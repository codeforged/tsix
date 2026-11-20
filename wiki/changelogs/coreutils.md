# Changelog Core Utilities

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-11-20

### `ls` mendukung pencarian direktori rekursif dan opsi Linux umum

- **File:** `src/mirror/bin/ls.ts`, `src/mirror/bin/ls.test.ts`.
- **Rekursif:** opsi `-R` / `--recursive` menampilkan isi subdirektori dengan
  header per direktori; direktori tersembunyi tidak ditelusuri kecuali diminta.
- **Opsi:** dukungan untuk hidden entries (`-a`, `-A`), directory-only (`-d`),
  format kolom/baris/satu entri (`-C`, `-x`, `-1`), long listing dan ukuran
  terbaca (`-l`, `-h`), klasifikasi (`-F`), pengurutan ukuran/waktu/ekstensi/
  versi (`-S`, `-t`, `-X`, `-v`), urutan asli (`-U`), pembalikan (`-r`),
  `--sort`, `--color`, `--no-color`, dan `--help`.
- **Verifikasi:** 5 tes `ls.test.ts` lulus, termasuk traversal rekursif,
  hidden directories, `-d`, ukuran terbaca, dan natural sorting.
- **Oleh:** Copilot
