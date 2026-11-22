import { Program, std, fs, shell } from "@tsix/Application";
import { utf8ToVfsBytes, vfsBytesToUtf8 } from "@common/VfsText";

/**
 * TRANSPILE — bangun sidecar `.js` dari `.ts` pasca-instalasi paket.
 *
 * KENAPA PERLU:
 * `EXEC`/`tsh` memprioritaskan `.js` di atas `.ts` (lihat `Syscalls.ts`). Paket
 * TPKG hanya mengirim sumber `.ts`, sehingga tanpa langkah ini berkas `.js` lama
 * tetap yang dieksekusi dan perubahan paket seolah tidak terjadi.
 *
 * BEDA DENGAN `apply-update`:
 * `apply-update` adalah hook ENGINE: ia memindai seluruh `/bin`, `/sbin`,
 * `/usr/bin` (plus sidecar host `WorkerEntry.js`). Tool ini HANYA men-transpile
 * path yang diberikan — cocok untuk post-install paket biasa (mis. `tpkg`),
 * tanpa menyentuh sidecar lain.
 *
 * PEMAKAIAN:
 *   transpile <file.ts|dir> [file.ts|dir ...]
 *
 * WAJIB ROOT: menulis sidecar `.js` di lokasi sistem.
 */

/** Mode eksekusi per direktori — sama dengan `apply-update` / `vfs-bootstrap`. */
const EXEC_MODE_DIRS: Record<string, number> = {
    "/bin": 0o755,
    "/sbin": 0o744,
    "/usr/bin": 0o755,
    "/usr/local/bin": 0o755,
    "/opt": 0o755,
};

function modeFor(path: string): number {
    const dir = path.substring(0, path.lastIndexOf("/"));
    return EXEC_MODE_DIRS[dir] ?? 0o644;
}

export const main = Program(async (args) => {
    const user = await shell.whoami();
    if (user.uid !== 0) {
        await std.println("❌ Error: transpile must be run as root. Use sudo.");
        return;
    }

    const targets = args.filter((a) => !a.startsWith("-"));
    if (targets.length === 0) {
        await std.println("Usage: transpile <file.ts|dir> [file.ts|dir ...]");
        return;
    }

    let esbuild: any;
    try {
        esbuild = (global as any).require("esbuild");
    } catch (e: any) {
        await std.println(`❌ Error: transpile butuh esbuild di host (${e.message}).`);
        return;
    }

    // Kumpulkan berkas .ts: target bisa file langsung atau direktori (top-level).
    const files: string[] = [];
    for (const target of targets) {
        try {
            const stat = await fs.stat(target);
            if (!stat) continue;
            if (stat.type === "DIRECTORY") {
                const base = target.replace(/\/$/, "");
                const entries = await fs.ls(base || "/");
                for (const entry of entries ?? []) {
                    if (entry.type === "FILE" && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
                        files.push(`${base}/${entry.name}`);
                    }
                }
            } else if (target.endsWith(".ts") && !target.endsWith(".d.ts")) {
                files.push(target);
            }
        } catch (e) {
            /* target tidak ada → lewati, jangan gagalkan sisanya */
        }
    }

    const unique = [...new Set(files)];
    if (unique.length === 0) {
        await std.println("Tidak ada berkas .ts untuk di-transpile.");
        return;
    }

    let done = 0;
    let failed = 0;
    for (const tsPath of unique) {
        const jsPath = tsPath.replace(/\.ts$/, ".js");
        try {
            // Isi VFS = BYTE (latin1); esbuild butuh TEKS UTF-8 yang sudah didekode.
            const raw = await fs.readFile(tsPath);
            if (raw === null) continue;
            const out = esbuild.transformSync(vfsBytesToUtf8(raw), {
                loader: "ts",
                format: "cjs",
                target: "node18",
                sourcemap: "inline",
                sourcefile: tsPath.split("/").pop(),
            });
            if (!out?.code) throw new Error("esbuild tidak menghasilkan kode");
            await fs.writeFile(jsPath, utf8ToVfsBytes(out.code));
            await fs.chmod(jsPath, modeFor(jsPath));
            await std.println(`  -> ${jsPath}`);
            done++;
        } catch (e: any) {
            failed++;
            await std.println(`⚠️  gagal ${tsPath}: ${e.message}`);
        }
    }

    await std.println(`✅ ${done} sidecar built${failed > 0 ? `, ${failed} failed` : ""}.`);
});
