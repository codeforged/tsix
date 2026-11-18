# Cashew — Rencana Peningkatan (Improvement Plan)

**Improvement Plan** | **Version 1.0** | **2026-11-16** | **Status: Draft**

Dokumen ini merangkum hasil review [cashew-in-a-nutshell.md](./cashew-in-a-nutshell.md),
[emerald-in-a-nutshell.md](./emerald-in-a-nutshell.md), dan contoh aplikasi di
`src/mirror/opt/test/` — lalu menerjemahkannya menjadi daftar pekerjaan yang
bisa dieksekusi bertahap.

> Tujuan dokumen: **tidak ada keputusan desain yang hilang**. Setiap temuan
> punya bukti (file:baris), setiap perbaikan punya kriteria terima.

---

## Daftar Isi

0. [Untuk Implementer (Manusia atau AI Agent)](#0-untuk-implementer-manusia-atau-ai-agent)
1. [Ringkasan](#1-ringkasan)
2. [Prinsip yang Harus Dipertahankan](#2-prinsip-yang-harus-dipertahankan)
3. [Basis Temuan](#3-basis-temuan)
4. [Rencana Kerja P0 — Bug & Fondasi](#4-rencana-kerja-p0--bug--fondasi)
5. [Rencana Kerja P1 — Ergonomi & Konsistensi](#5-rencana-kerja-p1--ergonomi--konsistensi)
6. [Rencana Kerja P2 — Testability & Tooling](#6-rencana-kerja-p2--testability--tooling)
7. [Keputusan: Posisi Emerald vs Cashew](#7-keputusan-posisi-emerald-vs-cashew)
8. [Arah Jangka Panjang: Form File `.cfm` (ala `.dfm`)](#8-arah-jangka-panjang-form-file-cfm-ala-dfm)
9. [Cara Kerja & Verifikasi](#9-cara-kerja--verifikasi)
10. [Non-Goals](#10-non-goals)
11. [Pertanyaan Terbuka](#11-pertanyaan-terbuka)
12. [Checklist Eksekusi](#12-checklist-eksekusi)
13. [Lampiran A — Kontrak Tugas (File, Simbol, Dependensi)](#13-lampiran-a--kontrak-tugas-file-simbol-dependensi)
14. [Lampiran B — Keputusan Default](#14-lampiran-b--keputusan-default)

---

## 0. Untuk Implementer (Manusia atau AI Agent)

Bagian ini **wajib dibaca lebih dulu**. Tujuannya: siapa pun — manusia atau agent AI —
yang mengambil dokumen ini bisa mulai bekerja tanpa perlu bertanya ulang.

### 0.1 Urutan baca

1. Dokumen ini: §0 → §7 → §13 (kontrak tugas) → §14 (keputusan default).
2. [`cashew-in-a-nutshell.md`](./cashew-in-a-nutshell.md) — API & perilaku yang dijanjikan ke user.
3. [`src/mirror/lib/cashew.ts`](../src/mirror/lib/cashew.ts): `TComponent` (L131–238),
   `TForm.run` (L396–473), `TForm.close` (L532), `TTimer` (L2503–2589).
4. [`src/mirror/lib/emerald.ts`](../src/mirror/lib/emerald.ts): `Window.unmount` (L3783),
   `Window.registerHandler` (L4077), `Window.setInterval` (L4744), `Screen.mount` (L4762),
   `Screen.update` (L4791).
5. Contoh yang terdampak: [`gui-db-test-csh.ts`](../src/mirror/opt/test/gui-db-test-csh.ts) (T2, T4, T10),
   [`cashew-demo1.ts`](../src/mirror/opt/test/cashew-demo1.ts) (T7, T8, T9).

### 0.2 Aturan mutlak (jangan dilanggar)

| Aturan | Alasan |
| :-- | :-- |
| Edit **hanya** `src/mirror/**` | `src/mirror` = sumber; alias `@tsix` → `src/mirror/lib` (`vitest.config.mts`, `tsconfig.json`) |
| **Jangan** edit `src/rootfs/**` | itu **dump** rootfs di host (hasil `vfs:pull`), bukan sumber; vitest mengecualikannya |
| **Jangan** menulis file `.js` | `.js` adalah sidecar hasil transpile saat inject ke VFS (`scripts/sync-vfs.ts`) |
| API publik **backward compatible** | ratusan baris app di `src/mirror/opt/**` memakai API ini |
| Jangan menambah dependency | cukup yang sudah ada |
| Jangan mengubah penamaan `T*`, `caption`, `text` | itu nilai jual utama framework |
| Format dengan Prettier sebelum selesai | `.prettierrc.json` di root repo |

### 0.3 Perintah kerja

```bash
npm run typecheck                                  # tsc --noEmit — wajib 0 error
npx vitest run src/mirror/lib/cashew.test.ts       # test satu file (cepat)
npm run test                                       # seluruh suite (71 file test)
npx prettier --write src/mirror/lib/cashew.ts      # format
npm run vfs:bootstrap                              # inject src/mirror → VFS (untuk demo manual)
```

> Demo manual (`cashew-demo1`, `gui-db-test-csh`, …) membutuhkan DOME + desktop Asteracea
> yang berjalan. Kalau environment tidak tersedia, **gunakan test headless (P2-1)** sebagai bukti.

### 0.4 Cara memakai dokumen ini sebagai tugas

- Item kerja ada di §4–§6; **kontraknya** (file, simbol, dependensi, verifikasi) ada di §13.
- Item tanpa dependensi boleh dikerjakan paralel; lihat `Bergantung pada` di §13.1.
- Kalau ada ambiguitas, **jangan berhenti**: pakai keputusan default di §14.
- Nomor baris **bisa bergeser** setelah perubahan pertama — acuan utama adalah **nama simbol**.

### 0.5 Contoh prompt handoff

```text
Baca wiki/cashew-improve-plan.md mulai dari §0, lalu §13 (kontrak) dan §14 (default).
Kerjakan P0-1 saja: guard TComponent.add + form.byId<T>().
Aturan: edit hanya src/mirror/**, API publik tetap kompatibel, id unik per form (§14 D2).
Wajib: npm run typecheck bersih + test regresi di src/mirror/lib/cashew.test.ts.
Laporkan: diff ringkas, hasil test, dan checklist §12 yang dicentang.
```

---

## 1. Ringkasan

Cashew sudah berada di posisi yang tepat: **retained-mode + imperatif ala Delphi**
(`TForm`/`TButton`/`TTimer`, setter live-sync, CSS variables untuk tema).
Model ini unggul untuk dashboard IoT (update titik tanpa rebuild subtree).

Yang perlu diperbaiki bukan konsepnya, melainkan **disiplin dan kelengkapan
lifecycle**:

| Kelompok | Jumlah item | Inti masalah |
| :-- | :-- | :-- |
| **P0** — bug & fondasi | 4 | duplikat child/id, komponen non-visual ikut ke DOM, interval ganda, tidak ada `remove()`/`dispose()` |
| **P1** — ergonomi | 4 | wiring event tersebar, 3 sistem layout bersaing, boilerplate `style`, boilerplate DB |
| **P2** — testability & tooling | 3 | belum ada test, tipe style lemah, belum ada form file deklaratif |

Estimasi kasar: **P0 ≈ 1–2 hari**, **P1 ≈ 3–5 hari**, **P2 ≈ 1–2 minggu** (bisa dicicil).

---

## 2. Prinsip yang Harus Dipertahankan

Jangan diubah saat mengerjakan rencana ini:

1. **Penamaan Delphi** — `TForm`, `TButton`, `TEdit`, `caption`, `items`, `checked`.
2. **Setter live-sync** — `caption = x` / `style = {...}` langsung sampai ke browser
   (via `Screen.update`), tanpa rebuild tree.
3. **`TForm.run()` auto-bind + auto-refresh** — app tidak boleh menyentuh
   `win.bindHandler` secara manual.
4. **CSS variables untuk tema** — `var(--surface, ...)` supaya theme switch runtime
   tidak butuh rebuild (Emerald men-*capture* warna saat build; Cashew sudah benar).
5. **Flat code** — komponen dideklarasikan berurutan, tanpa nesting closure seperti Emerald.
6. **Emerald dipakai sebagai transport**, bukan dirombak (lihat §7).

---

## 3. Basis Temuan

Semua nomor baris merujuk ke `src/mirror/` (sumber) — identik dengan `src/rootfs/`.

| ID | Temuan | Bukti |
| :-- | :-- | :-- |
| T1 | `add()` tidak mencegah child ganda / id duplikat | [`cashew.ts#L187`](../src/mirror/lib/cashew.ts#L187) |
| T2 | Bug nyata: `btnRefresh` ditambahkan 2× (HStack sudah menambah) → 2 node id `btn-refresh` | [`gui-db-test-csh.ts#L59`](../src/mirror/opt/test/gui-db-test-csh.ts#L59), [`#L61`](../src/mirror/opt/test/gui-db-test-csh.ts#L61) |
| T3 | `TTimer` diwarisi dari `TComponent` tanpa override `build()`/`tag` → ikut ter-mount jadi `<div>` | [`cashew.ts#L221`](../src/mirror/lib/cashew.ts#L221), [`gui-db-test-csh.ts#L149`](../src/mirror/opt/test/gui-db-test-csh.ts#L149) |
| T4 | `TTimer.stop()` kosong sementara `start()` memanggilnya lalu `setInterval` lagi; `Screen.setInterval` tidak dedupe → interval ganda saat `interval`/`enabled` diubah | [`cashew.ts#L2557`](../src/mirror/lib/cashew.ts#L2557), [`emerald.ts#L4744`](../src/mirror/lib/emerald.ts#L4744) |
| T5 | Satu-satunya teardown adalah `TChart.destroy()`; tidak ada `remove()`/`dispose()` di `TComponent` | [`cashew.ts#L2720`](../src/mirror/lib/cashew.ts#L2720) |
| T6 | `autoBind` hanya jalan di `run()` → komponen yang di-`add()` setelah run tidak ter-bind | [`cashew.ts#L456`](../src/mirror/lib/cashew.ts#L456) |
| T7 | Handler memakai komponen yang dideklarasikan 200+ baris setelahnya (rapuh; aman hanya karena binding terjadi di akhir) | [`cashew-demo1.ts#L84`](../src/mirror/opt/test/cashew-demo1.ts#L84) → [`#L293`](../src/mirror/opt/test/cashew-demo1.ts#L293), [`#L297`](../src/mirror/opt/test/cashew-demo1.ts#L297) |
| T8 | Tiga sistem layout bersaing: CSS Grid di form, flow default di panel, `alTop/alClient` tidak dipakai di demo mana pun | [`cashew-demo1.ts#L40`](../src/mirror/opt/test/cashew-demo1.ts#L40), [`cashew.ts#L1431`](../src/mirror/lib/cashew.ts#L1431) |
| T9 | Boilerplate `style = { ...style, x }` 12× di demo1; `marginTop: "0"` 8× → default `TPanel` salah | [`cashew-demo1.ts`](../src/mirror/opt/test/cashew-demo1.ts) |
| T10 | `loadData()` vs `reloadData()` duplikat ~15 baris + `db.connect/query/disconnect` manual di tiap app | [`gui-db-test-csh.ts#L82`](../src/mirror/opt/test/gui-db-test-csh.ts#L82), [`#L110`](../src/mirror/opt/test/gui-db-test-csh.ts#L110) |
| T11 | Tidak ada `cashew.test.ts`, padahal `emerald.test.ts` ada | `src/mirror/lib/` |
| T12 | Tipe style `Record<string, any>` meloloskan typo (contoh cast `as any`) | [`gui-db-test-csh.ts#L76`](../src/mirror/opt/test/gui-db-test-csh.ts#L76) |
| T13 | Klaim dokumen "`close()` membersihkan semua timer" belum benar-benar diimplementasikan | [`cashew.ts#L532`](../src/mirror/lib/cashew.ts#L532) |

---

## 4. Rencana Kerja P0 — Bug & Fondasi

Target: **2 bug nyata hilang + fondasi UI dinamis tersedia**. Tidak mengubah API publik
(backward compatible), kecuali `TTimer.stop()` yang jadi benar-benar berhenti.

### P0-1 — Guard `add()` (parent & id duplikat)

- **File**: `src/mirror/lib/cashew.ts` (`TComponent.add`, `TForm`)
- **Perubahan**:
  - `add()` melempar error bila `child.parent !== null`.
  - `TForm` menyimpan `Map<string, TComponent>`; `add()` melempar bila id sudah terdaftar.
  - Tambah `form.byId<T extends TComponent>(id): T | null` (lookup typed).
- **Kriteria terima**:
  - Menjalankan `gui-db-test-csh` → **hanya satu** tombol Refresh.
  - `form.add(x)` dua kali pada objek yang sama → error jelas saat build, bukan DOM korup.
- **Risiko**: rendah. Perlu audit demo yang mungkin menambahkan child ke 2 parent.

### P0-2 — Pisahkan komponen visual vs non-visual (`TControl`)

- **File**: `src/mirror/lib/cashew.ts`
- **Perubahan**:
  - `TComponent.isVisual = false`; kelas visual meng-extend `TControl` (`isVisual = true`) atau set flag.
  - `TComponent.build()` tetap ada untuk keperluan internal, tapi `TForm.build()` hanya
    me-mount child `isVisual`.
  - `autoBind`/`autoRefresh` tetap menelusuri **semua** child (non-visual perlu bind juga).
- **Kriteria terima**:
  - `form.add(new TTimer(...))` tidak menghasilkan `<div>` di DOM (cek DevTools).
  - `TTimer`, `TDataSource` (P1-4), logger, dsb. bisa ditambahkan tanpa mengotori tree.
- **Risiko**: sedang — perlu memastikan `TChart` (canvas/host element) tetap visual.

### P0-3 — `TTimer` benar-benar bisa berhenti

- **File**: `src/mirror/lib/cashew.ts` (`TTimer`), `src/mirror/lib/emerald.ts` (`Screen`)
- **Perubahan**:
  - `Screen.clearInterval(id)` + hapus id dari `_timers`.
  - `TTimer` menyimpan `_handle`; `stop()` → `clearInterval(_handle)`; `start()` selalu `stop()` dulu.
  - `interval` setter saat enabled → restart bersih (satu interval).
- **Kriteria terima**:
  - Ubah `interval` 10× saat runtime → `onTimer` tetap dipanggil 1× per tick.
  - `enabled = false` → tidak ada callback; `enabled = true` → hanya 1 interval.
- **Risiko**: rendah. Ini juga memperbaiki klaim dokumen (T13).

### P0-4 — `remove()` + `dispose()` (fondasi UI dinamis)

- **File**: `src/mirror/lib/cashew.ts` (`TComponent`, `TForm`), `src/mirror/lib/emerald.ts` (`Window`/`Screen`)
- **Perubahan**:
  - `TComponent.remove(child)`: hapus dari `_children`, `child.parent = null`, lalu
    **pakai jalur yang sudah ada**: `screen.win.unmount(child.id)` (emerald.ts L3783 →
    `GUIAction.UNMOUNT_NODE`, sudah ditangani DOME client `handleUnmountNode`). Tidak perlu
    tambah syscall/aksi GUI baru.
  - Tambah `Window.unregisterHandler(id)` + `TForm` menjaga map id→komponen agar handler
    lama dibuang saat `remove()`.
  - `TComponent.dispose()`: no-op di base; override di chart/timer/grid untuk cleanup.
  - `TForm.close()` → `dispose()` rekursif seluruh child sebelum `screen.close()`.
  - `TForm.add()` **setelah** `run()` → auto `bindEventHandler` + mount inkremental
    (pakai `Screen.mount(node, parentId)` yang sudah ada).
- **Kriteria terima**:
  - Test/demo: tambah 1 panel saat runtime lewat `form.add()` → langsung tampil & event jalan.
  - `form.remove(panel)` → hilang dari DOM dan tidak ada handler tersisa.
  - Tutup form → tidak ada interval/chart/theme watcher yang masih hidup.
- **Risiko**: sedang-tinggi (menyentuh lifecycle). Kerjakan terakhir di P0, dengan test.

---

## 5. Rencana Kerja P1 — Ergonomi & Konsistensi

### P1-1 — `form.wire()` (pola dua fase: deklarasi dulu, wiring terakhir)

- **Masalah**: T7 — handler tersebar dan merujuk deklarasi di bawahnya.
- **API usulan**:

  ```typescript
  form.wire({
    "btn-count":   { onClick: () => { count++; lblStatus.text = `Counter: ${count}`; } },
    "btn-refresh": { onClick: () => void loadData() },
    "cmb-mode":    { onChange: (i, item) => (lblStatus.text = item) },
  });
  ```

- **Kriteria terima**: id tidak dikenal → error saat `wire()`; wiring tetap satu jalur
  (`TForm.run()` yang mengikat, `wire()` hanya menyimpan rencana).
- **Manfaat sampingan**: semua koneksi event terlihat di satu blok → mudah diaudit & diuji.

### P1-2 — Layout: jadikan *dock/anchor* API utama

- **Masalah**: T8 — CSS Grid di form, flow di panel, `alTop/alClient` tidak dipakai.
- **Aturan yang didokumentasikan**:
  1. **Level form**: docking ala Delphi — `form.add(pnl, { align: alTop | alClient | ... })`.
  2. **Di dalam panel**: flex — `HStack` / `VStack` / `TGridPanel`.
  3. **Grid CSS** hanya untuk dashboard custom, bukan default.
- **Kriteria terima**: minimal 2 demo diubah memakai `align:`; dokumen "Quick Start"
  memakai `align:`; bagian CSS Grid pindah ke "advanced".

### P1-3 — `style.set()` + perbaiki default komponen

- **Masalah**: T9.
- **Perubahan**:
  - `comp.style.set({...})` → merge + push (menggantikan 12× spread manual).
  - `TButton`: default margin turun (jangan paksa `marginRight` di tiap demo).
  - `TPanel`: default `marginTop` = `0` (menghapus 8× override).
- **Kriteria terima**: jumlah `style = { ...style` di `cashew-demo1.ts` = 0; baris demo1 turun ≥ 10%.

### P1-4 — `TDataSource` (hilangkan boilerplate DB)

- **Masalah**: T10 + `TTimer` manual.
- **API usulan**:

  ```typescript
  const ds = new TDataSource({ query: "SELECT * FROM sensor_data ORDER BY id DESC LIMIT ?", params: [100] });
  grid.dataSource = ds;      // auto setData
  ds.autoRefresh = 5000;     // menggantikan TTimer manual
  await ds.open();
  ```

- **Kriteria terima**: `gui-db-test-csh` tidak lagi punya `loadData`/`reloadData` duplikat;
  `TTimer` tidak dipakai manual di app DB.

---

## 6. Rencana Kerja P2 — Testability & Tooling

### P2-1 — `cashew.test.ts` + harness headless

Keunggulan model imperatif: **tidak ada frame, tidak ada `pumpAndSettle`**.

```typescript
const h = harness(new MyForm());          // build tree tanpa DOME
await h.click("btn-count");
expect(h.byId<TLabel>("lbl-counter").caption).toBe("Counter: 1");
```

- **Cakupan minimum**: setiap komponen (P0-1 guard, TTimer, ListBox items, TEdit text live,
  TDialogs via stub), plus regresi bug T2 & T4.
- **Kriteria terima**: `npm run test` mencakup cashew; bug T2/T4 punya test yang gagal
  sebelum fix dan lulus sesudahnya.

### P2-2 — `TCSS` bertipe

```typescript
type TCSS = Partial<CSSStyleDeclaration> & { [k: `--${string}`]: string };
```

- Menghapus cast `as any` di demo; typo properti jadi error `tsc`.
- **Kriteria terima**: `npm run typecheck` lulus tanpa `as any` di file contoh.

### P2-3 — Form file `.cfm` (lihat §8)

---

## 7. Keputusan: Posisi Emerald vs Cashew

**Emerald: cukup sebagai lapisan low-level; tidak cukup sebagai API aplikasi.**

| Aspek | Emerald | Cashew |
| :-- | :-- | :-- |
| Ringkas untuk 1 layar kecil | ✅ | ⚠️ sedikit lebih panjang |
| Bebas nesting | ❌ `div(...div(...))` | ✅ flat |
| Wiring event | ❌ dua jalur (`onClickId` + `bindHandler`) | ✅ satu jalur |
| Lifecycle | ❌ manual (`mount`, `loopUntilClose`) | ✅ otomatis di `run()` |
| Tema runtime | ❌ warna di-capture saat build | ✅ CSS variables |
| Reusable komponen | ❌ tiap app reinvent | ✅ tersedia |

**Keputusan:**

1. Emerald = "lapisan Win32"-nya Cashew. **Tidak dirombak**, tidak ditambah fitur UI baru.
2. Semua aplikasi baru memakai Cashew.
3. Sediakan escape hatch resmi di Cashew: `TRawNode(node)` / `TNativeView` untuk kasus eksotis.
4. Persempit jalur wiring event Emerald menjadi satu (`onClickId` **atau** `bindHandler`,
   bukan dua-duanya) untuk menghindari footgun `cloneNode`.
5. Wrapper seperti `TTabulatorGrid` adalah pola yang benar — ulangi untuk komponen Emerald
   lain yang belum di-cover.

---

## 8. Arah Jangka Panjang: Form File `.cfm` (ala `.dfm`)

Tujuan: memisahkan **desain** dari **kode**, seperti `.dfm` + `.pas`. Ini juga satu-satunya
jalan menuju WYSIWYG designer tanpa mengubah runtime.

### Sketsa format

```json
{
  "form": { "title": "My App", "width": 720, "height": 520 },
  "components": [
    { "type": "TLabel", "id": "title", "caption": "🗄️ DB Browser", "align": "alTop" },
    { "type": "TButton", "id": "btn-refresh", "caption": "🔄 Refresh", "align": "alTop" },
    { "type": "TTabulatorGrid", "id": "grid", "align": "alClient",
      "columns": [{ "key": "id", "label": "ID", "width": 60 }] }
  ]
}
```

### Pemakaian

```typescript
const form = await TForm.fromFile("form.cfm");
form.wire({ "btn-refresh": { onClick: () => void loadData() } });
await form.run();
```

### Tahapan

1. **Registry tipe** `TComponentClass` (nama → constructor) — prasyarat validasi.
2. **Validator**: id duplikat, tipe properti, opsi `align` valid, unknown key → error.
3. **Loader** `TForm.fromFile()` (JSON dulu; format `.dfm`-like teks bisa belakangan).
4. **Handler map** terpisah (tidak ada fungsi di dalam file form).
5. **Codegen types** opsional: generate `.d.ts` dari form agar `form.byId<TButton>("x")` typed.
6. **Designer** (opsional, nanti): UI yang menulis `.cfm`.

**Non-goal tahap ini**: designer visual. Fokus ke loader + validator dulu.

---

## 9. Cara Kerja & Verifikasi

- **Sumber kebenaran**: `src/mirror/**` (alias `@tsix` → `src/mirror/lib`). Edit **hanya** di sini.
- **`src/rootfs/**` adalah dump rootfs di host** (hasil `vfs:pull`, ruang kerja `rootType = "host"`),
  bukan sumber, dan sudah dikecualikan dari vitest. Jangan diedit manual; kalau perlu segar,
  jalankan `npm run vfs:pull`. Perbedaan kecil antara `mirror` dan `rootfs` adalah **normal**
  (dump tertinggal), bukan drift yang harus dipaksa identik.
- **Inject ke VFS setelah perubahan**: `npm run vfs:bootstrap` atau
  `npx ts-node scripts/sync-vfs.ts src/mirror/lib/cashew.ts`.
- **Type check**: `npm run typecheck`
- **Test**: `npm run test` (vitest)
- **Demo manual** (butuh DOME):
  - `cashew-demo1` — komponen dasar & dialog
  - `cashew-demo2` — layout
  - `cashew-demo3` — IoT dashboard
  - `gui-db-test-csh` — DB + grid + timer
- **Definisi selesai tiap item**: kode + test (bila memungkinkan) + demo diperbarui +
  dokumen [`cashew-in-a-nutshell.md`](./cashew-in-a-nutshell.md) disesuaikan.
- **Dokumen yang perlu di-update**: klaim "`close()` membersihkan semua timer" (T13),
  "panggil `lb.refresh(screen)` manual" → diganti `bindItems()`, contoh Quick Start → `align:`.

---

## 10. Non-Goals

- Tidak menambahkan state management (Bloc/Redux-style) — Cashew tetap imperatif.
- Tidak mengubah Cashew menjadi deklaratif/rebuild seperti Flutter.
- Tidak merombak Emerald.
- Tidak membuat designer visual sebelum loader `.cfm` stabil.
- Tidak mengganti penamaan Delphi.

---

## 11. Pertanyaan Terbuka

> Semua pertanyaan di bawah **sudah punya keputusan default** di
> [§14 Lampiran B](#14-lampiran-b--keputusan-default). Implementer tidak perlu menunggu
> jawaban; bagian ini disimpan untuk dibahas ulang bila default terbukti salah.

1. `TControl` sebagai subclass baru, atau cukup flag `isVisual` di `TComponent`?
   (subclass lebih Delphi-like, tapi menyentuh semua konstruktor)
2. Id komponen: apakah harus unik **per form** (rekomendasi) atau global?
   Catatan: saat ini `screen.update(id)` menargetkan id global di satu window.
3. `remove()` pada komponen yang sedang menangkap event → perlu debounce atau langsung?
4. Apakah `TDataSource` masuk Cashew atau paket terpisah (`@tsix/cashew-db`)?
5. Format `.cfm`: JSON murni (mudah) vs teks ala `.dfm` (familiar, perlu parser).
6. Apakah TTimer perlu `once`/`TTimerOnce` (mirip `setTimeout` ala Delphi `TTimer`+disable)?

---

## 12. Checklist Eksekusi

### P0 — Bug & Fondasi

- [ ] **P0-1** Guard `add()` (parent + id duplikat) & `form.byId<T>()`
- [ ] **P0-1** Verifikasi `gui-db-test-csh` hanya menampilkan satu tombol Refresh
- [ ] **P0-2** `isVisual` / `TControl`; `TForm.build()` hanya mount child visual
- [ ] **P0-2** Audit `TChart`/`TImage`/`TDataGrid` tetap visual
- [ ] **P0-3** `Screen.clearInterval()` + `TTimer` simpan handle; fix interval ganda
- [ ] **P0-3** Update dokumen klaim "close() membersihkan timer"
- [ ] **P0-4** `TComponent.remove()` + `Screen.removeNode()`/`unregisterHandler`
- [ ] **P0-4** `dispose()` rekursif pada `TForm.close()`
- [ ] **P0-4** `form.add()` setelah `run()` → auto-bind + mount inkremental

### P1 — Ergonomi

- [ ] **P1-1** `form.wire(handlerMap)` + validasi id
- [ ] **P1-2** `form.add(comp, { align })` sebagai API utama; update 2 demo + Quick Start
- [ ] **P1-3** `style.set()`; perbaiki default `TButton`/`TPanel`; demo1 tanpa spread
- [ ] **P1-4** `TDataSource` (query + autoRefresh) → `gui-db-test-csh` bebas duplikasi

### P2 — Testability & Tooling

- [ ] **P2-1** `cashew.test.ts` + harness headless; regresi test untuk T2 & T4
- [ ] **P2-2** `TCSS` bertipe; hilangkan `as any` di demo
- [ ] **P2-3** Registry tipe + validator `.cfm`
- [ ] **P2-3** `TForm.fromFile()` + handler map
- [ ] **P2-3** (opsional) codegen `.d.ts` dari `.cfm`

---

## 13. Lampiran A — Kontrak Tugas (File, Simbol, Dependensi)

Bagian ini menggantikan pembacaan linear §4–§6. Satu baris = satu pekerjaan yang bisa
di-claim, dikerjakan, dan diverifikasi tanpa menebak.

### 13.1 Tabel kontrak

| ID | File utama | Simbol disentuh | Bergantung pada | Verifikasi wajib |
| :-- | :-- | :-- | :-- | :-- |
| **P0-1** | `cashew.ts` | `TComponent.add` (L187), `TForm` (map id + `byId<T>()`) | — | `npx vitest run src/mirror/lib/cashew.test.ts -t "add guard"`; demo DB hanya 1 tombol Refresh |
| **P0-2** | `cashew.ts` | `TComponent` (L131), `build` (L221), `TForm.build`, konstruktor komponen visual | P0-1 | assert `form.build().children.length` tidak memuat `TTimer`; DevTools bersih dari `<div>` liar |
| **P0-3** | `cashew.ts`, `emerald.ts` | `TTimer` (L2503–2589), `Window.setInterval` (L4744), `Window._timers` (L4654) | — | test: ubah `interval` 3× → callback tepat 1×/tick; `enabled=false` → 0 callback |
| **P0-4** | `cashew.ts`, `emerald.ts` | `TForm.close` (L532), `TComponent.remove/dispose` (baru), `Window.unmount` (L3783), `Window.unregisterHandler` (baru) | P0-2 | test: `form.add()` setelah `run()` → node muncul; `remove()` → hilang + handler terbuang; `close()` → `dispose()` terpanggil |
| **P1-1** | `cashew.ts` | `TForm.wire` (baru), `TForm.run` (L396) | P0-1 | test: `wire()` dengan id tak dikenal → throw; handler lama tidak tertimpa diam-diam |
| **P1-2** | `cashew.ts` + 2 demo + `cashew-in-a-nutshell.md` | `alTop…alCenter` (L1431–1436), `TForm.add` | P0-1 | demo Quick Start memakai `align:`; doc CSS Grid turun ke "advanced" |
| **P1-3** | `cashew.ts` | accessor `style` di `TComponent`, `TButton` (L682), `TPanel` (L615) | — | `grep -c 'style = { \.\.\.' cashew-demo1.ts` = 0; `typecheck` bersih |
| **P1-4** | `cashew.ts` (+ `DbLib`) | `TDataSource` (baru), `TDataGrid`/`TTabulatorGrid.setData` | P0-2, P0-3 | `gui-db-test-csh` tanpa `loadData`/`reloadData` duplikat; autoRefresh jalan 1×/interval |
| **P2-1** | `cashew.test.ts` (baru) | harness + semua komponen | P0-1…P0-4 | `npm run test` hijau; test regresi T2 & T4 ada dan gagal sebelum fix |
| **P2-2** | `cashew.ts` | `style` types, `TCSS` | P1-3 | `npm run typecheck` bersih tanpa cast `as any` di contoh |
| **P2-3** | `cashew.ts` | registry `TComponentClass`, `TForm.fromFile` | P0-1, P2-1 | test: load `.cfm` → `build()` identik dengan versi kode manual |

### 13.2 Titik sisip (per 2026-11-16)

| Simbol | File | Baris | Catatan |
| :-- | :-- | --: | :-- |
| `TComponent` | `cashew.ts` | 131–238 | induk semua komponen; tambah `isVisual`, `remove()`, `dispose()` |
| `TComponent.add` | `cashew.ts` | 187 | titik guard P0-1 |
| `TComponent.bindEventHandler` | `cashew.ts` | 206 | dipanggil `autoBind` di `run()` |
| `TComponent.refresh` | `cashew.ts` | 216 | dipanggil `autoRefresh` di `run()` |
| `TComponent.build` | `cashew.ts` | 221 | titik filter P0-2 |
| `TForm.run` | `cashew.ts` | 396–473 | `autoBind` di L456, `autoRefresh` setelahnya |
| `TForm.close` | `cashew.ts` | 532 | titik `dispose()` rekursif P0-4 |
| `TPanel` / `TButton` | `cashew.ts` | 615 / 682 | default style P1-3 |
| `TTimer` | `cashew.ts` | 2503–2589 | `start`/`stop`/`restart` P0-3 |
| `TChart.destroy` | `cashew.ts` | 2720 | satu-satunya teardown yang ada hari ini |
| `Window.unmount` | `emerald.ts` | 3783 | sudah mengirim `GUIAction.UNMOUNT_NODE` |
| `Window.registerHandler` | `emerald.ts` | 4077 | `Map<id, Map<event, handler>>` — tambah pasangan unregister |
| `Window.setInterval` | `emerald.ts` | 4744 | belum dedupe — sumber T4 |
| `Screen.mount` / `Screen.update` | `emerald.ts` | 4762 / 4791 | jalur mount inkremental P0-4 |

### 13.3 Audit `isVisual` (untuk P0-2)

| Klasifikasi | Komponen |
| :-- | :-- |
| **Visual** (harus `isVisual = true`) | `TPanel`, `TLabel`, `TButton`, `TEdit`, `TMemo`, `TCheckBox`, `TListBox`, `TRadioButton`, `TComboBox`, `TStatusBar`, `TScrollBox`, `TFlowPanel`, `TGridPanel`, `TSplitHorizontal`, `TSplitVertical`, `TGroupBox`, `TLineChart`, `TRadialGauge`, `TSevenSegment`, `TIndicatorLamp`, `TToggleSwitch`, `TVerticalGauge`, `TSensorCard`, `TRelayCard`, `TSlider`, `TChart`, `TDataGrid`, `TTabulatorGrid`, `TProgressBar`, `TImage`, `HStack`/`VStack`/`Spacer` |
| **Non-visual** (harus `isVisual = false`) | `TTimer`, `TDataSource` (baru di P1-4) |
| **Ambigu** | `TKeyboard` — saat ini `<div style="display:none">`; lihat §14 D7 |

### 13.4 Definition of Done (berlaku untuk semua item)

- [ ] Perubahan hanya di `src/mirror/**`; tidak ada file `.js` yang ditulis manual.
- [ ] API publik tetap kompatibel (atau ada jalur deprecation yang dijelaskan).
- [ ] `npm run typecheck` → 0 error.
- [ ] Ada test yang **gagal sebelum** perubahan dan **lulus sesudahnya** (kecuali murni kosmetik).
- [ ] `npx prettier --write` pada file yang diubah.
- [ ] Demo terdampak dijalankan **atau** dijelaskan kenapa tidak bisa (tanpa DOME).
- [ ] [`cashew-in-a-nutshell.md`](./cashew-in-a-nutshell.md) diperbarui bila perilaku user-facing berubah.
- [ ] Checklist §12 dicentang + catatan singkat "apa yang berubah".

### 13.5 Anti-pattern saat implementasi

1. Menambah `any` baru untuk "segera selesai" — pakai `unknown` + guard.
2. Membungkus `build()` dengan filter visual **tanpa** menjaga `autoBind` (komponen non-visual tetap perlu bind).
3. Memperbaiki demo alih-alih framework (mis. menghapus `toolbar.add(btnRefresh)` di P0-1 —
   guard `add()` tetap wajib ada; demo cukup dibersihkan setelahnya).
4. Menyentuh `src/rootfs/**` atau file `.js` sidecar.
5. Mengganti nama/konvensi Delphi demi "konsistensi modern".
6. Menambah dependency (termasuk `lodash`, `uuid`, dsb.) untuk hal yang bisa ditulis 5 baris.
7. Mengerjakan P2-3 (`.cfm`) sebelum P0 selesai.

### 13.6 Urutan eksekusi yang disarankan

```
P0-1  →  P0-3  →  P0-2  →  P0-4  →  P1-3  →  P1-1  →  P1-2  →  P1-4  →  P2-2  →  P2-1  →  P2-3
(guard)   (timer)  (visual)  (lifecycle) (style) (wire)  (layout)  (datasource) (types) (tests)  (.cfm)
```

Alasan: P0-1 dan P0-3 independen (bisa paralel, tidak menyentuh struktur tree);
P0-2 harus sebelum P0-4 (dispose perlu tahu mana yang punya DOM node); P1-4 butuh P0-2 & P0-3;
P2-1 diletakkan setelah P0 agar test regresi menutup bug yang baru diperbaiki; P2-3 paling akhir.

---

## 14. Lampiran B — Keputusan Default

Dipakai saat implementer tidak punya instruksi lain. Kalau default terbukti salah,
ubah **dokumen ini** dulu, baru kodenya.

| # | Pertanyaan (§11) | Keputusan default | Alasan |
| :-- | :-- | :-- | :-- |
| **D1** | `TControl` subclass vs flag `isVisual` | **Flag** `isVisual` di `TComponent` (default `false`), set `true` di komponen visual. Tambah `class TControl extends TComponent` yang men-set flag untuk pemakaian baru — tanpa migrasi konstruktor besar-besaran | risiko terkecil, backward compatible |
| **D2** | Cakupan keunikan id | **Unik per form** (`Map` di `TForm`) | dua form dalam satu app boleh memakai id sama; DOM tetap terpisah per window |
| **D3** | `remove()` sinkron/async | **Sinkron**: detach dari `_children` + `unregisterHandler` langsung; `win.unmount()` tetap dipanggil tapi tidak perlu di-`await` oleh pemanggil | API imperative harus bisa dipanggil di handler event mana pun |
| **D4** | Lokasi `TDataSource` | Di `cashew.ts` (satu paket) sampai file > ~4.000 baris, baru pisah ke `@tsix/cashew-db` | hindari pecah paket prematur |
| **D5** | Format `.cfm` | **JSON murni** dulu; format teks ala `.dfm` ditunda | loader + validator dulu, parser belakangan |
| **D6** | `TTimer` mode sekali-jalan | Tambahkan opsi `once?: boolean` pada P0-3 (murah, menutup use-case `setTimeout`) | mengurangi pemakaian `setTimeout` manual di app |
| **D7** | `TKeyboard` visual atau non-visual | **Tetap visual** (hidden div) pada P0-2; ubah hanya bila terbukti ada biaya/perilaku aneh | jangan memperluas risiko tanpa bukti |

---

## Referensi

- [Cashew in a Nutshell](./cashew-in-a-nutshell.md)
- [Emerald in a Nutshell](./emerald-in-a-nutshell.md)
- Implementasi: [`src/mirror/lib/cashew.ts`](../src/mirror/lib/cashew.ts), [`src/mirror/lib/emerald.ts`](../src/mirror/lib/emerald.ts)
- Contoh: `src/mirror/opt/test/cashew-demo{1,2,3}.ts`, `gui-db-test-csh.ts`, `gui-db-test-emr.ts`, `tab-demo-csh.ts`
