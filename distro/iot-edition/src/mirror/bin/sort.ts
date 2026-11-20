import { IProgram, OSContext } from "../lib/IProgram";

/**
 * SORT Utility
 * 
 * Sort lines of text files.
 * 
 * Flags:
 * -r: Reverse sort order
 * -n: Numerical sort
 * -u: Unique (remove duplicate lines)
 */
export class main implements IProgram {
    async execute(os: OSContext, args: string[]): Promise<void> {
        const { std, fs } = os;

        if (args.includes("--help") || args.includes("-h")) {
            await std.print("Usage: sort [options] [files...]\n\n" +
                "Options:\n" +
                "  -r    Reverse sort order\n" +
                "  -n    Numerical sort\n" +
                "  -u    Unique (remove duplicate lines)\n");
            return;
        }

        let filenames: string[] = [];
        let reverse = false;
        let numeric = false;
        let unique = false;

        for (const arg of args) {
            if (arg === "-r") reverse = true;
            else if (arg === "-n") numeric = true;
            else if (arg === "-u") unique = true;
            else if (arg.startsWith("-")) { /* ignore */ }
            else filenames.push(arg);
        }

        let content = "";

        if (filenames.length === 0) {
            // Read from stdin (Pipe)
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
            for (const file of filenames) {
                try {
                    const fd = await fs.open(file, "r");
                    if (fd !== null && fd >= 0) {
                        content += await fs.read(fd);
                        await fs.close(fd);
                    } else {
                        await std.print(`sort: ${file}: No such file\n`);
                    }
                } catch (e: any) {
                    await std.print(`sort: ${file}: ${e.message}\n`);
                }
            }
        }

        if (!content && content !== "") return;

        let lines = content.split("\n").filter(l => l.length > 0);

        if (numeric) {
            lines.sort((a, b) => {
                const numA = parseFloat(a);
                const numB = parseFloat(b);
                if (isNaN(numA) && isNaN(numB)) return a.localeCompare(b);
                if (isNaN(numA)) return -1;
                if (isNaN(numB)) return 1;
                return numA - numB;
            });
        } else {
            lines.sort();
        }

        if (reverse) {
            lines.reverse();
        }

        if (unique) {
            lines = [...new Set(lines)];
        }

        await std.print(lines.join("\n") + "\n");
    }
}
