// ─────────────────────────────────────────────────────────────
// VARIANT: mqtnl minimum-binfeo-sender
// Sends CIPHERED BINARY messages (Binfeo v1.2, mqtnl@1.2/) to TSIX node.
// Different from `minimum` (JSON v1.0): payload is encrypted by tsixlib
// into raw bytes (nonce[12]+tag[16]+cipher) inside magic 0x66 binary frame —
// bytes >= 0x80 remain intact up to the receiver (RX receives as raw bytes).
// Build: -DAPP_VARIANT_MINIMUM_BINFEO (env minimum-binfeo-esp32 / -esp8266)
// ─────────────────────────────────────────────────────────────
#include <Arduino.h>
#include <tsixlib.h>
#include "secrets.h"   // WiFi/MQTT/API key — in include/secrets.h (NOT committed)

// ── Configuration (network in secrets.h) ──
#define NODE_ID       "esp-binfeo-01"  // device identity in Device Bank
#define NODE_PORT     100              // virtual port of this MQTNL node
#define DST_HOST      "tsix"           // target TSIX node
#define DST_PORT      2700             // target port (Binfeo)

// Tenant API key = ChaCha20-Poly1305 key (from secrets.h)
const char apiKey[] = TSIX_API_KEY;

TSIX tsix(NODE_ID, NODE_PORT, apiKey, TSIX_MQTT_SERVER, TSIX_MQTT_PORT);

// ── Callback for incoming Binfeo messages (decrypted, raw bytes) ──
void onBinfeo(const char *srcAddress, int srcPort, const uint8_t *data, size_t len)
{
  Serial.printf("[RX-binfeo] %s:%d len=%u hex=", srcAddress, srcPort, (unsigned)len);
  for (size_t i = 0; i < len && i < 64; i++)
    Serial.printf("%02x", data[i]);
  Serial.println();
}

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
  tsix.onBinfeoMessage(onBinfeo);
  Serial.println("[setup] MQTT/MQTNL (Binfeo) ready");
}

void loop()
{
  tsix.loop();

  static uint32_t lastSent = 0;
  static uint16_t counter = 0; // 1. Add static counter variable so its value increments continuously

  if (millis() - lastSent >= 5000)
  {
    // Initial binary payload
    uint8_t buf[] = {0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff, 0x42};
    
    // 2. Split uint16_t into 2 bytes and replace the last 2 elements (index 9 and 10)
    // Using Big Endian (MSB / Most Significant Byte first)
    buf[9]  = (counter >> 8) & 0xFF; // High byte
    buf[10] = counter & 0xFF;        // Low byte

    bool ok = tsix.sendBinfeo(DST_HOST, DST_PORT, buf, sizeof(buf));
    Serial.printf("[loop] sendBinfeo (Counter: %u) -> %s:%d (%u bytes) %s\n",
                  counter, DST_HOST, DST_PORT, (unsigned)sizeof(buf), ok ? "OK" : "FAILED");
    
    lastSent = millis();
    counter++; // 3. Increment counter value each time transmission finishes/succeeds
  }
}
