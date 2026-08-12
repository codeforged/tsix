import { Program, fs, std, shell } from "@tsix/Application";

/**
 * UMOUNT Utility
 * 
 * Unmount a file system.
 */
export default Program(async (args) => {
    if (args.includes("--help") || args.includes("-h")) {
        await std.print("Usage: umount <vfs_path>\nUnmount the specified path.\n");
        return;
    }

    // SECURITY: Only root can perform UMOUNT
    const user = await shell.whoami();
    if (user.uid !== 0) {
        await std.print("Permission Denied: Only root can unmount filesystems. Use sudo.\n");
        return;
    }

    if (args.length < 1) {
        await std.print("Usage: umount <vfs_path>\n");
        return;
    }

    const vfsPath = args[0];

    try {
        const ok = await fs.umount(vfsPath);
        if (ok) {
            await std.print(`Successfully unmounted ${vfsPath}\n`);
        } else {
            await std.print(`Failed to unmount ${vfsPath}. Path might not be a mount point.\n`);
        }
    } catch (e: any) {
        await std.print(`Umount Error: ${e.message}\n`);
    }
});
