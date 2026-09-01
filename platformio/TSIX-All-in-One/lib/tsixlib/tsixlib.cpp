#include "tsixlib.h"
#include <stdlib.h>
#include <string.h>

TSIX *TSIX::instance = nullptr;

// ============================================================
// Constructor / init
// ============================================================
TSIX::TSIX(const char *id, uint16_t port, const char *apiKeyHex, const char *mqttServer, int mqttPort)
    : id(id), port(port), apiKey(apiKeyHex), mqttServer(mqttServer), mqttPort(mqttPort),
      mqttClient(espClient), encCb(nullptr), rawCb(nullptr)
{
  memset(keyBytes, 0, sizeof(keyBytes));
  if (apiKey)
    hexToBytes(apiKey, keyBytes, sizeof(keyBytes));
}

void TSIX::init(const char *id, uint16_t port, const char *apiKeyHex, const char *mqttServer, int mqttPort)
{
  this->id = id;
  this->port = port;
  this->apiKey = apiKeyHex;
  this->mqttServer = mqttServer;
  this->mqttPort = mqttPort;
  memset(keyBytes, 0, sizeof(keyBytes));
  if (apiKey)
    hexToBytes(apiKey, keyBytes, sizeof(keyBytes));
}

// ============================================================
// Helpers
// ============================================================
bool TSIX::hexToBytes(const char *hex, uint8_t *out, size_t outLen)
{
  if (!hex)
    return false;
  size_t len = strlen(hex);
  if (len != outLen * 2)
    return false;
  for (size_t i = 0; i < outLen; i++)
  {
    char hi = hex[i * 2], lo = hex[i * 2 + 1];
    auto nibble = [](char c) -> uint8_t
    {
      if (c >= '0' && c <= '9') return (uint8_t)(c - '0');
      if (c >= 'a' && c <= 'f') return (uint8_t)(c - 'a' + 10);
      if (c >= 'A' && c <= 'F') return (uint8_t)(c - 'A' + 10);
      return 0;
    };
    out[i] = (uint8_t)((nibble(hi) << 4) | nibble(lo));
  }
  return true;
}

size_t TSIX::bytesToHex(const uint8_t *in, size_t inLen, char *out, size_t outCap)
{
  static const char h[] = "0123456789abcdef";
  if (outCap < inLen * 2 + 1)
    return 0;
  for (size_t i = 0; i < inLen; i++)
  {
    out[i * 2] = h[(in[i] >> 4) & 0x0F];
    out[i * 2 + 1] = h[in[i] & 0x0F];
  }
  out[inLen * 2] = '\0';
  return inLen * 2;
}

void TSIX::randomBytes(uint8_t *out, size_t n)
{
  for (size_t i = 0; i < n; i++)
  {
#if defined(ESP8266)
    out[i] = (uint8_t)random(256);
#else
    out[i] = (uint8_t)esp_random();
#endif
  }
}

// ============================================================
// WiFi
// ============================================================
bool TSIX::connectWiFi(const char *ssid, const char *password, uint32_t timeoutMs)
{
  if (WiFi.status() == WL_CONNECTED)
    return true;
  WiFi.disconnect();
  WiFi.begin(ssid, password);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutMs)
    delay(200);
  return WiFi.status() == WL_CONNECTED;
}

// ============================================================
// MQTT
// ============================================================
bool TSIX::begin()
{
  instance = this;
  mqttClient.setServer(mqttServer, mqttPort);
  mqttClient.setCallback(mqttCallback);
  // Buffer besar untuk menerima chunk OTA biner (sampai ~6KB).
  mqttClient.setBufferSize(6144);
  connectMQTT();
  return mqttClient.connected();
}

void TSIX::loop()
{
  if (!mqttClient.connected())
  {
    static uint32_t lastTry = 0;
    uint32_t now = millis();
    if (now - lastTry > 5000)
    {
      lastTry = now;
      connectMQTT();
    }
    return;
  }
  mqttClient.loop();
}

