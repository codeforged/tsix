import { IProgram, OSContext } from "../lib/IProgram";

/**
 * MV Utility
 * 
 * Move or rename files and directories.
 */
export class main implements IProgram {
    async execute({ fs, std }: OSContext, args: string[]): Promise<string> {
        if (args.includes("--help") || args.includes("-h")) {
            return "Usage: mv SOURCE... DEST\n" +
                "Move SOURCE to DEST, or multiple SOURCE(s) to DIRECTORY.\n";
        }
        if (args.length < 2) {
            return "Usage: mv SOURCE... DEST";
        }

        const destPath = args[args.length - 1];
        const sources = args.slice(0, args.length - 1);

        try {
            // Check if destination is a directory
            let isDestDir = false;
            try {
                const destStat = await fs.stat(destPath);
                isDestDir = destStat && destStat.type === "DIRECTORY";
            } catch (e) {
                // If dest does not exist, it's not a directory (yet)
            }

            if (sources.length > 1 && !isDestDir) {
                return `mv: target '${destPath}' is not a directory`;
            }

            for (const src of sources) {
                try {
                    const srcStat = await fs.stat(src);
                    if (!srcStat) {
                        await std.print(`mv: cannot stat '${src}': No such file or directory\n`);
                        continue;
                    }

                    // Determine final destination path
                    let finalDest = destPath;
                    if (isDestDir) {
                        const parts = src.split("/").filter(p => p.length > 0);
                        const filename = parts.pop() || src;
                        finalDest = (destPath.endsWith("/") ? destPath : destPath + "/") + filename;
                    }

                    // Check if we are moving a directory to itself or its child
                    if (finalDest.startsWith(src + "/")) {
                        await std.print(`mv: cannot move '${src}' to a subdirectory of itself, '${finalDest}'\n`);
                        continue;
                    }

                    await this.moveRecursive(fs, std, src, finalDest);

                } catch (e: any) {
                    await std.print(`mv: error moving '${src}': ${e.message}\n`);
                }
            }
        } catch (e: any) {
            return `mv: ${e.message}`;
        }

        return "";
    }

    private async moveRecursive(fs: any, std: any, src: string, dest: string): Promise<void> {
        const stat = await fs.stat(src);
        if (!stat) return;

        if (stat.type === "DIRECTORY") {
            // Create destination directory
            await fs.mkdir(dest);

            // List contents
            const entries = await fs.ls(src);
            for (const entry of entries) {
                const subSrc = (src.endsWith("/") ? src : src + "/") + entry.name;
                const subDest = (dest.endsWith("/") ? dest : dest + "/") + entry.name;
                await this.moveRecursive(fs, std, subSrc, subDest);
            }

            // Remove source directory
            await fs.rmdir(src);
        } else {
            // File move: Copy and then Unlink
            const fd = await fs.open(src);
            if (fd === null) throw new Error(`Cannot open ${src}`);
            const content = await fs.read(fd);
            await fs.close(fd);

            const destFd = await fs.open(dest, "w");
            if (destFd === null) throw new Error(`Cannot create ${dest}`);
            await fs.write(destFd, content);
            await fs.close(destFd);

            await fs.unlink(src);
        }
    }
}
