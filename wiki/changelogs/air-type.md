# Changelog Air-Type

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-08-16

### Fitur: desktop notification saat ada pesan masuk dari orang lain
- **File:** `src/mirror/opt/air-type/air-type.ts`
- **Cara:** saat client menerima pesan chat dari nick LAIN (bukan nickname sendiri), kirim `shell.send(AST_IDENTITY, {type:"DESKTOP_NOTIF", title, message})` ke Asteracea (identity `3ec3ffe9-e0a6-411f-b7e3-c9ff0b00556c`) → muncul toast desktop.
- **Title:** `✈️ <from> · #<room>` · **Message:** isi pesan.
- **Catatan:** hanya pesan chat (bukan sys/join/leave). Kalau air-type dijalankan tanpa WM (terminal saja), send di-`catch` → diam.
- **Oleh:** Copilot

---

## 2026-08-16

### Fix: anggota room dobel saat buka-tutup-buka aplikasi (reconnect)
- **File:** `src/mirror/opt/air-type/air-type.ts`, `src/mirror/opt/air-type-server/air-type-server.ts`
- **Gejala:** buka → tutup → buka air-type → nick muncul 2x di daftar anggota room.
- **Akar masalah:** sid koneksi = `addr:localPort`, dan localPort client acak per sesi. Saat tutup tanpa `leave`, sesi lama masih nyangkut di server (baru di-bersihkan setelah `staleMs` 300 dtk); buka lagi = sid baru → dianggap anggota baru → dobel.
- **Fix client (`air-type.ts`):**
  - `clientId` STABIL (UUID acak, disimpan di config.json) — dikirim di pesan `join`/`create`.
  - `onClose` sekarang mengirim `{t:"leave"}` sebelum socket ditutup → server langsung menghapus anggota (graceful), bukan nunggu timeout.
- **Fix server (`air-type-server.ts`):**
  - Track `clientIdToSid` (clientId → sid).
  - Saat `join`/`create` dengan clientId yang sudah punya sesi lama → sesi lama dibuang (keluar dari room + clients) dulu, baru sesi baru masuk → tidak dobel.
  - Bersihkan mapping `clientIdToSid` saat `leave` dan saat cleanup idle.
- **Oleh:** Copilot

---

## 2026-08-16

### `configure.ts` terpisah per paket (server vs client)
- **File:** `src/mirror/opt/air-type-server/configure.ts` **(baru)**, `src/mirror/opt/air-type/configure.ts`
- **Latar:** server dan client chat adalah paket aplikasi terpisah — masing-masing punya configure.ts sendiri.
- **Server (`/opt/air-type-server/configure.ts`, baru):**
  - Setup `/etc/air-type-server` → 0o777 (config.json gampang diedit non-root).
  - Periksa identitas RSA (`/etc/keys/rsa`) → warning jika belum ada (server butuh untuk handshake E2E).
- **Client (`/opt/air-type/configure.ts`):** kembali khusus `/etc/air-type` (data client: history, known_hosts, config client) → 0o777.
- **Struktur paket:**
  ```
  /opt/air-type/          → air-type.ts + configure.ts (client GUI)
  /opt/air-type-server/   → air-type-server.ts + configure.ts (server daemon)
  ```
- **Oleh:** Copilot

---

## 2026-08-16

### Fitur: kehadiran anggota per room (bullet hijau/kuning/merah)
- **File:** `src/mirror/opt/air-type/air-type.ts`, `src/mirror/opt/air-type-server/air-type-server.ts`
- **Server (`air-type-server.ts`):**
  - Config presence baru `/etc/air-type-server/config.json` (auto-dibuat bila belum ada): `greenMax` (10), `yellowMax` (299), `redMin` (300), `staleMs` (300000), `presenceInterval` (5000). `configure.ts` ikut menyiapkan `/etc/air-type-server` (0o777).
  - `broadcastPresence()`: kirim daftar anggota per-room (`{nick, lastSeen}`) + threshold warna ke semua client. Dipanggil saat join/create, ganti nick, leave, cleanup stale, dan periodik tiap `presenceInterval`.
  - Cleanup idle memakai `staleMs` dari config (default 300 dtk = redMin).
