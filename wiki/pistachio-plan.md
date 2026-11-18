# Pistachio — Rencana Set Komponen Baru

**Design Plan** | **Version 1.0** | **2026-11-18** | **Status: Draft**

Dokumen ini merancang **Pistachio**, set komponen GUI baru untuk TSIX yang
**sengaja tidak backward compatible** dengan [Cashew](./cashew-in-a-nutshell.md).
Tujuannya bukan mempermak Cashew, tapi membangun set yang benar-benar bersih,
ramping, seragam, dan strukturnya ideal — termasuk stack database
(`TDBConnection`, `TDBQuery`, `TProvider`, `TClientDataset`, `TDataSource`,
`TDBControls`).

> Cashew tetap hidup sebagai **legacy**: bugfix saja, tanpa fitur baru.
> Aplikasi baru memakai Pistachio.

---

## Daftar Isi

0. [Untuk Implementer](#0-untuk-implementer)
1. [Ringkasan & Alasan](#1-ringkasan--alasan)
2. [Nama & Namespace](#2-nama--namespace)
3. [Prinsip yang Harus Dipertahankan](#3-prinsip-yang-harus-dipertahankan)
4. [Kontrak Komponen](#4-kontrak-komponen)
5. [Struktur Paket](#5-struktur-paket)
6. [Stack Database](#6-stack-database)
7. [Temuan Teknis: Kapabilitas DB Saat Ini](#7-temuan-teknis-kapabilitas-db-saat-ini)
8. [Strategi Eksekusi](#8-strategi-eksekusi)
9. [Rencana Fase](#9-rencana-fase)
10. [Koeksistensi & Migrasi](#10-koeksistensi--migrasi)
11. [Non-Goals](#11-non-goals)
12. [Risiko](#12-risiko)
13. [Checklist Eksekusi](#13-checklist-eksekusi)
14. [Keputusan Terbuka](#14-keputusan-terbuka)

---

## 0. Untuk Implementer

- Sumber kebenaran kode: `src/mirror/lib/` (alias `@tsix`).
- Baca dulu [cashew-improve-plan.md](./cashew-improve-plan.md) §3 untuk daftar
  masalah yang **tidak boleh terulang** di Pistachio.
- Jangan mengimpor `@tsix/cashew` dari Pistachio. Keduanya hanya boleh berbagi
  `@tsix/emerald` dan `@tsix/theme`.
- Setiap fase harus selesai dengan: kode + tes + contoh aplikasi + dokumentasi.
- Kalau ada ambiguitas, pakai keputusan default di §14 dan catat di changelog.

---

## 1. Ringkasan & Alasan

Cashew dibangun bertahap sehingga kontraknya bercabang: ada empat gaya
konstruktor, beberapa container berupa factory function, dan `splitConfig`
yang menebak props vs CSS. Memperbaikinya sambil menjaga 30 aplikasi tetap
jalan akan memaksa kompromi terus-menerus.

Pistachio mengambil jalan lain:

| Aspek | Cashew (legacy) | Pistachio |
| :-- | :-- | :-- |
| Konstruktor | 4 gaya bercampur | satu kontrak `(idOrOpts?, opts?)` |
| Props vs style | ditebak `splitConfig` | dipisah tegas |
| Container | sebagian factory function | class semua (`THStack`, `TSplit`, ...) |
| Komponen non-visual | opt-out `isVisual` | dinyatakan eksplisit per kelas |
| File | satu `cashew.ts` ±3.500 baris | paket modular |
| Database | manual `db.connect/query` | stack Delphi-style terstruktur |
| Kompatibilitas | wajib | **tidak** diperlukan |

---

## 2. Nama & Namespace

| Item | Nilai |
| :-- | :-- |
| Nama set | **Pistachio** |
| Import | `@tsix/pistachio` |
| Alias tsconfig | `@tsix/pistachio` → `src/mirror/lib/pistachio` |
| Prefix kelas | tetap `T` (Delphi heritage, konsisten dengan Cashew) |

Alasan penamaan: masih satu keluarga dengan Cashew, tapi jelas merupakan
identitas baru — bukan "Cashew versi 2". Nama yang **dihindari**:
`Cashew Next`, `Cashew 2`, `Cashew Pro` (mengundang asumsi kompatibel).

---

## 3. Prinsip yang Harus Dipertahankan

1. **Satu cara benar.** Tidak ada dua API untuk hal yang sama.
2. **Eksplisit lebih baik daripada pintar.** Tidak ada tebakan tipe atau CSS.
3. **Hirarki objek nyata.** Semua container adalah class; `instanceof` valid.
4. **Lifecycle seragam.** `mount → bind → refresh → dispose` untuk semua.
5. **I/O asinkron eksplisit.** Operasi DB/jaringan selalu `await`.
6. **Kesalahan terketik.** Jangan kembalikan `{ error }`; lempar exception.
7. **Satu tanggung jawab per komponen.** Grid tidak tahu SQL; koneksi tidak tahu UI.

---

## 4. Kontrak Komponen

```ts
interface TOptions {
  id?: string;
  style?: Record<string, any>;
  children?: TComponent[];
  // ...props spesifik komponen, bertipe
}

class TComponent {
  constructor(idOrOpts?: string | TOptions, opts?: TOptions);
  add(child: TComponent): TComponent;
  remove(child: TComponent): TComponent;
  dispose(): void;
  byId<T extends TComponent>(id: string): T | null;
}
```

Aturan:

- Bentuk posisional lama (`(id, columns, data, opts)`) **tidak ada**.
- Key props yang tidak dikenal → error saat mode dev, bukan jadi CSS.
- `children` boleh diisi di konstruktor; `add()` menolak child yang punya parent
  dan menolak ID duplikat dalam satu form.
- `dispose()` wajib idempoten dan menutup resource (timer, koneksi, listener).
- Setiap kelas mendeklarasikan `isVisual` secara eksplisit.

Contoh:

```ts
const grid = new TDBGrid({
  id: "grid",
  dataSource: source,
  columns: "auto",
  style: { height: "100%" },
});

const toolbar = new THStack({
  children: [btnRefresh, new TSpacer(), lblStatus],
});
```

---

## 5. Struktur Paket

```
src/mirror/lib/pistachio.ts        // barrel publik (@tsix/pistachio)
src/mirror/lib/pistachio/
  core.ts                          // TComponent, TOptions, registry, lifecycle, error, TScreenPort
  layout.ts                        // TPanel, THStack, TVStack, TGridPanel, TScrollBox, TSpacer, TGroupBox
  controls.ts                      // TLabel, TButton, TEdit, TMemo, TCheckBox, TRadioButton, TComboBox, TListBox
  form.ts                          // TForm (window + mount/bind/refresh/dispose)
  dialogs.ts                       // TDialogs, TOpenDialog, TSaveDialog
  widgets.ts                       // TLineChart, TRadialGauge, TSensorCard, TChart, ...
  data.ts                          // TDBConnection, TDBQuery, TProvider, TClientDataset, TDataSource
  dbcontrols.ts                    // TDBText, TDBEdit, TDBListBox, TDBMemo, TDBGrid, TDBNavigator
```

**Kenapa bukan folder dengan `index.ts`?** Resolver runtime memetakan
`@tsix/<nama>` ke `/lib/<nama>.ts` (lihat `src/userland/WorkerEntry.ts`), jadi
paket harus punya file barrel. Konsekuensi menguntungkan: import dalam
(`@tsix/pistachio/core`) juga langsung berfungsi karena dipetakan ke
`/lib/pistachio/core.ts`.

Aturan struktur:

- `core.ts` tidak boleh mengimpor modul lain di `pistachio/`.
- `controls.ts` dan `widgets.ts` hanya bergantung pada `core.ts` + `emerald`.
- `dbcontrols.ts` hanya berbicara ke `TDataSource`, bukan ke `TProvider`.

---

## 6. Stack Database

### 6.1 Rantai komponen

```
TDBConnection → TDBQuery → TProvider → TClientDataset → TDataSource → TDBControls
   (koneksi)     (source)   (fetch/apply)  (buffer+cursor)   (binding)      (UI)
```

`TDBTable` **tidak dibuat** — `TDBQuery` sudah mencakupnya dengan
`SELECT * FROM tabel`. `TDBStoredProc` juga ditunda sampai ada kebutuhan nyata.

| Komponen | Tanggung jawab | Batasan |
| :-- | :-- | :-- |
| `TDBConnection` | pilih driver, buka/tutup koneksi, `open()/close()/execute(sql, params)` | tidak tahu UI |
| `TDBQuery` | simpan SQL + params, `open()/close()/fetch()`, metadata hasil | tidak menyimpan buffer baris |
| `TProvider` | jembatan `TDBQuery` → dataset; fetch & apply | tidak menyimpan state UI |
| `TClientDataset` | buffer baris, cursor, sort/filter, dirty tracking, state (`dsBrowse/dsEdit/dsInsert`) | tidak mengirim SQL langsung |
| `TDataSource` | titik binding dataset ↔ kontrol, notifikasi perubahan | tidak menyimpan data |
| `TDBControls` | render + edit lewat `TDataSource` | tidak memanggil koneksi |

### 6.2 Prinsip driver-agnostic

Target om benar: **apa pun drivernya, `TProvider` sampai `TDBControls` tidak
berubah**. Tapi itu hanya berlaku kalau perbedaan driver dinormalisasi di
lapisan bawah. Yang wajib dinormalisasi:

| Perbedaan | Dinormalisasi oleh | Kalau bocor ke atas |
| :-- | :-- | :-- |
| Gaya placeholder (`?`, `$1`, `:name`) | `TDBQuery` (named params → gaya driver) | SQL harus beda per driver |
| Quoting identifier | `TDBConnection`/driver | nama tabel/kolom rawan error |
| Pemetaan tipe native → tipe kanonik | driver | `TDBGrid`/`TDBEdit` butuh cabang per driver |
| Metadata kolom (`fieldDefs`) | `TDBQuery.meta()` | kolom grid tidak bisa otomatis |
| Deteksi PK / auto-increment | driver | `applyUpdates` tidak tahu kunci baris |
| Kode error | driver → `EDatabaseError` | app harus parsing pesan |
| Kapabilitas (baca/tulis/transaksi/params) | capability flags | kontrol harus menebak |

Tipe kanonik yang dipakai DBControls: `ftString`, `ftInteger`, `ftFloat`,
`ftBoolean`, `ftDateTime`, `ftBlob`, `ftJSON`. Driver memetakan tipe aslinya ke
sini; DBControls **hanya** mengenal tipe kanonik.

### 6.3 Kontrak driver

```ts
interface TDBDriver {
  readonly name: string;                 // "mysql" | "pg" | "sqlite" | "csv"
  readonly capabilities: {
    canWrite: boolean;
    canTransact: boolean;
    canParam: boolean;
  };
  connect(cfg: TDBConfig, pid: number): Promise<void>;
  disconnect(pid: number): Promise<void>;
  execute(sql: string, params: unknown[], pid: number): Promise<TDBResult>;
  meta(sql: string, params: unknown[], pid: number): Promise<TFieldDef[]>;
  quoteIdent(name: string): string;
}
```

### 6.4 Matriks kemampuan

| Driver | Status di TSIX | Tulis | Params | Transaksi | Catatan |
| :-- | :-- | :-- | :-- | :-- | :-- |
| MySQL | **ada** (`/dev/mysql` + `mysqld`) | ✅ | ✅ (via `execute`) | ⏳ belum | jalur paling matang |
| PostgreSQL | belum | ✅ | ✅ | ⏳ | `pg` murni JS → bisa di daemon userland |
| SQLite | belum | ✅ | ✅ | ✅ | `better-sqlite3` native → perlu spike |
| CSV | belum | ❌ | ❌ | ❌ | cocok sebagai uji driver read-only |

CSV sengaja dipakai sebagai **conformance test**: komponen yang sama harus bisa
menampilkan data tanpa satu pun cabang `if (driver === ...)`. Kalau ada cabang,
berarti abstraksinya bocor. Operasi tulis pada driver tanpa `canWrite` harus
gagal rapi (`EDatabaseError`), dan kontrol edit otomatis read-only.

### 6.5 Alur edit yang ditargetkan

1. `dataset.edit()` → state `dsEdit`.
2. `TDBEdit` menulis ke field buffer dataset.
3. `dataset.post()` → validasi, tandai dirty.
4. `dataset.applyUpdates()` → `provider.apply()` → `TDBQuery` → `TDBConnection`.
5. `dataset.refresh()` bila perlu.

### 6.6 Contoh target API

```ts
const conn = new TDBConnection({
  driver: "mysql",
  host, user, password, database,
});

const query = new TDBQuery({
  connection: conn,
  sql: "SELECT id, node_id, value, timestamp FROM sensor_data WHERE node_id = :node",
  params: { node: "esp-01" },
});

const provider = new TProvider({ query });
const dataset = new TClientDataset({ provider, pageSize: 50 });
const source = new TDataSource({ dataset });

const grid = new TDBGrid({ dataSource: source, columns: "auto" });
const nav = new TDBNavigator({ dataSource: source });
const edtValue = new TDBEdit({ dataSource: source, field: "value" });
```

Ganti `driver` ke `"csv"` (mis. `path: "/var/data/sensor.csv"`) dan seluruh kode
di atas tetap sama — hanya `edtValue` yang otomatis read-only.

---

## 7. Temuan Teknis: Kapabilitas DB Saat Ini

Temuan ini menentukan batas v1 — jangan menjanjikan melebihi ini.

| # | Temuan | Bukti | Dampak |
| :-- | :-- | :-- | :-- |
| D1 | `query()` hanya menerima string SQL, tanpa params | [DbLib.ts](../src/mirror/lib/DbLib.ts) | `TProvider` butuh jalur params |
| D2 | Device sudah memakai prepared statement (`conn.execute`) | [MySQLDevice.ts](../src/kernel/devices/aux-devices/MySQLDevice.ts) | params **hampir gratis**: teruskan `{ sql, params }` |
| D3 | Tidak ada transaksi (`BEGIN/COMMIT/ROLLBACK`) | [Syscalls.ts](../src/kernel/Syscalls.ts) DB_* | v1: `applyUpdates` per baris; transaksi v1.1 |
| D4 | Koneksi disimpan per-PID | MySQLDevice `connections` | v1: satu `TDBConnection` aktif per proses |
| D5 | Error dikembalikan sebagai `{ error }` | MySQLDevice `query()` | Pistachio harus membungkus jadi `EDatabaseError` |
| D6 | Hasil `INSERT/UPDATE` berupa `ResultSetHeader` | MySQLDevice | provider dapat `affectedRows`/`insertId` |
| D7 | Kernel sudah punya transport daemon generik (`dbServicePid` + event `db_request` op `connect/query/disconnect/cleanup`) | [Syscalls.ts](../src/kernel/Syscalls.ts) `forwardDbRequest` | multi-driver **tidak perlu syscall baru per driver** |
| D8 | Daemon userland boleh `require` paket npm | [mysqld.ts](../src/mirror/opt/mysqld/mysqld.ts) `require("mysql2/promise")` | `pg` bisa dijalankan sebagai driver userland |
| D9 | Worker berjalan sebagai Node `Worker` thread | [Scheduler.ts](../src/kernel/Scheduler.ts) | `better-sqlite3` (native) perlu spike; kalau gagal → `SQLiteDevice` di kernel |
| D10 | DB syscall default di-hardcode ke `devices.mysql` | Syscalls `DB_CONNECT/QUERY/DISCONNECT` | tanpa daemon, driver lain butuh generalisasi `driver` di payload |

Prioritas teknis: **D1+D2 dulu** (wajib), **D3 nanti** (opsional v1.1).

---

## 8. Strategi Eksekusi

Jangan membangun lapis demi lapis horizontal (semua core, lalu semua kontrol).
Bangun **satu vertical slice utuh** lebih dulu sebagai bukti kontrak:

> **DB Browser Pistachio**:
> `TDBConnection → TDBQuery → TProvider → TClientDataset → TDataSource`
> `→ TDBGrid + TDBNavigator + TDBEdit`

Alasan: kontrak DB adalah bagian paling berisiko. Kalau slice ini terasa enak
dipakai, sisa komponen tinggal diperbanyak. Kalau kontraknya salah, kita tahu
sebelum menulis 30 komponen.

**Uji independensi driver** (murah, wajib di fase yang sama): jalankan slice yang
**sama persis** terhadap driver CSV (read-only). Kalau ada satu saja cabang
`if (driver === "mysql")` di `TProvider` ke atas, berarti abstraksinya bocor.

Referensi perilaku: [gui-db-test-csh.ts](../src/mirror/opt/test/gui-db-test-csh.ts).

---

## 9. Rencana Fase

| Fase | Isi | Estimasi |
| :-- | :-- | :-- |
| 0 | Skeleton paket + `core` (`TOptions`, lifecycle, registry, `dispose`, error) | 8–10 jam |
| 1 | Kontrak `TDBDriver` + `TDBConnection` + `TDBQuery` + params di `DB_QUERY` | 10–12 jam |
| 2 | `TProvider` (fetch/apply + metadata + capability) | 8–10 jam |
| 3 | `TClientDataset` + `TDataSource` (cursor, state, sort/filter) | 8–10 jam |
| 4 | `TDBGrid`, `TDBNavigator`, `TDBText`, `TDBEdit`, `TDBMemo`, `TDBListBox` | 12–16 jam |
| 5 | Driver CSV (uji independensi) + spike SQLite/PostgreSQL | 6–10 jam |
| 6 | Kontrol dasar & layout (`TLabel`, `TButton`, `TEdit`, `TPanel`, `THStack`, ...) | 10–12 jam |
| 7 | Widget IoT (`TLineChart`, `TRadialGauge`, `TSensorCard`, `TChart`, ...) | 8–12 jam |
| 8 | Dokumentasi, demo, panduan migrasi | 6–8 jam |
| | **Total** | **~76–98 jam (9–12 hari kerja fokus)** |

Fase 0–4 menghasilkan slice MySQL yang bisa dipakai. Fase 5 membuktikan
driver-agnostic. Fase 6–7 melengkapi cakupan.

**Status eksekusi (2026-11-18):** Fase 0 selesai. Atas keputusan pemilik
proyek, Fase 6 (kontrol dasar & layout) dikerjakan lebih dulu; Fase 1–5 (stack
database) ditunda sampai komponen UI stabil.

---

## 10. Koeksistensi & Migrasi

- `cashew.ts` **frozen**: hanya bugfix, tanpa fitur baru.
- Pistachio tidak mengimpor Cashew; hanya `emerald` + `theme`.
- Dokumentasi Cashew diberi banner **legacy**.
- Migrasi per aplikasi, bukan massal. Aplikasi lama tetap jalan apa adanya.
- Aplikasi pilot migrasi: `gui-db-test-csh` (setelah versi Pistachio-nya ada).

---

## 11. Non-Goals

- Designer visual dan format `.cfm` (menyusul setelah kontrak stabil).
- Multi-koneksi database per proses.
- Optimistic locking / transaksi lintas tabel di v1.
- Porting seluruh 30 aplikasi Cashew.
- State management deklaratif (Pistachio tetap imperatif).

---

## 12. Risiko

| Risiko | Tingkat | Mitigasi |
| :-- | :-- | :-- |
| Kontrak DB kurang cocok dengan `DbLib` | sedang | vertical slice lebih dulu (Fase 0–3) |
| Duplikasi kode dengan Cashew | sedang | tidak ada copy-paste buta; komponen ditulis ulang |
| Scope creep (transaksi, locking, designer) | tinggi | non-goals v1 dipatuhi |
| Dua framework membingungkan kontributor | sedang | banner legacy + panduan migrasi |
| Regresi ke aplikasi lama | rendah | tidak menyentuh `cashew.ts` |

---

## 13. Checklist Eksekusi

### Fase 0 — Core

- [x] Barrel `@tsix/pistachio` (resolusi runtime `@tsix/X` → `/lib/X.ts`)
- [x] `TOptions` + normalisasi konstruktor tunggal
- [x] `TComponent`: `add/remove/dispose/byId`, guard parent & ID
- [x] Error terketik (`EComponentError`)
- [x] Tes core
- [ ] Verifikasi resolusi VFS runtime (butuh aplikasi demo, menyusul fase kontrol)

### Fase 1 — Driver, Connection & Query

- [ ] `DB_QUERY` menerima `{ sql, params }` (kernel + device + `DbLib`)
- [ ] Kontrak `TDBDriver` + capability flags + tipe kanonik `TFieldType`
- [ ] `TDBConnection` (`driver`, `open/close/execute`, `EDatabaseError`)
- [ ] `TDBQuery` (named params → gaya driver, `open/close/fetch/meta`)
- [ ] Tes: params, normalisasi error, capability

### Fase 2 — Provider

- [ ] `TProvider` fetch dari `TDBQuery` (metadata + baris)
- [ ] `applyUpdates` per baris dengan laporan per baris
- [ ] Tolak tulis rapi saat `canWrite === false`
- [ ] Tes provider (mock driver)

### Fase 3 — Dataset & DataSource

- [ ] `TClientDataset`: buffer, cursor, `first/next/prior/last`, `edit/post/cancel`
- [ ] `sort`/`filter`, dirty tracking, state machine
- [ ] `TDataSource`: binding + notifikasi perubahan
- [ ] Tes state machine

### Fase 4 — DB Controls

- [ ] `TDBGrid` (kolom auto dari metadata) + `TDBNavigator`
- [ ] `TDBEdit`, `TDBText`, `TDBMemo`, `TDBListBox`
- [ ] Demo **DB Browser Pistachio**
- [ ] Tes binding: edit → post → apply

### Fase 5 — Independensi Driver

- [ ] Driver CSV (baca saja) memakai `fs`
- [ ] Slice DB Browser yang sama jalan tanpa cabang driver
- [ ] Spike `better-sqlite3` di worker thread → keputusan driver SQLite
- [ ] Spike `pg` di daemon userland

### Fase 6–8

- [x] Kontrol dasar (`TLabel`, `TButton`, `TEdit`, `TMemo`, `TCheckBox`, `TRadioButton`, `TComboBox`, `TListBox`)
- [x] Layout (`TPanel`, `THStack`, `TVStack`, `TGridPanel`, `TScrollBox`, `TSpacer`, `TGroupBox`)
- [x] `TForm` (window + mount/bind/refresh/dispose)
- [x] `TDataGrid` — data manual, **tidak** terhubung ke stack database
- [x] Demo `src/mirror/opt/test/pistachio-demo.ts`
- [x] Verifikasi runtime lewat DOME + `npm run vfs:bootstrap` (dikonfirmasi pemilik proyek, 2026-11-18)
- [x] Widget IoT — `TProgressBar`, `TIndicatorLamp`, `TToggleSwitch`, `TRelayCard`, `TSensorCard`, `TLineChart`, `TRadialGauge`, `TSevenSegment`, `TVerticalGauge`
- [x] Widget lanjutan — `TImage`, `TSlider`, `TStatusBar`, `TTabulatorGrid`
- [x] Dialog — `TDialogs` (alert/confirm/input), `TOpenDialog`, `TSaveDialog`
- [ ] `TKeyboard` (menyusul bila dibutuhkan)
- [ ] Dokumentasi `pistachio-in-a-nutshell.md` + panduan migrasi

---

## 14. Keputusan Terbuka

| # | Pertanyaan | Default sementara |
| :-- | :-- | :-- |
| Q1 | Nama paket final | `@tsix/pistachio` |
| Q2 | Transaksi di v1 atau v1.1? | v1.1 |
| Q3 | `applyUpdates` per baris atau batch? | per baris, dengan laporan per baris |
| Q4 | Grid: render virtual atau seluruh baris? | virtual (mengikuti pola Tabulator) |
| Q5 | Perilaku `connect()` kedua dalam satu proses | lempar error sampai multi-koneksi didukung |
| Q6 | Apakah `TDataSource` boleh melayani >1 kontrol? | ya (satu cursor, banyak view) |
| Q7 | Driver mana yang masuk v1? | **Diputuskan:** MySQL + CSV (CSV read-only sebagai uji independensi) |
| Q8 | Multi-driver lewat daemon userland atau device per driver? | **Ditunda:** default daemon userland; device hanya bila spike `better-sqlite3` gagal |
