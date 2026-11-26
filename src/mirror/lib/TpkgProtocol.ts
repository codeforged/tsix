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

/**
 * Mode untuk binary di `/sbin` — root-only, sama dengan `scripts/vfs-bootstrap.ts`.
 * `/sbin` bukan untuk user biasa, jadi tidak 0o755 seperti `/bin`.
 */
export const TPKG_SBIN_MODE = 0o744;

/**
 * Mode SetUID untuk binary yang harus membaca `/etc/shadow` (0640 root).
 * Sama dengan aturan `isSetuidBinary()` di `scripts/vfs-bootstrap.ts` agar mode
 * hasil `tpkg` identik dengan hasil bootstrap (kalau beda, `sudo`/`passwd`
 * mendadak tidak bisa baca shadow setelah update).
 */
export const TPKG_SETUID_MODE = 0o4755;

/**
 * Direktori executable (FHS). SUMBER TUNGGAL aturan mode eksekusi: dipakai
 * `tpkg` (`resolveMode`), `transpile`, `apply-update`, dan — di sisi host —
 * `scripts/lib/binary-mode.ts` (bootstrap/install/sync/pull/rootfs-chmod).
 *
 * Dulu daftar ini disalin di empat tempat dengan aturan yang sedikit berbeda
 * (mis. `transpile` mencocokkan direktori persis sehingga `/opt/<pkg>/x.js`
 * jatuh ke 0644). Sekarang semuanya memanggil `execModeForPath()`.
 */
export const TPKG_EXEC_DIRS = ["/bin", "/sbin", "/usr/bin", "/usr/local/bin", "/opt"];

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
 * Tidak memfilter ekstensi — pemanggil yang memutuskan (lihat `resolveMode`).
 */
export function execModeForPath(path: string): number | null {
    const p = String(path ?? "");
    if (isSetuidPath(p)) return TPKG_SETUID_MODE;
    if (TPKG_EXEC_DIRS.some((d) => p.startsWith(d + "/"))) {
        return p.startsWith("/sbin/") ? TPKG_SBIN_MODE : TPKG_EXEC_MODE;
    }
    return null;
}

/** Satu item (file) di dalam paket — bagian dari `packages.json`. */
export interface TpkgItem {
    /** Path sumber di node server. */
    src: string;
    /**
     * Path tujuan di node klien (absolut).
     *
     * Untuk file yang HANYA hidup di host (mis. kernel: `src/kernel/*.ts`),
     * `dst` adalah jalur staging sementara di VFS yang dipakai `syncToHost` —
     * lihat `hostDst`.
     */
    dst: string;
    /**
     * Path tujuan di HOST, relatif terhadap root proyek (mis.
     * `src/kernel/Kernel.ts`). Menandai file yang juga harus ditulis keluar dari
     * VFS — kernel & komponennya tidak ada di VFS, jadi tanpa field ini paket
     * "engine update" hanya bisa mengubah userland.
     *
     * Isinya divalidasi oleh `isSafeHostDst()` di kedua sisi. Klien menulis ke
     * `dst` (VFS) lalu `syncToHost(dst, hostDst)`.
     */
    hostDst?: string;
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
    /** Skrip yang dijalankan setelah instalasi berhasil (dikonfirmasi operator). */
    onAfterDownload?: string;
    /** Skrip yang dijalankan saat `tpkg remove`, sebelum file dihapus (opsional). */
    undoScript?: string;
    /** Versi TSIX minimum (informasi; belum ditegakkan). */
    minVersion?: string;
    /**
     * Paket lain yang dibutuhkan: `"emerald"` atau `"emerald>=1.2.0"`.
     * `tpkg install` menawarkan untuk memasangnya lebih dulu (lihat `planInstall`).
     */
    depends?: string[];
    items: TpkgItem[];
}

/** Entri katalog (`LIST_REPLY`) — ringkasan paket tanpa daftar file. */
export interface TpkgCatalogEntry {
    name: string;
    version: string;
    description?: string;
    author?: string;
    depends?: string[];
}

