import { UserLib } from "../lib/UserLib";
import * as bcrypt from "bcryptjs";

const SUDO_TIMESTAMP_DIR = "/var/run/sudo-timestamps";
const SUDO_TIMESTAMP_TIMEOUT_MS = 15 * 60 * 1000;

interface SudoIdentity {
    uid: number;
    gid: number;
    ruid: number;
    groups: number[];
    username: string;
    ttyId?: number;
}

/**
 * SUDO Utility
 *
 * Execute a command as another user (default: root).
 */
export default class Sudo {
    async execute(lib: UserLib, args: string[]) {
        if (args.includes("--help") || args.includes("-h")) {
            await lib.std.print(
                "Usage: sudo <command> [args...]\n" +
                    "       sudo -v | -k | -K\n" +
                    "Execute a command as superuser. Authentication is cached for 15 minutes per TTY.\n" +
                    "  -v  validate/refresh the current TTY's timestamp\n" +
                    "  -k  invalidate the current TTY's timestamp\n" +
                    "  -K  invalidate all timestamps for the current user\n",
            );
            return 0;
        }

        const identity = (await lib.shell.whoami()) as SudoIdentity;
        const { ruid, ttyId } = identity;

        if (args[0] === "-K" || args[0] === "--remove-timestamp") {
            await this.removeAllTimestamps(lib, ruid);
            return 0;
        }

        if (args[0] === "-k" || args[0] === "--reset-timestamp") {
            await this.removeTimestamp(lib, ruid, ttyId);
            args = args.slice(1);
            if (args.length === 0) return 0;
        }

        const validateOnly = args[0] === "-v" || args[0] === "--validate";
        if (validateOnly) args = args.slice(1);
        if ((!validateOnly && args.length < 1) || (validateOnly && args.length > 0)) {
            await lib.std.print("Usage: sudo <command> [args...]\n");
            return 1;
        }

        if (ruid === 0) {
            if (validateOnly) return 0;
            return await this.runAsRoot(lib, args);
        }

        // 2. Resolve username
        const passwdContent = (await lib.fs.readFile("/etc/passwd")) || "";
        const passwdLines = passwdContent
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        const callerEntry = passwdLines.find((l) => parseInt(l.split(":")[2]) === ruid);
        if (!callerEntry) {
            await lib.std.print("sudo: Who are you? (UID not found in /etc/passwd)\n");
            return 1;
        }
        const username = callerEntry.split(":")[0];

        // 3. Check if in 'sudo' or 'root' group
        const groupContent = (await lib.fs.readFile("/etc/group")) || "";
        const groupLines = groupContent
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0);

        const isSudoer = groupLines.some((l) => {
            const parts = l.split(":");
            const groupName = parts[0];
            if (groupName !== "sudo" && groupName !== "root") return false;

            const users = parts[3] ? parts[3].split(",").map((u) => u.trim()) : [];
            return users.includes(username);
        });

        if (!isSudoer) {
            await lib.std.print(`sudo: ${username} is not in the sudoers file. This incident will be reported.\n`);
            return 1;
        }

        // A successful timestamp only skips the password prompt. The command
        // still runs via this setuid-root process, as before.
        const hasTimestamp = await this.hasValidTimestamp(lib, ruid, ttyId);
        if (hasTimestamp) {
            if (validateOnly) await this.storeTimestamp(lib, ruid, ttyId);
        } else {
            if (!(await this.authenticate(lib, username))) return 1;
            await this.storeTimestamp(lib, ruid, ttyId);
        }

        if (validateOnly) return 0;

        // 5. Success! Escalate to root
        await lib.shell.setuid(0);
        await lib.shell.setgid(0);
        await lib.shell.setgroups([0]);

