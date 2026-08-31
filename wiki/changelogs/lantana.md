# Changelog Lantana

> Format: `YYYY-MM-DD | Perubahan | Oleh`

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
