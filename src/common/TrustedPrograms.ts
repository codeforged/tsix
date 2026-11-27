/**
 * TRUSTED PROGRAMS — siapa yang boleh memuat modul host Node di sandbox (SEC-12, K-12).
 *
 * Dulu `WorkerEntry` menganggap aplikasi "privileged" bila NAMANYA mengandung
 * "server", "daemon", "vfs", dst., jadi siapa pun bisa menamai programnya
 * `myserver.js` dan mendapat `fs` host. Sekarang keputusannya diambil KERNEL saat
 * EXEC, dari path absolut file yang dieksekusi dan pemiliknya:
 *
 *   - path harus ada di daftar di bawah (tanpa ekstensi; `.ts` / `.js` sama);
 *   - file milik root dan tidak bisa ditulis grup/other (mode & 0o022 == 0);
 *   - program hanya mendapat modul yang memang dipakainya.
 *
 * Daftar disusun dari pemakaian `require` di kode (2026-11-27). Tambah entri di
 * sini bila program sistem baru butuh modul host.
 *
 * Dependency-free: dipakai kernel (Syscalls) dan test.
 */

export const TRUSTED_HOST_MODULES: Readonly<Record<string, readonly string[]>> = {
    "/usr/bin/tbuild": ["fs", "path", "esbuild", "os"],
    "/sbin/transpile": ["esbuild"],
    "/sbin/apply-update": ["esbuild"],
    "/sbin/vfs-pull": ["path"],
    "/opt/dome/dome": ["esbuild"],
    "/opt/mysqld/mysqld": ["mysql2", "mysql2/promise"],
    "/opt/plcd/launcher": ["path", "module", "esbuild"],
};

interface NodeLike {
    type?: string;
    uid?: number;
    mode?: number;
}

/** Modul host yang boleh dimuat program di `vfsPath`; [] bila tidak tepercaya. */
export function trustedHostModules(vfsPath: string, node: NodeLike | null | undefined): string[] {
    if (!node || node.type !== "FILE") return [];
    if (node.uid !== 0) return [];
    if ((Number(node.mode) & 0o022) !== 0) return [];
    const key = String(vfsPath ?? "").replace(/\.(ts|js)$/i, "");
    const modules = TRUSTED_HOST_MODULES[key];
    return modules ? [...modules] : [];
}
