import { IProgram, OSContext } from "../lib/IProgram";
import { detectColor } from "@tsix/ansiLib";

/**
 * LS Utility
 * 
 * List directory contents with various formatting and sorting options.
 * 
 * Flags:
 * -a: Show all (including hidden dotfiles)
 * -l: Long listing format
 * -h: Human-readable sizes (with -l)
 * -F: Classify (add / to dirs, * to executables)
 * -S: Sort by file size
 * -t: Sort by modification time
 * -r: Reverse sort order
 * -R: List subdirectories recursively
 * -A: Show hidden files, excluding . and ..
 * -d: List directories themselves, not their contents
 * -1: List one entry per line
 * -X: Sort by extension
 * -U: Do not sort entries
 * -v: Sort naturally by version numbers
 */
export class main implements IProgram {
    async execute({ fs, shell }: OSContext, args: string[]): Promise<string> {
        const help =
            "Usage: ls [OPTION]... [FILE]...\n\n" +
            "Options:\n" +
            "  -a, --all              Include . and .. and hidden files\n" +
            "  -A, --almost-all       Include hidden files, but not . or ..\n" +
            "  -d, --directory        List directories themselves, not their contents\n" +
            "  -l                     Use long listing format\n" +
            "  -h, --human-readable   Human-readable sizes (with -l)\n" +
            "  -1                     List one entry per line\n" +
            "  -C                     List entries in columns\n" +
            "  -x                     List entries by rows\n" +
            "  -F, --classify         Append / to directories and * to executables\n" +
            "  -R, --recursive        List subdirectories recursively\n" +
            "  -S                     Sort by file size (largest first)\n" +
            "  -t                     Sort by modification time (newest first)\n" +
            "  -X                     Sort by extension\n" +
            "  -U                     Do not sort entries\n" +
            "  -v                     Sort naturally by version numbers\n" +
            "  -r, --reverse          Reverse sorting result\n" +
            "      --sort=WORD        Sort by name, size, time, extension, version, or none\n" +
            "      --color[=WHEN]     Colorize: always, auto, or never\n" +
            "      --help             Show this help\n";
        let isLong = false;
        let showAll = false;
        let showAlmostAll = false;
        let listDirectoryItself = false;
        let layout: "columns" | "across" | "one" = "columns";
        let humanReadable = false;
        let classify = false;
        let sortMode: "name" | "size" | "time" | "extension" | "version" | "none" = "name";
        let reverseSort = false;
        let recursive = false;
        let colorMode: "auto" | "always" | "never" = "auto";

        const filteredArgs: string[] = [];
        let optionsEnded = false;
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (optionsEnded) {
                filteredArgs.push(arg);
                continue;
            }
            if (arg === "--") {
                optionsEnded = true;
                continue;
            }
            if (arg === "--help") return help;
            if (arg === "--recursive") {
                recursive = true;
                continue;
            }
            if (arg === "--all") {
                showAll = true;
                continue;
            }
            if (arg === "--almost-all") {
                showAlmostAll = true;
                continue;
            }
            if (arg === "--directory") {
                listDirectoryItself = true;
                continue;
            }
            if (arg === "--classify") {
                classify = true;
                continue;
            }
            if (arg === "--no-color") {
                colorMode = "never";
                continue;
            }
            if (arg === "--reverse") {
                reverseSort = true;
                continue;
            }
            if (arg === "--human-readable") {
                humanReadable = true;
                continue;
            }
            if (arg === "--color") {
                colorMode = "always";
                continue;
            }
            if (arg.startsWith("--color=")) {
                const mode = arg.slice("--color=".length);
                if (mode === "always" || mode === "auto" || mode === "never") {
                    colorMode = mode;
                } else {
                    return `ls: invalid argument '${mode}' for '--color'\n`;
                }
                continue;
            }
            if (arg === "--sort" || arg.startsWith("--sort=")) {
                const value = arg === "--sort" ? args[++i] : arg.slice("--sort=".length);
                if (
                    value === "name" ||
                    value === "size" ||
                    value === "time" ||
                    value === "extension" ||
                    value === "version" ||
                    value === "none"
                ) {
                    sortMode = value;
                } else {
                    return `ls: invalid sort type '${value ?? ""}'\n`;
                }
                continue;
            }
            if (arg.startsWith("--")) {
                return `ls: unrecognized option '${arg}'\nTry 'ls --help' for more information.\n`;
            }
            if (arg.startsWith("-") && arg.length > 1) {
                const flags = arg.substring(1);
                for (const flag of flags) {
                    if (flag === "l") isLong = true;
                    else if (flag === "a") showAll = true;
                    else if (flag === "A") showAlmostAll = true;
                    else if (flag === "d") listDirectoryItself = true;
                    else if (flag === "1") layout = "one";
                    else if (flag === "C") layout = "columns";
                    else if (flag === "x") layout = "across";
                    else if (flag === "h") humanReadable = true;
                    else if (flag === "F") classify = true;
                    else if (flag === "S") sortMode = "size";
                    else if (flag === "t") sortMode = "time";
                    else if (flag === "X") sortMode = "extension";
                    else if (flag === "U") sortMode = "none";
                    else if (flag === "v") sortMode = "version";
                    else if (flag === "r") reverseSort = true;
                    else if (flag === "R") recursive = true;
                    else return `ls: invalid option -- '${flag}'\nTry 'ls --help' for more information.\n`;
                }
                continue;
            }
            filteredArgs.push(arg);
        }