- **Client (`air-type.ts`):**
  - Config client + `aliveInterval` (detik, default 10) → interval ping keepalive dinamis.
  - Daftar room di-render custom (bukan TListBox): tiap room = baris `# nama` (klik → pindah room, highlight) + baris anggota `● nick`.
  - Bullet warna by umur `lastSeen`: `<=greenMax` → hijau `#4caf50`, `<redMin` → kuning `#ffc107`, `>=redMin` → merah `#f44336`. Threshold diambil dari broadcast presence server (bisa di-override).
  - `presenceTimer` 4 dtk → refresh warna bullet lokal (umur bertambah walau tanpa broadcast baru).
  - Handler `t:"presence"` di `handleServerMsg` untuk update `membersByRoom` + thresholds.
- **Perilaku:** client yang sehat ping tiap `aliveInterval` → bullet hijau; yang berhenti ping lama makin kuning → merah.
- **Oleh:** Copilot

---

## 2026-08-16

### `air-type.ts` (GUI) di-strip jadi murni client-only
- **File:** `src/mirror/opt/air-type/air-type.ts`
- **Latar:** server sudah dipisah ke daemon headless `/opt/air-type-server/` — biar tidak dobel, semua fungsi server di GUI client dihapus.
- **Dihapus:** `isServer`/`--serve` parsing, `serverSocket`, `clients`, `roomMembers`, `pubKey`/`privateKey`/`fingerprint`, dan fungsi `serverSendToPeer`, `relayToRoom`, `broadcastRooms`, `serverSys`, `serverHandleChat`, `serverHandlePacket`, `serverLoop`, `serverSetup` (+ interface `Peer`). Semua cabang `isServer` di `setupNetwork`/`sendMessage`/`createRoom`/`setRoom`/`onClose`/statusBar/lblRole diramping.
- **Hasil:** `air-type` = client GUI murni (handshake RSA + chat). Server headless = `air-type-server` (daemon, auto-start via rc.local).
- **Oleh:** Copilot

---

## 2026-08-16

### Server dipisah jadi daemon headless `/opt/air-type-server/air-type-server.ts` (tanpa GUI)
- **File:** `src/mirror/opt/air-type-server/air-type-server.ts` **(baru)**, `src/mirror/etc/rc.local.ts`
- **Latar:** server chat tidak perlu GUI — yang GUI cukup client (`air-type`). Server dijadikan daemon headless, pola `airtermd`/`otad`.
- **`air-type-server.ts` (baru, `/opt/air-type-server/`):**
  - Headless hub/relay — TIDAK ada UI (tanpa `appMode`, tanpa cashew). CLI: `air-type-server [port]` (default 2500).
  - RSA handshake (client minta pubkey → kirim session key terenkripsi RSA) → per-koneksi session key ChaCha20 dinamis.
  - Dekripsi manual per-koneksi hanya untuk routing protokol (room), lalu relay terenkripsi ke anggota room. **Tidak mencatat isi chat** (jaga semangat E2E) — hanya log routing.
  - **Daemonize**: `shell.daemonize("Air-Type Server")` → jalan di background seperti airtermd/otad.
- **`rc.local.ts`**: air-type-server di-start otomatis saat boot (exec `/opt/air-type-server/air-type-server.js`), setelah IoT-Listener.
- **Catatan:** `air-type.ts` (GUI) masih punya mode `--serve` sebagai fallback server ber-GUI; untuk produksi gunakan `air-type-server`.
- **Oleh:** Copilot

---

## 2026-08-16

