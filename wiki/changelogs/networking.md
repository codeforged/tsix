# Changelog Networking MQTNL

> Changelog untuk stack networking MQTNL: `NetSocket`/`NetworkLib`, custom
> security agent (Jalur A), dan tool `secagent`.
> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-09-04

### NetSocket pin wire protocol per-port — `binary`/`protocol` deterministik

- **File:** `src/mirror/lib/NetworkLib.ts`, `src/kernel/devices/SimpleMQTNLDriver.ts`, `src/mirror/opt/test/netsocket-rx.ts`, `src/mirror/opt/test/netsocket-tx.ts`
- **Masalah:** protocol wire keluar ditentukan `protocolRegistry` (protocol "terakhir dipakai" peer) yang **menang atas** opsi `binary`/`protocol`. Di node tunggal (loopback ke `localhost`/diri sendiri), begitu ada satu trafik Binfeo ke alamat itu (mis. `scanif -p ... localhost`, `netsocket-binfeo-*`), socket JSON (`binary:false`) ikut terkirim sebagai Binfeo.
- **Perubahan:**
  - `NetSocket.open()` kini **selalu memin wire protocol per-port** (ioctl 0x1002): opsi `protocol` (mis. `"Binfeo"`) → nama itu; `binary:true` → `"Binary"`; default → `"JSON"`.
  - `SimpleMQTNLDriver.send()` prioritas diubah: **override per-port eksplisit menang** atas `protocolRegistry`; `protocolRegistry` jadi fallback (utk port tanpa override, supaya balasan tetap mengikuti protocol peer); `activeProtocol` fallback terakhir.
  - Contoh `netsocket-rx.ts`/`netsocket-tx.ts` kini eksplisit `protocol: "JSON"`.
- **Dampak:** `binary:false`/`protocol:"JSON"` benar-benar menghasilkan wire JSON walau sudah ada trafik Binfeo sebelumnya. App berbasis `NetSocket` yang ingin mengikuti protocol peer harus eksplisit `protocol: "Binfeo"`.
- **Oleh:** Copilot · **Verifikasi:** pengguna mengonfirmasi — setelah `scanif`, `netsocket-rx/tx` tetap JSON.

### `scanif` — pengganti `nmap` (rename, hapus `-sn`) + fix & perluasan port scan

- **File:** `src/mirror/usr/bin/scanif.ts` (baru, ex `nmap.ts`), `src/kernel/devices/SimpleMQTNLDriver.ts`, `src/kernel/Syscalls.ts`, `src/mirror/etc/tpkg/packages.json`, `wiki/Networking-MQTNL.md`
- **Perubahan:**
  - **Rename `nmap` → `scanif`** (nama file, teks help/usage, manifest tpkg, komentar, docs).
  - **Flag `-sn` dihapus** — tidak relevan lagi: `scanif` (tanpa flag) langsung broadcast ping ke `"*"` (discovery interface online). Help hanya lewat `-h/--help`. Parsing arg memisahkan nilai `-p` dari target → daftar port tidak lagi salah dianggap target (hilang blok scan kosong `Scanning ports on 24,2222...`).
  - **Self-interface ikut tampil di hasil discovery:** broadcast tidak di-loopback ke pengirim, jadi `scanif` menambahkan sendiri interface lokal yang `Connected` (via `net.netstat()`) ke daftar `Found node` berlabel `local interface` (RTT 0ms).
  - **Fix port scan (`-p`):** daemon tidak membalas probe acak, jadi kini kernel `SimpleMQTNLDriver` auto-balas `PING_REPLY` atas `PING_REQUEST` ke port service **yang sedang di-bind** (mirip SYN-ACK TCP). `scanif -p 24,2222 <node>` menampilkan port yang benar-benar terbuka. (Rincian kernel di changelog kernel.)
  - **Mode `-l` baru:** daftar port yang sedang di-bind per interface lokal (mirip `netstat -ltnp`) beserta nama proses/script pemilik — data dari kernel (`getStats().boundPorts` = `[{port, proc}]`).
- **Dampak:** `scanif` (broadcast), `scanif -p 1-1024 <node>` (scan remote), `scanif -l` (lihat port bind lokal + pemiliknya).
- **Oleh:** Copilot

## 2026-09-03

### `nmap` — discovery dan port scan memakai Binfeo

