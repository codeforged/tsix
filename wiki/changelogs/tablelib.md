# Changelog tableLib + ansiLib (Userland Library)

> Changelog untuk `src/mirror/lib/tableLib.ts` + `src/mirror/lib/ansiLib.ts`
> (text table builder & primitif ANSI native TSIX).
> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-09-18

### TableLib + AnsiLib — table builder & warna ANSI native TSIX (baru)

- **File:** `src/mirror/lib/tableLib.ts` (baru), `src/mirror/lib/ansiLib.ts` (baru),
  `src/mirror/lib/tableLib.test.ts` (baru), `src/mirror/lib/ansiLib.test.ts` (baru),
  `src/mirror/opt/test/table-demo.ts` (baru), `wiki/tablelib.md` (baru).
- **Latar belakang:** pertanyaan "bisa tidak `cli-table3` diintegrasikan ke TSIX?".
  Jawabannya bisa, tapi **tidak cocok apa adanya**: (`1`) `cli-table3` mengukur
  lebar lewat `string-width` (CJK = 2 kolom) sedangkan `TTY.putChar()` TSIX
  memakai **1 sel per code unit UTF-16** → tabel miring; (`2`) lebar layar
  diambil dari `process.stdout.columns` yang di worker **bukan TTY**;
  (`3`) output-nya lewat `console.log` yang mengarah ke stdout **host**
  (`bootstrap.sh`), bukan TTY app; (`4`) setiap paket npm di `/lib` membebani
  **setiap** worker (`Kernel.rebuildVFSCache`). Karena itu dibuat versi native.
- **Perubahan:**
    - **`AnsiLib`** — zero-dependency: `paint()` (nama warna, `16..255`,
      `#rrggbb`, `[r,g,b]`, modifier), `tone.*` (palet semantik CLI),
      `displayWidth()` (**semantik TTY TSIX**, bukan `string-width`),
      `stripAnsi`, `takeWidth`, `truncate` (menutup SGR terbuka sebelum elipsis),
      `wrap` (word-wrap ANSI-aware, `\n` = baris paksa), `padEnd`/`padStart`/`center`,
      `setColorEnabled`/`isColorEnabled`, `detectColor({TERM, NO_COLOR, FORCE_COLOR})`.
      Hanya menghasilkan subset ANSI yang di-parse `TTY.handleANSI()`
      (`m`, `J`, `K`, `A/B/C/D`, `H/f`, `S/T`, `L/M`, `s/u`) — tanpa escape asing.
    - **`TableLib`** — `Table` (push/addRow/addRows/separator/setHead/render/
      toString/toLines/print/fromRecords/rowCount), `renderTable()`,
      `printTable()`, `CHARSETS` (`box`, `rounded`, `double`, `compact`, `ascii`,
      `markdown`, `none`, atau kustom), `TABLE_THEMES` (`plain`, `classic`, `accent`).
      Opsi: `head`, `charset`, `align` (+`alignNumeric`), `padding`, `width`,
      `colWidths`, `minColWidth`, `maxColWidth`, `wrap`, `ellipsis`,
      `headSeparator`, `color`, `style`, `indent`, `stretch`.
    - **`Table.print(std)`** mengambil lebar dari `std.getScreenInfo()`
      (`SCREEN_INFO` → `TIOCGWINSZ`) minus 1 sel; fallback 80 kolom bila syscall
      gagal. Semua keluaran lewat `std.print()` (syscall PRINT).
    - **Penyusutan deterministik** — bila konten melebihi `width`, **kolom
      terlebar** menyusut lebih dulu sampai muat (batas `minColWidth`); kolom
      dengan `colWidths` eksplisit tidak disentuh. `stretch: true` membagi sisa
      lebar secara round-robin.
    - **Rata-kanan otomatis** — `align: "auto"` (default) merata-kanan-kan kolom
      yang **semua isi body-nya** angka (header diabaikan), seperti `ps`.
- **Demo:** `/opt/test/table-demo` — 8 seksi (dasar, warna, bingkai, lebar,
  separator, `fromRecords()` dari `shell.ps()`, `displayWidth()`, lebar layar),
  dengan opsi `--help`, `--width N`, `--no-color`, `--charset`, `--section`.
- **Tes:** 66 unit test (`vitest run src/mirror/lib/ansiLib.test.ts
src/mirror/lib/tableLib.test.ts`) — 25 untuk `ansiLib`, 41 untuk `tableLib`,
  semuanya lulus. Catatan: pada tes `tableLib`, lebar baris ber-ANSI dibandingkan
  lewat `displayWidth()`, bukan `.length` (ANSI 0 sel tapi tetap dihitung
  `String.length`).
- **Verifikasi manual:** smoke test di Node (tanpa kernel) menunjukkan baris
  berisi CJK (`日本語`), emoji (`😀😀`), dan sel ber-ANSI semuanya punya lebar
  tampilan yang sama dengan garis border (23 sel) — tabel tidak miring.
- **Deploy:** `npm run vfs:bootstrap` (menambah file di `src/mirror/lib/` +
  `src/mirror/opt/test/`), lalu restart app yang memakainya. Tidak menyentuh
  kernel/WorkerEntry, jadi **tidak perlu** restart node.
- **Detail:** `wiki/tablelib.md` (API lengkap + tabel perbandingan
  `displayWidth()` vs `string-width`).
- **Oleh:** Copilot

---
