# 🥜 Cashew Framework — Delphi-style GUI untuk TSIX

**Cashew** adalah framework GUI deklaratif untuk TSIX yang mengadopsi pola komponen ala **Delphi / Turbo Pascal**. Tujuannya: bikin kode GUI lebih flat, mudah dibaca, dan bebas dari nesting berlebihan.

---

## 📦 Instalasi

Cashew sudah termasuk dalam library TSIX. Tinggal import:

```typescript
import {
  // Window & dasar
  TForm,
  TDialogs,
  TComponent,

  // Input & kontrol dasar
  TLabel,
  TButton,
  TEdit,
  TMemo,
  TCheckBox,
  TRadioButton,
  TComboBox,
  TListBox,
  TStatusBar,
  TSlider,

  // Container
  TPanel,
  TGroupBox,

  // Layout helpers
  TScrollBox,
  TFlowPanel,
  TGridPanel,
  TSplitHorizontal,
  TSplitVertical,
  HStack,
  VStack,
  Spacer,
  alTop,
  alBottom,
  alLeft,
  alRight,
  alClient,
  alCenter,

  // IoT Widgets
  TSensorCard,
  TRelayCard,
  TLineChart,
  TRadialGauge,
  TSevenSegment,
  TIndicatorLamp,
  TToggleSwitch,
  TVerticalGauge,
  TChart,

  // Timer
  TTimer,

  // Data Grid
  TDataGrid,
  TTabulatorGrid,

  // Progress Bar & Gambar
  TProgressBar,
  TImage,
  mimeFromPath,
} from "@tsix/cashew";
```

---

## 🚀 Quick Start

```typescript
import { Program, std } from "@tsix/Application";
import { TForm, TLabel, TButton, TStatusBar } from "@tsix/cashew";

export const main = Program(async () => {
  const form = new TForm("My App", 400, 300);
  let count = 0;

  const lblCounter = new TLabel("counter");
  lblCounter.caption = "Count: 0";
  form.add(lblCounter);

  const btnClick = new TButton("btn-click");
  btnClick.caption = "Klik";
  btnClick.onClick = () => {
    count++;
    lblCounter.caption = "Count: " + count;
  };
  form.add(btnClick);

  const status = new TStatusBar("status");
  status.text = "✅ Siap";
  form.add(status);

  // onSetup opsional — untuk inisialisasi data/event tambahan setelah mount
  // (TForm.run() sudah auto-bind semua event & auto-refresh komponen)
  form.onSetup = async () => {
    // misal: load data awal grid/chart
  };

  await form.run();
});
```

---

## 🧱 Komponen

### TForm — Window Utama

Constructor `TForm` bisa dipanggil **dua cara** (setara): sequential atau object literal.

```typescript
// Bentuk 1 — sequential: (title, width, height, maximizable, resizable, fullscreen, frameless)
const form = new TForm("Judul", 800, 600);
form.style = { ...form.style, background: "#111" };
form.onClose = () => console.log("Closed");
await form.run();

// Bentuk 2 — object literal
const form = new TForm({
  title: "Judul",
  icon: "🚀", // ikon/emoji di kiri title bar (opsional)
  width: 800,
  height: 600,
  maximizable: true, // bisa di-maximize (default true)
  resizable: true, // bisa di-resize (default true)
  fullscreen: false, // mode fullscreen tanpa frame (default false)
  frameless: false, // tanpa titlebar/border (default false)
  style: { padding: "0", margin: "0", background: "#111" }, // style tambahan (di-merge)
});
```

| Opsi          | Tipe                  | Default | Fungsi                                                                       |
| :------------ | :-------------------- | :------ | :--------------------------------------------------------------------------- |
| `title`       | string                | —       | Judul window                                                                 |
| `icon`        | string                | —       | Ikon/emoji di kiri judul title bar (opsional)                                |
| `width`       | number                | `800`   | Lebar window (px)                                                            |
| `height`      | number                | `600`   | Tinggi window (px)                                                           |
| `maximizable` | boolean               | `true`  | Bisa di-maximize                                                             |
| `resizable`   | boolean               | `true`  | Bisa di-resize                                                               |
| `fullscreen`  | boolean               | `false` | Mode fullscreen                                                              |
| `frameless`   | boolean               | `false` | Tanpa titlebar/border                                                        |
| `style`       | `Record<string, any>` | —       | Style tambahan (margin, padding, background, dll) — di-merge di atas default |

