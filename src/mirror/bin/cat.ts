import { IProgram, OSContext } from "../lib/IProgram";

/**
 * CAT Utility
 * 
 * Concatenate files and print on the standard output.
 */
export class main implements IProgram {
    async execute({ fs, std }: OSContext, args: string[]): Promise<string | void> {
        if (args.includes("--help") || args.includes("-h")) {
            await std.print("Usage: cat [files...]\n" +
                "Concatenate and display file content.\n");
            return;
        }

        if (args.length === 0) {
            return "Usage: cat <file1> <file2> ...";
        }

        for (const fileName of args) {
            try {
                const fd = await fs.open(fileName);
                if (fd !== null) {
                    const content = await fs.read(fd);
                    if (content !== null) {
                        await std.print(content);
                    }
                    await fs.close(fd);
                }
            } catch (e: any) {
                await std.print(`cat: ${fileName}: ${e.message}\n`);
            }
        }
    }
}
