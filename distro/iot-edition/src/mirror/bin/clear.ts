import { IProgram, OSContext } from "../lib/IProgram";

/**
 * CLEAR Utility
 * 
 * Clear the terminal screen.
 */
export class main implements IProgram {
    async execute({ fs, std }: OSContext, args: string[]): Promise<void> {
        if (args.includes("--help") || args.includes("-h")) {
            await std.print("Usage: clear\nClear the screen.\n");
            return;
        }
        await fs.write(1, "\x1bc"); // FD 1 = stdout
    }
}

