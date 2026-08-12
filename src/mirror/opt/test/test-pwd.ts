import { Program, std } from "@tsix/Application";

export const main = Program(async (args) => {
    await std.println("--- TSIX Input Tester ---");

    await std.print("1. Testing readLine (Type something and Enter): ");
    const line = await std.readLine();
    await std.println(`Result: [${line}]`);

    await std.println("\n2. Testing readPassword (Type password and Enter):");
    const pwd = await (std as any).readPassword("Password: ");
    await std.println(`\nResult length: ${pwd?.length || 0}`);

    await std.println("\nTest complete.");
});
