# Lantana in a Nutshell (V2)

> **Lantana** adalah IoT stack di atas **MQTNL** di dalam TSIX. Identitas utama
> adalah `accountId` + `deviceId` + `schemeId`; `address:port` hanya alamat
> routing. Lantana mengautentikasi device, memeriksa izin, memvalidasi nilai,
> lalu mendistribusikan data ke consumer dan portable dashboard.

---

## 1. Lantana itu apa?

- **Device** (ESP32/ESP8266) melakukan handshake MQTNL, mengirim bacaan
  `schemeId:value`, dan menerima command.
- **Daemon Lantana** menjalankan listener, autentikasi akun/device, permission
  policy, validasi scheme, DeviceBank, DataBank adapter, dan distributor.
- **Consumer** wajib mendaftar dengan `accountId`; data yang keluar sudah lolos
  autentikasi, otorisasi, dan validasi.
- **Portable dashboard** memakai credential terpisah (PIN 6 digit), bukan
  AccessKey device. Satu dashboard dapat menampilkan banyak device dalam akun
  yang sama dan dibuka oleh beberapa client secara bersamaan.

```text
Device (tsixlib) ──MQTNL (RSA/PSK + ChaCha20)──▶ Broker MQTT ──▶ Lantana daemon
                                                                    │
                                                ┌───────────────────┼───────────────────┐
                                                ▼                   ▼                   ▼
                                          Listener + sesi     DeviceBank          Distributor
                                          account/policy      state + heartbeat   │
                                          scheme validator                        ├─▶ lantana-dashboard
                                          DataBank adapter                        ├─▶ lantana-file-logger
                                                                                  ├─▶ lantana-db-injector
                                                                                  └─▶ lantana-dashboard-server
```

| Layer | Yang melakukan | Contoh |
|---|---|---|
| **Protokol** | `tsixlib` (firmware) + MQTNL | transport, handshake, AEAD |
| **Server stack** | Lantana daemon | auth, policy, validasi, DeviceBank, DataBank, distributor |
| **Konsumen data** | Aplikasi userland | dashboard, logger, DB injector, portable dashboard |

---

## 2. Model identitas

| Nilai | Peran |
|---|---|
| `accountId` | Identitas akun dan dasar pemeriksaan hak akses. |
| `deviceId` | Identitas logis device untuk registry dan konfigurasi sensor. |
| `schemeId` | Identitas skema data (tipe, unit, rentang). |
| MQTNL `address + port` | Endpoint routing dan command balasan; **bukan** identitas. |

- `deviceId` diterbitkan saat device didaftarkan. Harus unik, stabil, dan tidak
  dianggap rahasia (UUID adalah pilihan implementasi).
- Device terdaftar sebagai pasangan `accountId + deviceId`; metadata nama,
  kota, kategori, dan grup dikelola di registry.
- `schemeId` unik global dan dimiliki satu akun (`ownerAccountId`). Akun lain
  hanya bisa memakai scheme jika diberi izin eksplisit.
- Izin `inject`/`query`/`command` bersifat eksplisit; **tidak ada inheritance**
  dari parent ke child.
- **Satu AccessKey per akun**, boleh dipakai banyak device. AccessKey adalah
  kredensial autentikasi, **bukan session key enkripsi**. Rotasi/cabut per akun.
- Consumer wajib mendaftar dengan `accountId`; filter tampilan bukan pengganti
  otorisasi.

---

## 3. Keamanan MQTNL

Device memilih mode handshake di `LANTANA_HELLO`:

| Mode | Device | Mekanisme |
|---|---|---|
| `rsa` | ESP32 | Fingerprint public key server di-pin → session key acak dibungkus RSA-OAEP → `AUTH` terenkripsi |
| `psk` | ESP8266 | `psk = SHA-256(AccessKey)`; server & device saling membuktikan lewat HMAC atas nonce; session key = HKDF-SHA256(psk, salt=`nonceC\|nonceS`) |

- AccessKey **tidak pernah dikirim plaintext** dan tidak ditulis ke log.
- Tidak ada fallback plaintext: handshake/auth/dekripsi gagal → paket ditolak.
- `lantana-ctl server fingerprint` dipakai untuk mengisi fingerprint di
  `secrets.h` (mode RSA).
- AccessKey lama yang belum punya `psk` harus dirotasi sebelum dipakai ESP8266.
- Jalur admin (CLI/Control Panel) terpisah dari jalur data device.

### Portable dashboard

Dashboard portable memakai credential sendiri, bukan AccessKey akun:

