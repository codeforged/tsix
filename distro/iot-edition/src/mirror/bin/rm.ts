import { IProgram, OSContext } from "../lib/IProgram";

/**
 * RM Utility
 *
 * Remove files or directories.
 *
 * Flags:
 * -r, -R: Recursive removal of directories.
 * -f:     Force — diam untuk file yang tidak ada. Dipakai skrip boot untuk
 *         membersihkan marker basi: `rm -f /var/run/dome.ready`.
 *
 * Flag gabungan (`-rf`, `-fr`) juga didukung, seperti coreutils.
 */
export class main implements IProgram {
    private fs: any;

    async execute({ fs, std }: OSContext, args: string[]): Promise<string> {
        this.fs = fs;

        if (args.includes("--help") || args.includes("-h")) {
            return "Usage: rm [options] <target1> <target2> ...\n\n" +
                "Options:\n" +
                "  -f        Ignore nonexistent files, never prompt\n" +
                "  -r, -R    Remove directories and their contents recursively\n";
        }

        // 1. Parsing Flags — dukung gabungan (`-rf`) seperti coreutils.
        let isRecursive = false;
        let isForce = false;
        const targets: string[] = [];

        for (const arg of args) {
            if (arg === "-h" || arg === "--help") continue;
            if (arg.startsWith("--")) continue; // flag panjang lain diabaikan
            if (arg.startsWith("-") && arg.length > 1) {
                if (arg.includes("r") || arg.includes("R")) isRecursive = true;
                if (arg.includes("f")) isForce = true;
                continue;
            }
            targets.push(arg);
        }

        if (targets.length === 0) {
            return "Usage: rm [-rf] <target1> <target2> ...";
        }

        let errors = "";

        for (const target of targets) {
            try {
                await this.removeTarget(target, isRecursive, isForce);
            } catch (e: any) {
                const message = String(e?.message ?? e);
                // -f: file yang tidak ada bukan error (jangan berisik di boot).
                if (isForce && /no such file/i.test(message)) continue;
                errors += `rm: cannot remove '${target}': ${message}\n`;
            }
        }

        if (errors) return errors.trim();
        return "";
    }

    private async removeTarget(path: string, recursive: boolean, force: boolean) {
        const info = await this.fs.stat(path).catch(() => null);
        if (!info) {
            if (force) return;
            throw new Error("No such file or directory");
        }

        if (info.type === "DIRECTORY") {
            if (!recursive) {
                throw new Error("Is a directory");
            }

            // Recursive Delete
            const children = await this.fs.ls(path);
            for (const child of children) {
                const childPath = (path.endsWith("/") ? path + child.name : path + "/" + child.name);
                await this.removeTarget(childPath, true, force);
            }

            // Delete empty dir
            const success = await this.fs.rmdir(path);
            if (!success) throw new Error("Failed to remove directory");

        } else {
            // File
            const success = await this.fs.unlink(path);
            if (!success) throw new Error("Failed to remove file");
        }
    }
}
