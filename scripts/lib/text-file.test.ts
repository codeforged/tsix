import { describe, it, expect, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { peekBom, readBinaryFile, readTextFile, utf8ToVfsBytes, vfsBytesToUtf8 } from "./text-file";
import { BKFS, encodeContent } from "../../src/vfs/BKFS";

/**
 * BOM UTF-8 di berkas sumber pernah mematikan SELURUH skrip DOME di browser:
 * `EF BB BF` dibaca `utf8` → `U+FEFF` → di-encode latin1 → byte `0xFF` di VFS →
 * "Uncaught ReferenceError: ÿ is not defined". Tes ini mengunci jalur pembacaan
 * host→VFS supaya bug itu tidak bisa kembali diam-diam.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tsix-textfile-"));
const write = (name: string, buf: Buffer) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, buf);
    return p;
};

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("scripts/lib/text-file", () => {
    it("T1.01 readTextFile membuang BOM UTF-8", () => {
        const p = write("bom.js", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("/* ok */")]));
        const text = readTextFile(p);
        expect(text).toBe("/* ok */");
        expect(text.charCodeAt(0)).toBe(0x2f); // '/' — bukan 0xFEFF lagi
    });

    it("T1.02 BOM → byte 0xFF di VFS kalau TIDAK dibuang (alasan tes ini ada)", () => {
        const p = write("bom2.js", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("x")]));

        // Baca mentah seperti kode lama: `utf8` → `U+FEFF` tetap ada.
        const tanpaPerbaikan = fs.readFileSync(p, "utf8");
        expect(tanpaPerbaikan.charCodeAt(0)).toBe(0xfeff);
        // …dan di-encode latin1, `U+FEFF & 0xFF` = 0xFF → skrip mati di browser.
        expect(encodeContent(tanpaPerbaikan)[0]).toBe(0xff);

        // Jalur yang benar: BOM dibuang lebih dulu → byte pertama tetap ASCII.
        expect(encodeContent(readTextFile(p))[0]).toBe(0x78); // 'x'
    });

    it("T1.03 readTextFile tidak mengubah berkas tanpa BOM", () => {
        const p = write("plain.js", Buffer.from("const a = 1;\n"));
        expect(readTextFile(p)).toBe("const a = 1;\n");
    });

    it("T1.04 readBinaryFile byte-untuk-byte (0xFF asli tidak disentuh)", () => {
        // JPEG `FF D8 FF E0` + NUL: byte ≥ 0x80 dan NUL harus tetap utuh.
        const asli = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x80, 0x01]);
        const p = write("foto.jpg", asli);
        const text = readBinaryFile(p);
        expect(text.charCodeAt(0)).toBe(0xff);
        expect(Buffer.from(text, "latin1").equals(asli)).toBe(true);
    });

    it("T1.05 peekBom melaporkan jenis BOM (atau null)", () => {
        expect(peekBom(write("u8.txt", Buffer.from([0xef, 0xbb, 0xbf, 0x41])))).toBe("utf8");
        expect(peekBom(write("u16le.txt", Buffer.from([0xff, 0xfe, 0x41, 0x00])))).toBe("utf16le");
        expect(peekBom(write("u16be.txt", Buffer.from([0xfe, 0xff, 0x00, 0x41])))).toBe("utf16be");
        expect(peekBom(write("bersih.txt", Buffer.from("hello")))).toBeNull();
    });

    it("T1.06 teks non-ASCII disimpan sebagai BYTE yang persis sama (glyph tombol jendela)", () => {
        // `✕` (U+2715) = E2 9C 95, `─` (U+2500) = E2 94 80 — glyph tombol close &
        // border tabel. Kalau teks dibaca sebagai string lalu di-encode latin1, dua
        // karakter ini masing-masing tinggal 1 byte (0x15 dan 0x00) → UI kacau.
        const asli = Buffer.from("tombol ✕ ─ selesai", "utf8");
        const p = write("glyph.js", asli);

        const bytes = readTextFile(p);
        // 1 char = 1 byte, byte identik dengan berkas di disk.
        expect(Buffer.from(bytes, "latin1").equals(asli)).toBe(true);
        // Panjang string = panjang byte (bukan jumlah karakter) → `size` VFS = byte.
        expect(bytes.length).toBe(asli.length);
        // Dan bisa dibalik jadi teks aslinya lagi (jalur kompilasi/serving).
        expect(vfsBytesToUtf8(bytes)).toBe("tombol ✕ ─ selesai");
        // Tanpa konversi, karakter non-ASCII akan rusak — inilah yang dulu terjadi.
        expect(encodeContent("tombol ✕ ─ selesai")[7]).not.toBe(0xe2);
    });

    it("T1.07 batas teks: round-trip untuk UTF-8, dan TIDAK untuk byte acak", () => {
        // Aturan: `vfsBytesToUtf8()`/`utf8ToVfsBytes()` hanya untuk berkas TEKS.
        // Teks apa pun (termasuk emoji) bolak-balik tanpa berubah.
        for (const t of ["halo", "emoji 🚀 é", "border ┌──┬──┐", "✕ ─ → °"]) {
            expect(vfsBytesToUtf8(utf8ToVfsBytes(t))).toBe(t);
        }

        // Byte BINER acak TIDAK selamat melewatinya (byte 0x80–0xFF bukan UTF-8 yang
        // sah → jadi U+FFFD). Itu memang benar: untuk biner, byte dibaca langsung
        // (`Buffer.from(raw, "latin1")`), tidak pernah lewat konversi teks.
        const biner = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join("");
        expect(vfsBytesToUtf8(biner)).not.toBe(biner);
        expect(Buffer.from(biner, "latin1")[0xff]).toBe(0xff); // jalan yang benar untuk biner
    });

    it("T1.08 round-trip SIMPAN EDITOR (alur atto): byte-identik setelah buka → edit → simpan", () => {
        // Meniru persis urutan panggilan `bin/atto.ts`:
        //   sync:  touch(path, utf8ToVfsBytes(teks))
        //   buka:  read → vfsBytesToUtf8
        //   simpan: touch(path, utf8ToVfsBytes(teksHasilEdit))
        const dbPath = path.join(dir, "atto.db");
        const bkfs = new BKFS(dbPath);
        try {
            const awal = "ikon: 📺  tabel: ┌──┬──┐  aksen: é ✓  → ✓\n";
            bkfs.touch("/ui.txt", utf8ToVfsBytes(awal));

            // Buka di editor
            const rawBuka = bkfs.read("/ui.txt");
            const diEditor = vfsBytesToUtf8(rawBuka);
            expect(diEditor).toBe(awal); // tampil benar, bukan mojibake

            // Edit lalu simpan
            const hasilEdit = diEditor + "baris baru 🚀\n";
            bkfs.touch("/ui.txt", utf8ToVfsBytes(hasilEdit));

            // Byte di VFS harus persis UTF-8 dari teks hasil edit
            const byteVfs = Buffer.from(bkfs.read("/ui.txt")!, "latin1");
            expect(byteVfs.equals(Buffer.from(hasilEdit, "utf8"))).toBe(true);
            expect(vfsBytesToUtf8(bkfs.read("/ui.txt")!)).toBe(hasilEdit);

            // Dan `size` = jumlah BYTE (bukan jumlah karakter)
            expect(bkfs.getSize("/ui.txt")).toBe(Buffer.byteLength(hasilEdit, "utf8"));

            // Bukti jalur lama (tanpa encode) MERUSAK berkas — ini yang dulu terjadi:
            bkfs.touch("/rusak.txt", hasilEdit);
            const rusak = Buffer.from(bkfs.read("/rusak.txt")!, "latin1");
            expect(rusak.equals(Buffer.from(hasilEdit, "utf8"))).toBe(false);
            expect(rusak.length).toBe(hasilEdit.length); // dipotong 1 byte per karakter
        } finally {
            bkfs.close();
        }
    });
});
