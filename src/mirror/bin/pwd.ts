import { IProgram, OSContext } from "../lib/IProgram";

/**
 * PWD Utility
 * 
 * Print the name of the current/working directory.
 */
export class main implements IProgram {
    async execute({ shell, std }: OSContext, args: string[]): Promise<string | void> {
        if (args.includes("--help") || args.includes("-h")) {
            await std.print("Usage: pwd\nPrint working directory.\n");
            return;
        }
        const cwd = await shell.getcwd();
        return cwd;
    }
}