void TSIX::connectMQTT()
{
  if (mqttClient.connected())
    return;
  if (!mqttClient.connect(id.c_str()))
    return;

  // Subscribe kanal v1.0 (JSON terenkripsi), v1.1 (biner/OTA), v1.2 (Binfeo)
  String t;
  t = "mqtnl@1.0/" + id;   mqttClient.subscribe(t.c_str());
  t = "mqtnl@1.0/*";       mqttClient.subscribe(t.c_str());
  t = "mqtnl@1.1/" + id;   mqttClient.subscribe(t.c_str());
  t = "mqtnl@1.1/*";       mqttClient.subscribe(t.c_str());
  t = "mqtnl@1.2/" + id;   mqttClient.subscribe(t.c_str());
  t = "mqtnl@1.2/*";       mqttClient.subscribe(t.c_str());
}

// ============================================================
// Crypto (ChaCha20-Poly1305)
// ============================================================
bool TSIX::encrypt(const uint8_t *in, uint8_t *out, const uint8_t *nonce, size_t len)
{
  ChaChaPoly chacha;
  chacha.clear();
  chacha.setKey(keyBytes, TSIX_KEY_SIZE);
  chacha.setIV(nonce, TSIX_NONCE_SIZE);
  chacha.encrypt(out, in, len);
  chacha.computeTag(tag, sizeof(tag));
  return true;
}

bool TSIX::decrypt(const uint8_t *in, uint8_t *out, const uint8_t *nonce, const uint8_t *tagBytes, size_t len)
{
  ChaChaPoly chacha;
  chacha.clear();
  chacha.setKey(keyBytes, TSIX_KEY_SIZE);
  chacha.setIV(nonce, TSIX_NONCE_SIZE);
  chacha.decrypt(out, in, len);
  uint8_t verify[TSIX_TAG_SIZE];
  chacha.computeTag(verify, sizeof(verify));
  return memcmp(tagBytes, verify, TSIX_TAG_SIZE) == 0;
}

// ============================================================
// Kanal v1.0 — JSON terenkripsi
// ============================================================
bool TSIX::sendEncrypted(const char *dstAddress, int dstPort, const char *payload)
{
  if (!mqttClient.connected() || !payload)
    return false;

  size_t payloadLen = strlen(payload);
  if (payloadLen > 4096)
    return false; // guard — untuk data besar pakai sendRaw (biner)

  uint8_t nonce[TSIX_NONCE_SIZE];
  randomBytes(nonce, sizeof(nonce));

  uint8_t *cipher = (uint8_t *)malloc(payloadLen ? payloadLen : 1);
  if (!cipher)
    return false;
  encrypt((const uint8_t *)payload, cipher, nonce, payloadLen);

  // payloadHex = nonceHex(24) + tagHex(32) + cipherHex(2*len)
  size_t hexLen = TSIX_NONCE_SIZE * 2 + TSIX_TAG_SIZE * 2 + payloadLen * 2;
  char *payloadHex = (char *)malloc(hexLen + 1);
  if (!payloadHex)
  {
    free(cipher);
    return false;
  }
  char nonceHex[TSIX_NONCE_SIZE * 2 + 1];
  char tagHex[TSIX_TAG_SIZE * 2 + 1];
  bytesToHex(nonce, TSIX_NONCE_SIZE, nonceHex, sizeof(nonceHex));
  bytesToHex(tag, TSIX_TAG_SIZE, tagHex, sizeof(tagHex));
  char *p = payloadHex;
  memcpy(p, nonceHex, TSIX_NONCE_SIZE * 2); p += TSIX_NONCE_SIZE * 2;
  memcpy(p, tagHex, TSIX_TAG_SIZE * 2);     p += TSIX_TAG_SIZE * 2;
  bytesToHex(cipher, payloadLen, p, hexLen - TSIX_NONCE_SIZE * 2 - TSIX_TAG_SIZE * 2 + 1);
  free(cipher);

  // Format JSON MQTNL v1.0: [src,srcPort,dst,dstPort,count,idx,size,flag,fwd,"hex"]
  size_t jsonCap = 64 + id.length() + strlen(dstAddress) + hexLen;
  char *json = (char *)malloc(jsonCap);
  if (!json)
  {
    free(payloadHex);
    return false;
  }
  snprintf(json, jsonCap, "[\"%s\",%u,\"%s\",%d,1,0,%u,0,0,\"%s\"]",
           id.c_str(), (unsigned)port, dstAddress, dstPort, (unsigned)hexLen, payloadHex);

  String topic = "mqtnl@1.0/";
  topic += dstAddress;
  bool ok = mqttClient.beginPublish(topic.c_str(), strlen(json), false) &&
            mqttClient.write((uint8_t *)json, strlen(json)) == strlen(json) &&
            mqttClient.endPublish();

  free(payloadHex);
  free(json);
  return ok;
}

