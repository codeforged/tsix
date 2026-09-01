#ifndef TSIXLIB_H
#define TSIXLIB_H

#include <Arduino.h>
#if defined(ESP8266)
#include <ESP8266WiFi.h>
#else
#include <WiFi.h>
#endif
#include <WiFiClient.h>
#include <PubSubClient.h>
#include <ChaChaPoly.h>

// ── MQTNL crypto constants (ChaCha20-Poly1305) ──
#define TSIX_KEY_SIZE    32   // session key (bytes) — apiKey hex = 64 chars
#define TSIX_NONCE_SIZE  12   // IV (bytes)
#define TSIX_TAG_SIZE    16   // auth tag (bytes)

// MQTNL protocol constants
#define TSIX_FLAG_DATA           0x0A
#define TSIX_FLAG_PING_REQUEST   0x01
#define TSIX_FLAG_PING_REPLY     0x02
#define TSIX_FLAG_BROADCAST_PING 0x03
#define TSIX_FLAG_BROADCAST_REPLY 0x04
#define TSIX_PING_PORT           65535
#define TSIX_BROADCAST_PORT      65534

// MQTNL wire magic bytes (deteksi protocol per-paket)
#define TSIX_MAGIC_JSON    0x5B  // '[' — JSON v1.0
#define TSIX_MAGIC_RAW     0x42  // 'B'  — biner OTA v1.1 (plain)
#define TSIX_MAGIC_BINFEO  0x66  // 'f'  — biner tersandi v1.2 (Binfeo)

// Callback signatures
typedef void (*TSIXEncryptedCb)(const char *srcAddress, int srcPort, const char *payload);
typedef void (*TSIXRawCb)(const char *srcAddress, int srcPort, const uint8_t *payload, size_t length);

/**
 * TSIX — library MQTNL terpadu untuk ESP8266 / ESP32.
 *
 * Menggabungkan (dan memperbaiki) `noslib` (kanal JSON terenkripsi MQTNL v1.0)
 * dan `TSIXSocket` (kanal biner MQTNL v1.1 untuk OTA/raw) jadi satu class:
 *
 *   - sendEncrypted() → publish ke "mqtnl@1.0/<dst>" (JSON + ChaCha20-Poly1305 hex)
 *   - sendBinfeo()    → publish ke "mqtnl@1.2/<dst>" (biner TERSANDI, magic 0x66)
 *   - sendRaw()       → publish ke "mqtnl@1.1/<dst>" (paket biner 0x42, plain)
 *   - onEncryptedMessage() / onBinfeoMessage() / onRawMessage() → callback sesuai kanal
 *   - Auto-respond PING & BROADCAST_SCAN (seperti kernel TSIX)
 *   - WiFi connect + MQTT reconnect + subscribe (1.0, 1.1, 1.2; id sendiri + "*")
 */
class TSIX
{
public:
  TSIX(const char *id, uint16_t port, const char *apiKeyHex, const char *mqttServer, int mqttPort);
  void init(const char *id, uint16_t port, const char *apiKeyHex, const char *mqttServer, int mqttPort);

  // ── WiFi ──
  bool connectWiFi(const char *ssid, const char *password, uint32_t timeoutMs = 20000);
  bool wifiConnected() { return WiFi.status() == WL_CONNECTED; }

  // ── MQTT / MQTNL ──
  bool begin();           // set server + buffer + connect + subscribe
  void loop();            // jaga koneksi + dispatch paket masuk
  bool mqttConnected() { return mqttClient.connected(); }

  // ── Kanal v1.0: JSON terenkripsi (ChaCha20-Poly1305) ──
  bool sendEncrypted(const char *dstAddress, int dstPort, const char *payload);

  // ── Kanal v1.1: biner plain (untuk OTA / raw) ──
  bool sendRaw(const char *dstAddress, int dstPort, const uint8_t *payload, size_t length);
  bool sendRaw(const char *dstAddress, int dstPort, const char *payload)
  {
    return sendRaw(dstAddress, dstPort, (const uint8_t *)payload, strlen(payload));
  }

  // ── Kanal v1.2: biner TERSANDI (Binfeo) — payload dienkripsi oleh library,
  //    wire berisi nonce[12]+tag[16]+cipher; RX diterima sebagai byte mentah ──
  bool sendBinfeo(const char *dstAddress, int dstPort, const uint8_t *payload, size_t length);
  bool sendBinfeo(const char *dstAddress, int dstPort, const char *payload)
  {
    return sendBinfeo(dstAddress, dstPort, (const uint8_t *)payload, strlen(payload));
  }

  // ── Callbacks ──
  void onEncryptedMessage(TSIXEncryptedCb cb) { encCb = cb; }
  void onBinfeoMessage(TSIXRawCb cb) { binfeoCb = cb; }
  void onRawMessage(TSIXRawCb cb) { rawCb = cb; }

  // ── Helpers ──
  static bool hexToBytes(const char *hex, uint8_t *out, size_t outLen);
  static size_t bytesToHex(const uint8_t *in, size_t inLen, char *out, size_t outCap);
  static void randomBytes(uint8_t *out, size_t n);
  const char *getID() { return id.c_str(); }
  uint16_t getPort() { return port; }

private:
  String id;
  uint16_t port;
  const char *apiKey;      // string hex 64 char (kunci ChaCha20)
  const char *mqttServer;
  int mqttPort;

  uint8_t keyBytes[TSIX_KEY_SIZE];
  uint8_t tag[TSIX_TAG_SIZE];

  static TSIX *instance;
  WiFiClient espClient;
  PubSubClient mqttClient;

  TSIXEncryptedCb encCb;
  TSIXRawCb binfeoCb;
  TSIXRawCb rawCb;

  bool encrypt(const uint8_t *in, uint8_t *out, const uint8_t *nonce, size_t len);
  bool decrypt(const uint8_t *in, uint8_t *out, const uint8_t *nonce, const uint8_t *tagBytes, size_t len);

  static void mqttCallback(char *topic, byte *payload, unsigned int length);
  void handleV1(const char *topic, byte *payload, unsigned int length);   // JSON terenkripsi
  void handleV11(const char *topic, byte *payload, unsigned int length);  // biner plain OTA
  void handleV12(const char *topic, byte *payload, unsigned int length);  // biner tersandi (Binfeo)

  void connectMQTT();
  void sendPong(const char *dstAddress, int dstPort, uint8_t flag);
  bool publishBinary(const char *topicPrefix, uint8_t magic, const char *dstAddress,
                     int dstPort, const uint8_t *payload, size_t length);
};

#endif // TSIXLIB_H
