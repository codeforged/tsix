import { IProgram, OSContext } from "../lib/IProgram";

/**
 * XARGS — Build and execute command lines from stdin.
 *
 * Usage:
 *   echo "one two three" | xargs echo
 *   ps | awk "/pixel/" | awk "{print \$1}" | xargs kill
 *   ps | awk "/pixel/" | awk "{print \$1}" | xargs kill -9
 *   echo "file1.txt file2.txt" | xargs rm
 *
 * Options:
 *   -n N    Max args per command line (default: all at once)
 *   -I R    Replace string in command (e.g. xargs -I {} echo {} )
 *   -p      Prompt before executing each command
 */

export class main implements IProgram {
    async execute(os: OSContext, args: string[]): Promise<void> {
        const { std, fs, shell } = os;

        if (args.includes("--help") || args.includes("-h")) {
            await std.print(
                "Usage: xargs [options] <command> [initial-args]\n" +
                "\n" +
                "Options:\n" +
                "  -n N    Max args per command line (default: all)\n" +
                "  -I R    Replace string (e.g. xargs -I {} echo files: {})\n" +
                "  -p      Prompt before each command\n" +
                "\n" +
                "Examples:\n" +
                "  echo 'a b c' | xargs echo\n" +
                "  ps | awk '/pixel/' | awk '{print $1}' | xargs kill\n" +
                "  ls /etc | xargs -I {} echo 'Found: {}'\n" +
                "  ps | awk '/pixel/' | awk '{print $1}' | xargs -n 1 kill -9\n"
            );
            return;
        }

        // Read stdin (FD 0 — pipe atau TTY)
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

        if (!input) return;

        // Parse items from stdin (whitespace-separated by default)
        const items = input.trim().split(/\s+/).filter(s => s.length > 0);
        if (items.length === 0) return;

        // Parse xargs options
        let maxArgs = 0; // 0 = all at once
        let replaceStr = "";
        let promptFirst = false;
        let cmdArgs: string[] = [];

        let i = 0;
        while (i < args.length) {
            if (args[i] === "-n" && i + 1 < args.length) {
                maxArgs = parseInt(args[i + 1]);
                i += 2;
            } else if (args[i] === "-I" && i + 1 < args.length) {
                replaceStr = args[i + 1];
                i += 2;
            } else if (args[i] === "-p") {
                promptFirst = true;
                i++;
            } else {
                cmdArgs.push(args[i]);
                i++;
            }
        }

        const command = cmdArgs[0];
        if (!command) return;

        const cmdInitialArgs = cmdArgs.slice(1);

        if (replaceStr) {
            // -I mode: one item at a time, replace string in command + args
            for (const item of items) {
                const fullArgs = cmdInitialArgs.map(a => a.replace(replaceStr, item));
                if (promptFirst) {
                    await std.print(`Execute: ${command} ${fullArgs.join(" ")}? (y/N) `);
                    const answer = await std.readLine();
                    if (answer?.trim().toLowerCase() !== "y") continue;
                }
                try {
                    await shell.exec(command, fullArgs);
                } catch (_) { }
            }
        } else {
            // Batch mode: group items into chunks of maxArgs
            const chunks: string[][] = [];
            if (maxArgs > 0) {
                for (let ci = 0; ci < items.length; ci += maxArgs) {
                    chunks.push(items.slice(ci, ci + maxArgs));
                }
            } else {
                chunks.push([...items]);
            }

            for (const chunk of chunks) {
                const fullArgs = [...cmdInitialArgs, ...chunk];
                if (promptFirst) {
                    await std.print(`Execute: ${command} ${fullArgs.join(" ")}? (y/N) `);
                    const answer = await std.readLine();
                    if (answer?.trim().toLowerCase() !== "y") continue;
                }
                try {
                    await shell.exec(command, fullArgs);
                } catch (_) { }
            }
        }
    }
}
