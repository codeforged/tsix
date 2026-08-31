#include <Arduino.h>
#include <noslib.h>

// ── Konfigurasi WiFi / MQTT ──
#define WIFI_SSID "BabamGo"
#define WIFI_PASSWORD "bismillah"
#define MQTT_SERVER "192.168.1.204"
#define MQTT_PORT 1883

// ── Konfigurasi Lantana (node ID & tujuan) ──
// NODE_ID = identitas device di Device Bank Lantana (multi-device).
// LANTANA_HOST = alamat node TSIX tempat daemon Lantana berjalan.
// LANTANA_PORT = port MQTN Lantana (default 1000).
#define NODE_ID "esp8266-dev-01"
#define LANTANA_HOST "wintsix"
#define LANTANA_PORT 1001

// Relay pin definitions
#ifdef ESP8266
#define RELAY1_PIN D1
#define RELAY2_PIN D2
#else
#define RELAY1_PIN 16
#define RELAY2_PIN 17
#endif

// API key tenant (string hex) = kunci enkripsi ChaCha20 (diterbitkan portal
// Lantana saat tenant mendaftar). Tinggal salin dari portal ke sini.
char apiKey[] = "81ff71ed574e54597690ae7b04e4ef5fc87497fe10b6b037cb031af7c7d67619";
NOS nos(NODE_ID, 100, apiKey, MQTT_SERVER, MQTT_PORT);

const char *sensorIds[] = {"01", "02", "03", "04"};
int sensorVals[4] = {0, 0, 0, 0}; // Initial values for sensors
const int sensorCount = 4;
uint32_t lastSent = 0;

// Relay states
bool relay1State = false;
bool relay2State = false;

// Message handler callback
void onMessageReceived(const char *srcAddress, int srcPort, const char *payload)
{
  Serial.print("Message from ");
  Serial.print(srcAddress);
  Serial.print(":");
  Serial.print(srcPort);
  Serial.print(" -> ");
  Serial.println(payload);

  // Parse relay commands from iot-listener: "RELAY_1:ON" or "RELAY_2:OFF"
  if (strncmp(payload, "RELAY_1:", 8) == 0)
  {
    relay1State = (strcmp(payload + 8, "ON") == 0);
    digitalWrite(RELAY1_PIN, relay1State ? HIGH : LOW);
    Serial.print("Relay 1: ");
    Serial.println(relay1State ? "ON" : "OFF");
  }
  else if (strncmp(payload, "RELAY_2:", 8) == 0)
  {
    relay2State = (strcmp(payload + 8, "ON") == 0);
    digitalWrite(RELAY2_PIN, relay2State ? HIGH : LOW);
    Serial.print("Relay 2: ");
    Serial.println(relay2State ? "ON" : "OFF");
  }
}

void setup()
{
  Serial.begin(115200);

  // Initialize relay pins
  pinMode(RELAY1_PIN, OUTPUT);
  pinMode(RELAY2_PIN, OUTPUT);
  digitalWrite(RELAY1_PIN, LOW);
  digitalWrite(RELAY2_PIN, LOW);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED)
    delay(500);

  nos.begin();
  nos.onMessage(onMessageReceived);

  Serial.println("System ready!");
  Serial.print("Relay 1 pin: ");
  Serial.println(RELAY1_PIN);
  Serial.print("Relay 2 pin: ");
  Serial.println(RELAY2_PIN);
}

void loop()
{
  nos.loop();
  if (millis() - lastSent >= 5000)
  {
    for (int i = 0; i < sensorCount; i++)
    {
      int delta = random(-10, 11);
      sensorVals[i] = constrain(sensorVals[i] + delta, 1, 100);
    }

    // Payload protokol Lantana (plaintext ber-nodeId):
    //   LANTANA|<nodeId>|<sensorId:value;sensorId:value;...>
    // Listener Lantana akan auto-detect sebagai plaintext & memetakan
    // sensorId 01/02/03/04 ke kategori temp/hum/pres/light (via sensorIdMap).
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