        return await this.runAsRoot(lib, args);
    }

    private timestampPath(uid: number, ttyId?: number): string | null {
        if (!Number.isInteger(ttyId)) return null;
        return `${SUDO_TIMESTAMP_DIR}/${uid}-${ttyId}.json`;
    }

    private async secureTimestampDirectory(lib: UserLib): Promise<boolean> {
        try {
            const stat = await lib.fs.stat(SUDO_TIMESTAMP_DIR);
            if (stat && stat.type !== "DIRECTORY") return false;
            if (!stat && !(await lib.fs.mkdir(SUDO_TIMESTAMP_DIR))) return false;
            await lib.fs.chmod(SUDO_TIMESTAMP_DIR, 0o700);
            return true;
        } catch {
            return false;
        }
    }

    private async hasValidTimestamp(lib: UserLib, uid: number, ttyId?: number): Promise<boolean> {
        const path = this.timestampPath(uid, ttyId);
        if (!path || !(await this.secureTimestampDirectory(lib))) return false;
        try {
            const content = await lib.fs.readFile(path);
            if (!content) return false;
            const timestamp = JSON.parse(content) as { uid?: number; ttyId?: number; authenticatedAt?: number };
            const age = Date.now() - Number(timestamp.authenticatedAt);
            return (
                timestamp.uid === uid &&
                timestamp.ttyId === ttyId &&
                Number.isFinite(timestamp.authenticatedAt) &&
                age >= 0 &&
                age < SUDO_TIMESTAMP_TIMEOUT_MS
            );
        } catch {
            return false;
        }
    }

    private async storeTimestamp(lib: UserLib, uid: number, ttyId?: number): Promise<void> {
        const path = this.timestampPath(uid, ttyId);
        if (!path || !(await this.secureTimestampDirectory(lib))) return;
        try {
            const saved = await lib.fs.writeFile(path, JSON.stringify({ uid, ttyId, authenticatedAt: Date.now() }));
            if (saved) await lib.fs.chmod(path, 0o600);
        } catch {
            // Caching is best-effort; a failure must not block this authenticated command.
        }
    }

    private async removeTimestamp(lib: UserLib, uid: number, ttyId?: number): Promise<void> {
        const path = this.timestampPath(uid, ttyId);
        if (!path || !(await this.secureTimestampDirectory(lib))) return;
        await lib.fs.unlink(path).catch(() => false);
    }

    private async removeAllTimestamps(lib: UserLib, uid: number): Promise<void> {
        if (!(await this.secureTimestampDirectory(lib))) return;
        try {
            const entries = await lib.fs.ls(SUDO_TIMESTAMP_DIR);
            const prefix = `${uid}-`;
            for (const entry of entries ?? []) {
                if (entry.type === "FILE" && entry.name.startsWith(prefix) && entry.name.endsWith(".json")) {
                    await lib.fs.unlink(`${SUDO_TIMESTAMP_DIR}/${entry.name}`).catch(() => false);
                }
            }
        } catch {
            // No timestamp directory or unreadable cache: nothing to invalidate.
        }
    }

    private async authenticate(lib: UserLib, username: string): Promise<boolean> {
        await lib.std.print(`[sudo] password for ${username}: `);
        const password = await (lib.std as any).readPassword("");

        const shadowContent = (await lib.fs.readFile("/etc/shadow")) || "";
        const shadowLines = shadowContent
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
        const shadowEntry = shadowLines.find((line) => line.split(":")[0] === username);
        if (!shadowEntry) {
            await lib.std.print("sudo: Authentication failure\n");
            return false;
        }

        const hash = shadowEntry.split(":")[1];
        if (!hash || !bcrypt.compareSync(password, hash)) {
            await lib.std.print("sudo: 1 incorrect password attempt\n");
            return false;
        }
        return true;
    }

    private async runAsRoot(lib: UserLib, args: string[]) {
        const cmd = args[0];
        const cmdArgs = args.slice(1);

        const resolvedCmd = await this.resolveCommand(lib, cmd);

        // In our system, the current process is already SetUID root.
        // When we exec, the child inherits THIS process's UID (which is 0).
        const result = await lib.shell.exec(resolvedCmd, cmdArgs);
        if (result && result.pid) {
            const status = await lib.shell.waitpid(result.pid);
            return status;
        }

        await lib.std.print(`sudo: ${cmd}: command not found\n`);
        return 127;
    }

    private async resolveCommand(lib: UserLib, cmd: string): Promise<string> {
        // If path is explicit/relative, return as is
        if (cmd.startsWith("/") || cmd.startsWith("./") || cmd.startsWith("../")) {
            return cmd;
        }

        const pathEnv = (await lib.shell.getenv("PATH")) || "/bin";
        const paths = pathEnv.split(":");
        // .js DIDAHULUKAN: sidecar sudah ter-transpile, jadi worker target
        // tidak perlu preload transpiler (+14.4 MB RSS). .ts tetap dicoba
        // sebagai fallback bila sidecar belum dibuat (vfs:bootstrap).
        const extensions = ["", ".js", ".ts"];

        for (const p of paths) {
            for (const ext of extensions) {
                // Construct absolute path candidates
                const dir = p.endsWith("/") ? p : p + "/";
                const candidate = dir + cmd + ext;

                try {
                    const stats = await lib.fs.stat(candidate);
                    if (stats) return candidate;
                } catch (e) {
                    // Ignore errors (file not found)
                }
            }
        }

        // If not found in PATH, return original (exec might fail)
        return cmd;
    }
}
