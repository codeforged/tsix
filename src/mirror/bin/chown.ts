import { IProgram, OSContext } from "../lib/IProgram";

/**
 * CHOWN Utility
 * 
 * Change file owner and group.
 */
export class main implements IProgram {
    async execute({ fs, std, shell }: OSContext, args: string[]): Promise<string | void> {
        if (args.includes("--help") || args.includes("-h")) {
            return "Usage: chown <user[:group]> <path...>\n\n" +
                "Change ownership of files or directories.\n" +
                "Example: chown root:root /dev/tty\n" +
                "Example: chown 1000:1000 /home/user\n";
        }
        if (args.length < 2) {
            return "Usage: chown <user[:group]> <path...>\nExample: chown root:root /dev/randomdevice\nExample: chown 1000:100 /home/guest";
        }

        const spec = args[0];
        const paths = args.slice(1);

        // 1. Parse spec (user:group)
        let userPart = "";
        let groupPart = "";

        if (spec.includes(":")) {
            [userPart, groupPart] = spec.split(":");
        } else {
            userPart = spec;
        }

        try {
            // 2. Resolve UID
            let targetUid = -1;
            if (userPart !== "") {
                if (/^-?\d+$/.test(userPart)) {
                    targetUid = parseInt(userPart);
                } else {
                    targetUid = await this.resolveUid(fs, userPart);
                    if (targetUid === -1) return `chown: invalid user: '${userPart}'`;
                }
            }

            // 3. Resolve GID
            let targetGid = -1;
            if (groupPart !== "") {
                if (/^-?\d+$/.test(groupPart)) {
                    targetGid = parseInt(groupPart);
                } else {
                    targetGid = await this.resolveGid(fs, groupPart);
                    if (targetGid === -1) return `chown: invalid group: '${groupPart}'`;
                }
            }

            // 4. Execute Syscall for each path
            let errors: string[] = [];
            for (const path of paths) {
                const success = await fs.chown(path, targetUid, targetGid);
                if (!success) {
                    errors.push(`chown: changing ownership of '${path}': Permission denied or invalid path`);
                }
            }

            if (errors.length > 0) return errors.join("\n");
            return;

        } catch (e: any) {
            return `chown: ${e.message}`;
        }
    }

    private async resolveUid(fs: any, username: string): Promise<number> {
        const content = await fs.readFile("/etc/passwd");
        if (!content) return -1;

        const lines = content.split("\n");
        for (const line of lines) {
            const parts = line.split(":");
            if (parts[0] === username) {
                return parseInt(parts[2]);
            }
        }
        return -1;
    }

    private async resolveGid(fs: any, groupname: string): Promise<number> {
        const content = await fs.readFile("/etc/group");
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
