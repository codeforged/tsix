import { UserLib } from "../lib/UserLib";

/**
 * GROUPMOD Utility
 *
 * Modify a group: rename it and/or change its GID.
 *
 * Usage:
 *   groupmod [-n NEWNAME] [-g NEWGID] <groupname>
 * Options: 
 *   -n NEWNAME  Rename the group
 *   -g NEWGID   Change the group ID
 */
export default class GroupMod {
    async execute(lib: UserLib, args: string[]) {
        if (args.includes("--help") || args.includes("-h")) {
            await lib.std.print("Usage: groupmod [-n NEWNAME] [-g NEWGID] <groupname>\n\n" +
                "Options:\n" +
                "  -n NEWNAME  Rename the group\n" +
                "  -g NEWGID   Change the group ID\n" +
                "Example: groupmod -n developers devs\n" +
                "         groupmod -g 1006 devs\n");
            return 0;
        }

        const { uid } = await lib.shell.whoami();
        if (uid !== 0) {
            await lib.std.print("groupmod: Permission denied (must be root)\n");
            return 1;
        }

        // 1. Parse arguments
        let newName = "";
        let newGid = -1;
        const positional: string[] = [];
        for (let i = 0; i < args.length; i++) {
            if (args[i] === "-n" && args[i + 1]) {
                newName = args[i + 1].trim();
                i++;
            } else if (args[i] === "-g" && args[i + 1]) {
                newGid = parseInt(args[i + 1]);
                if (isNaN(newGid) || newGid < 0) {
                    await lib.std.print(`groupmod: invalid GID '${args[i + 1]}'\n`);
                    return 1;
                }
                i++;
            } else {
                positional.push(args[i]);
            }
        }

        if (positional.length !== 1) {
            await lib.std.print("Usage: groupmod [-n NEWNAME] [-g NEWGID] <groupname>\n");
            return 1;
        }
        if (!newName && newGid === -1) {
            await lib.std.print("groupmod: no changes specified (use -n or -g)\n");
            return 1;
        }

        const groupName = positional[0].trim();

        // 2. Read /etc/group
        const groupContent = await lib.fs.readFile("/etc/group") || "";
        const lines = groupContent.split("\n").map(l => l.trim()).filter(l => l.length > 0);

        const idx = lines.findIndex(l => l.split(":")[0] === groupName);
        if (idx === -1) {
            await lib.std.print(`groupmod: group '${groupName}' does not exist\n`);
            return 1;
        }

        const parts = lines[idx].split(":");
        const oldGid = parseInt(parts[2]);

        // 3. Validate / apply changes
        if (newName) {
            if (lines.some(l => l.split(":")[0] === newName && l !== lines[idx])) {
                await lib.std.print(`groupmod: group name '${newName}' already exists\n`);
                return 1;
            }
            parts[0] = newName;
        }
        if (newGid !== -1) {
            if (lines.some(l => parseInt(l.split(":")[2]) === newGid && l !== lines[idx])) {
                await lib.std.print(`groupmod: GID '${newGid}' already exists\n`);
                return 1;
            }
            parts[2] = String(newGid);
        }

        lines[idx] = parts.join(":");

        const success = await lib.fs.writeFile("/etc/group", lines.join("\n") + "\n");
        if (!success) {
            await lib.std.print("groupmod: Failed to write /etc/group\n");
            return 1;
        }

        // 4. If GID changed and this group is a primary group, sync /etc/passwd
        if (newGid !== -1 && oldGid !== newGid) {
            const passwdContent = await lib.fs.readFile("/etc/passwd") || "";
            const passwdLines = passwdContent.split("\n").map(l => l.trim()).filter(l => l.length > 0);
            let passwdChanged = false;
            const newPasswd = passwdLines.map(l => {
                const p = l.split(":");
                if (parseInt(p[3]) === oldGid) {
                    p[3] = String(newGid);
                    passwdChanged = true;
                }
                return p.join(":");
            });
            if (passwdChanged) {
                await lib.fs.writeFile("/etc/passwd", newPasswd.join("\n") + "\n");
            }
        }

        await lib.std.print(`Group '${groupName}' updated successfully.\n`);
        return 0;
    }
}
