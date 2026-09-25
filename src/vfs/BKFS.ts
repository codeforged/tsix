import Database from "better-sqlite3";
import * as path from "path";
import { Logger } from "../common/Logger";
import { IVFS } from "./IVFS";
import { VNodeType } from "./VFS";

/**
 * Kolom METADATA vnode — `content` SENGAJA tidak ikut.
 *
 * `SELECT *` di tabel ini berarti ikut membaca `content`. Untuk file besar itu
 * bencana: satu baris 70 MB memaksa SQLite mematerialisasi seluruh isi + membuat
 * string JS ~2x ukuran byte (UTF-16). Terukur di lapangan: `stat` satu file 70 MB
 * pada export bkfs melewati timeout 5 s klien NetFS, dan beberapa kali percobaan
 * berturut-turut menghabiskan heap kernel SH (~800 MB, `--max-old-space-size=512`)
 * -> `FATAL ERROR: Reached heap limit`. Kontrak IVFS sendiri jelas:
 * `stat` = metadata, `read` = konten (lihat komentar di `Syscalls.EXEC`).
 */
const VNODE_META_COLUMNS = "id, parent_id, name, type, size, uid, gid, mode, created_at, modified_at";

/**
 * Batas ukuran isi yang BOLEH ditahan untuk cache `readChunk()` (byte).
 *
 * Sejak `content` disimpan sebagai BLOB, jalur normal `readChunk()` memotong di
 * sisi SQL (lihat `readChunk()`) sehingga cache ini TIDAK dipakai lagi untuk data
 * baru. Yang tersisa adalah baris WARISAN bertipe TEXT: di situ `substr()` SQLite
 * berhenti di byte NUL, jadi satu-satunya cara benar adalah membaca penuh ke JS
 * lalu `slice()`. Cache satu entri ini membuat pembacaan berurutan file warisan
 * tetap murah.
 */
const BKFS_CHUNK_CACHE_MAX_BYTES = 192 * 1024 * 1024;

/**
 * PRAGMA yang dipasang tiap kali database dibuka.
 *
 * `journal_mode = WAL` — yang paling berdampak, untuk KETAHANAN sekaligus
 * kecepatan:
 *
 *   - Mode lama (`DELETE`, default SQLite) menyalin HALAMAN LAMA ke rollback
 *     journal sebelum mengubah, lalu `fsync`. Untuk satu baris yang memuat file
 *     seukuran 35 MB, itu berarti menulis ~35 MB journal + ~35 MB tabel untuk
 *     SETIAP potongan `writeChunk()` — 2× ukuran file, berulang. Terukur di
 *     lapangan: copy 70 MB = 12m44s (~40 GB I/O untuk data 70 MB).
 *   - WAL hanya menulis halaman BARU dan `fsync` terjadi saat checkpoint, bukan
 *     tiap commit → commit jadi milidetik dan data lama tidak ditulis ulang.
 *   - Pembaca tidak lagi memblokir penulis (dan sebaliknya). Ini penting karena
 *     kernel bisa membaca VFS sementara proses/daemon lain menulis.
 *   - Recovery setelah crash bersifat otomatis dan transaksional; jauh lebih tahan
 *     mati listrik daripada rollback journal.
 *
 * `synchronous = NORMAL` — rekomendasi SQLite untuk mode WAL: struktur database
 * TIDAK BISA korup (selalu konsisten setelah recovery); yang berisiko hanya
 * transaksi terakhir yang belum ter-checkpoint bila OS/mesin mati. `FULL` memaksa
 * fsync tiap commit (satu fsync per file saat bootstrap) — tersedia lewat opsi
 * `synchronous` di konstruktor kalau memang dibutuhkan.
 *
 * `foreign_keys = ON` — skema sudah mendeklarasikan `FOREIGN KEY(parent_id)`,
 * tetapi SQLite TIDAK menegakkannya tanpa pragma ini (dan pragma-nya per-koneksi,
 * jadi harus dipasang tiap open). Dengan FK aktif, baris yatim ditolak dan tabel
 * `blocks` ikut terhapus lewat `ON DELETE CASCADE`.
 *
 * `busy_timeout` — jangan gagal dengan `SQLITE_BUSY` hanya karena proses lain
 * sedang menulis; tunggu, baru menyerah.
 */
export const BKFS_BUSY_TIMEOUT_MS = 5000;
/** Page cache SQLite (KiB, nilai negatif = KiB seperti konvensi SQLite). */
const BKFS_CACHE_KIB = 8192;
/** Plafon mmap baca (byte). Nilai konservatif supaya aman di node kecil. */
const BKFS_MMAP_BYTES = 64 * 1024 * 1024;

/**
 * Isi file ≤ batas ini disimpan INLINE di kolom `content` (satu baris).
 *
 * Mayoritas besar file sistem (skrip `/bin`, `/lib`, config `/etc`) ada di bawah
 * ambang ini, dan untuk mereka satu baris = satu baca = jalur tercepat (juga yang
 * dipakai `Kernel.rebuildVFSCache()` saat pre-compile `/lib`).
 */
export const BKFS_INLINE_MAX_BYTES = 64 * 1024;

/**
 * Ukuran satu blok pada tabel `blocks` (byte) untuk file besar.
 *
 * Dipilih 128 KiB supaya satu potongan tulis NetFS (124 KiB) jatuh dalam SATU
 * blok, sehingga append berurutan = satu INSERT kecil (O(1)), bukan penulisan
 * ulang seluruh isi file (O(n)).
 */
export const BKFS_BLOCK_BYTES = 128 * 1024;

/** Opsi teknis BKFS (semua opsional — default sudah aman untuk produksi). */
export interface BKFSOptions {
    /**
     * Mode durability SQLite. Default `NORMAL` (aman dari korupsi, commit cepat).
     * Naikkan ke `FULL` kalau node harus tahan mati listrik di detik terakhir.
     */
    synchronous?: "NORMAL" | "FULL";
    /** Ambang penyimpanan inline (byte). Default `BKFS_INLINE_MAX_BYTES`. */
    inlineMaxBytes?: number;
    /** Ukuran blok tabel `blocks` (byte). Default `BKFS_BLOCK_BYTES`. */
    blockBytes?: number;
}

/**
 * encodeContent(): String internal TSIX → nilai kolom `content`.
 *
 * Konvensi TSIX adalah latin1 (1 char = 1 byte). `Buffer.from(str, "latin1")`
 * memetakan kode karakter 0x00-0xFF langsung ke byte — jadi byte NUL dan byte
 * ≥ 0x80 tersimpan APA ADANYA. Ini yang membuat `substr()`/`length()` SQLite
 * aman untuk berkas biner (pada TEXT, byte NUL memotong string dan byte ≥ 0x80
 * menggelembung jadi 2 byte UTF-8).
 */
export function encodeContent(content: string | null | undefined): Buffer {
    return Buffer.from(content ?? "", "latin1");
}

/**
 * decodeContent(): Nilai kolom → string internal TSIX.
 *
 * Menerima DUA bentuk sekaligus, sengaja: baris baru disimpan sebagai BLOB,
 * sedangkan database lama berisi TEXT. SQLite menyimpan tipe per-NILAI (bukan
 * per-kolom), jadi konversi menyeluruh tidak wajib — baris lama tetap benar dan
 * otomatis ter-upgrade saat ditulis ulang. Ini yang membuat migrasi A3 tidak
 * berisiko: tidak ada pass “ubah semua isi” yang bisa gagal di tengah.
 */
export function decodeContent(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value; // baris warisan (TEXT)
    if (Buffer.isBuffer(value)) return value.toString("latin1");
    if (value instanceof Uint8Array) return Buffer.from(value).toString("latin1");
    return String(value);
}