Semua opsi juga bisa di-set lewat properti: `form.maximizable = false`, `form.frameless = true`, `form.style = { ...form.style, padding: "0" }`, dst.

| Method                     | Fungsi                       |
| :------------------------- | :--------------------------- |
| `form.add(component)`      | Tambah komponen              |
| `form.alert(title, msg)`   | Dialog info                  |
| `form.confirm(title, msg)` | Dialog konfirmasi            |
| `form.update(id, props)`   | Update props elemen tertentu |
| `form.screen`              | Akses Screen (buat TDialogs) |
| `form.onSetup`             | Callback setelah mount       |
| `form.onClose`             | Callback saat form ditutup   |

**Window control** — semua async, delegasi ke `Screen.win`:

```typescript
await form.maximize(); // perbesar ke ukuran penuh viewport
await form.unMaximize(); // kembalikan dari maximized (alias: form.unmaximize())
await form.minimize(); // sembunyikan window (iconify)
await form.restore(); // kembalikan window yang di-minimize
await form.close(); // tutup form + hancurkan aplikasi (triggers onClose)
```

| Method              | Fungsi                                                                                                                                            |
| :------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------ |
| `form.maximize()`   | Perbesar window ke ukuran penuh viewport                                                                                                          |
| `form.unMaximize()` | Kembalikan window dari maximized ke ukuran sebelumnya (alias `unmaximize()`)                                                                      |
| `form.restore()`    | Kembalikan window yang sedang di-minimize                                                                                                         |
| `form.minimize()`   | Sembunyikan window (iconify) — tetap hidup, bisa di-restore                                                                                       |
| `form.close()`      | **Tutup form & hancurkan aplikasi** — `running=false`, bersihkan timer, `DESTROY_WINDOW` → `Program()` selesai; ikut memanggil callback `onClose` |

> **Catatan:** Method window control hanya valid setelah `form.run()` dipanggil (butuh `Screen` yang sudah di-mount).

### TPanel — Container

```typescript
// Tanpa extra style
const pnl = new TPanel("panel1");

// Dengan extra style
const pnl = new TPanel("panel1", { marginTop: "8px", background: "#222" });
```

### TLabel — Teks

```typescript
const lbl = new TLabel("lbl-nama");
lbl.caption = "Hello World"; // otomatis update ke layar (setelah bind)
```

### TButton — Tombol

```typescript
// Constructor: (id, extraStyle?)
const btn = new TButton("btn-save", {
  color: "#4caf50",
  marginRight: "5px",
});
btn.caption = "Simpan";
btn.enabled = false; // disable/enable tombol
btn.onClick = () => {
  /* action */
};
```

### TEdit — Input Teks

```typescript
const edt = new TEdit("edt-email");
edt.placeholder = "Masukkan email...";
edt.onInput = (val) => console.log(val);
```

### TMemo — Textarea Multiline

```typescript
const memo = new TMemo("memo-catatan");
memo.text = "Baris 1\nBaris 2";
memo.rows = 5;
```

### TCheckBox — Checkbox

```typescript
const chk = new TCheckBox("chk-aktif");
chk.caption = "Aktifkan";
chk.checked = true;
chk.onClick = (checked) => console.log(checked);
```

### TRadioButton — Radio Button (Grouped)

```typescript
// Constructor: (id, groupName?, extraStyle?)
const rb1 = new TRadioButton("rb-merah", "warna");
rb1.caption = "Merah";
rb1.checked = true;
rb1.onClick = () => console.log("Merah");

const rb2 = new TRadioButton("rb-hijau", "warna");
rb2.caption = "Hijau";

// Group = "warna" — milih hijau otomatis uncheck merah
```

### TComboBox — Dropdown

```typescript
const cmb = new TComboBox("cmb-mode");
cmb.items = ["Auto", "Manual", "Scheduled"];
cmb.selectedIndex = 0;
cmb.onChange = (idx, item) => console.log(item);
```

