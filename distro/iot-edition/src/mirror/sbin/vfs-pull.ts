import { Program, std, fs } from "@tsix/Application";

/**
 * VFS-PULL (TSIX Version)
 * 
 * Script ini berjalan di dalam TSIX untuk menarik file dari VFS 
 * balik ke folder host project (src/root).
 */

export const main = Program(async (args) => {
    await std.println("🚀 VFS-to-Host Sync initiated from within TSIX...");

    // Periksa apakah user adalah root
    const user = await (std as any)._lib.shell.whoami();
    if (user.uid !== 0) {
        await std.println("❌ Error: Hanya root yang bisa melakukan physical sync ke host. Gunakan sudo.");
        return;
    }

    const EXCLUDE_DIRS = ["/dev", "/tmp", "/proc", "/logs", "/var"];
    let syncCount = 0;
    let lastSyncTime = Date.now();

    // Watchdog: If finished but hanging on exit, force it.
    const watchdog = setInterval(async () => {
        if (syncCount > 0 && Date.now() - lastSyncTime > 2000) {
            clearInterval(watchdog);
            await std.println("\n⚠️ Watchdog: Sync idle for 2s. Assuming finished but hanging on exit result. Force exiting...");
            await (std as any)._lib.shell.exit(0);
        }
    }, 1000);

    // Detect Host Root via Kernel (Source of Truth)
    const sysPath = await (std as any)._lib.shell.getSysPath();
    const hostRoot = sysPath.projectRoot;
    const absoluteRoot = sysPath.rootHostPath;

    const path = (global as any).require("path");

    const recursiveSync = async (vfsPath: string) => {
        if (EXCLUDE_DIRS.includes(vfsPath)) return;

        const items = await fs.ls(vfsPath);
        for (const item of items) {
            const fullVfsPath = (vfsPath === "/" ? "" : vfsPath) + "/" + item.name;

            if (item.name === "." || item.name === "..") continue;

            if (item.type === "DIRECTORY") {
                await recursiveSync(fullVfsPath);
            } else {
                // Tentukan Host Path
                let relativeHostPath = "";
                if (fullVfsPath.startsWith("/etc/")) {
                    relativeHostPath = "etc/" + fullVfsPath.replace("/etc/", "");
                } else if (fullVfsPath.startsWith("/root/")) {
                    relativeHostPath = "root/" + fullVfsPath.replace("/root/", "");
                } else {
                    relativeHostPath = fullVfsPath.startsWith("/") ? fullVfsPath.substring(1) : fullVfsPath;
                }

                const absoluteHostPath = path.join(absoluteRoot, relativeHostPath);

                try {
                    // Panggil syscall khusus SYNC_TO_HOST via UserLib
                    const ok = await (std as any)._lib.fs.syncToHost(fullVfsPath, absoluteHostPath);
                    if (ok) {
                        const progress = `[${syncCount + 1}]`;
                        await std.println(`${progress} ✅ Synced: ${fullVfsPath} -> ${absoluteHostPath}`);
                        syncCount++;
                    }
                } catch (e: any) {
                    await std.println(`⚠️ Fail: ${fullVfsPath} (${e.message})`);
                }
            }
        }
        lastSyncTime = Date.now();
    };

    await recursiveSync("/");
    clearInterval(watchdog);
    await std.println("\n🏁 All recursion finished. Returning to Shell...");
    return `\n✨ Done! ${syncCount} files synchronized to host surface.`;
});
