# Changelog Lantana

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-11-20

### Modul komunikasi Azalea dan contoh consumer Lantana

- **Azalea:** logika NetSocket, autentikasi PSK, enkripsi, keepalive, dan
  lifecycle koneksi dipisah ke `src/mirror/lib/lantana/azalea-dashboard-communication.ts`.
  Dashboard mengimpor class melalui alias VFS
  `@tsix/lantana/azalea-dashboard-communication`.
- **Consumer console:** `consumer-test.ts` menampilkan bacaan snapshot dan live,
  dengan filter `schemeId` dan `deviceId`; `*` memilih semua yang diizinkan
  untuk akun tersebut.
- **Consumer Telegram:** `consumer-analize-telegram.ts` mengevaluasi bacaan
  numerik terhadap threshold dan mengirim alert saat melewati ambang. Alert
  dikirim sekali per sensor sampai nilainya turun lagi; token dan chat ID
  dibaca dari environment.
- **Format paket:** `esp32-demo.ts` memakai `encodePlainPayload()` dan
  `encodeBinaryPayload()` dari `lantana-core.ts`, bukan encoder lokal.
- **Verifikasi:** kedua consumer berhasil dikompilasi dengan esbuild dan tidak
  menambah error typecheck pada file terkait; 16 tes codec Lantana lulus.
  Pengiriman Telegram memakai HTTPS `fetch` bawaan Node.js.
- **Oleh:** Copilot

## 2026-11-19

### Azalea — client dashboard remote berbasis Pistachio

- **File:** `src/mirror/opt/azalea-dashboard/azalea-dashboard.ts`.
- **Koneksi:** aplikasi TSIX memakai NetSocket ke `lantana-dashboard-server`
  dan autentikasi PIN/PSK; dashboard dapat membaca beberapa device dari node
  server yang sama.
- **Widget:** item dikelompokkan per device; mendukung sensor, gauge, line
  chart, indikator switch, dan command switch dengan status aktual.
- **Grafik:** sampel diambil mengikuti `updateInterval`; jumlah sampel yang
  ditampilkan mengikuti `scrollAfter` (default 7) dan bergeser saat jendela
  penuh.
- **Verifikasi:** tes Pistachio dan protokol dashboard terkait lulus.
- **Oleh:** Copilot

## 2026-11-18

### Control Panel dipindah ke Pistachio dengan navigasi pohon

- **File:** `src/mirror/opt/lantana/lantana-control-panel.ts`,
  `src/mirror/lib/lantana/control-panel-tree.ts` (baru),
  `control-panel-tree.test.ts` (baru).
- **Latar:** control panel lama memakai Cashew dan navigasinya berupa tombol
  section + daftar datar, sehingga akun, device, scheme, dan dashboard
  tercampur dalam satu list per section.
- **Perubahan UI:** panel kini dibangun dari komponen Pistachio (`TForm`,
  `TTreeView`, `TVStack`, `THStack`, `TGridPanel`, `TScrollBox`, `TEdit`,
  `TComboBox`, `TLabel`, `TButton`, `TDialogs`).
- **Navigasi pohon:** akun → `Device (n)` / `Scheme (n)` / `Portable Dashboard (n)`
  → entri → item dashboard. Klik baris akun/grup membuka anaknya; klik entri
  menampilkan editornya. Sub-akun tampil sebagai anak akun induk, akun dengan
  parent hilang tetap muncul sebagai root.
- **Lookup form item:** `Device`, `Scheme`, dan `Icon` pada item portable
  dashboard kini berupa combobox, bukan isian ID manual. Device & scheme diambil
  dari data akun dashboard tersebut (`Sensor A · 7f352db1`, `101 · Suhu (°C)`),
  sedangkan icon memakai daftar aplikasi Android
  (`src/mirror/lib/lantana/dashboard-icons.ts`: thermostat, water_drop, bolt,
  power_settings_new, lightbulb, air, speed, sensors). Nilai lama yang tidak ada
  di daftar tetap ditampilkan paling atas agar tidak berubah tanpa disengaja.
- **Editing:** field langsung bisa disunting tanpa mode terpisah; tombol Simpan
  mengirim perubahan ke `lantana-ctl` (`account permissions`, `device update`,
  `scheme update`, `dashboard update`, `dashboard item-set`). Tombol Tambah
  mengikuti konteks pilihan (sub-akun, device, scheme, dashboard, atau item),
  dan Batal membatalkan draft.
