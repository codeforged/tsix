# Lantana in a Nutshell

> **Lantana** adalah stack IoT di atas **MQTNL** — satu daemon yang menerima data dari
> banyak device (multi-device, multi-tenant), menormalkannya, lalu membagikannya ke
> consumer (dashboard, database, file log) — lengkap dengan autentikasi via **apiKey**.

---

## 1. Lantana itu apa?

Lantana adalah **server-side IoT stack** di dalam TSIX. Sederhananya:

- **Device** (ESP8266/ESP32) mengirim data sensor lewat protokol MQTNL (topic `mqtnl@1.0/...`)
  menggunakan library `noslib` — data dienkripsi ChaCha20 dengan **apiKey tenant**.
- **Lantana daemon** mendengarkan di port tertentu, menerima, memvalidasi (apiKey),
  menormalkan, lalu menyiarkan data ke **consumer** yang terdaftar.
- **Consumer** adalah aplikasi userland yang bisa dipilih: dashboard GUI, injector ke
  database MySQL, atau file logger ke `/var/log/lantana/`.

```
device (noslib) ──MQTNL+ChaCha20──▶ Broker MQTT ──▶ Lantana daemon
                                                      │  (listener + device bank + distributor)
                                                      ├─▶ lantana-dashboard   (GUI)
                                                      ├─▶ lantana-db-injector (MySQL)
                                                      └─▶ lantana-file-logger (file log)
```

Pemisahan penting:

| Layer | Yang melakukan | Contoh |
|---|---|---|
| **Protokol** | `noslib` (firmware) + MQTNL | transport, topic, enkripsi ChaCha20 |
| **Server stack** | Lantana daemon | listener, device bank, distributor |
| **Konsumen data** | Aplikasi userland | dashboard, db-injector, file-logger |

---

## 2. Arsitektur internal

Lantana daemon (`src/mirror/opt/lantana/lantana.ts`) menjalankan 3 layer
(separation of concern, beda file):

| Layer | File | Tugas |
|---|---|---|
| **1. Listener** | `lantana-listener.ts` | Bind port dari config, upgrade security (`ioctl 0x1001`), auto-detect format biner/plaintext, parse payload |
| **2. Device Bank** | `lantana-device-bank.ts` | Registry multi-device + sensor, kategori statis, heartbeat (`ONLINE`/`STALE`/`OFFLINE`) |
| **3. Distributor** | `lantana-distributor.ts` | Normalisasi + enrich (tenant, kategori, label, dataAgeMs, status) → broadcast ke consumer |

**Shared core** ada di `lantana-core.ts`: tipe data, konstanta, parsing payload, dan
loader config `/etc/lantana/config.json`.

### Consumer yang tersedia

| Consumer | File | Kegunaan |
|---|---|---|
| `lantana-dashboard` | `lantana-dashboard.ts` | GUI multi-device + kartu sensor + filter tenant + grouping `deviceGroupMap` |
| `lantana-db-injector` | `lantana-db-injector.ts` | Subscribe data → INSERT ke MySQL (`sensor_data`) |
| `lantana-file-logger` | `lantana-file-logger.ts` | Subscribe data → tulis history ke `/var/log/lantana/<tenant>/<tanggal>.log` |

---

## 3. Config — `/etc/lantana/config.json`

