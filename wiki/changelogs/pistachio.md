# Changelog Pistachio GUI Framework

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-11-23

### Dokumentasi `pistachio-in-a-nutshell.md` + panduan migrasi

- **File:** `wiki/pistachio-in-a-nutshell.md` (baru), `wiki/pistachio-plan.md`,
  `wiki/cashew-in-a-nutshell.md`, `wiki/Home.md`.
- **Isi:** konsep inti (konstruktor, props vs style, tree, lifecycle, error),
  `TForm`, layout, kontrol dasar, `TTreeView`, grid manual, widget IoT, dialog,
  shortcut, stack database (koneksi → kontrol DB, alur edit, paging, error),
  daftar batasan saat ini, dan panduan migrasi dari Cashew (pemetaan API, contoh
  sebelum/sesudah termasuk pengganti `TTimer`, checklist).
- **Verifikasi:** semua contoh kode Pistachio di dokumen di-typecheck terhadap
  `@tsix/pistachio`. Contoh di plan (`TClientDataset({ pageSize })`) tidak sesuai
  kode; dokumen memakai `TDBPager({ pageSize })`.
- **Banner Cashew** kini mengarah ke Pistachio, bukan "menunggu Pistachio siap".
- **Oleh:** Claude

## 2026-11-22

### Paket `pistachio-demos` dan menu launcher

- **File:** `src/mirror/etc/tpkg/packages.json`,
  `src/mirror/etc/asteracea/menu/pistachio-demo.menu`,
  `src/mirror/etc/asteracea/menu/pistachio-dbcontrols-demo.menu`,
  `src/mirror/sbin/transpile.ts`, `scripts/twrapper/iot-edition.json`.
- **Paket:** `pistachio-demos` mengemas `pistachio-demo.ts`, `pistachio-dbdemo.ts`,
  `pistachio-dbcontrols-demo.ts`, data contoh `pistachio-dbcontrols-demo.sql`,
  dan menu launcher-nya. `onAfterDownload` menjalankan `/sbin/transpile.ts`
  supaya sidecar `.js` siap dipakai setelah instalasi.
- **Launcher:** "Pistachio Demo" dan "Pistachio DB Browser" masuk grup
  "Pistachio Demo" di Asteracea.
- **Transpile:** `/opt` ditambahkan ke aturan mode `/sbin/transpile.ts` (0o755)
  agar sidecar aplikasi di `/opt` bisa dijalankan user biasa — selama ini hanya
  `/bin`, `/sbin`, `/usr/bin`, dan `/usr/local/bin` yang di-chmod.
- **Oleh:** Copilot

## 2026-11-19

### Rendering ulang widget IoT dan chart dashboard

- **File:** `src/mirror/lib/pistachio/widgets.ts`,
  `src/mirror/lib/pistachio/widgets.test.ts`,
  `src/mirror/opt/azalea-dashboard/azalea-dashboard.ts`.
- **Rendering:** `TViewWidget` menggunakan ID terpisah untuk view di dalam kartu
  dan mengantrekan render ulang secara berurutan. Ini mencegah pembaruan sensor
  atau chart melepas kartu induk maupun menghilangkan binding klik switch.
- **Switch:** `TToggleSwitch` mendukung mode `controlled`; klik hanya
  mengirimkan permintaan perubahan, sedangkan tampilan menunggu status aktual
  dari pemilik data.
- **`TLineChart`:** mendukung style view dan penyembunyian label sumbu X/Y;
  data identik tidak memicu render ulang.
- **Verifikasi:** 10 tes widget dan dashboard terkait lulus.
- **Oleh:** Copilot

## 2026-11-18

### `TTreeView` dan `TForm.maximize()`

- **File:** `src/mirror/lib/pistachio/treeview.ts` (baru),
  `src/mirror/lib/pistachio/form.ts`, `src/mirror/lib/pistachio.ts`,
  `src/mirror/lib/pistachio-controls.test.ts`.
- **Komponen:** `TTreeView` menampilkan pohon beranak dengan `icon`, `hint`, dan
  `data` per simpul. Baris di-flatten sesuai state buka/tutup sehingga pemakai
  tidak menghitung kedalaman sendiri. `onSelect` memberi simpul yang diklik,
  `onToggle` melaporkan buka/tutup; `select()` ikut membuka rantai induknya.
- **Interaksi:** klik baris memilih simpul (dan membuka anaknya bila tertutup),
  sedangkan klik chevron hanya membuka/menutup agar pemilihan tidak berubah.
- **Ketahanan klik:** id baris diturunkan dari id simpul (bukan indeks), jadi
  klik yang datang setelah render berikutnya tetap mengenai simpul yang benar.
  Pemilihan memakai `onSelect` sinkron dan hanya memperbarui style baris
  (`applySelection`), sehingga form pemakai langsung tampil tanpa menunggu
  `setContent`; render ulang penuh hanya terjadi saat cabang dibuka/ditutup.
- **API:** `setNodes()` mengganti isi pohon sambil mempertahankan id yang masih
  ada, `expand()/collapse()/toggle()/expandAll()/collapseAll()`, serta getter
  `rows`, `selectedId`, `selectedNode`, dan `expandedIds`.
