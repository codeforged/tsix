# Changelog ATTO Text Editor

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-09-16

### Ctrl+/ — toggle komentar `//` untuk baris terseleksi

- **File:** `src/mirror/bin/atto.ts`
- **Perubahan:**
  - **Ctrl+/** (terminal mengirim `0x1F`, alias `Ctrl+_`) men-toggle komentar `//`: kalau **semua** baris target sudah berkomentar → `//` dibuang; kalau tidak → `// ` ditambahkan **hanya** pada baris yang belum berkomentar (perilaku lazim editor). Baris kosong / hanya-spasi dilewati dan indentasi dipertahankan (`  foo()` ⇄ `  // foo()`).
  - Rentang yang dipakai adalah baris yang terseleksi; **tanpa selection** berlaku untuk baris kursor, jadi shortcut tidak pernah jadi no-op. Selection tetap aktif sesudahnya supaya Ctrl+/ bisa ditekan berulang (comment → uncomment → comment).
  - Handler dipasang **sebelum** blok `finalizeSelection()` di `handleKey()`; kalau ditaruh sesudahnya, selection terlanjur di-copy lalu dibatalkan lebih dulu. Kolom anchor/end + kursor digeser mengikuti delta tiap baris (`+3` untuk `// `, negatif saat uncomment), dan `captureState(true)` dipanggil supaya satu Ctrl+/ bisa di-undo.
  - Help box (F1) mendapat baris `Ctrl+/: Toggle Cmt` (lebar kolom tetap 74 char per baris).
- **Dampak:** Menandai blok kode jadi komentar (dan sebaliknya) tanpa menyentuh baris satu per satu — termasuk untuk satu baris kursor saja.
- **Verifikasi:** logika toggle disimulasikan terpisah — round-trip comment ⇄ uncomment benar (`["  const a = 1;", "", "    foo();"]` ⇄ `["  // const a = 1;", "", "    // foo();"]`) dengan delta `+3`/`-3`; tabel help dicek per-kolom (`sep@[0,24,43,73]`, semua baris 74 char).
- **Deploy:** sync `atto.ts` ke VFS (`scripts/sync-vfs.ts`) — sidecar `atto.js` ikut di-transpile otomatis; tanpa restart kernel.
- **Catatan:** di terminal browser (pixelterm/retroterm) butuh `dome-client-term.js`, karena xterm.js tidak mengirim apa pun untuk Ctrl+/ (lihat changelog DOME 2026-09-16).
- **Oleh:** Copilot · **Laporan:** andriansah

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
