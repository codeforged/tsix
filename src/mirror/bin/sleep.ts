import { IProgram, OSContext } from "../lib/IProgram";

/**
 * SLEEP Utility
 * 
 * Delay for a specified amount of time.
 */
export class main implements IProgram {
    async execute(os: OSContext, args: string[]): Promise<void> {
        const { std, shell } = os;

        if (args.includes("--help") || args.includes("-h")) {
            await std.print("Usage: sleep <seconds>\n" +
                "Pause for a number of seconds.\n");
            return;
        }

        const seconds = parseInt(args[0]) || 1;

        let interrupted = false;

        // Handle Ctrl+C gracefully
        shell.onSignal("SIGINT", async () => {
            interrupted = true;
            await std.print("\n^C\nInterrupted!\n");
            await shell.exit(130); // Standard exit code for SIGINT
        });

        await std.print(`Tidur dulu ya om selama ${seconds} detik...\n`);

        // Simulasi kerja keras (tidur) dengan check interrupt
        const startTime = Date.now();
        while (Date.now() - startTime < seconds * 1000) {
            if (interrupted) return;
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        if (!interrupted) {
            await std.print("Bangun! Sudah seger lagi.\n");
        }
    }
}