### TListBox — Daftar Pilihan

```typescript
const lb = new TListBox("lst-sensor");
lb.items = ["Sensor 1", "Sensor 2", "Sensor 3"];
lb.onClick = (idx, item) => console.log(item);
// TForm.run() auto-refresh saat mount; kalau items berubah saat runtime,
// panggil lb.refresh(screen) manual untuk rebuild item
```

### TStatusBar — Status Bar

```typescript
const status = new TStatusBar("status");
status.text = "✅ Ready";
```

---

## 🌡️ IoT Widgets

Komponen IoT siap pakai — semuanya bisa di-update runtime lewat method `setXxx()` (targeted update ke browser, tanpa rebuild seluruh DOM). Cocok untuk dashboard sensor/relay.

### TSensorCard — Kartu Sensor

Kartu berisi label, ikon, nilai + progress bar.

```typescript
const card = new TSensorCard("temp", {
  label: "Temperature",
  unit: "°C",
  icon: "🌡️",
  color: "#f44336",
  value: 45,
  min: 0,
  max: 100,
});
form.add(card);
await card.setValue(52.5); // update nilai + progress bar (pct otomatis)
```

### TRelayCard — Kartu Relay ON/OFF

```typescript
const relay = new TRelayCard("fan", {
  label: "FAN",
  icon: "🌀",
  color: "#4caf50",
  active: true,
});
form.add(relay);
await relay.setActive(false); // tampil "⚫ OFF" / "🟢 ON"
```

### TLineChart — Line Chart (spline + fill)

```typescript
const chart = new TLineChart("temp-chart", {
  data: [25, 30, 28, 35, 32],
  color: "#f44336",
  spline: true, // kurva halus (Catmull-Rom)
  fill: true, // area di bawah garis
  maxPoints: 15, // auto-scroll saat data penuh
});
form.add(chart);
await chart.setData([26, 31, 29, 36, 33]); // update + animasi scroll
```

### TRadialGauge — Gauge Melingkar

```typescript
const gauge = new TRadialGauge("cpu", {
  value: 72,
  min: 0,
  max: 100,
  color: "#4caf50",
  label: "CPU",
  unit: "%",
  size: 100,
});
form.add(gauge);
await gauge.setValue(80); // targeted arc/needle update (smooth)
```

### TSevenSegment — Display 7-Segment

```typescript
const seg = new TSevenSegment("counter", {
  value: 42.5,
  digits: 4,
  decimals: 1,
  color: "#4caf50",
  scale: 1,
});
form.add(seg);
await seg.setValue(43.2);
```

### TIndicatorLamp — Lampu Indikator (glow)

```typescript
const lamp = new TIndicatorLamp("power", {
  color: "#4caf50",
  on: true,
  label: "POWER",
});
form.add(lamp);
await lamp.setOn(false); // lampu mati + label redup
```

### TToggleSwitch — Switch ON/OFF (bisa diklik)

Otomatis toggle visual + border card saat diklik, lalu panggil `onClick`.

```typescript
const tgl = new TToggleSwitch("fan-toggle", {
  color: "#4caf50",
  on: false,
  label: "FAN",
});
tgl.onClick = async () => {
  console.log("FAN is", tgl.on ? "ON" : "OFF");
};
form.add(tgl);
```

### TVerticalGauge — Tabung Kaca Vertikal

```typescript
const vg = new TVerticalGauge("water", {
  value: 75,
  color: "#2196f3",
  label: "Water Level",
  unit: "%",
  w: 60,
  h: 180,
});
form.add(vg);
await vg.setValue(80); // level air naik smooth
```

### TSlider — Slider Range

Otomatis update value display saat digeser + panggil `onInput`.

```typescript
const sl = new TSlider("brightness", {
  value: 70,
  min: 0,
  max: 100,
  color: "#ffeb3b",
  label: "Brightness",
  unit: "%",
});
sl.onInput = (val) => console.log(val);
form.add(sl);
```

---

## ⏱️ TTimer — Timer ala Delphi

Timer interval yang **otomatis di-cleanup** saat form ditutup (managed timer dari Screen).

