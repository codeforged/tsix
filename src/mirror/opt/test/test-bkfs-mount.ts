import { Program, fs, std } from "@tsix/Application";

export default Program(async () => {
    await std.print("--- BKFS-to-BKFS Mount Verification ---\n");

    const secondaryDb = "./secondary_system.db";
    const mountPoint = "/mnt/ext_bkfs";

    await std.print(`1. Mounting secondary BKFS (${secondaryDb}) to ${mountPoint}...\n`);
    const mountOk = await fs.mount(mountPoint, secondaryDb, false, "bkfs");
    if (!mountOk) {
        await std.print("Mount failed!\n");
        return;
    }
    await std.print("Mount successful.\n");

    await std.print("\n2. Writing a file to the secondary BKFS...\n");
    const testFile = `${mountPoint}/secret_data.txt`;
    const content = "This data is stored in a secondary SQLite database file!\n";
    await fs.writeFile(testFile, content);
    await std.print(`File written: ${testFile}\n`);

    await std.print("\n3. Verifying file separation (Copying between BKFS)...\n");
    const sourceFile = "/etc/passwd";
    const destFile = `${mountPoint}/passwd_backup`;

    const passwdData = await fs.readFile(sourceFile);
    if (passwdData) {
        await std.print(`Copying ${sourceFile} -> ${destFile}\n`);
        await fs.writeFile(destFile, passwdData);
        await std.print("Copy successful.\n");
    }

    await std.print("\n4. Listing contents of secondary BKFS...\n");
    const files = await fs.ls(mountPoint);
    for (const f of files) {
        await std.print(`- ${f.name} (${f.type}, ${f.size} bytes)\n`);
    }

    await std.print("\n--- BKFS Mount Verification Completed ---\n");
});
