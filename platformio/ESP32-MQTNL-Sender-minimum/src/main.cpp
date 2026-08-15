#include <Arduino.h>
#include <noslib.h>

#define WIFI_SSID "Your SSID"
#define WIFI_PASSWORD "Your SSID Password"
#define MQTT_SERVER "broker.hivemq.com"
#define MQTT_PORT 1883

char key[KEY_SIZE] = {
    0x55, 0x55, 0xCC, 0xA2, 0x5C, 0xB9, 0x90, 0x06,
    0xAA, 0x22, 0x43, 0xFC, 0x09, 0xF8, 0x59, 0x57,
    0x56, 0x12, 0xEC, 0x49, 0xC2, 0x7C, 0x88, 0x85,
    0x88, 0x26, 0x18, 0x31, 0x7E, 0x56, 0xA1, 0x14
};

NOS nos("espMultiSensor", 100, key, MQTT_SERVER, MQTT_PORT);

void setup() {
  Serial.begin(115200);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED)
    delay(500);

  nos.begin();
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