```typescript
const timer = new TTimer("tmr-update", 2000, true); // (id, interval ms, enabled)
timer.onTimer = async () => {
  await gauge.setValue(...);
};
form.add(timer);

// Kontrol runtime
timer.enabled = false; // stop
timer.interval = 5000; // ganti interval (auto-restart)
```

---

## 📈 TChart — Real-time Chart (Lightweight Charts)

Chart real-time smooth-scroll via DOME IPC ke browser (library **TradingView Lightweight Charts** v5 di-load di `dome-client.html`). Mendukung **multi-series** dengan range Y per-series (price scale terpisah).

```typescript
const chart = new TChart("sys-chart", {
  width: 300,
  height: 250,
  maxPoints: 60,
  series: [
    {
      key: "temp",
      color: "#f44336",
      label: "Temperature",
      minValue: 15,
      maxValue: 45,
    },
    { key: "cpu", color: "#4caf50", label: "CPU" },
    { key: "mem", color: "#2196f3", label: "Memory" },
  ],
});
form.add(chart);

form.onSetup = async () => {
  await chart.initChart(); // WAJIB — init chart di browser setelah mount
};

// Push satu titik (single series) / multi series
await chart.pushData(Date.now() / 1000, 42); // single
await chart.pushData(Date.now() / 1000, { temp: 30, cpu: 55, mem: 45 }); // multi

// Atau set sekaligus
await chart.setData([t1, t2, t3], [v1, v2, v3]);

// Hancurkan chart
await chart.destroy();
```

---

## 🗃️ Data Grid — TDataGrid & TTabulatorGrid

Dua kelas data grid dengan **API 100% identik** — tinggal ganti class-nya:

- **`TDataGrid`** — render virtual-DOM app-side (berbasis `ConnectedDataGrid` Emerald).
- **`TTabulatorGrid`** — render **di sisi browser** oleh library **Tabulator v6** (sort, resize kolom, selection, scroll ditangani Tabulator sendiri → bebas bug render, traffic IPC jauh lebih kecil). Superset: punya `toggleSort()` tambahan.

```typescript
const grid = new TTabulatorGrid("sensor", [
  { key: "node_id", label: "Node", width: 150 },
  { key: "value", label: "Nilai", width: 80, align: "right" },
  { key: "timestamp", label: "Waktu", width: "40%" },
], [], { height: 300 });
form.add(grid);

// Data awal — di-set via onSetup (dipanggil TForm.run setelah mount)
form.onSetup = async () => {
  await grid.setData([
    { node_id: "espMultiSensor", value: 12, timestamp: "2026-02-24 07:29:37" },
    { node_id: "espMultiSensor", value: 42, timestamp: "2026-02-24 07:29:37" },
  ]);
};

// Event: klik header → sort, klik baris → detail
grid.onSort = (key, dir) => console.log(`sort ${key} ${dir}`);
grid.onRowClick = (idx, rec) => {
  const r = grid.getRecord(idx); // index = row-key stabil (BUKAN nomor baris)
  const sel = grid.selectedIndex;
  console.log("selected:", r?.value);
};

// Properti & metode
grid.columns = [...];               // ganti kolom (design-time / runtime)
await grid.appendData([...]);       // tambah baris INKREMENTAL (hemat traffic)
await grid.setColumns([...]);
await grid.setSelectedIndex(-1);    // clear selection
await grid.clearSelection();
await grid.toggleSort("value");     // ONLY TTabulatorGrid — sort programmatic
const s = grid.sort;                // { key, dir } atau null
```

| Properti / Metode                          | Fungsi                                                                 |
| :----------------------------------------- | :--------------------------------------------------------------------- |
| `columns` / `data` (setter)                | Ganti kolom / data (fire-and-forget; kalau mau await pakai `setXxx()`) |
| `sort`                                     | State sort saat ini: `{ key, dir }` atau `null`                        |
| `selectedIndex` / `selectedRecord`         | Baris terpilih (row-key stabil)                                        |
| `getRecord(index)`                         | Ambil record via row-key                                               |
| `setData(rows)`                            | Ganti data (async)                                                     |
| `appendData(rows)`                         | Tambah baris inkremental (async)                                       |
| `setColumns(cols)`                         | Ganti kolom (async)                                                    |
| `setSelectedIndex(i)` / `clearSelection()` | Select / clear programmatic                                            |
| `toggleSort(key)`                          | Sort programmatic (hanya `TTabulatorGrid`)                             |