/**
 * readVnodeContent(): Baca isi sebuah vnode lewat koneksi SQLite MENTAH.
 *
 * Untuk skrip di luar kelas BKFS (mis. `scripts/vfs-pull.ts`) yang membuka
 * database sendiri. Tanpa helper ini, isi file besar akan terbaca KOSONG, karena
 * file besar tidak disimpan di kolom `content` melainkan di tabel `blocks` —
 * penggabungannya harus lewat satu aturan, dan aturan itu hidup di sini.
 */
export function readVnodeContent(db: Database.Database, nodeId: number): string {
    const row = db.prepare("SELECT content, IFNULL(size, 0) AS size FROM vnodes WHERE id = ?").get(nodeId) as
        | { content: unknown; size: number }
        | undefined;
    if (!row) return "";

    if (row.content !== null && row.content !== undefined) return decodeContent(row.content) ?? "";
    if (row.size === 0) return "";

    let out = "";
    const rows = db
        .prepare("SELECT data FROM blocks WHERE vnode_id = ? ORDER BY seq")
        .iterate(nodeId) as Iterable<{ data: Buffer }>;
    for (const block of rows) out += decodeContent(block.data) ?? "";
    return out;
}

/**
 * BKFS (Bukan Kernel File System)
 *
 * VFS berbasis SQLite untuk penyimpanan persisten di User-land.
 * Ini mensimulasikan Disk Drive (seperti /dev/sda di Linux).
 */
export class BKFS implements IVFS {
    private db: Database.Database;
    private logger: Logger;
    private readOnly: boolean;
    private opts: Required<BKFSOptions>;
    /** Cache satu entri untuk `readChunk()` jalur WARISAN (TEXT) — lihat `readChunk()`. */
    private chunkCache: { path: string; content: string } | null = null;
    /** Sudah ditutup? Dipakai supaya `close()` aman dipanggil lebih dari sekali. */
    private closed = false;
    /** Path database — dipakai untuk log saat ditutup/checkpoint. */
    private dbPath: string;
    /**
     * Cache prepared statement per-koneksi.
     *
     * Sebelumnya setiap pemanggilan melakukan `this.db.prepare(sql)` dari awal:
     * navigasi path satu berkas berarti beberapa kali parse SQL (tiap segmen
     * direktori), dikalikan ribuan operasi saat bootstrap. Statement SQLite
     * bersifat reusable dan aman dipakai ulang selama skema tidak berubah.
     */
    private stmts = new Map<string, Database.Statement>();

    constructor(
        dbPath: string = "system.db",
        readOnly: boolean = false,
        uid?: number,
        gid?: number,
        mode?: number,
        opts: BKFSOptions = {},
    ) {
        this.logger = new Logger("BKFS");
        this.readOnly = readOnly;
        this.dbPath = dbPath;
        this.opts = {
            synchronous: opts.synchronous ?? "NORMAL",
            inlineMaxBytes: opts.inlineMaxBytes ?? BKFS_INLINE_MAX_BYTES,
            blockBytes: opts.blockBytes ?? BKFS_BLOCK_BYTES,
        };
        this.db = new Database(dbPath, { readonly: readOnly });

        this.applyPragmas();

        // Inisialisasi tabel jika belum ada
        this.initSchema();

        // FK dinyalakan SETELAH migrasi, sengaja: migrasi dedup di `initSchema()`
        // menghapus baris duplikat (yang bisa punya anak). Kalau FK sudah aktif saat
        // itu, migrasi gagal di database lama yang kotor — dan database lama yang kotor
        // justru yang paling butuh migrasi.
        this.db.pragma("foreign_keys = ON");

        // Bersihkan blok tidak sah (lihat `repairStorage()`). Idempoten dan murah —
        // dua COUNT + (bila perlu) dua DELETE pada tabel blok. Tanpa ini sampah tersebut
        // menumpuk tanpa gejala dan baru ketahuan saat ruang disk habis.
        this.repairStorage();

        // Override root ownership/permissions if specified
        if (uid !== undefined || gid !== undefined || mode !== undefined) {
            this.stmt("UPDATE vnodes SET uid = ?, gid = ?, mode = ? WHERE name = '/' AND parent_id IS NULL").run(
                uid ?? 0,
                gid ?? 0,
                mode ?? 0o755,
            );
        }

        const absPath = path.resolve(dbPath);
        this.logger.info(`VFS Database connected: ${absPath}`);
    }

    /**
     * applyPragmas(): Pasang PRAGMA koneksi (lihat `PRAGMAS` di atas untuk alasannya).
     *
     * `journal_mode` dibaca kembali dan dicatat: di filesystem yang tidak mendukung
     * WAL (mis. share jaringan), SQLite **diam-diam** mempertahankan mode lama. Untuk
     * operasional lebih baik tahu — kalau WAL gagal, performa tulis jatuh ke
     * perilaku lama dan itu terlihat di log, bukan jadi misteri.
     */
    private applyPragmas(): void {
        if (!this.readOnly) {
            const mode = this.db.pragma("journal_mode = WAL", { simple: true });
            this.db.pragma(`synchronous = ${this.opts.synchronous}`);
            if (String(mode).toLowerCase() !== "wal") {
                this.logger.warn(
                    `journal_mode tidak bisa WAL (dapat '${mode}') — tulis akan memakai rollback journal (lebih lambat). ` +
                        `Biasanya karena filesystem/direktori tidak mendukung.`,
                );
            }
        }
        // Berguna juga untuk koneksi read-only (menunggu penulis selesai, bukan gagal).
        this.db.pragma(`busy_timeout = ${BKFS_BUSY_TIMEOUT_MS}`);
        if (!this.readOnly) {
            this.db.pragma(`cache_size = -${BKFS_CACHE_KIB}`);
            this.db.pragma(`mmap_size = ${BKFS_MMAP_BYTES}`);
        }
    }

    /**
     * stmt(): Prepared statement dari cache (parse SQL sekali saja).
     *
     * Semua jalur baca/tulis ber-`path` melakukan navigasi beberapa segmen, jadi
     * tanpa cache ini satu operasi = beberapa kali parse SQL.
     */
    private stmt(sql: string): Database.Statement {
        let s = this.stmts.get(sql);
        if (!s) {
            s = this.db.prepare(sql);
            this.stmts.set(sql, s);
        }
        return s;
    }

    /**
     * batch(): Jalankan sekumpulan operasi dalam SATU transaksi atomik.
     *
     * KENAPA PENTING (kehandalan + kecepatan):
     *   - Atomik. Bootstrap image sistem = ribuan `touch()`. Tanpa transaksi, crash
     *     di tengah meninggalkan image SETENGAH jadi yang terlihat normal (sebagian
     *     `/bin` ada, sebagian tidak). Dengan satu transaksi, hasilnya "semua atau
     *     tidak sama sekali" — persis yang dibutuhkan operasional.
     *   - Kecepatan. Tanpa transaksi, tiap `touch()` = 1 transaksi = fsync. Ribuan
     *     fsync berubah jadi satu.
     *
     * Nesting aman: better-sqlite3 memakai SAVEPOINT untuk transaksi bersarang.
     */
    public batch<T>(fn: () => T): T {
        if (this.readOnly) throw new Error("Read-only filesystem");
        return this.db.transaction(fn)();
    }

