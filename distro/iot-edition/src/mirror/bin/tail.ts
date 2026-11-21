import { IProgram, OSContext } from "../lib/IProgram";

/**
 * TAIL Utility
 * 
 * Output the last part of files.
 * 
 * Flags:
 * -n <num>: Print the last <num> lines (default: 10).
 * -f:       Follow mode — stay alive, print new lines as file grows.
 * -s <sec>: Sleep interval for -f mode (default: 1 detik).
 */
export class main implements IProgram {
    async execute(os: OSContext, args: string[]): Promise<void> {
        const { std, fs } = os;

        if (args.includes("--help")) {
            await std.print("Usage: tail [options] [files...]\n\n" +
                "Options:\n" +
                "  -n <num>    Print the last <num> lines\n" +
                "  -f          Follow mode (tail -f)\n" +
                "  -s <sec>    Sleep interval for follow (default: 1s)\n");
            return;
        }

        let numLines = 10;
        let followMode = false;
        let sleepSec = 1;
        let filenames: string[] = [];

        // Improved Parser: Handle -n <num>, -f, -s <sec>, -<num>, and plain <num> shorthand
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (arg === "-n" && args[i + 1]) {
                numLines = parseInt(args[i + 1]);
                i++;
            } else if (arg === "-f") {
                followMode = true;
            } else if (arg === "-s" && args[i + 1]) {
                sleepSec = parseInt(args[i + 1]) || 1;
                i++;
            } else if (arg.startsWith("-") && /^-?\d+$/.test(arg)) {
                // Handle -5 or -n5
                numLines = Math.abs(parseInt(arg));
            } else if (/^\d+$/.test(arg) && filenames.length === 0) {
                // Handle "tail 5" (shorthand) if no filenames added yet
                numLines = parseInt(arg);
            } else if (arg === "-") {
                filenames.push("-");
            } else if (arg.startsWith("-")) {
                // Other flags (ignored)
            } else {
                filenames.push(arg);
            }
        }

        const processContent = async (content: string | null, name?: string) => {
            if (content === null) return;

            if (name && filenames.length > 1) {
                await std.print(`==> ${name} <==\n`);
            }
            const lines = content.split("\n");
            // Remove last empty line if exists
            if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

            const tailLines = lines.slice(-numLines);
            await std.print(tailLines.join("\n") + "\n");
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
                if (file === "-") continue;
                try {
                    const fd = await fs.open(file, "r");
                    if (fd !== null && fd >= 0) {
                        const content = await fs.read(fd);
                        await fs.close(fd);
                        if (content !== null) {
                            await processContent(content, file);
                        }
                    } else {
                        await std.print(`tail: ${file}: No such file\n`);
                    }
                } catch (e: any) {
                    await std.print(`tail: ${file}: ${e.message}\n`);
                }
            }

            // --- Follow Mode (-f): Poll file size, print new data ---
            if (followMode && filenames.length > 0) {
                const file = filenames[0];
                let lastSize = 0;
                try {
                    lastSize = await fs.getSize?.(file) || 0;
                } catch (_) {
                    lastSize = 0;
                }

                while (true) {
                    await new Promise(r => setTimeout(r, sleepSec * 1000));
                    try {
                        const curSize = await fs.getSize?.(file) || 0;
                        if (curSize > lastSize) {
                            const newLen = curSize - lastSize;
                            const chunk = await fs.readChunk?.(file, lastSize, newLen);
                            if (chunk) {
                                await std.print(chunk);
                            }
                            lastSize = curSize;
                        }
                    } catch (e) {
                        // File might disappear, keep trying
                    }
                }
            }
        }
    }
}
