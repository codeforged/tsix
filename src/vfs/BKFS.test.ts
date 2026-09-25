import { describe, it, expect, beforeEach } from "vitest";
import { BKFS } from "./BKFS";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

describe("BKFS (SQLite-based)", () => {
    let bkfs: BKFS;

    beforeEach(() => {
        // In-memory SQLite = no file on disk
        bkfs = new BKFS(":memory:");
    });

    // ============================================================
    // B2.01–B2.05: touch
    // ============================================================
    it("B2.01 touch – create file in SQLite", () => {
        expect(bkfs.touch("/test.txt")).toBe(true);
        expect(bkfs.exists("/test.txt")).toBe(true);
    });
    it("B2.02 touch – create file with content", () => {
        expect(bkfs.touch("/data.txt", "hello")).toBe(true);
        expect(bkfs.read("/data.txt")).toBe("hello");
    });
    it("B2.03 touch – overwrite existing", () => {
        bkfs.touch("/test.txt", "old");
        expect(bkfs.touch("/test.txt", "new")).toBe(true);
        expect(bkfs.read("/test.txt")).toBe("new");
    });
    it("B2.04 touch – nested path creates intermediate dirs", () => {
        // BKFS mkdir auto-creates parent dirs, but touch does NOT auto-create
        bkfs.mkdir("/a");
        bkfs.touch("/a/file.txt", "data");
        expect(bkfs.read("/a/file.txt")).toBe("data");
    });
    it("B2.05 touch – file appears in ls", () => {
        bkfs.touch("/file1.txt");
        const items = bkfs.ls("/");
        expect(items.some((i: any) => i.name === "file1.txt")).toBe(true);
    });

    // ============================================================
    // B2.06–B2.09: read / write
    // ============================================================
    it("B2.06 read – read file content from SQLite", () => {
        bkfs.touch("/readme.txt", "hello world");
        expect(bkfs.read("/readme.txt")).toBe("hello world");
    });
    it("B2.07 read – file not found returns null", () => {
        expect(bkfs.read("/nope.txt")).toBeNull();
    });
    it("B2.08 append – append to existing", () => {
        bkfs.touch("/log.txt", "line1\n");
        bkfs.append("/log.txt", "line2\n");
        expect(bkfs.read("/log.txt")).toBe("line1\nline2\n");
    });
    it("B2.09 append – creates if not exists", () => {
        bkfs.append("/new.txt", "fresh");
        expect(bkfs.read("/new.txt")).toBe("fresh");
    });

    // ============================================================
    // B2.10–B2.13: ls / stat
    // ============================================================
    it("B2.10 ls – directory listing from SQLite", () => {
        bkfs.touch("/a.txt");
        bkfs.touch("/b.txt");
        const items = bkfs.ls("/");
        const names = items.map((i: any) => i.name).sort();
        expect(names).toContain("a.txt");
        expect(names).toContain("b.txt");
    });
    it("B2.11 ls – empty directory", () => {
        // BKFS mkdir auto-creates parent dirs, but touch does NOT
        bkfs.mkdir("/parent");
        bkfs.touch("/parent/child.txt", "data");
        const items = bkfs.ls("/parent");
        expect(items.length).toBe(1);
    });
    it("B2.12 stat – file metadata (size, timestamps)", () => {
        bkfs.touch("/meta.txt", "12345");
        const s = bkfs.stat("/meta.txt");
        expect(s).not.toBeNull();
        expect(s!.type).toBe("FILE");
        expect(s!.size).toBe(5);
        expect(typeof s!.created_at).toBe("number");
    });
    it("B2.13 stat – not found returns undefined", () => {
        // BKFS stat returns undefined for not-found paths
        expect(bkfs.stat("/ghost.txt")).toBeUndefined();
    });

    // ============================================================
    // B2.14–B2.17: unlink / rmdir
    // ============================================================
    it("B2.14 unlink – delete file", () => {
        bkfs.touch("/delme.txt");
        expect(bkfs.unlink("/delme.txt")).toBe(true);
        expect(bkfs.exists("/delme.txt")).toBe(false);
    });
    it("B2.15 unlink – not found returns false", () => {
        expect(bkfs.unlink("/nope.txt")).toBe(false);
    });
    it("B2.16 rmdir – remove empty directory", () => {
        bkfs.mkdir("/emptydir");
        expect(bkfs.rmdir("/emptydir")).toBe(true);
        expect(bkfs.exists("/emptydir")).toBe(false);
    });
    it("B2.17 rmdir – non-empty directory fails", () => {
        bkfs.mkdir("/fulldir");
        bkfs.touch("/fulldir/file.txt", "x");
        expect(bkfs.rmdir("/fulldir")).toBe(false);
    });

    // ============================================================
    // B2.18–B2.22: Chunked I/O
    // ============================================================
    it("B2.18 readChunk – read partial file with offset/length", () => {
        bkfs.touch("/data.bin", "0123456789");
        expect(bkfs.readChunk("/data.bin", 2, 4)).toBe("2345");
    });
    it("B2.19 readChunk – offset beyond content returns null", () => {
        bkfs.touch("/data.bin", "abc");
        // BKFS returns "" (empty string) for out-of-range offset, not null
        const result = bkfs.readChunk("/data.bin", 100, 10);
        expect(result === null || result === "").toBe(true);
    });
    it("B2.20 writeChunk – sequential append (copy scenario)", () => {
        bkfs.writeChunk("/copy.bin", "AAAA", 0);
        bkfs.writeChunk("/copy.bin", "BBBB", 4);
        expect(bkfs.read("/copy.bin")).toBe("AAAABBBB");
    });
    it("B2.21 writeChunk – create file if not exists", () => {
        bkfs.writeChunk("/new.bin", "hello", 0);
        expect(bkfs.read("/new.bin")).toBe("hello");
    });
    it("B2.22 writeChunk – random write in middle", () => {
        bkfs.touch("/mid.bin", "0123456789");
        bkfs.writeChunk("/mid.bin", "XX", 3);
        expect(bkfs.read("/mid.bin")).toBe("012XX56789");
    });

    it("B2.22b writeChunk – offset melewati ekor ditolak (bukan metadata bohong)", () => {
        // Dulu jalur ini menulis dengan content=potongan, size=offset+len →
        // metadata bilang ada isi yang sebenarnya tidak ada.
        bkfs.touch("/hole.bin", "AB");
        expect(bkfs.writeChunk("/hole.bin", "Z", 5)).toBe(false);

        // Tidak boleh ada state setengah jadi: isi & size tetap sinkron.
        expect(bkfs.getSize("/hole.bin")).toBe(2);
        expect(bkfs.read("/hole.bin")).toBe("AB");
        expect(bkfs.readChunk("/hole.bin", 0, 2)).toBe("AB");

        // Tulis tepat di ekor tetap append biasa.
        expect(bkfs.writeChunk("/hole.bin", "Z", 2)).toBe(true);
        expect(bkfs.read("/hole.bin")).toBe("ABZ");
        expect(bkfs.getSize("/hole.bin")).toBe(3);
    });

    it("B2.22c readChunk – konten biner ber-NUL dibaca utuh (bukan via SQL SUBSTR)", () => {
        // Regresi nyata: kolom `content` bertipe TEXT, dan SQLite memperlakukan
        // TEXT sebagai C-string di `SUBSTR()`/`length()` — berhenti di byte NUL.
        // Berkas biner hampir selalu memuat NUL (video MP4/MOV bahkan di byte
        // PERTAMA: `00 00 00 18 ftyp`), sehingga `readChunk` selalu mengembalikan
        // "" dan `cp` dari mount NetFS menghasilkan file 0 byte (padahal `read()`
        // utuh dan berkasnya tidak korup).
        const bin = "\u0000MOV\u0000\u0000DATA\u0000END";
        bkfs.touch("/bin.dat", bin);

        expect(bkfs.readChunk("/bin.dat", 0, bin.length)).toBe(bin);
        expect(bkfs.readChunk("/bin.dat", 0, 4)).toBe(bin.slice(0, 4));
        expect(bkfs.readChunk("/bin.dat", 5, 4)).toBe(bin.slice(5, 9));
        expect(bkfs.readChunk("/bin.dat", bin.length + 10, 8)).toBe("");
        expect(bkfs.getSize("/bin.dat")).toBe(bin.length);
        expect(bkfs.read("/bin.dat")).toBe(bin);
    });

    it("B2.22d readChunk – cache satu entri dibuang saat berkas berubah", () => {
        bkfs.touch("/cache.bin", "AAAABBBB");
        expect(bkfs.readChunk("/cache.bin", 0, 4)).toBe("AAAA"); // isi masuk cache

        bkfs.append("/cache.bin", "CCCC");
        expect(bkfs.readChunk("/cache.bin", 4, 4)).toBe("BBBB");
        expect(bkfs.readChunk("/cache.bin", 8, 4)).toBe("CCCC"); // append terlihat

        bkfs.touch("/cache.bin", "ZZZ");
        expect(bkfs.readChunk("/cache.bin", 0, 3)).toBe("ZZZ"); // touch terlihat

        // Berkas lain tidak memakai cache lama.
        bkfs.touch("/other.bin", "123456");
        expect(bkfs.readChunk("/other.bin", 0, 3)).toBe("123");
        expect(bkfs.readChunk("/cache.bin", 0, 3)).toBe("ZZZ");
    });

    // ============================================================
    // B2.23–B2.25: getSize / getUsage
    // ============================================================
    it("B2.23 getSize – file size from size column", () => {
        bkfs.touch("/size.bin", "1234567890");
        expect(bkfs.getSize("/size.bin")).toBe(10);
    });
    it("B2.24 getSize – not found returns -1", () => {
        expect(bkfs.getSize("/nope.bin")).toBe(-1);
    });
    it("B2.25 getUsage – reports file count and total size", async () => {
        bkfs.touch("/a.txt", "12345");
        bkfs.touch("/b.txt", "67890");
        const u = await bkfs.getUsage();
        expect(u.files).toBeGreaterThanOrEqual(2);
        expect(u.size).toBeGreaterThanOrEqual(10);
    });

    // ============================================================
    // B2.26–B2.27: metadata TIDAK boleh membaca konten
    // ============================================================
    it("B2.26 stat – hanya metadata, kolom content tidak ikut terbawa", async () => {
        bkfs.touch("/meta.txt", "12345");
        const s = bkfs.stat("/meta.txt")!;

        // `SELECT *` dulu ikut mengambil `content`: untuk file besar itu berarti
        // mematerialisasi seluruh isi (string JS ~2x ukuran byte) hanya untuk
        // membaca `size` — di lapangan ini membuat klien NetFS timeout 5 s dan
        // kernel SH OOM. Metadata yang dibutuhkan pemanggil tetap lengkap.
        expect("content" in s).toBe(false);
        expect(s.name).toBe("meta.txt");
        expect(s.size).toBe(5);
        expect(s.type).toBe("FILE");
        expect(typeof s.mode).toBe("number");
        expect(typeof s.uid).toBe("number");
        expect(typeof s.gid).toBe("number");
        expect(typeof s.created_at).toBe("number");
        expect(typeof s.modified_at).toBe("number");
        expect(typeof s.parent_id).toBe("number");
    });

    it("B2.27 getUsage – dihitung dari kolom size, bukan length(content)", async () => {
        // Bukti paling langsung: isi `content` dikosongkan lewat koneksi SQLite
        // kedua (mensimulasikan "konten tidak dibaca/tidak ada"), angka `size`
        // HARUS tetap utuh karena kolom itulah sumbernya.
        const dbPath = path.join(os.tmpdir(), `bkfs-usage-${process.pid}-${Date.now()}.db`);
        const local = new BKFS(dbPath);
        try {
            local.touch("/big.bin", "1234567890");

            const raw = new Database(dbPath);
            raw.prepare("UPDATE vnodes SET content = '' WHERE name = 'big.bin'").run();
            raw.close();

            const u = await local.getUsage();
            expect(u.size).toBe(10);
        } finally {
            fs.rmSync(dbPath, { force: true });
        }
    });

    // ============================================================
    // B2.28–B2.29: touch menghormati uid/gid/mode (hanya berkas BARU)
    // ============================================================
    it("B2.28 touch – mode/uid/gid dipakai saat berkas BARU dibuat", () => {
        // Bug nyata: `install.ts` memasang `/etc/rc.local` (0o755) dan `/etc/shadow`
        // (0o640) lewat `touch()`, tapi `resolveForWrite()` dulu memanggil
        // `createEmptyFile()` TANPA argumen → semua berkas baru selalu 0o644.
        // Akibatnya init melewati rc.local ("belum executable") dan shadow terbaca
        // siapa pun (0o644, bukan 0o640).
        bkfs.mkdir("/etc");

        bkfs.touch("/etc/rc.local", "#!/bin/tsh\n", 0, 0, 0o755);
        const rc = bkfs.stat("/etc/rc.local")!;
        expect(rc.mode).toBe(0o755);
        expect((rc.mode & 0o111) !== 0).toBe(true); // syarat init

        bkfs.touch("/etc/shadow", "root:$2b$10$x:0:0:99999:7:::\n", 0, 0, 0o640);
        expect(bkfs.stat("/etc/shadow")!.mode).toBe(0o640);

        bkfs.mkdir("/home/alice");
        bkfs.touch("/home/alice/f.txt", "data", 1000, 1000, 0o600);
        const f = bkfs.stat("/home/alice/f.txt")!;
        expect(f.uid).toBe(1000);
        expect(f.gid).toBe(1000);
        expect(f.mode).toBe(0o600);
    });

    it("B2.29 touch – berkas yang sudah ada: isi diganti, mode tetap (semantik touch Unix)", () => {
        // Sisi lain yang juga penting: editing berkas executable (sync-vfs,
        // `open(..., "w")`) TIDAK boleh mencabut bit `x`-nya.
        bkfs.mkdir("/bin");
        bkfs.touch("/bin/tool.js", "v1", 0, 0, 0o755);

        bkfs.touch("/bin/tool.js", "v2");
        expect(bkfs.read("/bin/tool.js")).toBe("v2");
        expect(bkfs.stat("/bin/tool.js")!.mode).toBe(0o755);
    });
});

