import * as fs from "fs";

/**
 * PEMBACA BERKAS HOST UNTUK VFS.
 *
 * ATURAN UTAMA: yang disimpan VFS adalah **byte berkas**, bukan karakter. Jadi semua
 * pembaca di sini mengembalikan string **latin1 yang byte-nya persis sama** dengan
 * berkas di disk (1 char = 1 byte) — lihat `src/common/VfsText.ts` untuk alasannya.
 *
 * Kenapa penting (dua bug nyata, 2026-09-23):
 *   1. `readFileSync(p, "utf8")` + `Buffer.from(s, "latin1")` MEMOTONG karakter
 *      > U+00FF (`✕` U+2715 → `0x15`, `─` U+2500 → `0x00`) → tombol jendela, border
 *      tabel, dan emoji jadi kacau.
 *   2. BOM UTF-8 (`EF BB BF`) yang dibaca sebagai teks menjadi `U+FEFF` → encode
 *      latin1 → byte `0xFF` di awal berkas JS → browser menolak SELURUH skrip
 *      (`Uncaught ReferenceError: ÿ is not defined`).
 *
 * BOM tetap dibuang (di level BYTE, jadi bebas dari risiko di atas) karena berkas yang
 * disajikan browser tidak seharusnya membawa BOM — dan pembuangannya terlihat di log
 * sinkronisasi, bukan diam-diam.
 */
export function readTextFile(filePath: string): string {
    const buf = fs.readFileSync(filePath);
    const punyaBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    return (punyaBom ? buf.subarray(3) : buf).toString("latin1");
}

/**
 * Baca berkas biner sebagai latin1 (1 char = 1 byte) — byte-untuk-byte.
 *
 * TIDAK membuang apa pun: `Buffer.from(readBinaryFile(p), "latin1")` harus
 * mengembalikan byte yang persis sama (PNG/JPG/MP3/font). Untuk aset biner, `0xFF`
 * di awal adalah data sungguhan (JPEG `FF D8`, MP3 frame sync `FF FB`) — bukan BOM —
 * jadi jangan pernah "merapikan"-nya.
 */
export function readBinaryFile(filePath: string): string {
    return fs.readFileSync(filePath).toString("latin1");
}

/** Jenis BOM di awal berkas (tanpa membaca seluruh isi). */
export function peekBom(filePath: string): "utf8" | "utf16le" | "utf16be" | null {
    let fd: number | null = null;
    try {
        fd = fs.openSync(filePath, "r");
        const buf = Buffer.alloc(3);
        const n = fs.readSync(fd, buf, 0, 3, 0);
        if (n >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return "utf8";
        if (n >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return "utf16le";
        if (n >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return "utf16be";
        return null;
    } catch {
        return null;
    } finally {
        if (fd !== null) fs.closeSync(fd);
    }
}

// Konversi batas teks: dipakai saat isi VFS (byte) harus jadi teks (esbuild/parse).
export { utf8ToVfsBytes, vfsBytesToUtf8 } from "../../src/common/VfsText";
