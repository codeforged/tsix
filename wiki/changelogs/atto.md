# Changelog ATTO Text Editor

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-08-05

### Status bar warna konfigurabel (fg/bg) + R:C mengikuti cursor
- **File:** `src/mirror/bin/atto.ts`, `src/mirror/etc/atto.json`
- **Perubahan:**
  - Theme status bar baru `statusBar: { fg, bg }` — warna teks & background konfigurabel via `/etc/atto.json` (default + override per bahasa). Helper `bgOf()` otomatis mengubah kode foreground (`30-37` / `90-97`) ke background (`40-47` / `100-107`); mendukung juga `48;5;N` / `48;2;r;g;b`.
  - Fix: `renderCursorOnly()` kini memanggil `renderStatusBar()` — status `R:C` (row/col) **selalu mengikuti cursor** (sebelumnya hanya di-refresh saat `render()` penuh = ketika resize).
  - Self-heal ukuran layar: `refreshScreenSize()` di `renderCursorOnly()` — cek `getScreenInfo()`; jika ukuran berubah (resize terlewat sinyalnya) → full redraw agar status bar selalu di posisi benar (sinergi dengan fix multi-instance PixelTerm).
- **Dampak:** Status bar menampilkan warna sesuai tema & row/col real-time saat cursor bergerak.
- **Oleh:** Copilot

### Syntax highlighting TS/JS + nomor baris variable-width
- **File:** `src/mirror/bin/atto.ts`
- **Perubahan:**
  - Gutter nomor baris **variable-width** (`numWidth` = panjang digit total baris) — posisi kursor & scroll horizontal menyesuaikan; deteksi perubahan lebar gutter → full redraw.
  - **Syntax highlighting** untuk `.ts`/`.js`: tokenizer komentar (`//`, `/* */`), string (`' " \`` dengan escape), angka (desimal/hex/biner/exponen), keyword & builtin — warna ANSI zero-width (tidak menggeser kursor).
- **Dampak:** Mengedit file TypeScript/JavaScript lebih nyaman & terbaca.
- **Oleh:** Copilot

### Tema warna & daftar keyword via /etc/atto.json
- **File:** `src/mirror/etc/atto.json` (VFS `/etc/atto.json`), `src/mirror/bin/atto.ts`
- **Perubahan:**
  - Config per bahasa (`default`, `typescript`, `javascript`): warna ANSI SGR (`30-37`, `90-97`, `38;5;N`, `38;2;r;g;b`) + array `keywords[]` & `builtins[]` yang **menggantikan** daftar default di kode.
  - `loadSyntaxTheme()` merge default → override per bahasa; fallback ke default kode jika file tidak ada/rusak.
- **Dampak:** Sesuaikan warna & daftar keyword tiap bahasa cukup edit JSON — tanpa menyentuh kode.
- **Oleh:** Copilot
