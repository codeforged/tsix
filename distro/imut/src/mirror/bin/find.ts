import { IProgram, OSContext } from "../lib/IProgram";

/**
 * FIND Utility
 * 
 * Search for files in a directory hierarchy.
 * 
 * Usage: find [path] [-name pattern] [-type f|d]
 */
export class main implements IProgram {
    async execute(os: OSContext, args: string[]): Promise<void> {
        const { std, fs } = os;

        if (args.includes("--help") || args.includes("-h")) {
            await std.print("Usage: find [path] [options]\n\n" +
                "Options:\n" +
                "  -name <pattern>    Search for files by name pattern\n" +
                "  -type <f|d>        Filter by type: f (file) or d (directory)\n");
            return;
        }

        let startDir = ".";
        let namePattern = "";
        let typeFilter: "f" | "d" | null = null;

        // Parse Args
        for (let i = 0; i < args.length; i++) {
            if (args[i] === "-name" && i + 1 < args.length) {
                namePattern = args[++i];
            } else if (args[i] === "-type" && i + 1 < args.length) {
                const t = args[++i];
                if (t === "f") typeFilter = "f";
                else if (t === "d") typeFilter = "d";
            } else if (!args[i].startsWith("-") && i === 0) {
                startDir = args[i];
            }
        }

        let count = 0;
        const search = async (dir: string) => {
            const items = await fs.ls(dir);
            if (!items) return;

            for (const item of items) {
                // Ensure no double slashes, except for root
                const fullPath = (dir === "/" ? "/" : dir + "/") + item.name;

                let matches = true;

                // 1. Name Filter (Case Insensitive)
                if (namePattern && !item.name.toLowerCase().includes(namePattern.toLowerCase())) {
                    matches = false;
                }

                // 2. Type Filter
                if (typeFilter) {
                    if (typeFilter === "f" && item.type !== "FILE") matches = false;
                    if (typeFilter === "d" && item.type !== "DIRECTORY") matches = false;
                }

                if (matches) {
                    await std.print(`${fullPath}\n`);
                    count++;
                }

                // Recursive search
                if (item.type === "DIRECTORY") {
                    await search(fullPath);
                }
            }
        };

        try {
            await search(startDir);
        } catch (e: any) {
            await std.print(`find: Error: ${e.message}\n`);
        }
    }
}