- **Konsistensi:** setelah memuat ulang data, entri terpilih disegarkan dari
  registry supaya editor tidak menampilkan record lama; item baru langsung
  terpilih setelah disimpan.
- **Bug "kadang form tidak muncul":** pemilihan baris tidak lagi melewati guard
  `busy` milik aksi Simpan/Muat ulang, dan panel mencatat versi pilihan sehingga
  hasil muat ulang yang datang terlambat tidak menimpa baris yang baru diklik
  user.
- **Testabilitas:** model pohon dipisah ke `control-panel-tree.ts`
  (`buildControlTree`, `findPayload`, `nodeIdOf`) sehingga bisa diuji tanpa
  menjalankan window.
- **Verifikasi:** 5 tes model pohon lulus; 204 tes Pistachio + Lantana lulus;
  typecheck tidak menambah error baru.
- **Oleh:** Copilot

---
## 2026-11-18

### Menu Monitor di control panel

- **File:** `src/mirror/opt/lantana/lantana-control-panel.ts`,
  `src/mirror/lib/lantana/control-panel-tree.ts`,
  `src/mirror/lib/lantana/monitor-view.ts` (baru), `monitor-view.test.ts` (baru).
- **Pohon:** setiap akun mendapat grup **Monitor** di posisi paling bawah,
  selevel dengan Device / Scheme / Portable Dashboard. Klik Monitor langsung
  menampilkan tampilan live di area kanan (tidak ada entri anak).
- **Isi monitor:** status koneksi (`🟢 Connected` / `🔴 Menunggu daemon`), waktu
  snapshot terakhir, lalu kartu device per grup: judul + device ID, metadata
  (`akun · cat · kota · grp`), baris sensor (`101=20 °C  102=31 %`), status
  ONLINE/STALE/OFFLINE berwarna, dan umur data (`0.0s ago`).
- **Data:** memakai jalur yang sama dengan `lantana-dashboard` — kirim
  `LANTANA_SNAPSHOT` ke daemon tiap 3 detik selagi Monitor aktif, dan
  menangani `LANTANA_SNAPSHOT_REPLY`, `LANTANA_READING`, serta
  `LANTANA_DEVICE_STATUS`. Polling berhenti otomatis saat pindah menu atau
  window ditutup. Device yang terdaftar di registry tetap tampil dengan status
  OFFLINE sebelum daemon mengirim data.
- **Testabilitas:** `monitor-view.ts` memuat pemformatan sensor, umur data,
  warna status, pengelompokan (Ungrouped di akhir), dan merge bacaan per
  `schemeId` — semuanya diuji tanpa GUI.
- **Verifikasi:** 7 tes `monitor-view`, 5 tes pohon (Monitor ikut di posisi
  terakhir), 165 tes Lantana + controls lulus; typecheck tidak menambah error.
- **Oleh:** Copilot

### Sesi device pulih setelah server/Lantana restart
- **File:** `src/mirror/lib/lantana/lantana-listener.ts`, `lantana-listener.test.ts`,
  `platformio/TSIX-All-in-One/lib/lantana-auth/{lantana_auth.h,lantana_auth.cpp}`,
  `platformio/TSIX-All-in-One/src/variants/lantana.cpp`
- **Masalah:** sesi Lantana hanya hidup di memori server dan di-key `address:port`
  sumber device. Saat TSIX/Lantana restart (atau device reconnect sehingga port
  sumbernya berubah) sesi di server hilang, sedangkan ESP tetap merasa `ONLINE`
  dengan session key lama. Data sensor dibuang server tanpa pemberitahuan, jadi
  device tampak "berhenti mengirim data" sampai di-reboot.
- **Perubahan server:** data tanpa sesi terautentikasi kini dibalas `LANTANA_NACK`
  **plaintext** (`UNAUTHENTICATED`, "sesi tidak aktif — kirim LANTANA_HELLO")
  maksimal sekali per 5 detik per device, supaya device tahu harus handshake ulang.
  NACK terenkripsi tidak berguna di sini karena kunci sesi device sudah tidak cocok.
- **Perubahan ESP:** `LantanaAuth` memulai sesi baru ketika link MQTT baru
  tersambung (broker/server restart), saat NACK diterima, saat umur sesi melewati
  10 menit (server hanya menyimpan sesi di memori), dan saat `sendEncrypted` gagal
  3 kali berturut-turut. `noteSendResult()` dipanggil varian Lantana setiap kirim.
