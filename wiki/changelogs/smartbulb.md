# Changelog Smart Bulb (JayaLaras)

> Migrasi smart home "JayaLaras" dari NOS ke TSIX: GUI denah + service saklar/lampu.
> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-09-07

### `service` — reset relay OFF & seed saklar saat start (fix "lampu nyala sendiri" setelah reboot)

- **File:** `src/mirror/opt/smartbulb/service.ts`
- **Perubahan:**
  - Saat inisialisasi output relay, setiap pin `OUTPUT` kini langsung ditulis **OFF (HIGH)**. Sebelumnya hanya `SET_PIN_MODE` tanpa menulis → pin mengikuti latch boot chip (`GPIOA/B = 0x00` = LOW = relay ON karena active-low) → sebagian lampu menyala sendiri setelah TSIX restart.
  - `swStates` di-*seed* dari pembacaan saklar pertama sebelum polling → poll pertama tidak menganggap semua saklar "berubah" (mencegah lampu ke-toggle acak saat boot).
- **Dampak:** setelah restart, semua relay deterministik OFF (konsisten dgn touch switch OFF); hanya lampu yang di-ON scheduler sesuai jam yang menyala.
- **Oleh:** Copilot + kakang

### `service` — auto-OFF lampu WC (kamar & utama) setelah 15 menit

- **File:** `src/mirror/opt/smartbulb/service.ts`
- **Perubahan:**
  - Saat port WC (**10** = WC Kamar, **11** = WC Utama) dinyalakan → timer **15 menit**; bila masih nyala saat timer habis → padam paksa + `pushState()`.
  - Timer di-*restart* tiap kali dinyalakan lagi; dibatalkan bila dimatikan manual lebih dulu. Berlaku untuk semua jalur nyala (saklar fisik, web/control, `setgpio`).
- **Dampak:** mengatasi kebiasaan lupa memadamkan lampu WC setelah keluar dari WC.
- **Oleh:** Copilot + kakang

### `scheduler` — jadwal lampu otomatis (one-shot client IPC, via crond)

- **File:** `src/mirror/opt/smartbulb/scheduler.ts`, `src/mirror/etc/crontab`
- **Perubahan:**
  - `scheduler.ts` = **one-shot job** (bukan daemon): dipanggil `crond` tiap 5 menit (`*/5 * * * * /opt/smartbulb/scheduler.js`), cek jam → perbaiki lampu yang melanggar → keluar.
  - Client IPC ke `jayalaras.service`: `REGISTER` → `GET` state → `SET` hanya port yang melanggar → `UNREGISTER` (idempoten, minim tulis I2C).
  - Aturan (waktu lokal):
    1. 18:00–04:00 → **ON** teras depan (9), teras belakang (12)
    2. 06:00–17:00 → **OFF** teras depan (9), teras belakang (12)
    3. 23:00–03:00 → **OFF** kamar anak (2), ruang tengah depan (3) & belakang (8)
  - Jam di luar aturan tidak disentuh → kontrol manual/switch/web tetap dihormati (mis. nyala siang hari saat mendung).
- **Dampak:** lampu yang menyala di luar jam jadwal (mis. lupa dipadamkan) dibereskan ≤5 menit; `crond` auto-reload crontab tiap 30 detik.
- **Oleh:** Copilot + kakang

### `setgpio` — CLI client IPC (migrasi utilitas NOS, 2020)

- **File:** `src/mirror/opt/smartbulb/setgpio.ts`, `wiki/smartbulb.md`
- **Perubahan:**
  - `setgpio` adalah **client IPC** (setingkat `control.ts`) ke `jayalaras.service`, bukan akses MCP23017 langsung: `REGISTER` → `SET`/`GET` → `UNREGISTER`.
  - Syntax ala NOS: `setgpio <port>=<1|0> [port=...]`, `--status` (tabel status), `--bits` (state mentah `value <16-bit>` legacy), `--help`.
  - Menampilkan `ports[]` state logika lampu (output `getAllPortStatus()` NOS); urusan active-low & mapping port→pin ditangani service.
  - Menolak dengan pesan jelas bila `jayalaras.service` tidak berjalan (bukan simulasi).
  - `wiki/smartbulb.md`: dokumentasi CLI, diagram arsitektur, pola deployment & hak akses.
- **Oleh:** Copilot + kakang

### Compatibility gateway WebSocket untuk UI legacy JayaLaras

- **File:** `src/mirror/opt/smartbulb/web-gateway.ts`, `wiki/smartbulb.md`, `docs/smartbulb/`
- **Perubahan:**
  - Tambah daemon HTTP + WebSocket pada port `45452` yang mempertahankan RPC legacy `getAllPortStatus`, `setLight`, dan `MQTTsendMsg`.
  - Menyajikan asset `index.html`/`local.html` legacy dari `/opt/smartbulb` tanpa perlu mengubah JavaScript 2021.
  - Menerjemahkan RPC legacy ke IPC `jayalaras.service` dan meneruskan `SMARTBULB_STATE` sebagai envelope MQTT `value <16-bit states>` agar `local.html` auto-update saat switch fisik berubah.
  - Gateway berjalan sebagai compatibility bridge LAN. Pemakaian `hostRequire("http")`, `hostRequire("ws")`, `path`, dan `url` didokumentasikan sebagai utang arsitektur sementara; transport HTTP/WebSocket final sebaiknya masuk kernel land → dispatcher → `UserLib`.
- **Dampak:** UI web legacy dapat tetap dipakai setelah NOS pensiun; service tetap single owner untuk MCP23017.
- **Keamanan:** gateway belum memiliki autentikasi; bind hanya ke LAN/VPN dan jangan expose port `45452` langsung ke internet.
- **Oleh:** Copilot

