#ifndef NOS_ARDUINO_H
#define NOS_ARDUINO_H

#ifdef ESP8266
#include <ESP8266WiFi.h>
#else
#include <WiFi.h>
#endif

#include <PubSubClient.h>
#include <ChaChaPoly.h>

#define KEY_SIZE 32
#define NONCE_SIZE 12
#define TAG_SIZE 16

class NOS
{
public:
    NOS(const char *id, const uint16_t port, const char *apiKey, const char *mqttServer, int mqttPort);
    bool begin();
    void loop();
    void sendPacket(const char *dstAddress, int dstPort, const char *payload);
    void onMessage(void (*callback)(const char *srcAddress, int srcPort, const char *payload));

private:
    const char *apiKey;         // API key tenant (string hex) = kunci enkripsi ChaCha20
    uint8_t keyBytes[KEY_SIZE]; // hasil konversi hex -> byte mentah utk ChaCha20
    uint8_t tag[16];

    // Konversi string hex (mis. "81ff71ed...") ke byte mentah.
    static bool hexToBytes(const char *hex, uint8_t *out, size_t outLen);

    static NOS *instance;
    WiFiClient espClient;
    PubSubClient mqttClient;
    String id;
    uint16_t port;

    const char *mqttServer;
    int mqttPort;
    uint32_t lastReconnectAttempt = 0;
    void (*messageCallback)(const char *, int, const char *);
    static void mqttCallback(char *topic, byte *payload, unsigned int length);

    void encryptData(const uint8_t *input, uint8_t *output, const uint8_t *nonce, size_t length);
    bool decryptData(const uint8_t *input, uint8_t *output, const uint8_t *nonce, uint8_t *tagBytes, size_t length);

    // bool connectWiFi(const char* ssid, const char* password);
    bool connectMQTT();
};

#endif
