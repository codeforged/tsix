import { UserLib } from "../lib/UserLib";

/**
 * CHGRP Utility
 *
 * Change the group ownership of files or directories.
 * 
 * Usage:
 *   chgrp <group> <path...>
 */
export default class Chgrp {
    async execute(lib: UserLib, args: string[]) {
        if (args.includes("--help") || args.includes("-h")) {
            await lib.std.print("Usage: chgrp <group> <path...>\n\n" +
                "Change the group ownership of files or directories.\n" +
                "Example: chgrp devs /home/babam\n" +
                "         chgrp 1001 /home/babam\n");
            return 0;
        }

        if (args.length < 2) {
            await lib.std.print("Usage: chgrp <group> <path...>\n");
            return 1;
        }

        const groupSpec = args[0];
        const paths = args.slice(1);

        // 1. Resolve GID
        let targetGid = -1;
        if (/^-?\d+$/.test(groupSpec)) {
            targetGid = parseInt(groupSpec);
        } else {
            targetGid = await this.resolveGid(lib, groupSpec);
            if (targetGid === -1) {
                await lib.std.print(`chgrp: invalid group: '${groupSpec}'\n`);
                return 1;
            }
        }

        // 2. Change group on each path (uid = -1 keeps the current owner)
        let errors: string[] = [];
        for (const path of paths) {
            const success = await lib.fs.chown(path, -1, targetGid);
            if (!success) {
                errors.push(`chgrp: changing group of '${path}': Permission denied or invalid path`);
            }
        }

        if (errors.length > 0) {
            await lib.std.print(errors.join("\n") + "\n");
            return 1;
        }
        return 0;
    }

    private async resolveGid(lib: UserLib, groupname: string): Promise<number> {
        const content = await lib.fs.readFile("/etc/group");
        if (!content) return -1;

        const lines = content.split("\n");
        for (const line of lines) {
            const parts = line.split(":");
            if (parts[0] === groupname) {
                return parseInt(parts[2]);
            }
        }
        return -1;
    }
}