- **File:** `src/mirror/usr/bin/nmap.ts`, `src/mirror/lib/NetworkLib.js`
- **Masalah:** `nmap` memakai `NetworkLib` low-level tanpa mengaktifkan protocol per-port. Akibatnya `sendTo()` memakai `srcPort = 0` dan driver memilih protocol global default, yaitu JSON, sehingga trafik yang diharapkan Binfeo muncul sebagai `JSON` di Bitshark.
- **Perubahan:** kedua mode scan kini menyimpan port hasil `bind()`, mengaktifkan `SMQTNL_IOCTL.SET_BINARY_MODE` dengan protocol `Binfeo`, dan meneruskan port tersebut sebagai `srcPort` saat mengirim probe/discovery.
- **Dampak:** paket TX `nmap` memakai Binfeo (`mqtnl@1.2/`, magic `0x66`) tanpa mengubah protocol global aplikasi lain. Sidecar `NetworkLib.js` ikut diregenerasi agar perubahan berlaku pada runtime.
- **Oleh:** Copilot · **Verifikasi:** pengguna mengonfirmasi sudah solved; tes Binfeo/driver `14/14` lulus.

## 2026-09-02

### `forward` — hilangkan dependensi `@common/Config` (fix ENOENT)

- **File:** `src/mirror/usr/bin/forward.ts`
- **Perubahan:** buang `import { Config }` + `Config.get()`/`defaultBroker` (nilainya tidak pernah dipakai). `Config.load()` membaca `sysconfig.json` dari host filesystem relatif `__dirname` worker → ENOENT di node remote (`/home/<user>/sysconfig.json`).
- **Dampak:** `forward -s <broker_a> -d <broker_b>` jalan di node mana pun tanpa perlu file config host.

### `PacketForwarder` — anti-duplikasi (fix karakter berlipat di tssh)

- **File:** `src/mirror/lib/PacketForwarder.ts`
- **Perubahan:** `nextHop()` kini hanya meneruskan paket **origin-lokal (`forwarded == 0`)**, ditandai `forwarded = 1`. Paket yang sudah pernah di-bridge (`forwarded >= 1`) di-drop — tidak ada "bounce" A↔B. `MAX_FORWARD` dihapus.
- **Dampak:** payload tidak lagi sampai duplikat ke tujuan (sebelumnya: `tssh` ke node di broker lain karakter berlipat & login gagal; `ping` tampak sukses karena reply duplikat mengisi seq berikutnya). Berlaku utk JSON v1.0, Binary OTA v1.1, Binfeo v1.2.

- **Oleh:** Copilot

## 2026-09-03

### `forward` — flag `--start`/`--stop`/`--top` + fix `--stop` benar-benar mematikan bridge

- **File:** `src/mirror/usr/bin/forward.ts`
- **Perubahan:**
  - Flag diubah ke **double dash**: `--start`, `--stop`, `--top` (backward-compat `-start`/`-stop`/`-top` tetap diterima). Teks syntax/help ikut diperbarui.
  - **Fix `--stop`:** sebelumnya hanya mengecek `globalForwarder` (state per-proses) → di proses baru selalu null → bridge daemon tidak berhenti (masih bisa `ping`/`tssh` ke node di broker lain). Kini daemon menulis **PID file `/tmp/forward.pid`** (via `lib.getPid()`) dan mendaftarkan **handler `SIGTERM`** (`lib.shell.onSignal`) yang memanggil `stopForward()` lalu `exit(0)`. Perintah `--stop` membaca PID file → `lib.shell.kill(pid, 15)` (SIGTERM) → hapus PID/stats file → "✅ Bridge stopped."
  - `--start` kini cek status lewat PID file (bukan state lokal yang selalu null).
  - **Cegah duplikasi bridge:** saat `-s/-d` baru, dicek dulu apakah PID file sudah ada — kalau ya, ditolak sampai `--stop`.
- **Rantai kernel terverifikasi:** `kill(pid, 15)` → `SyscallCode.SIGNAL {pid, sig}` → `Scheduler.kill(pid, 15)` → event `"signal"/"SIGTERM"` → `UserLib.signalListeners` → handler daemon.

- **Oleh:** Copilot

## 2026-09-01

### Protocol biner TERSANDI — Binfeo (bukan OTA)