- PIN **6 digit angka**, unik global, dicetak sekali saat diterbitkan/dirotasi.
- `/etc/lantana/dashboard.json` hanya menyimpan `SHA-256(PIN)`.
- Handshake dashboard murni PSK (tanpa RSA dan tanpa `dashboardId` di client):
  `keyTag` + nonce → `serverProof` → `clientProof` → HKDF → ChaCha20-Poly1305.
- Server default MQTNL dashboard: **port 1515**. Auth gagal dibatasi
  5 percobaan/menit per alamat sumber.

---

## 4. Arsitektur internal

Library di `src/mirror/lib/lantana/`, daemon/aplikasi di
`src/mirror/opt/lantana/`.

| Komponen | File | Tugas |
|---|---|---|
| Core | `lantana-core.ts` | Tipe, konstanta, event, parser/encoder payload V2 |
| Config | `lantana-config.ts` | Loader `/etc/lantana/config.json` (tanpa kredensial) |
| Accounts | `account-manager.ts` | Akun parent-child, AccessKey (verifier scrypt) |
| Dashboards | `dashboard-registry.ts` | Portable dashboard + verifier PIN |
| Devices | `device-registry.ts` | `deviceId`, ikatan akun+device, metadata |
| Schemes | `scheme-registry.ts` | Definisi scheme + validasi tipe/rentang |
| Policy | `permission-policy.ts` | Inject/query/command |
| Sessions | `session-manager.ts` | State sesi MQTNL (nonce, binding akun/device) |
| Ingest | `lantana-ingest.ts` | Pipeline auth → policy → validate |
| Listener | `lantana-listener.ts` | Handshake, dekripsi, ingest, command |
| DeviceBank | `lantana-device-bank.ts` | State terkini, heartbeat, endpoint balik |
| DataBank | `lantana-databank.ts` | Sink + antrean berbatas (idempoten) |
| Distributor | `lantana-distributor.ts` | Event ke consumer + otorisasi command |
| Daemon | `opt/lantana/lantana.ts` | Wiring lifecycle |
| CLI | `opt/lantana/lantana-ctl.ts` | Manajemen akun, device, scheme, key, dashboard |
| Control Panel | `opt/lantana/lantana-control-panel.ts` | GUI admin (lewat `lantana-ctl --json`) |
| Dashboard server | `opt/lantana/lantana-dashboard-server.ts` | Consumer MQTNL dashboard portable (default 1515) |
| Consumers | `opt/lantana/lantana-dashboard.ts`, `lantana-file-logger.ts`, `lantana-db-injector.ts` | GUI, log file, DB |

### Config & state

| Path | Isi |
|---|---|
| `/etc/lantana/config.json` | Port layanan + `deviceCategories`; **tanpa kredensial** |
| `/etc/lantana/accounts.json` | Akun, relasi parent, izin, verifier scrypt |
| `/etc/lantana/devices.json` | Ikatan `accountId + deviceId` + metadata |
| `/etc/lantana/schemes.json` | Definisi scheme |
| `/etc/lantana/dashboard.json` | Portable dashboard + `accessKeyHash` (SHA-256 PIN) |
| `/etc/lantana/keys/server-key.json` | Key pair server untuk handshake RSA |

File state dibuat otomatis (isi `[]`) saat pertama dipakai dan **tidak**
disertakan di mirror, supaya `vfs:bootstrap` tidak menimpa state runtime.

Tabel DataBank yang diharapkan contoh `lantana-db-injector`:

```sql
CREATE TABLE IF NOT EXISTS sensor_readings (
    reading_id  VARCHAR(36) PRIMARY KEY,
    account_id  VARCHAR(64) NOT NULL,
    device_id   VARCHAR(64) NOT NULL,
    scheme_id   INT NOT NULL,
    label       VARCHAR(128) NOT NULL,
    unit        VARCHAR(32) NOT NULL,
    value       VARCHAR(64) NOT NULL,
    received_at DATETIME NOT NULL,
    INDEX idx_account_device_time (account_id, device_id, received_at)
);
```

`reading_id` sebagai PRIMARY KEY membuat retry idempoten.

---

## 5. Menjalankan & alur kerja

```sh
# Daemon
lantana                 # start (pidfile)
lantana --fg            # foreground debug
lantana --stop          # stop via pidfile

# 1) Akun + kredensial
lantana-ctl account create-root juragan
lantana-ctl account create-child juragan anak
lantana-ctl account key-issue juragan        # AccessKey dicetak sekali
lantana-ctl account permissions juragan --inject 101,102 --query 101

# 2) Scheme + device
lantana-ctl scheme add juragan 101 --label Suhu --unit C --min -40 --max 125
lantana-ctl scheme add juragan 102 --label Kelembapan --unit % --min 0 --max 100
lantana-ctl device add juragan --name "Sensor Bandung" --city Bandung --group jabar
lantana-ctl server fingerprint   # untuk TSIX_LANTANA_FINGERPRINT di secrets.h

# 3) Consumer
lantana-dashboard                        # auto-detect daemon, semua akun
lantana-dashboard <target> juragan       # filter akun
lantana-file-logger juragan
lantana-db-injector juragan --db 192.168.1.50 root pass antigonon_iot
lantana-dashboard-server                 # portable dashboard, port 1515
lantana-cmd juragan <deviceId> "RELAY_1:1"
```

