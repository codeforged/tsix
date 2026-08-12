#include <Arduino.h>
#if defined(ESP8266)
#include <ESP8266WiFi.h>
#define LED_PIN D4
#elif defined(ESP32)
#include <WiFi.h>
#define LED_PIN 2
#endif
#include <tsixOTA.h>
#include <noslib.h>

#define MQTT_SERVER "192.168.0.109"
#define MQTT_PORT 1883

const char *fwVersion = "1.0.9";
const uint8_t shared_key[32] = {0x81, 0xFF, 0x71, 0xED, 0x57, 0x4E, 0x54, 0x59, 0x76, 0x90, 0xAE, 0x7B, 0x04, 0xE4, 0xEF, 0x5F,
                                0xC8, 0x74, 0x97, 0xFE, 0x10, 0xB6, 0xB0, 0x37, 0xCB, 0x03, 0x1A, 0xF7, 0xC7, 0xD6, 0x76, 0x19};

TSIXSocket tsixSocket("OTA-DEVICE", 100, "", 1883); // SSID and Host will be set by NosOTA
NosOTA ota(&tsixSocket);

NOS nosNode("ESP-DEVICE", 200, (const char *)shared_key, MQTT_SERVER, MQTT_PORT); // MQTT host will be updated

unsigned long lastBlink = 0;
bool ledState = false;

// Callback for MQTNL v1.0 (Encrypted Data Exchange via noslib)
void handleNOSMessage(const char *srcAddress, int srcPort, const char *payload)
{
    Serial.printf("\n[NOSv1.0] Encrypted MSG From %s:%d => %s\n> ", srcAddress, srcPort, payload);
}

// Callback for MQTNL v1.1 (Binary Firmware Transfer via tsixOTA)
void handleTSIXSocketMessage(const char *srcAddress, int srcPort, const uint8_t *payload, size_t length)
{
    ota.handleMessage(srcAddress, srcPort, payload, length);
}

void setup()
{
    Serial.begin(115200);
    delay(100);
    Serial.println("\n\n--- TSIX OTA FIRMWARE ---");

    pinMode(LED_PIN, OUTPUT);
    digitalWrite(LED_PIN, HIGH);

    if (ota.begin())
    {
        ota.setFWVersion(fwVersion);
        ota.setFirmwareConfig("/test/mytest.json");
#if defined(ESP8266)
        ota.setDeviceClass("TestDevice");
#elif defined(ESP32)
        ota.setDeviceClass("TestDeviceESP32C3");
#endif
        Serial.println("Config loaded. Connecting...");
        ota.connectWiFi();

        // Initialize the encrypted node router with the same server configuration
        if (WiFi.status() == WL_CONNECTED && ota.config.mqttServer[0])
        {
            nosNode.init("ESP-DEVICE", 200, (const char *)shared_key, MQTT_SERVER, MQTT_PORT);
            nosNode.begin();
        }
    }
    else
    {
        ota.setFWVersion(fwVersion);
        Serial.println("First boot: No config found. Type 'help' to setup.");
    }

    tsixSocket.onMessage(handleTSIXSocketMessage);
    nosNode.onMessage(handleNOSMessage);
    Serial.print("> ");
}

void loop()
{
    if (WiFi.status() == WL_CONNECTED)
    {
        tsixSocket.loop();
        nosNode.loop();
    }
    ota.loop();
    ota.handleSerial();

    // Blink Logic
    unsigned long interval = ota.isUpdating() ? 100 : 1000;
    if (WiFi.status() != WL_CONNECTED)
        interval = 250;

    if (millis() - lastBlink > interval)
    {
        lastBlink = millis();
        ledState = !ledState;
        digitalWrite(LED_PIN, ledState ? LOW : HIGH);
    }
}
