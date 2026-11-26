import * as fs from "fs";
import * as path from "path";
import * as esbuild from "esbuild";
import { BKFS } from "../../src/vfs/BKFS";
import { FRESH_FSTAB_INI } from "./fresh-fstab";
import { ensureFreshAccountFiles } from "./fresh-accounts";
import { applyBinaryMode, needsBinaryMode } from "./binary-mode";
import { peekBom, readBinaryFile, readTextFile, utf8ToVfsBytes, vfsBytesToUtf8 } from "./text-file";

/**
 * ROOTFS IMAGE — isi `system.db` (BKFS) baru dari pohon `src/mirror` + `src/common`.
 *
 * Dipakai BERSAMA oleh:
 *   - `scripts/install.ts` (mode development: distro/checkout yang masih punya
 *     `src/mirror`, DB dibuat saat instalasi);
 *   - `scripts/twrapper/build.ts --no-mirror` (mode produksi: DB dibuat saat
 *     build, distro dikirim TANPA `src/mirror`).
 *
 * Satu implementasi supaya image hasil build dan hasil install tidak pernah
 * berbeda (mode file, sidecar `.js`, akun awal, fstab).
 */

export interface PopulateResult {
    /** true = `/etc/shadow` dibuat dengan root TERKUNCI (password wajib diatur saat install). */
    rootPasswordSeeded: boolean;
}

/** Ekstensi yang ikut disalin ke image. */
const TEXT_EXT = [".ts", ".js", ".json", ".conf", ".html", ".css", ".menu", ".svg"];
/** Aset biner — disimpan sebagai latin1 (1 byte = 1 char). */
const BINARY_EXT = [
    ".mp3",
    ".wav",
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".bmp",
    ".b64",
    ".webp",
    ".ico",
    ".woff2",
    ".woff",
    ".ttf",
    ".otf",
    ".eot",
];

/**
 * Berkas `/etc` tanpa ekstensi (tidak lolos filter `syncDir`) yang disalin eksplisit.
 */
const CRITICAL_ETC: Array<{
    name: string;
    mode?: number;
    /** Jangan timpa file yang sudah ada — isinya milik admin (per-node). */
    preserveExisting?: boolean;
}> = [
    { name: "crontab" },
    { name: "fstab.md" },
    { name: "group" },
    { name: "motd" },
    { name: "passwd" },
    { name: "pkg-demo.conf" },
    { name: "profile" },
    // Skrip boot gaya Unix (shebang `#!/bin/tsh`). Mode 0o755 penting: tanpa
    // bit x, init akan MELEWATI-nya (dan melaporkan alasannya saat boot).
    // TIDAK ditimpa kalau sudah ada: isinya khas node ini (daemon + export).
    { name: "rc.local", mode: 0o755, preserveExisting: true },
    { name: "shadow", mode: 0o640 },
];

export interface ImageOptions {
    /**
     * Image PRODUKSI ("binary"): program disimpan sebagai `.js` SAJA, tanpa
     * sourcemap dan tanpa `.ts`-nya. Sourcemap inline esbuild menyimpan source TS
     * lengkap (base64) — `tpkg.js` 240 KB vs 64 KB tanpa map — jadi tanpa ini
     * membuang `.ts` hampir tidak menghemat apa pun.
     *
     * Pengecualian (tetap `.ts`, lihat `keepsSource`): `/lib/**` — kernel
     * meng-compile `/lib/*.ts` ke cache saat boot (`@tsix/X` → `/lib/X.ts`) — dan
     * `/var/lib/tpkg/repo/**` (sumber paket yang dilayani tpkgd node ini).
     */
    binaryOnly?: boolean;
}

/** Lokasi yang WAJIB tetap berisi `.ts` walau image produksi. */
const KEEP_SOURCE_PREFIXES = ["/lib/", "/var/lib/tpkg/repo/"];

export function keepsSource(vfsPath: string): boolean {
    return KEEP_SOURCE_PREFIXES.some((prefix) => vfsPath.startsWith(prefix));
}

