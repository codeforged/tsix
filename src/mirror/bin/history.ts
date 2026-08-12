import { IProgram, OSContext } from "../lib/IProgram";

/**
 * HISTORY Utility
 * 
 * Display the command history list with line numbers.
 */
export class main implements IProgram {
    async execute(os: OSContext, args: string[]): Promise<void> {
        const { std, fs, shell } = os;

        if (args.includes("--help") || args.includes("-h")) {
            await std.print("Usage: history\nDisplay command history.\n");
            return;
        }

        const home = await shell.getenv("HOME") || "/root";
        const historyPath = home + "/.sh_history";

        try {
            const content = await fs.readFile(historyPath);
            if (!content || typeof content !== "string") {
                // Silently exit if no history
                return;
            }

            const lines = content.split("\n").filter(line => line.trim().length > 0);

            for (let i = 0; i < lines.length; i++) {
                await std.print(`  ${i + 1}  ${lines[i]}\n`);
            }
        } catch (e) {
            // history file might not exist or be unreadable
        }
    }
}
