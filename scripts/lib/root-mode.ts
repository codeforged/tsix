import * as path from "path";
import { Config } from "../../src/common/Config";
import {
    resolveHostRootDir,
    resolveRootType,
    RootFsType,
} from "../../src/kernel/RootFilesystem";

/**
 * ROOT MODE — "sadarkah skrip ini terhadap mode root yang sedang aktif?"
 *
 * TSIX mengenal dua backend root `/` (lihat `src/kernel/RootFilesystem.ts`):
 *
 *   - `bkfs` — root ada di dalam `system.db`. Siklus kerja: edit `src/mirror/`
 *     → `vfs-bootstrap`/`sync-vfs` (host → DB) → jalankan → `vfs-pull` (DB → host).
 *   - `host` — root adalah FOLDER HOST itu sendiri. Berkas yang disunting user
 *     sudah berada di dalam sistem, jadi SELURUH alat sinkronisasi **tidak ada
 *     gunanya**: tidak ada DB yang jadi sumber kebenaran, dan menulis ke DB hanya
 *     menghasilkan "sukses palsu" (laporan berhasil untuk data yang tidak dibaca
 *     siapa pun).
 *
 * Karena itu `vfs-bootstrap`, `vfs-pull`, dan `sync-vfs` memakai
 * `skipIfHostRoot()` di awal `main()`: berhenti dengan pesan singkat + **exit 0**
 * (supaya hook otomatis seperti run-on-save tidak dianggap gagal).
 *
 * CATATAN PENTING: mode & folder diambil dari helper KERNEL yang sama
 * (`resolveRootType`, `resolveHostRootDir`) — termasuk prioritas env
 * `TSIX_ROOTFS` / `TSIX_ROOTFS_PATH` di atas `sysconfig.conf`. Ini mencegah
 * alat-alat luar berbeda pendapat dengan kernel (mis. `TSIX_ROOTFS=bkfs npm start`
 * tapi skrip menganggap mode host).
 */

/** Config dari `src/sysconfig.conf`; `null` kalau berkasnya belum ada. */
function loadConfig(): any | null {
    return Config.tryGet();
}

/** Mode root yang AKTIF (env `TSIX_ROOTFS` menang atas `kernel.rootType`). */
export function activeRootType(env: NodeJS.ProcessEnv = process.env): RootFsType {
    return resolveRootType(loadConfig(), env);
}

/** Folder root host kalau mode `host` aktif; `null` kalau mode `bkfs`. */
export function activeHostRoot(env: NodeJS.ProcessEnv = process.env): string | null {
    if (activeRootType(env) !== "host") return null;
    return resolveHostRootDir(loadConfig(), env);
}

/**
 * skipIfHostRoot(): Panggil di AWAL `main()` setiap alat sinkronisasi.
 *
 * @param tool Label yang muncul di pesan (mis. `"VFS-Pull"`).
 * @param hint Kalimat penjelas khusus alat itu (apa yang tidak perlu dilakukan).
 * @returns `false` kalau boleh lanjut (mode bkfs), tidak pernah kembali kalau `true`.
 */
export function skipIfHostRoot(tool: string, hint: string): boolean {
    const hostRoot = activeHostRoot();
    if (!hostRoot) return false;

    const rel = path.relative(process.cwd(), hostRoot) || hostRoot;
    console.log(
        `[${tool}] skipped — kernel.rootType = "host" (active root: ${rel}).`,
    );
    console.log(`[${tool}] ${hint}`);
    console.log(
        `[${tool}] New files need the executable bit? run \`npm run rootfs:modes\`.`,
    );
    process.exit(0);
}
