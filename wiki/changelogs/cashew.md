# Changelog Cashew GUI Framework

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-09-04

### `TImage` kini punya `onClick` — gambar bisa diklik (ikon, bulbon/off, dsb)

- **File:** `src/mirror/lib/cashew.ts`
- **Perubahan:**
  - `TImage` menambah properti `onClick` (pola sama seperti `TButton`): saat ada handler & `build()` dipanggil → otomatis `props.onClickId = this.id` (listener **mount-time**, hindari bug `cloneNode` DOME) + `style.cursor = "pointer"`; `bindEventHandler` mendaftarkan `screen.on(this.id, "click", onClick)`.
  - DOME client memasang listener klik untuk `onClickId` di elemen apa pun — termasuk `<img>` — jadi gambar yang bisa diklik tinggal `img.onClick = ...`.
- **Contoh:**
  ```ts
  const lamp = new TImage("bulb-0", {
    file: "/opt/bulbon.png",
    width: 40,
    height: 40,
  });
  lamp.onClick = () => std.log("lampu diklik!");
  form.add(lamp);
  ```
- **Oleh:** Copilot

## 2026-08-30

### TFlowPanel default full-width di grid (`gridColumn: "1 / -1"`)

- **File:** `src/mirror/lib/cashew.ts`
- **Perubahan:** `TFlowPanel` kini menyertakan **default `gridColumn: "1 / -1"`** di style-nya — diletakkan **sebelum** `...extraStyle`, jadi tetap bisa di-override user. Karena `TFlowPanel` paling sering dipakai sebagai baris penuh (section) di dalam `TGridPanel`/form grid, user tidak perlu set `gridColumn` manual lagi.
- **Dampak:** `TFlowPanel("sensor-row")` langsung full-width saat jadi child grid. Di parent non-grid properti diabaikan browser (aman). Override tetap jalan: `TFlowPanel("row", { gridColumn: "2 / 3" })`.
- **Oleh:** Copilot · **Konsep:** kakang

## 2026-08-30

### Unifikasi pola opsi — semua komponen kini domain-separated (props di atas + style: {} di bawah)

- **File:** `src/mirror/lib/cashew.ts`
- **Latar:** Sebelumnya ada dua pola berbeda: widget IoT memakai props + `style:{}` (domain-separated), sedangkan komponen sederhana memakai objek sebagai flat-style langsung. Sekarang disatukan.
- **Perubahan:**
  - Helper baru `splitConfig(config, knownProps)` — memisahkan opsi objek literal menjadi **props komponen** (key di `knownProps`, diterapkan via setter) dan **css** (gabungan `style:{}` nested + key lain).
  - Komponen sederhana (`TPanel`, `TLabel`, `TButton`, `TEdit`, `TMemo`, `TCheckBox`, `TComboBox`, `TStatusBar`, `TProgressBar`) kini menerima **props + `style:{}`**, misalnya:
    ```ts
    new TButton({
      caption: "OK",
      enabled: false,
      style: { background: "#222" },
    });
    new TEdit({
      text: "halo",
      placeholder: "Ketik...",
      style: { width: "200px" },
    });
    new TComboBox({
      items: ["A", "B"],
      selectedIndex: 0,
      style: { width: "140px" },
    });
    new TProgressBar({
      value: 50,
      min: 0,
      max: 100,
      unit: "%",
      style: { height: "24px" },
    });
    new TStatusBar({ leftText: "Siap", style: { padding: "8px 12px" } });
    ```
  - **Backward-compat penuh:** flat style (`new TButton("btn", { background: "#222" })`) dan setter (`btn.caption = "OK"`) tetap bekerja — key yang bukan prop komponen dianggap CSS.
  - `TListBox` kini bisa `new TListBox({ items: [...], style: {...} })` (selain `new TListBox("id")` + setter).
  - `TRadioButton` kini bisa `new TRadioButton({ caption, group, checked, style })` (selain `(id, group, extraStyle)`).
  - `TGroupBox` kini bisa `new TGroupBox({ caption, style })` (selain `(id, caption, extraStyle)`).
  - `TChart` ikut menerapkan `style:{}` (di-merge ke `this.style`, dipakai base build).
  - **Urutan penting:** `TStatusBar`/`TProgressBar` menerapkan props di akhir constructor (setelah sub-komponen dibuat), karena setter-nya (`leftText`, `value`, dll.) memakai sub-komponen internal.
