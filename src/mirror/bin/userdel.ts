import { UserLib } from "../lib/UserLib";

/**
 * USERDEL Utility
 *
 * Delete a user account.
 *
 * Usage:
 *   userdel [-r] <username>
 * Options:
 *   -r   Also remove the user's home directory
 */
export default class UserDel {
    async execute(lib: UserLib, args: string[]) {
        if (args.includes("--help") || args.includes("-h")) {
            await lib.std.print("Usage: userdel [-r] <username>\n\n" +
                "Options:\n" +
                "  -r   Also remove the user's home directory\n");
            return 0;
        }

        const { uid } = await lib.shell.whoami();
        if (uid !== 0) {
            await lib.std.print("userdel: Permission denied (must be root)\n");
            return 1;
        }

        const removeHome = args.includes("-r");
        const positional = args.filter(a => a !== "-r" && a !== "--help" && a !== "-h");

        if (positional.length !== 1) {
            await lib.std.print("Usage: userdel [-r] <username>\n");
            return 1;
        }

        const username = positional[0].trim();

        // 1. Read /etc/passwd
        const passwdContent = await lib.fs.readFile("/etc/passwd") || "";
        const passwdLines = passwdContent.split("\n").map(l => l.trim()).filter(l => l.length > 0);

        const userEntry = passwdLines.find(l => l.split(":")[0] === username);
        if (!userEntry) {
            await lib.std.print(`userdel: user '${username}' does not exist\n`);
            return 1;
        }

        const parts = userEntry.split(":");
        const userUid = parseInt(parts[2]);
        const homeDir = parts[5];

        if (userUid === 0) {
            await lib.std.print("userdel: cannot delete the root account\n");
            return 1;
        }

        // 2. Remove from /etc/passwd
        const newPasswd = passwdLines.filter(l => l.split(":")[0] !== username);
        await lib.fs.writeFile("/etc/passwd", newPasswd.join("\n") + "\n");

        // 3. Remove from /etc/shadow
        const shadowContent = await lib.fs.readFile("/etc/shadow") || "";
        if (shadowContent) {
            const shadowLines = shadowContent.split("\n").map(l => l.trim()).filter(l => l.length > 0);
            const newShadow = shadowLines.filter(l => l.split(":")[0] !== username);
            await lib.fs.writeFile("/etc/shadow", newShadow.join("\n") + "\n");
        }

        // 4. Remove from all supplementary groups in /etc/group
        const groupContent = await lib.fs.readFile("/etc/group") || "";
        if (groupContent) {
            const groupLines = groupContent.split("\n").map(l => l.trim()).filter(l => l.length > 0);
            const newGroups = groupLines.map(line => {
                const g = line.split(":");
                if (g[3]) {
                    const members = g[3].split(",").map(m => m.trim()).filter(m => m.length > 0 && m !== username);
                    g[3] = members.join(",");
                }
                return g.join(":");
            });
            await lib.fs.writeFile("/etc/group", newGroups.join("\n") + "\n");
        }

        // 5. Remove home directory (optional)
        if (removeHome && homeDir) {
            try {
                const proc = await lib.shell.exec("/bin/rm.ts", ["-r", homeDir]);
                if (proc && proc.pid) {
                    await lib.shell.waitpid(proc.pid);
                }
                await lib.std.print(`userdel: removed home directory '${homeDir}'\n`);
            } catch (e: any) {
                await lib.std.print(`userdel: warning - could not remove '${homeDir}': ${e.message}\n`);
            }
        }

        await lib.std.print(`User '${username}' deleted successfully.\n`);
        return 0;
    }
}