/** Satu dependensi hasil parsing `depends`. */
export interface TpkgDependency {
    name: string;
    /** Versi minimum (inklusif), kalau ditulis `name>=x.y.z`. */
    minVersion?: string;
}

/**
 * parseDependency(): `"emerald"` → `{name}`, `"emerald>=1.2"` → `{name, minVersion}`.
 * Return null kalau formatnya tidak dikenal.
 */
export function parseDependency(spec: string): TpkgDependency | null {
    const m = /^\s*([A-Za-z0-9._-]+)\s*(?:>=\s*([0-9][0-9A-Za-z.+-]*))?\s*$/.exec(String(spec ?? ""));
    if (!m) return null;
    return m[2] ? { name: m[1], minVersion: m[2] } : { name: m[1] };
}

/** Satu langkah rencana instalasi, sudah terurut (dependensi lebih dulu). */
export interface TpkgPlanStep {
    name: string;
    version: string;
    reason: "requested" | "dependency";
    /** Untuk dependensi: paket pertama yang membutuhkannya. */
    requiredBy?: string;
}

export interface TpkgPlan {
    steps: TpkgPlanStep[];
    /** Masalah yang tidak bisa diselesaikan otomatis (siap ditampilkan). */
    problems: string[];
}

/**
 * planInstall(): Susun urutan instalasi `requested` + dependensinya.
 *
 * Murni (tanpa I/O) supaya bisa diuji: status "sudah terpasang" diputuskan oleh
 * `isSatisfied`. Urutan post-order — dependensi selalu sebelum pemakainya.
 * Siklus, paket yang tidak ada di katalog, spesifikasi rusak, atau versi katalog
 * yang terlalu tua dilaporkan di `problems`, bukan dilempar.
 */
export function planInstall(
    requested: string[],
    catalog: TpkgCatalogEntry[],
    isSatisfied: (dep: TpkgDependency) => boolean,
): TpkgPlan {
    const byName = new Map(catalog.map((p) => [p.name, p]));
    const wanted = new Set(requested);
    const steps: TpkgPlanStep[] = [];
    const problems: string[] = [];
    const done = new Set<string>();
    const stack: string[] = [];

    const visit = (name: string, requiredBy?: string) => {
        if (done.has(name)) return;
        if (stack.includes(name)) {
            problems.push(`dependency cycle: ${[...stack.slice(stack.indexOf(name)), name].join(" -> ")}`);
            return;
        }
        const entry = byName.get(name);
        if (!entry) {
            problems.push(`'${name}' is not in the catalog${requiredBy ? ` (required by ${requiredBy})` : ""}`);
            return;
        }

        stack.push(name);
        for (const spec of entry.depends ?? []) {
            const dep = parseDependency(spec);
            if (!dep) {
                problems.push(`${name}: invalid dependency '${spec}'`);
                continue;
            }
            if (wanted.has(dep.name) || isSatisfied(dep)) {
                // Diminta juga → cukup pastikan urutannya benar.
                if (wanted.has(dep.name)) visit(dep.name, name);
                continue;
            }
            const candidate = byName.get(dep.name);
            if (candidate && dep.minVersion && compareVersions(candidate.version, dep.minVersion) < 0) {
                problems.push(
                    `${name} requires ${dep.name}>=${dep.minVersion}, but the catalog only has ${candidate.version}`,
                );
                continue;
            }
            visit(dep.name, name);
        }
        stack.pop();

        done.add(name);
        steps.push({
            name,
            version: entry.version,
            reason: wanted.has(name) ? "requested" : "dependency",
            ...(wanted.has(name) || !requiredBy ? {} : { requiredBy }),
        });
    };

    for (const name of requested) visit(name);
    return { steps, problems };
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
    /** Path tujuan di host (relatif root proyek), kalau file ini juga keluar VFS. */
    hostDst?: string;
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
    /**
     * Tujuan host ikut ditandatangani: tanpa ini, pihak ketiga yang bisa
     * menyisipkan di transport (bukan server) bisa membelokkan file engine ke
     * path host lain selama `signature` tetap valid.
     */
    hostDst: string;
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
    return crypto.createHash("sha256").update(Buffer.from(content, "latin1")).digest("hex");
}

