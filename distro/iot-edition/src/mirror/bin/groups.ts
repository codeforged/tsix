import { UserLib } from "../lib/UserLib";

/**
 * GROUPS Utility
 * 
 * Print the groups a user is in.
 */ 
export default class Groups {
    async execute(lib: UserLib, args: string[]) {
        if (args.includes("--help") || args.includes("-h")) {
            await lib.std.print("Usage: groups [user]\n" +
                "Print group memberships for user (default: current user).\n");
            return 0;
        }
        const { ruid, username: effectiveUser } = await lib.shell.whoami();

        // 1. Resolve username from RUID
        const passwdContent = await lib.fs.readFile("/etc/passwd") || "";
        const passwdLines = passwdContent.split("\n").map(l => l.trim()).filter(l => l.length > 0);

        let targetUser = args[0] || "";
        if (!targetUser) {
            const callerEntry = passwdLines.find(l => parseInt(l.split(":")[2]) === ruid);
            if (callerEntry) targetUser = callerEntry.split(":")[0];
        }

        if (!targetUser) {
            await lib.std.print("groups: user not found\n");
            return 1;
        }

        // 2. Find primary group
        const targetPasswd = passwdLines.find(l => l.split(":")[0] === targetUser);
        let groups: string[] = [];
        if (targetPasswd) {
            const primaryGid = targetPasswd.split(":")[3];
            // Find group name for this GID
            const groupContent = await lib.fs.readFile("/etc/group") || "";
            const groupLines = groupContent.split("\n").map(l => l.trim()).filter(l => l.length > 0);
            const primaryGroup = groupLines.find(l => l.split(":")[2] === primaryGid);
            if (primaryGroup) groups.push(primaryGroup.split(":")[0]);

            // 3. Find supplementary groups
            groupLines.forEach(l => {
                const parts = l.split(":");
                const users = parts[3] ? parts[3].split(",").map(u => u.trim()) : [];
                if (users.includes(targetUser) && !groups.includes(parts[0])) {
                    groups.push(parts[0]);
                }
            });
        }

        await lib.std.print(`${targetUser} : ${groups.join(" ")}\n`);
        return 0;
    }
}