- **Dampak:** Satu konvensi di seluruh framework — props komponen ditulis langsung di opsi, styling di bawah key `style`. Nama prop komponen tidak ada yang bertabrakan dengan properti CSS (`min`/`max` di `TProgressBar` aman karena CSS pakai `min-width`/`min-height`).
- **Oleh:** Copilot

## 2026-08-30

### Opsi objek literal widget IoT kini menerapkan styling (style)

- **File:** `src/mirror/lib/cashew.ts`, `src/mirror/lib/emerald.ts`
- **Masalah:** Widget IoT Cashew (`TRadialGauge`, `TLineChart`, `TSevenSegment`, `TIndicatorLamp`, `TToggleSwitch`, `TVerticalGauge`, `TSensorCard`, `TRelayCard`, `TSlider`) menerima opsi objek literal, tapi `style` yang dikirim lewat opsi itu **tidak pernah diterapkan** — fungsi widget Emerald membangun kartu luar dengan style hardcoded dan mengabaikan prop `style`.
- **Perubahan:**
  - **Emerald:** semua fungsi widget (`sensorCard`, `relayCard`, `lineChart`, `radialGauge`, `sevenSegment`, `indicatorLamp`, `toggleSwitch`, `verticalGauge`, `slider`) kini menerima prop **`style`** dan meng-merge-nya **di atas** style default kartu (`{ ...default, ...props.style }`). Blok `Props:` di-dokumentasikan.
  - **Cashew:** wrapper widget menyinkronkan `style` dari opsi objek literal ke `this.style` — konsisten dengan komponen Cashew lain (`comp.style` kini merefleksikan opsi yang dikirim).
- **Contoh:**
  ```ts
  const gauge = new TRadialGauge({
    value: 72,
    style: { width: "220px", background: "#111" },
  });
  const card = new TSensorCard({ label: "Temp", style: { minWidth: "220px" } });
  ```
- **Dampak:** User bisa mengkustomisasi kartu luar widget IoT langsung dari opsi objek literal (atau lewat `comp.style`).
- **Oleh:** Copilot

## 2026-08-30

### id komponen otomatis — user tidak perlu lagi mengisi id di constructor

- **File:** `src/mirror/lib/cashew.ts`
- **Perubahan:**
  - `id` di semua komponen (`TComponent` + turunan: `TPanel`, `TLabel`, `TButton`, `TEdit`, `TMemo`, `TCheckBox`, `TListBox`, `TRadioButton`, `TComboBox`, `TStatusBar`, `TProgressBar`, `TLineChart`, `TRadialGauge`, `TSevenSegment`, `TIndicatorLamp`, `TToggleSwitch`, `TVerticalGauge`, `TSensorCard`, `TRelayCard`, `TSlider`, `TTimer`, `TChart`, `TDataGrid`, `TTabulatorGrid`, `TImage`, dll.) kini **opsional** — kalau tidak diisi, di-generate otomatis dari nama class (`TButton` → `button_1`, `button_2`, ...; readable saat debug di browser).
  - `id` tetap dibutuhkan **internal** (Emerald/DOM: mount, event binding, `screen.update`/`setContent`, `onClickId`/`onInputId` untuk routing event di browser) — hanya saja user tidak perlu repot mengisinya lagi.
  - **Object-first:** komponen yang menerima style/props bisa dipanggil langsung dengan object tanpa id — `new TButton({...})`, `new TSensorCard({...})`, `new TPanel({...})`.
  - `TStatusBar`/`TProgressBar`/`TGroupBox` yang menurunkan id sub-komponen kini memakai `this.id` (id hasil auto-generate), bukan `id` param.
  - `TTimer` disederhanakan: `new TTimer(id?, interval?, enabled?)` — id opsional; bisa juga **object literal** `new TTimer({ interval, enabled })` (id auto-generate).
  - `TDataGrid`/`TTabulatorGrid`: `new TDataGrid(id?, columns?, data?, opts?)` — id opsional, `ConnectedDataGrid`/`ConnectedTabulator` menerima `this.id` yang sudah ter-resolve.
  - **Kompatibel ke belakang** — semua pemanggilan `new TButton("btn", {...})`, `new TSensorCard("temp", {...})`, `new TTabulatorGrid("sensor", cols, ...)` lama tetap bekerja.
