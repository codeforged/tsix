import { Program, std, fs, shell } from "@tsix/Application";

/**
 * USERLIB-UPDATE
 * 
 * Script khusus untuk menyinkronkan file library dari VFS (/lib/) 
 * langsung ke folder host SDK (src/.tsix_sdk/lib/).
 * 
 * Digunakan oleh developer saat remote untuk mempermanenkan perubahan UserLib.
 */
export const main = Program(async (args) => {
    await std.println("\n[USERLIB UPDATE] Synchronizing VFS /lib to Host SDK...\n");

    // 1. Cek User (Harus Root)
    const user = await shell.whoami();
    if (user.uid !== 0) {
        await std.println("❌ Error: userlib-update must be run as root. Use sudo.");
        return;
    }

    const vfsLibDir = "/lib";
    const hostSdkLibDir = "src/.tsix_sdk/lib";

    // Detect project root to ensure clean paths
    const sysPath = await (shell as any).getSysPath().catch(() => null);
    if (!sysPath) {
        await std.println("❌ Error: Could not determine system paths.");
        return;
    }

    const items = await fs.ls(vfsLibDir);
    if (items.length === 0) {
        await std.println("⚠️ No files found in /lib.");
        return;
    }

    await std.println(`📦 Found ${items.length} files in ${vfsLibDir}.\n`);

    let successCount = 0;
    for (const item of items) {
        if (item.type === "DIRECTORY") continue; // Skip subdirectories for now

        const vfsPath = `${vfsLibDir}/${item.name}`;
        const hostPath = `${hostSdkLibDir}/${item.name}`;

        try {
            await std.print(`   -> Syncing ${item.name} ... `);

            // Syscall syncToHost: vfs -> physical host
            const ok = await (fs as any).syncToHost(vfsPath, hostPath);

            if (ok) {
                await std.println("✅ OK");
                successCount++;
            } else {
                await std.println("❌ FAILED");
            }
        } catch (e: any) {
            await std.println(`❌ ERROR: ${e.message}`);
        }
    }

    await std.println(`\n[USERLIB UPDATE] ${successCount}/${items.length} files synced to Host SDK.`);

    if (successCount > 0) {
        return "🚀 UserLib updated successfully! New processes will use the updated library.";
    } else {
        return "⚠️ Update failed or no files were synchronized.";
    }
});