    /**
     * checkpoint(): Pindahkan isi WAL ke file database utama.
     *
     * Dipakai setelah pekerjaan besar (bootstrap/install) supaya `system.db`
     * kembali self-contained: satu file yang bisa langsung disalin/di-backup tanpa
     * harus ikut membawa `-wal`/`-shm`.
     */
    public checkpoint(): void {
        if (this.readOnly || this.closed) return;
        try {
            // `simple: false` supaya baris hasilnya terbaca: wal_checkpoint()
            // mengembalikan [busy, log_pages, checkpointed_pages], dan `busy = 1`
            // berarti ADA KONEKSI LAIN yang menahan checkpoint.
            const result = this.db.pragma("wal_checkpoint(TRUNCATE)") as Array<Record<string, number>>;
            if (result?.[0]?.busy === 1) {
                this.logger.warn(
                    `checkpoint tertahan koneksi lain — ${this.dbPath} masih butuh file -wal saat disalin ` +
                        `(aman: SQLite memulihkannya otomatis saat dibuka lagi)`,
                );
            }
        } catch (e: any) {
            this.logger.warn(`checkpoint gagal: ${e.message}`);
        }
    }

    /**
     * checkIntegrity(): Periksa kesehatan file database.
     *
     * `quick = true` (default) memakai `quick_check` — melewati verifikasi index
     * yang mahal, cocok untuk pemeriksaan rutin. `quick = false` memakai
     * `integrity_check` penuh. Return `"ok"` kalau sehat, selain itu pesan masalah.
     */
    public checkIntegrity(quick: boolean = true): string {
        const rows = this.db.pragma(quick ? "quick_check" : "integrity_check") as Array<Record<string, string>>;
        const messages = (rows ?? []).map((r) => Object.values(r)[0]);
        if (messages.length === 0) return "ok";
        return messages.every((m) => m === "ok") ? "ok" : messages.join("; ");
    }

    /** compact(): VACUUM — ciutkan file setelah banyak penghapusan. */
    public compact(): void {
        if (this.readOnly) throw new Error("Read-only filesystem");
        this.db.exec("VACUUM");
        this.stmts.clear(); // VACUUM menulis ulang skema → statement lama dibuang
    }

    /**
     * close(): Checkpoint lalu tutup database.
     *
     * Idempotent — boleh dipanggil dua kali (mis. eksplisit saat shutdown, lalu
     * lagi dari hook `process.on("exit")`) tanpa melempar.
     *
     * Sebelumnya BKFS TIDAK PERNAH ditutup saat sistem dimatikan: file `-wal`/
     * `-shm` tertinggal dan `system.db` sendirian jadi TIDAK lengkap — menyalinnya
     * berarti kehilangan transaksi terakhir (kasus nyata: `system.db-wal` 749 KB
     * tertinggal setelah shutdown). Checkpoint di sini yang membuat image
     * "satu file" kembali, sesuai asumsi `bkfs -c`, `create-bkfs`, & backup manual.
     */
    public close(): void {
        if (this.closed) return;
        this.closed = true;

        this.checkpoint();
        this.stmts.clear();
        try {
            this.db.close();
            this.logger.info(`Database ditutup rapi: ${this.dbPath}`);
        } catch (e: any) {
            this.logger.warn(`close gagal: ${e.message}`);
        }
    }