- **Dampak:** User cukup `new TButton()` + set properti via instance (atau `new TButton({...})`), tidak perlu menebak id unik. Id unik dijamin oleh counter global per proses.
- **Oleh:** Copilot

## 2026-08-18

### Penambahan paramater left, top dan desktopCentered untuk positioning TForm

## 2026-08-08

### TForm — opsi window (maximizable/resizable/fullscreen/frameless) + overload constructor object literal

- **File:** `src/mirror/lib/cashew.ts`, `wiki/cashew-in-a-nutshell.md`
- **Perubahan:**
  - `TForm` kini meneruskan `maximizable`, `resizable`, `fullscreen`, `frameless` ke `Screen` (sebelumnya hanya `title`/`width`/`height` → tombol maximize tidak bisa disembunyikan dari sisi Cashew).
  - Constructor **overload dua bentuk**: sequential `new TForm(title, width, height, maximizable, resizable, fullscreen, frameless)` DAN object literal `new TForm({ title, width, height, maximizable, resizable, fullscreen, frameless })` via interface `TFormOptions` (diexport).
  - Setter properti baru: `form.maximizable`, `form.resizable`, `form.fullscreen`, `form.frameless`.
  - **Opsi `style`** di `TFormOptions` (object literal): style tambahan (margin, padding, background, dll) di-merge di atas style default form.
  - Kompatibel ke belakang — semua pemanggilan `new TForm("title", w, h)` lama tetap bekerja.
  - Dokumentasi `wiki/cashew-in-a-nutshell.md` disinkronkan (kedua bentuk pemanggilan + tabel opsi + contoh `style`).
- **Dampak:** Aplikasi Cashew bisa mengontrol perilaku window (maximize off, frameless, fullscreen) dan styling form (margin/padding/background) langsung dari konstruktor. Contoh: `new TForm({ title: "App", width: 500, height: 100, maximizable: false, style: { padding: "0" } })`.
- **Oleh:** Copilot

## 2026-08-03

### DataGrid — satu scroll container + sticky th (robust scroll & alignment)

- **File:** `src/mirror/lib/emerald.ts` (ConnectedDataGrid), `src/mirror/bin/dome-client.html`
- **Masalah (iterasi panjang):** Desain dua-region (header & body tabel terpisah) gagal menjaga lebar kolom konsisten: header tidak ikut scroll horizontal, kolom terakhir lebih sempit/lebar, lebar hasil drag tidak sinkron ke baris data, kompensasi `scrollbar-gutter`/`calc()` rapuh lintas lingkungan.
- **Perubahan:**
  - **Struktur jadi SATU scroll container:** `body-scroll` (overflow:auto) menampung header table + `<style>` + body table. Header di-pin via **`th` sticky** (`position: sticky; top: 0; z-index: 2`), pola yang sama dengan `dataGrid()` statis.
  - **Dampak:** Scroll horizontal & vertikal otomatis sinkron (header ikut geser bareng body). Lebar tabel header == body == lebar container — kolom selalu sejajar termasuk di ujung scroll. Tidak perlu kompensasi manual (hapus `thead-scroll` wrapper, hapus relay `scrollLeft`, hapus `scrollbar-gutter`, hapus `calc(100% - scrollbar)`).
  - **Resize kolom:** scope `wrap` di-resize handler kini `table.closest(".tsix-dgrid")` → colgroup header & body ikut resize saat drag.
- **Dampak:** Semua aplikasi TDataGrid (Bitshark, DB Browser, dll) sekarang scroll horizontal & vertikal sinkron, lebar kolom konsisten. Dua-region dihapus sepenuhnya.

### DataGrid — paint per-sel (box-shadow + background) untuk separator & zebra

