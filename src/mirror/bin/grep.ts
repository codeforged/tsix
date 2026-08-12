import { IProgram, OSContext } from "../lib/IProgram";

/**
 * GREP UTILITY
 * 
 * Search for text patterns within files or standard input using regular expressions.
 * 
 * Flags:
 * -i: Case-insensitive search
 * -v: Invert match (show lines that don't match)
 * -n: Show line numbers
 * -r, -R: Recursive search through directories
 * -l: Show only filenames with matches
 * -c: Show only the count of matching lines
 * -w: Match whole words only
 */
export class main implements IProgram {
    async execute(os: OSContext, args: string[]): Promise<void> {
        const { std, fs } = os;

        if (args.includes("--help")) {
            await std.print("Usage: grep [options] <pattern> [files...]\n\n" +
                "Options:\n" +
                "  -i    Case-insensitive search\n" +
                "  -v    Invert match (show non-matching lines)\n" +
                "  -n    Show line numbers\n" +
                "  -r    Recursive search\n" +
                "  -l    List only filenames with matches\n" +
                "  -c    Print only match count per file\n" +
                "  -w    Match whole words only\n");
            return;
        }

        let patternStr = "";
        let filenames: string[] = [];
        let caseInsensitive = false;
        let invertMatch = false;
        let showLineNumbers = false;
        let recursive = false;
        let filesWithMatches = false;
        let countMatches = false;
        let wordRegexp = false;

        // Parse Args
        for (const arg of args) {
            if (arg.startsWith("-") && arg.length > 1) {
                const flags = arg.substring(1);
                for (const flag of flags) {
                    if (flag === "i") caseInsensitive = true;
                    else if (flag === "v") invertMatch = true;
                    else if (flag === "n") showLineNumbers = true;
                    else if (flag === "r" || flag === "R") recursive = true;
                    else if (flag === "l") filesWithMatches = true;
                    else if (flag === "c") countMatches = true;
                    else if (flag === "w") wordRegexp = true;
                }
            } else {
                if (!patternStr) patternStr = arg;
                else filenames.push(arg);
            }
        }

        if (!patternStr) {
            await std.print("Usage: grep [options] <pattern> [files...]\n");
            return;
        }

        let regexPattern = patternStr;
        if (wordRegexp) {
            regexPattern = `\\b${patternStr}\\b`;
        }
        const pattern = new RegExp(regexPattern, caseInsensitive ? "i" : "");

        const processContent = async (content: string, sourceName?: string): Promise<boolean> => {
            const lines = content.split("\n");
            let matchCount = 0;
            let found = false;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const isMatch = pattern.test(line);
                const shouldPrint = invertMatch ? !isMatch : isMatch;

                if (shouldPrint) {
                    found = true;
                    matchCount++;

                    if (filesWithMatches) {
                        if (sourceName) await std.print(`\x1B[35m${sourceName}\x1B[0m\n`);
                        return true; // Stop processing file as soon as a match is found
                    }

                    if (!countMatches) {
                        let output = "";
                        if (sourceName && filenames.length > 1) output += `\x1B[35m${sourceName}\x1B[0m:`;
                        if (showLineNumbers) output += `\x1B[32m${i + 1}\x1B[0m:`;

                        if (!invertMatch) {
                            const highlighted = line.replace(pattern, (match) => `\x1B[1;31m${match}\x1B[0m`);
                            output += highlighted;
                        } else {
                            output += line;
                        }

                        await std.print(output + "\n");
                    }
                }
            }

            if (countMatches) {
                let output = "";
                if (sourceName && filenames.length > 1) output += `\x1B[35m${sourceName}\x1B[0m:`;
                output += matchCount.toString();
                await std.print(output + "\n");
            }

            return found;
        };

        const processFile = async (path: string) => {
            try {
                const stat = await fs.stat(path);
                if (stat.type === "DIRECTORY") {
                    if (recursive) {
                        const items = await fs.ls(path);
                        for (const item of items) {
                            const childPath = (path === "/" ? "/" : path + "/") + item.name;
                            await processFile(childPath);
                        }
                    } else {
                        await std.print(`grep: ${path}: Is a directory\n`);
                    }
                    return;
                }

                const fd = await fs.open(path, "r");
                if (fd !== null && fd >= 0) {
                    const content = await fs.read(fd);
                    await fs.close(fd);
                    await processContent(content, path);
                }
            } catch (e: any) {
                await std.print(`grep: ${path}: ${e.message}\n`);
            }
        };

        if (filenames.length === 0) {
            // Read from stdin (Pipe)
            let pipeBuffer = "";
            while (true) {
                const chunk = await fs.read(0);
                if (chunk === "" || chunk === null) {
                    if (chunk === "") break;
                    await new Promise(r => setTimeout(r, 10));
                    continue;
                }
                pipeBuffer += chunk;
            }
            if (pipeBuffer) await processContent(pipeBuffer);
        } else {
            for (const file of filenames) {
                await processFile(file);
            }
        }
    }
}