### Service smartbulb menjadi daemon app TSIX + hardening 24/7

- **File:** `src/mirror/opt/smartbulb/service.ts`, `src/mirror/opt/smartbulb/control.ts`, `src/kernel/devices/aux-devices/MCP23017Device.ts`, asset PNG smartbulb
- **Perubahan:**
  - `service.ts` mengikuti pola `tsshd`: `export default class`, `execute(lib, args)`, `daemonize`, event IPC langsung, dan cleanup fd saat `SIGTERM`.
  - Penulisan relay diserialisasi agar operasi I2C tidak saling balap; polling switch tidak overlap; subscriber IPC mati dibersihkan otomatis.
  - `control.ts` hanya refresh UI hardware jika state berubah.
  - `MCP23017Device.disabled` dikembalikan ke `false` untuk auto-registration hardware deployment.
- **Dampak:** service menjadi hardware owner tunggal; `control` dan web gateway cukup memakai IPC. Untuk konfigurasi device default `uid=0/gid=0/mode=0660`, service hardware dijalankan root atau user group pemilik device; client IPC tidak perlu root.
- **Oleh:** Copilot + kakang

## 2026-09-04

### `control` — lampu pakai `bulbon/off.png` (TImage klik), label ruangan dihapus

- **File:** `src/mirror/opt/smartbulb/control.ts`
- **Perubahan:**
  - Ikon lampu ON/OFF kini memakai **`bulbon.png` / `bulboff.png`** dari `/opt/smartbulb` (dimuat byte-safe dari VFS → data URI). Tiap lampu = **`TImage` yang bisa diklik** (pakai `TImage.onClick` baru di Cashew): `src` ditukar bulbon ↔ bulboff saat toggle. Fallback tombol emoji otomatis bila PNG tidak tersedia.
  - **Label nama ruangan di bawah lampu dihapus** — denah/background sudah menampilkan nama ruangan (`capStyleAt`/`bulbLabels`/`bulb-cap-*` dibuang).
- **Oleh:** Copilot

### `service` — kandidat device MCP23017 mengikuti nama baru (`mcp-bulb` / `mcp-sw`)

- **File:** `src/mirror/opt/smartbulb/service.ts`
- **Perubahan:** daftar kandidat relay & saklar dirapikan ke nama driver MCP23017 terbaru: relay `/dev/mcp-bulb`; saklar `/dev/mcp-sw` (menggantikan `/dev/relays,/dev/mcp0,/dev/mcp23017` dan `/dev/switches,/dev/mcpSw,/dev/mcp1,...`).
- **Oleh:** kakang

### `control` — GUI Cashew pengontrol lampu (denah rumah)

- **File:** `src/mirror/opt/smartbulb/control.ts`
- **Perubahan:**
  - GUI Cashew (`TForm`/`TPanel`/`TButton`/`TImage`/`TLabel`/`TStatusBar`) dengan denah rumah ala `docs/jayalaras-iot/smartbulb/index.html`: background `layoutrumah.png` (TImage, load VFS) + lampu `💡` yang bisa diklik per ruangan; posisi lampu mengikuti koordinat `index.html`.
  - Ukuran stage otomatis mengikuti dimensi PNG (baca header IHDR); bila gambar tidak ada → fallback kotak ruangan skematik.
  - Mode: **simulasi** (default), **`--hw`** (langsung ke MCP23017 relay, auto-detect), dan **SERVICE** (auto-connect via IPC bila daemon berjalan).
  - Tombol Semua ON/OFF, status bar jumlah lampu, poll relay (bila `--hw`).
- **Oleh:** Copilot

### `service` — daemon JayaLaras (migrasi `jayalarasiot_i2c.js` NOS)

- **File:** `src/mirror/opt/smartbulb/service.ts`
- **Perubahan:**
  - Daemon headless pemilik hardware 2 chip MCP23017 (relay @0x20 + saklar @0x24) dan logika saklar→lampu.
  - Transliterasi `updateSwitchAndLamp()` NOS apa adanya: mapping saklar lama (15→9, 9→11, 8→8, 3→7, 7→15, 12→10, 11→12 kamar mandi invert), **multi-state** (pin 8 & 15), **logika dusk** (jam ≥18 / <5 utk ruang utama depan), relay aktif-low (ON=LOW).
  - IPC (SEND_MSG / `ipc_message`) dengan identity **`jayalaras.service`**:
    - terima `REGISTER`, `UNREGISTER`, `GET`, `SET {port,on}`, `SETALL {on}`
    - push `SMARTBULB_STATE {ports[16], switches[16], manual}` ke subscriber (GUI)
  - Tanpa chip → mode simulasi (state di memori tetap bisa diatur/dipush via IPC — memudahkan tes GUI tanpa hardware).
- **Dampak:** GUI (`control`) bisa menampilkan update saklar fisik real-time; satu sumber kebenaran state/hardware ada di service.
- **Oleh:** Copilot

### Catatan migrasi

- `control.ts` ↔ `service.ts` terhubung via IPC: control otomatis `REGISTER` ke `jayalaras.service` saat start; kalau service belum jalan → kontrol jatuh ke mode lama (simulasi/`--hw`).
- ⚠️ Mapping `port`/saklar masih konfigurasi NOS 2020 — perlu diverifikasi dengan wiring fisik sebelum mengandalkan mode hardware.
- Register chip saklar kedua (`switches` @0x24) di kernel agar logika saklar fisik aktif (lihat `wiki/mcp23017-registration.md`).

---
