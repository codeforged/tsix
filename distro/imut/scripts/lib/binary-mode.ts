import * as fs from "fs";
import { BKFS } from "../../src/vfs/BKFS";

/**
 * BINARY MODE — aturan bit eksekusi berkas executable TSIX (FHS).
 *
 * Dipakai BERSAMA oleh semua alat sinkronisasi supaya VFS dan host tidak pernah
 * berbeda pendapat soal izin:
 *
 *   - `vfs-bootstrap.ts` (host → VFS)
 *   - `install.ts`       (image baru)
 *   - `sync-vfs.ts`      (satu berkas host → VFS)
 *   - `vfs-pull.ts`      (VFS → host)   ← dulu TIDAK memakai aturan ini
 *   - `rootfs-chmod.ts`  (perbaiki folder host yang dipakai `rootType = "host"`)
 *
 * KENAPA PENTING (bug nyata): `vfs-pull` menulis berkas apa adanya
 * (`fs.writeFileSync` → 0644), sehingga folder host yang dipakai sebagai root
 * langsung kehilangan bit `x`. Shell menegakkannya seperti Linux
 * (`tsh.ts`: `(mode & 0o111) === 0` → `-tsh: /bin/ls.js: Permission denied`,
 * `$?` = 126), jadi SELURUH perintah eksternal mati walau UID 0 — root pun tidak
 * menembus pemeriksaan itu (pemeriksaan di shell, bukan di PermissionManager).
 *
 * Aturan mode (samakan dengan kernel/userland):
 *   - `SetUID`  → `/bin/login|passwd|sudo` (baca/tulis `/etc/shadow` 0640 root)
 *   - `/sbin`   → 0o744 (root-only)
 *   - sisanya   → 0o755
 */

/**
 * Direktori executable standar (FHS) — semua file .ts/.js di sini diberi bit
 * execute saat sync agar bisa dijalankan dari PATH.
 */
export const EXEC_DIRS = ["/bin", "/sbin", "/usr/bin", "/usr/local/bin", "/opt"];

/**
 * Binary istimewa yang wajib berjalan sebagai pemilik file (SetUID root):
 * login, passwd, dan sudo — semuanya butuh akses baca/tulis /etc/shadow (0640 root).
 * Dikenali baik versi .ts maupun sidecar .js yang benar-benar dieksekusi runtime.
 */
export function isSetuidBinary(vfsPath: string): boolean {
    return /\/bin\/(login|passwd|sudo)\.(ts|js)$/.test(vfsPath);
}

export function isExecutableBinary(vfsPath: string): boolean {
    return EXEC_DIRS.some((d) => vfsPath.startsWith(d + "/"));
}

/**
 * binaryModeFor(): Mode yang SEHARUSNYA dimiliki sebuah path, atau `null` kalau
 * path itu bukan executable (berkas biasa → biarkan mode apa adanya).
 */
export function binaryModeFor(vfsPath: string): number | null {
    if (isSetuidBinary(vfsPath)) return 0o4755;
    if (isExecutableBinary(vfsPath)) {
        return vfsPath.startsWith("/sbin/") ? 0o744 : 0o755;
    }
    return null;
}

/** Terapkan mode eksekusi (dan SetUID untuk login/passwd/sudo) di VFS. */
export function applyBinaryMode(bkfs: BKFS, vfsPath: string, label: string): void {
    const mode = binaryModeFor(vfsPath);
    if (mode === null) return;

    bkfs.chmod(vfsPath, mode);
    if (mode === 0o4755) bkfs.chown(vfsPath, 0, 0);
    if (mode === 0o4755) console.log(`[${label}] SetUID+chown root -> ${vfsPath}`);
}

/**
 * applyBinaryModeIfNeeded(): Sama seperti di atas, tapi mengembalikan `false`
 * kalau berkas bukan executable — supaya pemanggil bisa "hanya panggil kalau
 * perlu" (pola yang dipakai install/sync-vfs/bootstrap).
 */
export function needsBinaryMode(vfsPath: string): boolean {
    return isSetuidBinary(vfsPath) || isExecutableBinary(vfsPath);
}

/**
 * applyHostBinaryMode(): Pasang mode executable pada berkas HOST.
 *
 * Dipakai `vfs-pull` dan `rootfs-chmod`, karena `rootType = "host"` membuat
 * folder host adalah root sesungguhnya — izin di disk-lah yang dibaca kernel.
 *
 * @param hostPath path nyata di disk
 * @param vfsPath  path padanannya di dalam TSIX (`/bin/ls.js`) untuk menentukan mode
 * @returns `true` kalau mode dipasang, `false` kalau bukan executable / chmod gagal
 *          (mis. berkas milik user lain) — sengaja tidak melempar.
 */
export function applyHostBinaryMode(hostPath: string, vfsPath: string): boolean {
    const mode = binaryModeFor(vfsPath);
    if (mode === null) return false;
    try {
        fs.chmodSync(hostPath, mode);
        return true;
    } catch {
        return false;
    }
}