/** Sync rekursif direktori host → VFS (transpile TS → JS + mode executable). */
export function syncDir(
    bkfs: BKFS,
    hostDir: string,
    vfsDir: string,
    label: string = "INSTALL",
    options: ImageOptions = {},
): void {
    if (!bkfs.exists(vfsDir)) {
        // Sync generik: semua direktori 0o755. Setup permission khusus aplikasi
        // (mis. /etc/air-type → 0o777) dilakukan oleh configure.ts aplikasi tsb.
        bkfs.mkdir(vfsDir, 0, 0, 0o755);
        console.log(`[${label}] mkdir ${vfsDir}`);
    }

    const entries = fs.readdirSync(hostDir);
    for (const item of entries) {
        const fullHostPath = path.join(hostDir, item);
        const fullVfsPath = path.join(vfsDir, item).replace(/\\/g, "/");
        const stats = fs.statSync(fullHostPath);

        if (stats.isDirectory()) {
            syncDir(bkfs, fullHostPath, fullVfsPath, label, options);
            continue;
        }

        // Unit test (vitest) BUKAN bagian dari image sistem: tidak dieksekusi
        // runtime, tapi kalau ikut disalin dia masuk ke cache pre-compile `/lib`
        // yang dikirim ke SETIAP worker. Jadi lebih baik dilewati di sini.
        if (item.endsWith(".test.ts") || item.endsWith(".spec.ts")) continue;

        // Image binary: `.js` dibangun dari `.ts` di bawah — sidecar `.js` lama
        // yang kebetulan ada di mirror (bisa basi) jangan ikut menimpa.
        const keepSource = keepsSource(fullVfsPath);
        const binary = !!options.binaryOnly && !keepSource;
        if (binary && item.endsWith(".js") && entries.includes(item.slice(0, -3) + ".ts")) continue;
        if (binary && item.endsWith(".ts")) {
            compileBinary(bkfs, fullHostPath, fullVfsPath, label);
            continue;
        }
        // Image binary, lokasi yang tetap source (/lib, repo tpkgd): `.ts` saja.
        // Sidecar `.js` di sini tidak pernah dimuat — kernel & resolver memakai
        // `/lib/*.ts` — jadi hanya beban (plus sourcemap berisi source lengkap).
        const sourceOnly = !!options.binaryOnly && keepSource;
        if (sourceOnly && item.endsWith(".js") && entries.includes(item.slice(0, -3) + ".ts")) continue;

        const isBinary = BINARY_EXT.some((ext) => item.endsWith(ext));
        // `.conf` penting: tanpa itu `/etc/fstab.conf`, `/etc/dome/dome.conf`
        // DIAM-DIAM tidak ikut ter-sync ke image baru.
        if (!isBinary && !TEXT_EXT.some((ext) => item.endsWith(ext))) continue;

        const content = isBinary ? readBinaryFile(fullHostPath) : readTextFile(fullHostPath);

        // BOM UTF-8 → `U+FEFF` → byte `0xFF` di VFS (latin1). Berkas JS yang diawali
        // 0xFF ditolak browser, jadi BOM dibuang oleh `readTextFile()` dan dicatat.
        const bom = isBinary ? null : peekBom(fullHostPath);
        if (bom === "utf8") {
            console.log(`[${label}]   -> UTF-8 BOM stripped: ${fullVfsPath}`);
        } else if (bom) {
            console.warn(`[${label}]   -> WARNING: ${fullVfsPath} has a ${bom} BOM — fix the source file.`);
        }

        bkfs.touch(fullVfsPath, content);

        // Transpile TS -> JS sidecar (yang dieksekusi runtime)
        if (fullVfsPath.endsWith(".ts") && !sourceOnly) {
            try {
                // `content` = BYTE berkas; esbuild butuh TEKS (lihat `VfsText.ts`).
                const result = esbuild.transformSync(vfsBytesToUtf8(content), {
                    loader: "ts",
                    format: "cjs",
                    target: "node18",
                    sourcemap: "inline",
                });
                if (result.code) {
                    const jsPath = fullVfsPath.substring(0, fullVfsPath.length - 3) + ".js";
                    bkfs.touch(jsPath, utf8ToVfsBytes(result.code));
                    if (needsBinaryMode(jsPath)) applyBinaryMode(bkfs, jsPath, label);
                }
            } catch (e: any) {
                console.error(`[${label}] Warning: failed to compile ${fullVfsPath}: ${e.message}`);
            }
        }

        // Auto-executable untuk file di direktori eksekusi (/bin, /sbin, dll)
        if (needsBinaryMode(fullVfsPath) && (fullVfsPath.endsWith(".ts") || fullVfsPath.endsWith(".js"))) {
            applyBinaryMode(bkfs, fullVfsPath, label);
        }
    }
}

/**
 * compileBinary(): `.ts` → `.js` saja (tanpa sourcemap, tanpa menyimpan `.ts`).
 * Kalau compile gagal, `.ts` disimpan apa adanya supaya program tidak hilang
 * dari image (dan kegagalannya terlihat di log build).
 */
function compileBinary(bkfs: BKFS, hostPath: string, vfsPath: string, label: string): void {
    const content = readTextFile(hostPath);
    try {
        const result = esbuild.transformSync(vfsBytesToUtf8(content), {
            loader: "ts",
            format: "cjs",
            target: "node18",
            sourcefile: path.basename(vfsPath),
        });
        const jsPath = vfsPath.slice(0, -3) + ".js";
        bkfs.touch(jsPath, utf8ToVfsBytes(result.code));
        if (needsBinaryMode(jsPath)) applyBinaryMode(bkfs, jsPath, label);
    } catch (e: any) {
        console.error(`[${label}] Warning: failed to compile ${vfsPath} — keeping the .ts source: ${e.message}`);
        bkfs.touch(vfsPath, content);
        if (needsBinaryMode(vfsPath)) applyBinaryMode(bkfs, vfsPath, label);
    }
}

