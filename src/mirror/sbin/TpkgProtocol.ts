import * as crypto from "crypto";

/**
 * TPKG PROTOCOL (shared) — tipe + util MURNI untuk `tpkg` (klien) & `tpkgd` (server)
 *
 * Kenapa dipisah: kedua sisi harus menghitung **hal yang sama persis** untuk
 * digest/signature. Kalau rumusnya terduplikasi di dua file, satu perbedaan
 * kecil (mis. latin1 vs utf8 saat hashing) bikin verifikasi gagal untuk paket
 * yang sebenarnya sehat. Jadi rumusnya hidup di satu tempat ini, dan bisa
 * di-unit-test tanpa I/O.
 *
 * File ini SENGAJA dependency-free (tanpa `UserLib`, tanpa `fs`) — dipakai dua
 * proses berbeda dengan lifecycle berbeda, dan dipanggil dari test murni.
 *
 * (c) 2026 TSIX Project
 */

/** Versi wire protocol TPKG. Naikkan kalau format pesan berubah tak kompatibel. */
export const TPKG_PROTOCOL_VERSION = "1.0";

/** Port MQTNL default `tpkgd` (dipakai klien kalau host ditulis tanpa `:port`). */
export const TPKG_DEFAULT_PORT = 80;

/**
 * Batas ukuran satu bundle (byte). Server menolak bundle lebih besar, klien
 * juga menolak sebelum menulis apa pun.
 *
 * Catatan jujur: bundle dikirim sebagai SATU pesan JSON+enkripsi, sehingga
 * ukurannya menggelembung (JSON escape × hex ≈ 2–2,2×). Angka ini sengaja
 * konservatif supaya tidak pernah menabrak batas memori worker. Untuk paket
 * besar, jalur yang benar adalah transfer chunked (lihat catatan di
 * `wiki/Package-Manager-TPKG.md`).
 */
export const TPKG_DEFAULT_MAX_BUNDLE = 4 * 1024 * 1024;

/** Mode untuk file yang ditandai executable bila `permissions` tidak diisi. */
export const TPKG_EXEC_MODE = 0o755;

/** Satu item (file) di dalam paket — bagian dari `packages.json`. */
export interface TpkgItem {
    /** Path sumber di node server. */
    src: string;
    /** Path tujuan di node klien (absolut). */
    dst: string;
    /** Mode chmod eksplisit (mis. 493 = 0o755). Menang atas `isExecutable`. */
    permissions?: number;
    /** Tandai file executable → chmod `TPKG_EXEC_MODE`. */
    isExecutable?: boolean;
}

/** Definisi satu paket di manifest server. */
export interface TpkgPackage {
    name: string;
    version: string;
    description: string;
    author?: string;
    /** Paket minta reboot setelah dipasang (informasi ke operator). */
    needReboot?: boolean;
    /** Skrip yang dijalankan setelah instalasi berhasil. */
    onAfterDownload?: string;
    /** Skrip yang dijalankan saat rollback (opsional). */
    undoScript?: string;
    /** Versi TSIX minimum (informasi; belum ditegakkan). */
    minVersion?: string;
    items: TpkgItem[];
}

/** Isi `packages.json` di node server. */
export interface TpkgManifest {
    version: string;
    packages: TpkgPackage[];
}

/** Satu file yang benar-benar dikirim di bundle. */
export interface TpkgBundleFile {
    /** Path tujuan (yang ditulis klien). */
    path: string;
    /** Ukuran byte (panjang string latin1 = 1 char 1 byte). */
    size: number;
    /** SHA-256 byte konten (latin1) — dihitung server, diperiksa klien. */
    sha256: string;
    /** Konten (string internal TSIX = latin1). */
    content: string;
    /** Mode eksplisit dari manifest (opsional). */
    permissions?: number;
    /** Tanda executable dari manifest (opsional). */
    isExecutable?: boolean;
}

/** Metadata file yang IKUT ditandatangani server (tanpa konten). */
export interface TpkgBundleMeta {
    path: string;
    size: number;
    sha256: string;
}

/** Hasil pemeriksaan integritas bundle di sisi klien. */
export interface TpkgVerifyResult {
    ok: boolean;
    error?: string;
}

/**
 * sha256Hex(): SHA-256 dari konten string internal TSIX.
 *
 * Byte yang di-hash = `Buffer.from(content, "latin1")` karena string internal
 * TSIX adalah latin1 (1 char = 1 byte) dan itulah yang ditulis ke VFS. Server
 * dan klien WAJIB memakai fungsi ini — jangan `Buffer.from(content)` polos,
 * karena default-nya utf8 dan akan menggelembungkan byte ≥ 0x80 (bug yang
 * pernah terjadi di implementasi lain).
 */
export function sha256Hex(content: string): string {
    return crypto
        .createHash("sha256")
        .update(Buffer.from(content, "latin1"))
        .digest("hex");
}

/** bundleMeta(): Ambil metadata (path/size/sha) dari daftar file bundle. */
export function bundleMeta(files: TpkgBundleFile[]): TpkgBundleMeta[] {
    return (files ?? []).map((f) => ({
        path: f?.path ?? "",
        size: typeof f?.size === "number" ? f.size : 0,
        sha256: f?.sha256 ?? "",
    }));
}

