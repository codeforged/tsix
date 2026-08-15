# Changelog Air-Type

> Format: `YYYY-MM-DD | Perubahan | Oleh`

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