> **Catatan kolom:** `DataGridColumn` = `{ key, label, width?, sortable?, resizable?, align? }`. `width` bisa number (px) atau string CSS (`"20%"`). Field data yang tidak terdaftar sebagai kolom (mis. `_name`) tetap bisa dipakai logika app tanpa tampil di grid.

---

## � TProgressBar — Progress Bar

Progress bar dengan **efek XOR klona ganda** — teks persentase selalu terbaca baik di area yang belum terisi (teks redup) maupun yang sudah terisi (teks putih kontras), karena ada teks klona di dalam bar pengisi.

```typescript
const bar = new TProgressBar("progress", {
  height: "22px",           // opsional — tinggi bar
  background: "#1a1a2e",    // opsional — track
});
form.add(bar);

bar.min = 0;
bar.max = 100;
bar.unit = "%";        // satuan (default "%")

bar.value = 45;        // update otomatis: lebar bar + teks klona
bar.value = 78.5;      // angka desimal diformat (78.5%)
```

| Properti      | Fungsi                                     |
| :------------ | :----------------------------------------- |
| `value`       | Nilai saat ini (auto-hitung % dari min/max) |
| `min` / `max` | Rentang (default 0/100)                     |
| `unit`        | Satuan ditampilkan setelah angka (default "%") |

---

## 🖼️ TImage — Komponen Gambar

Komponen gambar ala `TImage`/`TPicture` Delphi. **Input = path file langsung** (mis. `/opt/app/logo.png`) — komponen membaca file via `fs` global, mengubahnya jadi base64 data URI, lalu menampilkan di browser. MIME type di-detect otomatis dari ekstensi file.

```typescript
import { TImage } from "@tsix/cashew";

// 1) Auto-load dari file di constructor:
const img = new TImage("img-logo", {
  file: "/opt/app/logo.png",  // path file gambar VFS
  width: 200, height: 120,    // ukuran (px)
  alt: "Logo",                // teks alternatif
  fit: "contain",             // object-fit: contain | cover | fill | none
});
form.add(img);   // auto-load saat form di-mount

// 2) Load dari file kapan saja:
img.loadFile("/opt/app/logo.png");

// 3) Pakai fsLib sendiri (kalau app punya referensi fs eksplisit):
await img.loadFromFile(fs, "/opt/app/logo.png");

// 4) Set dari base64 langsung (low-level, jarang):
img.setBase64("iVBORw0KGgo...", "image/png");
```

| Properti / Metode          | Fungsi                                                          |
| :------------------------- | :-------------------------------------------------------------- |
| `file`                     | Path file VFS (set → auto-load)                                 |
| `src`                      | URL/data-URI gambar saat ini                                    |
| `alt`                      | Teks alternatif (aksesibilitas)                                 |
| `mime`                     | MIME override (default di-detect dari ekstensi)                 |
| `loadFile(path)`           | Load dari file VFS (pakai `fs` global `@tsix/Application`)      |
| `loadFromFile(fsLib,path)` | Load dari file dengan fsLib eksplisit                           |
| `updateImageFromFile(...)` | Alias `loadFromFile` (nama familiar dari Emerald/Screen)        |
| `setBase64(b64, mime?)`    | Set gambar dari data base64 langsung                            |

> **Cara kerja:** browser **tidak bisa** load path VFS (`/opt/...`) langsung — itu path kernel, bukan URL HTTP. Jadi worker baca file (`fs.readFile`) → **base64 data URI** (`data:image/png;base64,...`) → update `<img src>`. `TImage` menangani ini otomatis.
>
> **MIME:** `mimeFromPath(path)` mendeteksi MIME dari ekstensi: `.png` → `image/png`, `.jpg/.jpeg` → `image/jpeg`, `.gif` → `image/gif`, `.bmp` → `image/bmp`, `.webp` → `image/webp`, `.svg` → `image/svg+xml`, `.ico` → `image/x-icon`.

---

## �📐 Layout