- **`TForm.maximize()`:** meneruskan ke `Screen.maximize()` supaya form bisa
  dibuka penuh tanpa mengakses `form.screen`.
- **`TComboBox.setItems()`:** opsi bisa diganti saat runtime (mis. lookup yang
  bergantung pada pilihan lain); nilai terpilih dipertahankan bila masih ada,
  selain itu jatuh ke opsi pertama atau `-1` saat daftar kosong.
- **Verifikasi:** 29 tes controls lulus (termasuk 2 tes `setItems` dan 5 tes
  `TTreeView`).
- **Oleh:** Copilot

### Fase 4 DB — DB Controls

- **File:** `src/mirror/lib/pistachio/dbcontrols.ts`,
  `src/mirror/lib/pistachio-dbcontrols.test.ts`, dan
  `src/mirror/opt/test/pistachio-dbcontrols-demo.ts`.
- **Binding:** `TDBText`, `TDBEdit`, `TDBMemo`, dan `TDBListBox` diturunkan
  dari kontrol dasar Pistachio dan terikat ke `TDataSource`. Edit mengikuti
  capability dataset; field numerik, boolean, tanggal, dan JSON diparse dengan
  validasi tipe.
- **Grid/navigator:** `TDBGrid` memakai Tabulator, membuat kolom dari metadata,
  menyinkronkan pilihan baris dengan cursor dataset tanpa meninggalkan highlight
  pada baris lama, dan mendukung sort serta double-click ke record terpilih.
  `TForm` meneruskan keydown yang ditangkap ke tree komponen; event berhenti
  pada komponen pertama yang menanganinya. `TDBGrid` mengurus navigasi panah
  saat browser aktif, sedangkan `TDBNavigator` menjadi fallback jika grid tidak
  ada, sehingga satu penekanan tombol tidak menggerakkan cursor dua kali.
  Form editor juga memiliki navigator record;
  permintaan pindah record otomatis mem-Post edit aktif ke buffer tanpa
  mengirimnya ke MySQL. Cancel tetap tersedia untuk membatalkan edit sebelum
  berpindah; perubahan yang sudah di-Post perlu Apply.
  `TDBNavigator` menyediakan navigasi, edit, post, cancel, delete, dan apply;
  kegagalan apply per baris dilaporkan melalui callback atau console serta
  status navigator.
- **Lifecycle GUI:** penutupan form melepas seluruh handler/subscription tanpa
  mengirim unmount per-node ke window yang sedang dihancurkan.
- **Demo:** aplikasi GUI DB Browser terpisah membaca tabel database aktif.
  Konfigurasi koneksi hanya dari environment, tanpa kredensial di source.
- **DB Browser:** demo menampilkan tabel database aktif dan maksimal 200 baris
  per halaman. `TDBPager` menghitung total record dan menjalankan query
  `LIMIT/OFFSET`; query aplikasi cukup menyediakan `SELECT` tanpa paging manual.
  Tombol pindah halaman diblokir saat edit aktif atau perubahan lokal belum
  di-Apply, dan cursor diposisikan ke record pertama di halaman baru.
  Pager tampil `[ 2 ] of 10`: nomor halaman berupa `TEdit` yang bisa diketik
  lalu di-commit dengan Enter atau saat field ditinggalkan (`change`), dan
  fokus keyboard dikembalikan ke window setelah Enter supaya panah langsung
  menggerakkan record. Input di luar jangkauan atau bukan angka ditolak dengan
  pesan di samping tombol, dan nomor halaman dipulihkan.
  DOME kini meneruskan event `change` (`onChangeId`) sebagai sinyal onExit.
  `TDBNavigator` menyediakan navigasi, insert, edit, delete, serta
  apply; edit/double-click membuka form berisi DB controls berdasarkan metadata.
  Pemilih tabel tetap aktif; permintaan Refresh/pindah tabel saat editor terbuka,
  edit aktif, atau perubahan belum di-Apply ditolak dengan status yang jelas.
  Update/delete hanya aktif saat metadata driver mendukungnya dan delete
  meminta konfirmasi. DDL + seed data idempotent tersedia di
  `pistachio-dbcontrols-demo.sql`.
- **Verifikasi:** 76 tes fokus lulus mencakup DB Controls, grid, keyboard,
  paging, input nomor halaman, dan lifecycle komponen. Smoke test pager dengan driver palsu
  1.000.000 baris hanya memuat 100 baris per halaman (200 baris untuk dua kali
  fetch), total 10.000 halaman, dan halaman terakhir berhenti tepat di record
  terakhir. Typecheck proyek masih gagal pada sejumlah error yang sudah ada.
- **Oleh:** Copilot

### Fase 3 DB — `TClientDataset` dan `TDataSource`

- **File:** `src/mirror/lib/pistachio/data.ts`,
  `src/mirror/lib/pistachio-data.test.ts`, dan `pistachio-dbdemo.ts`.
