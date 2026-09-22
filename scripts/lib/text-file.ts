import * as fs from "fs";

/**
 * PEMBACA BERKAS HOST UNTUK VFS — sadar-BOM.
 *
 * KENAPA ADA (bug nyata, 2026-09-23):
 * VFS menyimpan isi file sebagai BLOB latin1 (1 char = 1 byte). Kalau berkas teks
 * dibaca dengan `readFileSync(p, "utf8")`, BOM UTF-8 (`EF BB BF`) menjadi SATU
 * karakter `U+FEFF` — dan saat di-encode latin1, `U+FEFF & 0xFF` = **byte `0xFF`**.
 * Hasilnya berkas JS di VFS diawali byte sampah:
 *
 *     Uncaught ReferenceError: ÿ is not defined      (dome-client-core.js:1:1)
 *
 * Browser menolak seluruh skrip, jadi satu BOM di berkas sumber = satu fitur mati.
 * BOM juga tidak pernah diinginkan di file yang disajikan browser, jadi jalur
 * pembacaan VFS membuangnya (dan mencatatnya, supaya terlihat — bukan diam-diam).
 *
 * Catatan: BOM UTF-16 (`FF FE` / `FE FF`) TIDAK diperbaiki di sini. Berkas seperti
 * itu bukan teks yang bisa dipakai apa adanya; `peekBom()` melaporkannya supaya
 * operator bisa memperbaiki sumbernya (bukan ditebak-tebak oleh loader).
 */

/** Baca berkas teks, buang BOM UTF-8 kalau ada. */
export function readTextFile(filePath: string): string {
    const buf = fs.readFileSync(filePath);
    const text = buf.toString("utf8");
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
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
