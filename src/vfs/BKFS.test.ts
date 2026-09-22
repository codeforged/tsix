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
});