`lantana-ctl --json` mengembalikan envelope versi 1
(`{ version, ok, data }` / `{ version, ok, error }`) dan dipakai GUI.
AccessKey/PIN mentah hanya tampil sekali saat diterbitkan/dirotasi.

---

## 6. Firmware V2 (`tsixlib`)

Contoh variant: `platformio/TSIX-All-in-One/src/variants/lantana.cpp`
(env `lantana-esp32` / `lantana-esp8266`). Identitas diisi di
`include/secrets.h`:

```cpp
#define TSIX_ACCOUNT_ID   "juragan"
#define TSIX_DEVICE_ID    "<deviceId dari lantana-ctl device add>"
#define TSIX_ACCESS_KEY   "<AccessKey dari lantana-ctl account key-issue>"
#define TSIX_LANTANA_FINGERPRINT "<16 hex huruf besar>"   // mode RSA
```

Firmware memakai `tsixlib` + `lantana_auth`; mode handshake dipilih otomatis
dari board (ESP32 → `rsa`, ESP8266 → `psk`).

Variant contoh mengirim status scheme boolean relay (105/106 secara default)
saat sesi online dan langsung setelah command relay diterima. Status relay
dikirim terpisah dari payload sensor periodik agar perubahan switch tidak
menunggu interval sensor. Sesuaikan macro scheme bila ID tersebut sudah dipakai.

### Payload teks V2

```text
LANTANA|<deviceId>|<schemeId>:<value>;<schemeId>:<value>;...
```

Contoh:

```cpp
char payload[128];
snprintf(payload, sizeof(payload),
         "LANTANA|%s|101:%.2f;102:%.2f",
         TSIX_DEVICE_ID, suhu, kelembapan);
tsix.sendEncrypted(LANTANA_HOST, LANTANA_PORT, payload);
```

### Frame biner V2

```text
[0x4C][0x02][devLen:1][deviceId][count:1]
per bacaan: [schemeId:u16 LE][type:1][value]
  type 0x00 → float32 LE
  type 0x01 → bool (1 byte)
  type 0x02 → len:u8 + utf8
```

Magic `0x4C`, versi frame `0x02`. Tidak ada fallback ke format V1.

> V1 (`sensorIdMap`, `LANTANA|<nodeId>|01:25;...` dengan ID sensor, dan
> `deviceGroupMap` flat) sudah dihapus. Gunakan `deviceId` + `schemeId`.

---

## 7. Consumer & event contract

Consumer mendaftar dengan `accountId`; distributor hanya mengirim data akun
tersebut. Event utama:

| Event | Arah | Arti |
|---|---|---|
| `LANTANA_REGISTER` / `LANTANA_UNREGISTER` | consumer → daemon | Daftar/keluar (wajib `accountId`) |
| `LANTANA_SUBSCRIBE` / `LANTANA_UNSUBSCRIBE` | consumer → daemon | Tambah/lepas subscription akun; dipakai dashboard-server multi-akun |
| `LANTANA_SNAPSHOT` → `LANTANA_SNAPSHOT_REPLY` | consumer ↔ daemon | Minta state terkini |
| `LANTANA_READING` | distributor → consumer | Bacaan tervalidasi per device |
| `LANTANA_DEVICE_STATUS` | distributor → consumer | Status heartbeat semua device |
| `LANTANA_COMMAND` / `LANTANA_COMMAND_RESULT` | consumer ↔ daemon | Command dua arah + hasil |
| `LANTANA_RELOAD` | CLI/admin → daemon | Muat ulang state akun/device/scheme |
| `LANTANA_DASH_SWITCH_STATUS` | dashboard-server → Android | Status switch terenkripsi saat bacaan boolean baru diterima |

Payload event switch pada sesi dashboard terenkripsi:

```json
{
  "type": "LANTANA_DASH_SWITCH_STATUS",
  "dashboardId": "1000",
  "updates": [
    { "itemId": "lampu", "itemIndex": 0, "value": false, "updatedAt": 1756800000000 }
  ],
  "timestamp": 1756800000000
}
```

Contoh `LANTANA_READING`:

