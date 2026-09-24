import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { getDefaultDbPath } from "./lib/db-path";
import { BKFS } from "../src/vfs/BKFS";

/**
 * BKFS-INFO — "mata" untuk isi & kesehatan database BKFS.
 *
 * KENAPA TOOL INI ADA:
 * optimasi storage (tabel `blocks`, WAL, BLOB) tidak kelihatan dari luar: `ls -l`
 * tidak membedakan file inline vs ber-blok, dan `df` (getUsage) hanya total ukuran.
 * Tanpa alat ini, satu-satunya cara memeriksa adalah membuka SQL mentah — dan itulah
 * sebabnya perubahan besar (O(n²) → O(1) per potongan) sulit diverifikasi secara
 * visual.
 *
 * Yang dilaporkan: mode journal, ukuran file (+ peringatan kalau `-wal` tertinggal),
 * integritas, sebaran penyimpanan (inline vs blok), baris WARISAN (TEXT) yang belum
 * bermigrasi, dan file terbesar beserta bentuk penyimpanannya.
 *
 * SEKSI KESEHATAN: `quick_check` SQLite hanya memeriksa integritas HALAMAN. Bentuk
 * penyimpanan yang tidak konsisten (baris punya `content` *dan* blok sisa, blok yatim,
 * blok bolong) tetap dilaporkan "ok" — padahal itu ruang terbuang dan potensi isi
 * hantu. Seksi "Kesehatan penyimpanan" melaporkan hal itu, dan `--repair`
 * membersihkannya (isi file tidak disentuh).
 *
 * CARA PAKAI:
 *   npm run bkfs:info                    # DB default dari sysconfig.conf
 *   npm run bkfs:info -- --db system.db
 *   npm run bkfs:info -- --top 15        # daftar file terbesar
 *   npm run bkfs:info -- --check         # integrity_check penuh (lebih lambat)
 *   npm run bkfs:info -- --json          # keluaran mesin (untuk skrip/CI)
 *   npm run bkfs:info -- --repair        # MENULIS: buang blok tidak sah
 *   npm run bkfs:info -- --checkpoint    # MENULIS: pindahkan WAL ke system.db
 *
 * Read-only secara default (aman dijalankan saat sistem hidup). Hanya `--repair`,
 * `--checkpoint` dan `--compact` yang menulis, dan itu harus diminta eksplisit.
 */

interface Options {
    db: string;
    top: number;
    full: boolean;
    json: boolean;
    checkpoint: boolean;
    compact: boolean;
    repair: boolean;
    migrateLegacy: boolean;
}

function parseArgs(argv: string[]): Options {
    const opts: Options = {
        db: path.resolve(__dirname, "..", getDefaultDbPath()),
        top: 10,
        full: false,
        json: false,
        checkpoint: false,
        compact: false,
        repair: false,
        migrateLegacy: false,
    };

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--db") opts.db = path.resolve(argv[++i] ?? "");
        else if (a === "--top") opts.top = Number(argv[++i] ?? 10) || 10;
        else if (a === "--check") opts.full = true;
        else if (a === "--json") opts.json = true;
        else if (a === "--checkpoint") opts.checkpoint = true;
        else if (a === "--compact") opts.compact = true;
        else if (a === "--repair") opts.repair = true;
        else if (a === "--migrate-legacy") opts.migrateLegacy = true;
        else if (a === "--help" || a === "-h") {
            console.log(
                "Usage: bkfs-info [--db <path>] [--top <n>] [--check] [--json] [--repair] [--migrate-legacy] [--checkpoint] [--compact]\n" +
                    "  --check          integrity_check penuh (default: quick_check)\n" +
                    "  --repair         buang blok yatim/basi (menulis, isi file tidak disentuh)\n" +
                    "  --migrate-legacy tulis ulang baris TEXT warisan jadi BLOB (menulis)\n" +
                    "  --checkpoint     pindahkan WAL ke file utama (menulis)\n" +
                    "  --compact        VACUUM — ciutkan file (menulis, bisa lama)",
            );
            process.exit(0);
        }
    }
    return opts;
}

