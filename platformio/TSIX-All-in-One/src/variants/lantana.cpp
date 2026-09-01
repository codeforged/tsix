// ─────────────────────────────────────────────────────────────
// VARIANT: mqtnl lantana-sender
// Sends sensor data (Lantana format) + receives relay commands from
// TSIX, via encrypted JSON MQTNL v1.0 channel (mqtnl@1.0/).
// Same as `ESP32-MQTNL-SensorData-Sender`, uses `tsixlib`.
// Build: -DAPP_VARIANT_LANTANA (env lantana-esp32 / -esp8266)
// ─────────────────────────────────────────────────────────────
#include <Arduino.h>
#include <tsixlib.h>
#include "secrets.h"   // WiFi/MQTT/API key — in include/secrets.h (NOT committed)

// ── Lantana Configuration ──
#define NODE_ID       "esp8266-dev-01"   // device identity in Device Bank
#define NODE_PORT     100                // virtual port of this node
#define LANTANA_HOST  "tsix"             // TSIX node running Lantana daemon
#define LANTANA_PORT  1001               // Lantana MQTN port

// Relay pins (adjust according to board)
#ifdef ESP8266
#define RELAY1_PIN D1
#define RELAY2_PIN D2
#else
#define RELAY1_PIN 16
#define RELAY2_PIN 17
#endif

// Tenant API key = ChaCha20-Poly1305 key (from secrets.h)
const char apiKey[] = TSIX_API_KEY;

TSIX tsix(NODE_ID, NODE_PORT, apiKey, TSIX_MQTT_SERVER, TSIX_MQTT_PORT);

const char *sensorIds[] = {"01", "02", "03", "04"};
int sensorVals[4] = {0, 0, 0, 0};
const int sensorCount = 4;
uint32_t lastSent = 0;

bool relay1State = false;
bool relay2State = false;

// ── Callback for encrypted messages from TSIX ──
void onMessageReceived(const char *srcAddress, int srcPort, const char *payload)
{
  Serial.printf("[RX] %s:%d -> %s\n", srcAddress, srcPort, payload);

  if (strncmp(payload, "RELAY_1:", 8) == 0)
  {
    relay1State = (strcmp(payload + 8, "ON") == 0);
    digitalWrite(RELAY1_PIN, relay1State ? HIGH : LOW);
    Serial.printf("Relay 1: %s\n", relay1State ? "ON" : "OFF");
  }
  else if (strncmp(payload, "RELAY_2:", 8) == 0)
  {
    relay2State = (strcmp(payload + 8, "ON") == 0);
    digitalWrite(RELAY2_PIN, relay2State ? HIGH : LOW);
    Serial.printf("Relay 2: %s\n", relay2State ? "ON" : "OFF");
  }
}

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
  tsix.onEncryptedMessage(onMessageReceived);
  Serial.println("[setup] System ready!");
}

void loop()
{
  tsix.loop();

  if (millis() - lastSent >= 5000)
  {
    for (int i = 0; i < sensorCount; i++)
    {
      int delta = random(-10, 11);
      sensorVals[i] = constrain(sensorVals[i] + delta, 1, 100);
    }

    // Lantana protocol payload (plaintext with nodeId):
    //   LANTANA|<nodeId>|<sensorId:value;sensorId:value;...>
    char data[128];
    snprintf(data, sizeof(data), "LANTANA|%s|%s:%d;%s:%d;%s:%d;%s:%d",
             NODE_ID,
             sensorIds[0], sensorVals[0],
             sensorIds[1], sensorVals[1],
             sensorIds[2], sensorVals[2],
             sensorIds[3], sensorVals[3]);

    bool ok = tsix.sendEncrypted(LANTANA_HOST, LANTANA_PORT, data);
    Serial.printf("[loop] %s (%s)\n", data, ok ? "OK" : "FAILED");
    lastSent = millis();
  }
}
