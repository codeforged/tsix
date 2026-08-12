import { IProgram, OSContext } from "../lib/IProgram";

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
 */
export class main implements IProgram {
    async execute({ fs, shell, std }: OSContext, args: string[]): Promise<string> {
        if (args.includes("--help") || args.includes("-h")) {
            return "Usage: ls [options] [targets...]\n\n" +
                "Options:\n" +
                "  -a    Show all files including hidden ones\n" +
                "  -l    Use long listing format\n" +
                "  -h    Human-readable sizes (e.g. 1.2K, 4.5M)\n" +
                "  -F    Classify entries (dirs/, exe*)\n" +
                "  -S    Sort by file size (largest first)\n" +
                "  -t    Sort by modification time (newest first)\n" +
                "  -r    Reverse sorting result\n";
        }
        let isLong = false;
        let showAll = false;
        let humanReadable = false;
        let classify = false;
        let sortBySize = false;
        let sortByTime = false;
        let reverseSort = false;

        // Simple Flag Parsing
        const filteredArgs = args.filter(arg => {
            if (arg.startsWith("-") && arg.length > 1) {
                const flags = arg.substring(1);
                for (const flag of flags) {
                    if (flag === "l") isLong = true;
                    else if (flag === "a") showAll = true;
                    else if (flag === "h") humanReadable = true;
                    else if (flag === "F") classify = true;
                    else if (flag === "S") sortBySize = true;
                    else if (flag === "t") sortByTime = true;
                    else if (flag === "r") reverseSort = true;
                }
                return false;
            }
            return true;
        });

        // Jika tidak ada argumen target, default ke "."
        const targets = filteredArgs.length > 0 ? filteredArgs : ["."];
        let finalOutput = "";

        for (const t of targets) {
            try {
                const info = await fs.stat(t);
                if (!info) {
                    finalOutput += `ls: cannot access '${t}': No such file or directory\n`;
                    continue;
                }

                let entries: any[] = [];
                if (info.type === "DIRECTORY") {
                    if (targets.length > 1) finalOutput += `${t}:\n`;
                    let files = await fs.ls(t);

                    // Hidden files filtering
                    if (!showAll) {
                        files = files.filter((f: any) => !f.name.startsWith("."));
                    }

                    // Sorting
                    if (sortBySize) {
                        files.sort((a: any, b: any) => (b.size || 0) - (a.size || 0));
                    } else if (sortByTime) {
                        files.sort((a: any, b: any) => (b.modified_at || 0) - (a.modified_at || 0));
                    } else {
                        files.sort((a: any, b: any) => a.name.localeCompare(b.name));
                    }

                    if (reverseSort) files.reverse();

                    entries = files.map((f: any) => {
                        let suffix = "";
                        if (classify) {
                            if (f.type === "DIRECTORY") suffix = "/";
                            else if ((f.mode & 0x49) !== 0) suffix = "*";
                        } else if (f.type === "DIRECTORY") {
                            suffix = "/";
                        }
                        const name = f.name + suffix;
                        return { ...f, displayName: name, rawName: f.name };
                    });
                } else {
                    // Jika ini file, tampilkan info filenya saja
                    entries = [{ ...info, displayName: info.name }];
                }

                if (isLong) {
                    const rows: string[] = [];
                    for (const f of entries) {
                        const modeStr = this.formatMode(f.mode, f.type === "DIRECTORY");
                        const size = f.type === 'DIRECTORY' ? 0 : (f.size || 0);

                        const d = new Date(f.modified_at || f.createdAt || 0);
                        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                        const dateStr = `${months[d.getMonth()]} ${d.getDate().toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;

                        // Resolve names if possible (cached would be better but simple for now)
                        const user = await this.resolveUser(fs, f.uid);
                        const group = await this.resolveGroup(fs, f.gid);

                        const coloredName = this.colorizeName(f.displayName, f);
                        const sizeStr = humanReadable ? this.formatSize(size).padStart(5) : size.toString().padStart(5);

                        rows.push(`${modeStr} 1 ${user.padEnd(8)} ${group.padEnd(8)} ${sizeStr} ${dateStr} ${coloredName}`);
                    }
                    finalOutput += rows.join("\n") + "\n";
                    if (info.type === "DIRECTORY") finalOutput += "\n";
                }
                else {
                    const columnsVal = await shell.getenv("COLUMNS");
                    const termWidth = parseInt(columnsVal || "80");

                    const maxLen = Math.max(...entries.map((e: any) => e.displayName.length)) + 2;
                    const numCols = Math.max(1, Math.floor(termWidth / maxLen));
                    const numRows = Math.ceil(entries.length / numCols);

                    let output = "";
                    for (let r = 0; r < numRows; r++) {
                        let line = "";
                        for (let c = 0; c < numCols; c++) {
                            const idx = c * numRows + r;
                            if (idx < entries.length) {
                                const entry = entries[idx];
                                const colored = this.colorizeName(entry.displayName, entry);
                                // Pad based on uncolored name length
                                line += colored + " ".repeat(maxLen - entry.displayName.length);
                            }
                        }
                        output += line.trimEnd() + "\n";
                    }
                    finalOutput += output;
                    if (info.type === "DIRECTORY") finalOutput += "\n";
                }
            } catch (e: any) {
                const msg = (e?.message || "").toLowerCase();
                if (msg.includes("permission")) {
                    finalOutput += `ls: cannot open directory '${t}': Permission denied\n`;
                } else {
                    finalOutput += `ls: cannot access '${t}': No such file or directory\n`;
                }
            }
        }
        return finalOutput.trimEnd();
    }

    private colorizeName(name: string, info: any): string {
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