/** bundleMeta(): Ambil metadata (path/hostDst/size/sha) dari daftar file bundle. */
export function bundleMeta(files: TpkgBundleFile[]): TpkgBundleMeta[] {
    return (files ?? []).map((f) => ({
        path: f?.path ?? "",
        // Selalu diisi ("" kalau tidak ada) supaya bentuk kanonik digest stabil:
        // kalau field-nya hilang saat undefined, signature dua sisi bisa beda
        // hanya karena key-nya tidak ikut di-JSON.stringify.
        hostDst: f?.hostDst ?? "",
        size: typeof f?.size === "number" ? f.size : 0,
        sha256: f?.sha256 ?? "",
    }));
}

/**
 * isSafeHostDst(): Tolak tujuan host yang bisa keluar dari root proyek.
 *
 * `SYNC_TO_HOST` sendiri sudah membatasi ke `process.cwd()`, tapi menolak lebih
 * awal memberi pesan yang jelas ("manifest paket salah") alih-alih kegagalan
 * syscall yang membingungkan di tengah instalasi.
 */
export function isSafeHostDst(hostDst: string): boolean {
    const p = String(hostDst ?? "");
    if (p.trim() === "") return false;
    if (p.startsWith("/") || p.startsWith("~")) return false; // wajib relatif
    if (p.includes("\\")) return false;
    const parts = p.split("/");
    if (parts.some((s) => s === ".." || s === "")) return false;
    return true;
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
        return { ok: false, error: "empty bundle" };
    }
    for (const f of files) {
        if (!f || typeof f.path !== "string" || f.path.trim() === "") {
            return { ok: false, error: "entry without path" };
        }
        if (typeof f.content !== "string") {
            return { ok: false, error: `${f.path}: content is not a string` };
        }
        if (typeof f.size !== "number" || f.content.length !== f.size) {
            return {
                ok: false,
                error: `${f.path}: size mismatch (received ${f.content.length}, manifest ${f.size})`,
            };
        }
        const actual = sha256Hex(f.content);
        if (actual !== f.sha256) {
            return { ok: false, error: `${f.path}: SHA-256 mismatch (data altered in transit?)` };
        }
    }
    return { ok: true };
}

/** resolveMode(): Mode akhir sebuah file setelah instalasi. */
export function resolveMode(file: TpkgBundleFile): number | undefined {
    if (typeof file.permissions === "number" && Number.isFinite(file.permissions)) {
        return file.permissions;
    }
    const path = String(file?.path ?? "");

    // SetUID lebih dulu dari `isExecutable`: login/passwd/sudo WAJIB 0o4755,
    // kalau tidak bisa membaca /etc/shadow (0640 root).
    if (isSetuidPath(path)) return TPKG_SETUID_MODE;
    if (file.isExecutable) return TPKG_EXEC_MODE;

    // Kompatibilitas repo lama: isi direktori eksekusi dianggap executable,
    // TAPI hanya .ts/.js — supaya file data di bawah /opt (mis. kunci OTA)
    // tidak mendadak jadi 0o755 seperti yang dilakukan bootstrap.
    if (/\.(ts|js)$/.test(path)) {
        const mode = execModeForPath(path);
        if (mode !== null) return mode;
    }
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
export function parseHostPort(spec: string, defaultPort: number = TPKG_DEFAULT_PORT): TpkgHostPort {
    const raw = String(spec ?? "").trim();
    if (!raw) throw new Error("empty repository address");

    const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    const idx = withoutScheme.lastIndexOf(":");

    if (idx <= 0) return { address: withoutScheme, port: defaultPort };

    const portStr = withoutScheme.slice(idx + 1);
    const port = Number(portStr);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`invalid port: '${portStr}' (example: node:8090)`);
    }

    const address = withoutScheme.slice(0, idx).trim();
    if (!address || /\s/.test(address)) {
        throw new Error(`invalid address: '${raw}'`);
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
