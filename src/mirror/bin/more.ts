import { IProgram, OSContext } from "../lib/IProgram";

/**
 * MORE Utility
 * 
 * A filter for paging through text one screenful at a time.
 */
export class main implements IProgram {
    async execute(os: OSContext, args: string[]): Promise<void> {
        const { std, fs } = os;

        if (args.includes("--help") || args.includes("-h")) {
            await std.print("Usage: more [file]\n" +
                "Display file contents one screen at a time.\n");
            return;
        }

        let content = "";
        let moreSource = "";

        if (args.length < 1) {
            // Read from stdin (Pipe mode)
            moreSource = "stdin";
            let pipeBuffer = "";
            while (true) {
                const chunk = await fs.read(0);
                if (chunk === "") break; // Proper EOF
                if (chunk === null) {
                    await new Promise(r => setTimeout(r, 10)); // Wait if pipe is empty but open
                    continue;
                }
                pipeBuffer += chunk;
            }
            content = pipeBuffer;
        } else {
            const filename = args[0];
            moreSource = filename;
            try {
                const fd = await fs.open(filename);
                if (fd === null || fd < 0) {
                    await std.print(`more: ${filename}: No such file\n`);
                    return;
                }
                content = await fs.read(fd);
                await fs.close(fd);
            } catch (e: any) {
                await std.print(`more: error reading file: ${e.message}\n`);
                return;
            }
        }

        // After reading content, try to use /dev/tty for user interaction.
        try {
            const ttyFd = await fs.open("/dev/tty", "r");
            if (ttyFd >= 0) {
                std.setStdin(ttyFd);
            }
        } catch (e) { }


        if (!content && content !== "") return;

        const lines = content.split("\n");
        const totalLines = lines.length;

        // Get Screen Info
        const envLines = parseInt(await os.shell.getenv("LINES") || "24");
        const envColumns = parseInt(await os.shell.getenv("COLUMNS") || "80");
        const screen = await std.getScreenInfo() || { lines: envLines, columns: envColumns };

        let linesCount = parseInt(screen.lines?.toString()) || envLines || 24;
        const pageSize = Math.max(1, linesCount - 2);
        const columns = parseInt(screen.columns?.toString()) || envColumns || 80;


        let currentLine = 0;
        let quit = false;

        // Dedicated Keyboard for Interaction
        await std.setRawMode(true);

        const getNextChar = async () => {
            return await std.getChar();
        };

        try {
            while (currentLine < totalLines && !quit) {
                const endLine = Math.min(currentLine + pageSize, totalLines);
                for (let i = currentLine; i < endLine; i++) {
                    await std.print(lines[i] + "\n");
                }
                currentLine = endLine;

                if (currentLine >= totalLines) break;

                // Interaction Loop
                while (true) {
                    const percent = totalLines > 0 ? Math.floor((currentLine / totalLines) * 100) : 0;

                    await std.print(`\x1B[7m--More (${percent}%)--\x1B[0m`);

                    const char = await getNextChar();

                    if (char === null) {
                        // EOF on interaction device: Exit paging
                        quit = true;
                        break;
                    }

                    await std.print("\r\x1B[K");


                    if (char === "q" || char === "Q" || char === "\u0003") {
                        quit = true;
                        break;
                    }
                    else if (char === " ") { // Space: Next Page
                        break;
                    }
                    else if (char === "\r" || char === "\n") { // Enter: Next Line
                        if (currentLine < totalLines) {
                            await std.print(lines[currentLine] + "\n");
                            currentLine++;
                        }
                        if (currentLine >= totalLines) {
                            quit = true;
                            break;
                        }
                    }
                }
            }
        } catch (e) {
            // ignore
        } finally {
            await std.setRawMode(false);
        }
    }
}