/**
 * applyEtcMode(): Paksa mode berkas `CRITICAL_ETC` tepat seperti di tabel.
 *
 * `BKFS.touch()` menghormati `mode` hanya saat berkas BARU dibuat (semantik `touch`
 * Unix), jadi mode berkas yang sudah ada ditegakkan terpisah.
 * `/etc/rc.local` tanpa bit `x` dilewati init, dan `/etc/shadow` harus tetap 0o640.
 */
function applyEtcMode(bkfs: BKFS, name: string, mode: number | undefined, label: string): void {
    if (mode === undefined) return;
    const vfsPath = `/etc/${name}`;
    const st = bkfs.stat(vfsPath);
    if (!st || st.mode === mode) return;
    bkfs.chmod(vfsPath, mode);
    console.log(`[${label}] chmod ${mode.toString(8)} ${vfsPath} (was ${(st.mode as number).toString(8)})`);
}

/**
 * populateRootfs(): isi image fresh — rootfs, framework common, `/etc` penting,
 * akun awal (root terkunci bila belum ada shadow), fstab & crontab bersih.
 *
 * Semua penulisan rootfs dalam SATU transaksi: kalau proses mati di tengah,
 * hasilnya "tidak ada" — bukan image setengah jadi yang kelihatan normal.
 */
export function populateRootfs(
    bkfs: BKFS,
    mirrorRoot: string,
    commonRoot: string,
    label: string = "INSTALL",
    options: ImageOptions = {},
): PopulateResult {
    console.log(
        `[${label}] Copying rootfs from ${mirrorRoot}${options.binaryOnly ? " (binary: .js only, no sourcemaps)" : ""} ...`,
    );
    bkfs.batch(() => {
        syncDir(bkfs, mirrorRoot, "/", label, options);
        // Framework @common/* (SyscallCode, IPCTypes, ExecMode, dll) dipakai
        // WorkerEntry via /lib/common.
        if (fs.existsSync(commonRoot)) {
            console.log(`[${label}] Copying common framework from ${commonRoot} ...`);
            syncDir(bkfs, commonRoot, "/lib/common", label, options);
        }
    });
    console.log(`[${label}] Rootfs synchronized.`);

    for (const entry of CRITICAL_ETC) {
        const hostFile = path.join(mirrorRoot, "etc", entry.name);
        if (!fs.existsSync(hostFile)) continue;

        if (entry.preserveExisting && bkfs.exists(`/etc/${entry.name}`)) {
            console.log(`[${label}] /etc/${entry.name} already exists — kept (owned by admin)`);
            applyEtcMode(bkfs, entry.name, entry.mode, label);
            continue;
        }

        // `readTextFile()` membuang BOM UTF-8 (byte 0xFF di VFS → skrip ditolak).
        bkfs.touch(`/etc/${entry.name}`, readTextFile(hostFile), 0, 0, entry.mode ?? 0o644);
        applyEtcMode(bkfs, entry.name, entry.mode, label);
        console.log(`[${label}] sync /etc/${entry.name}`);
    }

    const rootPasswordSeeded = ensureFreshAccountFiles(bkfs);

    // Image fresh: fstab hanya berisi mount esensial (templat diuji di
    // `FstabParser.test.ts` A4.09). Format INI adalah satu-satunya sumber mount.
    bkfs.touch("/etc/fstab.conf", FRESH_FSTAB_INI, 0, 0, 0o644);
    console.log(`[${label}] /etc/fstab.conf: /tmp + /var/run (ramfs); dev mounts removed`);

    // `.json` lama bukan lagi sumber konfigurasi (kernel hanya membaca `.conf`).
    if (bkfs.exists("/etc/fstab.json")) {
        bkfs.unlink("/etc/fstab.json");
        console.log(`[${label}] old /etc/fstab.json removed (moved to .conf)`);
    }

    // Crontab dikosongkan (tidak membawa jadwal bawaan developer).
    bkfs.touch(
        "/etc/crontab",
        "# /etc/crontab — empty for a fresh install.\n# Edit schedules with: crontab -e\n",
        0,
        0,
        0o644,
    );
    console.log(`[${label}] /etc/crontab emptied`);

    return { rootPasswordSeeded };
}

/**
 * isRootLocked(): apakah akun root di image masih terkunci (`!`/`*`/kosong) —
 * dipakai installer mode produksi untuk tahu apakah password root WAJIB diisi.
 */
export function isRootLocked(bkfs: BKFS): boolean {
    const shadow = bkfs.read("/etc/shadow") || "";
    const root = shadow.split("\n").find((l) => l.startsWith("root:"));
    if (!root) return true;
    const hash = root.split(":")[1] ?? "";
    return hash === "" || hash.startsWith("!") || hash === "*";
}
