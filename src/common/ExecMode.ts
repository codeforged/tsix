/**
 * EXEC MODE — sumber tunggal aturan bit eksekusi berkas TSIX (FHS).
 *
 * Dipakai di DUA sisi:
 *   - di dalam TSIX: `@tsix/TpkgProtocol` (tpkg `resolveMode`), `transpile`,
 *     `apply-update` — lewat `/lib/common/ExecMode`;
 *   - di host: `scripts/lib/binary-mode.ts` (bootstrap/install/sync/pull/
 *     rootfs-chmod, builder distro).
 *
 * KENAPA DI `src/common`: file ini harus tersedia di host bahkan pada distro
 * mode produksi yang TIDAK punya `src/mirror/` (lihat `twrapper --no-mirror`).
 * Dulu aturannya hidup di `src/mirror/lib/TpkgProtocol.ts`, sehingga
 * `scripts/install.ts` di distro tanpa mirror gagal di level import.
 *
 * Dependency-free supaya aman dimuat dari proses mana pun.
 */

/** Direktori executable (FHS). */
export const EXEC_DIRS = ["/bin", "/sbin", "/usr/bin", "/usr/local/bin", "/opt"];

/** Mode file executable biasa. */
export const EXEC_MODE = 0o755;

/** Mode binary di `/sbin` — root-only. */
export const SBIN_MODE = 0o744;

/** Mode SetUID untuk binary yang harus membaca `/etc/shadow` (0640 root). */
export const SETUID_MODE = 0o4755;

/** Binary istimewa SetUID (login/passwd/sudo — butuh akses /etc/shadow). */
export function isSetuidPath(path: string): boolean {
    return /\/bin\/(login|passwd|sudo)\.(ts|js)$/.test(String(path ?? ""));
}

/**
 * execModeForPath(): Mode standar sebuah path executable, atau `null` kalau
 * path itu tidak berada di direktori executable.
 *
 *   - SetUID (`/bin/login|passwd|sudo`) → 0o4755
 *   - di bawah `/sbin/`                 → 0o744 (root-only)
 *   - di bawah direktori exec lain      → 0o755 (termasuk `/opt/<pkg>/…`)
 *
 * Tidak memfilter ekstensi — pemanggil yang memutuskan.
 */
export function execModeForPath(path: string): number | null {
    const p = String(path ?? "");
    if (isSetuidPath(p)) return SETUID_MODE;
    if (EXEC_DIRS.some((d) => p.startsWith(d + "/"))) {
        return p.startsWith("/sbin/") ? SBIN_MODE : EXEC_MODE;
    }
    return null;
}
