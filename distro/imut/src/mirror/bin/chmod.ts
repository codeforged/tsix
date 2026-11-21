import { IProgram, OSContext } from "../lib/IProgram";

/**
 * CHMOD Utility
 * 
 * Change file mode bits (permissions).
 * Supports octal (e.g., 755) and symbolic (e.g., u+x) formats.
 */
export class main implements IProgram {


    async execute({ fs }: OSContext, args: string[]): Promise<string> {
        if (args.includes("--help") || args.includes("-h")) {
            return "Usage: chmod <mode> <path...>\n\n" +
                "Change permissions of files or directories.\n" +
                "Example: chmod 755 script.ts\n" +
                "Example: chmod u+x script.ts\n";
        }

        if (args.length < 2) {
            return "Usage: chmod <mode> <path...>\nExample: chmod 755 file.ts\nExample: chmod u+x test.ts";
        }

        const modeArg = args[0];
        const paths = args.slice(1);

        let errors: string[] = [];

        for (const path of paths) {
            try {
                let newMode: number;

                // Check if it's octal (standard digits)
                if (/^[0-7]+$/.test(modeArg)) {
                    newMode = parseInt(modeArg, 8);
                } else {
                    // Symbolic mode: [ugoa][+-=][rwx]
                    const stat = await fs.stat(path);
                    if (!stat) {
                        errors.push(`chmod: cannot access '${path}': No such file or directory`);
                        continue;
                    }
                    newMode = this.parseSymbolicMode(stat.mode, modeArg);
                }

                const success = await fs.chmod(path, newMode);
                if (!success) {
                    errors.push(`chmod: cannot access '${path}': Permission denied`);
                }
            } catch (e: any) {
                errors.push(`chmod: ${path}: ${e.message}`);
            }
        }

        return errors.join("\n");
    }

    private parseSymbolicMode(currentMode: number, modeStr: string): number {
        const regex = /^([ugoa]*)([+=-])([rwx]*)$/;
        const match = modeStr.match(regex);
        if (!match) return currentMode;

        const [_, who, op, perms] = match;
        const targets = who === "" || who.includes("a") ? "ugo" : who;

        // Bit patterns
        let bitmask = 0;
        if (perms.includes("r")) bitmask |= 0o444;
        if (perms.includes("w")) bitmask |= 0o222;
        if (perms.includes("x")) bitmask |= 0o111;

        // Filter bitmask by targets
        let targetMask = 0;
        if (targets.includes("u")) targetMask |= 0o700;
        if (targets.includes("g")) targetMask |= 0o070;
        if (targets.includes("o")) targetMask |= 0o007;

        const effectiveBits = bitmask & targetMask;

        if (op === "+") {
            return currentMode | effectiveBits;
        } else if (op === "-") {
            return currentMode & ~effectiveBits;
        } else if (op === "=") {
            // Clear current bits for targets then set new ones
            return (currentMode & ~targetMask) | effectiveBits;
        }

        return currentMode;
    }
}
