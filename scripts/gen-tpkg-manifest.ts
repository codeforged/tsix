import * as fs from "fs";
import * as path from "path";

/**
 * GENERATOR MANIFEST TPKG — paket `system-update` (engine update)
 *
 * KENAPA GENERATOR, BUKAN DITULIS TANGAN:
 * daftar file sistem TSIX berubah terus (pernah 17 item padahal sistemnya 128
 * file, dan kernel 37 file sama sekali tidak ikut). Manifest yang ditulis tangan
 * pasti drift; manifest yang di-generate dari inventaris nyata tidak bisa.
 *
 * CARA PAKAI:
 *   npm run tpkg:manifest            -> tulis manifest
 *   npm run tpkg:manifest -- --dry   -> cuma tampilkan ringkasan (tanpa menulis)
 *
 * APA YANG DI-GENERATE:
 *   1. File VFS sistem  : src/mirror/{bin,sbin,usr/bin,lib,lib/common,etc}
 *      src (dibaca server) = path VFS;  dst = path VFS yang sama di klien.
 *   2. Kerangka engine  : src/kernel/**.ts + src/userland/WorkerEntry.ts
 *      File-file ini HANYA ada di host (tidak pernah masuk VFS), jadi:
 *      src = /hostsrc/<rel>   (mount read-only dari fstab: hostPath "src")
 *      dst = /tmp/tpkg-stage/<rel>  (staging; SYNC_TO_HOST membaca isi dari VFS)
 *      hostDst = <rel>        (tujuan sebenarnya, relatif root proyek)
 *   3. hostDst untuk SEMUA item: paket engine menulis ke HOST juga, supaya repo di
 *      node tidak tertinggal dari BKFS. Kalau tertinggal, `npm run vfs:bootstrap`
 *      berikutnya akan menurunkan versi sistem secara diam-diam.
 *
 * MODE: tidak ditulis di manifest kalau sudah bisa diturunkan dari path —
 * `resolveMode()` di TpkgProtocol.ts memakai aturan yang sama dengan
 * `scripts/vfs-bootstrap.ts` (EXEC_DIRS + SetUID login/passwd/sudo). Yang tetap
 * ditulis eksplisit hanya SetUID, karena salah di situ = `sudo` tidak bisa baca
 * /etc/shadow.
 *
 * FILE YANG SENGAJA DILEWATI:
 *   - `*.test.ts` / `*.spec.ts` — bukan bagian image sistem (juga dilewati
 *     `install.ts` & `vfs-bootstrap.ts`);
 *   - sidecar `*.js` — selalu di-regenerate dari `.ts` (saat bootstrap, dan oleh
 *     `/sbin/apply-update.ts` setelah paket ini dipasang);
 *   - `.DS_Store` dan file non-.ts/.json (aset gambar/audio milik aplikasi /opt).
 */

const ROOT = path.resolve(__dirname, "..");
const MIRROR = path.join(ROOT, "src/mirror");
const MANIFEST = path.join(MIRROR, "etc/tpkg/packages.json");
/** Nama paket engine yang di-generate. */
const ENGINE_PKG = "system-update";
/** Direktori VFS yang isinya masuk paket engine (relatif src/mirror). */
const VFS_DIRS = ["bin", "sbin", "usr/bin", "lib", "lib/common", "etc"];
/** Ekstensi yang dianggap isi sistem. */
const EXT = [".ts", ".json"];
/** Mount host read-only di node (lihat src/mirror/etc/fstab.conf). */
const HOSTSRC_MOUNT = "/hostsrc";
/** Staging VFS untuk file host (ramfs /tmp). */
const HOST_STAGE = "/tmp/tpkg-stage";

/**
 * YANG TIDAK BOLEH IKUT — data milik NODE, bukan milik engine.
 *
 * Ini kategori paling berbahaya kalau salah: mengirim `/etc/shadow` ke node lain
 * berarti akun server menggantikan akun node itu, dan mengirim `trusted_repos`
 * menyuntikkan kepercayaan ke repo asing. `fstab.conf`/`crontab` mengubah cara node
 * itu boot & menjadwalkan tugas. Semua ini sengaja TIDAK PERNAH di-update oleh paket
 * engine.
 */