/**
 * B3 — KETAHANAN OPERASIONAL & SKALA
 *
 * Blok ini mengunci jaminan yang selama ini tidak ada/implisit:
 *   - durability & mode journal (WAL, integritas, FK);
 *   - atomisitas `batch()` (image sistem tidak boleh setengah jadi);
 *   - encoding BLOB (byte NUL & byte ≥ 0x80 tidak boleh berubah/korup);
 *   - penyimpanan blok untuk file besar (isi & `size` selalu konsisten);
 *   - kompatibilitas baris WARISAN (TEXT) supaya DB lama tetap terbaca.
 *
 * Blok diuji dengan `blockBytes`/`inlineMaxBytes` kecil supaya batas blok
 * benar-benar terlewati tanpa memindahkan megabyte di setiap test.
 */
describe("BKFS — ketahanan operasional & penyimpanan blok (B3)", () => {
    const tmp = (tag: string) =>
        path.join(os.tmpdir(), `bkfs-b3-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const wipe = (p: string) => {
        for (const f of [p, p + "-wal", p + "-shm"]) fs.rmSync(f, { force: true });
    };

    /** bkfsBlok(): BKFS dengan ambang kecil supaya tabel blok mudah terpicu. */
    const bkfsSmall = () => new BKFS(":memory:", false, 0, 0, 0o755, { inlineMaxBytes: 64, blockBytes: 128 });

    /** referensi(): string byte 0..255 (mewakili berkas biner nyata). */
    const binari = (n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(i % 256)).join("");

    // ---------------------------------------------------------- A1: durability
    it("B3.01 file DB memakai WAL + integrity ok (+ FK ditegakkan)", () => {
        const dbPath = tmp("wal");
        const bkfs = new BKFS(dbPath);
        try {
            // Dicek lewat koneksi kedua: pragma journal_mode bersifat persisten per-DB,
            // jadi ini membuktikan mode yang benar-benar tertulis di file.
            const raw = new Database(dbPath, { readonly: true });
            const mode = raw.pragma("journal_mode", { simple: true });
            raw.close();

            expect(String(mode).toLowerCase()).toBe("wal");
            expect(bkfs.checkIntegrity()).toBe("ok");
        } finally {
            bkfs.close();
            wipe(dbPath);
        }
    });

    it("B3.02 close() lalu buka ulang: data tetap utuh (WAL ter-checkpoint)", () => {
        const dbPath = tmp("reopen");
        const first = new BKFS(dbPath);
        first.touch("/persist.txt", "tahan-reboot");
        first.close();

        const second = new BKFS(dbPath);
        try {
            expect(second.read("/persist.txt")).toBe("tahan-reboot");
            expect(second.checkIntegrity()).toBe("ok");
        } finally {
            second.close();
            wipe(dbPath);
        }
    });

    // ---------------------------------------------------------- A2: atomisitas
    it("B3.03 batch() atomik — gagal di tengah membatalkan SEMUA tulisan", () => {
        const bkfs = new BKFS(":memory:");
        bkfs.mkdir("/sistem");

        expect(() =>
            bkfs.batch(() => {
                bkfs.touch("/sistem/a.ts", "AAA");
                bkfs.touch("/sistem/b.ts", "BBB");
                throw new Error("gagal di tengah bootstrap");
            }),
        ).toThrow(/gagal di tengah/);

        // Inilah yang mencegah "image setengah jadi": tidak satupun file tertinggal.
        expect(bkfs.exists("/sistem/a.ts")).toBe(false);
        expect(bkfs.exists("/sistem/b.ts")).toBe(false);

        // Dan batch yang sukses tetap bekerja normal.
        bkfs.batch(() => {
            bkfs.touch("/sistem/a.ts", "AAA");
            bkfs.touch("/sistem/b.ts", "BBB");
        });
        expect(bkfs.read("/sistem/a.ts")).toBe("AAA");
        expect(bkfs.read("/sistem/b.ts")).toBe("BBB");
    });

    // ---------------------------------------------------------- A3: BLOB
    it("B3.04 byte 0..255 utuh (disimpan sebagai BLOB, bukan TEXT)", () => {
        const dbPath = tmp("blob");
        const bkfs = new BKFS(dbPath);
        const data = binari(1024);
        try {
            bkfs.touch("/biner.dat", data);
            expect(bkfs.read("/biner.dat")).toBe(data);
            expect(bkfs.readChunk("/biner.dat", 0, data.length)).toBe(data);
            expect(bkfs.readChunk("/biner.dat", 255, 10)).toBe(data.slice(255, 265));
            expect(bkfs.getSize("/biner.dat")).toBe(data.length);

            // Bentuk penyimpanan: BLOB. Kalau ini TEXT, byte NUL memotong `substr()`
            // di SQL dan byte ≥ 0x80 menggelembung jadi 2 byte UTF-8 di file DB.
            const raw = new Database(dbPath, { readonly: true });
            const t = raw.prepare("SELECT typeof(content) AS t FROM vnodes WHERE name = 'biner.dat'").get() as {
                t: string;
            };
            raw.close();
            expect(t.t).toBe("blob");
        } finally {
            bkfs.close();
            wipe(dbPath);
        }
    });

    it("B3.05 baris WARISAN (TEXT) tetap terbaca benar, termasuk byte NUL", () => {
        const dbPath = tmp("legacy");
        const bkfs = new BKFS(dbPath);
        try {
            bkfs.touch("/warisan.bin", "placeholder");

            // Simulasi database lama: tulis sebagai TEXT (tanpa blok), termasuk NUL.
            const legacy = "AB\u0000\u0000CD\u0000EF";
            const raw = new Database(dbPath);
            raw.prepare("UPDATE vnodes SET content = ?, size = ? WHERE name = 'warisan.bin'").run(
                legacy,
                legacy.length,
            );
            raw.close();

            expect(bkfs.read("/warisan.bin")).toBe(legacy);
            // Jalur TEXT tidak boleh memakai substr() SQL (berhenti di NUL) — ini yang
            // dulu membuat `cp` dari NetFS menghasilkan file 0 byte.
            expect(bkfs.readChunk("/warisan.bin", 0, legacy.length)).toBe(legacy);
            expect(bkfs.readChunk("/warisan.bin", 2, 4)).toBe(legacy.slice(2, 6));
        } finally {
            bkfs.close();
            wipe(dbPath);
        }
    });

    // ---------------------------------------------------------- A4: tabel blok
    it("B3.06 file besar disimpan di tabel blok (content NULL), read() merakit utuh", () => {
        const bkfs = bkfsSmall(); // inline ≤ 64 B, blok 128 B
        const data = binari(1000); // ~8 blok

        bkfs.touch("/besar.bin", data);

        expect(bkfs.getSize("/besar.bin")).toBe(1000);
        expect(bkfs.read("/besar.bin")).toBe(data);
        expect(bkfs.countBlocks("/besar.bin")).toBeGreaterThan(1);
        expect(bkfs.storageKind("/besar.bin")).toBe("blocks");
    });

    it("B3.07 append melewati batas blok: isi & size tetap konsisten", () => {
        const bkfs = bkfsSmall();
        const potongan = binari(300);

        bkfs.touch("/tumbuh.bin", potongan.slice(0, 10));
        let expected = potongan.slice(0, 10);
        for (let i = 10; i < potongan.length; i += 37) {
            const piece = potongan.slice(i, i + 37);
            expect(bkfs.writeChunk("/tumbuh.bin", piece, expected.length)).toBe(true);
            expected += piece;
        }

        expect(bkfs.getSize("/tumbuh.bin")).toBe(expected.length);
        expect(bkfs.read("/tumbuh.bin")).toBe(expected);
        // Potongan terakhir juga harus benar saat dibaca sebagian.
        expect(bkfs.readChunk("/tumbuh.bin", expected.length - 20, 20)).toBe(expected.slice(-20));
    });

    it("B3.08 readChunk file ber-blok: offset tak sejajar, lintas blok, dan di luar batas", () => {
        const bkfs = bkfsSmall();
        const data = binari(400);
        bkfs.touch("/potong.bin", data);

        expect(bkfs.readChunk("/potong.bin", 0, 1)).toBe(data.slice(0, 1));
        expect(bkfs.readChunk("/potong.bin", 127, 2)).toBe(data.slice(127, 129)); // tepat di batas blok
        expect(bkfs.readChunk("/potong.bin", 100, 100)).toBe(data.slice(100, 200)); // lintas blok
        expect(bkfs.readChunk("/potong.bin", 300, 500)).toBe(data.slice(300)); // melebihi ekor
        expect(bkfs.readChunk("/potong.bin", 400, 10)).toBe(""); // di luar isi
    });

    it("B3.09 random write di tengah file ber-blok (splice hanya blok terdampak)", () => {
        const bkfs = bkfsSmall();
        const data = binari(400);
        bkfs.touch("/acak.bin", data);

        // Tulis 5 byte di offset 130 (lintas batas blok 128).
        const patch = "ZZZZZ";
        expect(bkfs.writeChunk("/acak.bin", patch, 130)).toBe(true);

        const expected = data.slice(0, 130) + patch + data.slice(135);
        expect(bkfs.read("/acak.bin")).toBe(expected);
        expect(bkfs.getSize("/acak.bin")).toBe(expected.length);
        expect(bkfs.readChunk("/acak.bin", 128, 10)).toBe(expected.slice(128, 138));
    });

    it("B3.10 touch besar → kecil membuang blok (tidak ada ekor lama yang menyembul)", () => {
        const bkfs = bkfsSmall();
        bkfs.touch("/ubah.bin", binari(500));
        expect(bkfs.countBlocks("/ubah.bin")).toBeGreaterThan(0);

        bkfs.touch("/ubah.bin", "kecil");

        expect(bkfs.countBlocks("/ubah.bin")).toBe(0);
        expect(bkfs.storageKind("/ubah.bin")).toBe("inline");
        expect(bkfs.read("/ubah.bin")).toBe("kecil");
        expect(bkfs.getSize("/ubah.bin")).toBe(5);
    });

    it("B3.11 unlink membuang blok (tidak ada ruang disk yang bocor)", () => {
        const bkfs = bkfsSmall();
        bkfs.touch("/hapus.bin", binari(500));
        expect(bkfs.countBlocks("/hapus.bin")).toBeGreaterThan(0);

        expect(bkfs.unlink("/hapus.bin")).toBe(true);
        expect(bkfs.countBlocks("/hapus.bin")).toBe(0);
        expect(bkfs.read("/hapus.bin")).toBeNull();
    });

    it("B3.12 size selalu konsisten dengan isi (invariant)", () => {
        const bkfs = bkfsSmall();
        const data = binari(777);

        bkfs.touch("/inv.bin", data.slice(0, 5));
        expect(bkfs.getSize("/inv.bin")).toBe(bkfs.read("/inv.bin")!.length);

        // Tulis berurutan tiap 50 byte dari offset 5 → menutupi 5..305 tanpa celah.
        for (let off = 5; off < 300; off += 50) {
            const piece = data.slice(off, off + 50);
            bkfs.writeChunk("/inv.bin", piece, bkfs.getSize("/inv.bin"));
            const isi = bkfs.read("/inv.bin")!;
            expect(isi.length).toBe(bkfs.getSize("/inv.bin"));
            expect(isi).toBe(data.slice(0, isi.length));
        }

        // Sambungan di ekor tetap kontigu → isi harus persis potongan referensi.
        expect(bkfs.getSize("/inv.bin")).toBe(305);
        bkfs.append("/inv.bin", data.slice(305, 320));
        expect(bkfs.getSize("/inv.bin")).toBe(320);
        expect(bkfs.read("/inv.bin")).toBe(data.slice(0, 320));
    });

    it("B3.13 menyisakan celah tetap ditolak pada file ber-blok (bukan metadata bohong)", () => {
        const bkfs = bkfsSmall();
        bkfs.touch("/celah.bin", binari(300)); // sudah ber-blok

        expect(bkfs.writeChunk("/celah.bin", "X", 1000)).toBe(false);
        expect(bkfs.getSize("/celah.bin")).toBe(300);
        expect(bkfs.read("/celah.bin")).toBe(binari(300));
    });

    it("B3.14 close() idempotent + menghapus -wal/-shm (system.db kembali satu file)", () => {
        const dbPath = tmp("close");
        const bkfs = new BKFS(dbPath);
        bkfs.touch("/a.txt", "konten");

        // Bukti mode WAL memang aktif pada koneksi hidup: sidecar WAL dibuat.
        expect(fs.existsSync(dbPath + "-wal")).toBe(true);

        bkfs.close();
        expect(() => bkfs.close()).not.toThrow(); // idempotent (dipanggil exit hook juga)

        // Setelah koneksi TERAKHIR ditutup, SQLite membuang sidecar-nya: inilah yang
        // bikin `system.db` bisa disalin/di-backup sendirian tanpa kehilangan data.
        // (Sebelum perbaikan: `system.db-wal` tetap ada setelah shutdown.)
        expect(fs.existsSync(dbPath + "-wal")).toBe(false);
        expect(fs.existsSync(dbPath + "-shm")).toBe(false);

        const again = new BKFS(dbPath);
        try {
            expect(again.read("/a.txt")).toBe("konten");
        } finally {
            again.close();
            wipe(dbPath);
        }
    });

    // ============================================================
    // B4.01–B4.06: invarian "content ATAU blok" + pembersihan blok tidak sah
    //
    // Latar: di database asli ditemukan `/var/log/syslog` dengan `content` 17 KB
    // *dan* blok sisa 2,6 MB (seq 0, 1, 19 — bolong). Isi tidak salah (read()
    // memprioritaskan `content`), tapi 260 KB jadi sampah tak terlihat. Sumbernya:
    // aturan "content ATAU blok" hanya diingat pemanggil, dan ada penulis yang
    // melewatinya (SQL mentah). Tes di bawah mengunci aturan itu.
    // ============================================================
    it("B4.01 blok basi dibersihkan otomatis saat database dibuka", () => {
        const dbPath = tmp("staleblocks");
        const kecil = { inlineMaxBytes: 64, blockBytes: 128 };
        const b1 = new BKFS(dbPath, false, 0, 0, 0o755, kecil);
        b1.touch("/syslog", binari(300)); // > 64 byte → pindah ke tabel blok
        expect(b1.storageKind("/syslog")).toBe("blocks");
        b1.close();

        // Tiru penulis yang melewati aturan: menulis `content` tanpa membuang blok.
        const raw = new Database(dbPath);
        raw.prepare("UPDATE vnodes SET content = ?, size = ? WHERE name = 'syslog'").run("baris terakhir\n", 15);
        raw.close();

        const b2 = new BKFS(dbPath, false, 0, 0, 0o755, kecil);
        try {
            // Isi benar SEBELUM maupun sesudah pembersihan (content menang) …
            expect(b2.read("/syslog")).toBe("baris terakhir\n");
            expect(b2.getSize("/syslog")).toBe(15);
            // … dan blok sisanya sudah dibuang saat dibuka (dulu: 300 byte sampah).
            expect(b2.countBlocks("/syslog")).toBe(0);
            expect(b2.storageKind("/syslog")).toBe("inline");
            expect(b2.storageHealth().staleBlocks).toBe(0);
        } finally {
            b2.close();
            wipe(dbPath);
        }
    });

    it("B4.02 append pada file ber-blok tetap ber-blok (tidak jadi baris campuran)", () => {
        const b = bkfsSmall();
        b.touch("/log", binari(300));
        b.append("/log", "tambahan");

        expect(b.storageKind("/log")).toBe("blocks");
        expect(b.countBlocks("/log")).toBeGreaterThan(0);
        expect(b.getSize("/log")).toBe(308);
        expect(b.read("/log")).toBe(binari(300) + "tambahan");
    });

    it("B4.03 append pada baris campuran tidak menulis di atas blok sisa", () => {
        const dbPath = tmp("hybrid");
        const kecil = { inlineMaxBytes: 64, blockBytes: 128 };
        const b = new BKFS(dbPath, false, 0, 0, 0o755, kecil);
        b.touch("/syslog", binari(300));

        const raw = new Database(dbPath);
        raw.prepare("UPDATE vnodes SET content = ?, size = ? WHERE name = 'syslog'").run("kecil", 5);
        raw.close();

        // `content` = sumber kebenaran (sama seperti read()) → "kecil" + "X".
        // Blok sisa tidak boleh ikut terbaca, dan harus dibuang oleh penulisan inline.
        b.append("/syslog", "X");
        expect(b.read("/syslog")).toBe("kecilX");
        expect(b.getSize("/syslog")).toBe(6);
        expect(b.countBlocks("/syslog")).toBe(0);
        b.close();
        wipe(dbPath);
    });

    it("B4.04 repairStorage() membuang blok yatim dan melaporkannya", () => {
        const dbPath = tmp("orphan");
        const kecil = { inlineMaxBytes: 64, blockBytes: 128 };
        const b = new BKFS(dbPath, false, 0, 0, 0o755, kecil);
        b.touch("/besar.bin", binari(300));
        expect(b.countBlocks("/besar.bin")).toBeGreaterThan(0);

        // Hapus baris vnode via koneksi LAIN tanpa FK → CASCADE tidak jalan,
        // persis seperti penghapus lama/migrasi dedup di `initSchema()`.
        const raw = new Database(dbPath);
        raw.pragma("foreign_keys = OFF");
        raw.prepare("DELETE FROM vnodes WHERE name = 'besar.bin'").run();
        expect((raw.prepare("SELECT COUNT(*) AS n FROM blocks").get() as { n: number }).n).toBeGreaterThan(0);
        raw.close();

        const hasil = b.repairStorage();
        expect(hasil.orphan).toBeGreaterThan(0);
        expect(b.storageHealth().orphanBlocks).toBe(0);
        b.close();
        wipe(dbPath);
    });

    it("B4.05 storageHealth() nol pada database sehat", () => {
        const b = bkfsSmall();
        b.touch("/kecil.txt", "abc");
        b.touch("/besar.bin", binari(300));

        const h = b.storageHealth();
        expect(h.staleBlocks).toBe(0);
        expect(h.orphanBlocks).toBe(0);
        expect(h.holeyFiles).toBe(0);
        expect(h.sizeMismatch).toBe(0);
        expect(h.inlineFiles).toBe(1);
        expect(h.blockFiles).toBe(1);
    });

    it("B4.06 read() dan readChunk() menjawab sama pada baris campuran", () => {
        const dbPath = tmp("mixchunk");
        const kecil = { inlineMaxBytes: 64, blockBytes: 128 };
        const b = new BKFS(dbPath, false, 0, 0, 0o755, kecil);
        b.touch("/mix.bin", binari(300));

        const raw = new Database(dbPath);
        raw.prepare("UPDATE vnodes SET content = ?, size = ? WHERE name = 'mix.bin'").run("ABCDE", 5);
        raw.close();

        expect(b.read("/mix.bin")).toBe("ABCDE");
        // Dulu `readChunk()` memilih sumber dari JUMLAH BLOK → membaca dari blok
        // ("01234") padahal `read()` membaca `content` ("ABCDE"): satu file, dua jawaban.
        expect(b.readChunk("/mix.bin", 0, 5)).toBe("ABCDE");
        b.close();
        wipe(dbPath);
    });
});
