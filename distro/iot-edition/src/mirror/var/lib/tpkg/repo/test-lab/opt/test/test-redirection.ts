import { OSContext } from "@tsix/IProgram";

export class main {
    async execute(lib: OSContext, args: string[]) {
        await lib.std.println("Line 1: Starting test...");
        await lib.std.sleep(100);
        await lib.std.println("Line 2: Middle of test...");
        await lib.std.sleep(100);
        await lib.std.println("Line 3: End of test.");
        return "Complete";
    }
}
