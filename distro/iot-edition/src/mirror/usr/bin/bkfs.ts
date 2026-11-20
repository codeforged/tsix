import { Program, fs, std, shell } from "@tsix/Application";

/**
 * BKFS Management Utility
 * 
 * Script ini berguna untuk management vfs bkfs.
 * Versi awal mendukung pembuatan file bkfs baru.
 */
export default Program(async (args) => {
    // SECURITY: Only root or members of root group can manage BKFS (host access)
    const user = await shell.whoami();
    if (user.uid !== 0) {
        await std.print("Permission Denied: Only root can manage BKFS images. Use sudo.\n");
        return;
    }

    if (args.includes("--help") || args.includes("-h") || args.length === 0) {
        await std.print("Usage: bkfs -c <host_path>\n" +
            "Management utility for BKFS (Bukan Kernel File System).\n\n" +
            "Options:\n" +
            "  -c <host_path>    Create a new empty BKFS database file.\n");
        return;
    }

    if (args[0] === "-c") {
        const hostPath = args[1];
        if (!hostPath) {
            await std.print("Error: Please specify the host path for the new BKFS file.\n");
            return;
        }

        await std.print(`Creating BKFS image at ${hostPath}...\n`);

        try {
            // Kita gunakan mount point sementara untuk memicu inisialisasi schema oleh kernel
            const tempMountPoint = `/tmp/bkfs_init_${Date.now()}`;

            // Kernel akan membuat file jika belum ada saat mount dilakukan dengan type 'bkfs'
            const ok = await fs.mount(tempMountPoint, hostPath, false, "bkfs");

            if (ok) {
                // Setelah mount berhasil (dan file dibuat serta di-init), kita unmount
                await fs.umount(tempMountPoint);
                await std.print(`Successfully created and initialized BKFS: ${hostPath}\n`);
            } else {
                await std.print(`Failed to initialize BKFS at ${hostPath}\n`);
            }
        } catch (e: any) {
            await std.print(`Error creating BKFS: ${e.message}\n`);
        }
    } else {
        await std.print(`Unknown option: ${args[0]}\n`);
        await std.print("Use 'bkfs --help' for usage information.\n");
    }
});
