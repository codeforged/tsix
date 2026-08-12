import { Program, fs, std } from "@tsix/Application";

/**
 * LSBLK Utility
 * 
 * List block devices (VFS mount points in TSIX).
 */
export default Program(async (args) => {
    if (args.includes("--help") || args.includes("-h")) {
        await std.print("Usage: lsblk\nList active VFS mount points as block devices.\n");
        return;
    }

    const mounts = await fs.getMounts();

    // Header
    await std.println(`${"MOUNTPOINT".padEnd(20)} ${"TYPE".padEnd(10)} ${"SOURCE".padEnd(25)} ${"OPTS"}`);
    await std.println("-".repeat(65));

    for (const m of mounts) {
        const mountPoint = m.vfsPath.padEnd(20);
        const type = m.type.padEnd(10);
        const source = m.source.padEnd(25);
        const opts = m.readOnly ? "ro" : "rw";

        await std.println(`${mountPoint} ${type} ${source} ${opts}`);
    }
});
