import { IProgram, OSContext } from "../lib/IProgram";

/**
 * ID Utility
 * 
 * Print real and effective user and group IDs.
 */
export class main implements IProgram {
    async execute({ shell, std }: OSContext, args: string[]): Promise<void> {
        if (args.includes("--help") || args.includes("-h")) {
            await std.print("Usage: id\nPrint user and group information.\n");
            return;
        }
        const me = await shell.whoami();
        await std.print(`uid=${me.uid}(${me.username}) gid=${me.gid} groups=${me.groups?.join(",") || me.gid}\n`);
    }
}