- **File:** `src/common/protocols/MQTNLProtocolBinfeo.ts`, `src/common/protocols/MQTNLProtocolBinary.ts`, `src/kernel/devices/SimpleMQTNLDriver.ts`, `src/common/ISecurityAgent.ts`, `src/common/SecurityAgent.ts`, `src/common/AesGcmAgent.ts`, `src/mirror/lib/NetworkLib.ts`
- **Perubahan:**
  - Protocol baru **`Binfeo`** (extend `MQTNLProtocolBinary`): biner yang BISA dienkripsi utk komunikasi normal — magic `0x66` (`'f'`), topic `mqtnl@1.2/` (bukan OTA `0x42`/`mqtnl@1.1/`). Magic & version di `MQTNLProtocolBinary` dibuat `protected` supaya bisa di-override.
  - Driver: **TX Binfeo dienkripsi** via `securePacketOutRaw()` (beda dari OTA yang bypass); **RX dekripsi ke Buffer utuh** via `securePacketInRawBuffer()` (byte ≥ 0x80 tidak rusak; OTA tetap jalur string).
  - Per-port protocol digeneralisasi: `binaryPorts: Set` → `portProtocols: Map<port, nama>`; ioctl `0x1002` terima `{ port, protocol: "Binfeo" }`.
  - `ISecurityAgent` + agent: tambah `securePacketInRawBuffer()` (decrypt → Buffer) & `securePacketOutRaw?` (encrypt → Buffer) — binary-safe.
  - `NetSocket`: opsi baru **`protocol`** (mis. `protocol: "Binfeo"`) — mengalahkan `binary: true`.
  - Sniffer (`bitshark`) melabeli nama protocol asli (mis. `Binfeo`).
- **Contoh:** `netsocket-binfeo-rx.ts` / `netsocket-binfeo-tx.ts`; test `MQTNLProtocolBinfeo.test.ts`.
- **Dampak:** komunikasi biner normal bisa terenkripsi end-to-end tanpa menyalahgunakan protocol OTA (yang bypass security).

### tssh / tsshd pindah ke Binfeo

- **File:** `src/mirror/opt/tssh/tssh.ts`, `src/mirror/opt/tssh/tsshd.ts`
- **Perubahan:** protocol per-port dari OTA Binary → **Binfeo** (`ioctl 0x1002 { port, protocol: "Binfeo" }`). Enkripsi payload tetap di app level (per-session key) karena `tsshd` multiplex banyak session di SATU port — security driver per-port (1 key/port) tidak cukup.
- **Dampak:** shell TSSH tidak lagi memakai protocol OTA (semantiknya "bypass enkripsi"); wire memakai `mqtnl@1.2/` / magic `0x66`.

### `tsixlib` + proyek PlatformIO `TSIX-All-in-One` (ESP8266/ESP32)

- **File:** `platformio/TSIX-All-in-One/` (lib/tsixlib, src/main.cpp + 4 varian, platformio.ini, README)
- **Perubahan:**
  - Library ESP **`tsixlib`** menggantikan `noslib` + `TSIXSocket` lama: 1 class `TSIX` = WiFi + MQTT + 3 kanal MQTNL:
    - `sendEncrypted()` → JSON v1.0 (`mqtnl@1.0/`, magic `0x5B`), ChaCha20-Poly1305 (hex)
    - `sendBinfeo()` → **Binfeo** v1.2 (`mqtnl@1.2/`, magic `0x66`), biner TERSANDI (byte utuh, ≥0x80 tidak rusak)
    - `sendRaw()` → biner OTA v1.1 (`mqtnl@1.1/`, magic `0x42`), plain
  - Perbaikan bug `noslib`: buffer dinamis (heap) bukan fixed 256, hapus VLA di stack, pong PING/SCAN benar, parsing aman (bounds), `setBufferSize(6144)` untuk OTA.
  - Auto-respond PING & BROADCAST_SCAN; subscribe ketiga prefix (`<id>` + `*`).
  - Proyek **4 varian**: `minimum`, `minimum-binfeo`, `lantana`, `ota` — tiap varian bisa build utk ESP32 & ESP8266 (8 env).
- **Dampak:** firmware ESP cukup pakai satu library utk komunikasi terenkripsi (JSON/Binfeo) + OTA; logika tidak lagi tersebar di 3 proyek terpisah.

### `tsixlib` — PING/BROADCAST jalan di semua kanal (fix)

- **File:** `platformio/TSIX-All-in-One/lib/tsixlib/tsixlib.h`, `tsixlib.cpp`
- **Perubahan:** `handleV11` (biner OTA) & `handleV12` (Binfeo) sekarang auto-respond **PING_REQUEST** (flag 1, port 65535) dan **BROADCAST_PING** (flag 3, port 65534) — sebelumnya hanya `handleV1` (JSON) yang melakukannya. Sebab: server merutekan ping ke sebuah address memakai protocol yang terakhir ia lihat dari address itu (`protocolRegistry`), jadi device Binfeo menerima ping di `mqtnl@1.2/`. `publishBinary()` kini menerima param `flag` + helper `sendPongBinfeo()`/`sendPongRaw()`.
- **Dampak:** `nmap` & `ping` (kebutuhan dasar MQTNL) tetap jalan di device JSON, Binfeo, maupun OTA.

