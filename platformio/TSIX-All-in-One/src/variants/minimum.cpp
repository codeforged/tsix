// ─────────────────────────────────────────────────────────────
// VARIAN: mqtnl minimum-sender
// Kirim pesan terenkripsi (ChaCha20-Poly1305) ke node TSIX lewat
// kanal JSON MQTNL v1.0 (mqtnl@1.0/). Sama seperti
// `ESP32-MQTNL-Sender-minimum`, tapi pakai `tsixlib` terpadu.
// Build: -DAPP_VARIANT_MINIMUM   (env minimum-esp32 / minimum-esp8266)
// ─────────────────────────────────────────────────────────────
#include <Arduino.h>
#include <tsixlib.h>

// ── Konfigurasi ──
#define WIFI_SSID     "BabamGo"
#define WIFI_PASSWORD "bismillah"
#define MQTT_SERVER   "192.168.1.204"
#define MQTT_PORT     1883

#define NODE_ID       "esp-minimum-01"  // identitas device di Device Bank
#define NODE_PORT     100               // port virtual MQTNL node ini
#define DST_HOST      "mactsix"            // node TSIX tujuan
#define DST_PORT      2500              // port tujuan

// API key tenant (hex 64 char) = kunci ChaCha20-Poly1305
const char apiKey[] =
  "5555cca25cb99006aa2243fc09f859575612ec49c27c8885882618317e56a114";

TSIX tsix(NODE_ID, NODE_PORT, apiKey, MQTT_SERVER, MQTT_PORT);

void setup()
{
  Serial.begin(115200);
  delay(200);

  if (!tsix.connectWiFi(WIFI_SSID, WIFI_PASSWORD))
  {
    Serial.println("[setup] WiFi GAGAL");
    return;
  }
  Serial.println("[setup] WiFi OK");

  tsix.begin();
  Serial.println("[setup] MQTT/MQTNL siap");
}

void loop()
{
  tsix.loop();

  static uint32_t lastSent = 0;
  if (millis() - lastSent >= 5000)
  {
    char data[64];
    snprintf(data, sizeof(data), "Hello %lu from %s", millis(), NODE_ID);

    bool ok = tsix.sendEncrypted(DST_HOST, DST_PORT, data);
    Serial.printf("[loop] sendEncrypted -> %s:%d => %s (%s)\n",
                  DST_HOST, DST_PORT, data, ok ? "OK" : "FAILED");
    lastSent = millis();
  }
}
