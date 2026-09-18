# tableLib — Text Table Builder native TSIX

> Padanan `cli-table3` untuk ekosistem TSIX: **`@tsix/tableLib`** (tabel) +
> **`@tsix/ansiLib`** (warna & pengukuran lebar).
> Riwayat perubahan: [`changelogs/tablelib.md`](changelogs/tablelib.md).

```text
┌──────┬────────────┬───────────┐
│ PID  │ SERVICE    │ STATUS    │
├──────┼────────────┼───────────┤
│    1 │ init       │ running   │
│   42 │ mqtt-broker│ UP        │
└──────┴────────────┴───────────┘
```

---

## Kenapa tidak pakai `cli-table3` (atau `string-width`/`chalk`) saja?

Tiga alasan konkret — semuanya soal arsitektur worker TSIX:

**1. Lebar kolom harus mengikuti `TTY.putChar()`, bukan "true width" Unicode.**
`TTY.putChar()` (`src/kernel/tty/TTY.ts`) menulis **satu sel per code unit
UTF-16** dan menaikkan `cursorX` sebanyak 1. `string-width` npm menghitung CJK
& emoji = 2 kolom → tabel akan **miring** di TSIX. `displayWidth()` di
`ansiLib` mengikuti perilaku TTY persis:

| Teks                 | `displayWidth()` (TSIX) | `string-width` npm |
| -------------------- | ----------------------- | ------------------ |
| `abc`                | 3                       | 3                  |
| `\x1b[31mabc\x1b[0m` | 3                       | 3                  |
| `日本語`             | **3**                   | 6                  |
| `┌─┬─┐`              | 5                       | 5                  |
| `😀`                 | 2                       | 2                  |

**2. Lebar layar tidak bisa dibaca dari `process.stdout`.**
Di worker, `process.stdout.columns` tidak ada (bukan TTY) dan `process.stdout`
mengarah ke **stdout host** — layar `bootstrap.sh`, bukan layar app. Lebar
diambil dari `std.getScreenInfo()` (syscall `SCREEN_INFO` → `TIOCGWINSZ`) atau
`$COLUMNS`.

**3. `/lib` di-pre-compile & dikirim ke SETIAP worker.**
`Kernel.rebuildVFSCache()` men-transpile seluruh `/lib/*.ts` ke `vfsCache`, lalu
cache itu di-clone ke tiap worker lewat `workerData`. Menambah paket npm berarti
membebani setiap proses. Kedua file ini murni string/Number — **tanpa import apa
pun**. Terukur: `ansiLib.ts` + `tableLib.ts` = **23.5 KB** hasil transpile
(tanpa sourcemap) per worker — jauh di bawah penghematan yang pernah didapat dari
membuang 51 file `.js` basi di `/lib` (1.70 MB → −4.4 MB/worker).

---

## `@tsix/tableLib`

### Ringkas

```ts
import { Program, std } from "@tsix/Application";
import { Table, TABLE_THEMES, renderTable } from "@tsix/tableLib";
import { tone } from "@tsix/ansiLib";

export const main = Program(async () => {
    const t = new Table({
        head: ["PID", "PROCESS", "STATE"],
        style: TABLE_THEMES.accent,
    });
    t.addRow([1, "init", tone.success("running")]);
    t.addRow([42, "airtermd", tone.muted("sleep")]);
    await t.print(std); // lebar = COLUMNS TTY - 1
});
```

### Opsi `TableOptions`

| Opsi            | Default   | Keterangan                                                                                                 |
| --------------- | --------- | ---------------------------------------------------------------------------------------------------------- |
| `head`          | `[]`      | Baris header (kosong = tanpa header).                                                                      |
| `charset`       | `"box"`   | `box` · `rounded` · `double` · `compact` · `ascii` · `markdown` · `none`, atau definisi `Charset` sendiri. |
| `align`         | `"auto"`  | `left`/`right`/`center`/`auto`, skalar (semua kolom) atau array per kolom.                                 |
| `alignNumeric`  | `true`    | `"auto"` → kolom yang **semua isi body-nya angka** rata-kanan (header diabaikan).                          |
| `padding`       | `1`       | Spasi kiri+kanan tiap sel. `0` = rapat (`│A│B│`).                                                          |
| `width`         | lebar TTY | Lebar **total** tabel; bila konten lebih lebar, kolom terlebar menyusut lebih dulu.                        |
| `colWidths`     | —         | Lebar tetap per kolom (`null` = otomatis). Kolom ini tidak pernah menyusut.                                |
| `minColWidth`   | `3`       | Batas bawah saat menyusut.                                                                                 |
| `maxColWidth`   | —         | Batas atas lebar kolom.                                                                                    |
| `wrap`          | `false`   | `false` = potong + elipsis; `true` = bungkus jadi beberapa baris.                                          |
| `ellipsis`      | `"…"`     | Karakter elipsis (pakai `"..."` untuk LCD/terminal tanpa Unicode).                                         |
| `headSeparator` | `true`    | Garis pemisah setelah header.                                                                              |
| `color`         | `true`    | Warna ANSI tabel (juga tunduk pada `setColorEnabled()` global).                                            |
| `style`         | —         | `{ border, head, body, divider }` — tiap bagian `PaintOptions`.                                            |
| `indent`        | `0`       | Geser seluruh tabel ke kanan `n` sel.                                                                      |
| `stretch`       | `false`   | Bagi sisa lebar ke kolom (rata penuh, gaya `ps`).                                                          |

### Method