- **Dampak:** device kembali terautentikasi otomatis dalam hitungan detik tanpa
  reboot; data sensor lanjut masuk ke DeviceBank setelah server hidup lagi.
- **Verifikasi:** 120 tes Lantana lulus (termasuk NACK handshake ulang, rate
  limit-nya); firmware `lantana-esp32` dan `lantana-esp8266` berhasil dikompilasi.
- **Oleh:** Copilot

### `portableDashboard` dipindah ke `/etc/lantana/dashboard.json`
- **File:** `src/mirror/lib/lantana/dashboard-registry.ts` (baru), `dashboard-registry.test.ts` (baru), `account-manager.ts`, `lantana-core.ts`, `lantana-store.ts`, `lantana-ctl.ts`, `lantana-dashboard-server.ts`
- **Masalah:** konfigurasi dashboard menumpang di `accounts.json` bersama kredensial akun, sehingga edit dashboard berisiko menyentuh file kredensial dan formatnya bercampur.
- **Perubahan:** dashboard + verifier key-nya dipisah ke registry sendiri dengan file `/etc/lantana/dashboard.json` berformat `[{ accountId, portableDashboard, createdAt }]`. `accounts.json` tidak lagi memuat `portableDashboard`. State lama yang masih menyimpan dashboard di `accounts.json` dimigrasikan otomatis saat `loadState()` (dashboardId duplikat tidak digandakan).
- **Dampak:** `lantana-ctl dashboard ...`, `lantana-dashboard-server`, dan `account list` membaca/menulis ke file dashboard; isi dashboard yang sudah ada tetap terbaca.
- **Oleh:** Copilot

---

## 2026-08-31 (lanjutan 2)

### Fix duplikasi daftar device di dashboard (race render)
- **File:** `src/mirror/opt/lantana/lantana-dashboard.ts`
- **Masalah:** kadang device list tampil dobel — `▸ client-a (1 device)` dua kali dan kartu device dua kali. Penyebabnya dua panggilan `renderDeviceList()` yang datang hampir bersamaan (event `LANTANA_SENSOR_DATA` + `LANTANA_DEVICE_STATUS` / snapshot) jalan **paralel**: dua `setContent` (clear + mount) bisa interleave → node tercampur → duplikat.
- **Perubahan:** `renderDeviceList` kini **diserialisasi** dengan promise-chain (mutex) — render berikutnya antri di belakang render yang sedang berjalan, sehingga `setContent` tidak pernah tumpang tindih.
- **Dampak:** daftar device selalu render satu set utuh (tidak dobel), nilai sensor tetap tampil (`01=55 °C 02=80 % ...`).
- **Oleh:** Copilot

---

## 2026-08-31 (lanjutan)

### Dashboard di-porting ke Cashew + fix tampil nilai sensor
- **File:** `src/mirror/opt/lantana/lantana-dashboard.ts`
- **Perubahan:**
  - Port penuh dari **Emerald** → **Cashew**: `Screen/div/span/textarea` → `TForm`, `TPanel`, `TLabel`, `TMemo`, `TStatusBar`, `TTimer`.
  - Device list di-render dinamis via `screen.setContent(...)` (pola Cashew yang benar).
  - Status log pakai `TMemo` + **`scrollToBottom()`** → auto scroll ke bawah setiap ada log baru.
  - Polling snapshot pakai `TTimer` (3 detik) menggantikan while-loop Emerald.
  - **Dukungan multi-tenant:** map device & sensor di-key `tenant::nodeId` (nodeId boleh sama antar tenant).
- **Fix bug tampilan:** sebelumnya span sensor menampilkan `sensors: 01, 02, 03, 04` (daftar ID) karena nilai di-update terpisah (`renderAllSensors`) yang rawan race dengan `setContent`. Sekarang nilai sensor di-render **langsung** dari `sensorMap` di `renderDeviceList` → tampil `01=39 °C 02=14 % 03=52 hPa 04=29 lx`; `renderAllSensors` dihapus.
- **Oleh:** Copilot

### Kategori device `esp32` → `esp` (selaras config)
- **File:** `src/mirror/etc/lantana/config.json`, `src/mirror/lib/lantana/lantana-device-bank.ts`, `lantana-core.ts`, `lantana-device-bank.test.ts`
- **Perubahan:** `inferDeviceCategory()` return `"esp"` (bukan `"esp32"`); fallback config `deviceCategories.esp32` → `esp`; test ikut disesuaikan.
- **Dampak:** device dengan nodeId `esp8266-dev-01` kini match key `"esp"` di config → label/icon `ESP` tampil benar (sebelumnya fallback ke nodeId karena key tidak match).
- **Oleh:** kakang (config) + Copilot (kode/test)

