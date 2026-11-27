import { describe, it, expect, vi } from "vitest";
import * as bcrypt from "bcryptjs";
import Login from "./login";

/**
 * login — batas percobaan password.
 *
 * login.js dipakai konsol (di-spawn ulang init setelah keluar) dan sesi tssh
 * (tsshd selalu men-spawn login). Tanpa batas, password bisa ditebak tanpa
 * henti dari jarak jauh. Setelah MAX_ATTEMPTS gagal, login keluar.
 */

const HASH = bcrypt.hashSync("rahasia", 4);
const ROOT_DEFAULT = bcrypt.hashSync("root", 4);

function makeLib(answers: { user: string; pass: string }[]) {
    const users = [...answers];
    let current: { user: string; pass: string } | undefined;
    const files: Record<string, string> = {
        "/etc/passwd": "root:x:0:0:root:/root:/bin/tsh\nalice:x:1000:1000:Alice:/home/alice:/bin/tsh\n",
        "/etc/shadow": `root:${ROOT_DEFAULT}\nalice:${HASH}\n`,
        "/etc/group": "",
    };
    return {
        std: {
            print: vi.fn(async () => undefined),
            log: vi.fn(async () => undefined),
            readLine: vi.fn(async () => {
                current = users.shift();
                return current ? current.user : null;
            }),
            readPassword: vi.fn(async () => (current ? current.pass : "")),
        },
        fs: { readFile: vi.fn(async (p: string) => files[p] ?? null) },
        shell: {
            onSignal: vi.fn(async () => undefined),
            setgroups: vi.fn(async () => undefined),
            setgid: vi.fn(async () => undefined),
            setuid: vi.fn(async () => undefined),
            setenv: vi.fn(async () => undefined),
            chdir: vi.fn(async () => undefined),
            exec: vi.fn(async () => ({ pid: 99 })),
            waitpid: vi.fn(async () => 0),
        },
    } as any;
}

function makeLogin() {
    const l = new Login() as any;
    l.failDelayMs = 0;
    return l;
}

describe("login: batas percobaan", () => {
    it("5x password salah → keluar tanpa setuid/exec; percobaan ke-6 tidak ditanyakan", async () => {
        const wrong = Array.from({ length: 10 }, () => ({ user: "alice", pass: "salah" }));
        const lib = makeLib(wrong);
        await makeLogin().execute(lib, []);

        expect(lib.std.readPassword).toHaveBeenCalledTimes(Login.MAX_ATTEMPTS);
        expect(lib.shell.setuid).not.toHaveBeenCalled();
        expect(lib.shell.exec).not.toHaveBeenCalled();
    });

    it("username tidak dikenal juga dihitung sebagai percobaan gagal", async () => {
        const wrong = Array.from({ length: 10 }, () => ({ user: "mallory", pass: "x" }));
        const lib = makeLib(wrong);
        await makeLogin().execute(lib, []);

        expect(lib.std.readPassword).toHaveBeenCalledTimes(Login.MAX_ATTEMPTS);
        expect(lib.shell.exec).not.toHaveBeenCalled();
    });

    it("gagal 2x lalu benar → login berhasil sebagai alice", async () => {
        const lib = makeLib([
            { user: "alice", pass: "salah" },
            { user: "alice", pass: "salah" },
            { user: "alice", pass: "rahasia" },
        ]);
        await makeLogin().execute(lib, []);

        expect(lib.shell.setuid).toHaveBeenCalledWith(1000);
        expect(lib.shell.exec).toHaveBeenCalledWith("/bin/tsh");
    });
});

describe("login: password bawaan root/root (SEC-20)", () => {
    const out = (lib: any) => lib.std.print.mock.calls.map((c: any[]) => c[0]).join("");

    it("sesi remote (--remote): root/root ditolak dan dihitung gagal", async () => {
        const tries = Array.from({ length: 10 }, () => ({ user: "root", pass: "root" }));
        const lib = makeLib(tries);
        await makeLogin().execute(lib, ["--remote"]);

        expect(lib.shell.setuid).not.toHaveBeenCalled();
        expect(lib.shell.exec).not.toHaveBeenCalled();
        expect(lib.std.readPassword).toHaveBeenCalledTimes(Login.MAX_ATTEMPTS);
        expect(out(lib)).toMatch(/default password/i);
    });

    it("sesi remote: user biasa tetap bisa login", async () => {
        const lib = makeLib([{ user: "alice", pass: "rahasia" }]);
        await makeLogin().execute(lib, ["--remote"]);
        expect(lib.shell.setuid).toHaveBeenCalledWith(1000);
    });

    it("`--remote` tidak dianggap sebagai username", async () => {
        const lib = makeLib([{ user: "alice", pass: "rahasia" }]);
        await makeLogin().execute(lib, ["--remote"]);
        expect(lib.std.readLine).toHaveBeenCalled(); // username tetap ditanyakan
    });

    it("konsol: root/root diizinkan tapi diberi peringatan untuk mengganti password", async () => {
        const lib = makeLib([{ user: "root", pass: "root" }]);
        await makeLogin().execute(lib, []);
        expect(lib.shell.setuid).toHaveBeenCalledWith(0);
        expect(out(lib)).toMatch(/passwd/);
    });
});
