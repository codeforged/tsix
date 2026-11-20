import { IProgram, OSContext } from "../lib/IProgram";

/**
 * LESS Utility
 * 
 * Opposite of more. A terminal pager that allows backward movement.
 */
export class main implements IProgram {
    async execute(os: OSContext, args: string[]): Promise<void> {
        const { std, fs, shell } = os;

        if (args.includes("--help") || args.includes("-h")) {
            await std.print("Usage: less [file]\n" +
                "A filter for paging through text one screenful at a time.\n");
            return;
        }

        let content = "";
        let lessSource = "";
        let isPiped = false;

        if (args.length < 1) {
            // Read from stdin (Pipe mode)
            isPiped = true;
            lessSource = "";

            let pipeBuffer = "";
            while (true) {
                const chunk = await fs.read(0);
                if (chunk === "" || chunk === null) {
                    if (chunk === "") break; // Real EOF
                    await new Promise(r => setTimeout(r, 10));
                    continue;
                }
                pipeBuffer += chunk;
            }
            content = pipeBuffer;

            // --- CRITICAL FIX: Switch to /dev/tty for interactive commands ---
            // Stdin (FD 0) is a pipe and reached EOF. We need keyboard now.
            const ttyFd = await fs.open("/dev/tty", "r");
            if (ttyFd >= 0) {
                std.setStdin(ttyFd);
            }
        } else {
            const filename = args[0];
            lessSource = `${filename} `;
            try {
                const fd = await fs.open(filename);
                if (fd === null || fd < 0) {
                    await std.print(`less: ${filename}: No such file\n`);
                    return;
                }
                content = await fs.read(fd);
                await fs.close(fd);
            } catch (e: any) {
                await std.print(`less: error reading file: ${e.message}\n`);
                return;
            }
        }

        if (content === undefined || content === null) {
            await std.print("less: No content to display\n");
            return;
        }

        const lines = content.split("\n");
        const totalLines = lines.length;

        // Get Screen Info from environment variables or fallback
        const envLines = parseInt(await shell.getenv("LINES") || "24");
        const envColumns = parseInt(await shell.getenv("COLUMNS") || "80");
        let screen = await std.getScreenInfo() || { lines: envLines, columns: envColumns };
        let rows = screen.lines;
        let cols = screen.columns;

        // Buffer state
        let topLine = 0; // Index baris pertama yang tampil
        let quit = false;

        // UI Helpers
        const hideCursor = "\x1B[?25l";
        const showCursor = "\x1B[?25h";

        /**
         * Render ulang seluruh layar.
         * Digunakan saat pertama kali buka, resize, atau lompat jauh (PageUp/Dn).
         */
        const fullRedraw = async () => {
            await std.print("\x1B[H\x1B[J"); // Move home and clear
            const end = Math.min(topLine + rows - 1, totalLines);
            let pageOutput = "";
            for (let i = topLine; i < end; i++) {
                pageOutput += lines[i].substring(0, cols) + "\n";
            }
            // Kosongkan baris sisa jika file pendek
            for (let i = end - topLine; i < rows - 1; i++) {
                pageOutput += "~\n";
            }
            await std.print(pageOutput);
            await drawStatus();
        };

        const drawStatus = async () => {
            // Pindah ke baris terakhir
            const percent = Math.floor(((topLine + rows - 1) / totalLines) * 100);
            const status = `\x1B[${rows};1H\x1B[7m${lessSource}(Line ${topLine + 1}/${totalLines}) ${Math.min(100, percent)}% [q to quit] \x1B[0m\x1B[K`;
            await std.print(status);
        };

        const scrollDown = async () => {
            if (topLine + rows - 1 >= totalLines) return;

            topLine++;
            // ANSI Scroll Up (Geser konten ke atas 1 baris)
            // Region: baris 1 s/d rows-1
            await std.print(`\x1B[1;${rows - 1}r`); // Set scrolling region
            await std.print(`\x1B[${rows - 1};1H\x1B[1S`); // Goto bottom row of region & scroll up

            // Tulis baris baru di bawah
            const newLineIdx = topLine + rows - 2;
            await std.print(`\x1B[${rows - 1};1H\x1B[K${lines[newLineIdx].substring(0, cols)}`);

            await std.print("\x1B[r"); // Reset region
            await drawStatus();
        };

        const scrollUp = async () => {
            if (topLine <= 0) return;

            topLine--;
            // ANSI Scroll Down (Geser konten ke bawah 1 baris)
            await std.print(`\x1B[1;${rows - 1}r`); // Set scrolling region
            await std.print(`\x1B[1;1H\x1B[1T`);   // Goto top row of region & scroll down

            // Tulis baris baru di atas
            await std.print(`\x1B[1;1H\x1B[K${lines[topLine].substring(0, cols)}`);

            await std.print("\x1B[r"); // Reset region
            await drawStatus();
        };

        // SETUP TERMINAL
        await std.setRawMode(true);
        await std.print(hideCursor);
        await fullRedraw();

        const getNextChar = async () => {
            return await std.getChar();
        };

        try {
            while (!quit) {
                const char = await getNextChar();

                if (char === "q") {
                    quit = true;
                }
                else if (char === "j" || char === "\r" || char === "\n") {
                    await scrollDown();
                }
                else if (char === "k") {
                    await scrollUp();
                }
                else if (char === " ") { // Next Page
                    topLine = Math.min(topLine + rows - 1, Math.max(0, totalLines - rows + 1));
                    await fullRedraw();
                }
                else if (char === "b") { // Prev Page
                    topLine = Math.max(0, topLine - (rows - 1));
                    await fullRedraw();
                }
                else if (char === "g") { // Home
                    topLine = 0;
                    await fullRedraw();
                }
                else if (char === "G") { // End
                    topLine = Math.max(0, totalLines - rows + 1);
                    await fullRedraw();
                }
                else if (char === "\x1B") { // ESC (Sequences)
                    // Check if more data is available for escape sequence
                    const next1 = await std.poll();
                    if (next1 === "[") {
                        await std.getChar(); // consume [
                        const next2 = await std.getChar();
                        if (next2 === "A") await scrollUp();    // Up
                        else if (next2 === "B") await scrollDown(); // Down
                        else if (next2 === "5") { // PageUp? (Esc[5~)
                            await std.getChar(); // consume ~
                            topLine = Math.max(0, topLine - (rows - 1));
                            await fullRedraw();
                        }
                        else if (next2 === "6") { // PageDown? (Esc[6~)
                            await std.getChar(); // consume ~
                            topLine = Math.min(topLine + rows - 1, Math.max(0, totalLines - rows + 1));
                            await fullRedraw();
                        }
                    }
                }
            }
        } finally {
            await std.print(showCursor + "\x1B[H\x1B[J"); // Home and clear screen
            await std.setRawMode(false);
        }
    }
}