/** size(): Ukuran file dalam teks pendek; 0 kalau tidak ada. */
function size(file: string): number {
    try {
        return fs.statSync(file).size;
    } catch {
        return 0;
    }
}

function human(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function row(label: string, value: string, note?: string): string {
    return `   ${label.padEnd(16)}: ${value}${note ? `  ${note}` : ""}`;
}

/**
 * migrateLegacy(): Tulis ulang baris WARISAN (`typeof(content) = 'text'`) sebagai BLOB.
 *
 * KENAPA: baris lama menyimpan isi sebagai TEXT. Untuk aset BINER itu berarti byte
 * ≥ 0x80 di-encode UTF-8 (2 byte per byte) sehingga database ~2× lebih besar, dan
 * `length()`/`substr()` SQLite berhenti di byte NUL sehingga metadata seperti `size`
 * tidak bisa dipercaya. Ditambah lagi, file > `inlineMaxBytes` tetap satu baris besar
 * (tulis-ulang O(n) per potongan).
 *
 * CARA: baca lewat API (`read()`) lalu tulis ulang lewat API (`touch()`) — jalur yang
 * sama dengan kernel, jadi aturan "content ATAU blok" ikut berlaku (file besar otomatis
 * pindah ke tabel blok). SEMUA dalam SATU transaksi: mati di tengah = tidak berubah
 * sama sekali, bukan setengah jalan.
 *
 * CATATAN PENTING: byte yang dibaca kembali adalah apa yang TERSIMPAN. Kalau baris lama
 * sudah rusak saat ditulis (dulu dibaca sebagai `utf8` dari berkas biner), kerusakannya
 * sudah terjadi di database dan tidak bisa dipulihkan dari sini — jalankan
 * `npm run vfs:bootstrap` (atau install ulang) untuk mengisi ulang dari sumber aslinya.
 */
function migrateLegacy(dbPath: string, db: Database.Database): void {
    // Path lengkap dibutuhkan karena `touch()` bekerja per path, bukan per id.
    const rows = db
        .prepare(
            `WITH RECURSIVE tree(id, path) AS (
                SELECT id, name FROM vnodes WHERE parent_id IS NULL
                UNION ALL
                SELECT v.id, CASE WHEN tree.path = '/' THEN '/' || v.name ELSE tree.path || '/' || v.name END
                FROM vnodes v JOIN tree ON v.parent_id = tree.id
             )
             SELECT tree.path AS path, v.uid AS uid, v.gid AS gid, v.mode AS mode
             FROM tree JOIN vnodes v ON v.id = tree.id
             WHERE v.type = 'FILE' AND typeof(v.content) = 'text'
             ORDER BY v.size DESC`,
        )
        .all() as Array<{ path: string; uid: number; gid: number; mode: number }>;

    if (rows.length === 0) {
        console.log("✅ Tidak ada baris warisan TEXT — semua isi sudah BLOB.");
        return;
    }

    const sebelum = size(dbPath);
    const b = new BKFS(dbPath);
    try {
        let ditulis = 0;
        let gagal = 0;
        b.batch(() => {
            for (const f of rows) {
                const isi = b.read(f.path);
                if (isi === null) continue;
                const ok = b.touch(f.path, isi, f.uid ?? 0, f.gid ?? 0, f.mode ?? 420);
                if (ok) ditulis++;
                else gagal++;
            }
        });
        b.checkpoint();
        console.log(
            `✅ ${ditulis} baris warisan ditulis ulang sebagai BLOB` +
                (gagal > 0 ? ` (${gagal} gagal)` : "") +
                `, dalam satu transaksi.`,
        );
        console.log(
            `   file: ${human(sebelum)} → ${human(size(dbPath))} (ruang benar-benar kembali setelah \`--compact\`).`,
        );
    } finally {
        b.close();
    }
}

/**
 * withReadOnlyBkfs(): Buka database lewat class `BKFS` (read-only) lalu tutup lagi.
 *
 * Angka kesehatan penyimpanan diambil dari `BKFS.storageHealth()` supaya alat ini dan
 * kernel memakai SATU definisi yang sama — kalau tidak, laporan diagnostik bisa
 * "menyimpang" dari yang benar-benar dipakai sistem, dan justru itu yang menjebak
 * saat mencari masalah.
 *
 * Return `null` kalau bukan database BKFS (skema `vnodes`/`blocks` tidak ada).
 */
function withReadOnlyBkfs<T>(dbPath: string, fn: (b: BKFS) => T): T | null {
    try {
        const b = new BKFS(dbPath, true);
        try {
            return fn(b);
        } finally {
            b.close();
        }
    } catch {
        return null;
    }
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));

    if (!fs.existsSync(opts.db)) {
        console.error(`❌ Database tidak ditemukan: ${opts.db}`);
        process.exit(1);
    }

    // `--checkpoint`/`--compact`/`--repair`/`--migrate-legacy` menulis → butuh read-write.
    const writable = opts.checkpoint || opts.compact || opts.repair || opts.migrateLegacy;
    const db = new Database(opts.db, { readonly: !writable });
    db.pragma("busy_timeout = 5000");

    try {
        // ---------------------------------------------------------------- file
        const dbSize = size(opts.db);
        const walSize = size(opts.db + "-wal");
        const shmSize = size(opts.db + "-shm");

        // ------------------------------------------------------------ pragmas
        const journal = String(db.pragma("journal_mode", { simple: true }) ?? "?");
        const sync = String(db.pragma("synchronous", { simple: true }) ?? "?");
        const pageSize = Number(db.pragma("page_size", { simple: true }) ?? 0);
        const pageCount = Number(db.pragma("page_count", { simple: true }) ?? 0);
        const freelist = Number(db.pragma("freelist_count", { simple: true }) ?? 0);
        const autoVacuum = Number(db.pragma("auto_vacuum", { simple: true }) ?? 0);

        // --------------------------------------------------------- integritas
        const checkRows = db.pragma(opts.full ? "integrity_check" : "quick_check") as Array<
            Record<string, string>
        >;
        const checkMsgs = (checkRows ?? []).map((r) => Object.values(r)[0]);
        const integrity = checkMsgs.every((m) => m === "ok") ? "ok" : checkMsgs.join("; ");

        // -------------------------------------------------------------- isi
        const counts = db
            .prepare(
                `SELECT
                    SUM(CASE WHEN type = 'DIRECTORY' THEN 1 ELSE 0 END) AS dirs,
                    SUM(CASE WHEN type = 'FILE' THEN 1 ELSE 0 END)      AS files,
                    SUM(CASE WHEN type = 'FILE' THEN IFNULL(size,0) ELSE 0 END) AS bytes,
                    SUM(CASE WHEN type = 'FILE' AND content IS NOT NULL THEN 1 ELSE 0 END) AS inline_files,
                    (SELECT COUNT(DISTINCT vnode_id) FROM blocks) AS block_files,
                    SUM(CASE WHEN type = 'FILE' AND typeof(content) = 'text' THEN 1 ELSE 0 END) AS legacy_text
                 FROM vnodes WHERE name != '/'`,
            )
            .get() as Record<string, number>;

        const blockStats = db
            .prepare("SELECT COUNT(*) AS n, IFNULL(SUM(length(data)),0) AS bytes FROM blocks")
            .get() as Record<string, number>;

        // ------------------------------------------------------- file terbesar
        // Path lengkap dibangun lewat recursive CTE (nama saja tidak informatif).
        const top = db
            .prepare(
                `WITH RECURSIVE tree(id, path) AS (
                    SELECT id, name FROM vnodes WHERE parent_id IS NULL
                    UNION ALL
                    SELECT v.id, CASE WHEN tree.path = '/' THEN '/' || v.name ELSE tree.path || '/' || v.name END
                    FROM vnodes v JOIN tree ON v.parent_id = tree.id
                 )
                 SELECT tree.path AS path, v.size AS size,
                        (SELECT COUNT(*) FROM blocks b WHERE b.vnode_id = v.id) AS blocks,
                        typeof(v.content) AS kind
                 FROM tree JOIN vnodes v ON v.id = tree.id
                 WHERE v.type = 'FILE' AND IFNULL(v.size,0) > 0
                 ORDER BY v.size DESC LIMIT ?`,
            )
            .all(opts.top) as Array<{ path: string; size: number; blocks: number; kind: string }>;

        // -------------------------------------------------------------- aksi
        if (opts.migrateLegacy) {
            migrateLegacy(opts.db, db);
            return;
        }
        if (opts.repair) {
            // Hitung DULU lewat SQL mentah: membuka `BKFS` langsung membersihkan
            // (lihat `repairStorage()`), jadi setelah itu angkanya sudah nol dan
            // laporannya akan berbohong ("tidak ada yang perlu dibersihkan").
            const sebelum = {
                orphan: Number(
                    (
                        db.prepare("SELECT COUNT(*) AS n FROM blocks WHERE vnode_id NOT IN (SELECT id FROM vnodes)").get() as {
                            n: number;
                        }
                    ).n,
                ),
                stale: Number(
                    (
                        db
                            .prepare(
                                "SELECT COUNT(*) AS n FROM blocks WHERE vnode_id IN (SELECT id FROM vnodes WHERE content IS NOT NULL)",
                            )
                            .get() as { n: number }
                    ).n,
                ),
            };

            const b = new BKFS(opts.db);
            try {
                b.repairStorage(); // idempoten: membersihkan sisa yang mungkin muncul setelah buka
                b.checkpoint();
            } finally {
                b.close();
            }

            if (sebelum.orphan + sebelum.stale === 0) {
                console.log("✅ Tidak ada blok tidak sah — bentuk penyimpanan sudah konsisten.");
            } else {
                console.log(
                    `✅ Dibersihkan: ${sebelum.orphan} blok yatim + ${sebelum.stale} blok basi.\n` +
                        `   Isi file (kolom content) tidak disentuh — yang dibuang hanya blok yang tidak dibaca siapa pun.`,
                );
            }
            return;
        }
        if (opts.checkpoint) {
            db.pragma("wal_checkpoint(TRUNCATE)");
            db.close();
            const after = size(opts.db + "-wal");
            console.log(
                after === 0
                    ? `✅ Checkpoint selesai — ${path.basename(opts.db)} sekarang lengkap sebagai satu file.`
                    : `⚠️ Checkpoint jalan tapi -wal masih ${human(after)} (ada koneksi lain yang menahan).`,
            );
            return;
        }
        if (opts.compact) {
            db.exec("VACUUM");
            db.close();
            console.log(`✅ VACUUM selesai — ukuran sekarang ${human(size(opts.db))}.`);
            return;
        }

        // ------------------------------------------------- kesehatan penyimpanan
        // (setelah blok aksi: `--repair`/`--checkpoint`/`--compact` sudah `return`)
        const health = withReadOnlyBkfs(opts.db, (b) => b.storageHealth());

        // ------------------------------------------------------------- output
        if (opts.json) {
            console.log(
                JSON.stringify(
                    {
                        db: opts.db,
                        files: { db: dbSize, wal: walSize, shm: shmSize },
                        pragmas: { journal, synchronous: sync, pageSize, pageCount, freelist, autoVacuum },
                        integrity,
                        counts,
                        blocks: blockStats,
                        health,
                        top,
                    },
                    null,
                    2,
                ),
            );
            return;
        }

        console.log(`\n📦 BKFS — ${path.relative(process.cwd(), opts.db)}`);
        console.log(row("ukuran db", human(dbSize)));
        console.log(
            row(
                "WAL",
                walSize > 0 ? human(walSize) : "—",
                walSize > 0 ? "⚠️ ada transaksi belum ter-checkpoint" : "✅ sudah rapi (satu file)",
            ),
        );
        if (shmSize > 0) console.log(row("SHM", human(shmSize)));
        console.log(row("journal_mode", journal, sync !== "?" ? `· synchronous=${sync}` : ""));
        console.log(row("halaman", `${pageCount} × ${pageSize} B`, `· freelist ${freelist}`));
        if (autoVacuum !== 0) console.log(row("auto_vacuum", String(autoVacuum)));
        console.log(row("integritas", integrity, opts.full ? "(integrity_check)" : "(quick_check)"));

        console.log(`\n📊 Isi`);
        console.log(row("direktori", String(counts?.dirs ?? 0)));
        console.log(row("file", String(counts?.files ?? 0)));
        console.log(row("total isi", human(Number(counts?.bytes ?? 0))));
        console.log(
            row(
                "penyimpanan",
                `inline ${counts?.inline_files ?? 0} · blok ${counts?.block_files ?? 0}`,
                `${blockStats?.n ?? 0} blok (${human(Number(blockStats?.bytes ?? 0))} isi blok)`,
            ),
        );
        if ((counts?.legacy_text ?? 0) > 0) {
            const biner = health?.legacyNulFiles ?? 0;
            console.log(
                row(
                    "warisan TEXT",
                    String(counts.legacy_text),
                    biner > 0
                        ? `termasuk ${biner} biner/ber-NUL (~2× lebih besar di DB)`
                        : "belum BLOB — berpindah otomatis saat file ditulis ulang",
                ),
            );
            console.log(
                `      ${"".padEnd(14)}  → rapikan sekarang: npm run bkfs:info -- --migrate-legacy`,
            );
        }

        // Kesehatan bentuk penyimpanan: `quick_check` di atas TIDAK memeriksa ini.
        if (health) {
            const bermasalah = health.staleBlocks + health.orphanBlocks + health.holeyFiles + health.sizeMismatch;
            console.log(`\n🩺 Kesehatan penyimpanan`);
            console.log(row("file ber-blok", String(health.blockFiles), "isi besar dipotong per 128 KB"));
            console.log(
                row(
                    "blok tidak sah",
                    String(health.staleBlocks + health.orphanBlocks),
                    bermasalah === 0 ? "✅ tidak ada" : "⚠️ jalankan: npm run bkfs:info -- --repair",
                ),
            );
            if (health.staleBlocks > 0) {
                console.log(row("  · basi", String(health.staleBlocks), "baris punya content tapi bloknya masih ada"));
            }
            if (health.orphanBlocks > 0) {
                console.log(row("  · yatim", String(health.orphanBlocks), "vnodenya sudah dihapus"));
            }
            if (health.holeyFiles > 0) {
                console.log(row("file bolong", String(health.holeyFiles), "⚠️ nomor blok tidak berurutan"));
            }
            if (health.sizeMismatch > 0) {
                console.log(
                    row("size ≠ isi", String(health.sizeMismatch), "⚠️ kolom size tidak cocok dengan panjang content"),
                );
            }
            if (health.emptyWithoutBlocks > 0) {
                // Normal untuk file yang dibuat tanpa isi (`touch` pada path baru):
                // `content` = BLOB kosong, bukan NULL. > 0 berarti ada baris warisan
                // dengan `content` NULL tanpa blok — isinya memang kosong.
                console.log(
                    row("tanpa isi", String(health.emptyWithoutBlocks), "file kosong (tanpa content & tanpa blok)"),
                );
            }
        }

        if (top.length > 0) {
            console.log(`\n🔝 ${top.length} file terbesar`);
            const width = Math.min(60, Math.max(...top.map((f) => f.path.length), 20));
            for (const f of top) {
                const kind = f.blocks > 0 ? `blok×${f.blocks}` : f.kind === "text" ? "inline (TEXT)" : "inline";
                console.log(`   ${f.path.slice(0, width).padEnd(width)}  ${human(f.size).padStart(9)}  ${kind}`);
            }
        }

        if (walSize > 0) {
            console.log(
                `\n💡 Ada WAL ${human(walSize)}: jangan salin ${path.basename(opts.db)} sendirian (transaksi terakhir hanya ada di -wal).\n` +
                    `   Kalau sistem sudah mati: npm run bkfs:info -- --checkpoint`,
            );
        }
        console.log();
    } finally {
        try {
            db.close();
        } catch {
            /* sudah ditutup di jalur aksi */
        }
    }
}

main().catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exit(1);
});