```jsonc
{
  "ports": {
    "1000": {
      "tenant": "default",
      "apiKeyHex": "81ff71ed574e54597690ae7b04e4ef5fc87497fe10b6b037cb031af7c7d67619",
      "enabled": true,
      "mode": "auto"
    },
    "1001": {
      "tenant": "Juragan Sensor",
      "apiKeyHex": "81ff71ed574e54597690ae7b04e4ef5fc87497fe10b6b037cb031af7c7d67619",
      "enabled": true,
      "mode": "auto"
    }
  },
  "deviceCategories": {
    "esp32":   { "label": "ESP32", "icon": "🔧", "description": "ESP32 fisik via MQTNL" },
    "simulator": { "label": "Simulator", "icon": "💻", "description": "Node simulasi" },
    "generic": { "label": "Generic Device", "icon": "📡" }
  },
  "sensorCategories": {
    "temp":  { "label": "Temperature", "unit": "°C", "icon": "🌡️", "min": -40, "max": 125 },
    "hum":   { "label": "Humidity", "unit": "%", "icon": "💧", "min": 0, "max": 100 },
    "pres":  { "label": "Pressure", "unit": "hPa", "icon": "🌀", "min": 800, "max": 1100 },
    "light": { "label": "Light", "unit": "lx", "icon": "☀️", "min": 0, "max": 100 },
    "generic": { "label": "Sensor", "unit": "", "icon": "📊" }
  },
  "sensorIdMap": { "01": "temp", "02": "hum", "03": "pres", "04": "light" },
  "deviceGroupMap": {
    "Juragan Sensor": {
      "esp8266-dev-01": "client-a",
      "esp8266-dev-02": "client-a",
      "esp8266-dev-03": "client-b"
    }
  }
}
```

### Penjelasan field

| Field | Arti |
|---|---|
| `ports.<port>.tenant` | Nama tenant yang dilayani port ini |
| `ports.<port>.apiKeyHex` | **API key tenant** (hex 64 char) = kredensial akses + kunci enkripsi ChaCha20. Diterbitkan portal Lantana saat tenant mendaftar, lalu ditanam ke firmware |
| `ports.<port>.mode` | `"auto"` (default), `"binary"`, atau `"plain"` |
| `deviceCategories` | Label/icon untuk kategori device (`esp32`, `simulator`, `generic`) |
| `sensorCategories` | Label/unit/icon + rentang normal per kategori sensor |
| `sensorIdMap` | Petakan id sensor (`01`) → kategori (`temp`) |
| `deviceGroupMap` | Pengelompokan device per tenant: `{ tenant: { nodeId: group } }` — nodeId sama di tenant beda tidak bentrok |

> **Multi-tenant, nodeId boleh sama.** Device Bank memakai key `tenant::nodeId`,
> jadi dua tenant dengan `apiKeyHex` berbeda boleh memakai `nodeId` yang identik
> tanpa konflik — entri, sensor, grup, dan command terpisah per tenant. Firmware
> `noslib` tidak perlu tahu soal ini: cukup `apiKey` yang benar untuk tenant-nya.

> **apiKey = kredensial + enkripsi.** ChaCha20-Poly1305 bersifat *authenticated
> encryption* — hanya device yang memegang apiKey tenant yang bisa terdekripsi & diterima.
> Server `SecurityAgent` memakai `Buffer.from(apiKeyHex, "hex")`, firmware `noslib`
> memakai `hexToBytes()` — dua sisi memakai hex string yang sama.

---

## 4. Menjalankan

```sh
# Start daemon (foreground)
lantana

# Start daemon foreground debug
lantana --fg

# Stop via pidfile
lantana --stop
```

Consumer dijalankan manual:

```sh
# Dashboard (auto-detect daemon via UUID)
lantana-dashboard

# Dashboard dengan filter tenant
lantana-dashboard <lantanaPid|uuid> "Juragan Sensor"

# File logger — tulis ke /var/log/lantana/
lantana-file-logger <lantanaPid|uuid> "Juragan Sensor"

# DB injector — INSERT ke MySQL (mysqld harus jalan)
lantana-db-injector <lantanaPid|uuid> --db 192.168.1.50 root pass antigonon_iot
```

---

## 5. Contoh firmware (ESP8266/ESP32 + `noslib`)

### 5a. Plaintext payload (`LANTANA|<nodeId>|<id:val;...>`)

Ini contoh lengkap ala `ESP32-MQTNL-SensorData-Sender`. Tenant hanya perlu:
1. Daftar di portal Lantana → dapat `apiKey` (hex string)
2. Salin ke `char apiKey[]`, set `NODE_ID`, host, port
3. Kirim payload `LANTANA|<nodeId>|<sensorId:value;...>`

