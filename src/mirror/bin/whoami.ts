import { UserLib } from "../lib/UserLib";

/**
 * WHOAMI Utility
 * 
 * Print effective user name.
 * 
 * Flags:
 * -l: List all groups the user belongs to.
 */
export default class WhoAmI {
    async execute(lib: any, args: string[]) {
        if (args.includes("--help") || args.includes("-h")) {
            await lib.std.print("Usage: whoami [options]\n\n" +
                "Options:\n" +
                "  -l    List groups the user belongs to\n");
            return 0;
        }
        const info = await lib.shell.whoami();
        const showGroups = args.includes("-l");

        if (!showGroups) {
            await lib.std.print(`${info.username}\n`);
            return 0;
        }

        // --- Handle -l (List groups) ---
        const username = info.username;

        // 1. Resolve groups from /etc/group
        const groupContent = await lib.fs.readFile("/etc/group") || "";
        const groupLines = groupContent.split("\n").map((l: string) => l.trim()).filter((l: string) => l.length > 0);

        let groups: string[] = [];

        // Primary group name
        const primaryGroup = groupLines.find(l => parseInt(l.split(":")[2]) === info.gid);
        if (primaryGroup) groups.push(primaryGroup.split(":")[0]);
        else groups.push(info.gid.toString());

        // Supplementary groups
        groupLines.forEach(l => {
            const parts = l.split(":");
            const members = parts[3] ? parts[3].split(",").map(u => u.trim()) : [];
            if (members.includes(username) && !groups.includes(parts[0])) {
                groups.push(parts[0]);
            }
        });

        await lib.std.print(`${username} (groups: ${groups.join(", ")})\n`);
        return 0;
    }
}
