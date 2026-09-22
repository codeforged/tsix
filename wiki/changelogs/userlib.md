# Changelog UserLib (Userland Library)

> Changelog untuk `src/mirror/lib/UserLib.ts` + framework `@tsix/Application`
> (std, fs, shell, net, db, pty, keyboard).
> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-09-22

### `ConfigParser` (baru) — perbaikan sebelum dipakai: regex array, boolean, komentar, oktal

- **File:** `src/mirror/lib/ConfigParser.ts` (baru), `src/mirror/lib/ConfigParser.test.ts`
  (baru, C11.70–C11.79), `src/mirror/opt/test/read-config.ts`,
  `src/mirror/etc/test.conf` (baru).
- **Konteks:** parser INI userland ditulis untuk membaca `.conf` gaya INI
  (`[section]` + `key = value`). Lima jebakan ditemukan saat review, semuanya
  jenis "salah tapi tidak error":
    1. Pemisah koma memakai `/,(?=(?:(?:[^"]*"){2})*[^"]*\$)/` — `\$` di situ
       **dolar literal**, bukan anchor `$`, jadi `123, 456, 789` tidak pernah jadi
       array (selalu satu string).
    2. Tidak ada parsing boolean → `false` jadi string `"false"` yang **truthy**
       (`if (cfg.get(s,k))` selalu benar).
    3. Komentar ekor (`nilai # catatan`) ikut tersimpan sebagai bagian nilai.
    4. `Number("0755")` → `755` desimal: niat oktalnya hilang tanpa jejak.
    5. `console.error` dipanggil dari dalam modul `/lib` (menulis ke TTY tanpa
       diminta pemanggil).
- **Perubahan:**
    - **Aturan nilai disamakan dengan parser kernel** (`src/kernel/FstabParser.ts`)
      supaya satu berkas `.conf` tidak punya dua arti: kutip = string apa adanya,
      koma di luar kutip = array, `true/false|yes/no|on/off` = boolean, `0o755`/`0x1f`
      = oktal/hex eksplisit, dan angka desimal hanya dikonversi kalau bolak-baliknya
      **utuh** (`String(Number(x)) === x`) — jadi `0755` tetap string, dan kunci
      64 digit (mis. `--key` NetFS) tidak kehilangan presisi.
    - Komentar `#`/`;` dibuang hanya di luar kutip dan hanya kalau di awal baris atau
      didahului spasi (`kanal#1` tetap utuh).
    - `load()` menyimpan sebab kegagalan di `stats.lastError` (tidak mencetak
      sendiri); `null` dari VFS = berkas tidak ada, berkas kosong tetap sah.
    - Peringatan (key sebelum `[section]`, baris tanpa `=`, `[` tanpa `]`) masuk
      `stats.warnings`.
    - Tambah `has(section, key?)` dan opsi `reader` di konstruktor (untuk unit test /
      sumber lain) — logika parsing kini bisa diuji tanpa menyalakan kernel.
    - Contoh `/etc/test.conf` ditambahkan supaya `/opt/test/read-config` benar-benar
      bisa dijalankan (sebelumnya menunjuk berkas yang tidak ada).
- **Deploy:** `npm run vfs:bootstrap` (mengubah `src/mirror/*`).
- **Oleh:** Copilot

## 2026-09-19

### `FsLib` — kontrak operasi file dieksplisitkan + demo uji mandiri

- **File:** `src/mirror/opt/test/file-operation.ts` (baru), `wiki/file-operation.md` (baru)
- **Perubahan:** tidak ada perubahan API — yang ditambahkan adalah **kontrak tertulis** untuk `FsLib` beserta alat ujinya: tabel nilai balik per method (`stat()`→`null`, `readChunk()`→`null`, `readFile()`/`getSize()`/`open("r")`→melempar ENOENT, `unlink()`/`rmdir()`/`chmod()`→`false`), arti flag `open` (`r`/`w`/`a`/`r+` — ketiganya selain `r` bermuara di `VFS.append()`), semantik `mkdir()` rekursif + idempotent, padding `writeChunk()` saat `offset` melewati akhir isi, dan `getUsage()` yang berlaku per-filesystem (mount), bukan per-path.
- **Dampak:** aplikasi baru tidak perlu menebak perilaku; yang dulu hanya bisa dibaca dari `Syscalls.ts`/`VFS.ts` sekarang jadi kontrak tertulis yang bisa diulang di node mana pun (`/opt/test/file-operation --demo`, 44 pemeriksaan).
- **Oleh:** Copilot

