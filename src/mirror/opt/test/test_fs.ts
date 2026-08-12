import { IProgram, OSContext } from "../../lib/IProgram";

export class main implements IProgram {
    async execute(lib: OSContext, args: string[]): Promise<string> {
        const path = "/root/test_file.txt";

        try {
            await lib.std.print(`DEBUG: Attempting to create ${path}...\n`);

            // 1. OPEN (should create if not exists)
            const fd = await lib.fs.open(path);
            await lib.std.print(`DEBUG: Open returned FD: ${fd} (Type: ${typeof fd})\n`);

            if (typeof fd === "number") {
                // 2. WRITE
                const content = "Hello Persistence!";
                await lib.std.print(`DEBUG: Writing '${content}'...\n`);
                await lib.fs.write(fd, content);

                // 3. CLOSE
                await lib.fs.close(fd);
                await lib.std.print(`DEBUG: Closed.\n`);

                // 4. VERIFY READ
                const fd2 = await lib.fs.open(path);
                const readBack = await lib.fs.read(fd2);
                await lib.fs.close(fd2);
                await lib.std.print(`DEBUG: Read Back: '${readBack}'\n`);

            } else {
                await lib.std.print(`DEBUG: Open failed, returned non-number.\n`);
            }

        } catch (e: any) {
            await lib.std.print(`DEBUG ERROR: ${e.message}\n`);
        }

        return "Test Complete.";
    }
}
