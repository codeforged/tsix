import { UserLib } from "../lib/UserLib";

/**
 * GROUPDEL Utility
 *
 * Delete a group.
 *
 * Usage: 
 *   groupdel [-f] <groupname>
 * Options:
 *   -f   Force deletion even if the group is a user's primary group
 */
export default class GroupDel {
    async execute(lib: UserLib, args: string[]) {
        if (args.includes("--help") || args.includes("-h")) {
            await lib.std.print("Usage: groupdel [-f] <groupname>\n\n" +
                "Options:\n" +
                "  -f   Force deletion (even if it is a user's primary group)\n");
            return 0;
        }

        const { uid } = await lib.shell.whoami();
        if (uid !== 0) {
            await lib.std.print("groupdel: Permission denied (must be root)\n");
            return 1;
        }

        const force = args.includes("-f");
        const positional = args.filter(a => a !== "-f" && a !== "--help" && a !== "-h");

        if (positional.length !== 1) {
            await lib.std.print("Usage: groupdel [-f] <groupname>\n");
            return 1;
        }

        const groupName = positional[0].trim();

        // 1. Read /etc/group
        const groupContent = await lib.fs.readFile("/etc/group") || "";
        const lines = groupContent.split("\n").map(l => l.trim()).filter(l => l.length > 0);

        const targetLine = lines.find(l => l.split(":")[0] === groupName);
        if (!targetLine) {
            await lib.std.print(`groupdel: group '${groupName}' does not exist\n`);
            return 1;
        }

        const gid = parseInt(targetLine.split(":")[2]);

        // 2. Safety: refuse if group is the primary group of any user
        if (!force) {
            const passwdContent = await lib.fs.readFile("/etc/passwd") || "";
            const passwdLines = passwdContent.split("\n").map(l => l.trim()).filter(l => l.length > 0);
            const primaryUsers = passwdLines
                .filter(l => parseInt(l.split(":")[3]) === gid)
                .map(l => l.split(":")[0]);

            if (primaryUsers.length > 0) {
                await lib.std.print(
                    `groupdel: group '${groupName}' is the primary group of: ${primaryUsers.join(", ")}\n` +
                    "groupdel: use '-f' to force deletion\n");
                return 1;
            }
        }

        // 3. Remove the group line
        const newLines = lines.filter(l => l.split(":")[0] !== groupName);
        const success = await lib.fs.writeFile("/etc/group", newLines.join("\n") + "\n");
        if (!success) {
            await lib.std.print("groupdel: Failed to write /etc/group\n");
            return 1;
        }

        await lib.std.print(`Group '${groupName}' removed successfully.\n`);
        return 0;
    }
}