| Method                                               | Kegunaan                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| `push(...cells)` / `addRow(cells)` / `addRows(rows)` | Menambah baris (`this`, bisa dirantai).                         |
| `separator()`                                        | Sisipkan garis horizontal di posisi sekarang.                   |
| `setHead(cells)`                                     | Ganti header.                                                   |
| `render(override?)` / `toString()`                   | Kembalikan string (baris digabung `\n`, tanpa newline penutup). |
| `toLines(override?)`                                 | Kembalikan `string[]` (mis. untuk dicetak per baris).           |
| `print(std, { width?, newline? })`                   | Render + `std.print()`. Lebar otomatis dari `SCREEN_INFO` − 1.  |
| `Table.fromRecords(records, columns?, opts?)`        | Bangun dari array objek (hasil query/syscall).                  |
| `rowCount`                                           | Jumlah baris body (garis pemisah tidak dihitung).               |

Fungsi sekali pakai: `renderTable(head, rows, opts?)` dan
`printTable(std, head, rows, opts?)`.

### Preset warna

```ts
import { TABLE_THEMES } from "@tsix/tableLib";

TABLE_THEMES.plain; // tanpa warna (untuk output ke file/LCD)
TABLE_THEMES.classic; // border abu, header bold putih
TABLE_THEMES.accent; // border abu, header bold cyan (aksen TSIX)
```

Border memakai `brightblack` (abu) supaya tabel tetap terbaca di tema gelap
maupun terang.

---

## `@tsix/ansiLib`

```ts
import { paint, tone, displayWidth, truncate, wrap, padEnd } from "@tsix/ansiLib";
```

| Fungsi                                                            | Keterangan                                                                                                     |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `paint(text, opts)`                                               | SGR: `{ fg, bg, bold, dim, italic, underline, blink, inverse, hidden, strike }`, atau array `["red", "bold"]`. |
| `paint(text, 208)` / `paint(text, "#ff8800")`                     | xterm-256 & truecolor (juga menerima `[r,g,b]`).                                                               |
| `tone.title/accent/success/warning/danger/info/muted/label/value` | Palet semantik CLI (dipakai bersama agar warna konsisten).                                                     |
| `displayWidth(text)`                                              | Lebar dalam **sel TTY** (ANSI = 0, LF/CR = 0, emoji = 2, sisanya = 1 per code unit).                           |
| `stripAnsi(text)` / `takeWidth(text, n)`                          | Buang ANSI / ambil `n` sel pertama.                                                                            |
| `truncate(text, n, ellipsis?)`                                    | Potong aman-ANSI; SGR yang terbuka ditutup sebelum elipsis.                                                    |
| `wrap(text, n)`                                                   | Word-wrap ANSI-aware; `\n` = baris paksa.                                                                      |
| `padEnd` / `padStart` / `center`                                  | Padding yang tidak menghitung ANSI.                                                                            |
| `setColorEnabled(bool)` / `isColorEnabled()`                      | Saklar global.                                                                                                 |
| `detectColor({ TERM, NO_COLOR, FORCE_COLOR })`                    | Deteksi dari environment (pola `NO_COLOR` standar).                                                            |

### Nama warna

Dasar: `black red green yellow blue magenta cyan white`.
Terang: `brightblack` (abu) `brightred` … `brightwhite` (alias `gray`/`grey`).
Angka `16..255` = xterm-256 (`38;5;N`), `#rgb`/`#rrggbb`/`[r,g,b]` = truecolor.

---

## Catatan penting untuk console TSIX

1. **Selalu cetak lewat `std.print()`** — `console.log` / `process.stdout.write`
   di worker menuju stdout **host** (terminal `bootstrap.sh`), bukan TTY app.
2. **Warna tunduk pada `TTY.handleANSI()`** yang hanya mem-parse subset:
   SGR `m`, `J`, `K`, `A/B/C/D`, `H/f`, `S/T`, `L/M`, `s/u`. Kedua lib ini hanya
   menghasilkan SGR, jadi tidak ada escape yang muncul sebagai sampah.
3. **Mode bitmap-font (pixelterm/retroterm)** menyintesis bold → glyph bisa
   terlihat kabur. Untuk tabel panjang, `TABLE_THEMES.plain` atau warna
   `bright*` lebih nyaman dibaca.
4. **Glyph lebar (CJK/emoji)** dihitung sesuai TTY, jadi kolom tetap lurus —
   tapi font bitmap mungkin tidak punya glyph-nya. Untuk LCD (`/dev/lcd`,
   `@tsix/lcdLib`) pakai `charset: "ascii"` + `ellipsis: "..."`.
5. **Resize jendela**: pixelterm/retroterm mengirim `ioctl(fd, 3, {...})` +
   `SIGWINCH`; panggil ulang `table.print(std)` agar lebar menyesuaikan.

---

## Demo

```sh
/opt/test/table-demo                     # semua demo
/opt/test/table-demo --charset rounded   # bingkai lain
/opt/test/table-demo --width 60          # lebar dipaksa
/opt/test/table-demo --no-color          # output polos
/opt/test/table-demo --section dasar,ansi
```

## File terkait

| Berkas                              | Isi                                                             |
| ----------------------------------- | --------------------------------------------------------------- |
| `src/mirror/lib/ansiLib.ts`         | Primitif SGR + `displayWidth()` (setia TTY).                    |
| `src/mirror/lib/tableLib.ts`        | Table builder + charset + tema.                                 |
| `src/mirror/lib/ansiLib.test.ts`    | 25 unit test (lebar, padding, wrap, warna, detect).             |
| `src/mirror/lib/tableLib.test.ts`   | 41 unit test (bingkai, perataan, penyusutan, warna, `print()`). |
| `src/mirror/opt/test/table-demo.ts` | Demo interaktif.                                                |
| `src/kernel/tty/TTY.ts`             | Acuan semantik lebar & daftar ANSI yang didukung.               |
