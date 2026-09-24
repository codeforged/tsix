# TSIX-All-in-One (PlatformIO)

A unified PlatformIO project containing **4 `main.cpp` variants** compatible with both **ESP8266** and **ESP32**. All variants share the centralized **`tsixlib`** library located in `lib/tsixlib/`.

```
src/
  main.cpp            ← dispatcher: selects variant via build flags
  variants/
    minimum.cpp       ← mqtnl minimum-sender
    minimum-binfeo.cpp← mqtnl minimum-binfeo-sender (encrypted binary v1.2)
    lantana.cpp       ← mqtnl lantana-sender (relay + Lantana sensor data)
    ota.cpp           ← ota-mqtnl (binary OTA + flashing)
lib/
  tsixlib/            ← unified MQTNL library (tsixlib.h/.cpp)
```

## Credentials (secrets.h)

All credentials (WiFi SSID/password, MQTT server/port, tenant API keys) are stored in `include/secrets.h`. This file is **NOT committed** to version control (ignored via `.gitignore`). Create it from the template and fill in your details:

```sh
cp include/secrets.sample.h include/secrets.h
```

All variants automatically import these settings via `#include "secrets.h"` (`TSIX_WIFI_SSID`, `TSIX_MQTT_SERVER`, `TSIX_API_KEY`, etc.).

> ⚠️ Never commit `include/secrets.h` as it contains sensitive real credentials. Only commit `secrets.sample.h` with placeholder values.

## Variants & Environments

| Variant                    | Build Flag                   | Env (ESP32)            | Env (ESP8266)            |
| -------------------------- | ---------------------------- | ---------------------- | ------------------------ |
| mqtnl minimum-sender       | `APP_VARIANT_MINIMUM`        | `minimum-esp32`        | `minimum-esp8266`        |
| mqtnl minimum-binfeo-sender| `APP_VARIANT_MINIMUM_BINFEO` | `minimum-binfeo-esp32` | `minimum-binfeo-esp8266` |
| mqtnl lantana-sender       | `APP_VARIANT_LANTANA`        | `lantana-esp32`        | `lantana-esp8266`        |
| ota-mqtnl                  | `APP_VARIANT_OTA`            | `ota-esp32`            | `ota-esp8266`            |

## Build & Upload

```sh
pio run -e minimum-esp32          # Build only
pio run -e minimum-binfeo-esp32   # Binfeo variant (encrypted binary)
pio run -e lantana-esp8266 -t upload
pio run -e ota-esp32 -t upload -t monitor
```

## `tsixlib` — Supported Channels

| Method            | Topic             | Protocol                        | Encryption                         |
| ----------------- | ----------------- | ------------------------------- | ---------------------------------- |
| `sendEncrypted()` | `mqtnl@1.0/<dst>` | JSON (magic `0x5B`)             | ChaCha20-Poly1305 (hex)            |
| `sendBinfeo()`    | `mqtnl@1.2/<dst>` | **Binfeo** binary (magic `0x66`)| ChaCha20-Poly1305 (raw bytes)      |
| `sendRaw()`       | `mqtnl@1.1/<dst>` | Binary OTA (magic `0x42`)       | Plaintext (for fast OTA transfers) |

Callbacks: `onEncryptedMessage(src, port, char*)`, `onBinfeoMessage(src, port, uint8_t*, len)`, `onRawMessage(src, port, uint8_t*, len)`. Includes built-in auto-response for `PING` & `BROADCAST_SCAN`.

### Binfeo Usage Example:

```cpp
TSIX tsix("esp-binfeo-01", 100, apiKey, MQTT_SERVER, MQTT_PORT);

void onBinfeo(const char *src, int srcPort, const uint8_t *data, size_t len) {
  // data = decrypted plaintext (raw bytes, safe for non-ASCII byte values >= 0x80)
  Serial.printf("[binfeo] %s:%d len=%u\n", src, srcPort, len);
}

// Setup:
tsix.begin();
tsix.onBinfeoMessage(onBinfeo);

// Send encrypted binary payload:
uint8_t buf[] = {0xde, 0xad, 0xbe, 0xef, 0x00, 0x80, 0xff};
tsix.sendBinfeo("tsix", 2700, buf, sizeof(buf));
```

> **OTA Note:** `ota-mqtnl` utilizes the v1.1 binary channel (plaintext) per the TSIX OTA design specifications to maximize transfer speeds without encryption overhead. For **regular encrypted binary messaging**, use `sendBinfeo()` (v1.2).

## Additional Notes

- `tsixlib` replaces legacy libraries (`noslib` and `TSIXSocket`) used in older projects (`ESP32-MQTNL-Sender-minimum`, `ESP32-MQTNL-SensorData-Sender`, and `ESP-OTA-MQTNL`).
- Make sure to review and adjust your `#define` configurations (SSID, MQTT, NODE_ID, keys, OTA settings) in the respective variant files before uploading.
- Ensure the TSIX server and MQTT broker are running, and that the target node is properly registered.
