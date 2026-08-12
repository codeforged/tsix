import { UserLib } from "../lib/UserLib";
import * as bcrypt from "bcryptjs";

/**
 * SUDO Utility
 * 
 * Execute a command as another user (default: root).
 */
export default class Sudo {
    async execute(lib: UserLib, args: string[]) {
        if (args.includes("--help") || args.includes("-h")) {
            await lib.std.print("Usage: sudo <command> [args...]\n" +
                "Execute a command as superuser.\n");
            return 0;
        }
        if (args.length < 1) {
            await lib.std.print("Usage: sudo <command> [args...]\n");
            return 1;
        }

        // 1. Identify whose calling (RUID)
        const { ruid } = await lib.shell.whoami();
        if (ruid === 0) {
            // Root can just run anything directly, but for consistency we let it through
            return await this.runAsRoot(lib, args);
        }

        // 2. Resolve username
        const passwdContent = await lib.fs.readFile("/etc/passwd") || "";
        const passwdLines = passwdContent.split("\n").map(l => l.trim()).filter(l => l.length > 0);
        const callerEntry = passwdLines.find(l => parseInt(l.split(":")[2]) === ruid);
        if (!callerEntry) {
            await lib.std.print("sudo: Who are you? (UID not found in /etc/passwd)\n");
            return 1;
        }
        const username = callerEntry.split(":")[0];

        // 3. Check if in 'sudo' or 'root' group
        const groupContent = await lib.fs.readFile("/etc/group") || "";
        const groupLines = groupContent.split("\n").map(l => l.trim()).filter(l => l.length > 0);

        const isSudoer = groupLines.some(l => {
            const parts = l.split(":");
            const groupName = parts[0];
            if (groupName !== "sudo" && groupName !== "root") return false;

            const users = parts[3] ? parts[3].split(",").map(u => u.trim()) : [];
            return users.includes(username);
        });

        if (!isSudoer) {
            await lib.std.print(`sudo: ${username} is not in the sudoers file. This incident will be reported.\n`);
            return 1;
        }

        // 4. Verification (Password)
        await lib.std.print(`[sudo] password for ${username}: `);
        const password = await (lib.std as any).readPassword("");

        // Load shadow for password check
        const shadowContent = await lib.fs.readFile("/etc/shadow") || "";
        const shadowLines = shadowContent.split("\n").map(l => l.trim()).filter(l => l.length > 0);
        const shadowEntry = shadowLines.find(l => l.split(":")[0] === username);

        if (!shadowEntry) {
            await lib.std.print("sudo: Authentication failure\n");
            return 1;
        }

        const hash = shadowEntry.split(":")[1];
        if (!bcrypt.compareSync(password, hash)) {
            await lib.std.print("sudo: 1 incorrect password attempt\n"); // Keep it classic
            return 1;
        }

        // 5. Success! Escalate to root
        await lib.shell.setuid(0);
        await lib.shell.setgid(0);
        await lib.shell.setgroups([0]);

        return await this.runAsRoot(lib, args);
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

        const pathEnv = await lib.shell.getenv("PATH") || "/bin";
        const paths = pathEnv.split(":");
        const extensions = ["", ".ts"];

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
