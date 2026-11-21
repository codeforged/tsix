import { IProgram, OSContext } from "../lib/IProgram";

/**
 * CP Utility
 * 
 * Copy files and directories.
 */
export class main implements IProgram {
    async execute({ fs, std }: OSContext, args: string[]): Promise<string> {
        if (args.includes("--help") || args.includes("-h")) {
            return "Usage: cp SOURCE... DEST\n" +
                "Copy SOURCE to DEST, or multiple SOURCE(s) to DIRECTORY.\n";
        }
        if (args.length < 2) {
            return "Usage: cp SOURCE... DEST";
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
                return `cp: target '${destPath}' is not a directory`;
            }

            for (const src of sources) {
                try {
                    const srcStat = await fs.stat(src);
                    if (!srcStat) {
                        await std.print(`cp: cannot stat '${src}': No such file or directory\n`);
                        continue;
                    }

                    if (srcStat.type === "DIRECTORY") {
                        await std.print(`cp: -r not specified; omitting directory '${src}'\n`);
                        continue;
                    }

                    // Open source file
                    const srcFd = await fs.open(src);
                    if (srcFd === null) {
                        await std.print(`cp: cannot open '${src}' for reading\n`);
                        continue;
                    }

                    const content = await fs.read(srcFd);
                    await fs.close(srcFd);

                    // Jangan percaya buta pada hasil read.
                    //
                    // Kejadian nyata: `read` file 70 MB dari mount NetFS mengembalikan
                    // KOSONG tanpa error (jalur fallback readChunk), lalu `cp`
                    // melaporkan sukses dengan file 0 byte — korupsi senyap, lebih
                    // buruk daripada gagal. Metadata sudah menyebut ukurannya, jadi
                    // bandingkan dulu sebelum menulis apa pun.
                    const expected = Number(srcStat.size ?? -1);
                    const got = content === null || content === undefined ? -1 : content.length;
                    if (expected > 0 && got !== expected) {
                        await std.print(
                            `cp: '${src}' terbaca ${got < 0 ? "kosong" : `${got} byte`}, ` +
                                `metadata ${expected} byte — dibatalkan\n`,
                        );
                        continue;
                    }

                    // Determine final destination path
                    let finalDest = destPath;
                    if (isDestDir) {
                        // Extract filename from source
                        const parts = src.split("/");
                        const filename = parts.pop() || src;
                        finalDest = (destPath.endsWith("/") ? destPath : destPath + "/") + filename;
                    }

                    // Write to destination
                    const destFd = await fs.open(finalDest, "w");
                    if (destFd !== null) {
                        await fs.write(destFd, content);
                        await fs.close(destFd);
                    } else {
                        await std.print(`cp: cannot create '${finalDest}'\n`);
                    }

                } catch (e: any) {
                    await std.print(`cp: error copying '${src}': ${e.message}\n`);
                }
            }
        } catch (e: any) {
            return `cp: ${e.message}`;
        }

        return "";
    }
}