### Grid Layout

Form bisa pake CSS Grid untuk layout 2 kolom:

```typescript
form.style = {
  ...form.style,
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "6px",
};
```

Header full width:

```typescript
lblTitle.style = { gridColumn: "1 / -1" };
```

### Layout Helpers

| Helper                                                                    | Fungsi                                                    |
| :------------------------------------------------------------------------ | :-------------------------------------------------------- |
| **`TGridPanel(id, cols?, style?)**                                        | Panel dengan CSS Grid, jumlah kolom tetap                 |
| **`TFlowPanel(id, style?)**                                               | Flex wrap — item otomatis pindah baris                    |
| **`TScrollBox(id, style?)**                                               | Panel dengan overflow auto (scroll)                       |
| **`TSplitHorizontal(c1, c2, ratio?)**                                     | Dua panel bersebelahan (kiri \| kanan) — **bisa di-drag** |
| **`TSplitVertical(c1, c2, ratio?)**                                       | Dua panel bertumpuk (atas \| bawah) — **bisa di-drag**    |
| **`TGroupBox(id, caption, style?)**                                       | Panel dengan border + label (kayak GroupBox Delphi)       |
| **`HStack(...children)**                                                  | Flex row horizontal                                       |
| **`VStack(...children)**                                                  | Flex column vertical                                      |
| **`Spacer(size?)**                                                        | Pengisi ruang fleksibel                                   |
| **`alTop` / `alBottom` / `alLeft` / `alRight` / `alClient` / `alCenter`** | Konstanta alignment (nilai string untuk `style.position`) |

> **Catatan layout:** `HStack(style?, ...children)` dan `VStack(style?, ...children)` menerima style sebagai argumen pertama opsional, lalu daftar child. `TSplit*` mendukung **nesting** (split di dalam split).

Contoh splitter:

```typescript
const panelKiri = new TPanel("kiri", { padding: "8px" });
const panelKanan = new TPanel("kanan", { padding: "8px" });
const split = TSplitHorizontal(panelKiri, panelKanan, "1");
form.add(split);
// Splitter bisa di-drag pake mouse!
```

Contoh group box:

```typescript
const group = TGroupBox("grup1", "⚙️ Pengaturan", { height: "150px" });
const btn = new TButton("btn1");
btn.caption = "Simpan";
group.add(btn);
form.add(group);
```

---

## 🎯 Event Binding

`TForm.run()` **otomatis** me-_bind_ semua event (onClick, onInput, onChange, ...) dan auto-_refresh_ komponen dinamis (TListBox, data grid) untuk **semua child** — rekursif. Jadi **tidak perlu** manual memanggil `bind()`.

```typescript
// Cukup set callback sebelum form.run(); TForm yang handle binding-nya
btnSave.onClick = () => { ... };
edtEmail.onInput = (val) => { ... };
form.add(btnSave);
form.add(edtEmail);

await form.run(); // auto-bind + auto-refresh semua komponen
```

`onSetup` hanya untuk inisialisasi **data/state tambahan** setelah mount (misal `grid.setData(...)` atau `chart.initChart()`):

```typescript
form.onSetup = async (screen) => {
  await grid.setData(rows);
  await chart.initChart();
};
```

> **Catatan:** Perubahan properti seperti `caption = "..."` atau `text = "..."` akan otomatis sync ke layar karena komponen sudah ter-bind oleh `TForm.run()`.

---

## 💬 Dialogs

Cashew menyediakan `TDialogs` — static methods tanpa perlu form:

```typescript
import { TDialogs } from "@tsix/cashew";

// Alert — info, 1 tombol OK
await TDialogs.alert(screen, "Info", "Pesan");

// Confirm — default tombol ["OK", "Cancel"], bisa custom
const ans = await TDialogs.confirm(screen, "Yakin?", "Lanjutkan?");
// ans = label tombol yang diklik ("OK" / "Cancel")
const yes = await TDialogs.confirm(screen, "Hapus?", "Yakin?", [
  "✅ Ya",
  "🚫 Tidak",
]);
// yes = "✅ Ya" atau "🚫 Tidak"