- **Dataset:** buffer baris, cursor (`first/next/prior/last`), filter/sort
  callback, state `dsBrowse/dsEdit/dsInsert`, serta `edit/insert/post/cancel/delete`.
- **Dirty tracking:** update/insert/delete dikirim lewat provider; hasil sukses
  disinkronkan ke buffer, sementara baris gagal tetap dirty untuk dicoba ulang.
  Refresh/close menolak perubahan yang belum diterapkan.
- **Binding:** `TDataSource` meneruskan field, record aktif, navigasi, operasi
  edit, dan notifikasi ke banyak subscriber.
- **Demo:** `pistachio-dbdemo.ts` kini menguji rantai connection → query →
  provider → dataset → data source menggunakan query probe yang sama.
- **Verifikasi:** tes cursor, sort/filter, state machine, CRUD apply,
  notifikasi, dan retry state.
- **Oleh:** Copilot

### Fase 2 DB — `TProvider`

- **File:** `src/mirror/lib/pistachio/data.ts`, `DbLib.ts`, `MySQLDevice.ts`,
  dan `mysqld.ts`.
- **Fetch:** provider membuka atau menjalankan ulang `TDBQuery` dan meneruskan
  baris beserta metadata field ke lapisan dataset.
- **Apply:** perubahan insert/update/delete dieksekusi berurutan memakai
  parameter named. Hasil melaporkan sukses/gagal per baris; kegagalan satu
  baris tidak menghilangkan laporan atau menghentikan percobaan berikutnya.
- **Keamanan pemetaan:** table, primary key, dan nama kolom sumber diambil dari
  metadata MySQL. Query multi-tabel atau tanpa primary key tidak dianggap dapat
  di-update otomatis; `tableName`/`primaryKey` dapat diberikan eksplisit.
- **Kapabilitas:** operasi tulis ditolak saat driver read-only atau tidak
  mendukung parameter. Tidak ada transaksi; setiap baris berdiri sendiri.
- **Verifikasi:** tes provider memakai mock driver mencakup fetch, SQL
  berparameter, laporan kegagalan per baris, read-only, dan primary key.
- **Oleh:** Copilot

### Fase 1 DB — `TDBConnection`, `TDBQuery`, dan parameterized query

- **File:** `src/mirror/lib/pistachio/data.ts`, `DbLib.ts`, `Syscalls.ts`,
  `MySQLDevice.ts`, `mysqld.ts`, dan barrel `pistachio.ts`.
- **Transport:** `DB_QUERY` kini menerima query dengan parameter positional
  (`?`) atau named (`:name`) di jalur device dan daemon. Pemanggilan lama
  `db.query(sql)` tetap mengirim bentuk string.
- **API:** `TDBConnection` membuka/menutup koneksi MySQL, menyediakan
  `execute()` dan capability flags; `TDBQuery` menjalankan SQL ber-parameter
  dan membawa metadata field dari hasil query. Error dibungkus sebagai
  `EDatabaseError`.
- **Driver:** built-in MySQL memakai `DbLib`; driver kustom dapat diinjeksi.
  Driver bernama selain `mysql` belum tersedia. Satu koneksi MySQL Pistachio
  per proses untuk sementara.
- **Demo:** `pistachio-dbdemo.ts` terpisah dari demo GUI; memakai
  `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, dan `DB_PORT` opsional dari
  environment, lalu menguji named parameter dengan `SELECT`.
- **Batas saat fase ini ditutup:** `TProvider`, `TClientDataset`,
  `TDataSource`, DB controls, dan driver CSV masih menunggu fase lanjutan.
- **Oleh:** Copilot

### `TKeyboard` — shortcut hanya saat window fokus

- **File:** `src/mirror/lib/pistachio/{keyboard,form,core}.ts`,
  `src/mirror/lib/emerald.ts`
- **Model:** satu capture keyboard per window. `TForm` membuat `Keyboard`
  emerald, attach setelah window ter-mount, menyimpannya di `Screen.keyboard`,
  dan detach saat `close()`. Komponen `TKeyboard` (non-visual) hanya
  berlangganan, jadi beberapa set shortcut bisa hidup berdampingan.
- **API:** `new TKeyboard({ shortcuts: { "Ctrl+S": fn, "F2": fn } })`, plus
  `bind()`, `unbind()`, dan `onKey` untuk event mentah.
- **Normalisasi:** `"ctrl+shift+s"` setara `"Ctrl+Shift+S"`; `"space"` setara
  `"Space"`. Keyup dan auto-repeat diabaikan.
- **Fokus:** DOME hanya merutekan `kb_key` ke window yang sedang fokus dan
  me-refokus capture saat window diklik, sehingga shortcut mati saat aplikasi
  tidak aktif. Ketikan di `input`/`textarea`/`select` sengaja tidak dianggap
  shortcut oleh DOME.
- **Demo:** `Ctrl+S`, `F2`, `Ctrl+Q` (konfirmasi keluar), serta `Escape` lewat
  `onKey`.
- **Verifikasi:** 64 tes Pistachio lulus; `tsc` bersih.
- **Oleh:** Copilot

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