### Fix: daftar room duplikat saat klik room (race setContent)
- **File:** `src/mirror/opt/air-type/air-type.ts`
- **Gejala:** klik salah satu room di panel kiri → daftar room langsung jadi dobel (general, general, games, games, ...).
- **Akar masalah (race condition):** klik item memicu **dua** `setContent("room-list")` yang tumpang tindih:
  1. refresh internal `TListBox` (fire-and-forget, tidak di-await) dari handler klik.
  2. `setRoom` → `renderRooms` → `roomList.refresh` → `setContent` lagi.
  Karena keduanya `await` round-trip GUI, pesan IPC saling interleave → item ke-mount dua kali.
- **Perbaikan:**
  - `setRoom` **tidak lagi** memanggil `renderRooms()` (highlight sudah ditangani refresh internal TListBox saat klik).
  - `createRoom`: `renderRooms()` dipindah **setelah** `setRoom` (biar highlight room baru benar) dan hanya sekali.
  - `renderRooms()` di-**serialisasi** (promise-chain) agar panggilan yang tumpang tindih (mis. broadcast server) tidak race.
- **Oleh:** Copilot

---

## 2026-08-16

### Fix minor: label judul room (lbl-room) tidak berubah saat bikin room baru
- **File:** `src/mirror/opt/air-type/air-type.ts`
- **Gejala:** setelah buat room (auto-join), label judul di kanan atas (lbl-room) tetap menampilkan room lama (mis. "# general").
- **Perbaikan (`setRoom`):**
  - Label judul room kini **selalu** di-sinkronkan — bahkan jika `room === currentRoom` (guard lama `if (room === currentRoom) return;` melewatkan update label).
  - Update label di-**flush eksplisit** (`form.screen.win.flush()`) agar tidak bergantung pada batch `setTimeout(0)` yang bisa tertunda oleh `setContent` dari `renderRooms`/`renderHistory` yang beruntun.
- **Catatan:** `Screen` (emerald) tidak punya `flush()` — pakai `form.screen.win.flush()`.
- **Oleh:** Copilot

---

## 2026-08-16

### Refactor: install.ts kembali generik + `/opt/air-type/configure.ts` (setup permission)
- **File:** `src/mirror/opt/air-type/configure.ts` **(baru)**, `scripts/install.ts`, `scripts/vfs-bootstrap.ts`, `scripts/sync-vfs.ts`
- **Latar (keberatan user):** special-case `vfsDir === "/etc/air-type" ? 0o777 : 0o755` bikin script sync (install.ts & kawan-kawan) jadi tidak generik — nama aplikasi nempel di script inti.
- **Perubahan:**
  - **Hapus special-case `/etc/air-type`** dari `install.ts`, `vfs-bootstrap.ts`, `sync-vfs.ts` → sync kembali polos (semua direktori 0o755).
  - **`configure.ts` (baru, di `/opt/air-type/`):** setup pasca-instalasi — pastikan `/etc/air-type` ada + `chmod 0o777` (world-writable) agar air-type non-root bisa menulis `history.json`/`known_hosts`. Dijalankan sebagai **ROOT** (`/opt/air-type/configure.js`). Idempotent.
- **Deploy:** setelah install/update, jalankan `/opt/air-type/configure.js` (root) supaya permission data dir benar. Integrasi **post-install hook tpkg menyusul** (user akan cek tpkg dulu).
- **Oleh:** Copilot

---

## 2026-08-15

### Fix: kirim pesan tidak ada efek — onInput di-set di onSetup (terlambat)
- **File:** `src/mirror/opt/air-type/air-type.ts`
- **Gejala:** handshake/koneksi OK (server & client tampil connected), tapi Enter / klik Send tidak menghasilkan apa-apa.
- **Akar masalah:** `input.onInput` di-set di `form.onSetup`, padahal cashew **auto-bind event saat `run()` (sebelum onSetup)** → handler `onInput` tidak pernah terdaftar → `inputText` selalu kosong → `sendMessage()` langsung `return`. (Tombol & keydown terpanggil, tapi tidak ada teks.)
- **Perubahan:** semua binding event dipindah ke **sebelum `form.run()`** (cara cashew yang benar):
  - `input.onInput` → set langsung setelah konstruksi komponen.
  - `btnSend.onClick`, `btnNewRoom.onClick`, `btnNewRoom2.onClick` → set sebelum run (auto-bind).
  - Keydown Enter tetap via `screen.on("msg-input","keydown")` di onSetup (TEdit cashew tidak punya onKeyDown native).