        // Jika tidak ada argumen target, default ke "."
        const targets = filteredArgs.length > 0 ? filteredArgs : ["."];
        let finalOutput = "";
        const colorEnabled = colorMode === "always"
            ? true
            : colorMode === "never"
              ? false
              : detectColor({
                    TERM: (await shell.getenv("TERM")) ?? "xterm",
                    NO_COLOR: await shell.getenv("NO_COLOR"),
                    FORCE_COLOR: await shell.getenv("FORCE_COLOR"),
                });

        const appendError = (path: string, error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            if (message.toLowerCase().includes("permission")) {
                finalOutput += `ls: cannot open directory '${path}': Permission denied\n`;
            } else {
                finalOutput += `ls: cannot access '${path}': No such file or directory\n`;
            }
        };

        const makeEntries = (files: any[]) => files.map((file: any) => {
            let suffix = "";
            if (classify) {
                if (file.type === "DIRECTORY") suffix = "/";
                else if ((file.mode & 0x49) !== 0) suffix = "*";
            }
            return {
                ...file,
                displayName: file.name + suffix,
                rawName: file.name,
            };
        });

        const appendEntries = async (entries: any[], isDirectory: boolean) => {
            if (isLong) {
                if (entries.length > 0) {
                    const rows: string[] = [];
                    for (const file of entries) {
                        const modeStr = this.formatMode(file.mode, file.type === "DIRECTORY");
                        const size = file.type === "DIRECTORY" ? 0 : (file.size || 0);

                        const date = new Date(file.modified_at || file.createdAt || 0);
                        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                        const dateStr = `${months[date.getMonth()]} ${date.getDate().toString().padStart(2, "0")} ${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
                        const user = await this.resolveUser(fs, file.uid);
                        const group = await this.resolveGroup(fs, file.gid);
                        const coloredName = this.colorizeName(file.displayName, file, colorEnabled);
                        const sizeStr = humanReadable
                            ? this.formatSize(size).padStart(5)
                            : size.toString().padStart(5);

                        rows.push(`${modeStr} 1 ${user.padEnd(8)} ${group.padEnd(8)} ${sizeStr} ${dateStr} ${coloredName}`);
                    }
                    finalOutput += rows.join("\n") + "\n";
                }
                if (isDirectory) finalOutput += "\n";
                return;
            }

            if (entries.length > 0) {
                if (layout === "one") {
                    for (const entry of entries) {
                        finalOutput += this.colorizeName(entry.displayName, entry, colorEnabled) + "\n";
                    }
                } else {
                    const columnsVal = await shell.getenv("COLUMNS");
                    const termWidth = Math.max(1, parseInt(columnsVal || "80", 10) || 80);
                    const maxLen = Math.max(...entries.map((entry: any) => entry.displayName.length)) + 2;
                    const numCols = Math.max(1, Math.floor(termWidth / maxLen));
                    const numRows = Math.ceil(entries.length / numCols);

                    let output = "";
                    for (let row = 0; row < numRows; row++) {
                        let line = "";
                        for (let column = 0; column < numCols; column++) {
                            const index = layout === "across"
                                ? row * numCols + column
                                : column * numRows + row;
                            if (index < entries.length) {
                                const entry = entries[index];
                                const colored = this.colorizeName(entry.displayName, entry, colorEnabled);
                                line += colored + " ".repeat(maxLen - entry.displayName.length);
                            }
                        }
                        output += line.trimEnd() + "\n";
                    }
                    finalOutput += output;
                }
            }
            if (isDirectory) finalOutput += "\n";
        };

        const listDirectory = async (directory: string, showHeading: boolean) => {
            try {
                let files = await fs.ls(directory);
                if (!showAll && !showAlmostAll) {
                    files = files.filter((file: any) => !file.name.startsWith("."));
                }
                if (!showAll) {
                    files = files.filter((file: any) => file.name !== "." && file.name !== "..");
                }

                if (showAll) {
                    const currentInfo = await fs.stat(directory);
                    const normalized = directory.replace(/\/+$/, "");
                    const lastSlash = normalized.lastIndexOf("/");
                    const parentPath = normalized === "."
                        ? ".."
                        : lastSlash < 0
                          ? "."
                          : lastSlash === 0
                            ? "/"
                            : normalized.slice(0, lastSlash);
                    const parentInfo = await fs.stat(parentPath);
                    if (currentInfo && !files.some((file: any) => file.name === ".")) {
                        files.push({ ...currentInfo, name: "." });
                    }
                    if (parentInfo && !files.some((file: any) => file.name === "..")) {
                        files.push({ ...parentInfo, name: ".." });
                    }
                }

                if (sortMode !== "none") {
                    files.sort((a: any, b: any) => {
                        let result = 0;
                        if (sortMode === "size") {
                            result = (b.size || 0) - (a.size || 0);
                        } else if (sortMode === "time") {
                            result = (b.modified_at || 0) - (a.modified_at || 0);
                        } else if (sortMode === "extension") {
                            result = a.name.split(".").pop()!.localeCompare(b.name.split(".").pop()!) ||
                                a.name.localeCompare(b.name);
                        } else if (sortMode === "version") {
                            result = a.name.localeCompare(b.name, undefined, { numeric: true });
                        } else {
                            result = a.name.localeCompare(b.name);
                        }
                        return result;
                    });
                }
                if (reverseSort) files.reverse();

                if (showHeading) {
                    if (finalOutput && !finalOutput.endsWith("\n\n")) finalOutput += "\n";
                    finalOutput += `${directory}:\n`;
                }
                await appendEntries(makeEntries(files), true);

                if (recursive) {
                    for (const file of files) {
                        if (
                            file.type !== "DIRECTORY" ||
                            file.name === "." ||
                            file.name === ".."
                        ) continue;
                        const childPath = directory === "/"
                            ? `/${file.name}`
                            : `${directory.replace(/\/+$/, "")}/${file.name}`;
                        await listDirectory(childPath, true);
                    }
                }
            } catch (error) {
                appendError(directory, error);
            }
        };

        for (const t of targets) {
            try {
                const info = await fs.stat(t);
                if (!info) {
                    finalOutput += `ls: cannot access '${t}': No such file or directory\n`;
                    continue;
                }

                if (info.type === "DIRECTORY" && !listDirectoryItself) {
                    await listDirectory(t, recursive || targets.length > 1);
                } else {
                    const targetEntry = {
                        ...info,
                        name: listDirectoryItself ? t : info.name,
                    };
                    await appendEntries(makeEntries([targetEntry]), false);
                }
            } catch (e: any) {
                appendError(t, e);
            }
        }
        return finalOutput.trimEnd();
    }

    private colorizeName(name: string, info: any, colorEnabled: boolean): string {
        if (!colorEnabled) return name;
        const reset = "\x1b[0m";
        if (info.type === "DIRECTORY") {
            return `\x1b[97m${name}${reset}`; // White
        }

        const isExe = (info.mode & 0x49) !== 0; // Check any 'x' bit
        if (isExe) {
            return `\x1b[32m${name}${reset}`; // Green
        }

        if (name.endsWith(".ts") || name.endsWith(".ts/")) {
            return `\x1b[93m${name}${reset}`; // Yellow
        }

        return name;
    }

    private formatMode(mode: number, isDir: boolean): string {
        const chars = ["---", "--x", "-w-", "-wx", "r--", "r-x", "rw-", "rwx"];
        const owner = chars[(mode >> 6) & 0x7];
        const group = chars[(mode >> 3) & 0x7];
        const others = chars[mode & 0x7];
        return (isDir ? "d" : "-") + owner + group + others;
    }

    private async resolveUser(fs: any, uid: number): Promise<string> {
        if (uid === 0) return "root";
        try {
            const content = await fs.readFile("/etc/passwd");
            if (!content) return uid.toString();
            const lines = content.split("\n");
            for (const line of lines) {
                const parts = line.split(":");
                if (parseInt(parts[2]) === uid) return parts[0];
            }
        } catch (e) { }
        return uid.toString();
    }

    private async resolveGroup(fs: any, gid: number): Promise<string> {
        if (gid === 0) return "root";
        try {
            const content = await fs.readFile("/etc/group");
            if (!content) return gid.toString();
            const lines = content.split("\n");
            for (const line of lines) {
                const parts = line.split(":");
                if (parseInt(parts[2]) === gid) return parts[0];
            }
        } catch (e) { }
        return gid.toString();
    }

    private formatSize(bytes: number): string {
        if (bytes === 0) return "0";
        const units = ["B", "K", "M", "G", "T"];
        const k = 1024;
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        if (i === 0) return bytes.toString();
        return (bytes / Math.pow(k, i)).toFixed(1) + units[i];
    }
}
