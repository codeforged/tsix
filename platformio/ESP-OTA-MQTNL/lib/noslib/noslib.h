#ifndef NOS_ARDUINO_H
#define NOS_ARDUINO_H

#include <WiFiClient.h>
#include <PubSubClient.h>
#include <ChaChaPoly.h>

#define KEY_SIZE 32
#define NONCE_SIZE 12
#define TAG_SIZE 16

class NOS
{
public:
    // Init dinamis (Runtime)
    void init(const char *id, const uint16_t port, const char *key, const char *mqttServer, int mqttPort);

    // Constructor
    NOS(const char *id, const uint16_t port, const char *key, const char *mqttServer, int mqttPort);

    bool begin();
    void loop();
    void sendPacket(const char *dstAddress, int dstPort, const char *payload);
    void onMessage(void (*callback)(const char *srcAddress, int srcPort, const char *payload));

private:
    // [FIX] Tambahkan 'const' di sini agar cocok dengan main.cpp
    const char *key;
    const char *mqttServer;

    uint8_t tag[16];

    static NOS *instance;
    WiFiClient espClient;
    PubSubClient mqttClient;
    String id;
    uint16_t port;

    int mqttPort;
    void (*messageCallback)(const char *, int, const char *);
    static void mqttCallback(char *topic, byte *payload, unsigned int length);

    void encryptData(const uint8_t *input, uint8_t *output, const uint8_t *nonce, size_t length);
    bool decryptData(const uint8_t *input, uint8_t *output, const uint8_t *nonce, uint8_t *tagBytes, size_t length);

    void connectMQTT();
};

#endif