## 2026-09-12

### `shell.ps({ includeMemory })` + `memoryUsage()` — atribusi memori per-proses

- **File:** `src/mirror/lib/UserLib.ts`, `src/kernel/Syscalls.ts`, `src/kernel/Scheduler.ts`
- **Perubahan:**
  - `ShellLib.ps()` kini menerima opsi `{ includeMemory?: boolean }`. Bila `true`, kernel membaca statistik heap **per worker isolate** (pull via `worker.getHeapStatistics()`) dan melampirkan `mem: { heapUsed, heapTotal, external, heapLimit }` pada tiap entri proses. Tanpa opsi ini, `ps` tetap ringan seperti sebelumnya.
  - Tambah **`memoryUsage()`** — pemakaian memori isolate proses pemanggil sendiri (padanan `process.memoryUsage()`, tapi terdokumentasi jelas soal `rss` yang process-wide).
  - `mem` di entri proses bernilai `null` untuk PCB zombie / proses tanpa worker.
- **Penting:** `rss` bersifat **process-wide** (main thread + semua worker). Yang **per-isolate** adalah `heapUsed`/`external`/`arrayBuffers`. Untuk atribusi pakai `includeMemory` — jangan pakai `rss`.
- **Pemakaian:** `ps --mem`, `ps --sort-mem` (`/bin/ps`), dan `mem --per-proc` di `/sbin/mem` (teks keluaran berbahasa Inggris).
- **Deploy:** `npm run vfs:bootstrap` (mengubah `src/mirror/lib/*` + `src/common/*`).
- **Detail:** `wiki/changelogs/kernel.md` (bagian "Utilitas `ps --mem` / `mem --per-proc`").
- **Oleh:** Copilot

## 2026-09-07

### WebLib — sub-library `web` (HTTP & WebSocket server yang friendly)

- **File:** `src/mirror/lib/UserLib.ts`, `src/mirror/lib/UserLib.js`
- **Perubahan:**
  - Tambah class **`WebLib`** — membungkus device kernel `/dev/httpd` (HttpServerDevice) & `/dev/wsd` (WebSocketDevice) jadi API manusiawi, tanpa ioctl mentah & tanpa `hostRequire("http"/"ws")`.
  - Di-expose sebagai sub-library baru **`lib.web`**.
  - API: `start(port, mode)` (`"both"` | `"http"` | `"ws"`), event `on("request"|"connection"|"message"|"close"|"listening"|"error")`, `respond(reqId,status,ct,body)`, `send(clientId,data)`, `broadcast(data)`, `closeClient(id)`, `status()`.
  - Objek data di-`send`/`broadcast` otomatis di-`JSON.stringify`.
- **Dampak:** daemon server (web-gateway, dome nanti) bisa migrasi dari `hostRequire` ke `lib.web` — userland tetap tidak menyentuh network host langsung.
- **Deploy:** sidecar `UserLib.js` di-regenerasi (wajib di-sync + restart daemon lama).
- **Detail:** `wiki/webserver.md`, `wiki/websocket.md`, `wiki/changelogs/kernel.md`.
- **Oleh:** Copilot

## 2026-08-30

### KeyboardLib — sub-library `keyboard` baru (decoder keyboard CLI)

- **File:** `src/mirror/lib/UserLib.ts`, `src/mirror/lib/Application.ts`
- **Perubahan:**
  - Tambah class **`KeyboardLib`** + interface **`KeyEvent`** di `UserLib.ts` — decoder byte stream terminal (padanan CLI dari `TKeyboard` Cashew).
  - Di-expose sebagai sub-library baru **`lib.keyboard`**; ditambah proxy `keyboard` di `@tsix/Application` (+ `export type { KeyEvent }`).
  - API: `keyboard.enable()` (raw mode) → `keyboard.readKey(): KeyEvent | null` → `keyboard.disable()` (cooked mode).
  - `KeyboardLib` dibangun di atas `StdLib` (pakai `getChar()`/`sleep()`/`setRawMode()`), jadi konsisten dengan sub-library lain.
- **Detail teknis:** lihat `wiki/changelogs/keyboard.md`.
- **Dampak:** UserLib punya kemampuan baca tombol CLI yang reusable — app interaktif (less/atto/dll) bisa pakai `keyboard.readKey()` tanpa menulis decoder sendiri. Sub-library ke-7 setelah std/fs/shell/net/db/pty.
- **Deploy:** `npm run vfs:bootstrap` (userland mirror — tanpa restart kernel).
- **Oleh:** Copilot

---