// ============================================================
// Kanal v1.1 — biner plain (OTA / raw) & v1.2 — biner tersandi (Binfeo)
// ============================================================
bool TSIX::sendRaw(const char *dstAddress, int dstPort, const uint8_t *payload, size_t length)
{
  return publishBinary("mqtnl@1.1/", TSIX_MAGIC_RAW, dstAddress, dstPort, TSIX_FLAG_DATA, payload, length);
}

bool TSIX::sendBinfeo(const char *dstAddress, int dstPort, const uint8_t *payload, size_t length)
{
  if (!mqttClient.connected())
    return false;

  // Enkripsi payload → wire berisi nonce[12] + tag[16] + cipher (RAW bytes,
  // bukan hex) — format yang sama dgn server Binfeo (securePacketOutRaw).
  uint8_t nonce[TSIX_NONCE_SIZE];
  randomBytes(nonce, sizeof(nonce));
  uint8_t *cipher = (uint8_t *)malloc(length ? length : 1);
  if (!cipher)
    return false;
  encrypt(payload, cipher, nonce, length); // set member `tag`

  size_t bodyLen = TSIX_NONCE_SIZE + TSIX_TAG_SIZE + length;
  uint8_t *body = (uint8_t *)malloc(bodyLen ? bodyLen : 1);
  if (!body)
  {
    free(cipher);
    return false;
  }
  memcpy(body, nonce, TSIX_NONCE_SIZE);
  memcpy(body + TSIX_NONCE_SIZE, tag, TSIX_TAG_SIZE);
  if (length)
    memcpy(body + TSIX_NONCE_SIZE + TSIX_TAG_SIZE, cipher, length);
  free(cipher);

  bool ok = publishBinary("mqtnl@1.2/", TSIX_MAGIC_BINFEO, dstAddress, dstPort, TSIX_FLAG_DATA, body, bodyLen);
  free(body);
  return ok;
}

bool TSIX::publishBinary(const char *topicPrefix, uint8_t magic, const char *dstAddress,
                         int dstPort, uint8_t flag, const uint8_t *payload, size_t length)
{
  if (!mqttClient.connected())
    return false;

  size_t sAddrLen = id.length();
  size_t dAddrLen = strlen(dstAddress);
  size_t headerSize = 2 + 1 + sAddrLen + 2 + 1 + dAddrLen + 2 + 2 + 2 + 4 + 1 + 1;
  size_t totalLen = headerSize + length;

  String topic = topicPrefix;
  topic += dstAddress;

  if (!mqttClient.beginPublish(topic.c_str(), totalLen, false))
    return false;

  mqttClient.write(magic);                    // Magic (0x42 OTA / 0x66 Binfeo)
  mqttClient.write(0x01);                     // Proto ver
  mqttClient.write((uint8_t)sAddrLen);        // src len
  mqttClient.print(id);                       // src addr
  mqttClient.write((uint8_t)(port & 0xFF));   // src port LE
  mqttClient.write((uint8_t)((port >> 8) & 0xFF));
  mqttClient.write((uint8_t)dAddrLen);        // dst len
  mqttClient.print(dstAddress);               // dst addr
  mqttClient.write((uint8_t)(dstPort & 0xFF));// dst port LE
  mqttClient.write((uint8_t)((dstPort >> 8) & 0xFF));
  mqttClient.write(0x01); mqttClient.write(0x00); // packetCount=1, index=0
  mqttClient.write(0x00); mqttClient.write(0x00); // (index word, 2 byte)
  // dataSize (payload) 4 byte LE
  uint32_t ds = (uint32_t)length;
  mqttClient.write((uint8_t)(ds & 0xFF));
  mqttClient.write((uint8_t)((ds >> 8) & 0xFF));
  mqttClient.write((uint8_t)((ds >> 16) & 0xFF));
  mqttClient.write((uint8_t)((ds >> 24) & 0xFF));
  mqttClient.write(flag);                      // flag (DATA / PING_REPLY / dll)
  mqttClient.write(0x00);                     // forwarded
  if (length)
    mqttClient.write(payload, length);        // payload

  return mqttClient.endPublish();
}

