import { UserLib } from "../lib/UserLib";

/**
 * USERMOD Utility
 * 
 * Modify a user account.
 */
export default class UserMod {
    async execute(lib: UserLib, args: string[]) {
        if (args.includes("--help") || args.includes("-h")) {
            await lib.std.print("Usage: usermod <options> <username>\n\n" +
                "Options:\n" +
                "  -s <shell>  Change user shell\n" +
                "  -d <home>   Change home directory\n" +
                "  -aG <group> Add to supplementary group\n" +
                "  -rG <group> Remove from supplementary group\n");
            return 0;
        }
        const { uid } = await lib.shell.whoami();

        let shell: string | undefined;
        let home: string | undefined;
        let addGroup: string | undefined;
        let removeGroup: string | undefined;
        let usernameIndex = args.length - 1;

        for (let i = 0; i < args.length - 1; i++) {
            if (args[i] === "-s" && args[i + 1]) {
                shell = args[i + 1];
                i++;
            } else if (args[i] === "-d" && args[i + 1]) {
                home = args[i + 1];
                i++;
            } else if (args[i] === "-aG" && args[i + 1]) {
                addGroup = args[i + 1];
                i++;
            } else if (args[i] === "-rG" && args[i + 1]) {
                removeGroup = args[i + 1];
                i++;
            }
        }

        const username = args[usernameIndex].trim();

        // 1. Update /etc/passwd (for -s, -d)
        if (shell || home) {
            const passwdContent = await lib.fs.readFile("/etc/passwd") || "";
            const lines = passwdContent.split("\n").map(l => l.trim()).filter(l => l.length > 0);
            let found = false;

            const newLines = lines.map(line => {
                const parts = line.split(":");
                if (parts[0] === username) {
                    found = true;
                    if (home) parts[5] = home;
                    if (shell) parts[6] = shell;
                    return parts.join(":");
                }
                return line;
            });

            if (!found) {
                await lib.std.print(`usermod: user '${username}' not found in /etc/passwd\n`);
                return 1;
            }

            await lib.fs.writeFile("/etc/passwd", newLines.join("\n") + "\n");
        }

        // 2. Update /etc/group (for -aG, -rG)
        if (addGroup || removeGroup) {
            const groupContent = await lib.fs.readFile("/etc/group") || "";
            const lines = groupContent.split("\n").map(l => l.trim()).filter(l => l.length > 0);
            let groupUpdated = false;

            const newLines = lines.map(line => {
                const parts = line.split(":"); // name:pass:gid:users
                const groupName = parts[0];
                let userList = parts[3] ? parts[3].split(",").map(u => u.trim()).filter(u => u.length > 0) : [];

                if (addGroup && groupName === addGroup) {
                    if (!userList.includes(username)) {
                        userList.push(username);
                        groupUpdated = true;
                    }
                    parts[3] = userList.join(",");
                }

                if (removeGroup && groupName === removeGroup) {
                    const idx = userList.indexOf(username);
                    if (idx !== -1) {
                        userList.splice(idx, 1);
                        groupUpdated = true;
                    }
                    parts[3] = userList.join(",");
                }

                return parts.join(":");
            });

            if (addGroup && !newLines.some(l => l.split(":")[0] === addGroup)) {
                await lib.std.print(`usermod: group '${addGroup}' not found\n`);
                return 1;
            }

            if (groupUpdated) {
                await lib.fs.writeFile("/etc/group", newLines.join("\n") + "\n");
            }
        }

        await lib.std.print(`User '${username}' updated successfully.\n`);
        return 0;
    }
}
