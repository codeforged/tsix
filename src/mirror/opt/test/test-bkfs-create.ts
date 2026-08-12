import { Program, fs, std, shell } from "@tsix/Application";

export default Program(async () => {
    await std.print("--- BKFS Creation Verification ---\n");

    const testDb = "./test-created.db";
    const mountPoint = "/mnt/test_create";

    await std.print(`1. Running: bkfs -c ${testDb}\n`);
    // Note: In TSIX, we usually run things via shell.exec for binaries in /bin
    // But since we are inside a Program, we could also call it if we wanted to be direct, 
    // however, the most realistic test is via exec.
    const proc = await shell.exec("bkfs", ["-c", testDb]);
    await shell.waitpid(proc.pid);

    await std.print("\n2. Verifying if file was created and is mountable...\n");
    try {
        const mountOk = await fs.mount(mountPoint, testDb, false, "bkfs");
        if (mountOk) {
            await std.print("Success: New BKFS is mountable.\n");

            await std.print("3. Checking contents...\n");
            const files = await fs.ls(mountPoint);
            await std.print(`Contents of ${mountPoint}: ${files.length} items.\n`);

            await fs.umount(mountPoint);
            await std.print("4. Unmounted successfully.\n");
        } else {
            await std.print("Fail: Could not mount the newly created BKFS.\n");
        }
    } catch (e: any) {
        await std.print(`Verification Error: ${e.message}\n`);
    }

    await std.print("\n--- BKFS Verification Completed ---\n");
});