    private initSchema() {
        // Tabel vnodes: menyimpan struktur folder dan file + Metadata Security
        //
        // `content` didokumentasikan sebagai BLOB sejak awal (wiki), tapi dulu praktiknya
        // TEXT — dan itulah akar dua bug nyata: (1) `SUBSTR()`/`length()` SQLite berhenti
        // di byte NUL untuk TEXT, (2) byte ≥ 0x80 disimpan UTF-8 (2 byte) sehingga aset
        // biner menggelembung ~2× di dalam DB. Afinitas BLOB tidak mengubah nilai yang
        // sudah ada (SQLite menyimpan tipe per-nilai), jadi baris lama tetap terbaca —
        // lihat `readContentValue()`.
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS vnodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                parent_id INTEGER,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                content BLOB,
                size INTEGER DEFAULT 0,
                uid INTEGER DEFAULT 0,    -- User ID (0 = root)
                gid INTEGER DEFAULT 0,    -- Group ID (0 = root)
                mode INTEGER DEFAULT 420, -- Permission (Decimal dari Octal: 644 = 420, 755 = 493)
                created_at INTEGER,
                modified_at INTEGER,
                FOREIGN KEY (parent_id) REFERENCES vnodes(id),
                UNIQUE(parent_id, name)
            );
        `);

        // Tabel blok untuk isi file BESAR (lihat `writeChunk()`).
        //
        // Menyimpan isi file panjang di SATU baris berarti setiap potongan tulis harus
        // menulis ulang seluruh baris (O(n) per potongan → O(n²) per file). Terukur: copy
        // 70 MB = 12m44s. Dengan blok, append = satu INSERT kecil (O(1)).
        //
        // WITHOUT ROWID menjadikan (vnode_id, seq) sebagai clustered index → membaca satu
        // file berurutan = range scan yang berurutan juga (ramah cache halaman).
        // ON DELETE CASCADE: hapus vnode → blok ikut hilang (tidak ada sampah yatim).
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS blocks (
                vnode_id INTEGER NOT NULL,
                seq INTEGER NOT NULL,
                data BLOB NOT NULL,
                PRIMARY KEY (vnode_id, seq),
                FOREIGN KEY (vnode_id) REFERENCES vnodes(id) ON DELETE CASCADE
            ) WITHOUT ROWID;
        `);

        // Hapus duplikasi jika ada (Migration Hack dari Lapis 10.2)
        try {
            this.db.exec(`
                DELETE FROM vnodes 
                WHERE id NOT IN (
                    SELECT MIN(id) 
                    FROM vnodes 
                    GROUP BY parent_id, name
                );
            `);
        } catch (e) {
            // Ignore if migration fails on fresh DB
        }

        // Migration: Tambahkan kolom jika belum ada (SQLite ALTER TABLE)
        try {
            this.db.exec("ALTER TABLE vnodes ADD COLUMN uid INTEGER DEFAULT 0");
        } catch (e) {}
        try {
            this.db.exec("ALTER TABLE vnodes ADD COLUMN gid INTEGER DEFAULT 0");
        } catch (e) {}
        try {
            this.db.exec("ALTER TABLE vnodes ADD COLUMN mode INTEGER DEFAULT 420");
        } catch (e) {}
        try {
            this.db.exec("ALTER TABLE vnodes ADD COLUMN modified_at INTEGER");
        } catch (e) {}
        try {
            this.db.exec("ALTER TABLE vnodes ADD COLUMN size INTEGER DEFAULT 0");
        } catch (e) {}

        // Masukkan root (/) jika belum ada (Mode 755 = 493)
        const root = this.db.prepare("SELECT id FROM vnodes WHERE name = '/' AND parent_id IS NULL").get();
        if (!root) {
            this.db
                .prepare(
                    "INSERT INTO vnodes (name, type, uid, gid, mode, created_at) VALUES ('/', 'DIRECTORY', 0, 0, 493, ?)",
                )
                .run(Date.now());
            this.logger.debug("Root (/) created in BKFS with root permissions.");
        }
    }

    /**
     * mkdir(): Membuat direktori di database.
     */
    public mkdir(path: string, uid: number = 0, gid: number = 0, mode: number = 493): boolean {
        if (this.readOnly) throw new Error("Read-only filesystem");
        const parts = path.split("/").filter((p) => p.length > 0 && p !== "." && p !== "..");
        let parentId = this.getRootId();

        for (const part of parts) {
            let node = this.db.prepare("SELECT id FROM vnodes WHERE name = ? AND parent_id = ?").get(part, parentId) as
                | { id: number }
                | undefined;

            if (!node) {
                const now = Date.now();
                const result = this.db
                    .prepare(
                        "INSERT INTO vnodes (parent_id, name, type, uid, gid, mode, created_at, modified_at) VALUES (?, ?, 'DIRECTORY', ?, ?, ?, ?, ?)",
                    )
                    .run(parentId, part, uid, gid, mode, now, now);
                parentId = result.lastInsertRowid as number;
                this.logger.debug(`Directory created in BKFS: ${part} (Mode: ${mode.toString(8)})`);
            } else {
                parentId = node.id;
            }
        }
        return true;
    }

    /**
     * touch(): Membuat / mengganti isi file.
     *
     * Penyimpanan dipilih otomatis:
     *   - isi ≤ `inlineMaxBytes` → satu baris `content` (jalur tercepat, dan bentuk
     *     yang paling sering dibaca kernel saat pre-compile `/lib`);
     *   - isi lebih besar → dipecah ke tabel `blocks` (lihat `writeBlocks()`).
     *
     * `uid`/`gid`/`mode` dihormati saat berkas BARU dibuat — sama seperti `touch`
     * Unix: berkas yang sudah ada hanya isinya yang diganti, izinnya milik
     * pemiliknya (`chmod` terpisah).
     *
     * KENAPA PENTING (bug nyata): `install.ts` memasang `/etc/rc.local` (0o755) dan
     * `/etc/shadow` (0o640) lewat `touch()`. Dulu `resolveForWrite()` memanggil
     * `createEmptyFile()` TANPA argumen, jadi SEMUA berkas baru selalu 0o644 —
     * akibatnya init melewati rc.local ("belum executable", boot tanpa daemon tapi
     * terlihat normal) dan `/etc/shadow` jadi 0o644 (bukan 0o640).
     *
     * Perubahan besar→kecil WAJIB membuang blok lama, kalau tidak isi lama akan
     * “menyembul” kembali saat dibaca. Karena itu pembuangan + penulisan + update
     * baris dijalankan dalam SATU transaksi (atomik: tidak ada state setengah jadi
     * kalau proses mati di tengah).
     */
    public touch(path: string, content: string = "", uid: number = 0, gid: number = 0, mode: number = 420): boolean {
        if (this.readOnly) throw new Error("Read-only filesystem");

        const nodeId = this.resolveForWrite(path, uid, gid, mode);
        if (nodeId < 0) return false;

        this.forgetChunkCache();
        const text = content ?? "";
        const now = Date.now();
        this.warnIfTextNotEncoded(path, text);

        return this.batch(() => {
            if (text.length <= this.opts.inlineMaxBytes) {
                this.writeInline(nodeId, text, text.length, now);
            } else {
                this.writeToBlocks(nodeId, text, 0, text.length, now, true);
            }
            return true;
        });
    }

    /**
     * append(): Menambahkan isi ke ekor file.
     *
     * CONCAT DI SQLITI TIDAK DIPAKAI (`content || ?`): pada operand BLOB, hasil
     * `||` bisa dipaksakan menjadi TEXT — dan begitu jadi TEXT, byte NUL kembali
     * memotong data (bug lama). Penggabungan dilakukan di JS/Buffer, yang tipenya
     * eksplisit dan NUL-safe.
     */
    public append(path: string, content: string): boolean {
        if (this.readOnly) throw new Error("Read-only filesystem");

        const nodeId = this.resolveForWrite(path);
        if (nodeId < 0) return false;

        const text = content ?? "";
        if (text.length === 0) return true;

        const size = this.sizeOf(nodeId);
        if (size < 0) return false;

        this.forgetChunkCache();

        // Masih inline dan hasilnya tetap muat → baca-gabung-tulis (isi ≤ 64 KiB,
        // jadi biayanya kecil dan tidak perlu menyentuh tabel blok).
        //
        // `blockCount() === 0` adalah syarat WAJIB, bukan sekadar optimasi: kalau baris
        // ini punya blok sisa (keadaan campuran — lihat `writeInline()`), maka isi file
        // yang sebenarnya ada di blok, dan menggabung ke `content` akan menulis di atas
        // data yang tidak dibaca siapa pun. Lebih baik lewat jalur potongan, yang
        // memindahkan isi ke blok secara benar.
        const inlineText = this.inlineContent(nodeId);
        if (
            inlineText !== null &&
            this.blockCount(nodeId) === 0 &&
            inlineText.length + text.length <= this.opts.inlineMaxBytes
        ) {
            const merged = inlineText + text;
            return this.batch(() => {
                this.writeInline(nodeId, merged, merged.length, Date.now());
                return true;
            });
        }

        // Sudah besar / akan besar → pakai jalur blok (O(1) per potongan).
        return this.writeChunk(path, text, size);
    }

    /**
     * resolveForWrite(): Ambil node id untuk operasi tulis, buat file bila belum ada.
     *
     * `uid`/`gid`/`mode` diteruskan ke `createEmptyFile()` (berkas BARU saja);
     * berkas yang sudah ada mengembalikan id-nya tanpa menyentuh izin — semantik
     * `touch` Unix (lihat catatan di `touch()`).
     *
     * Return -1 kalau direktori induk tidak ada (pemanggil mengembalikan `false`,
     * konsisten dengan perilaku lama: `touch()` tidak membuat folder induk).
     */
    private resolveForWrite(path: string, uid: number = 0, gid: number = 0, mode: number = 420): number {
        const existing = this.getNodeId(path);
        if (existing >= 0) return existing;
        return this.createEmptyFile(path, uid, gid, mode) ? this.getNodeId(path) : -1;
    }

    /** createEmptyFile(): INSERT baris file kosong (jalur `touch` pada path baru). */
    private createEmptyFile(path: string, uid: number = 0, gid: number = 0, mode: number = 420): boolean {
        const parts = path.split("/").filter((p) => p.length > 0 && p !== "." && p !== "..");
        const fileName = parts.pop();
        if (!fileName) return false;

        let parentId = this.getRootId();
        for (const part of parts) {
            const node = this.stmt("SELECT id FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'DIRECTORY'").get(
                part,
                parentId,
            ) as { id: number } | undefined;
            if (!node) return false;
            parentId = node.id;
        }

        const now = Date.now();
        this.stmt(
            "INSERT INTO vnodes (parent_id, name, type, content, size, uid, gid, mode, created_at, modified_at) VALUES (?, ?, 'FILE', ?, 0, ?, ?, ?, ?, ?)",
        ).run(parentId, fileName, encodeContent(""), uid, gid, mode, now, now);
        return true;
    }

    /**
     * stat(): Mengambil metadata file/folder.
     *
     * TIDAK membaca `content` (lihat `VNODE_META_COLUMNS`): pemanggil stat hanya
     * butuh ukuran/mode/uid, dan konten tersedia lewat `read()`/`readChunk()`.
     */
    public stat(path: string) {
        const parts = path.split("/").filter((p) => p.length > 0 && p !== "." && p !== "..");
        let parentId = this.getRootId();

        if (path === "/") {
            return this.db.prepare(`SELECT ${VNODE_META_COLUMNS} FROM vnodes WHERE id = ?`).get(parentId) as any;
        }

        const targetName = parts.pop();
        if (!targetName) return null; // Should not happen if path is not "/" and parts is not empty

        for (const part of parts) {
            let node = this.db
                .prepare("SELECT id FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'DIRECTORY'")
                .get(part, parentId) as { id: number } | undefined;
            if (!node) return null;
            parentId = node.id;
        }

        return this.db
            .prepare(`SELECT ${VNODE_META_COLUMNS} FROM vnodes WHERE name = ? AND parent_id = ?`)
            .get(targetName, parentId) as any;
    }

    /**
     * chmod(): Mengubah permission file/folder.
     */
    public chmod(path: string, mode: number): boolean {
        if (this.readOnly) throw new Error("Read-only filesystem");
        const node = this.stat(path);
        if (!node) return false;

        this.db.prepare("UPDATE vnodes SET mode = ? WHERE id = ?").run(mode, node.id);
        return true;
    }

    /**
     * chown(): Mengubah pemilik file/folder.
     */
    public chown(path: string, uid: number, gid: number): boolean {
        if (this.readOnly) throw new Error("Read-only filesystem");
        const node = this.stat(path);
        if (!node) return false;

        this.db.prepare("UPDATE vnodes SET uid = ?, gid = ? WHERE id = ?").run(uid, gid, node.id);
        return true;
    }

    /**
     * ls(): List isi folder dari database.
     */
    public ls(path: string = "/"): any[] {
        let parentId = this.getRootId();

        if (path !== "/") {
            const parts = path.split("/").filter((p) => p.length > 0 && p !== "." && p !== "..");
            for (const part of parts) {
                let node = this.db
                    .prepare("SELECT id FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'DIRECTORY'")
                    .get(part, parentId) as { id: number } | undefined;
                if (!node) return [];
                parentId = node.id;
            }
        }

        // Menggunakan GROUP BY name untuk mencegah duplikasi jika database "kotor"
        // Tambahkan filter untuk '.' dan '..' agar tidak terjadi infinite recursion di aplikasi userland
        const rows = this.db
            .prepare(
                "SELECT name, type, mode, uid, gid, modified_at, size FROM vnodes WHERE parent_id = ? AND name != '' AND name != '.' AND name != '..' GROUP BY name",
            )
            .all(parentId) as any[];
        return rows as any[];
    }

    /**
     * exists(): Cek apakah path ada di database dengan tipe tertentu.
     */
    public exists(path: string, type?: VNodeType): boolean {
        const parts = path.split("/").filter((p) => p.length > 0 && p !== "." && p !== "..");
        let parentId = this.getRootId();

        if (path === "/") return true;

        const targetName = parts.pop();
        if (!targetName) return true; // root case already handled

        for (const part of parts) {
            let node = this.db
                .prepare("SELECT id FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'DIRECTORY'")
                .get(part, parentId) as { id: number } | undefined;
            if (!node) return false;
            parentId = node.id;
        }

        let query = "SELECT id FROM vnodes WHERE name = ? AND parent_id = ?";
        let params: any[] = [targetName, parentId];
        if (type) {
            query += " AND type = ?";
            params.push(type);
        }

        const result = this.db.prepare(query).get(...params);
        return !!result;
    }

    /**
     * read(): Membaca SELURUH isi file.
     *
     * Isi bisa berada di dua tempat: kolom `content` (file kecil) atau tabel `blocks`
     * (file besar). Untuk file besar, pemanggil sebaiknya memakai `readChunk()` —
     * kontrak `IVFS.read()` mengembalikan SATU string, jadi file 70 MB berarti string
     * ~140 MB di heap (di UTF-16). NetFS sudah menghindari itu lewat `readChunk`.
     */
    public read(path: string): string | null {
        const nodeId = this.getNodeId(path);
        if (nodeId < 0) return null;

        const inline = this.inlineContent(nodeId);
        if (inline !== null) return inline;

        if (this.blockCount(nodeId) === 0) {
            // Baris ada, tanpa isi & tanpa blok: file kosong → ""; bukan file → null.
            return this.sizeOf(nodeId) === 0 ? "" : null;
        }

        // Dirakit sebagai string (bukan `Buffer.concat` seluruh file) supaya tidak ada
        // salinan Buffer tambahan seukuran file yang menumpuk di heap.
        let out = "";
        const rows = this.stmt("SELECT data FROM blocks WHERE vnode_id = ? ORDER BY seq").iterate(nodeId) as Iterable<{
            data: Buffer;
        }>;
        for (const row of rows) out += decodeContent(row.data) ?? "";
        return out;
    }

    /**
     * unlink(): Menghapus file beserta blok-bloknya.
     *
     * Blok dibuang EKSPLISIT, bukan hanya mengandalkan `ON DELETE CASCADE`: CASCADE
     * hanya aktif kalau `PRAGMA foreign_keys=ON`, dan database lama bisa dibuka oleh
     * proses yang belum menyetelnya. Blok yatim = ruang disk bocor tanpa gejala.
     * Keduanya dijalankan dalam satu transaksi supaya tidak ada keadaan setengah hapus.
     */
    public unlink(path: string): boolean {
        if (this.readOnly) throw new Error("Read-only filesystem");
        const parts = path.split("/").filter((p) => p.length > 0);
        const fileName = parts.pop();
        if (!fileName) return false;

        let parentId = this.getRootId();
        for (const part of parts) {
            const node = this.stmt("SELECT id FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'DIRECTORY'").get(
                part,
                parentId,
            ) as { id: number } | undefined;
            if (!node) return false;
            parentId = node.id;
        }

        const target = this.stmt("SELECT id FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'FILE'").get(
            fileName,
            parentId,
        ) as { id: number } | undefined;
        if (!target) return false;

        this.forgetChunkCache();
        return this.batch(() => {
            this.clearBlocks(target.id);
            const result = this.stmt("DELETE FROM vnodes WHERE id = ?").run(target.id);
            return result.changes > 0;
        });
    }

    /**
     * rmdir(): Menghapus direktori kosong dari database.
     */
    public rmdir(path: string): boolean {
        if (this.readOnly) throw new Error("Read-only filesystem");
        this.forgetChunkCache();
        const parts = path.split("/").filter((p) => p.length > 0);
        const dirName = parts.pop();
        if (!dirName) return false;

        let parentId = this.getRootId();
        for (const part of parts) {
            let node = this.db
                .prepare("SELECT id FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'DIRECTORY'")
                .get(part, parentId) as { id: number } | undefined;
            if (!node) return false;
            parentId = node.id;
        }

        // Ambil ID direktori target
        const targetNode = this.db
            .prepare("SELECT id FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'DIRECTORY'")
            .get(dirName, parentId) as { id: number } | undefined;

        if (!targetNode) return false;

        // Cek apakah kosong
        const childrenCount = this.db
            .prepare("SELECT COUNT(*) as count FROM vnodes WHERE parent_id = ?")
            .get(targetNode.id) as { count: number };

        if (childrenCount.count > 0) return false; // Directory not empty

        const result = this.db.prepare("DELETE FROM vnodes WHERE id = ?").run(targetNode.id);
        return result.changes > 0;
    }

    private getRootId(): number {
        const root = this.db.prepare("SELECT id FROM vnodes WHERE name = '/' AND parent_id IS NULL").get() as {
            id: number;
        };
        return root.id;
    }

    // ==================== CHUNKED I/O & PENYIMPANAN BLOK ====================

    /** sizeOf(): Ukuran file dari kolom `size` (tanpa menyentuh isi). -1 kalau bukan file. */
    private sizeOf(nodeId: number): number {
        const row = this.stmt("SELECT IFNULL(size, 0) AS sz FROM vnodes WHERE id = ? AND type = 'FILE'").get(nodeId) as
            | { sz: number }
            | undefined;
        return row ? row.sz : -1;
    }

    /** inlineContent(): Isi dari kolom `content`. `null` = isi ada di tabel blok (atau kosong). */
    private inlineContent(nodeId: number): string | null {
        const row = this.stmt("SELECT content FROM vnodes WHERE id = ?").get(nodeId) as
            | { content: unknown }
            | undefined;
        if (!row) return null;
        return decodeContent(row.content);
    }

    /** blockCount(): Jumlah blok milik vnode (0 = tidak memakai tabel blok). */
    private blockCount(nodeId: number): number {
        const row = this.stmt("SELECT COUNT(*) AS c FROM blocks WHERE vnode_id = ?").get(nodeId) as {
            c: number;
        };
        return row?.c ?? 0;
    }

    /** clearBlocks(): Buang semua blok milik vnode (dipakai saat tulis-ulang / hapus). */
    private clearBlocks(nodeId: number): void {
        this.stmt("DELETE FROM blocks WHERE vnode_id = ?").run(nodeId);
    }

    /**
     * writeInline(): SATU-SATUNYA jalur yang boleh menulis kolom `content`.
     *
     * ATURAN PENYIMPANAN BKFS: "content ATAU blok, tidak pernah keduanya".
     *
     * Sebelum ini aturan itu hanya diingat oleh pemanggil (`clearBlocks()` dipanggil
     * manual di setiap jalur tulis) — dan satu jalur yang lupa sudah cukup untuk
     * merusak baris secara DIAM-DIAM. Kasus nyata yang ditemukan di database asli
     * (`/var/log/syslog`, vnode 493): `content` 17 KB *dan* blok sisa 2,6 MB. Karena
     * `read()` membaca `content`, isinya tidak salah — tapi 260 KB blok menjadi sampah
     * tak terlihat yang tidak pernah dibaca maupun dibuang. Lebih buruk lagi: kalau
     * `content` di-NULL-kan (mis. saat promosi ke blok), isi LAMA akan "menyembul"
     * kembali.
     *
     * Karena itu pembuangan blok sekarang MENEMPEL pada penulisan inline: mustahil
     * menulis `content` tanpa membuang blok, dari jalur mana pun (termasuk skrip host
     * yang memakai class ini).
     */
    private writeInline(nodeId: number, text: string, size: number, now: number): void {
        this.clearBlocks(nodeId);
        this.stmt("UPDATE vnodes SET content = ?, size = ?, modified_at = ? WHERE id = ?").run(
            encodeContent(text),
            size,
            now,
            nodeId,
        );
    }

    /**
     * writeToBlocks(): Jalur tulis untuk isi besar.
     *
     * `content` dipastikan NULL lebih dulu — kalau tidak ada DUA sumber kebenaran
     * (lihat `writeInline()`). `reset=true` untuk tulis-ulang penuh (`touch()`);
     * `reset=false` untuk potongan (`writeChunk()`), di mana blok lain dipertahankan.
     */
    private writeToBlocks(nodeId: number, text: string, offset: number, size: number, now: number, reset: boolean): void {
        if (reset) this.clearBlocks(nodeId);
        this.stmt("UPDATE vnodes SET content = NULL WHERE id = ?").run(nodeId);
        this.writeBlocks(nodeId, text, offset);
        this.stmt("UPDATE vnodes SET size = ?, modified_at = ? WHERE id = ?").run(size, now, nodeId);
    }

    /**
     * writeBlocks(): Tulis `text` ke tabel blok mulai posisi `offset`.
     *
     * INI INTI PERBAIKAN O(n²). Dulu seluruh isi file hidup di satu baris, jadi
     * setiap potongan tulis memaksa SQLite menulis ulang seluruh baris + menyalin
     * halaman lamanya ke journal (2× ukuran file, per potongan). Sekarang biaya satu
     * potongan sebanding dengan UKURAN POTONGAN, bukan ukuran file.
     *
     * Blok yang sejajar & penuh ditulis dengan satu `INSERT OR REPLACE`. Potongan
     * yang tidak sejajar (mis. chunk NetFS 124 KiB dengan blok 128 KiB) hanya
     * menyentuh SATU blok: baca blok itu, splice, tulis kembali — tetap O(1).
     *
     * Pemanggil WAJIB sudah berada di dalam transaksi (`batch`) supaya tidak ada
     * blok setengah tertulis kalau proses mati di tengah.
     */
    private writeBlocks(nodeId: number, text: string, offset: number): void {
        const BLOCK = this.opts.blockBytes;
        const buf = encodeContent(text);
        const upsert = this.stmt("INSERT OR REPLACE INTO blocks (vnode_id, seq, data) VALUES (?, ?, ?)");
        let done = 0;

        while (done < buf.length) {
            const abs = offset + done;
            const seq = Math.floor(abs / BLOCK);
            const within = abs - seq * BLOCK;

            if (within === 0 && buf.length - done >= BLOCK) {
                // Jalur tercepat: append besar yang sejajar blok.
                upsert.run(nodeId, seq, buf.subarray(done, done + BLOCK));
                done += BLOCK;
                continue;
            }

            const take = Math.min(BLOCK - within, buf.length - done);
            const current =
                (
                    this.stmt("SELECT data FROM blocks WHERE vnode_id = ? AND seq = ?").get(nodeId, seq) as
                        | { data: Buffer }
                        | undefined
                )?.data ?? Buffer.alloc(0);
            const merged = Buffer.alloc(Math.max(current.length, within + take));
            current.copy(merged, 0);
            buf.copy(merged, within, done, done + take);
            upsert.run(nodeId, seq, merged);
            done += take;
        }
    }

    /**
     * readChunk(): Membaca potongan isi file — HANYA data yang diminta yang dibaca.
     *
     * Tiga jalur, sesuai bentuk penyimpanan:
     *   1. blok           → ambil blok yang menutupi rentang (1–2 baris), potong di JS;
     *   2. inline (BLOB)  → `substr()` di sisi SQL: SQLite membaca halaman yang perlu
     *                       saja, jadi kernel TIDAK menahan seluruh file di heap;
     *   3. inline (TEXT)  → baris WARISAN: `substr()` berhenti di byte NUL, jadi harus
     *                       baca penuh (di-cache satu entri) lalu `slice()`.
     */
    public readChunk(path: string, offset: number, length: number): string | null {
        const nodeId = this.getNodeId(path);
        if (nodeId < 0) return null;

        const size = this.sizeOf(nodeId);
        if (size < 0) return null;

        const start = offset < 0 ? 0 : offset;
        const len = length < 0 ? 0 : length;
        if (start >= size) return "";

        // Sumber isi ditentukan oleh kolom `content` — SAMA seperti `read()`. Memakai
        // jumlah blok saja akan salah pada baris campuran (blok sisa): `read()` membaca
        // `content`, `readChunk()` membaca blok, dan keduanya menjawab berbeda untuk
        // file yang sama.
        //
        // Jenis nilai diperiksa tanpa mengambil isinya: SQLite menyimpan tipe di header
        // record, jadi `typeof()` tidak mematerialisasi kolom.
        const kind = this.stmt("SELECT typeof(content) AS t FROM vnodes WHERE id = ?").get(nodeId) as
            | { t: string }
            | undefined;

        if ((!kind || kind.t === "null") && this.blockCount(nodeId) > 0) {
            return this.readChunkFromBlocks(nodeId, start, len, size);
        }

        if (kind?.t === "blob") {
            const row = this.stmt("SELECT substr(content, ?, ?) AS piece FROM vnodes WHERE id = ?").get(
                start + 1, // SQLite 1-indexed
                len,
                nodeId,
            ) as { piece: unknown } | undefined;
            return decodeContent(row?.piece) ?? "";
        }

        // Legacy TEXT → baca penuh (benar untuk byte NUL) + cache satu entri.
        const text =
            this.chunkCache && this.chunkCache.path === path
                ? this.chunkCache.content
                : (this.inlineContent(nodeId) ?? "");
        this.chunkCache = text.length <= BKFS_CHUNK_CACHE_MAX_BYTES ? { path, content: text } : null;
        return text.slice(start, start + len);
    }

    /**
     * readChunkFromBlocks(): Potong rentang dari tabel blok.
     *
     * Rentang dibatasi `size` (kolom `size` = sumber kebenaran, bukan panjang blok —
     * blok terakhir bisa lebih pendek, dan itu normal). Blok yang diambil hanya yang
     * beririsan dengan [start, end), jadi biaya baca sebanding panjang potongan.
     */
    private readChunkFromBlocks(nodeId: number, start: number, len: number, size: number): string {
        const BLOCK = this.opts.blockBytes;
        const end = Math.min(start + len, size);
        if (end <= start) return "";

        const firstSeq = Math.floor(start / BLOCK);
        const lastSeq = Math.ceil(end / BLOCK) - 1;

        const rows = this.stmt("SELECT data FROM blocks WHERE vnode_id = ? AND seq BETWEEN ? AND ? ORDER BY seq").all(
            nodeId,
            firstSeq,
            lastSeq,
        ) as Array<{ data: Buffer }>;

        const parts = rows.map((r) => (Buffer.isBuffer(r.data) ? r.data : Buffer.from(String(r.data), "latin1")));
        const joined = Buffer.concat(parts);
        const localStart = start - firstSeq * BLOCK;
        return joined.subarray(localStart, localStart + (end - start)).toString("latin1");
    }

    /** forgetChunkCache(): Dipanggil setiap operasi tulis — metadata & isi berubah. */
    private forgetChunkCache(): void {
        this.chunkCache = null;
    }

    /**
     * writeChunk(): Menulis satu potongan isi pada posisi tertentu.
     *
     * Bentuk penyimpanan dipilih otomatis:
     *   - hasil akhir masih ≤ `inlineMaxBytes` → splice di JS (isi kecil);
     *   - lebih besar → pindah ke tabel blok (sekali), lalu tulis potongan sebagai blok.
     *
     * Pemindahan inline → blok bersifat "sekali per file": setelahnya setiap potongan
     * hanya menyentuh blok yang bersangkutan. Untuk database lama yang isinya masih
     * satu baris besar (mis. file 70 MB hasil NetFS versi lama), pemindahan ini
     * membaca isi itu satu kali lalu memecahnya — biaya sekali, sesudahnya O(1) per
     * potongan.
     *
     * `offset > size` (menyisakan celah) tetap DITOLAK, seperti sebelumnya: jalur itu
     * dulu menghasilkan metadata yang berbohong (`size` besar, isi kosong). Gagal
     * jelas lebih baik daripada state setengah jadi.
     */
    public writeChunk(path: string, chunk: string, offset: number): boolean {
        if (this.readOnly) throw new Error("Read-only filesystem");

        const nodeId = this.resolveForWrite(path);
        if (nodeId < 0) return false;

        const currentSize = this.sizeOf(nodeId);
        if (currentSize < 0) return false;
        if (offset > currentSize) return false;

        const text = chunk ?? "";
        if (text.length === 0) return true;

        const newSize = Math.max(currentSize, offset + text.length);
        const now = Date.now();
        this.forgetChunkCache();

        return this.batch(() => {
            // Sumber kebenaran bentuk penyimpanan adalah KOLOM `content`, bukan jumlah
            // blok: `content` terisi = file inline; `content` NULL = file memakai blok.
            // (Menjumlahkan blok saja akan salah pada baris campuran — lihat `writeInline()`.)
            const inline = this.inlineContent(nodeId);

            if (inline !== null && newSize <= this.opts.inlineMaxBytes) {
                const merged = inline.slice(0, offset) + text + inline.slice(offset + text.length);
                this.writeInline(nodeId, merged, merged.length, now);
                return true;
            }

            if (inline !== null) {
                // Promosi inline → blok, sekali per file. Sisa blok (kalau ada) dibuang
                // lebih dulu supaya tidak ada blok lama yang ikut terbaca.
                this.clearBlocks(nodeId);
                this.stmt("UPDATE vnodes SET content = NULL WHERE id = ?").run(nodeId);
                if (inline.length > 0) this.writeBlocks(nodeId, inline, 0);
            }

            this.writeBlocks(nodeId, text, offset);
            this.stmt("UPDATE vnodes SET size = ?, modified_at = ? WHERE id = ?").run(newSize, now, nodeId);
            return true;
        });
    }

    /**
     * getSize(): Membaca langsung dari kolom `size` — tanpa fetch konten.
     */
    public getSize(path: string): number {
        const nodeId = this.getNodeId(path);
        return nodeId < 0 ? -1 : this.sizeOf(nodeId);
    }

    /**
     * storageKind(): Bentuk penyimpanan sebuah file.
     *
     * Dipakai diagnostik/operasional: "file mana yang sudah pindah ke tabel blok?"
     * Tanpa ini, satu-satunya cara tahu adalah membaca SQL mentah.
     */
    public storageKind(path: string): "inline" | "blocks" | "missing" {
        const nodeId = this.getNodeId(path);
        if (nodeId < 0) return "missing";
        // Urutan penting: `content` diperiksa lebih dulu karena itulah yang dibaca
        // `read()`. Dengan urutan lama (blok dulu), baris campuran dilaporkan "blocks"
        // padahal yang dibaca `content` — laporan yang menyembunyikan masalah.
        if (this.inlineContent(nodeId) !== null) return "inline";
        return this.blockCount(nodeId) > 0 ? "blocks" : "missing";
    }

    /** countBlocks(): Jumlah blok sebuah file (0 kalau inline atau tidak ada). */
    public countBlocks(path: string): number {
        const nodeId = this.getNodeId(path);
        return nodeId < 0 ? 0 : this.blockCount(nodeId);
    }

    /**
     * warnIfTextNotEncoded(): Peringatkan kalau pemanggil menulis **teks** tanpa
     * `utf8ToVfsBytes()` lebih dulu.
     *
     * Isi VFS adalah BYTE: encode yang dipakai adalah latin1, sehingga setiap karakter
     * > U+00FF DIPOTONG ke byte rendahnya (`✕` U+2715 → `0x15`, `─` U+2500 → `0x00`).
     * Berkasnya rusak **diam-diam** — tanpa galat, tanpa jejak, hanya isi yang salah.
     *
     * Kelas bug ini sudah dua kali terjadi (glyph UI & jalur simpan editor `atto`), dan
     * keduanya mahal untuk dilacak karena tidak ada petunjuk apa pun di log. Karena itu
     * penjagaan ini dipasang di jalur tulis SELURUH berkas (`touch()`), bukan di
     * `writeChunk()`: potongan besar datang dari NetFS/paket yang memang byte.
     *
     * Bit warna: pemanggil yang benar (sync, editor, paket) selalu mengirim byte — jadi
     * peringatan ini berarti ada jalur yang lupa, dan itu yang ingin kita lihat.
     */
    private warnIfTextNotEncoded(path: string, text: string): void {
        for (let i = 0; i < text.length; i++) {
            const c = text.charCodeAt(i);
            if (c > 0xff) {
                this.logger.warn(
                    `Tulis teks TANPA encode ke ${path}: U+${c.toString(16).toUpperCase()} ` +
                        `di posisi ${i} akan terpotong jadi byte 0x${(c & 0xff).toString(16).toUpperCase()} ` +
                        `(berkas rusak diam-diam). Gunakan utf8ToVfsBytes() dari src/common/VfsText.ts.`,
                );
                return;
            }
        }
    }

    /** countOf(): Jalankan query `SELECT COUNT(*) AS n ...` tanpa parameter. */
    private countOf(sql: string): number {
        const row = this.stmt(sql).get() as { n: number } | undefined;
        return row ? row.n : 0;
    }

    /**
     * storageHealth(): Laporan kesehatan penyimpanan (untuk diagnostik/operasional).
     *
     * Kenapa perlu: `quick_check` SQLite hanya memeriksa integritas HALAMAN. Bentuk
     * penyimpanan yang tidak konsisten (content + blok, blok yatim, blok bolong) tetap
     * dilaporkan "ok" — padahal itu kehilangan ruang dan sumber bug di masa depan.
     */
    public storageHealth(): {
        inlineFiles: number;
        blockFiles: number;
        legacyTextFiles: number;
        legacyNulFiles: number;
        orphanBlocks: number;
        staleBlocks: number;
        holeyFiles: number;
        sizeMismatch: number;
        emptyWithoutBlocks: number;
    } {
        return {
            inlineFiles: this.countOf("SELECT COUNT(*) AS n FROM vnodes WHERE type = 'FILE' AND content IS NOT NULL"),
            blockFiles: this.countOf("SELECT COUNT(DISTINCT vnode_id) AS n FROM blocks"),
            // Baris WARISAN: isi disimpan sebagai TEXT (bukan BLOB). Binernya di-encode
            // UTF-8 → byte ≥ 0x80 memakai 2 byte, jadi aset biner ~2× lebih besar.
            legacyTextFiles: this.countOf(
                "SELECT COUNT(*) AS n FROM vnodes WHERE type = 'FILE' AND typeof(content) = 'text'",
            ),
            // TEXT yang panjang `size`-nya MELEBIHI `length()` berarti isinya punya byte
            // NUL: SQLite `length()` pada TEXT berhenti di NUL pertama (makanya PNG 180 KB
            // terbaca "8 karakter"). Hanya bisa dipastikan benar setelah ditulis ulang
            // sebagai BLOB.
            legacyNulFiles: this.countOf(
                "SELECT COUNT(*) AS n FROM vnodes WHERE type = 'FILE' AND typeof(content) = 'text' AND IFNULL(size, 0) > length(content)",
            ),
            orphanBlocks: this.countOf(
                "SELECT COUNT(*) AS n FROM blocks WHERE vnode_id NOT IN (SELECT id FROM vnodes)",
            ),
            staleBlocks: this.countOf(
                "SELECT COUNT(*) AS n FROM blocks WHERE vnode_id IN (SELECT id FROM vnodes WHERE content IS NOT NULL)",
            ),
            holeyFiles: this.countOf(
                "SELECT COUNT(*) AS n FROM (SELECT vnode_id, COUNT(*) AS c, MAX(seq) + 1 AS m FROM blocks GROUP BY vnode_id HAVING c <> m)",
            ),
            // HANYA baris BLOB yang diperiksa: pada TEXT, `length()` berhenti di byte NUL
            // sehingga perbandingannya akan selalu salah untuk aset biner warisan dan
            // menghasilkan alarm palsu (147 "masalah" padahal cuma bentuk lama).
            sizeMismatch: this.countOf(
                "SELECT COUNT(*) AS n FROM vnodes WHERE type = 'FILE' AND typeof(content) = 'blob' AND length(content) <> IFNULL(size, 0)",
            ),
            emptyWithoutBlocks: this.countOf(
                "SELECT COUNT(*) AS n FROM vnodes WHERE type = 'FILE' AND content IS NULL AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocks.vnode_id = vnodes.id)",
            ),
        };
    }

    /**
     * repairStorage(): Buang blok yang tidak sah, lalu laporkan apa yang dibuang.
     *
     * Dua bentuk blok tidak sah:
     *   1. YATIM — vnode-nya sudah tidak ada. Terjadi kalau ada yang menghapus baris
     *      `vnodes` tanpa FK aktif sehingga CASCADE tidak jalan — termasuk migrasi dedup
     *      di `initSchema()`, yang memang sengaja berjalan SEBELUM `foreign_keys = ON`.
     *   2. BASI — barisnya PUNYA `content`, jadi isi file ada di `content` dan bloknya
     *      sisa dari bentuk sebelumnya. Kasus nyata: `/var/log/syslog` (vnode 493) di
     *      database asli: `content` 17 KB + blok sisa 2,6 MB.
     *
     * Dijalankan otomatis setiap database dibuka: sampah seperti ini tidak menghasilkan
     * galat apa pun — hanya ruang terbuang dan potensi "isi hantu" muncul kembali kalau
     * `content` di-NULL-kan — jadi tidak ada cara menemukannya tanpa memeriksa.
     *
     * AMAN terhadap data: yang dibuang hanya blok yang memang TIDAK dibaca siapa pun,
     * karena `read()` membaca `content` bila `content` tidak NULL.
     */
    public repairStorage(): { orphan: number; stale: number } {
        if (this.readOnly) return { orphan: 0, stale: 0 };

        const orphan = this.countOf("SELECT COUNT(*) AS n FROM blocks WHERE vnode_id NOT IN (SELECT id FROM vnodes)");
        const stale = this.countOf(
            "SELECT COUNT(*) AS n FROM blocks WHERE vnode_id IN (SELECT id FROM vnodes WHERE content IS NOT NULL)",
        );
        if (orphan === 0 && stale === 0) return { orphan: 0, stale: 0 };

        this.batch(() => {
            this.stmt("DELETE FROM blocks WHERE vnode_id NOT IN (SELECT id FROM vnodes)").run();
            this.stmt("DELETE FROM blocks WHERE vnode_id IN (SELECT id FROM vnodes WHERE content IS NOT NULL)").run();
        });
        this.logger.warn(
            `Blok tidak sah dibersihkan: ${orphan} yatim + ${stale} basi. ` +
                `Isi file (kolom content) tidak disentuh — hanya sampah yang dibuang.`,
        );
        return { orphan, stale };
    }

    /**
     * getNodeId(): Navigasi path ke node ID tanpa membaca konten.
     */
    private getNodeId(path: string): number {
        const parts = path.split("/").filter((p) => p.length > 0 && p !== "." && p !== "..");
        let parentId = this.getRootId();

        if (path === "/") return parentId;

        const targetName = parts.pop();
        if (!targetName) return parentId;

        for (const part of parts) {
            const node = this.stmt("SELECT id FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'DIRECTORY'").get(
                part,
                parentId,
            ) as { id: number } | undefined;
            if (!node) return -1;
            parentId = node.id;
        }

        const target = this.stmt("SELECT id FROM vnodes WHERE name = ? AND parent_id = ?").get(targetName, parentId) as
            | { id: number }
            | undefined;

        return target ? target.id : -1;
    }

    public async getUsage(): Promise<{
        size: number;
        files: number;
        dirs: number;
        diskSize?: number;
    }> {
        // Ukuran total dibaca dari kolom `size`, BUKAN `length(content)`.
        //
        // `SUM(length(content))` berarti membaca isi SETIAP file di disk — pada DB
        // dengan satu file 70 MB itu memaksa SQLite memuat 70 MB ekstra hanya untuk
        // `df`, dan pada node SH yang heapnya kecil langsung OOM. Kolom `size`
        // dipelihara oleh semua jalur tulis (`touch`/`append`/`writeChunk`), jadi
        // hasilnya sama — sekaligus kini KONSISTEN dengan yang dilaporkan
        // `stat`/`ls -l` (dulu bisa beda pada karakter non-BMP, karena SQLite
        // `length()` menghitung code point sedangkan kolom `size` code unit UTF-16).
        const stats = this.db
            .prepare(
                `
            SELECT 
                SUM(CASE WHEN type = 'FILE' THEN IFNULL(size, 0) ELSE 0 END) as total_size,
                SUM(CASE WHEN type = 'FILE' THEN 1 ELSE 0 END) as file_count,
                SUM(CASE WHEN type = 'DIRECTORY' THEN 1 ELSE 0 END) as dir_count
            FROM vnodes
            WHERE name != '/'
        `,
            )
            .get() as { total_size: number; file_count: number; dir_count: number };

        return {
            size: stats.total_size || 0,
            files: stats.file_count || 0,
            dirs: stats.dir_count || 0,
        };
    }
}