void TSIX::sendPongBinfeo(const char *dstAddress, int dstPort, uint8_t flag)
{
  if (!mqttClient.connected())
    return;
  publishBinary("mqtnl@1.2/", TSIX_MAGIC_BINFEO, dstAddress, dstPort, flag, nullptr, 0);
}

void TSIX::sendPongRaw(const char *dstAddress, int dstPort, uint8_t flag)
{
  if (!mqttClient.connected())
    return;
  publishBinary("mqtnl@1.1/", TSIX_MAGIC_RAW, dstAddress, dstPort, flag, nullptr, 0);
}

// ============================================================
// Dispatch incoming
// ============================================================
void TSIX::mqttCallback(char *topic, byte *payload, unsigned int length)
{
  if (!instance)
    return;
  if (strstr(topic, "mqtnl@1.2/"))
    instance->handleV12(topic, payload, length);
  else if (strstr(topic, "mqtnl@1.1/"))
    instance->handleV11(topic, payload, length);
  else
    instance->handleV1(topic, payload, length);
}

void TSIX::handleV1(const char *topic, byte *payload, unsigned int length)
{
  if (length < 4)
    return;
  if (payload[0] != '[')
    return; // bukan JSON MQTNL

  char *buf = (char *)malloc(length + 1);
  if (!buf)
    return;
  memcpy(buf, payload, length);
  buf[length] = '\0';

  // Bersihkan [ ]
  char *json = buf;
  if (json[0] == '[') json++;
  size_t l = strlen(json);
  if (l && json[l - 1] == ']') json[l - 1] = '\0';

  const char *srcAddress = nullptr;
  int srcPort = 0;
  const char *dstAddress = nullptr;
  int dstPort = 0;
  int flag = 0;
  const char *message = nullptr;
  int index = 0;

  char *token = strtok(json, ",");
  while (token)
  {
    while (*token == ' ' || *token == '"') token++;
    char *end = token + strlen(token) - 1;
    while (end >= token && (*end == '"' || *end == ' ')) { *end = '\0'; end--; }

    switch (index)
    {
      case 0: srcAddress = token; break;
      case 1: srcPort = atoi(token); break;
      case 2: dstAddress = token; break;
      case 3: dstPort = atoi(token); break;
      case 7: flag = atoi(token); break;
      case 9: message = token; break;
    }
    token = strtok(nullptr, ",");
    index++;
  }

  // PING / BROADCAST_SCAN → balas otomatis
  if (flag == TSIX_FLAG_PING_REQUEST && dstPort == TSIX_PING_PORT)
    sendPong(srcAddress ? srcAddress : "", srcPort, TSIX_FLAG_PING_REPLY);
  if (flag == TSIX_FLAG_BROADCAST_PING && dstPort == TSIX_BROADCAST_PORT)
    sendPong(srcAddress ? srcAddress : "", srcPort, TSIX_FLAG_BROADCAST_REPLY);

  // Dekripsi hanya kalau paket memang untuk node ini
  if (message && dstAddress && strcmp(dstAddress, id.c_str()) == 0 && dstPort == (int)port)
  {
    size_t hexLen = strlen(message);
    if (hexLen < (TSIX_NONCE_SIZE + TSIX_TAG_SIZE) * 2)
    {
      free(buf);
      return;
    }
    const int NONCE_HL = TSIX_NONCE_SIZE * 2;
    const int TAG_HL = TSIX_TAG_SIZE * 2;
    int cipherLen = (int)(hexLen - NONCE_HL - TAG_HL) / 2;

    uint8_t nonceBytes[TSIX_NONCE_SIZE];
    uint8_t tagBytes[TSIX_TAG_SIZE];
    uint8_t *cipherBytes = (uint8_t *)malloc(cipherLen ? cipherLen : 1);
    uint8_t *decrypted = (uint8_t *)malloc(cipherLen + 1);
    if (!cipherBytes || !decrypted)
    {
      free(cipherBytes);
      free(decrypted);
      free(buf);
      return;
    }

    for (int i = 0; i < TSIX_NONCE_SIZE; i++)
    {
      char bs[3] = {message[i * 2], message[i * 2 + 1], '\0'};
      nonceBytes[i] = (uint8_t)strtoul(bs, nullptr, 16);
    }
    for (int i = 0; i < TSIX_TAG_SIZE; i++)
    {
      char bs[3] = {message[NONCE_HL + i * 2], message[NONCE_HL + i * 2 + 1], '\0'};
      tagBytes[i] = (uint8_t)strtoul(bs, nullptr, 16);
    }
    for (int i = 0; i < cipherLen; i++)
    {
      char bs[3] = {message[NONCE_HL + TAG_HL + i * 2], message[NONCE_HL + TAG_HL + i * 2 + 1], '\0'};
      cipherBytes[i] = (uint8_t)strtoul(bs, nullptr, 16);
    }

    if (decrypt(cipherBytes, decrypted, nonceBytes, tagBytes, cipherLen))
    {
      decrypted[cipherLen] = '\0';
      if (encCb)
        encCb(srcAddress, srcPort, (char *)decrypted);
    }
    free(cipherBytes);
    free(decrypted);
  }
  free(buf);
}