- **File:** `src/mirror/lib/emerald.ts` (ConnectedDataGrid)
- **Masalah:** Kolom terakhir (yang overflow / "ngumpet" ke kanan) kehilangan styling (separator & latar) saat discroll — border tabel tidak ikut repaint oleh Chromium pada sel yang baru masuk viewport horizontal. Pendekatan via `border-collapse: collapse` / `translateZ(0)` gagal atau menimbulkan efek samping lebar tabel.
- **Perubahan:**
  - Separator antar-kolom & antar-baris pindah dari `border-right`/`border-bottom` ke **`box-shadow: inset`** (dicat bersama elemen sel, bukan mesin border tabel).
  - Zebra background pindah dari `tr` ke **`td` inline** (tiap sel mandiri).
  - CSS hover/selected menarget `td` (bukan `tr`) agar background tetap override dengan benar.
  - Kolom terakhir TIDAK lagi dikecualikan — semua kolom seragam (hapus `th:last-child, td:last-child { border-right: none }`).
- **Dampak:** Separator & background dicat bersama sel → andal repaint saat sel masuk viewport. Hover/selected tetap berfungsi. **Diketahui:** kolom terakhir masih dapat kehilangan styling pada batas overflow di beberapa konfigurasi browser — belum fully resolved.
- **Oleh:** Copilot

---

## 2026-08-02

### DataGrid — appendData() INKREMENTAL (hemat traffic WS)

- **File:** `src/mirror/lib/emerald.ts` (ConnectedDataGrid), `src/mirror/lib/cashew.ts` (TDataGrid)
- **Masalah:** `setData()` tiap kali rebuild seluruh tbody (`setContent` = clear + mount semua baris) → seluruh data dikirim ulang ke browser. Untuk data yang terus bertambah (sniffer, log, telemetry) ini boros WS.
- **Perubahan:**
  - **Row ID berbasis kunci stabil:** ID baris DOM berubah dari `dg-row-<indexTampil>` → `dg-row-<rowKey>` (pakai `rowKeys` WeakMap yang sudah ada). Pemangkasan dari depan tidak lagi menggeser ID → tidak salah klik. `selectRow(rIdx)` → `selectRowByKey(key)`; `applySelectionVisual` kini patch langsung by key (lebih sederhana). API publik tidak berubah (onRowClick/onRowCtx tetap terima kunci stabil + salinan record).
  - **`appendData(records)`** baru: tanpa sort → **mount per baris baru** saja (`win.mount(node, bodyId)`), bukan rebuild seluruh tbody. Ada sort aktif → fallback render penuh agar urutan tetap benar. Diproteksi mutex (serial dengan render penuh).
  - **Opsi `maxRows`** (constructor): batas baris tampil; baris tertua dipangkas dari depan + DOM-nya di-unmount. Default 0 = tanpa batas.
  - **`TDataGrid`:** opsi `maxRows` diteruskan + method `appendData(records)`.
- **Dampak:** 1 baris baru = 1 mount kecil ke WS (bukan seluruh tabel). Semua aplikasi berbasis grid bisa memakai `grid.appendData()` langsung.
- **Oleh:** Copilot

### DataGrid — mutex render serialization (cegah race condition)

- **File:** `src/mirror/lib/emerald.ts` (ConnectedDataGrid)
- **Masalah:** Render async (`setContent` → `bindHandlers`) bisa saling menimpa saat data baru datang di tengah render → order tampil kacau / duplikat.
- **Perubahan:** `render()` kini dilindungi mutex (render baru menunggu render sebelumnya selesai). `setData()` meng-clone array input agar tidak termutasi saat render.
- **Dampak:** Urutan data stabil walau data masuk cepat. Diverifikasi dengan regression test (`emerald.test.ts`).
- **Oleh:** Copilot

---

## 2026-08-01

### DataGrid — lebar kolom hasil drag PERSISTEN (fix "kolom melebar sendiri")

