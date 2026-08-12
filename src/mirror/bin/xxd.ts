import { IProgram, OSContext } from "../lib/IProgram";

/**
 * XXD Utility
 * 
 * Create a hex dump or do the reverse.
 */
export class main implements IProgram {
    async execute({ fs, std }: OSContext, args: string[]): Promise<string | void> {
        if (args.includes("--help") || args.includes("-h")) {
            return "Usage: xxd <filename>\nCreate a hex dump of the specified file.\n";
        }
        if (args.length === 0) {
            return "Usage: xxd <filename>";
        }

        const fileName = args[0];
        try {
            const fd = await fs.open(fileName);
            if (fd === null) {
                return `xxd: ${fileName}: No such file or directory`;
            }

            const content = await fs.read(fd);
            await fs.close(fd);

            if (content === null) return;

            // Convert string to bytes if needed, but our FS usually returns string data.
            // We treat the string characters as byte values.
            const bytes = typeof content === "string" ?
                Array.from(content).map(c => c.charCodeAt(0)) :
                (Array.isArray(content) ? content : []);

            for (let i = 0; i < bytes.length; i += 16) {
                // 1. Offset
                let line = i.toString(16).padStart(8, "0") + ": ";

                // 2. Hex content (grouped by 2 bytes)
                let hexPart = "";
                let asciiPart = "";

                for (let j = 0; j < 16; j++) {
                    if (i + j < bytes.length) {
                        const b = bytes[i + j];
                        hexPart += b.toString(16).padStart(2, "0");
                        if (j % 2 === 1) hexPart += " ";

                        // ASCII part
                        asciiPart += (b >= 32 && b <= 126) ? String.fromCharCode(b) : ".";
                    } else {
                        hexPart += "  ";
                        if (j % 2 === 1) hexPart += " ";
                    }
                }

                line += hexPart.padEnd(40, " ") + " " + asciiPart;
                await std.print(line + "\n");
            }

        } catch (e: any) {
            return `xxd: ${fileName}: ${e.message}`;
        }
    }
}
