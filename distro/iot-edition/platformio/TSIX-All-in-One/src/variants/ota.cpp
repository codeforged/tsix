// ─────────────────────────────────────────────────────────────
// VARIANT: ota-mqtnl — Firmware update via MQTNL binary OTA (v1.1)
//
// Varian ini hanya wiring konfigurasi; state machine OTA ada di library
// tsixlib (class TSIXOTA — lihat lib/tsixlib/tsixota.h).
//
// Protocol (matches otad / ota-server TSIX):
//   1. sendRaw request (binary channel mqtnl@1.1/):
//        {cmd:"ota.info", path, mac, dc, ak}
//      → resp (JSON inside binary channel): {cmd:"ota.info_res", version, size}
//   2. Update.begin(size)
//   3. sendRaw request: {cmd:"ota.read", offset, len, path, mac, dc, ak}
//      → resp binary chunk: [0x55][OFFSET:4 LE][DATA...]
//      → Update.write → offset += len → repeat until complete
//   4. Update.end(true) → onComplete → reboot
//
// Trigger: automated autoStartDelay after boot, or type "ota" in serial.
// Build: -DAPP_VARIANT_OTA (env ota-esp32 / ota-esp8266)
// ─────────────────────────────────────────────────────────────
#include <Arduino.h>
#include <tsixlib.h>
#include "secrets.h"   // WiFi/MQTT/API key — in include/secrets.h (NOT committed)

// ── Configuration (network in secrets.h) ──
#define NODE_ID       "ota-device-01"
#define NODE_PORT     100
#define OTA_HOST      "tsix"          // TSIX node running ota-server/otad
#define OTA_PORT      4000            // OTA port on that node
// #define OTA_PATH      "/test/firmwareESP32C3.bin"  // firmware path in VFS
#define OTA_PATH      "/test/firmwareESP32.bin"  // firmware path in VFS
#define OTA_AK        "123456"        // activation key (from portal)
#define OTA_CHUNK     2048*2            // chunk size (1280-2048 is safe for ESP8266)
#define OTA_DELAY_MS  5000            // auto-trigger after boot

const char apiKey[] = TSIX_API_KEY;

TSIX tsix(NODE_ID, NODE_PORT, apiKey, TSIX_MQTT_SERVER, TSIX_MQTT_PORT);

// ── State machine OTA dari library tsixlib (TSIXOTA) ──
TSIXOTA ota(&tsix);

void setup()
{
  Serial.begin(115200);
  delay(200);

  if (!tsix.connectWiFi(TSIX_WIFI_SSID, TSIX_WIFI_PASSWORD))
  {
    Serial.println("[setup] WiFi FAILED");
    return;
  }

  tsix.begin();

  TSIXOTA::Config cfg;
  cfg.host = OTA_HOST;
  cfg.port = OTA_PORT;
  cfg.path = OTA_PATH;
  cfg.activationKey = OTA_AK;
  cfg.chunk = OTA_CHUNK;
  cfg.autoStartDelay = OTA_DELAY_MS;
  ota.begin(cfg);

  ota.onProgress([](uint32_t done, uint32_t total) {
    Serial.printf("[OTA] %lu/%lu (%d%%)\n", (unsigned long)done, (unsigned long)total,
                  (int)((done * 100) / total));
  });
  ota.onComplete([]() {
    Serial.println("[OTA] SUCCESS — rebooting...");
    delay(1000);
    ESP.restart();
  });
  ota.onError([](const char *msg) {
    Serial.printf("[OTA] ERROR: %s\n", msg);
  });

  Serial.println("[setup] OTA device ready");
  Serial.println("      type 'ota' in serial for manual update.");
}

void loop()
{
  tsix.loop();
  ota.loop(); // auto-start setelah OTA_DELAY_MS

  if (Serial.available())
  {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd == "ota")
      ota.start();
  }
}
