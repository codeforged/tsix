# TSIX-All-in-One (PlatformIO)

Satu proyek PlatformIO berisi **4 varian `main.cpp`** yang bisa di-build untuk
**ESP8266** dan **ESP32**, semuanya memakai library terpadu **`tsixlib`**
(berada di `lib/tsixlib/`).

```
src/
  main.cpp            ← dispatcher: pilih varian via build flag
  variants/
    minimum.cpp       ← mqtnl minimum-sender
    minimum-binfeo.cpp← mqtnl minimum-binfeo-sender (biner tersandi v1.2)
    lantana.cpp       ← mqtnl lantana-sender (relay + data sensor Lantana)
    ota.cpp           ← ota-mqtnl (binary OTA + flash)
lib/
  tsixlib/            ← library MQTNL terpadu (tsixlib.h/.cpp)
```

## Kredensial (secrets.h)

Semua kredensial (WiFi SSID/password, MQTT server/port, API key tenant) ada di
`include/secrets.h` — file ini **TIDAK ikut di-commit** (di-gitignore). Buat dari
template lalu isi:

```sh
cp include/secrets.sample.h include/secrets.h
```

Semua varian otomatis memakainya via `#include "secrets.h"` (`TSIX_WIFI_SSID`,
`TSIX_MQTT_SERVER`, `TSIX_API_KEY`, dst).

> ⚠️ Jangan pernah commit `include/secrets.h` (isinya kredensial asli).
> `secrets.sample.h` yang berisi placeholder itulah yang boleh di-commit.

## Varian & env

| Varian                      | build flag                   | env (ESP32)            | env (ESP8266)            |
| --------------------------- | ---------------------------- | ---------------------- | ------------------------ |
| mqtnl minimum-sender        | `APP_VARIANT_MINIMUM`        | `minimum-esp32`        | `minimum-esp8266`        |
| mqtnl minimum-binfeo-sender | `APP_VARIANT_MINIMUM_BINFEO` | `minimum-binfeo-esp32` | `minimum-binfeo-esp8266` |
| mqtnl lantana-sender        | `APP_VARIANT_LANTANA`        | `lantana-esp32`        | `lantana-esp8266`        |
| ota-mqtnl                   | `APP_VARIANT_OTA`            | `ota-esp32`            | `ota-esp8266`            |

## Build / upload

```sh
pio run -e minimum-esp32          # build saja
pio run -e minimum-binfeo-esp32   # varian Binfeo (biner tersandi)
pio run -e lantana-esp8266 -t upload
pio run -e ota-esp32 -t upload -t monitor
```

## `tsixlib` — kanal yang didukung

| Metode            | Topic             | Protocol                        | Enkripsi                           |
| ----------------- | ----------------- | ------------------------------- | ---------------------------------- |
| `sendEncrypted()` | `mqtnl@1.0/<dst>` | JSON (magic `0x5B`)             | ChaCha20-Poly1305 (hex)            |
| `sendBinfeo()`    | `mqtnl@1.2/<dst>` | **Binfeo** biner (magic `0x66`) | ChaCha20-Poly1305 (raw, byte utuh) |
| `sendRaw()`       | `mqtnl@1.1/<dst>` | biner OTA (magic `0x42`)        | plain (untuk OTA cepat)            |

Callback: `onEncryptedMessage(src, port, char*)`, `onBinfeoMessage(src, port, uint8_t*, len)`,
`onRawMessage(src, port, uint8_t*, len)`. Auto-respond PING & BROADCAST_SCAN.

Contoh pemakaian Binfeo (di salah satu varian atau app baru):

```cpp
TSIX tsix("esp-binfeo-01", 100, apiKey, MQTT_SERVER, MQTT_PORT);

void onBinfeo(const char *src, int srcPort, const uint8_t *data, size_t len) {
  // data = plaintext hasil dekripsi (byte mentah, tidak rusak utk byte >= 0x80)
  Serial.printf("[binfeo] %s:%d len=%u\n", src, srcPort, len);
}

// setup:
tsix.begin();
tsix.onBinfeoMessage(onBinfeo);

// kirim byte biner terenkripsi:
uint8_t buf[] = {0xde, 0xad, 0xbe, 0xef, 0x00, 0x80, 0xff};
tsix.sendBinfeo("tsix", 2700, buf, sizeof(buf));
```

> Catatan OTA: `ota-mqtnl` memakai kanal biner v1.1 (plain) sesuai desain OTA TSIX
> (transfer cepat, tidak menambah overhead enkripsi). Untuk komunikasi biner
> **normal yang terenkripsi**, pakai `sendBinfeo()` (v1.2).

## Catatan

- `tsixlib` menggantikan `noslib` + `TSIXSocket` dari proyek-proyek lama
  (`ESP32-MQTNL-Sender-minimum`, `ESP32-MQTNL-SensorData-Sender`, `ESP-OTA-MQTNL`).
- Ganti semua `#define` konfigurasi (SSID, MQTT, NODE_ID, key, dst, OTA) di
  varian masing-masing sebelum upload.
- Pastikan server TSIX + broker MQTT sudah jalan dan node tujuan sudah
  ter-registrasi.
