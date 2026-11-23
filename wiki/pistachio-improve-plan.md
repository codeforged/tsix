# Pistachio — Rencana Penyempurnaan

**Improvement Plan** | **Version 1.0** | **2026-11-23** | **Status: Disetujui — P0 & P2 selesai, berikutnya P1 (API breaking)**

Pistachio baru dibangun beberapa hari, dan fondasinya sudah sesuai
[pistachio-plan.md](./pistachio-plan.md): satu kontrak konstruktor, props vs
style yang ketat, tree yang dijaga, `TScreenPort`, dan stack database berlapis.
Ketidakseragaman yang tersisa ada di **permukaan API**: nama event, setter vs
`setX()`, penamaan properti teks, error, dan dialog. Ini jenis masalah yang
dulu membuat Cashew sulit dirapikan.

Dokumen ini menetapkan **konvensi tertulis**, lalu menerjemahkannya menjadi
paket kerja dengan bukti (`file:baris`) dan kriteria terima.

> **Kenapa sekarang:** pemakai Pistachio baru 5 aplikasi (§1.2). Perubahan yang
> tidak backward compatible masih murah. Setiap aplikasi baru menaikkan biayanya.

---

## Daftar Isi

0. [Untuk Implementer](#0-untuk-implementer)
1. [Ringkasan](#1-ringkasan)
2. [Temuan](#2-temuan)
3. [Konvensi yang Diusulkan](#3-konvensi-yang-diusulkan)
4. [Paket Kerja](#4-paket-kerja)
5. [Strategi Rilis & Migrasi](#5-strategi-rilis--migrasi)
6. [Keputusan yang Dibutuhkan](#6-keputusan-yang-dibutuhkan)
7. [Non-Goals](#7-non-goals)
8. [Checklist Eksekusi](#8-checklist-eksekusi)

---

## 0. Untuk Implementer

### 0.1 Aturan

| Aturan | Alasan |
| :-- | :-- |
| Edit hanya `src/mirror/**` | `src/rootfs/**` adalah dump VFS, bukan sumber |
| Jangan tulis file `.js` | sidecar `.js` dihasilkan transpile |
| Jangan impor `@tsix/cashew` dari Pistachio | hanya boleh `emerald`, `theme`, `Application` |
| Konsumen dimigrasi **dalam PR yang sama** dengan perubahan API | tidak ada shim kompatibilitas (§5) |
| Setiap paket kerja: kode + tes + update [pistachio-in-a-nutshell.md](./pistachio-in-a-nutshell.md) + changelog | dokumen pengguna tidak boleh tertinggal |

### 0.2 Verifikasi

```bash
npx vitest run src/mirror/lib/pistachio*.test.ts src/mirror/lib/pistachio/   # baseline: 110 lolos
npm run typecheck                                                            # baseline repo: 87 error
npm run typecheck:pistachio                                                  # harus 0 error
```

> ⚠️ **Jangan bungkus `tsc` dengan `timeout`.** Perintah itu tidak ada di macOS;
> `timeout … | grep …` akan "lolos" tanpa pernah menjalankan typecheck. Bandingkan
> jumlah error dengan baseline, atau grep path file yang diubah tanpa `timeout`.
> Paket P2-2 menambah typecheck khusus Pistachio yang harus **0 error**.

---

## 1. Ringkasan

### 1.1 Penilaian

| Area | Status | Catatan |
| :-- | :-- | :-- |
| Kontrak konstruktor & `UNKNOWN_PROP` | ✅ rapi | `core.ts` `resolveOptions` / `assertKnownProps` |
| Tree (`add/remove/dispose/byId`) | ✅ rapi | guard parent, ID, siklus; dispose idempoten |
| Testability (`TScreenPort`) | ✅ rapi | 110 tes tanpa DOME |
| Stack database | ✅ rapi | layering disiplin, `EDatabaseError` ber-`code`, selalu ber-parameter |
| Nama & signature event | ⚠️ belum seragam | T1 |
| Sinkronisasi state (setter vs `setX()`) | ⚠️ belum seragam | T2, T3 |
| Penamaan properti teks & mutabilitas widget | ⚠️ belum seragam | T4, T5 |
| Error terketik | ⚠️ ada yang bocor | T6, T7 |
| Komponen di luar kontrak | ⚠️ | T8, T9 |
| Guard konvensi otomatis | ❌ belum ada | T10 |

### 1.2 Pemakai saat ini

| File | Titik sentuh API yang terdampak* |
| :-- | :-- |
| `src/mirror/opt/test/pistachio-demo.ts` | 22 |
| `src/mirror/opt/test/pistachio-dbcontrols-demo.ts` | 17 |
| `src/mirror/opt/lantana/lantana-control-panel.ts` (+ `lib/lantana/control-panel-tree.ts`) | 11 |
| `src/mirror/opt/azalea-dashboard/azalea-dashboard.ts` | 3 |
| `src/mirror/opt/test/pistachio-dbdemo.ts` | 0 |

\* hitungan kasar `onClick/onChange/onSelect/onToggle/onInput`, `items =`,
`setItems`, `TOpenDialog/TSaveDialog`.

---

## 2. Temuan

| # | Temuan | Bukti | Dampak |
| :-- | :-- | :-- | :-- |
| **T1** | Event untuk konsep yang sama memakai nama/signature berbeda: perubahan nilai = `TCheckBox.onClick(checked)`, `TListBox.onClick(index, item)`, `TComboBox.onChange(index, item)`, `TToggleSwitch.onClick(on)`, `TRelayCard.onToggle(active)`; seleksi = `TTreeView.onSelect(node)`, `TTabulatorGrid.onSelectionChange(index, record)`; aktivasi baris = `onRowDoubleClick(index, record)` vs `TDBGrid.onRecordDoubleClick(record)` | `controls.ts:270,396,486`, `widgets.ts:212,217,509,572`, `treeview.ts:43`, `dbcontrols.ts:458` | pengguna harus menghafal per komponen |
| **T2** | Setter `items` tidak me-render ulang setelah mount; hanya `setItems()` yang render. Melanggar prinsip "satu cara benar" | `controls.ts:422,516` | bug diam: list tidak berubah |
| **T3** | `setItems()` berbeda perilaku: `TComboBox` mempertahankan pilihan, `TListBox` mereset ke -1 | `controls.ts:442` vs `controls.ts:532` | perilaku tak terduga |
| **T4** | Properti teks: `TLabel.text`, `TButton/TCheckBox/TGroupBox.caption`, widget `label`, `TStatusBar.leftText/rightText` tanpa aturan tertulis | `controls.ts:60,87,265`, `layout.ts:125`, `widgets.ts:457…1008,931` | tebak-tebakan saat menulis kode |
| **T5** | Widget menyimpan `label`/`color` sebagai `private readonly` (18 field), sehingga tidak bisa diubah runtime; kontrol dasar bisa | `widgets.ts` (`_label`, `_color`) | widget tidak setara kontrol |
| **T6** | Error `Error` biasa (dan berbahasa Indonesia) di dialog dan `TImage`, melanggar prinsip "kesalahan terketik" | `dialogs.ts:27,39`, `widgets.ts:1173` | tidak bisa dicek via `code` |
| **T7** | Kode `EDatabaseError` dipinjam untuk salah wiring konstruktor: `TProvider`/`TClientDataset`/`TDataSource` melempar `INVALID_QUERY`, `TDBGrid` melempar `INVALID_FIELD` | `data.ts:790,1232,1791`, `dbcontrols.ts:441` | `code` kehilangan makna |
| **T8** | `TOpenDialog`/`TSaveDialog` memakai `constructor(options)`, bukan `(idOrOpts, opts)`, dan bukan komponen | `dialogs.ts:92,121` | satu-satunya pengecualian kontrak |
| **T9** | `TDBGrid extends TTabulatorGrid` mewarisi `setData/appendData/setColumns` dan setter `data/columns` secara publik, sehingga grid terikat dataset bisa diisi manual dan tidak sinkron | `dbcontrols.ts:456` (tidak ada override) | melanggar "kontrol DB hanya bicara ke `TDataSource`" |
| **T10** | Radio: `checked = true` lewat kode tidak meng-uncheck saudara (hanya klik), dan grup dibatasi **parent yang sama** | `controls.ts:368` | state radio bisa ganda |
| **T11** | Props didefinisikan dua kali: interface TS (`TButtonOptions`) dan array runtime (`["caption","enabled"]`), tanpa pemeriksaan silang | `controls.ts:86` vs `controls.ts:99` (pola di semua kelas) | bisa bergeser diam-diam |
| **T12** | Tidak ada tes kontrak lintas-komponen; konvensi hanya dijaga disiplin manual | — | regresi konsistensi tak terdeteksi |
| **T14** | `TDBGrid` menyambung dirinya ke dataset dengan meng-assign `onSort`, `onSelectionChange`, `onRowDoubleClick` miliknya sendiri; aplikasi yang meng-assign event itu memutus sinkronisasi tanpa error | `dbcontrols.ts` konstruktor `TDBGrid` | sinkron grid–dataset bisa putus diam-diam |
| **T13** | Contoh di plan memakai `new TClientDataset({ provider, pageSize: 50 })`, padahal opsi itu tidak ada (paging via `TDBPager`) | `pistachio-plan.md` §6.6 | dokumen menyesatkan |

---

## 3. Konvensi yang Diusulkan

Konvensi ini menjadi bagian tetap dari `pistachio-in-a-nutshell.md` setelah
disetujui. Default di sini adalah rekomendasi; yang masih perlu keputusan
ditandai **[Q#]** (§6).

### K1 — Event

| Event | Kapan | Signature | Komponen |
| :-- | :-- | :-- | :-- |
| `onClick()` | aktivasi murni, tanpa nilai | `() => void` | `TButton`, `TImage` |
| `onInput(value)` | setiap perubahan **sementara** (ketik, geser) | `(value) => void` | `TEdit`, `TMemo`, `TSlider` |
| `onChange(value, …ctx)` | nilai **berubah oleh user** | argumen pertama selalu nilai baru | `TCheckBox`/`TRadioButton` (`checked`), `TComboBox`/`TListBox` (`index, item`), `TToggleSwitch` (`on`), `TRelayCard` (`active`), `TSlider` (saat dilepas), `TEdit`/`TMemo` (Enter/blur) |
| `onSelect(…)` | seleksi di koleksi | `TTreeView`: `(node)`; grid: `(index, record \| null)` | `TTreeView`, `TDataGrid`, `TTabulatorGrid`, `TDBGrid` |
| `onActivate(…)` | aktivasi item (double-click/Enter) | sama dengan `onSelect` | grid, `TTreeView` **[Q1]** |
| `onError(error)` | kegagalan **async** yang dipicu user | `(error: EComponentError \| EDatabaseError) => void` | semua komponen yang melakukan I/O dari event |
| `onRowClick`, `onSort`, `onRowContextMenu`, `onToggle` (tree) | event spesifik yang tidak punya padanan umum | tetap | grid, tree |

Aturan tambahan:

- Event **tidak** dipicu oleh perubahan lewat kode (`cb.checked = true` tidak
  memanggil `onChange`), sama seperti Delphi `OnClick` vs set `Checked`.
  Pengecualian saat ini yang harus diubah: `TTreeView.select(id, notify = true)`
  (`treeview.ts:112`) memicu `onSelect` secara default; default menjadi `false`.
- Event yang sudah ada dan berubah nama **dihapus**, tanpa alias (§5).

### K2 — State & sinkronisasi

1. **Setiap setter publik langsung menyinkronkan UI** bila sudah ter-mount
   (fire-and-forget). Tidak ada setter "data saja".
2. Varian `async setX()` hanya ada bila pemanggil perlu **menunggu render**, dan
   perilakunya **identik** dengan setter.
3. Mengganti isi koleksi **mempertahankan pilihan** bila item yang sama masih
   ada; bila tidak, pilihan → `-1` (list) atau item pertama (combo) **[Q2]**.
4. Semua properti tampilan (caption, label, color, ...) **bisa diubah runtime**;
   tidak ada `readonly` kecuali identitas (`id`) dan wiring (`dataSource`, `field`).

### K3 — Penamaan properti teks

| Nama | Arti | Komponen |
| :-- | :-- | :-- |
| `text` | **isi** yang ditampilkan atau diedit | `TLabel`, `TEdit`, `TMemo`, `TDBText` |
| `caption` | **judul** kontrol yang punya nilai/aksi lain | `TButton`, `TCheckBox`, `TRadioButton`, `TGroupBox`, `TForm.title` tetap |
| `caption` (dari `label`) | judul widget | semua widget IoT **[Q3]** |
| `leftText` / `rightText` | dua panel teks | `TStatusBar` (tetap, panel bernama) |

### K4 — Error

| Situasi | Kelas | Kode baru |
| :-- | :-- | :-- |
| Opsi/props salah, wiring salah | `EComponentError` | `INVALID_OPTIONS` (sudah ada) |
| Wiring stack DB salah tipe (`TProvider` tanpa `TDBQuery`, ...) | `EDatabaseError` | `INVALID_BINDING` (baru, menggantikan `INVALID_QUERY`/`INVALID_FIELD` untuk kasus ini) |
| Operasi butuh form yang sudah `run()` | `EComponentError` | `NOT_MOUNTED` (baru) |
| Baca file/aset gagal (`TImage.loadFile`) | `EComponentError` | `IO_FAILED` (baru, `cause` = error asli) |
| Operasi tidak didukung (mis. `TDBGrid.setData`) | `EComponentError` | `UNSUPPORTED` (baru) |

Pesan error dalam **bahasa Inggris** (konsisten dengan kode lain di core); komentar
kode boleh bahasa Indonesia. Tidak ada `throw new Error(...)` di Pistachio.

### K5 — Satu sumber props

Setiap kelas mendeklarasikan props-nya sekali sebagai `const` array, dan
pemeriksaan tipe memastikan array dan interface sama persis:

```ts
const BUTTON_PROPS = ["caption", "enabled"] as const satisfies readonly (keyof TButtonOptions)[];
// Gagal compile bila interface punya prop yang tidak ada di array (atau sebaliknya):
type _CheckButton = AssertExact<OwnProps<TButtonOptions>, (typeof BUTTON_PROPS)[number]>;
```

`OwnProps<T>` = `Exclude<keyof T, keyof TOptions>`; helper tipe ada di `core.ts`.

### K6 — Komponen non-visual

Komponen pendukung yang hidup bersama form (`TKeyboard`, `TDBConnection`, dialog
file **[Q4]**) adalah `TComponent` dengan `isVisual = false` dan mengikuti
kontrak konstruktor. Helper statis murni (`TDialogs`) tetap statis.

---

## 4. Paket Kerja

Estimasi dalam jam fokus, termasuk tes dan dokumen.

### P0 — Bug & kebenaran (tidak mengubah API publik)

| ID | Pekerjaan | Temuan | Kriteria terima | Est. |
| :-- | :-- | :-- | :-- | :-- |
| P0-1 | Setter `items` (`TComboBox`, `TListBox`) me-render ulang setelah mount, identik dengan `setItems()` | T2 | tes: setter setelah bind memanggil `host.setContent`; dokumen menghapus peringatan `setItems` | 1–2 |
| P0-2 | `TListBox.setItems()` mempertahankan pilihan seperti `TComboBox` (K2.3) | T3 | tes kedua kelas dengan skenario sama: item tetap ada / hilang | 1 |
| P0-3 | `TRadioButton`: `checked = true` lewat kode meng-uncheck anggota grup lain | T10 | tes: set programatik → tepat satu checked | 1 |
| P0-4 | `TDBGrid` menolak `setData/appendData` dan setter `data` dengan `EComponentError("UNSUPPORTED")`; `setColumns`/`columns` hanya ditolak bila kolom `"auto"` (kolom eksplisit boleh diganti, itu urusan tampilan) | T9 | tes: tiap method melempar; grid tetap sinkron dataset | 1–2 |
| P0-5 | Perbaiki contoh plan §6.6 | T13 | contoh memakai `TDBPager({ pageSize })` | 0,5 |

### P1 — Konsistensi API (breaking, konsumen ikut dimigrasi)

| ID | Pekerjaan | Temuan | Kriteria terima | Est. |
| :-- | :-- | :-- | :-- | :-- |
| P1-1 | Terapkan K1: `onChange` untuk perubahan nilai, `onSelect` untuk koleksi, `onActivate` untuk aktivasi baris, `onInput`/`onChange` di `TEdit`/`TMemo`/`TSlider`. Wiring internal komponen (mis. `TDBGrid`) memakai hook `protected`, bukan event publik; `TDBGrid.onRecordDoubleClick` → `onActivate` | T1, T14 | tabel K1 terpenuhi; entri P1-1 di `KNOWN_VIOLATIONS` kosong; 5 konsumen dimigrasi dan jalan | 5–7 |
| P1-2 | Terapkan K3: widget `label` → `caption` | T4 | semua widget menerima `caption`; `label` → `UNKNOWN_PROP` | 2–3 |
| P1-3 | Terapkan K2.4: properti tampilan widget bisa di-set runtime (hapus `readonly` `_label`/`_color`/...) | T5 | tes: ubah `caption`/`color` setelah bind memicu render | 3–4 |
| P1-4 | Terapkan K4: kode error baru, hapus `throw new Error`, pesan berbahasa Inggris | T6, T7 | `grep "new Error(" src/mirror/lib/pistachio` kosong; tes memeriksa `code` | 2–3 |
| P1-5 | Dialog file sebagai komponen non-visual (K6) **[Q4]**: `new TOpenDialog({ id, title, filter })`, `form.add(dlg)`, `await dlg.execute()` | T8 | kontrak konstruktor berlaku; `execute()` tanpa owner memakai form induk; `NOT_MOUNTED` bila belum `run()` | 3–4 |
| P1-6 | `onError` seragam untuk I/O async dari event (`TImage.loadFile` via klik, kontrol DB yang sudah ada) | K1 | satu tipe signature; tes tiap komponen | 2 |

### P2 — Guard & tooling (mencegah drift)

| ID | Pekerjaan | Temuan | Kriteria terima | Est. |
| :-- | :-- | :-- | :-- | :-- |
| P2-1 | Terapkan K5 (satu sumber props + `AssertExact`) di semua kelas | T11 | menambah prop di interface tanpa array → gagal compile | 3–4 |
| P2-2 | `tsconfig.pistachio.json` + skrip `typecheck:pistachio` (hanya `lib/pistachio*` + konsumen) | 0.2 | **0 error**; dipakai di checklist PR | 1 |
| P2-3 | Tes kontrak lintas-komponen: loop semua kelas yang diekspor barrel, cek (a) 3 bentuk konstruktor, (b) `UNKNOWN_PROP`, (c) `isVisual` eksplisit, (d) `dispose()` idempoten, (e) setiap setter publik memanggil `host.update/setContent` setelah bind, (f) nama event mengikuti K1 | T12 | kelas baru otomatis ikut diuji; melanggar konvensi → tes gagal | 4–6 |
| P2-4 | Fire-and-forget terpusat: `push()`/`rerender()` menangkap rejection dan melaporkannya (log + `onError` bila ada), bukan unhandled rejection | — | tes: host yang melempar tidak menghasilkan unhandled rejection | 2 |

### P3 — Kelengkapan fitur (opsional, setelah P1)

Fitur yang ada di Cashew tapi belum ada di Pistachio, dicatat di
[Batasan Saat Ini](./pistachio-in-a-nutshell.md#-batasan-saat-ini). Masing-masing
mengikuti konvensi §3 sejak awal.

| ID | Pekerjaan | Est. |
| :-- | :-- | :-- |
| P3-1 | `TTimer` non-visual (`interval`, `enabled`, `onTimer`), dibersihkan otomatis saat dispose | 2–3 |
| P3-2 | `TSplit` (horizontal/vertikal, bisa di-drag) sebagai class container | 4–6 |
| P3-3 | `TForm.minimize/restore/unMaximize` | 1 |
| P3-4 | `toggleSort()` di grid | 1 |
| P3-5 | Driver CSV read-only (Fase 5 plan, uji independensi driver) | 6–8 |

### Total

| Prioritas | Estimasi |
| :-- | :-- |
| P0 | 4,5–6,5 jam |
| P1 | 17–23 jam |
| P2 | 10–13 jam |
| **P0–P2** | **~32–42 jam (4–5 hari kerja fokus)** |
| P3 (opsional) | 14–19 jam |

---

## 5. Strategi Rilis & Migrasi

1. **P0 dulu**, satu commit per item. Tidak mengubah API, jadi aman dirilis kapan saja.
2. **P2-2 dan P2-3 sebelum P1.** Tes kontrak ditulis terhadap konvensi §3 dan
   awalnya ditandai `todo`/gagal untuk pelanggaran yang diketahui. P1 lalu
   "menghijaukan" tes itu satu per satu, sehingga progres terukur.
3. **P1 sebagai satu rilis breaking** (tanpa alias/shim): Pistachio masih muda dan
   konsumennya hanya 5 file. Alias justru menciptakan "dua cara" yang ingin dihapus.
   Setiap PR P1 memigrasi kelima konsumen dan menjalankan demo di DOME.
4. Setelah P1: bagian **Konvensi** ditambahkan ke `pistachio-in-a-nutshell.md`,
   dan pemetaan migrasi Cashew diperbarui ke nama event baru.
5. Setelah rilis P1, perubahan nama API publik butuh catatan migrasi di changelog.

---

## 6. Keputusan yang Dibutuhkan

> **Diputuskan pemilik proyek (2026-11-23):** semua mengikuti kolom
> **Rekomendasi**. Kolom Alternatif dipertahankan sebagai catatan.

| # | Pertanyaan | Rekomendasi | Alternatif |
| :-- | :-- | :-- | :-- |
| Q1 | Nama event aktivasi baris/node | `onActivate` (netral untuk double-click & Enter) | `onDoubleClick` (lebih Delphi, tapi tidak mencakup Enter) |
| Q2 | Combo kehilangan item terpilih setelah `setItems` → pilih apa? | item pertama (combo tak pernah kosong); list → `-1` | keduanya `-1` |
| Q3 | Widget: `label` → `caption`? | ya, satu aturan K3 untuk semua | biarkan `label` di widget (lebih sedikit churn, aturan K3 punya pengecualian) |
| Q4 | Dialog file jadi komponen non-visual? | ya (Delphi-style, `execute()` tanpa owner) | tetap kelas biasa, hanya samakan konstruktor ke `(idOrOpts, opts)` |
| Q5 | Rilis breaking P1 tanpa alias? | ya, konsumen dimigrasi bersamaan | alias `@deprecated` selama satu rilis |
| Q6 | Grup radio dibatasi parent yang sama? | lingkup **form** (seperti atribut `name` HTML dalam form) | tetap parent (perilaku sekarang, didokumentasikan) |
| Q7 | Bahasa pesan error | Inggris | Indonesia (perlu ubah seluruh core & data) |

---

## 7. Non-Goals

- Fitur baru di luar P3 (designer visual, transaksi DB, multi-koneksi).
- Mengubah arsitektur yang sudah rapi: kontrak konstruktor, tree, `TScreenPort`,
  layering stack database.
- Menyentuh Cashew.
- Mengubah tampilan/tema default komponen.

---

## 8. Checklist Eksekusi

### P0

- [x] P0-1 Setter `items` me-render ulang
- [x] P0-2 `TListBox.setItems` mempertahankan pilihan
- [x] P0-3 Radio programatik meng-uncheck grup (+ Q6: grup eksplisit lingkup form)
- [x] P0-4 `TDBGrid` menolak API data manual
- [x] P0-5 Contoh plan §6.6

### Keputusan

- [x] Q1–Q7 diputuskan pemilik proyek, dicatat di tabel §6 (semua: rekomendasi)

### P2 (fondasi guard)

- [x] P2-2 `typecheck:pistachio` 0 error
- [x] P2-3 Tes kontrak lintas-komponen
- [x] P2-1 Satu sumber props
- [x] P2-4 Fire-and-forget terpusat

**Catatan pelaksanaan P2** (2026-11-23):

- **P2-2:** `tsconfig.pistachio.json` mencakup `lib/pistachio*` + 6 file konsumen.
  Dua error bawaan di inti OS yang ikut terimpor (`IProgram.ts`: `AuxLib` tidak
  pernah didefinisikan; `RandomLib.ts`: path impor `SyscallCode` salah) berada di
  luar cakupan: skrip melaporkannya sebagai catatan, bukan kegagalan.
- **P2-3:** 13 pelanggaran yang diketahui tercatat di `KNOWN_VIOLATIONS` sebagai
  `it.fails` (11 untuk P1-1, 2 untuk P1-5) dan menjadi ukuran progres P1. Temuan
  baru: `TDBGrid.onRecordDoubleClick` juga melanggar K1 (masuk P1-1).
  `TTabulatorGrid` menyinkronkan lewat IPC DOME, bukan `TScreenPort`; tes memeriksa
  saluran itu.
- **P2-1:** helper `defineProps<T, TBase>()` + `OwnProps`/`AssertExact` di
  `core.ts`, diterapkan di 40 deklarasi props (semua kelas ber-props). Langsung menemukan drift: `TDBTextOptions`
  mewarisi `parseValue` yang ditolak runtime (`UNKNOWN_PROP`); kini di-`Omit`.
- **P2-4:** `TComponent.background()` / `reportError()` menggantikan ~40
  `void promise` dan `reportAsyncError` milik DB controls. Auto-load `TImage.file`
  yang dulu menelan error diam-diam kini melaporkannya. Tanpa P2-4, 43 tes kontrak
  gagal karena unhandled rejection.

### P1

- [x] P1-1 Event K1 + migrasi 5 konsumen
- [x] P1-2 `label` → `caption`
- [ ] P1-3 Properti tampilan widget runtime
- [ ] P1-4 Error K4
- [ ] P1-5 Dialog file non-visual
- [ ] P1-6 `onError` seragam
- [ ] Bagian Konvensi masuk `pistachio-in-a-nutshell.md`

### P3 (opsional)

- [ ] P3-1 `TTimer` · [ ] P3-2 `TSplit` · [ ] P3-3 window control · [ ] P3-4 `toggleSort` · [ ] P3-5 driver CSV