```json
{
  "type": "LANTANA_READING",
  "accountId": "juragan",
  "deviceId": "0e8ab4d8-f242-4f26-af35-a9a56cd3cced",
  "name": "Sensor Bandung",
  "category": "esp",
  "group": "jabar",
  "city": "Bandung",
  "receivedAt": 1756800000000,
  "dataAgeMs": 120,
  "deviceStatus": "ONLINE",
  "readings": [
    { "schemeId": 101, "value": 27.5, "label": "Suhu", "unit": "C", "ts": 1756800000000 },
    { "schemeId": 102, "value": 60, "label": "Kelembapan", "unit": "%", "ts": 1756800000000 }
  ]
}
```

- **`lantana-file-logger`** menulis ke
  `/var/log/lantana/<accountId>/<deviceId>/<YYYY-MM-DD>.log`.
- **`lantana-db-injector`** INSERT ke `sensor_readings`; tanpa `--db` berjalan
  mode kering (cetak ke terminal).
- **`lantana-dashboard`** menampilkan device + kartu sensor + status heartbeat.

---

## 8. Portable dashboard (PIN 6 digit)

```sh
lantana-ctl dashboard key-issue juragan --id 1000 --title "Sensor Rumah"
lantana-ctl dashboard show juragan
lantana-ctl dashboard key-rotate juragan 1000
lantana-ctl dashboard key-revoke juragan 1000
lantana-dashboard-server          # default port 1515
```

- `--id` menentukan `dashboardId` manual (integer positif, unik); tanpa `--id`
  registry memilih ID acak. `dashboardId` masih dipakai internal (registry,
  item, rotasi/cabut), tetapi **tidak diperlukan client**.
- PIN 6 digit ditampilkan sekali untuk disampaikan ke pengguna dashboard.
- Client dashboard cukup menyimpan `SHA-256(PIN)`. Handshake (tanpa
  `dashboardId`/RSA):
  1. `HELLO { mode:"psk", keyTag, clientNonce }` — `keyTag` = 16 hex pertama
     `SHA-256(PIN)`.
  2. `CHALLENGE { serverNonce, serverProof }` — client memverifikasi proof.
  3. `AUTH { proof }` — server memverifikasi proof client.
  4. `AUTH_OK`; kedua sisi menurunkan session key
     `HKDF-SHA256(psk, salt=nonceC|nonceS)` → ChaCha20-Poly1305.
- Di Android: isi alamat broker MQTT, alamat server dashboard, dan PIN. Port
  dashboard **tetap 1515** (tidak diinput).
- Satu dashboard dapat berisi item dari beberapa device pada akun pemiliknya;
  beberapa sesi Android dapat terhubung ke dashboard yang sama.
- `type` item: `text`, `radialGauge`, `lineChart`, `switchIndicator`, `switch`.
  Card `switch` memerlukan prefix command (mis. `RELAY_1`) dan scheme boolean
  opsional. Android mengirim `RELAY_1:1` atau `RELAY_1:0`; status aktual datang
  melalui event `LANTANA_DASH_SWITCH_STATUS`, bukan dari ACK command.
- Snapshot dipakai untuk sinkronisasi awal dan setelah koneksi pulih. Interval
  hanya mengatur pembaruan item sensor; perubahan status switch didorong sebagai
  event langsung ke seluruh sesi dashboard yang cocok.
  `scrollAfter` = jumlah sampel chart (default 7, sementara selama app hidup).
- Dashboard/Control Panel tersedia dari menu **IoT** Asteracea.

---

## 9. Heartbeat

DeviceBank menghitung status dari umur data terakhir (`lastDataAt`):

| Kondisi | Status |
|---|---|
| `dataAgeMs <= 15s` | `ONLINE` |
| `<= 60s` | `STALE` |
| `> 60s` | `OFFLINE` |

---

## 10. Pemisahan protokol vs produk

- **`tsixlib` + MQTNL** = protokol/transport netral; bisa dipakai listener lain.
- **Lantana V2** = implementasi server di atas protokol tersebut, dengan
  account/device/scheme, policy, validasi, dan consumer.

Yang **dibuang** dari V1 (tanpa lapisan kompatibilitas):

- `ports.<port>.tenant` + `apiKeyHex` sebagai identitas dan key tenant per port.
- `mode: "auto" | "binary" | "plain"` dan fallback plaintext otomatis.
- Format legacy `sensorId:value;...` tanpa `deviceId`, `sensorIdMap`, dan
  `deviceGroupMap` flat.
- Filter tenant pada registrasi consumer sebagai pengganti otorisasi.
- Default config yang menanam API key di repo.

Artinya: device dan consumer V1 harus menyesuaikan diri ke kontrak V2.
