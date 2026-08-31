#include <Arduino.h>
#include <noslib.h>

#define WIFI_SSID "Your SSID"
#define WIFI_PASSWORD "Your SSID Password"
#define MQTT_SERVER "broker.hivemq.com"
#define MQTT_PORT 1883

char apiKey[] = "5555cca25cb99006aa2243fc09f859575612ec49c27c8885882618317e56a114";

NOS nos("espMultiSensor", 100, apiKey, MQTT_SERVER, MQTT_PORT);

void setup()
{
  Serial.begin(115200);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED)
    delay(500);

  nos.begin();
}

void loop()
{
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