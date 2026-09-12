# Changelog UserLib (Userland Library)

> Changelog untuk `src/mirror/lib/UserLib.ts` + framework `@tsix/Application`
> (std, fs, shell, net, db, pty, keyboard).
> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

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