---

## 2026-08-31

### API key tenant (`apiKeyHex`) — kredensial + enkripsi
- **File:** `src/mirror/etc/lantana/config.json`, `src/mirror/lib/lantana/lantana-core.ts`, `src/mirror/lib/lantana/lantana-listener.ts`, `src/mirror/usr/bin/keygen.ts`
- **Perubahan:**
  - `LantanaPortConfig.keyHex` → **`apiKeyHex`** — API key tenant (hex 64 char) diterbitkan portal saat registrasi, ditanam ke firmware, dan dipakai sebagai kunci ChaCha20 sekaligus kredensial akses (authenticated encryption).
  - Rename `key` → `apiKey` di seluruh lini: config, core, listener (`ioctl 0x1001`), `keygen.ts` (output `char apiKey[] = "<hex>";` siap tempel).
- **Dampak:** satu istilah (`apiKey`) konsisten di config ↔ driver ↔ firmware ↔ custom listener.

### Firmware `noslib` — apiKey sebagai string hex
- **File:** `platformio/ESP32-MQTNL-SensorData-Sender/lib/noslib/*`, `platformio/ESP32-MQTNL-Sender-minimum/lib/noslib/*`, `src/main.cpp`, `lib/noslib/Examples/Test/Test.ino`
- **Perubahan:**
  - `main.cpp` kini `char apiKey[] = "81ff71ed...";` (string hex) — bukan array byte yang menyeramkan.
  - `noslib.h/.cpp` tambah `hexToBytes()` + `keyBytes[KEY_SIZE]`; `chacha.setKey(keyBytes, ...)` memakai byte hasil konversi.
  - **Perbaikan bug:** sebelumnya `setKey((uint8_t*)apiKey, KEY_SIZE)` memakai 32 byte pertama karakter ASCII hex (bukan nilai hex asli) → key server & device tidak match. Sekarang benar.
- **Dampak:** tenant tinggal salin string apiKey dari portal ke `main.cpp`; `noslib` tetap netral (tidak tergantung Lantana).

### Multi-tenant aman — nodeId sama, apiKey beda tidak konflik
- **File:** `src/mirror/lib/lantana/lantana-device-bank.ts`, `lantana-core.ts`, `lantana-distributor.ts`, `lantana-cmd.ts`, `config.json`
- **Masalah:** Device Bank di-key hanya `nodeId` → dua tenant dengan `nodeId` sama saling menimpa (tenant, sensor, grup, srcAddress).
- **Perubahan:**
  - Key internal registry → **`tenant::nodeId`** (`private key(nodeId, tenant)`).
  - `getDevice`/`getDeviceAddress`/`getSensors` tenant-aware; tambah `getDeviceByNode` (fallback command).
  - `deviceGroupMap` → nested `{ tenant: { nodeId: group } }` (flat legacy tetap didukung).
  - `LantanaCommand` tambah `tenant?`; `lantana-cmd <nodeId> <cmd> [target] [tenant]`.
  - Distributor: semua panggilan bank pakai tenant; `handleCommand` utamakan tenant+nodeId.
- **Dampak:** nodeId yang sama di tenant berbeda jadi entri terpisah; firmware tidak perlu diubah (cukup apiKey benar). Consumer (dashboard/db-injector/file-logger) tetap jalan tanpa perubahan.

### Dokumen & contoh
- **File:** `wiki/lantana-in-a-nutshell.md` (baru), `wiki/LANTANA.md`
- **Perubahan:** panduan lengkap Lantana (arsitektur, config + apiKey, contoh firmware plaintext & biner, consumer dashboard/db-injector/file-logger, alur tenant, event API, heartbeat, pemisahan protokol vs produk).

### Test
- **File:** `src/mirror/lib/lantana/lantana-device-bank.test.ts`
- **Perubahan:** +3 test multi-tenant (nodeId sama tenant beda tidak konflik, group per tenant, listDevices menampilkan keduanya). Total 8 test lolos.

---

## Catatan deploy
- Setelah update kode Lantana, sinkronkan ke VFS yang berjalan: `npm run vfs:bootstrap` / `install` agar daemon memakai kode baru.
- Format config baru (`apiKeyHex`, `deviceGroupMap` nested) harus dipakai saat daemon start; config lama (`keyHex`, flat group) tetap dibaca via fallback/backward-compat.
