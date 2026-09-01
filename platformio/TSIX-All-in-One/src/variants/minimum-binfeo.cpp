// ─────────────────────────────────────────────────────────────
// VARIAN: mqtnl minimum-binfeo-sender
// Kirim pesan BINER TERSANDI (Binfeo v1.2, mqtnl@1.2/) ke node TSIX.
// Berbeda dari `minimum` (JSON v1.0): payload dienkripsi oleh tsixlib
// jadi byte mentah (nonce[12]+tag[16]+cipher) di frame biner magic 0x66 —
// byte >= 0x80 tetap utuh sampai receiver (RX terima sebagai byte mentah).
// Build: -DAPP_VARIANT_MINIMUM_BINFEO (env minimum-binfeo-esp32 / -esp8266)
// ─────────────────────────────────────────────────────────────
#include <Arduino.h>
#include <tsixlib.h>
#include "secrets.h"   // WiFi/MQTT/API key — di include/secrets.h (TIDAK di-commit)

// ── Konfigurasi (network di secrets.h) ──
#define NODE_ID       "esp-binfeo-01"  // identitas device di Device Bank
#define NODE_PORT     100              // port virtual MQTNL node ini
#define DST_HOST      "mactsix"        // node TSIX tujuan
#define DST_PORT      2700             // port tujuan (Binfeo)

// API key tenant = kunci ChaCha20-Poly1305 (dari secrets.h)
const char apiKey[] = TSIX_API_KEY;

TSIX tsix(NODE_ID, NODE_PORT, apiKey, TSIX_MQTT_SERVER, TSIX_MQTT_PORT);

// ── Callback pesan Binfeo masuk (sudah didekripsi, byte mentah) ──
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
    Serial.println("[setup] WiFi GAGAL");
    return;
  }
  Serial.println("[setup] WiFi OK");

  tsix.begin();
  tsix.onBinfeoMessage(onBinfeo);
  Serial.println("[setup] MQTT/MQTNL (Binfeo) siap");
}

void loop()
{
  tsix.loop();

  static uint32_t lastSent = 0;
  if (millis() - lastSent >= 5000)
  {
    // Payload biner (ada byte >= 0x80) — bukti Binfeo tidak merusak byte
    uint8_t buf[] = {0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff, 0x42};
    bool ok = tsix.sendBinfeo(DST_HOST, DST_PORT, buf, sizeof(buf));
    Serial.printf("[loop] sendBinfeo -> %s:%d (%u byte) %s\n",
                  DST_HOST, DST_PORT, (unsigned)sizeof(buf), ok ? "OK" : "FAILED");
    lastSent = millis();
  }
}
