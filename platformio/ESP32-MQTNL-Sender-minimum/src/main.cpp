#include <Arduino.h>
#include <noslib.h>

#define WIFI_SSID "BabamGo"
#define WIFI_PASSWORD "bismillah"
#define MQTT_SERVER "iot-hub.site"
#define MQTT_PORT 1883


char key[KEY_SIZE] = {0x81, 0xFF, 0x71, 0xED, 0x57, 0x4E, 0x54, 0x59,
                      0x76, 0x90, 0xAE, 0x7B, 0x04, 0xE4, 0xEF, 0x5F,
                      0xC8, 0x74, 0x97, 0xFE, 0x10, 0xB6, 0xB0, 0x37,
                      0xCB, 0x03, 0x1A, 0xF7, 0xC7, 0xD6, 0x76, 0x19};
NOS nos("espMultiSensor", 100, key, MQTT_SERVER, MQTT_PORT);

// Message handler callback
void onMessageReceived(const char *srcAddress, int srcPort, const char *payload) {
  Serial.print("Message from ");
  Serial.print(srcAddress);
  Serial.print(":");
  Serial.print(srcPort);
  Serial.print(" -> ");
  Serial.println(payload);
}

void setup() {
  Serial.begin(115200);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED)
    delay(500);

  nos.begin();
  nos.onMessage(onMessageReceived);
}

void loop() {
  static uint32_t lastSent = 0;
  nos.loop();
  if (millis() - lastSent >= 5000)
  {
    char data[128];
    sprintf(data, "Hello %lu", millis());
    nos.sendPacket("tsix", 2500, data);
    lastSent = millis();
  }
}