```cpp
#include <Arduino.h>
#include <noslib.h>

// ── WiFi / MQTT ──
#define WIFI_SSID "BabamGo"
#define WIFI_PASSWORD "bismillah"
#define MQTT_SERVER "192.168.1.204"
#define MQTT_PORT 1883

// ── Identitas device & tujuan Lantana ──
#define NODE_ID "esp8266-dev-01"     // ID di Device Bank Lantana
#define LANTANA_HOST "wintsix"        // node TSIX tempat daemon Lantana
#define LANTANA_PORT 1001             // port tenant di config

// API key tenant (string hex) = kredensial + kunci ChaCha20 dari portal
char apiKey[] = "81ff71ed574e54597690ae7b04e4ef5fc87497fe10b6b037cb031af7c7d67619";

NOS nos(NODE_ID, 100, apiKey, MQTT_SERVER, MQTT_PORT);

const char *sensorIds[] = {"01", "02", "03", "04"};
int sensorVals[4] = {0, 0, 0, 0};
const int sensorCount = 4;
uint32_t lastSent = 0;

void setup() {
  Serial.begin(115200);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) delay(500);

  nos.begin();
  Serial.println("System ready!");
}

void loop() {
  nos.loop();
  if (millis() - lastSent >= 5000) {
    for (int i = 0; i < sensorCount; i++) {
      int delta = random(-10, 11);
      sensorVals[i] = constrain(sensorVals[i] + delta, 1, 100);
    }

    // Payload protokol Lantana (plaintext ber-nodeId):
    //   LANTANA|<nodeId>|<sensorId:value;sensorId:value;...>
    char data[128];
    sprintf(data, "LANTANA|%s|%s:%d;%s:%d;%s:%d;%s:%d",
            NODE_ID,
            sensorIds[0], sensorVals[0],
            sensorIds[1], sensorVals[1],
            sensorIds[2], sensorVals[2],
            sensorIds[3], sensorVals[3]);

    nos.sendPacket(LANTANA_HOST, LANTANA_PORT, data);
    Serial.println(data);
    lastSent = millis();
  }
}
```

### 5b. Biner payload (frame sensor Lantana `0x4C 0x01`)

Lebih hemat bandwidth — strukturnya:

```
[0x4C][0x01][nodeLen:1][nodeId...][cnt:1]
per sensor: [sidLen:1][sid...][value:4 float32 LE]
```

Contoh builder di firmware:

```cpp
// Frame: 0x4C 0x01 <nodeLen> <nodeId> <cnt> (sidLen sid val32)*
void sendBinaryFrame(const char *nodeId, const char **ids, float *vals, int cnt) {
  uint8_t frame[128];
  int off = 0;
  frame[off++] = 0x4C;
  frame[off++] = 0x01;
  uint8_t nl = strlen(nodeId);
  frame[off++] = nl;
  memcpy(frame + off, nodeId, nl); off += nl;
  frame[off++] = cnt;
  for (int i = 0; i < cnt; i++) {
    uint8_t sl = strlen(ids[i]);
    frame[off++] = sl;
    memcpy(frame + off, ids[i], sl); off += sl;
    memcpy(frame + off, &vals[i], 4); off += 4; // float32 LE
  }
  nos.sendPacket(LANTANA_HOST, LANTANA_PORT, (char*)frame);
}
```

Lantana listener **auto-detect** format (biner vs plaintext) lewat byte magic, jadi
keduanya bisa dicampur tanpa ubah config.

---

## 6. Consumer: injeksi ke DB & log file

Distributor menyiarkan data ternormalisasi (`NormalizedSensorData`) ke semua consumer
yang sudah `LANTANA_REGISTER`. Bentuk event:

