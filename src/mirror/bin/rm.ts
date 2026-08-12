import { IProgram, OSContext } from "../lib/IProgram";

/**
 * RM Utility
 * 
 * Remove files or directories.
 * 
 * Flags:
 * -r, -R: Recursive removal of directories.
 */
export class main implements IProgram {
    private fs: any;

    async execute({ fs, std }: OSContext, args: string[]): Promise<string> {
        this.fs = fs;

        if (args.includes("--help") || args.includes("-h")) {
            return "Usage: rm [options] <target1> <target2> ...\n\n" +
                "Options:\n" +
                "  -r, -R    Remove directories and their contents recursively\n";
        }

        // 1. Parsing Flags
        const isRecursive = args.includes("-r") || args.includes("-R");
        const targets = args.filter(arg => arg !== "-r" && arg !== "-R" && arg !== "-h" && arg !== "--help");

        if (targets.length === 0) {
            return "Usage: rm [-r] <target1> <target2> ...";
        }

        let errors = "";

        for (const target of targets) {
            try {
                await this.removeTarget(target, isRecursive);
            } catch (e: any) {
                errors += `rm: cannot remove '${target}': ${e.message}\n`;
            }
        }

        if (errors) return errors.trim();
        return "";
    }

    private async removeTarget(path: string, recursive: boolean) {
        const info = await this.fs.stat(path);
        if (!info) throw new Error("No such file or directory");

        if (info.type === "DIRECTORY") {
            if (!recursive) {
                throw new Error("Is a directory");
            }

            // Recursive Delete
            const children = await this.fs.ls(path);
            for (const child of children) {
                const childPath = (path.endsWith("/") ? path + child.name : path + "/" + child.name);
                await this.removeTarget(childPath, true);
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
