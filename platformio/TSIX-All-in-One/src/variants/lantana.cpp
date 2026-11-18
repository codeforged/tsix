// ─────────────────────────────────────────────────────────────
// VARIANT: Lantana V2 sensor node
//
// Alur (sama dengan src/mirror/lib/lantana):
//   HELLO → CHALLENGE → (KEYSET) → AUTH → AUTH_OK → kirim data AEAD
//
// Dua jalur handshake, dipilih otomatis dari target board:
//   ESP32   : RSA-OAEP (mbedtls) — session key acak dibungkus public key server
//   ESP8266 : PSK + HMAC/HKDF (BearSSL) — tanpa RSA, cocok untuk RAM/flash kecil
//
// Payload data: LANTANA|<deviceId>|<schemeId:value;...>  (V2 teks)
// Build: -DAPP_VARIANT_LANTANA (env lantana-esp32 / -esp8266)
// ─────────────────────────────────────────────────────────────
#include <Arduino.h>
#include <tsixlib.h>
#include <lantana_auth.h>
#include "secrets.h"

// ── Identitas (isi di include/secrets.h) ──
#ifndef TSIX_ACCOUNT_ID
#define TSIX_ACCOUNT_ID "juragan"
#endif
#ifndef TSIX_DEVICE_ID
#define TSIX_DEVICE_ID "0e8ab4d8-f242-4f26-af35-a9a56cd3cced"
#endif
#ifndef TSIX_ACCESS_KEY
#define TSIX_ACCESS_KEY "0000000000000000000000000000000000000000000000000000000000000000"
#endif
// Opsional: fingerprint server yang di-pin (16 hex char, huruf besar).
// Kosongkan untuk mode longgar (hanya log peringatan).
#ifndef TSIX_LANTANA_FINGERPRINT
#define TSIX_LANTANA_FINGERPRINT ""
#endif

// ── Lantana / MQTNL ──
#define NODE_PORT     101
#define LANTANA_HOST  "tsix"
#define LANTANA_PORT  1000
#define SEND_INTERVAL_MS 5000

// Relay pins
#ifdef ESP8266
#define RELAY1_PIN D1
#define RELAY2_PIN D2
#else
#define RELAY1_PIN 16
#define RELAY2_PIN 17
#endif

// Key awal kosong: session key dipasang setelah handshake.
TSIX tsix(TSIX_DEVICE_ID, NODE_PORT, nullptr, TSIX_MQTT_SERVER, TSIX_MQTT_PORT);
LantanaAuth auth(tsix, LANTANA_HOST, LANTANA_PORT, TSIX_ACCOUNT_ID,
                 TSIX_DEVICE_ID, TSIX_ACCESS_KEY, TSIX_LANTANA_FINGERPRINT);
uint32_t lastSend = 0;

const uint16_t SCHEME_IDS[4] = {101, 102, 103, 104};
int schemeVals[4] = {27, 60, 1013, 60};
const int SCHEME_MIN[4] = {-40, 0, 800, 0};
const int SCHEME_MAX[4] = {125, 100, 1100, 100};

bool relay1State = false;
bool relay2State = false;

// ─────────────────────────────────────────────────────────────
// Callback
// ─────────────────────────────────────────────────────────────
void onPlain(const char *srcAddress, int srcPort, const char *json)
{
  auth.onPlainMessage(json);
}

void onEncrypted(const char *srcAddress, int srcPort, const char *payload)
{
  if (auth.onEncryptedMessage(payload))
  {
    if (auth.isOnline()) lastSend = 0;
    return;
  }

  if (strncmp(payload, "RELAY_1:", 8) == 0)
  {
    relay1State = (strcmp(payload + 8, "ON") == 0);
    digitalWrite(RELAY1_PIN, relay1State ? HIGH : LOW);
  }
  else if (strncmp(payload, "RELAY_2:", 8) == 0)
  {
    relay2State = (strcmp(payload + 8, "ON") == 0);
    digitalWrite(RELAY2_PIN, relay2State ? HIGH : LOW);
  }
}

// ─────────────────────────────────────────────────────────────
void setup()
{
  Serial.begin(115200);
  delay(200);

  pinMode(RELAY1_PIN, OUTPUT);
  pinMode(RELAY2_PIN, OUTPUT);
  digitalWrite(RELAY1_PIN, LOW);
  digitalWrite(RELAY2_PIN, LOW);

  if (!tsix.connectWiFi(TSIX_WIFI_SSID, TSIX_WIFI_PASSWORD))
  {
    Serial.println("[setup] WiFi FAILED");
    return;
  }

  tsix.begin();
  tsix.onPlainMessage(onPlain);
  tsix.onEncryptedMessage(onEncrypted);

  Serial.printf("[setup] Lantana V2 node — akun=%s device=%s mode=%s\n",
                TSIX_ACCOUNT_ID, TSIX_DEVICE_ID, auth.mode());
  auth.begin();
}

void loop()
{
  tsix.loop();
  auth.loop();

  if (auth.isOnline() && millis() - lastSend >= SEND_INTERVAL_MS)
  {
    lastSend = millis();

    for (int i = 0; i < 4; i++)
    {
      int delta = random(-3, 4);
      schemeVals[i] = constrain(schemeVals[i] + delta, SCHEME_MIN[i], SCHEME_MAX[i]);
    }

    char data[128];
    snprintf(data, sizeof(data), "LANTANA|%s|%u:%d;%u:%d;%u:%d;%u:%d",
             TSIX_DEVICE_ID,
             SCHEME_IDS[0], schemeVals[0],
             SCHEME_IDS[1], schemeVals[1],
             SCHEME_IDS[2], schemeVals[2],
             SCHEME_IDS[3], schemeVals[3]);

    bool ok = tsix.sendEncrypted(LANTANA_HOST, LANTANA_PORT, data);
    auth.noteSendResult(ok);
    Serial.printf("[TX] %s (%s)\n", data, ok ? "OK" : "FAILED");
  }
}
