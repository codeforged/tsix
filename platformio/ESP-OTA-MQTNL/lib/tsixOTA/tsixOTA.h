#ifndef TSIX_OTA_H
#define TSIX_OTA_H

#include <Arduino.h>
#include <WiFiClient.h>
#include <PubSubClient.h>

// Tuning: Smaller chunks (1024) are more reliable on unstable mobile hotspots.
#define NOS_OTA_CHUNK_SIZE 2048

#if defined(ESP8266)
#include <Updater.h>
#elif defined(ESP32)
#include <Update.h>
#endif

// ============================================================
// TSIXSocket (Network Over MQTT) - Plain mode only, no encryption
// ============================================================
class TSIXSocket
{
public:
    TSIXSocket(const char *id, const uint16_t port, const char *mqttServer, int mqttPort);

    void init(const char *id, const uint16_t port, const char *mqttServer, int mqttPort);

    bool begin();
    void loop();
    void sendPacket(const char *dstAddress, int dstPort, const char *payload);
    void sendPacketRaw(const char *dstAddress, int dstPort, const uint8_t *payload, size_t length);
    void onMessage(void (*callback)(const char *srcAddress, int srcPort, const uint8_t *payload, size_t length));

private:
    const char *mqttServer;

    static TSIXSocket *instance;
    WiFiClient espClient;
    PubSubClient mqttClient;
    String id;
    uint16_t port;

    int mqttPort;
    void (*messageCallback)(const char *, int, const uint8_t *, size_t);
    static void mqttCallback(char *topic, byte *payload, unsigned int length);

    void connectMQTT();
};

// ============================================================
// NosOTA - OTA Update via NOS/MQTT
// ============================================================
struct NosConfig
{
    char ssid[32];
    char password[64];
    char mqttServer[64];
    int mqttPort;
    char otaHost[64];
    int otaPort;
    char activationKey[8]; // 6-digit alphanumeric
};

class NosOTA
{
public:
    NosOTA(TSIXSocket *nos_instance);

    // Persistent Storage & CLI
    bool begin();        // Mounts FS and loads config
    void handleSerial(); // Interactive CLI handler
    void connectWiFi();  // Connects using current config

    // Manual Setters (for Captive Portal integration)
    void setWiFi(const char *ssid, const char *pass);
    void setMQTT(const char *host, int port);
    void setOTA(const char *host, int port);
    void setAK(const char *key);
    void setFirmwarePath(const char *path)
    {
        strncpy(fwPath, path, sizeof(fwPath));
        isJsonConfig = false;
    }
    void setFirmwareConfig(const char *path)
    {
        strncpy(fwPath, path, sizeof(fwPath));
        isJsonConfig = true;
    }
    void setDeviceClass(const char *dc) { strncpy(deviceClass, dc, sizeof(deviceClass)); }
    void setFWVersion(const char *version) { strncpy(fwVersion, version, sizeof(fwVersion)); }
    void saveConfig();

    // Core OTA logic
    void startUpdate(bool force = false, const char *version = nullptr); // Trigger OTA manually
    void checkUpdate();                                                  // Just check version info
    void loop();
    void handleMessage(const char *srcAddress, int srcPort, const uint8_t *payload, size_t length);
    bool isUpdating();

    NosConfig config;

private:
    TSIXSocket *nos;
    char fwVersion[16] = "1.0.0";
    char fwPath[128] = "/firmware.bin";
    bool isJsonConfig = false;
    char deviceClass[32] = "general";
    uint8_t *decodeBuffer = nullptr; // Pre-allocated decode buffer
    const char *CONFIG_PATH = "/nos_ota.bin";
    String cmdBuf = "";
    bool loadConfig();
    bool onlyCheck = false;
    bool forceUpdate = false;

    enum OTAState
    {
        STATE_IDLE,
        STATE_REQUESTING_CONFIG, // Fetching .json info
        STATE_FETCHING_CONFIG,   // Fetching .json data (chunks)
        STATE_REQUESTING_INFO,   // Fetching .bin info (size)
        STATE_REQUESTING_CHUNK,
        STATE_FLASHING,
        STATE_SUCCESS,
        STATE_ERROR
    };

    OTAState state;
    uint32_t totalFirmwareSize;
    uint32_t currentOffset;
    uint32_t chunkSize;
    char activePath[256] = ""; // Current path being fetched (for retries)
    char activeVersion[16] = "";

    // Metadata from JSON
    char targetVersion[16] = "";
    char targetFileName[128] = "";
    char targetName[64] = "";
    char targetRelease[16] = "";

    unsigned long lastRequestTime;
    int retryCount;
    const int MAX_RETRIES = 15;                     // More patience for patchy signal
    const unsigned long REQUEST_TIMEOUT_MS = 10000; // 10s for high jitter internet

    void requestInfo(const char *path, const char *version = nullptr);
    void requestChunk();
    void processConfigResponse(const char *payload);
    void processInfoResponse(const char *payload);
    void processDataChunk(const char *payload);
    void processDataChunkBinary(uint32_t offset, const uint8_t *data, size_t dataLen);
    void endWithError(const char *msg);

    int compareVersions(const char *v1, const char *v2); // v2 > v1 returns positive

    // JSON parsers (minimal, string manipulation based to save memory vs ArduinoJson)
    String extractJsonString(const char *json, const char *key);
    long extractJsonInt(const char *json, const char *key);
    bool extractJsonBool(const char *json, const char *key);
};

#endif // NOS_OTA_H