### `tsixlib` — kredensial dipisah ke `secrets.h` (tidak di-commit)

- **File:** `platformio/TSIX-All-in-One/include/secrets.h` (git-ignored), `include/secrets.sample.h`, `src/variants/*.cpp`, `.gitignore`
- **Perubahan:** WiFi SSID/password, MQTT server/port, dan `apiKey` tidak lagi inline di varian — dipindah ke `include/secrets.h` yang **di-gitignore**. Template `secrets.sample.h` di-commit; varian `#include "secrets.h"` memakai `TSIX_WIFI_SSID`/`TSIX_MQTT_SERVER`/`TSIX_API_KEY`.
- **Dampak:** kredensial asli tidak pernah masuk git; clone baru cukup `cp secrets.sample.h secrets.h`.

### Firmware lama diganti TSIX-All-in-One

- **File:** hapus `platformio/ESP-OTA-MQTNL`, `platformio/ESP32-MQTNL-Sender-minimum`, `platformio/ESP32-MQTNL-SensorData-Sender`
- **Perubahan:** 3 proyek PlatformIO lama (`noslib` + `tsixOTA`) dihapus; sejak sekarang hanya **`TSIX-All-in-One`** (tsixlib + 4 varian) yang dipakai & dipelihara.
- **Dampak:** satu proyek utk semua kebutuhan ESP (JSON/Binfeo/OTA), tidak ada duplikasi.
- **Oleh:** Copilot

### `PacketForwarder` — bridge mendukung 3 protokol MQTNL (v1.0/v1.1/v1.2)

- **File:** `src/mirror/lib/PacketForwarder.ts`, `src/mirror/lib/PacketForwarder.js`, `src/mirror/usr/bin/forward.ts`
- **Perubahan:**
  - Sebelumnya forwarder hanya subscribe `mqtnl@1.0/#` dan `JSON.parse` semua payload → trafik biner OTA (v1.1) dan Binfeo terenkripsi (v1.2) tidak dijembatani (atau rusak bila di-re-encode).
  - Kini subscribe **ketiga prefix** (`mqtnl@1.0/#`, `mqtnl@1.1/#`, `mqtnl@1.2/#`) dan meneruskan payload **byte-exact** (tanpa re-encode) → byte biner/terenkripsi tidak berubah sama sekali.
  - Loop prevention version-aware: counter `forwarded` di-increment per hop — JSON: elemen array ke-8; Binary/Binfeo: byte di offset `17 + srcLen + dstLen` (di-patch pada salinan buffer). Paket di-drop saat `forwarded >= 3` (anti-loop).
  - Helper `pack()`/`unpack()` lama dihapus → diganti `nextHop()`/`subscribeAll()`.
  - `forward.ts`: perbaikan error strict-mode `TS18046` (`catch (e: unknown)` → `e.message` aman).
  - Catatan: runtime memakai sidecar `.js` (hasil `esbuild.transformSync` seperti `scripts/sync-vfs.ts`), jadi `.js` ikut di-regenerate agar sinkron dengan `.ts`.
- **Dampak:** broker bridge kini relevan untuk seluruh stack MQTNL (JSON / Binfeo / OTA), bukan hanya v1.0 — OTA & komunikasi biner terenkripsi ikut terjembatani.

### `tsixlib` — state machine OTA dipindah ke class `TSIXOTA`

- **File:** `platformio/TSIX-All-in-One/lib/tsixlib/tsixota.h`, `tsixota.cpp`, `tsixlib.h`, `src/variants/ota.cpp`
- **Perubahan:** logika OTA (`ota.info` / `ota.read` / chunk `0x55`, `Update.*`) yang tadinya menumpuk di `src/variants/ota.cpp` dipindah ke library tsixlib sebagai class **`TSIXOTA`**: `begin(Config)`, `start()`, `loop()`, callback `onProgress/onComplete/onError`, helper `isRunning()/done()/total()`. `tsixlib.h` meng-`#include "tsixota.h"` (include guard aman dari circular). Varian `ota.cpp` diringkas jadi config + wiring; default `deviceClass` otomatis (`esp32` / `TestDevice`).
- **Dampak:** semua varian/device bisa pakai OTA tanpa duplikasi kode ~150 baris.

### `platformio` — fix env `ota-esp32c3` + env baru `ota-esp32`