void TSIX::handleV11(const char *topic, byte *payload, unsigned int length)
{
  // Deteksi paket biner MQTNL v1.1 (magic 0x42, ver 0x01)
  if (length < 2 || payload[0] != 0x42 || payload[1] != 0x01)
    return;

  size_t offset = 2;
  uint8_t sAddrLen = payload[offset++];
  if (offset + sAddrLen + 2 + 1 > length)
    return;
  char srcAddress[32] = {0};
  if (sAddrLen < sizeof(srcAddress))
  {
    memcpy(srcAddress, payload + offset, sAddrLen);
    offset += sAddrLen;
  }
  uint16_t srcPort = payload[offset] | (payload[offset + 1] << 8);
  offset += 2;

  uint8_t dAddrLen = payload[offset++];
  if (offset + dAddrLen + 2 + 4 + 4 + 1 + 1 > length)
    return;
  char dstAddress[32] = {0};
  if (dAddrLen < sizeof(dstAddress))
  {
    memcpy(dstAddress, payload + offset, dAddrLen);
    offset += dAddrLen;
  }
  uint16_t dstPort = payload[offset] | (payload[offset + 1] << 8);
  offset += 2;
  offset += 2; // packetCount(2)
  offset += 2; // packetIndex(2)
  offset += 4; // dataSize(4)
  if (offset + 2 > length)
    return;
  uint8_t pktFlag = payload[offset]; // flag
  offset += 2; // flag(1) + forwarded(1)

  size_t dataLen = length - offset;

  // PING / BROADCAST_SCAN → balas otomatis (kebutuhan dasar MQTNL, jangan diganggu)
  if (pktFlag == TSIX_FLAG_PING_REQUEST && dstPort == TSIX_PING_PORT)
  {
    sendPongRaw(srcAddress, srcPort, TSIX_FLAG_PING_REPLY);
    return;
  }
  if (pktFlag == TSIX_FLAG_BROADCAST_PING && dstPort == TSIX_BROADCAST_PORT)
  {
    sendPongRaw(srcAddress, srcPort, TSIX_FLAG_BROADCAST_REPLY);
    return;
  }

  // Hanya proses kalau paket untuk node ini (atau broadcast "*")
  if (dstAddress[0] && strcmp(dstAddress, id.c_str()) != 0 && strcmp(dstAddress, "*") != 0)
    return;

  if (rawCb)
    rawCb(srcAddress, srcPort, payload + offset, dataLen);
}

