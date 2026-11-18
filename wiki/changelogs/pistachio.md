# Changelog Pistachio GUI Framework

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-11-18

### Grid Tabulator, kontrol tambahan, dan dialog

- **File:** `src/mirror/lib/pistachio/{widgets,dialogs}.ts`
- **Grid:** `TDataGrid` dan `TTabulatorGrid` kini memakai basis `TGridBase` —
  API identik (`setData`, `appendData`, `setColumns`, `selectedIndex`,
  `selectedRecord`, `getRecord`, `setSelectedIndex`, `clearSelection`,
  `onSort`, `onRowClick`, `onRowContextMenu`), dengan tambahan
  `onSelectionChange` + opsi `selectable` untuk Tabulator.
- **Kontrol tambahan:** `TStatusBar`, `TSlider` (clamp + nilai tampil live),
  `TImage` (src/data URI atau `file` VFS otomatis jadi data URI).
- **Dialog:** `TDialogs.alert/confirm/input` (trio) serta `TOpenDialog` dan
  `TSaveDialog` yang membungkus `Screen.openFileDialog`/`saveFileDialog`.
  Semua menerima `TForm` atau `Screen`.
- **Demo:** grup **Dialog** (Alert, Confirm, Input, Open…, Save…).
- **Verifikasi:** 56 tes Pistachio lulus; `tsc` bersih.
- **Oleh:** Copilot

### Footprint seragam untuk kartu IoT

- **File:** `src/mirror/lib/pistachio/widgets.ts`
- **Latar:** lampu, switch, relay, sensor card, dan radial gauge mengikuti lebar
  isi masing-masing sehingga tampak tidak rapi di `TGroupBox`/grid.
- **Perubahan:** basis `TCardWidget` memberi seluruh kartu ukuran tetap
  **132×156 px** dengan `boxSizing: border-box` dan `flex: 0 0 auto`. View dari
  builder emerald di-stretch `width/height: 100%` + `minWidth: 0` agar mengisi
  kartu. Default `size` radial gauge diturunkan ke 92 agar proporsional.
- **Override:** ukuran tetap bisa diubah per komponen lewat `style`
  (`{ width: "200px", height: "90px" }`). Bila `width` diubah tanpa `minWidth`,
  `minWidth` otomatis mengikuti lebar baru.
- **Alignment:** isi kartu kini di-flex kolom dengan `justify-content: center`,
  jadi konten selalu berada di tengah secara vertikal berapa pun tingginya.
- **Verifikasi:** 11 tes widget lulus (termasuk keseragaman ukuran); `tsc` bersih.
- **Oleh:** Copilot

### Widget IoT Pistachio

- **File:** `src/mirror/lib/pistachio/widgets.ts`
- **Perubahan:** `TProgressBar`, `TIndicatorLamp`, `TToggleSwitch`, `TRelayCard`,
  `TSensorCard`, `TLineChart`, `TRadialGauge`, `TSevenSegment`, `TVerticalGauge`.
- **Pola update:** `TViewWidget` menyimpan view hasil builder emerald, lalu saat
  nilai berubah view lama di-unmount dan view baru di-mount dengan id stabil.
  Tidak ada duplikasi logika path SVG/HTML per widget.
- **Interaksi:** `TToggleSwitch` dan `TRelayCard` menangani klik, mengubah state,
  memanggil callback, lalu render ulang. `TRelayCard` menambahkan `onClickId`
  pada node relay sebelum mount.
- **Demo:** grup "Widget IoT" di `pistachio-demo` (lampu, toggle, relay, sensor
  card, radial gauge, progress bar, seven segment, line chart).
- **Verifikasi:** 40 tes Pistachio lulus; `tsc` bersih.
- **Oleh:** Copilot

### `TDataGrid` (data manual) + tampilan `readOnly`