const NODE_LOCAL_PATTERNS: RegExp[] = [
    /^\/etc\/(passwd|shadow|group)$/,
    // fstab: `.conf` adalah sumber kebenaran sekarang, `.json` nama lama yang masih
    // dipakai node pra-migrasi. Keduanya dilarang — `EXT` belum memuat `.conf`,
    // jadi pola ini penjaga kalau nanti `EXT`/whitelist ikut berubah.
    /^\/etc\/fstab\.(conf|json)$/,
    /^\/etc\/crontab$/,
    /^\/etc\/tpkg\/trusted_repos$/,
    /^\/etc\/tpkg\/keys\//,
    /^\/etc\/tsd\//, // trust + manifest milik tsd (legacy, per node)
];

/**
 * `/etc` WHITELIST: hanya config tingkat sistem yang aman ditimpa.
 *
 * Sisanya (config aplikasi seperti /etc/lantana/*, /etc/telechat/*) adalah
 * pengaturan operator — engine update tidak boleh mengembalikannya ke default.
 * Paket manager di distro nyata menyelesaikan ini dengan "conffile": kalau user
 * sudah mengubah, file tidak ditimpa. TSIX belum punya mekanisme itu, jadi untuk
 * sekarang: lebih baik tidak mengirim sama sekali.
 */
const SYSTEM_ETC = ["profile", "rc.local", "motd", "motd.json", "fstab.md", "tpkg/packages.json"];

interface Item {
    src?: string;
    dst: string;
    hostDst?: string;
    permissions?: number;
    isExecutable?: boolean;
}

/** Binary yang wajib SetUID (salinan aturan vfs-bootstrap). */
const SETUID_RE = /\/bin\/(login|passwd|sudo)\.ts$/;
/** Mode SetUID — disamakan dengan `TPKG_SETUID_MODE`. */
const SETUID_MODE = 0o4755;

/**
 * walk(): daftar file yang ikut paket.
 *
 * `nameWhitelist` dipakai `/etc`: file seperti `profile`/`rc.local`/`motd` tidak
 * berekstensi, jadi filter ekstensi saja akan membuangnya padahal itu config boot
 * (rc.local dijalankan init via shebang `#!/bin/tsh`).
 */
function walk(dir: string, base: string = "", nameWhitelist?: string[]): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === ".DS_Store" || entry.name.startsWith(".")) continue;
        const rel = base ? `${base}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...walk(full, rel, nameWhitelist));
            continue;
        }
        if (/\.(test|spec)\.ts$/.test(entry.name)) continue;
        const allowed = EXT.some((e) => entry.name.endsWith(e)) || !!nameWhitelist?.includes(rel);
        if (!allowed) continue;
        out.push(rel);
    }
    return out;
}

/** Versi engine diambil dari `src/kernel/Kernel.ts` — satu sumber kebenaran. */
function kernelVersion(): string {
    const src = fs.readFileSync(path.join(ROOT, "src/kernel/Kernel.ts"), "utf8");
    const m = src.match(/private\s+version\s*:\s*string\s*=\s*"([^"]+)"/);
    if (!m) throw new Error("versi kernel tidak ketemu di src/kernel/Kernel.ts");
    return m[1];
}

/** Ikut dikirim ke node lain? (lihat NODE_LOCAL_PATTERNS & SYSTEM_ETC) */
function isShippable(vfsPath: string): boolean {
    for (const re of NODE_LOCAL_PATTERNS) if (re.test(vfsPath)) return false;
    if (vfsPath.startsWith("/etc/")) {
        return SYSTEM_ETC.some((f) => vfsPath === `/etc/${f}`);
    }
    return true;
}

/** File sistem yang ada di VFS (src = VFS, dst = VFS, hostDst = repo). */
function vfsItems(): Item[] {
    const items: Item[] = [];
    const seen = new Set<string>();
    const skipped: string[] = [];
    for (const dir of VFS_DIRS) {
        const abs = path.join(MIRROR, dir);
        if (!fs.existsSync(abs)) continue;
        const whitelist = dir === "etc" ? SYSTEM_ETC : undefined;
        for (const rel of walk(abs, "", whitelist)) {
            const vfsPath = `/${dir}/${rel}`;
            if (!isShippable(vfsPath)) {
                skipped.push(vfsPath);
                continue;
            }
            // Satu-satunya pengecualian: /lib/common di VFS di-seed dari src/common,
            // jadi sumber repo-nya juga src/common (bukan src/mirror/lib/common).
            const hostDst = dir === "lib/common" ? `src/common/${rel}` : `src/mirror/${dir}/${rel}`;
            const item: Item = { src: vfsPath, dst: vfsPath, hostDst };
            if (SETUID_RE.test(vfsPath)) item.permissions = SETUID_MODE;
            else if (vfsPath.endsWith(".ts") && /\/(bin|usr\/bin|opt)\//.test(vfsPath)) item.isExecutable = true;
            items.push(item);
            seen.add(vfsPath);
        }
    }

    if (skipped.length > 0) {
        console.log(`[tpkg:manifest] dilewati (data per node): ${skipped.sort().join(", ")}`);
    }

    // Framework `@common/*`: HANYA 1 file ada di src/mirror/lib/common (sisanya
    // hidup di src/common dan di-seed ke VFS saat install/bootstrap). Tanpa blok
    // ini, komponen seperti AesGcmAgent/ISecurityAgent/Shebang tidak ikut terkirim
    // — padahal itu bagian keamanan engine.
    const commonDir = path.join(ROOT, "src/common");
    if (fs.existsSync(commonDir)) {
        for (const rel of fs.readdirSync(commonDir).sort()) {
            if (!rel.endsWith(".ts") || /\.(test|spec)\.ts$/.test(rel)) continue;
            const vfsPath = `/lib/common/${rel}`;
            if (seen.has(vfsPath)) continue;
            items.push({ src: vfsPath, dst: vfsPath, hostDst: `src/common/${rel}` });
        }
    }

    return items;
}

/** File host-only (kernel + bootloader worker). */
function hostItems(): Item[] {
    const items: Item[] = [];
    const targets = [
        { abs: path.join(ROOT, "src/kernel"), rel: "src/kernel" },
        // Bootloader worker + resolver modul relatif. Keduanya dimuat LANGSUNG oleh
        // Node (WorkerEntry.js via `new Worker()`, VfsModuleResolver.js via require),
        // jadi sidecar .js-nya dibangun ulang oleh /sbin/apply-update.ts.
        {
            abs: path.join(ROOT, "src/userland"),
            rel: "src/userland",
            only: ["WorkerEntry.ts", "VfsModuleResolver.ts"],
        },
    ];

    for (const t of targets) {
        if (!fs.existsSync(t.abs)) continue;
        for (const rel of walk(t.abs)) {
            if (t.only && !t.only.includes(rel)) continue;
            const hostRel = `${t.rel}/${rel}`;
            items.push({
                src: `${HOSTSRC_MOUNT}/${hostRel.substring("src/".length)}`,
                dst: `${HOST_STAGE}/${hostRel.substring("src/".length)}`,
                hostDst: hostRel,
            });
        }
    }
    return items;
}