void TSIX::handleV12(const char *topic, byte *payload, unsigned int length)
{
  // Paket biner Binfeo (magic 0x66, ver 0x01) — payload = nonce[12]+tag[16]+cipher
  if (length < 2 || payload[0] != TSIX_MAGIC_BINFEO || payload[1] != 0x01)
    return;

  size_t offset = 2;
  uint8_t sAddrLen = payload[offset++];
  if (offset + sAddrLen + 2 + 1 > length)
    return;
  char srcAddress[32] = {0};
  if (sAddrLen < sizeof(srcAddress))
  {
    memcpy(srcAddress, payload + offset, sAddrLen);
    offset += sAddrLen;
  }
  uint16_t srcPort = payload[offset] | (payload[offset + 1] << 8);
  offset += 2;

  uint8_t dAddrLen = payload[offset++];
  if (offset + dAddrLen + 2 + 4 + 4 + 1 + 1 > length)
    return;
  char dstAddress[32] = {0};
  if (dAddrLen < sizeof(dstAddress))
  {
    memcpy(dstAddress, payload + offset, dAddrLen);
    offset += dAddrLen;
  }
  uint16_t dstPort = payload[offset] | (payload[offset + 1] << 8);
  offset += 2;
  offset += 2; // packetCount(2)
  offset += 2; // packetIndex(2)
  offset += 4; // dataSize(4)
  if (offset + 2 > length)
    return;
  uint8_t pktFlag = payload[offset]; // flag
  offset += 2; // flag(1) + forwarded(1)

  size_t dataLen = length - offset;

  // PING / BROADCAST_SCAN → balas otomatis (kebutuhan dasar MQTNL, jangan diganggu)
  if (pktFlag == TSIX_FLAG_PING_REQUEST && dstPort == TSIX_PING_PORT)
  {
    sendPongBinfeo(srcAddress, srcPort, TSIX_FLAG_PING_REPLY);
    return;
  }
  if (pktFlag == TSIX_FLAG_BROADCAST_PING && dstPort == TSIX_BROADCAST_PORT)
  {
    sendPongBinfeo(srcAddress, srcPort, TSIX_FLAG_BROADCAST_REPLY);
    return;
  }

  if (dstAddress[0] && strcmp(dstAddress, id.c_str()) != 0 && strcmp(dstAddress, "*") != 0)
    return;

  // Payload = nonce[12] + tag[16] + cipher → dekripsi → callback byte mentah
  if (dataLen < TSIX_NONCE_SIZE + TSIX_TAG_SIZE)
    return;
  const uint8_t *body = payload + offset;
  size_t cipherLen = dataLen - TSIX_NONCE_SIZE - TSIX_TAG_SIZE;
  uint8_t *plain = (uint8_t *)malloc(cipherLen + 1);
  if (!plain)
    return;
  bool ok = decrypt(body + TSIX_NONCE_SIZE + TSIX_TAG_SIZE, plain, body,
                    body + TSIX_NONCE_SIZE, cipherLen);
  if (ok && binfeoCb)
  {
    plain[cipherLen] = '\0';
    binfeoCb(srcAddress, srcPort, plain, cipherLen);
  }
  free(plain);
}

void TSIX::sendPong(const char *dstAddress, int dstPort, uint8_t flag)
{
  if (!mqttClient.connected())
    return;
  char json[128];
  snprintf(json, sizeof(json), "[\"%s\",%u,\"%s\",%d,1,0,0,%u,0,\"\"]",
           id.c_str(), (unsigned)port, dstAddress, dstPort, (unsigned)flag);
  String topic = "mqtnl@1.0/";
  topic += dstAddress;
  mqttClient.beginPublish(topic.c_str(), strlen(json), false);
  mqttClient.write((uint8_t *)json, strlen(json));
  mqttClient.endPublish();
}
