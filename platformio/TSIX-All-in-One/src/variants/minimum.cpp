// ─────────────────────────────────────────────────────────────
// VARIANT: mqtnl minimum-sender
// Sends encrypted messages (ChaCha20-Poly1305) to TSIX node via
// JSON MQTNL v1.0 channel (mqtnl@1.0/). Same as
// `ESP32-MQTNL-Sender-minimum`, but uses integrated `tsixlib`.
// Build: -DAPP_VARIANT_MINIMUM   (env minimum-esp32 / minimum-esp8266)
// ─────────────────────────────────────────────────────────────
#include <Arduino.h>
#include <tsixlib.h>
#include "secrets.h"   // WiFi/MQTT/API key — in include/secrets.h (NOT committed)

// ── Configuration (network in secrets.h) ──
#define NODE_ID       "esp-minimum-01"  // device identity in Device Bank
#define NODE_PORT     100               // virtual port of this MQTNL node
#define DST_HOST      "tsix"            // target TSIX node
#define DST_PORT      2500              // target port

// Tenant API key = ChaCha20-Poly1305 key (from secrets.h)
const char apiKey[] = TSIX_API_KEY;

TSIX tsix(NODE_ID, NODE_PORT, apiKey, TSIX_MQTT_SERVER, TSIX_MQTT_PORT);

void setup()
{
  Serial.begin(115200);
  delay(200);

  if (!tsix.connectWiFi(TSIX_WIFI_SSID, TSIX_WIFI_PASSWORD))
  {
    Serial.println("[setup] WiFi FAILED");
    return;
  }
  Serial.println("[setup] WiFi OK");

  tsix.begin();
  Serial.println("[setup] MQTT/MQTNL ready");
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
