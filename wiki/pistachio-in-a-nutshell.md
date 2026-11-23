# 🌰 Pistachio — Set Komponen GUI TSIX

**Pistachio** adalah set komponen GUI ala Delphi untuk aplikasi TSIX, pengganti
[Cashew](./cashew-in-a-nutshell.md). Satu bentuk konstruktor, props dan style
dipisah tegas, semua container berupa class, dan ada stack database bergaya
Delphi (`TDBConnection → TDBQuery → TProvider → TClientDataset → TDataSource →
TDBControls`).

> **Status:** siap dipakai untuk aplikasi baru. Pistachio **sengaja tidak
> backward compatible** dengan Cashew. Cashew tetap jalan untuk aplikasi lama
> (mode maintenance, bugfix saja). Untuk berpindah, lihat
> [Panduan Migrasi dari Cashew](#-panduan-migrasi-dari-cashew).
> Latar belakang desain: [pistachio-plan.md](./pistachio-plan.md).

---

## Daftar Isi

1. [Quick Start](#-quick-start)
2. [Konsep Inti](#-konsep-inti)
3. [TForm — Window](#-tform--window)
4. [Layout](#-layout)
5. [Kontrol Dasar](#-kontrol-dasar)
6. [TTreeView](#-ttreeview)
7. [Grid Data Manual](#-grid-data-manual)
8. [Widget IoT](#-widget-iot)
9. [Dialog](#-dialog)
10. [Shortcut Keyboard](#-shortcut-keyboard)
11. [Stack Database](#-stack-database)
12. [Batasan Saat Ini](#-batasan-saat-ini)
13. [Panduan Migrasi dari Cashew](#-panduan-migrasi-dari-cashew)
14. [Referensi](#-referensi)

---

## 🚀 Quick Start

```ts
import { Program } from "@tsix/Application";
import { TButton, TForm, THStack, TLabel, TSpacer } from "@tsix/pistachio";

// Dipakai Eucalyptus/File Cruiser untuk mengenali aplikasi GUI.
export const appMode = "gui";

export const main = Program(async () => {
  const form = new TForm({ title: "Counter", width: 360, height: 160 });

  let count = 0;
  const lblCount = new TLabel({ id: "lbl-count", text: "Count: 0" });
  const btnAdd = new TButton({ id: "btn-add", caption: "Tambah" });

  btnAdd.onClick = () => {
    count++;
    lblCount.text = `Count: ${count}`; // langsung tampil, tanpa update manual
  };

  form.add(new THStack({ children: [btnAdd, new TSpacer(), lblCount] }));
  await form.run(); // mount → bind event → refresh → tunggu window ditutup
});
```

Semua import dari satu barrel: `@tsix/pistachio`. Contoh lengkap yang bisa
dijalankan ada di `/opt/test/pistachio-demo.ts` (menu Asteracea
**Pistachio Demo**, paket `pistachio-demos`).

---

## 🧠 Konsep Inti

### Satu bentuk konstruktor

Setiap komponen menerima `(idOrOpts?, opts?)`:

```ts
new TButton({ id: "btn-save", caption: "Simpan" }); // bentuk utama
new TButton("btn-save", { caption: "Simpan" });     // id terpisah, setara
new TButton();                                      // id otomatis: "button_1", ...
```

Argumen kedua menimpa yang pertama. Tidak ada bentuk posisional seperti
`new TForm("Judul", 800, 600)` di Cashew.

> ⚠️ **Jebakan migrasi:** `new TForm("Judul")` di Pistachio berarti
> **id = "Judul"**, bukan title. Pakai `new TForm({ title: "Judul" })`.

### Props dan style dipisah tegas

- Props komponen (`caption`, `text`, `items`, ...) ditulis di level atas opsi.
- CSS hanya lewat `style`.
- Key yang tidak dikenal **langsung dilempar** `EComponentError("UNKNOWN_PROP")`,
  tidak diam-diam menjadi CSS. Typo seperti `captoin` ketahuan saat konstruksi.

```ts
new TButton({ caption: "OK", style: { marginLeft: "8px" } }); // ✅
new TButton({ caption: "OK", marginLeft: "8px" });            // ❌ UNKNOWN_PROP
```

`style` bisa di-assign ulang setelah mount dan langsung tersinkron:
`btn.style = { ...btn.style, color: "red" }`. Mutasi objek
(`btn.style.color = "red"`) **tidak** tersinkron.

### Tree komponen

| Method / properti | Fungsi |
| :-- | :-- |
| `add(child)` | Pasang child. Menolak child yang sudah punya parent, ID duplikat dalam satu root, dan siklus |
| `remove(child)` | Lepas child (DOM + handler ikut dilepas) **tanpa** menghancurkannya; bisa dipasang ke parent lain |
| `dispose()` | Hancurkan subtree; idempoten |
| `byId<T>(id)` | Cari komponen di seluruh tree root |
| `children` / `parent` | Navigasi tree (read-only) |
| `options.children` | Child bisa langsung diisi di konstruktor |

Komponen yang di-`add()` setelah `form.run()` langsung di-mount, di-bind, dan
di-refresh. UI dinamis tidak butuh langkah tambahan.

### Lifecycle

`form.run()` menjalankan urutan yang sama untuk semua komponen:

1. **mount**: tree dibangun (`build()`) dan dipasang ke window.
2. **bind**: setiap komponen mendaftarkan event handler-nya.
3. **refresh**: isi dinamis dimuat (list, grid, DB control).
4. **`onSetup(form)`**: hook aplikasi, opsional.
5. Menunggu window ditutup, lalu **dispose** seluruh tree.

Komponen non-visual (`TKeyboard`, `TDBConnection`, `TDataSource`, ...) punya
`isVisual = false`: tetap di-bind, tapi tidak menghasilkan elemen DOM.

### Error terketik

| Kelas | Kapan | Contoh kode |
| :-- | :-- | :-- |
| `EComponentError` | kesalahan tree/opsi | `UNKNOWN_PROP`, `DUPLICATE_ID`, `ALREADY_PARENTED`, `CYCLE`, `NOT_A_CHILD`, `DISPOSED`, `INVALID_OPTIONS`, `UNSUPPORTED` |
| `EDatabaseError` | kesalahan stack database | `CONNECTION_FAILED`, `QUERY_FAILED`, `PROVIDER_NOT_WRITABLE`, `DATASET_DIRTY`, ... (lihat [Stack Database](#-stack-database)) |

Keduanya punya `code` untuk dicek program, jadi aplikasi tidak perlu mem-parsing
pesan error.

**Error async dari setter.** Setter tidak ditunggu (`label.text = "..."`
langsung kembali), jadi kegagalan render di belakangnya, misalnya karena window
sudah ditutup, tidak bisa dilempar ke pemanggil. Kegagalan itu tidak menjadi
unhandled rejection. Pistachio meneruskannya ke `onError` milik komponen bila
ada (kontrol DB), dan selain itu menulisnya ke `console.error` sebagai
`[Pistachio] TLabel "status" update failed: ...`. Pakai varian `async setX()`
bila perlu menunggu dan menangkap error sendiri.

### Membuat kelas komponen

Komponen baru mengikuti pola yang sama dengan komponen bawaan:

```ts
import { defineProps, TComponent, type TOptions } from "@tsix/pistachio";

export interface TBadgeOptions extends TOptions {
  text?: string;
  color?: string;
}

// Satu sumber props (K5): compile gagal bila array dan interface berbeda.
const BADGE_PROPS = defineProps<TBadgeOptions>()(["text", "color"]);

export class TBadge extends TComponent {
  constructor(idOrOpts?: string | TBadgeOptions, opts?: TBadgeOptions) {
    super(idOrOpts, opts, BADGE_PROPS);
    const o = this.options as TBadgeOptions;
    this.props.text = o.text ?? "";
  }

  get text(): string {
    return this.props.text;
  }
  set text(value: string) {
    this.props.text = value;
    this.push({ text: value }); // sinkron ke UI; error async dilaporkan otomatis
  }
}
```

- Subclass mendaftarkan **tambahannya saja**:
  `defineProps<TChildOptions, TParentOptions>()(["extra"])`.
- Tugas async yang tidak ditunggu dijalankan lewat `this.background(promise, "konteks")`,
  bukan `void promise`.
- Kelas yang diekspor dari barrel otomatis diuji `pistachio-contract.test.ts`
  (konstruktor, `UNKNOWN_PROP`, `isVisual`, `dispose()`, setter → UI, nama event,
  host gagal). Kelas yang butuh opsi wajib didaftarkan di `FIXTURES` tes itu.

---

## 🪟 TForm — Window

```ts
const form = new TForm({
  title: "Monitor",
  icon: "📡",
  width: 900,
  height: 600,
  style: { overflow: "auto" }, // di-merge di atas style default form
});

form.onSetup = async (f) => { /* muat data awal */ };
form.onClose = () => { /* bersihkan resource milik aplikasi */ };

await form.run();
```

| Opsi | Default | Fungsi |
| :-- | :-- | :-- |
| `title` | `"Untitled"` | Judul window |
| `icon` | — | Ikon/emoji di title bar |
| `width` / `height` | `800` / `600` | Ukuran (px) |
| `maximizable` / `resizable` | `true` | Tombol maximize / resize |
| `fullscreen` / `frameless` | `false` | Mode tanpa frame |
| `left` / `top` | — | Posisi awal |
| `desktopCentered` | `false` | Tengah desktop |

| Member | Fungsi |
| :-- | :-- |
| `run()` | Tampilkan window dan tunggu sampai ditutup |
| `close()` | Tutup window, panggil `onClose`, dispose tree |
| `maximize()` | Perbesar ke ukuran viewport |
| `screen` | `Screen` emerald (null sebelum `run()`), untuk API tingkat rendah |
| `onSetup` / `onClose` | Hook setelah mount / saat ditutup |

Tema Asteracea aktif diterapkan otomatis ke window. Pakai CSS variable
(`var(--surface)`, `var(--accent)`, `var(--text)`, ...) di `style` supaya ikut tema.

---

## 📐 Layout

Semua container adalah class, jadi `instanceof` berlaku dan bisa di-subclass.

| Kelas | Opsi khusus | Fungsi |
| :-- | :-- | :-- |
| `TPanel` | — | Panel surface + border |
| `THStack` | — | Flex row (wrap, gap 8px) |
| `TVStack` | — | Flex column (gap 8px) |
| `TGridPanel` | `columns` (default 2) | CSS grid dengan jumlah kolom tetap |
| `TScrollBox` | — | Container `overflow: auto` |
| `TSpacer` | `size` (px) | Tanpa `size` mengisi sisa ruang; dengan `size` ruang tetap |
| `TGroupBox` | `caption` | Panel bergaris dengan judul; `caption` bisa diubah runtime |

```ts
const toolbar = new THStack({
  children: [btnRefresh, btnSave, new TSpacer(), lblStatus],
});

const settings = new TGroupBox({
  caption: "⚙️ Pengaturan",
  children: [new TVStack({ children: [edtHost, edtPort, chkAuto] })],
});

const cards = new TGridPanel({ columns: 3, children: [card1, card2, card3] });
```

Untuk tata letak kiri/kanan, cukup `THStack` dengan `style.flex` di child.
Splitter yang bisa di-drag belum ada (lihat [Batasan](#-batasan-saat-ini)).

---

## 🎛️ Kontrol Dasar

Nilai input **selalu live**: ketikan atau pilihan user langsung tertulis ke
properti (`text`, `checked`, `selectedIndex`), jadi bisa dibaca kapan saja.
Callback event hanya untuk reaksi real-time.

| Kelas | Opsi | Properti runtime | Event |
| :-- | :-- | :-- | :-- |
| `TLabel` | `text` | `text` | — |
| `TButton` | `caption`, `enabled` | `caption`, `enabled` | `onClick()` |
| `TEdit` | `text`, `placeholder`, `readOnly` | sama | `onInput(value)` |
| `TMemo` | `text`, `rows`, `readOnly` | sama | `onInput(value)` |
| `TCheckBox` | `caption`, `checked` | `caption`, `checked` | `onClick(checked)` |
| `TRadioButton` | `caption`, `checked`, `group` | sama | `onClick(checked)` |
| `TComboBox` | `items`, `selectedIndex` | `items`, `selectedIndex`, `setItems()` | `onChange(index, item)` |
| `TListBox` | `items`, `selectedIndex` | `items`, `selectedIndex`, `setItems()` | `onClick(index, item)` |

```ts
const edtName = new TEdit({ id: "edt-name", placeholder: "Nama..." });
const cmbMode = new TComboBox({ items: ["Santai", "Normal", "Ketat"], selectedIndex: 1 });

btnSave.onClick = () => save(edtName.text, cmbMode.selectedIndex);
```

**Mengganti isi list:** setter `items` dan `await setItems(items)` identik;
pakai `setItems()` bila perlu menunggu render selesai. Item terpilih yang masih
ada tetap terpilih. Bila hilang, `TComboBox` memilih item pertama dan
`TListBox` kembali ke `-1`.

**Radio button:** radio dengan `group` yang sama saling meng-uncheck di
seluruh form, walaupun berada di panel berbeda. Radio tanpa `group` hanya
dikelompokkan dengan saudara satu parent. `rb.checked = true` lewat kode juga
mematikan anggota grup lain, tanpa memicu `onClick`.

`readOnly` di `TEdit`/`TMemo` bisa diubah setelah mount; field tetap bisa
dipilih dan disalin, dengan tampilan embos.

---

## 🌳 TTreeView

```ts
const tree = new TTreeView({
  nodes: [
    {
      id: "acc-juragan",
      label: "juragan",
      icon: "👤",
      expanded: true,
      children: [
        { id: "dev-1", label: "Sensor A", hint: "3 scheme", data: { deviceId: "..." } },
      ],
    },
  ],
});

tree.onSelect = (node) => showEditor(node.data);
tree.onToggle = (node, expanded) => { /* ... */ };
```

| Member | Fungsi |
| :-- | :-- |
| `setNodes(nodes)` | Ganti seluruh pohon |
| `select(id, notify = true)` | Pilih node (memicu `onSelect` bila `notify`) |
| `expand(id)` / `collapse(id)` / `toggle(id)` | Buka/tutup satu node |
| `expandAll()` / `collapseAll()` | Buka/tutup semua |
| `selectedId` / `selectedNode` / `expandedIds` | State saat ini |

`TTreeNode`: `{ id, label, icon?, hint?, data?, children?, expanded? }`; `data`
bebas diisi aplikasi.

---

## 🗃️ Grid Data Manual

Untuk data yang **bukan** dari stack database (data dari IPC, file, sensor).
Untuk tabel database pakai [`TDBGrid`](#kontrol-db).

| Kelas | Render | Tambahan |
| :-- | :-- | :-- |
| `TDataGrid` | virtual-DOM di sisi aplikasi | — |
| `TTabulatorGrid` | di browser oleh Tabulator (lebih ringan untuk data banyak) | `selectable`, `onRowDoubleClick`, `onSelectionChange` |

```ts
const grid = new TTabulatorGrid({
  id: "readings",
  columns: [
    { key: "device", label: "Device", width: 160 },
    { key: "value", label: "Nilai", width: 80, align: "right" },
    { key: "ts", label: "Waktu", width: "40%" },
  ],
  height: 300,
  maxRows: 500, // 0 = tanpa batas
});

grid.onRowClick = (index, record) => { /* index = row-key stabil, tahan sorting */ };
grid.onSort = (key, dir) => { /* ... */ };

await grid.setData(rows);   // ganti semua baris
await grid.appendData(more); // tambah inkremental (hemat traffic)
```

Kolom: `{ key, label, width?, sortable?, resizable?, align? }`; `width` berupa
angka (px) atau string CSS. Member lain: `setColumns()`, `selectedIndex`,
`selectedRecord`, `getRecord(index)`, `setSelectedIndex()`,
`setSelectedRecord()`, `clearSelection()`, `sort`, `onRowContextMenu`.

---

## 🌡️ Widget IoT

Semua widget menerima opsi di konstruktor dan memperbarui tampilan saat
propertinya di-assign (`gauge.value = 64`).

| Kelas | Opsi utama | Properti / event |
| :-- | :-- | :-- |
| `TSensorCard` | `value`, `label`, `unit`, `icon`, `color`, `min`, `max` | `value` |
| `TRadialGauge` | `value`, `min`, `max`, `label`, `unit`, `color`, `size` | `value` |
| `TVerticalGauge` | `value`, `label`, `unit`, `color`, `width`, `height` | `value` |
| `TSevenSegment` | `value`, `digits`, `decimals`, `label`, `color`, `scale` | `value` |
| `TLineChart` | `data`, `color`, `spline`, `fill`, `width`, `height`, `showXAxisLabels`, `showYAxisLabels` | `data`, `setData(values)` |
| `TProgressBar` | `value` (0–100), `color`, `track`, `height` | `value` |
| `TIndicatorLamp` | `on`, `label`, `color`, `size` | `on` |
| `TToggleSwitch` | `on`, `controlled`, `label`, `color`, `size` | `on`, `onClick(on)` |
| `TRelayCard` | `active`, `label`, `icon`, `color` | `active`, `onToggle(active)` |
| `TSlider` | `value`, `min`, `max`, `step`, `unit`, `label`, `color` | `value`, `onInput(value)` |
| `TImage` | `src` (URL/data URI) atau `file` (path VFS), `alt`, `fit`, `width`, `height` | `src`, `alt`, `loadFile(path)`, `onClick()` |
| `TStatusBar` | `leftText`, `rightText` | `leftText`, `rightText` |

```ts
const suhu = new TSensorCard({ label: "Suhu", unit: "°C", icon: "🌡️", min: -40, max: 125 });
const chart = new TLineChart({ spline: true, fill: true, height: 120 });

onReading((v) => {
  suhu.value = v;
  void chart.setData([...chart.data, v].slice(-60));
});
```

> **`TToggleSwitch` dengan `controlled: true`** tidak mengubah tampilannya
> sendiri saat diklik. `onClick(requested)` dipanggil, lalu aplikasi meng-set
> `on` setelah device mengonfirmasi. Cocok untuk relay yang statusnya
> ditentukan perangkat, bukan UI.

---

## 💬 Dialog

Pemilik dialog bisa `TForm` (setelah `run()`) atau `Screen`.

```ts
await TDialogs.alert(form, "Info", "Tersimpan.");

const answer = await TDialogs.confirm(form, "Hapus?", "Tidak bisa dibatalkan.", ["Ya", "Batal"]);
if (answer === "Ya") { /* label tombol yang diklik */ }

const name = await TDialogs.input(form, "Nama", "Masukkan nama:", "default");
// string, atau null bila dibatalkan

const opened = await new TOpenDialog({ title: "Pilih file", startDir: "/home", filter: ["txt", "md"] })
  .execute(form);
const saved = await new TSaveDialog({ title: "Simpan", defaultName: "catatan.txt" })
  .execute(form);
// { path, filename, directory } atau null bila dibatalkan
```

---

## ⌨️ Shortcut Keyboard

`TKeyboard` adalah komponen non-visual. Shortcut hanya aktif saat window
**sedang fokus**, karena DOME merutekan event keyboard hanya ke window aktif.
Beberapa `TKeyboard` bisa hidup berdampingan di satu form.

```ts
const keys = new TKeyboard({
  shortcuts: {
    "Ctrl+S": () => save(),
    F5: () => void reload(),
    "Ctrl+Shift+Q": () => void form.close(),
  },
});
keys.onKey = (ev) => { if (ev.key === "Escape") cancel(); };
keys.bind("Ctrl+N", () => newRecord()); // tambah/ganti saat runtime
form.add(keys);
```

Ejaan kombinasi dinormalisasi (`"ctrl+shift+s"` = `"Ctrl+Shift+S"`). Urutan
modifier kanonik: `Ctrl`, `Alt`, `Shift`.

---

## 🗄️ Stack Database

### Rantai komponen

```
TDBConnection → TDBQuery → TProvider → TClientDataset → TDataSource → DB controls
   koneksi       SQL+params   fetch/apply    buffer+cursor     binding        UI
```

Setiap lapis hanya mengenal lapis di bawahnya. DB controls tidak pernah
menyentuh SQL atau koneksi, dan semua I/O selalu `await`.

```ts
import {
  TClientDataset, TDataSource, TDBConnection, TDBEdit, TDBGrid,
  TDBNavigator, TDBQuery, TProvider,
} from "@tsix/pistachio";

const connection = new TDBConnection({ driver: "mysql", host, user, password, database });
const query = new TDBQuery({
  connection,
  sql: "SELECT reading_id, device_id, scheme_id, value FROM sensor_readings WHERE device_id = :dev",
  params: { dev: deviceId },
});
const provider = new TProvider({ query });
const dataset = new TClientDataset({ provider });
const source = new TDataSource({ dataset });

const grid = new TDBGrid({ dataSource: source, style: { height: "360px" } }); // kolom otomatis
const nav = new TDBNavigator({ dataSource: source });
const edtValue = new TDBEdit({ dataSource: source, field: "value" });

form.onSetup = async () => {
  await connection.open();
  await dataset.open();
};
form.onClose = () => void connection.close();
```

> 🔐 Jangan simpan kredensial DB di source. Demo membacanya dari environment
> (`shell.getenv("DB_HOST")`, dst.); lihat `/opt/test/pistachio-dbdemo.ts`.

### TDBConnection

| Member | Fungsi |
| :-- | :-- |
| opsi | `driver` (`"mysql"` default, atau objek `TDBDriver`), `host`, `port?`, `user`, `password`, `database` |
| `open()` / `close()` | Buka/tutup koneksi |
| `connected` | Status |
| `capabilities` | `{ canWrite, canTransact, canParam }` dari driver |
| `driver.quoteIdent(name)` | Quote identifier sesuai driver (mis. nama tabel dinamis) |

Driver built-in hanya **MySQL**, dan hanya **satu koneksi built-in per proses**.
`open()` kedua melempar `CONNECTION_ALREADY_OPEN`. Driver lain bisa dipasang
dengan mengirim objek yang mengimplementasikan `TDBDriver`
(`connect/disconnect/execute/quoteIdent` + `capabilities`).

### TDBQuery

- Parameter **named** (`:dev`, objek) atau **positional** (`?`, array), selalu
  dikirim sebagai prepared statement, tidak pernah disambung ke SQL.
- `sql` dan `params` bisa diganti runtime (mis. ganti tabel), lalu
  `dataset.refresh()`.
- `fields` berisi metadata kolom kanonik (`TFieldDef`): `name`, `type`
  (`ftString`, `ftInteger`, `ftFloat`, `ftBoolean`, `ftDateTime`, `ftBlob`,
  `ftJSON`), `nullable`, `primaryKey`, `autoIncrement`, `table`, `sourceName`.

Untuk nama tabel dinamis, quote dulu identifier-nya:
`query.sql = \`SELECT * FROM ${connection.driver.quoteIdent(table)}\``.

### TProvider

Menjembatani query ke dataset: `fetch()` dan `applyUpdates` per baris.

- Tabel target dan primary key **diturunkan dari metadata** bila query membaca
  satu tabel. Override dengan `tableName` / `primaryKey: ["id"]` bila perlu
  (mis. query dengan JOIN atau view).
- `capabilities` memberi tahu apa yang mungkin: `canInsert`, `canUpdate`,
  `canDelete`. Tanpa primary key, update/delete tidak diizinkan. Kontrol edit
  otomatis read-only bila tulis tidak mungkin.

### TClientDataset

Buffer baris di memori, dengan cursor, state, dan dirty tracking.

| Kelompok | Member |
| :-- | :-- |
| Buka/tutup | `open()`, `refresh()`, `close()`, `isOpen` |
| Cursor | `first()`, `next()`, `prior()`, `last()`, `setCurrentIndex(i)`, `currentIndex`, `bof`, `eof`, `recordCount` |
| Data | `currentRecord`, `records`, `fields`, `getField(name)`, `setField(name, value)` |
| Edit | `edit()`, `insert(values?)`, `post()`, `cancel()`, `delete()` |
| State | `state` (`"dsBrowse"`, `"dsEdit"`, `"dsInsert"`), `dirtyCount`, `hasChanges` |
| Simpan | `applyUpdates()` → `{ results, succeeded, failed }` |
| View lokal | `setFilter(predicate \| null)`, `setSort(comparator \| null)` |
| Notifikasi | `subscribe(listener)` → fungsi unsubscribe; event `data`, `cursor`, `state` |

Alur edit:

```ts
dataset.edit();                  // dsEdit
dataset.setField("value", 42);   // atau lewat TDBEdit
dataset.post();                  // simpan ke buffer, tandai dirty
const result = await dataset.applyUpdates(); // kirim ke DB per baris
if (result.failed > 0) {
  for (const row of result.results) if (!row.success) console.log(row.error.code);
}
```

`applyUpdates()` **tidak transaksional**: tiap baris dikirim sendiri dan
dilaporkan sendiri. Baris yang gagal tetap dirty dan bisa dicoba lagi.

### TDataSource

Titik binding antara satu dataset dan banyak kontrol (satu cursor, banyak
tampilan). Menyediakan member yang sama dengan dataset untuk navigasi, edit, dan
`subscribe()`. DB controls hanya berbicara ke `TDataSource`.

### Kontrol DB

| Kelas | Opsi khusus | Catatan |
| :-- | :-- | :-- |
| `TDBGrid` | `dataSource`, `columns` (`"auto"` default atau daftar kolom) | Turunan `TTabulatorGrid`; cursor ikut baris terpilih; `onRecordDoubleClick(record)`, `onError`. Isi grid **hanya** dari dataset: `setData`/`appendData`/`data =` melempar `UNSUPPORTED`; kolom eksplisit boleh diganti, kolom `"auto"` tidak. Jangan meng-assign `onSort`/`onSelectionChange`/`onRowDoubleClick` (dipakai untuk sinkron dengan dataset) |
| `TDBNavigator` | `dataSource` | Tombol first/prior/next/last/insert/edit/delete/post/cancel/apply (bisa diakses: `navigator.applyButton`, dst.); `onError` |
| `TDBPager` | `dataSource`, `pageSize` (default 100) | Paging **sisi server** (`COUNT` + `LIMIT/OFFSET`) untuk tabel besar; `goToPage()`, `pageIndex`, `pageCount`, `totalCount` |
| `TDBText` | `dataSource`, `field`, `formatValue?` | Label read-only |
| `TDBEdit` | `dataSource`, `field`, `formatValue?`, `parseValue?`, `readOnly?` | Edit satu baris; ketikan menulis ke field |
| `TDBMemo` | sama dengan `TDBEdit` | Multiline |
| `TDBListBox` | `dataSource`, `field`, `items`, `parseValue?` | Pilihan dari daftar tetap; `onError` |

Kontrol edit otomatis read-only bila dataset tidak sedang `dsEdit`/`dsInsert`,
provider tidak bisa menulis, atau field bertipe `ftBlob`. `TDBPager` hanya menerima satu `SELECT`, dan
menolak pindah halaman selama ada perubahan yang belum di-apply.

### Error database

Semua kegagalan dibungkus `EDatabaseError` dengan `code`, misalnya
`CONNECTION_FAILED`, `CONNECTION_ALREADY_OPEN`, `QUERY_FAILED`,
`PROVIDER_NOT_WRITABLE`, `PROVIDER_NOT_UPDATABLE`, `DATASET_DIRTY`,
`DATASET_NOT_BROWSE`, `INVALID_FIELD`. Tidak ada objek `{ error }` yang perlu
dicek manual seperti di `db.query()` mentah.

---

## 🚧 Batasan Saat Ini

| Belum ada | Alternatif sementara |
| :-- | :-- |
| `TTimer` | `setInterval` + `clearInterval` setelah `await form.run()` (lihat contoh migrasi) |
| `TChart` (Lightweight Charts) | `TLineChart` untuk tren sederhana |
| `TSplitHorizontal` / `TSplitVertical` (drag) | `THStack` / `TVStack` dengan `style.flex` |
| `TFlowPanel`, konstanta `alTop`/`alClient`/... | `THStack` (sudah `flexWrap`), `TGridPanel`, atau `style` |
| `form.minimize()`, `restore()`, `unMaximize()` | `form.screen.win` (API emerald) |
| `toggleSort()` di grid | sort lewat header grid, atau `dataset.setSort()` untuk DB |
| Driver selain MySQL (CSV, SQLite, PostgreSQL) | implementasi `TDBDriver` sendiri; driver CSV direncanakan |
| Transaksi, multi-koneksi per proses | `applyUpdates()` per baris; satu `TDBConnection` per proses |

Status terbaru ada di checklist [pistachio-plan.md §13](./pistachio-plan.md#13-checklist-eksekusi).

---

## 🔁 Panduan Migrasi dari Cashew

Migrasi dilakukan **per aplikasi**, tidak massal. Aplikasi Cashew tetap jalan
apa adanya. Pistachio dan Cashew tidak saling mengimpor, tapi jangan mencampur
komponen keduanya dalam satu form.

### Langkah

1. Ganti import `@tsix/cashew` → `@tsix/pistachio`.
2. Ubah semua konstruktor ke bentuk opsi (`{ id, ...props, style }`).
3. Pindahkan argumen style ke `style`.
4. Ganti helper factory (`HStack(...)`, `Spacer()`, `TGroupBox(...)`) menjadi
   `new THStack({ children })`, dst.
5. Sesuaikan nama properti yang berubah (tabel di bawah).
6. Ganti `db.connect/query` manual dengan stack database.
7. Jalankan aplikasi: `UNKNOWN_PROP` langsung menunjuk opsi yang salah tulis
   atau belum dipindah ke `style`.

### Pemetaan API

| Cashew | Pistachio |
| :-- | :-- |
| `new TForm("Judul", 800, 600)` | `new TForm({ title: "Judul", width: 800, height: 600 })` |
| `form.onSetup = async (screen) => …` | `form.onSetup = async (form) => …` (Screen: `form.screen`) |
| `form.alert(title, msg)` | `TDialogs.alert(form, title, msg)` |
| `form.update(id, props)` | set properti komponennya (`lbl.text = …`) |
| `new TPanel("p1", { padding: "8px" })` | `new TPanel({ id: "p1", style: { padding: "8px" } })` |
| `const lbl = new TLabel("x"); lbl.caption = "Hai"` | `new TLabel({ id: "x", text: "Hai" })`; properti `text` |
| `new TButton("b", { color: "red" }); b.caption = "OK"` | `new TButton({ id: "b", caption: "OK", style: { color: "red" } })` |
| `new TRadioButton("rb", "warna")` | `new TRadioButton({ id: "rb", group: "warna", caption: "…" })` |
| `lb.items = […]; lb.refresh(screen)` | `lb.items = […]` (atau `await lb.setItems([…])`) |
| `new TStatusBar("s"); s.text = "Siap"` | `new TStatusBar({ leftText: "Siap" })`; `leftText` / `rightText` |
| `HStack(style?, a, b)` / `VStack(…)` | `new THStack({ style, children: [a, b] })` / `TVStack` |
| `Spacer(size?)` | `new TSpacer({ size })` |
| `TGroupBox("g", "Judul", style)` | `new TGroupBox({ id: "g", caption: "Judul", style, children })` |
| `TGridPanel("g", 3)` | `new TGridPanel({ id: "g", columns: 3 })` |
| `new TTabulatorGrid("g", cols, data, { height })` | `new TTabulatorGrid({ id: "g", columns: cols, data, height })` |
| `new TTimer("t", 2000, true)` | belum ada, pakai `setInterval` (lihat contoh) |
| `TDialogs.openFile(screen, fs, title, dir)` → path | `new TOpenDialog({ title, startDir: dir }).execute(form)` → `{ path, … } \| null` |
| `TDialogs.saveFile(screen, fs, title, name)` → path | `new TSaveDialog({ title, defaultName: name }).execute(form)` → `{ path, … } \| null` |
| `TDialogs.alert/confirm/input(screen, …)` | sama, pemilik boleh `form` |
| `isVisual = false` (opt-out) | sama; kelas non-visual sudah mendeklarasikannya |
| `db.connect()` + `db.query(sql)` + cek `{ error }` | `TDBConnection` + `TDBQuery` + `EDatabaseError` |

### Contoh sebelum → sesudah

**Cashew:**

```ts
import { HStack, Spacer, TButton, TForm, TLabel, TTimer } from "@tsix/cashew";

const form = new TForm("Suhu", 360, 140);
const lbl = new TLabel("lbl-suhu");
lbl.caption = "—";
const btn = new TButton("btn-reset", { marginLeft: "8px" });
btn.caption = "Reset";
btn.onClick = () => { lbl.caption = "—"; };

const timer = new TTimer("tmr", 2000, true);
timer.onTimer = async () => { lbl.caption = `${await readSuhu()} °C`; };

form.add(HStack(lbl, Spacer(), btn));
form.add(timer);
await form.run();
```

**Pistachio:**

```ts
import { TButton, TForm, THStack, TLabel, TSpacer } from "@tsix/pistachio";

const form = new TForm({ title: "Suhu", width: 360, height: 140 });
const lbl = new TLabel({ id: "lbl-suhu", text: "—" });
const btn = new TButton({ id: "btn-reset", caption: "Reset", style: { marginLeft: "8px" } });
btn.onClick = () => { lbl.text = "—"; };

form.add(new THStack({ children: [lbl, new TSpacer(), btn] }));

// Pengganti TTimer: timer dibersihkan setelah window ditutup.
const timer = setInterval(async () => {
  lbl.text = `${await readSuhu()} °C`;
}, 2000);
try {
  await form.run();
} finally {
  clearInterval(timer);
}
```

### Database: sebelum → sesudah

**Manual (Cashew):**

```ts
await db.connect({ host, user, password, database });
const rows = await db.query(`SELECT * FROM sensor_readings WHERE device_id = '${dev}'`);
if ((rows as any).error) { /* parsing pesan */ }
await grid.setData(rows);
```

**Pistachio:**

```ts
const connection = new TDBConnection({ host, user, password, database });
const query = new TDBQuery({
  connection,
  sql: "SELECT * FROM sensor_readings WHERE device_id = :dev",
  params: { dev }, // prepared statement, aman dari SQL injection
});
const source = new TDataSource({
  dataset: new TClientDataset({ provider: new TProvider({ query }) }),
});
const grid = new TDBGrid({ dataSource: source });

form.onSetup = async () => {
  await connection.open();          // gagal → EDatabaseError("CONNECTION_FAILED")
  await source.dataset.open();
};
```

### Checklist migrasi

- [ ] Tidak ada import `@tsix/cashew` tersisa.
- [ ] Semua `new TForm(...)` memakai `{ title }`, bukan string.
- [ ] Tidak ada `caption` pada `TLabel` dan `text` pada `TStatusBar` (diganti `text` / `leftText`).
- [ ] Timer dibersihkan setelah `form.run()` selesai.
- [ ] Query memakai parameter, bukan string yang disambung.
- [ ] Aplikasi dibuka sekali di DOME tanpa `EComponentError`.

---

## 📚 Referensi

| Sumber | Isi |
| :-- | :-- |
| `src/mirror/lib/pistachio.ts` | Barrel publik `@tsix/pistachio` |
| `src/mirror/lib/pistachio/*.ts` | `core`, `layout`, `controls`, `treeview`, `widgets`, `dialogs`, `keyboard`, `form`, `data`, `dbcontrols` |
| `src/mirror/lib/pistachio*.test.ts` | Tes perilaku (kontrak core, kontrol, dataset, DB controls) |
| `src/mirror/lib/pistachio-contract.test.ts` | Tes kontrak lintas-komponen; pelanggaran yang diketahui ditandai `it.fails` |
| `npm run typecheck:pistachio` | Typecheck Pistachio + konsumennya; harus 0 error |
| `/opt/test/pistachio-demo.ts` | Demo kontrol, layout, widget, dialog, shortcut |
| `/opt/test/pistachio-dbdemo.ts` | Demo stack DB dari CLI (konfigurasi lewat environment) |
| `/opt/test/pistachio-dbcontrols-demo.ts` | DB Browser: grid, navigator, pager, editor record |
| `/opt/lantana/lantana-control-panel.ts` | Aplikasi nyata berbasis Pistachio (tree, editor, monitor) |
| [pistachio-plan.md](./pistachio-plan.md) | Alasan desain, fase, keputusan terbuka |
| [changelogs/pistachio.md](./changelogs/pistachio.md) | Riwayat perubahan |
| [emerald-in-a-nutshell.md](./emerald-in-a-nutshell.md) | Lapisan bawah (`Screen`, widget mentah) |