function build(): { items: Item[]; vfs: number; host: number } {
    const vfs = vfsItems();
    const host = hostItems();
    return { items: [...vfs, ...host], vfs: vfs.length, host: host.length };
}

function main() {
    const dry = process.argv.includes("--dry");
    const { items, vfs, host } = build();
    const version = kernelVersion();

    const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
    const engine = {
        name: ENGINE_PKG,
        version,
        description: "TSIX engine update — kernel + semua file sistem (/bin, /sbin, /usr/bin, /lib, /lib/common, /etc)",
        author: "TSIX",
        needReboot: true,
        // Dijalankan setelah semua file mendarat: regenerate sidecar .js di VFS
        // (EXEC & PATH memprioritaskan .js!) lalu tegakkan mode eksekusi.
        onAfterDownload: "/sbin/apply-update.ts",
        items,
    };

    const idx = manifest.packages.findIndex((p: any) => p.name === ENGINE_PKG);
    if (idx >= 0) manifest.packages[idx] = engine;
    else manifest.packages.push(engine);

    const size = items.reduce((sum, it) => sum + fs.statSync(srcToHostPath(it)).size, 0);

    console.log(`[tpkg:manifest] paket   : ${ENGINE_PKG} v${version}`);
    console.log(`[tpkg:manifest] file    : ${items.length} (VFS ${vfs} + host ${host})`);
    console.log(`[tpkg:manifest] ukuran  : ${(size / 1024).toFixed(0)} KB`);

    if (dry) {
        console.log("[tpkg:manifest] --dry: manifest tidak ditulis.");
        return;
    }

    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 4) + "\n");
    console.log(`[tpkg:manifest] ditulis : ${path.relative(ROOT, MANIFEST)}`);
}

/** srcToHostPath(): item manifest → path nyata di host (untuk hitung ukuran). */
function srcToHostPath(item: Item): string {
    if (item.hostDst) return path.join(ROOT, item.hostDst);
    return path.join(MIRROR, item.src ?? "");
}

main();
