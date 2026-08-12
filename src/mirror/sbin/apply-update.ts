import { Program, std, fs, shell } from "@tsix/Application";

/**
 * APPLY-UPDATE
 * 
 * Script khusus untuk menyinkronkan file dari VFS (/tmp/system-updates/) 
 * kembali ke host fisik (src/).
 * 
 * Versi Dinamis: Mencari semua file di staging area secara otomatis.
 */
export const main = Program(async (args) => {
    await std.println("\n[SYSTEM UPDATE] Starting dynamic synchronization to host...\n");

    // 1. Cek User (Harus Root)
    const user = await shell.whoami();
    if (user.uid !== 0) {
        await std.println("❌ Error: apply-update must be run as root. Use sudo.");
        return;
    }

    const stagingDir = "/tmp/system-updates";

    // Check if staging dir exists
    try {
        const s = await fs.stat(stagingDir);
        if (!s || s.type !== "DIRECTORY") throw new Error("Not a directory");
    } catch (e) {
        await std.println(`❌ Error: Staging directory ${stagingDir} not found.`);
        return;
    }

    const filesToSync: { vfs: string, host: string }[] = [];

    const scanDir = async (baseDir: string, currentDir: string) => {
        const items = await fs.ls(currentDir);
        for (const item of items) {
            const fullPath = (currentDir === "/" ? "" : currentDir) + "/" + item.name;
            if (item.type === "DIRECTORY") {
                await scanDir(baseDir, fullPath);
            } else {
                // Konversi path VFS ke path Host
                let hostPath = fullPath.substring(baseDir.length);
                if (hostPath.startsWith("/")) hostPath = hostPath.substring(1);

                if (hostPath) {
                    filesToSync.push({ vfs: fullPath, host: hostPath });
                }
            }
        }
    };

    await scanDir(stagingDir, stagingDir);

    if (filesToSync.length === 0) {
        await std.println("⚠️ No update files found in staging area.");
        return;
    }

    await std.println(`📦 Found ${filesToSync.length} files to synchronize.\n`);

    let successCount = 0;
    for (const update of filesToSync) {
        try {
            await std.print(`   -> Syncing ${update.host} ... `);
            const ok = await (fs as any).syncToHost(update.vfs, update.host);
            if (ok) {
                await std.print("✅ HOST ");

                // --- VFS ROOT MIRRORING ---
                // Jika file ini bagian dari src/root, update VFS aslinya juga
                if (update.host.startsWith("src/root/")) {
                    const vfsDest = update.host.substring("src/root".length); // e.g., /bin/ls.js
                    const content = await fs.readFile(update.vfs);
                    if (content !== null) {
                        await fs.writeFile(vfsDest, content);
                        await std.print("✅ VFS ");
                    }
                }

                await std.print("\n");
                successCount++;
            } else {
                await std.print("❌ FAILED\n");
            }
        } catch (e: any) {
            await std.print(`❌ ERROR: ${e.message}\n`);
        }
    }

    await std.println(`\n[SYSTEM UPDATE] ${successCount}/${filesToSync.length} files synced.`);

    if (successCount === filesToSync.length) {
        return "🚀 Update complete! You should REBOOT or REEXEC to apply kernel changes.";
    } else {
        return "⚠️ Some files failed to sync. Check logs.";
    }
});