- **File:** `src/mirror/lib/pistachio/{controls,widgets}.ts`
- **Read-only:** `TEdit`/`TMemo` kini membedakan tampilan saat `readOnly` —
  latar lebih samar, teks muted, `boxShadow` inset (efek embos ke dalam), dan
  `cursor: default`. Style dari pengguna tetap dipertahankan.
- **`TDataGrid`:** wrapper `ConnectedDataGrid` untuk data **manual** (tanpa stack
  database). Opsi `columns`, `data`, `height`, `maxRows`; API `setData`,
  `appendData`, `setColumns`, `selectedIndex`, `selectedRecord`, `getRecord`,
  serta callback `onSort`, `onRowClick`, `onRowContextMenu` (index = row-key
  stabil, tahan sorting).
- **`TListBox`:** lebar bawaan `100%` + `minWidth: 0` agar tidak menyusut di
  container flex.
- **Verifikasi:** 32 tes lulus; `tsc --noEmit` bersih untuk modul Pistachio.
- **Oleh:** Copilot

### Kontrol dasar, layout, dan `TForm`

- **File:** `src/mirror/lib/pistachio/{layout,controls,form}.ts`
- **Perubahan:**
  - Layout sebagai **class** (bukan factory function): `TPanel`, `THStack`,
    `TVStack`, `TGridPanel`, `TScrollBox`, `TSpacer`, `TGroupBox`.
  - Kontrol dasar: `TLabel`, `TButton`, `TEdit`, `TMemo`, `TCheckBox`,
    `TRadioButton`, `TComboBox`, `TListBox`.
  - `TForm`: mount window emerald, auto-bind, auto-refresh, `onSetup`,
    mount inkremental untuk `add()` setelah `run()`, dan `close()` yang
    menghancurkan subtree.
  - `TScreenPort`: core tidak mengimpor `emerald`, sehingga kontrol bisa diuji
    dengan port palsu (tanpa DOME).
  - Perilaku klik checkbox/radio dipisah lewat hook `handleClick()` agar radio
    bisa memakai logika pilih-tunggal tanpa menduplikasi binding.
- **Verifikasi:** 26 tes lulus (12 core + 14 kontrol/layout/form);
  `tsc --noEmit` tanpa error di modul Pistachio.
- **Oleh:** Copilot

### Fase 0 — Core komponen Pistachio

- **File:** `src/mirror/lib/pistachio.ts`, `src/mirror/lib/pistachio/core.ts`
- **Latar:** Pistachio dibangun sebagai set komponen baru yang **tidak backward
  compatible** dengan Cashew, supaya kontraknya bisa bersih sejak awal.
- **Perubahan:**
  - Barrel publik `@tsix/pistachio` + modul `pistachio/core.ts`.
  - `resolveOptions()` menormalkan tiga bentuk pemanggilan (`("id")`,
    `({ ...opsi })`, `("id", { ...opsi })`) menjadi satu objek opsi.
  - `assertKnownProps()` menolak key tak dikenal (`UNKNOWN_PROP`) sehingga typo
    tidak lagi diam-diam berubah menjadi CSS seperti perilaku `splitConfig`.
  - `TComponent`: `add`, `remove`, `byId`, `dispose`, `build`, `isVisual`.
    Guard: `ALREADY_PARENTED`, `DUPLICATE_ID` (atomik), `CYCLE`, `NOT_A_CHILD`,
    `DISPOSED`.
  - `remove()` melepas tanpa menghancurkan (mendukung re-parent); `dispose()`
    menghancurkan subtree, idempoten, dan otomatis melepas dari parent.
  - Error terketik `EComponentError` dengan `code` + `componentId`.
- **Catatan desain:** `isVisual` default `true`; kelas non-visual menyetelnya
  `false` di konstruktor. `build()` menyaring child non-visual.
- **Verifikasi:** 12 tes core lulus; `tsc --noEmit` tidak menambah error baru.
- **Oleh:** Copilot