/**
 * bundleDigest(): Bentuk kanonik yang ditandatangani server.
 *
 * Hanya metadata (path + size + sha256), bukan konten: payload tanda tangan
 * jadi kecil, dan integritas konten tetap terjaga karena sha256 masing-masing
 * file ada di dalamnya. Klien menghitung ulang dengan fungsi yang sama.
 */
export function bundleDigest(files: TpkgBundleFile[]): string {
    return JSON.stringify(bundleMeta(files));
}

/**
 * verifyBundleFiles(): Periksa tiap file bundle sebelum ditulis ke VFS.
 *
 * Menangkap: konten terpotong, size tidak cocok, hash tidak cocok (tamper /
 * korupsi transport / salah encoding). Return `{ok:false, error}` yang siap
 * ditampilkan, bukan melempar — pemanggil memutuskan mau rollback atau tidak.
 */
export function verifyBundleFiles(files: TpkgBundleFile[]): TpkgVerifyResult {
    if (!Array.isArray(files) || files.length === 0) {
        return { ok: false, error: "bundle kosong" };
    }
    for (const f of files) {
        if (!f || typeof f.path !== "string" || f.path.trim() === "") {
            return { ok: false, error: "entri tanpa path" };
        }
        if (typeof f.content !== "string") {
            return { ok: false, error: `${f.path}: konten bukan string` };
        }
        if (typeof f.size !== "number" || f.content.length !== f.size) {
            return {
                ok: false,
                error: `${f.path}: ukuran tidak cocok (dikirim ${f.content.length}, manifest ${f.size})`,
            };
        }
        const actual = sha256Hex(f.content);
        if (actual !== f.sha256) {
            return { ok: false, error: `${f.path}: SHA-256 tidak cocok (data berubah di jalan?)` };
        }
    }
    return { ok: true };
}

/** resumeMode(): Mode akhir sebuah file setelah instalasi. */
export function resolveMode(file: TpkgBundleFile): number | undefined {
    if (typeof file.permissions === "number" && Number.isFinite(file.permissions)) {
        return file.permissions;
    }
    if (file.isExecutable) return TPKG_EXEC_MODE;
    // Kompatibilitas repo lama: apa pun di bawah /bin dianggap executable.
    if (file.path.startsWith("/bin/")) return TPKG_EXEC_MODE;
    return undefined; // biarkan mode bawaan VFS (0o644 untuk file baru)
}

/** Alamat + port hasil parsing spec `host[:port]`. */
export interface TpkgHostPort {
    address: string;
    port: number;
}

/**
 * parseHostPort(): Terima `"node"`, `"node:8090"`, `"mqtnl://node:8090"`.
 *
 * PENTING: dulu klien mengirim ke port 80 yang di-hardcode dan memakai spec
 * mentah sebagai alamat, sehingga `tpkg install x --from node:8090` mengirim ke
 * address literal "node:8090" — gagal tanpa pesan yang jelas.
 */
export function parseHostPort(
    spec: string,
    defaultPort: number = TPKG_DEFAULT_PORT,
): TpkgHostPort {
    const raw = String(spec ?? "").trim();
    if (!raw) throw new Error("alamat repository kosong");

    const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    const idx = withoutScheme.lastIndexOf(":");

    if (idx <= 0) return { address: withoutScheme, port: defaultPort };

    const portStr = withoutScheme.slice(idx + 1);
    const port = Number(portStr);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`port tidak valid: '${portStr}' (contoh: node:8090)`);
    }

    const address = withoutScheme.slice(0, idx).trim();
    if (!address || /\s/.test(address)) {
        throw new Error(`alamat tidak valid: '${raw}'`);
    }
    return { address, port };
}

/**
 * compareVersions(): Bandingkan versi gaya semver sederhana.
 * Return 1 kalau v1 > v2, -1 kalau v1 < v2, 0 kalau sama.
 *
 * Metadata pra-rilis/build dibuang dulu (`2.0.0-rc1` == `2.0.0`, ala
 * semver mana yang menganggap keduanya "versi angka" sama), lalu tiap segmen
 * dibandingkan numerik dan jumlah segmen disamakan (`1.2` == `1.2.0`).
 */
export function compareVersions(v1: string, v2: string): number {
    const parse = (v: string) =>
        String(v ?? "")
            .split(/[-+]/)[0]
            .replace(/[^0-9.]/g, "")
            .split(".")
            .map((p) => parseInt(p, 10) || 0);

    const p1 = parse(v1);
    const p2 = parse(v2);
    const len = Math.max(p1.length, p2.length);

    for (let i = 0; i < len; i++) {
        const a = p1[i] ?? 0;
        const b = p2[i] ?? 0;
        if (a > b) return 1;
        if (a < b) return -1;
    }
    return 0;
}

/** formatBytes(): Ukuran manusiawi untuk pesan CLI (1.4 KB, 2.1 MB). */
export function formatBytes(bytes: number): string {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
