import { IProgram, OSContext } from "../lib/IProgram";

/**
 * ECHO — Write arguments or stdin to standard output.
 *
 * Usage:
 *   echo hello world
 *   echo "hello world"
 *   echo -n hello
 *   ps | echo                 (print piped output)
 */

export class main implements IProgram {
    async execute(os: OSContext, args: string[]): Promise<string | void> {
        const { std, fs, shell } = os;

        if (args.includes("--help") || args.includes("-h")) {
            await std.print("Usage: echo [options] [text...]\n" +
                "  -n    Do not output trailing newline\n");
            return;
        }

        const noNewline = args.includes("-n");
        const textArgs = args.filter(a => a !== "-n");

        if (textArgs.length > 0) {
            await std.print(textArgs.join(" ") + (noNewline ? "" : "\n"));
            return;
        }

        // Pipe mode: read from stdin
        let input = "";
        while (true) {
            const chunk = await fs.read(0);
            if (chunk === null) {
                await new Promise(r => setTimeout(r, 10));
                continue;
            }
            if (chunk === "" || chunk === "FD NOT FOUND") break;
            input += chunk;
        }

        if (input) await std.print(input + (noNewline ? "" : "\n"));
    }
}
