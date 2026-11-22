import { afterEach, describe, expect, it, vi } from "vitest";
import * as bcrypt from "bcryptjs";
import Sudo from "./sudo";

function makeLib(ttyId: number | undefined = 1) {
    const passwordHash = bcrypt.hashSync("secret", 4);
    const files = new Map<string, string>([
        ["/etc/passwd", "alice:x:1000:1000:Alice:/home/alice:/bin/tsh\n"],
        ["/etc/group", "root:x:0:alice\nsudo:x:27:alice\n"],
        ["/etc/shadow", `alice:${passwordHash}:1:0:99999:7:::\n`],
    ]);
    const directories = new Set(["/", "/etc", "/var", "/var/run", "/bin"]);
    const prompts: string[] = [];
    const commands: string[] = [];
    const lib = {
        std: {
            print: vi.fn(async (_text: string) => {}),
            readPassword: vi.fn(async () => "secret"),
        },
        fs: {
            readFile: vi.fn(async (path: string) => files.get(path) ?? null),
            writeFile: vi.fn(async (path: string, value: string) => {
                files.set(path, value);
                return true;
            }),
            stat: vi.fn(async (path: string) => {
                if (files.has(path)) return { type: "FILE", mode: 0o600, uid: 0, gid: 0 };
                if (directories.has(path)) return { type: "DIRECTORY", mode: 0o700, uid: 0, gid: 0 };
                if (path === "/bin/echo.js") return { type: "FILE", mode: 0o755, uid: 0, gid: 0 };
                return null;
            }),
            mkdir: vi.fn(async (path: string) => {
                directories.add(path);
                return true;
            }),
            chmod: vi.fn(async () => true),
            unlink: vi.fn(async (path: string) => files.delete(path)),
            ls: vi.fn(async (path: string) => {
                const prefix = path.endsWith("/") ? path : `${path}/`;
                return [...files.keys()]
                    .filter((name) => name.startsWith(prefix) && !name.slice(prefix.length).includes("/"))
                    .map((name) => ({ name: name.slice(prefix.length), type: "FILE" }));
            }),
        },
        shell: {
            whoami: vi.fn(async () => ({ uid: 0, gid: 0, ruid: 1000, groups: [1000], username: "root", ttyId })),
            setuid: vi.fn(async () => true),
            setgid: vi.fn(async () => true),
            setgroups: vi.fn(async () => true),
            getenv: vi.fn(async () => "/bin"),
            exec: vi.fn(async (command: string) => {
                commands.push(command);
                return { pid: 7 };
            }),
            waitpid: vi.fn(async () => 0),
        },
        _files: files,
        _directories: directories,
        _prompts: prompts,
        _commands: commands,
    };
    return lib;
}

describe("sudo authentication timestamp", () => {
    afterEach(() => vi.useRealTimers());

    it("reuses a successful password per TTY until the timeout", async () => {
        const lib = makeLib() as any;
        const sudo = new Sudo();

        expect(await sudo.execute(lib, ["echo", "first"])).toBe(0);
        expect(await sudo.execute(lib, ["echo", "second"])).toBe(0);

        expect(lib.std.readPassword).toHaveBeenCalledTimes(1);
        expect(lib._commands).toEqual(["/bin/echo.js", "/bin/echo.js"]);
    });

    it("asks again after the 15-minute timestamp expires", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-11-22T12:00:00.000Z"));
        const lib = makeLib() as any;
        const sudo = new Sudo();

        await sudo.execute(lib, ["echo"]);
        vi.advanceTimersByTime(15 * 60 * 1000 + 1);
        await sudo.execute(lib, ["echo"]);

        expect(lib.std.readPassword).toHaveBeenCalledTimes(2);
    });

    it("keeps timestamps separate per TTY", async () => {
        const lib = makeLib(1) as any;
        const sudo = new Sudo();

        await sudo.execute(lib, ["echo"]);
        lib.shell.whoami.mockResolvedValue({ uid: 0, gid: 0, ruid: 1000, groups: [1000], username: "root", ttyId: 2 });
        await sudo.execute(lib, ["echo"]);

        expect(lib.std.readPassword).toHaveBeenCalledTimes(2);
    });

    it("sudo -v refreshes a valid timestamp", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-11-22T12:00:00.000Z"));
        const lib = makeLib() as any;
        const sudo = new Sudo();

        await sudo.execute(lib, ["echo"]);
        vi.advanceTimersByTime(14 * 60 * 1000);
        expect(await sudo.execute(lib, ["-v"])).toBe(0);
        vi.advanceTimersByTime(2 * 60 * 1000);
        await sudo.execute(lib, ["echo"]);

        expect(lib.std.readPassword).toHaveBeenCalledTimes(1);
    });

    it("sudo -k invalidates the current TTY timestamp", async () => {
        const lib = makeLib() as any;
        const sudo = new Sudo();

        await sudo.execute(lib, ["echo"]);
        expect(await sudo.execute(lib, ["-k"])).toBe(0);
        await sudo.execute(lib, ["echo"]);

        expect(lib.std.readPassword).toHaveBeenCalledTimes(2);
    });

    it("sudo -K invalidates timestamps across TTYs for the current UID", async () => {
        const lib = makeLib(1) as any;
        const sudo = new Sudo();

        await sudo.execute(lib, ["echo"]);
        lib.shell.whoami.mockResolvedValue({ uid: 0, gid: 0, ruid: 1000, groups: [1000], username: "root", ttyId: 2 });
        await sudo.execute(lib, ["echo"]);
        expect(lib.std.readPassword).toHaveBeenCalledTimes(2);

        await sudo.execute(lib, ["-K"]);
        await sudo.execute(lib, ["echo"]);
        expect(lib.std.readPassword).toHaveBeenCalledTimes(3);
    });
});