- **File:** `src/mirror/lib/emerald.ts` (ConnectedDataGrid), `src/mirror/bin/dome-client.html`, `scripts/vfs-bootstrap.ts`
- **Bug:** Setelah user mengubah lebar kolom via drag, lebar bisa reset/"melebar" sendiri saat klik kolom (sort → render ulang) — lebar hasil drag hanya hidup di DOM browser (ephemeral), tidak dipegang oleh app.
- **Perubahan:**
  - **`dome-client.html`:** Saat drag handle selesai (mouseup), browser mengirim event `col_resized` ke app (`{ key, width }`, targetId = wrapId grid) via socket — DOME relay generik (tidak perlu whitelist baru).
  - **`emerald.ts`:** `ConnectedDataGrid` kini **memiliki state lebar kolom** (`colWidths: Map<key, number>`):
    - `build()` memakai `colWidths.get(key) ?? c.width` untuk lebar `<col>`.
    - `mount()` mendengarkan `col_resized` via `bindHandler(wrapId, ...)` → simpan lebar.
    - `render()` memanggil `applyColWidths()` — re-apply lebar ke semua colgroup (header+body) + `<th>` di SETIAP render (sort/refresh/setData) → lebar TETAP sampai user drag lagi.
  - **`scripts/vfs-bootstrap.ts`:** Ditambah dukungan sync `.html`/`.css` — sebelumnya `dome-client.html` TIDAK ikut tersinkron ke VFS (hanya .ts/.js/.json), sehingga edit HTML tidak pernah sampai ke sistem berjalan.
- **Dampak:** Lebar kolom hasil drag bertahan melintasi semua jalur render (diverifikasi live: drag 160px/182px bertahan setelah klik sort DAN tombol Refresh).
- **Oleh:** Copilot

---

## 2026-07-31

### DataGrid — selection berbasis row-key stabil (INDEX ≠ ROW NUMBER)

- **File:** `src/mirror/lib/emerald.ts` (ConnectedDataGrid), `src/mirror/lib/cashew.ts` (TDataGrid)
- **Perubahan:**
  - **Konsep:** Klik row menyimpan **row-key stabil** (di-generate saat row masuk, cache via WeakMap), bukan posisi baris. Referensi object yang sama → kunci yang sama → tahan sort & refresh.
  - API baru: `onRowClick(index, record)`, `selectedIndex`, `selectedRecord`, `getRecord(index)`, `setSelectedIndex(index)`, `clearSelection()`.
  - `setData()` reset seleksi hanya jika array berubah; refresh dengan array sama → seleksi dipertahankan.
- **Dampak:** Cursor DataGrid menempel ke record (bukan posisi) — fondasi untuk TDBDataGrid / ClientDataSet delta.
- **Oleh:** Copilot

### DataGrid — hover + targeted selection (tanpa reset scroll)

- **File:** `src/mirror/lib/emerald.ts`
- **Perubahan:**
  - Hover row via CSS (`.dg-row:hover`) di styleNode — murni CSS karena DOME hanya relay click/input/keydown.
  - Seleksi (klik row, `setSelectedIndex`, `clearSelection`) kini **targeted update className** pada 2 baris saja, bukan rebuild tbody — sebelumnya `setContent` me-reset `scrollTop` ke atas.
- **Dampak:** Klik row di grid panjang tidak lagi melompat ke atas; highlight tetap ikut record saat sort.
- **Oleh:** Copilot

### DataGrid — kolom separator + resizable columns

- **File:** `src/mirror/lib/emerald.ts`, `src/mirror/bin/dome-client.html`
- **Perubahan:**
  - **Separator kolom:** border-right antar th/td (kecuali kolom terakhir) via CSS di styleNode.
  - **Resize kolom:** handle 6px di tepi kanan th (`data-col-resize`) → drag native di browser menyesuaikan lebar `<col>` di colgroup. Flag `resizable?: boolean` per kolom (default true). Lebar manual bertahan saat setData/sort (thead/colgroup tidak di-rebuild).
- **Dampak:** Tabel lebih terbaca + kolom bisa di-resize seperti spreadsheet.
- **Oleh:** Copilot

### DataGrid — row context menu + bindHandler diperlebar

- **File:** `src/mirror/lib/emerald.ts`, `src/mirror/bin/taskmgr.ts`
- **Perubahan:**
  - `ConnectedDataGrid.mount(screen, onSort?, onRowClick?, onRowContextMenu?)` — tiap row dapat `onContextMenuId` + bind `contextmenu`, callback `(index, record, x, y)`.
  - `Window.bindHandler` signature `eventType` diperlebar dari `"click" | "input" | "keydown"` → `string` (fix pre-existing error `bindHandler(rid, "contextmenu")` di taskmgr).
- **Dampak:** Grid bisa dipakai untuk app dengan menu klik-kanan.
- **Oleh:** Copilot

### Task Manager — ditulis ulang pakai DataGrid