- **Catatan (gotcha cashew):** event handler (`onClick`/`onInput`) WAJIB di-set sebelum `run()`; hanya keydown/focus yang butuh `screen.on` di onSetup.
- **Oleh:** Copilot

---

## 2026-08-15

### Nickname: prompt sekali + perintah /nickname
- **File:** `src/mirror/opt/air-type/air-type.ts`
- **Perubahan:**
  - **Prompt nickname saat startup** hanya jika belum ada di config (`/etc/air-type/config.json`). Setelah diisi → langsung disimpan ke config → launch berikutnya tidak prompt lagi. Prioritas nickname: argumen > config > prompt (default hostname).
  - **Perintah `/nickname <nama>`** di input chat: ganti nickname kapan saja tanpa terkirim sebagai pesan chat; update label header + simpan config + notif lokal. Untuk client, mengirim `{t:"nick"}` ke server agar server memakai nama baru saat relay; untuk server, relay sys-notice ke anggota room. Server juga handle `t:"nick"` (update `client.nick` + sys-notice).
  - Teks prompt alamat server diperjelas (MQTNL address node server, bukan IP).
- **Oleh:** Copilot

---

## 2026-08-15

### v1.0 — Air-Type: Secure E2E Chat antar Node TSIX (Cashew + MQTNL)
- **File:** `src/mirror/opt/air-type/air-type.ts` **(baru)**, `src/mirror/etc/air-type/config.json` **(baru)**, `src/mirror/opt/asteracea/menu/air-type.menu` **(baru)**, `scripts/install.ts`, `scripts/vfs-bootstrap.ts`, `scripts/sync-vfs.ts`
- **Fitur:**
  - Chatroom antar node TSIX: startup masuk ke room `general`; bisa buat room custom (`＋ Room Baru` / `＋ Buat Room`).
  - UI Cashew: panel kiri = daftar room (TListBox, klik untuk pindah), panel kanan = history chat + input teks + tombol Send. Kirim via **Enter** saat fokus di input, atau klik tombol Send. Input auto-focus saat launch.
  - **Keamanan E2E ala airtermd**: handshake RSA (public key server + fingerprint) → negosiasi **session key ChaCha20-Poly1305 32-byte yang DINAMIS per koneksi** (bukan KEY_HEX statis). Semua payload chat dienkripsi end-to-end per link. Fingerprint diverifikasi via `known_hosts` (anti MITM, seperti SSH).
  - Dua peran satu binary: `air-type --serve [port]` (server/hub, punya UI juga) dan `air-type <serverAddr> [port] [nick]` (client). Server meneruskan pesan room ke semua anggota room (relay), kelola daftar room, & cleanup client idle.
  - Konfigurasi & history disimpan di `/etc/air-type/`: `config.json` (default server/port/nickname), `history.json` (ditulis saat runtime, debounced), `known_hosts` (fingerprint server). Identitas RSA node dipakai dari `/etc/keys/rsa` (sama seperti airtermd).
- **Perubahan pendukung:**
  - `scripts/install.ts`, `scripts/vfs-bootstrap.ts`, `scripts/sync-vfs.ts`: direktori `/etc/air-type` dibuat **world-writable (0o777)** agar history/known_hosts bisa ditulis aplikasi saat runtime sebagai non-root (konsisten dengan model permissive OS).
  - Menu Asteracea `air-type.menu` → `command=/opt/air-type/air-type.js` (client). Mode server: `air-type --serve` dari terminal.
- **Deploy:** sync VFS (`npx ts-node scripts/sync-vfs.ts src/mirror/opt/air-type/air-type.ts` + config) atau install ulang; lalu launch dari menu/terminal. Catatan: port chat default 2500.
- **Oleh:** Copilot
