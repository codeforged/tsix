import { IProgram, OSContext } from "../../lib/IProgram";

export class main implements IProgram {
    async execute(lib: OSContext, args: string[]): Promise<string> {
        const path = "/root/test_pipe_fix.txt";
        await lib.std.print(`Testing Pipe Append Logic on ${path}...\n`);

        try {
            // 1. OPEN with "w" (Should truncate if exists)
            const fd = await lib.fs.open(path, "w");
            if (fd < 0) return "Failed to open file.";

            // 2. WRITE "Part 1" (Since "w" truncates, this starts fresh)
            await lib.std.print("Writing 'Part 1'...\n");
            await lib.fs.write(fd, "Part 1");

            // 3. WRITE "Part 2" (Should APPEND now)
            await lib.std.print("Writing 'Part 2'...\n");
            await lib.fs.write(fd, "Part 2");

            await lib.fs.close(fd);

            // 4. VERIFY
            const content = await lib.fs.readFile(path);
            await lib.std.print(`Result Content: '${content}'\n`);

            if (content === "Part 1Part 2") {
                await lib.std.print("✅ PASS: Content appended correctly.\n");
            } else {
                await lib.std.print(`❌ FAIL: Expected 'Part 1Part 2', got '${content}'\n`);
            }

            // 5. VERIFY TRUNCATION (Open again with "w")
            const fd2 = await lib.fs.open(path, "w");
            await lib.fs.close(fd2);
            const content2 = await lib.fs.readFile(path);

            if (content2 === "") {
                await lib.std.print("✅ PASS: Truncation logic works.\n");
            } else {
                await lib.std.print(`❌ FAIL: Expected empty file after truncation, got '${content2}'\n`);
            }

        } catch (e: any) {
            await lib.std.print(`ERROR: ${e.message}\n`);
        }

        return "Test Complete.";
    }
}
