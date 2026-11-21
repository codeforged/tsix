/**
 * VFS MENYIMPAN *BYTE*, BUKAN KARAKTER.
 *
 * Konvensi internal TSIX: isi berkas di VFS adalah string **latin1** dengan
 * 1 char = 1 byte (lihat `encodeContent()` di `src/vfs/BKFS.ts`). Itu wajib supaya:
 *   - aset biner tetap utuh (`Buffer.from(raw, "latin1")` → byte persis sama),
 *   - offset `readChunk()`/`writeChunk()` = byte (yang dikirim NetFS),
 *   - `size` benar-benar byte.
 *
 * KONSEKUENSINYA: string itu adalah wadah byte, **bukan** teks. Berkas teks UTF-8
 * ikut disimpan sebagai byte-nya, jadi teks non-ASCII terlihat "mojibake" kalau
 * dibaca mentah. Selama bertahun-tahun hal ini tidak kelihatan untuk ASCII, lalu
 * meledak dalam dua bentuk nyata (2026-09-23):
 *
 *   1. `Buffer.from(text, "latin1")` MEMOTONG setiap karakter > U+00FF ke byte
 *      rendahnya → `✕` (U+2715) menjadi byte `0x15`, `─` (U+2500) menjadi `0x00`.
 *      Tombol minimize/maximize/close dan border tabel jadi kacau.
 *   2. BOM UTF-8 (`U+FEFF`) menjadi byte `0xFF` di awal berkas JS → browser menolak
 *      seluruh skrip: `Uncaught ReferenceError: ÿ is not defined`.
 *
 * ATURAN: kalau sebuah berkas adalah TEKS dan mau dipakai sebagai teks (dikompilasi,
 * di-parse, disajikan ke browser sebagai teks), konversi eksplisit lewat fungsi di
 * sini — jangan menebak, dan jangan pernah meng-encode string latin1 dengan `utf8`.
 *
 *   host → VFS :  utf8ToVfsBytes(text)     (teks dijadikan byte UTF-8-nya)
 *   VFS → teks :  vfsBytesToUtf8(raw)      (byte UTF-8 dijadikan teks)
 *
 * Keduanya round-trip EXACT (tidak ada yang hilang) dan aman dipakai berkali-kali.
 *
 * ⚠️ JANGAN di-import dari *worker entry* host-side (`src/userland/WorkerEntry.ts`):
 * worker jalur JS-Direct dijalankan tanpa preload transpiler `.ts`, jadi `require()`
 * ke berkas ini GAGAL (`Cannot find module '../common/VfsText'`) dan worker mati
 * sebelum mengirim 'ready' — boot diam di `/etc/rc.local`. Untuk kasus itu, salin
 * satu barisnya (lihat komentar di `WorkerEntry.ts`).
 */

/** Byte VFS (latin1) → teks UTF-8. Untuk berkas yang memang teks. */
export function vfsBytesToUtf8(raw: string | null | undefined): string {
    if (raw === null || raw === undefined) return "";
    return Buffer.from(raw, "latin1").toString("utf8");
}

/** Teks UTF-8 → byte VFS (latin1). Kebalikan `vfsBytesToUtf8()`. */
export function utf8ToVfsBytes(text: string): string {
    return Buffer.from(text, "utf8").toString("latin1");
}
