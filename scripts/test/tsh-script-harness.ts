/**
 * tsh-script-harness.ts — jalankan mesin skrip `tsh` TANPA boot TSIX.
 *
 * Memakai `main` dari `src/mirror/bin/tsh.ts` dengan lib tiruan (std/fs/shell)
 * supaya `runScriptFile()` bisa diuji langsung dari terminal:
 *
 *   node -r esbuild-register -r tsconfig-paths/register \
 *     scripts/test/tsh-script-harness.ts <file.sh> [args...]
 */
import * as fsHost from "node:fs";
import { main as Tsh } from "../../src/mirror/bin/tsh";

const argv = process.argv.slice(2);
const scriptPath = argv[0];
const scriptArgs = argv.slice(1);
const content = fsHost.readFileSync(scriptPath, "utf8");

const env: Record<string, string> = {
    PATH: "/bin",
    HOME: "/root",
    LINES: "24",
    COLUMNS: "80",
};
const out: string[] = [];
const execLog: string[] = [];
let cwd = "/root";
let pid = 100;

// Penghitung "syscall": tiap panggilan lib = 1 round-trip IPC ke kernel
// (postMessage + await). `exec` lebih mahal lagi: di TSIX asli ia men-spawn
// Worker/V8 isolate baru per perintah.
const calls: Record<string, number> = {};
const count = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
};

// Perintah eksternal yang "ada" di PATH tiruan.
const BINARIES: Record<string, (args: string[]) => string> = {
    echo: (args) => args.join(" "),
    cat: (args) => args.map((a) => fsHost.readFileSync(a, "utf8")).join(""),
    pwd: () => cwd,
};

// Direktori tiruan: hanya "/" yang dipalsukan, sisanya host (untuk /tmp).
const SYNTH_LS: Record<string, string[]> = {
    "/": ["bin", "boot", "dev", "etc", "home", "root", "tmp", "usr"],
};

// Tabel fd nyata supaya redirection (`>`, `>>`) benar-benar menulis ke host.
const fdTable = new Map<number, { path: string; append: boolean }>();
let nextFd = 100;

const std: any = {
    print: async (s: string) => {
        out.push(s);
    },
    setRawMode: async () => {},
    getChar: async () => "",
};

const fs: any = {
    readFile: async (p: string) => {
        if (p === scriptPath) return content;
        try {
            return fsHost.readFileSync(p, "utf8");
        } catch {
            return null;
        }
    },
    writeFile: async (p: string, data: string) => {
        fsHost.writeFileSync(p, data);
        return true;
    },
    stat: async (p: string) => {
        if (p === scriptPath) return { name: p, type: "FILE", mode: 0o755 };
        const bare = p.replace(/\.(js|ts)$/, "");
        if (BINARIES[bare.replace(/^.*\//, "")]) {
            return { name: p, type: "FILE", mode: 0o755 };
        }
        try {
            const st = fsHost.statSync(p);
            return { name: p, type: st.isDirectory() ? "DIRECTORY" : "FILE", mode: 0o755 };
        } catch {
            return null;
        }
    },
    ls: async (p: string) => {
        const dir = p.replace(/\/+$/, "") || "/";
        if (SYNTH_LS[dir]) return SYNTH_LS[dir].map((n) => ({ name: n, type: "DIRECTORY" }));
        try {
            return fsHost.readdirSync(p).map((n) => ({
                name: n,
                type: fsHost.statSync(`${p}/${n}`).isDirectory() ? "DIRECTORY" : "FILE",
            }));
        } catch {
            return [];
        }
    },
    open: async (p: string, mode: string) => {
        const append = mode === "a";
        if (!append || !fsHost.existsSync(p)) fsHost.writeFileSync(p, "");
        const fd = nextFd++;
        fdTable.set(fd, { path: p, append });
        return fd;
    },
    write: async (fd: number, data: string) => {
        const entry = fdTable.get(fd);
        if (!entry) return false;
        fsHost.appendFileSync(entry.path, data);
        return true;
    },
    close: async (fd: number) => fdTable.delete(fd),
};

const shell: any = {
    getenv: async (n: string) => {
        count("getenv");
        return env[n] ?? null;
    },
    setenv: async (n: string, v: string) => {
        count("setenv");
        env[n] = String(v);
        return true;
    },
    getcwd: async () => {
        count("getcwd");
        return cwd;
    },
    chdir: async (p: string) => {
        count("chdir");
        cwd = p;
        return true;
    },
    whoami: async () => ({ uid: 0, gid: 0, username: "root" }),
    exit: async () => {},
    pipe: async () => [10, 11],
    waitpid: async () => {
        count("waitpid");
        return 0;
    },
    exec: async (binPath: string, args: string[], stdoutFd?: number) => {
        count("exec(spawn proses)");
        const name = binPath.replace(/^.*\//, "").replace(/\.(js|ts)$/, "");
        execLog.push(`${name} ${args.join(" ")}`.trim());
        const fn = BINARIES[name];
        if (fn) {
            const text = fn(args) + "\n";
            // stdoutFd ada → hormati redirection (`> file`, pipe).
            if (stdoutFd !== undefined && fdTable.has(stdoutFd)) await fs.write(stdoutFd, text);
            else out.push(text);
        }
        return { pid: pid++ };
    },
};

(async () => {
    const app = new Tsh();
    (app as any).std = std;
    (app as any).fs = fs;
    (app as any).shell = shell;
    (app as any).user = "root";
    (app as any).hostname = "mactsix";
    (app as any).scriptArgs = [scriptPath, ...scriptArgs];

    const result = await (app as any).runScriptFile(scriptPath);

    process.stdout.write("----- STDOUT -----\n");
    process.stdout.write(out.join(""));
    process.stdout.write("----- RETURN -----\n");
    process.stdout.write(JSON.stringify(result) + "\n");
    process.stdout.write("----- EXEC LOG -----\n");
    process.stdout.write(execLog.join("\n") + "\n");
    process.stdout.write("----- SYSCALL COUNT -----\n");
    process.stdout.write(
        Object.entries(calls)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n") + "\n",
    );
    process.stdout.write("----- ENV -----\n");
    process.stdout.write(
        Object.entries(env)
            .filter(([k]) => !["PATH", "HOME", "LINES", "COLUMNS"].includes(k))
            .map(([k, v]) => `${k}=${v}`)
            .join("\n") + "\n",
    );
})();