```ts
{
  type: "LANTANA_SENSOR_DATA",
  tenant: "Juragan Sensor",
  nodeId: "esp8266-dev-01",
  nodeCategory: "esp32",
  nodeLabel: "ESP32",
  group: "client-a",            // dari deviceGroupMap
  format: "plain",
  receivedAt: 1756800000000,
  dataAgeMs: 120,
  deviceStatus: "ONLINE",       // ONLINE / STALE / OFFLINE
  sensors: [
    { id: "01", value: 25, category: "temp",  label: "Temperature", unit: "°C", ts: 1756800000000 },
    { id: "02", value: 60, category: "hum",   label: "Humidity", unit: "%",  ts: 1756800000000 },
    // ...
  ],
  meta: { port: 1001, count: 4, source: "mqtnl" }
}
```

### 6a. `lantana-file-logger` → file log

Menulis ke `/var/log/lantana/<tenant>/<YYYY-MM-DD>.log`. Contoh isi file:

```
[2026-09-01 07:15:00] tenant=Juragan Sensor node=esp8266-dev-01 sensor=01(temp) value=25 °C
[2026-09-01 07:15:00] tenant=Juragan Sensor node=esp8266-dev-01 sensor=02(hum) value=60 %
```

Jalankan:

```sh
lantana-file-logger <lantanaPid|uuid> "Juragan Sensor"
```

### 6b. `lantana-db-injector` → MySQL

Menyisipkan ke tabel `sensor_data` (satu baris per sensor). Contoh SQL yang dihasilkan
(dari kode):

```sql
INSERT INTO sensor_data (tenant, node_id, sensor_id, sensor_category, value, timestamp)
VALUES ('Juragan Sensor', 'esp8266-dev-01', '01', 'temp', 25, '2026-09-01 07:15:00');
```

Jalankan:

```sh
lantana-db-injector <lantanaPid|uuid> --db 192.168.1.50 root pass antigonon_iot
```

Tanpa `--db`, consumer berjalan **mode kering** (hanya mencetak data ke terminal) —
berguna untuk cek koneksi tanpa harus menyentuh DB.

---

## 7. Alur untuk user/tenant (pembuat firmware)

```
1. Daftar di portal Lantana            → dapat apiKeyHex (hex string)
2. Salin apiKey ke main.cpp            → char apiKey[] = "..."
3. Set NODE_ID, host, port tujuan      → sesuai tenant
4. Kirim payload LANTANA|<nodeId>|...  → atau biner 0x4C
5. Nyalakan daemon lantana             → lantana
6. Jalankan consumer yang diinginkan   → dashboard / db-injector / file-logger
```

Yang perlu diurus device: **cuma firmware** (noslib + payload). Server, validasi apiKey,
device bank, dashboard, DB, dan log — **semua sudah jalan di Lantana**.

---

## 8. Ringkasan API/event

| Event | Arah | Arti |
|---|---|---|
| `LANTANA_REGISTER` / `LANTANA_UNREGISTER` | consumer → daemon | Daftar/keluar sebagai consumer (filter tenant opsional) |
| `LANTANA_SNAPSHOT` | consumer → daemon | Minta data terkini (balasan `LANTANA_SNAPSHOT_REPLY`) |
| `LANTANA_RAW_DATA` | listener → distributor | Data mentah dari device (internal) |
| `LANTANA_SENSOR_DATA` | distributor → consumer | Data sensor ternormalisasi |
| `LANTANA_DEVICE_STATUS` | distributor → consumer | Status heartbeat semua device |
| `LANTANA_COMMAND` | consumer → distributor | Kirim perintah ke device (dua arah, mis. relay) |

---

## 9. Status heartbeat

Device Bank menghitung status dari umur data terakhir (`lastDataAt`):

| Kondisi | Status |
|---|---|
| `dataAgeMs <= 15s` | `ONLINE` |
| `<= 60s` | `STALE` |
| `> 60s` | `OFFLINE` |

---

## 10. Pemisahan protokol vs produk

- **`noslib` + MQTNL** = protokol/transport yang **netral** (tidak bergantung Lantana).
  Bisa dipakai dengan listener custom sendiri.
- **Lantana** = salah satu implementasi server di atas protokol tersebut.

Artinya: user yang "hanya bikin firmware & hardware" cukup pakai `noslib` + ikut format
payload Lantana — server & dashboard sudah jadi.
