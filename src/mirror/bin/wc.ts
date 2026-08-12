import { IProgram, OSContext } from "../lib/IProgram";

/**
 * WC Utility
 * 
 * Print newline, word, and byte counts for each file.
 * 
 * Flags:
 * -l: Print the newline counts
 * -w: Print the word counts
 * -c: Print the byte counts
 */
export class main implements IProgram {
    async execute(os: OSContext, args: string[]): Promise<void> {
        const { std, fs } = os;

        if (args.includes("--help") || args.includes("-h")) {
            await std.print("Usage: wc [options] [files...]\n\n" +
                "Options:\n" +
                "  -l    Print the newline counts\n" +
                "  -w    Print the word counts\n" +
                "  -c    Print the byte counts\n");
            return;
        }

        let filenames: string[] = [];
        let showLines = false;
        let showWords = false;
        let showChars = false;

        for (const arg of args) {
            if (arg === "-l") showLines = true;
            else if (arg === "-w") showWords = true;
            else if (arg === "-c") showChars = true;
            else if (arg.startsWith("-")) { /* ignore */ }
            else filenames.push(arg);
        }

        // Default: show all
        if (!showLines && !showWords && !showChars) {
            showLines = showWords = showChars = true;
        }

        const processContent = async (content: string, name?: string) => {
            const lines = content.split("\n").length - 1;
            const words = content.trim().split(/\s+/).filter(w => w.length > 0).length;
            const chars = content.length;

            let result = "";
            if (showLines) result += `${lines.toString().padStart(8)} `;
            if (showWords) result += `${words.toString().padStart(8)} `;
            if (showChars) result += `${chars.toString().padStart(8)} `;
            if (name) result += name;

            await std.print(result + "\n");
            return { lines, words, chars };
        };

        if (filenames.length === 0) {
            // Read from stdin
            let pipeBuffer = "";
            while (true) {
                const chunk = await fs.read(0);
                if (chunk === "") break;
                if (chunk === null) {
                    await new Promise(r => setTimeout(r, 10));
                    continue;
                }
                pipeBuffer += chunk;
            }
            await processContent(pipeBuffer);
        } else {
            let totalLines = 0, totalWords = 0, totalChars = 0;

            for (const file of filenames) {
                try {
                    const fd = await fs.open(file, "r");
                    if (fd !== null && fd >= 0) {
                        const content = await fs.read(fd);
                        await fs.close(fd);
                        const res = await processContent(content, file);
                        totalLines += res.lines;
                        totalWords += res.words;
                        totalChars += res.chars;
                    } else {
                        await std.print(`wc: ${file}: No such file\n`);
                    }
                } catch (e: any) {
                    await std.print(`wc: ${file}: ${e.message}\n`);
                }
            }

            if (filenames.length > 1) {
                let result = "";
                if (showLines) result += `${totalLines.toString().padStart(8)} `;
                if (showWords) result += `${totalWords.toString().padStart(8)} `;
                if (showChars) result += `${totalChars.toString().padStart(8)} `;
                result += "total";
                await std.print(result + "\n");
            }
        }
    }
}