- **File:** `platformio/TSIX-All-in-One/platformio.ini`
- **Perubahan:**
  - `ota-esp32c3` (ESP32-C3): tambah `build_src_filter = +<*> -<variants/*>` — sebelumnya hilang karena env tidak `extends = common` → memperbaiki error link **"multiple definition"** (`setup`/`loop`/`tsix`) akibat semua `variants/*.cpp` ikut dikompilasi terpisah dari dispatcher `main.cpp`.
  - Env baru **`ota-esp32`** (ESP32 biasa, board `esp32dev`) dengan `extends = common` + `-DAPP_VARIANT_OTA`.
- **Dampak:** varian OTA bisa build & upload di ESP32-C3 maupun ESP32 biasa tanpa error link.

### Komentar varian diterjemahkan ke EN + host Lantana diganti

- **File:** `platformio/TSIX-All-in-One/include/secrets.sample.h`, `src/variants/lantana.cpp`, `minimum.cpp`, `minimum-binfeo.cpp`
- **Perubahan:** komentar header varian diterjemahkan ID→EN; placeholder `secrets.sample.h` memakai nilai generik; host Lantana `wintsix` → `tsix`.
- **Dampak:** konsistensi bahasa dokumentasi kode; tidak ada perubahan logika.

- **Oleh:** Copilot

## 2026-08-31

### NetSocket — komponen networking high-level ala Cashew

- **File:** `src/mirror/lib/NetworkLib.ts`, `src/mirror/lib/Application.ts`
- **Perubahan:**
  - Tambah class **`NetSocket`** (Cashew-style): `new NetSocket({ port, iface, key, binary, autoCleanup })` → `open()` → events `onData/onError/onClose` → `sendTo()`/`reply()`/`recv()` → `close()` → `waitClosed()`.
  - Security **tidak** auto-upgrade saat `open()` — switch eksplisit lewat `upgradeSecurity(key, { agent })` (mulai plain dulu, secure kapan pun, mis. setelah handshake).
  - Auto-cleanup default: SIGINT/SIGTERM → `close()` (release port + normalisasi agent) lalu exit(130/143).
  - Tanpa magic number ioctl (0x1001/0x1002) — dibungkus `SMQTNL_IOCTL` + opsi `key`/`binary`.
- **Dampak:** aplikasi networking baru cukup instantiate → event → open → close; tidak perlu urus fd & loop recv manual.

### Dua class NetworkLib disatukan jadi satu source of truth

- **File:** `src/mirror/lib/NetworkLib.ts`, `src/mirror/lib/UserLib.ts`, `src/mirror/lib/Application.ts`
- **Perubahan:** Sebelumnya ada DUA `NetworkLib` (satu OSContext-based di `NetworkLib.ts`, satu `dispatch`-based inline di `UserLib.ts`) — kini SATU class di `NetworkLib.ts` yang menerima `dispatch` ATAU `OSContext`; `UserLib` import + re-export; `toBuffer()` static dipertahankan.
- **Dampak:** menghilangkan ambiguitas API; `lantana-listener.ts` tidak lagi import dua path.

### Custom Security Agent (Jalur A) — kontrak + factory registry

- **File:** `src/common/ISecurityAgent.ts`, `src/common/SecurityAgent.ts`, `src/common/AesGcmAgent.ts`, `src/kernel/devices/SimpleMQTNLDriver.ts`
- **Perubahan:**
  - Kontrak **`ISecurityAgent`** (5 method) — `SecurityAgent` (default "chacha20") mengimplementasikannya.
  - Driver pakai `Map<number, ISecurityAgent>` + **factory registry**: `SimpleMQTNLDriver.registerAgent(name, factory)` / `getAgent(name)` / `listAgents()`.
  - ioctl UPGRADE_SECURITY menerima field `agent` (default "chacha20"); agent tak dikenal → fallback chacha20 (backward-compat).
  - Contoh agent kustom built-in: **`AesGcmAgent`** (AES-256-GCM, format wire sama IV+Tag+Cipher).
- **Dampak:** jenis enkripsi baru tinggal buat class `implements ISecurityAgent` → `registerAgent` → pilih via `upgradeSecurity(key, { agent: "nama" })`.

### Tool `secagent` — daftar agent yang terdaftar di kernel

- **File:** `src/mirror/sbin/secagent.ts`, `src/common/SyscallCode.ts`, `src/kernel/Syscalls.ts`, `src/mirror/lib/NetworkLib.ts`
- **Perubahan:** Syscall baru **`SECAGENT_LIST = 39`**; `SimpleMQTNLDriver.listAgents()`; `lib.net.listAgents()`. Tool `/sbin/secagent` (`secagent` / `--list` / `--json`) menampilkan agent terdaftar.
- **Dampak:** audit jenis enkripsi aktif dari shell.

### Kernel version → `0.2.5.20260831.1`

- **Oleh:** Copilot

---
