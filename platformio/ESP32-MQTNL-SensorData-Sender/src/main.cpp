#include <Arduino.h>
#include <noslib.h>

#define WIFI_SSID "Your WiFi SSID"
#define WIFI_PASSWORD "Your WiFi Password"
#define MQTT_SERVER "broker.hivemq.com"
#define MQTT_PORT 1883

// Relay pin definitions
#ifdef ESP8266
#define RELAY1_PIN D1
#define RELAY2_PIN D2
#else
#define RELAY1_PIN 16
#define RELAY2_PIN 17
#endif

char key[KEY_SIZE] = {0x81, 0xFF, 0x71, 0xED, 0x57, 0x4E, 0x54, 0x59,
                      0x76, 0x90, 0xAE, 0x7B, 0x04, 0xE4, 0xEF, 0x5F,
                      0xC8, 0x74, 0x97, 0xFE, 0x10, 0xB6, 0xB0, 0x37,
                      0xCB, 0x03, 0x1A, 0xF7, 0xC7, 0xD6, 0x76, 0x19};
NOS nos("espMultiSensor", 100, key, MQTT_SERVER, MQTT_PORT);

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
    char data[128];
    sprintf(data, "%s:%d;%s:%d;%s:%d;%s:%d;R1:%d;R2:%d",
            sensorIds[0], sensorVals[0],
            sensorIds[1], sensorVals[1],
            sensorIds[2], sensorVals[2],
            sensorIds[3], sensorVals[3],
            relay1State ? 1 : 0,
            relay2State ? 1 : 0);
    nos.sendPacket("antigonon", 1000, data);
    Serial.println(data);
    lastSent = millis();
  }
}