// Input — teks dari user
const name = await TDialogs.input(screen, "Nama", "Siapa?");
// name = input user, atau null kalau cancel
// (default value opsional: TDialogs.input(screen, t, m, defaultValue))

// Open File — pilih file dari VFS
// (butuh fs dari @tsix/Application)
const path = await TDialogs.openFile(screen, fs, "Pilih File", "/");
// path = "/home/kakang/file.txt" atau null

// Save File — tentukan path simpan
const path = await TDialogs.saveFile(screen, fs, "Simpan", "data.txt");
// path = "/home/kakang/data.txt" atau null
```

---

## 🧅 Lapisan API

```
Kernel → Syscall GUI_REQ
  ↓
DOME Engine → WebSocket
  ↓
Browser DOM
  ↑
Emerald → Screen, Window, mount, alert, confirm
  ↑
Cashew → TForm, TButton, TPanel, TDialogs ...
```

**Emerald** = low-level: widget mentah (`div`, `button`, `span`), DOM manipulation.

**Cashew** = high-level: komponen OOP ala Delphi, auto-sync caption/text, layout helpers.

---

## 🎨 Styling

Semua style pake CSS-in-JS (object style). Bisa di-set di constructor atau langsung:

```typescript
// Di constructor
const btn = new TButton("btn-ok", { color: "red", marginRight: "5px" });

// Setelah constructor (tapi hindari kalo bisa pake constructor)
btn.style = { ...btn.style, color: "red" };
```

Style dari constructor **override** default style component.

### Theme / CSS Variables

Cashew pake **CSS variables** biar semua komponen otomatis ngikut theme aktif:

```css
var(--bg, #0d1b2a)        /* Background utama */
var(--surface, #16213e)   /* Panel / card */
var(--text, #e0e0e0)     /* Teks utama */
var(--text-dim, #ccc)     /* Teks redup */
var(--text-muted, #888)   /* Teks samar */
var(--accent, #4caf50)    /* Warna aksen */
var(--border, ...)        /* Warna border */
var(--button-bg, #0f3460) /* Tombol */
var(--input-bg, ...)      /* Input field */
```

Tinggal panggil `theme.applyToDome()` di `onSetup`:

```typescript
import { theme } from "@tsix/theme";

form.onSetup = async (screen) => {
  await theme.loadCurrent();
  theme.watch();
  const domePid = ...; // dari ps
  if (domePid) await theme.applyToDome(domePid, form.screen.win.wid);
};
```

> **Catatan:** Untuk form standar, `TForm.run()` sudah otomatis memuat theme (`loadCurrent` + `watch`) dan mengirim `WINDOW_THEME` ke DOME — jadi `applyToDome()` manual umumnya **tidak wajib** kecuali kamu butuh kontrol penuh.

---

## 📝 Contoh Lengkap

| Demo                        | File                                                              | Deskripsi                                                            |
| :-------------------------- | :---------------------------------------------------------------- | :------------------------------------------------------------------- |
| **Cashew GUI Demo**         | [`cashew-demo1.ts`](../src/mirror/opt/test/cashew-demo1.ts)       | Counter, input, checkbox, radio, listbox, dialog                     |
| **Cashew Layout Demo**      | [`cashew-demo2.ts`](../src/mirror/opt/test/cashew-demo2.ts)       | Grid, flow, splitter, scroll, anchor, groupbox                       |
| **Cashew IoT Dashboard**    | [`cashew-demo3.ts`](../src/mirror/opt/test/cashew-demo3.ts)       | Sensor card, relay, gauge, chart, 7-seg, toggle, slider, timer, lamp |
| **Tabulator Grid (Cashew)** | [`tab-demo-csh.ts`](../src/mirror/opt/test/tab-demo-csh.ts)       | `TTabulatorGrid`: sort, resize, select, appendData, toggleSort       |
| **DB Browser (Cashew)**     | [`gui-db-test-csh.ts`](../src/mirror/opt/test/gui-db-test-csh.ts) | `TDataGrid` + DbLib: browse tabel MySQL + sort                       |
| **Image Viewer**            | [`image-viewer.ts`](../src/mirror/opt/image-viewer/image-viewer.ts) | `TImage` + explorer tree: preview gambar dari file VFS              |
