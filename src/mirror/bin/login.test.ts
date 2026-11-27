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

/**
 * SEC-24 — `login.js --verify <user> <password> <resultFile>`.
 *
 * login.js SetUID root (scripts/lib/binary-mode.ts). Mode verify dipakai GUI
 * login (Asteracea). Hasil harus ditulis dengan identitas PEMANGGIL (ruid),
 * bukan root, dan tebakan dibatasi per pemanggil.
 */
describe("login --verify (SEC-24)", () => {
    function makeVerifyLib(ruid: number) {
        const files: Record<string, string> = {
            "/etc/passwd": "root:x:0:0:root:/root:/bin/tsh\nalice:x:1000:1000:Alice:/home/alice:/bin/tsh\nbob:x:1001:1001:Bob:/home/bob:/bin/tsh\n",
            "/etc/shadow": `root:${bcrypt.hashSync("kuat", 4)}\nalice:${HASH}\n`,
            "/etc/group": "",
        };
        const proc = { uid: 0, gid: 0 }; // efektif root (SetUID)
        // VFS tiruan: hanya root yang boleh menulis di /etc atau /var/run.
        const canWrite = (p: string) => proc.uid === 0 || !(p.startsWith("/etc/") || p.startsWith("/var/run/"));
        const lib = {
            std: { print: vi.fn(async () => undefined), log: vi.fn(async () => undefined) },
            fs: {
                readFile: vi.fn(async (p: string) => files[p] ?? null),
                writeFile: vi.fn(async (p: string, c: string) => {
                    if (!canWrite(p)) throw new Error(`Permission Denied: ${p}`);
                    files[p] = c;
                    return true;
                }),
                mkdir: vi.fn(async () => true),
            },
            shell: {
                onSignal: vi.fn(async () => undefined),
                whoami: vi.fn(async () => ({ uid: proc.uid, gid: proc.gid, ruid, groups: [], username: "root" })),
                setgroups: vi.fn(async () => undefined),
                setgid: vi.fn(async (g: number) => {
                    proc.gid = g;
                }),
                setuid: vi.fn(async (u: number) => {
                    proc.uid = u;
                }),
            },
        } as any;
        // Setiap exec login.js = proses SetUID baru yang mulai sebagai root.
        lib.__freshProcess = () => {
            proc.uid = 0;
            proc.gid = 0;
        };
        return { lib, files, proc };
    }

    const verify = (lib: any, user: string, pass: string, out: string) => {
        lib.__freshProcess();
        return makeLogin().execute(lib, ["--verify", user, pass, out]);
    };

    it("password benar → 'OK' tertulis di file milik pemanggil (/tmp)", async () => {
        const { lib, files } = makeVerifyLib(1001);
        await verify(lib, "alice", "rahasia", "/tmp/v1");
        expect(files["/tmp/v1"]).toBe("OK");
    });

    it("resultFile di /etc tidak bisa ditimpa oleh pemanggil non-root", async () => {
        const { lib, files } = makeVerifyLib(1001);
        const before = files["/etc/shadow"];
        await verify(lib, "alice", "salah", "/etc/shadow");
        expect(files["/etc/shadow"]).toBe(before);
    });

    it("login turun ke uid/gid pemanggil sebelum menulis hasil", async () => {
        const { lib } = makeVerifyLib(1001);
        await verify(lib, "alice", "rahasia", "/tmp/v2");
        expect(lib.shell.setuid).toHaveBeenCalledWith(1001);
        expect(lib.shell.setgid).toHaveBeenCalledWith(1001);
        const setuidOrder = lib.shell.setuid.mock.invocationCallOrder[0];
        const writeOrder = lib.fs.writeFile.mock.invocationCallOrder.at(-1);
        expect(setuidOrder).toBeLessThan(writeOrder);
    });

    it("lebih dari 5 kali gagal per pemanggil → ditolak tanpa memeriksa password", async () => {
        const { lib, files } = makeVerifyLib(1001);
        for (let i = 0; i < Login.MAX_ATTEMPTS; i++) {
            await verify(lib, "root", "tebak" + i, `/tmp/f${i}`);
            expect(files[`/tmp/f${i}`]).toMatch(/^FAIL:/);
        }
        // Tebakan ke-6, walaupun benar, tetap ditolak.
        await verify(lib, "root", "kuat", "/tmp/f6");
        expect(files["/tmp/f6"]).toMatch(/^FAIL:.*too many/i);
    });

    it("batas dihitung per pemanggil: pemanggil lain tidak terkena", async () => {
        const { lib, files } = makeVerifyLib(1001);
        for (let i = 0; i < Login.MAX_ATTEMPTS; i++) await verify(lib, "root", "x", `/tmp/g${i}`);
        // Pemanggil lain (ruid 1000) dengan state file yang sama.
        const other = makeVerifyLib(1000);
        other.files["/var/run/login-verify.json"] = files["/var/run/login-verify.json"];
        await verify(other.lib, "alice", "rahasia", "/tmp/ok");
        expect(other.files["/tmp/ok"]).toBe("OK");
    });
});
