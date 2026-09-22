import { describe, it, expect, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { peekBom, readBinaryFile, readTextFile } from "./text-file";
import { encodeContent } from "../../src/vfs/BKFS";

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
});