- **File:** `src/mirror/bin/taskmgr.ts`
- **Perubahan:** Tabel proses manual (div rows) diganti `ConnectedDataGrid` — kolom Icon/PID/Name/State/User, sortable, resizable, seleksi row. Context menu klik-kanan (Close SIGTERM / Kill SIGKILL) tetap dipertahankan via `onRowContextMenu`.
- **Dampak:** Task Manager konsisten dengan toolkit DataGrid; otomatis dapat hover, separator, sort.
- **Oleh:** Copilot

---

## 2026-07-30

### TChart — Multi-series support

- **File:** `src/mirror/lib/cashew.ts`, `src/mirror/bin/dome-client.html`
- **Perubahan:**
  - Constructor TChart terima opsi `series: [{ key, color, label, minValue, maxValue }]`
  - `pushData(x, values)` — values berupa object `{ cpu: 55, mem: 45 }`, bukan single number
  - Data disimpan per-series di `_seriesData[key]`, auto-shift via `maxPoints`
  - Data dikirim ke DOME format `{ x: [...], series: { cpu: [...], mem: [...] } }`
  - Browser (dome-client.html) bikin multiple `LightweightCharts.LineSeries` sesuai konfigurasi
  - Series dengan `minValue`/`maxValue` pake price scale terpisah (contoh: temperature 15-45°C vs CPU 0-100%)
  - Backward compatible: `pushData(x, y)` single series tetap jalan
- **Dampak:** Satu chart bisa nampilin beberapa metrik sekaligus dengan warna dan skala berbeda.
- **Oleh:** Copilot

### TVerticalGauge — Dual-layer text masking

- **File:** `src/mirror/lib/emerald.ts`, `src/mirror/lib/cashew.ts`
- **Perubahan:**
  - Value text digambar dua lapis: satu warna theme (di atas air), satu putih (di dalam air, clipped)
  - Clip path (`wg-clip-*`) bergerak bareng permukaan air via `translateY` yang sama
  - `setValue()` update posisi clip + kedua teks
- **Dampak:** Value gauge selalu terbaca — warna otomatis menyesuaikan background cairan vs background card.
- **Oleh:** Copilot

### TSevenSegment — Opsi scale & height

- **File:** `src/mirror/lib/emerald.ts`
- **Perubahan:**
  - `props.scale` — perbesar/ perkecil seven segment (SVG width/height, gap, stroke-width dikali scale)
  - `props.height` — dibaca dan diterapkan ke style outer container
- **Dampak:** Seven segment bisa di-scale 2x, 3x, dan memenuhi container dengan `height: "100%"`.
- **Oleh:** Copilot

### TChart — Internal data buffer + pushData

- **File:** `src/mirror/lib/cashew.ts`
- **Perubahan:**
  - `pushData(x, y)` — cukup push satu titik, urusan shifting diurus internal via `maxPoints`
  - `setData(xData, yData)` — replace semua data, tetap auto-shift
- **Dampak:** Developer tidak perlu kelola array history manual.
- **Oleh:** Copilot

### Schedule flush — setTimeout (stabil)

- **File:** `src/mirror/lib/emerald.ts`
- **Perubahan:** Setelah test `setImmediate` vs `setTimeout`, balik ke `setTimeout(0)` karena lebih stabil untuk event loop.
- **Dampak:** - (rollback)
- **Oleh:** Copilot

---

## 2026-07-29

### TCheckBox & TRadioButton — simbol besar, caption kecil

- **File:** `src/mirror/lib/cashew.ts`
- **Perubahan:**
  - Simbol (`☑`/`☐` untuk checkbox, `●`/`○` untuk radiobutton) dirender sebagai `<span>` child terpisah dengan `fontSize: 24px`.
  - Caption dirender di `<span>` child terpisah dengan `fontSize: 12px`.
  - **Bug fix:** Double caption terjadi karena `this.props.text` (dari setter `caption`) ikut tersebar ke parent div. Fix: `const { text: _t, ...restProps } = this.props` di `build()`.
  - Click handler update hanya child simbol (`${id}_sym`), bukan seluruh parent.
- **Dampak:** Tampilan checkbox/radio lebih jelas — simbol besar mudah dikenali, caption tetap rapi 12px.
- **Oleh:** Copilot
