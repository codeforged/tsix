import { UserLib } from "../lib/UserLib";

/**
 * GROUPADD Utility
 *
 * Create a new group.
 * 
 * Usage:
 *   groupadd [-g GID] <groupname>
 * Options:
 *   -g GID   Manually specify the group ID (default: auto-assigned)
 */
export default class GroupAdd {
    async execute(lib: UserLib, args: string[]) {
        if (args.includes("--help") || args.includes("-h")) {
            await lib.std.print("Usage: groupadd [-g GID] <groupname>\n\n" +
                "Options:\n" +
                "  -g GID   Manually specify the group ID (default: auto-assigned)\n" +
                "Example: groupadd devs\n" +
                "         groupadd -g 1005 ops\n");
            return 0;
        }

        const { uid } = await lib.shell.whoami();
        if (uid !== 0) {
            await lib.std.print("groupadd: Permission denied (must be root)\n");
            return 1;
        }

        // 1. Parse arguments
        let requestedGid = -1;
        const positional: string[] = [];
        for (let i = 0; i < args.length; i++) {
            if (args[i] === "-g" && args[i + 1]) {
                requestedGid = parseInt(args[i + 1]);
                if (isNaN(requestedGid) || requestedGid < 0) {
                    await lib.std.print(`groupadd: invalid GID '${args[i + 1]}'\n`);
                    return 1;
                }
                i++;
            } else {
                positional.push(args[i]);
            }
        }

        if (positional.length !== 1) {
            await lib.std.print("Usage: groupadd [-g GID] <groupname>\n");
            return 1;
        }

        const groupName = positional[0].trim();
        if (!groupName || groupName.includes(":") || groupName.includes(",") || groupName.includes(" ")) {
            await lib.std.print(`groupadd: invalid group name '${groupName}'\n`);
            return 1;
        }

        // 2. Read /etc/group
        const groupContent = await lib.fs.readFile("/etc/group") || "";
        const lines = groupContent.split("\n").map(l => l.trim()).filter(l => l.length > 0);

        // 3. Duplicate name check
        if (lines.some(l => l.split(":")[0] === groupName)) {
            await lib.std.print(`groupadd: group '${groupName}' already exists\n`);
            return 1;
        }

        // 4. Resolve GID
        let gid = requestedGid;
        if (gid === -1) {
            let maxGid = 1000;
            lines.forEach(l => {
                const g = parseInt(l.split(":")[2]);
                if (!isNaN(g) && g >= maxGid) maxGid = g;
            });
            gid = maxGid + 1;
        } else {
            if (lines.some(l => parseInt(l.split(":")[2]) === gid)) {
                await lib.std.print(`groupadd: GID '${gid}' already exists\n`);
                return 1;
            }
        }

        // 5. Append new group line
        const newLine = `${groupName}:x:${gid}:`;
        const success = await lib.fs.writeFile("/etc/group", groupContent.trim() + "\n" + newLine + "\n");
        if (!success) {
            await lib.std.print("groupadd: Failed to write /etc/group\n");
            return 1;
        }

        await lib.std.print(`Group '${groupName}' (GID ${gid}) added successfully.\n`);
        return 0;
    }
}
