import { IProgram, OSContext } from "../lib/IProgram";

/**
 * HEAD Utility
 * 
 * Output the first part of files.
 * 
 * Flags:
 * -n <num>: Print the first <num> lines (default: 10).
 */
export class main implements IProgram {
    async execute(os: OSContext, args: string[]): Promise<void> {
        const { std, fs } = os;

        if (args.includes("--help")) {
            await std.print("Usage: head [options] [files...]\n\n" +
                "Options:\n" +
                "  -n <num>    Print the first <num> lines\n");
            return;
        }

        let numLines = 10;
        let filenames: string[] = [];

        // Improved Parser: Handle -n <num>, -<num>, and plain <num> shorthand
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (arg === "-n" && args[i + 1]) {
                numLines = parseInt(args[i + 1]);
                i++;
            } else if (arg.startsWith("-") && /^-?\d+$/.test(arg)) {
                // Handle -5 or -n5
                numLines = Math.abs(parseInt(arg));
            } else if (/^\d+$/.test(arg) && filenames.length === 0) {
                // Handle "head 5" (shorthand) if no filenames added yet
                numLines = parseInt(arg);
            } else if (arg === "-") {
                // Standard way to represent stdin
                filenames.push("-");
            } else if (arg.startsWith("-")) {
                // Other flags (ignored for now)
            } else {
                filenames.push(arg);
            }
        }

        const processContent = async (content: string | null, name?: string) => {
            if (content === null) return;

            if (name && filenames.length > 1) {
                await std.print(`==> ${name} <==\n`);
            }
            const lines = content.split("\n").slice(0, numLines);
            await std.print(lines.join("\n") + "\n");
        };

        if (filenames.length === 0 || (filenames.length === 1 && filenames[0] === "-")) {
            // Read from stdin
            let pipeBuffer = "";
            while (true) {
                const chunk = await fs.read(0);
                if (chunk === "") break; // Proper EOF
                if (chunk === null) {
                    await new Promise(r => setTimeout(r, 10));
                    continue;
                }
                pipeBuffer += chunk;
            }
            await processContent(pipeBuffer);
        } else {
            for (const file of filenames) {
                if (file === "-") {
                    // Mixed stdin (rare but supported)
                    // ... (omitted for simplicity, but could be added)
                    continue;
                }
                try {
                    const fd = await fs.open(file, "r");
                    if (fd !== null && fd >= 0) {
                        const content = await fs.read(fd);
                        await fs.close(fd);
                        if (content !== null) {
                            await processContent(content, file);
                        }
                    } else {
                        await std.print(`head: ${file}: No such file\n`);
                    }
                } catch (e: any) {
                    await std.print(`head: ${file}: ${e.message}\n`);
                }
            }
        }
    }
}
