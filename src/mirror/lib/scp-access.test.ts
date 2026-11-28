import { describe, it, expect } from "vitest";
import {
    AuthLimiter,
    READ,
    WRITE,
    EXEC,
    allowed,
    lookupUser,
    normalizeScpPath,
    parentDir,
    scpBasename,
    scpDestination,
} from "./scp-access";

describe("scp: tujuan berupa direktori memakai nama file sumber", () => {
    it("scpBasename: segmen terakhir; kosong/direktori → null", () => {
        expect(scpBasename("/root/start-netfsd-client.sh")).toBe("start-netfsd-client.sh");
        expect(scpBasename("data.txt")).toBe("data.txt");
        expect(scpBasename("/root/")).toBeNull();
        expect(scpBasename("..")).toBeNull();
        expect(scpBasename("")).toBeNull();
    });

    it("tujuan `./`, `.`, `..`, `dir/`, atau kosong → ditambah nama sumber", () => {
        const src = "/root/start-netfsd-client.sh";
        expect(scpDestination("./", src)).toBe("./start-netfsd-client.sh");
        expect(scpDestination(".", src)).toBe("./start-netfsd-client.sh");
        expect(scpDestination("..", src)).toBe("../start-netfsd-client.sh");
        expect(scpDestination("/tmp/", src)).toBe("/tmp/start-netfsd-client.sh");
        expect(scpDestination("", "a.txt")).toBe("a.txt");
    });

    it("tujuan direktori yang sudah ada (diketahui pemanggil) → ditambah nama sumber", () => {
        expect(scpDestination("/root", "/x/a.txt", true)).toBe("/root/a.txt");
    });

    it("tujuan berupa nama file dibiarkan; sumber tanpa nama → null", () => {
        expect(scpDestination("./copy.sh", "/root/a.sh")).toBe("./copy.sh");
        expect(scpDestination("./", "/root/")).toBeNull();
    });
});

const PASSWD = "root:x:0:0:root:/root:/bin/tsh\nalice:x:1000:1000:Alice:/home/alice:/bin/tsh\n";
const GROUP = "root:x:0:\nsudo:x:27:bob\nstaff:x:50:alice\n";

describe("scp-access (SEC-03)", () => {
    const alice = lookupUser(PASSWD, GROUP, "alice")!;
    const root = lookupUser(PASSWD, GROUP, "root")!;

    it("lookupUser: uid/gid + grup tambahan", () => {
        expect(alice).toEqual({ name: "alice", uid: 1000, gid: 1000, groups: [1000, 50], home: "/home/alice" });
        expect(lookupUser(PASSWD, GROUP, "mallory")).toBeNull();
    });

    it("alice tidak boleh membaca /etc/shadow (0o640 root:root)", () => {
        expect(allowed(alice, { uid: 0, gid: 0, mode: 0o640 }, READ)).toBe(false);
    });

    it("alice tidak boleh menulis /etc/rc.local (0o755 root) maupun membuat file di /etc (0o755 root)", () => {
        expect(allowed(alice, { uid: 0, gid: 0, mode: 0o755 }, WRITE)).toBe(false);
        expect(allowed(alice, { uid: 0, gid: 0, mode: 0o755 }, WRITE | EXEC)).toBe(false);
    });

    it("alice boleh menulis di home-nya sendiri", () => {
        expect(allowed(alice, { uid: 1000, gid: 1000, mode: 0o755 }, WRITE | EXEC)).toBe(true);
    });

    it("bit grup lewat grup tambahan; tidak jatuh ke bit others", () => {
        expect(allowed(alice, { uid: 0, gid: 50, mode: 0o640 }, READ)).toBe(true);
        expect(allowed(alice, { uid: 0, gid: 50, mode: 0o604 }, READ)).toBe(false);
    });

    it("root boleh semuanya", () => {
        expect(allowed(root, { uid: 0, gid: 0, mode: 0o000 }, READ | WRITE)).toBe(true);
    });

    it("normalizeScpPath: harus absolut, `..` diselesaikan, NUL ditolak", () => {
        expect(normalizeScpPath("/home/alice/../../etc/shadow")).toBe("/etc/shadow");
        expect(normalizeScpPath("/home//alice/./x")).toBe("/home/alice/x");
        expect(normalizeScpPath("etc/shadow")).toBeNull();
        expect(normalizeScpPath("catatan.txt", "/home/alice")).toBe("/home/alice/catatan.txt");
        // `..` keluar dari home tetap diselesaikan; izinnya diputuskan allowed().
        expect(normalizeScpPath("../../etc/shadow", "/home/alice")).toBe("/etc/shadow");
        expect(normalizeScpPath("/x\0y")).toBeNull();
        expect(normalizeScpPath(42)).toBeNull();
        expect(parentDir("/home/alice/x")).toBe("/home/alice");
        expect(parentDir("/x")).toBe("/");
    });

    it("AuthLimiter: 5 gagal per sesi, dan batas global lintas sesi", () => {
        const lim = new AuthLimiter(5, 8, 60_000);
        for (let i = 0; i < 5; i++) lim.fail("a", 0);
        expect(lim.blocked("a", 0)).toBe(true);
        expect(lim.blocked("b", 0)).toBe(false);
        for (let i = 0; i < 3; i++) lim.fail(`s${i}`, 0);
        expect(lim.blocked("baru", 0)).toBe(true); // 8 gagal global
        expect(lim.blocked("baru", 60_001)).toBe(false); // jendela lewat
    });
});
