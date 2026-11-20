import { IProgram, OSContext } from "../lib/IProgram";

/**
 * MKDIR Utility
 * 
 * Create directories.
 */
export class main implements IProgram {
    async execute({ fs }: OSContext, args: string[]): Promise<string> {
        if (args.includes("--help") || args.includes("-h")) {
            return "Usage: mkdir <directory>\n" +
                "Create a new directory.\n";
        }
        if (args.length === 0) return "Usage: mkdir <directory>";
        const success = await fs.mkdir(args[0]);

        return success ? `Directory [${args[0]}] created.` : `Failed to create directory [${args[0]}].`;
    }
}
