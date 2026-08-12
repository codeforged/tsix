#include "noslib.h"

// Buffer statis untuk konversi hex (hemat memori)
static const char hex_chars[] = "0123456789abcdef";

#define DEBUG_LOG false
NOS *NOS::instance = nullptr;

NOS::NOS(const char *id, const uint16_t port, const char *key, const char *mqttServer, int mqttPort)
    : id(id), port(port), key(key), mqttServer(mqttServer), mqttPort(mqttPort), mqttClient(espClient)
{
}

// Implementasi fungsi init yang kita panggil di main.cpp
void NOS::init(const char *id, const uint16_t port, const char *key, const char *mqttServer, int mqttPort)
{
    // Salin nilai dinamis ke member kelas
    this->id = id;
    this->port = port;
    this->key = key;
    this->mqttServer = mqttServer;

    // Set server dan callback lagi (diperlukan PubSubClient)
    mqttClient.setServer(mqttServer, mqttPort);
    mqttClient.setCallback(mqttCallback);
}

bool NOS::begin()
{
    instance = this;
    mqttClient.setServer(mqttServer, mqttPort);
    mqttClient.setCallback(mqttCallback);

    // [OPTIMASI] SET BUFFER MQTT LEBIH BESAR (6KB Hammer)
    // 2048 kadang masih mepet kalau enkripsi hex membengkak.
    // Kita pakai 6144 (6KB) agar aman sentosa. Heap ESP8266 masih sangat cukup.
    mqttClient.setBufferSize(6144);

    if (DEBUG_LOG == 1)
        Serial.println("✓ MQTT buffer size set to 6144 bytes");

    connectMQTT();
    return true;
}

void NOS::loop()
{
    if (!mqttClient.connected())
    {
        connectMQTT();
    }
    mqttClient.loop();
}

// [OPTIMASI STREAMING] Kirim paket tanpa buffer raksasa
void NOS::sendPacket(const char *dstAddress, int dstPort, const char *payload)
{
    if (DEBUG_LOG == 1)
    {
        Serial.print("📤 Send -> ");
        Serial.println(dstAddress);
    }

    size_t payloadLen = strlen(payload);
    size_t encryptedLen = payloadLen + 1;

    // 1. Siapkan Buffer Enkripsi (Heap)
    uint8_t *encrypted = (uint8_t *)malloc(encryptedLen);
    if (!encrypted)
    {
        if (DEBUG_LOG == 1)
            Serial.println("❌ Malloc fail (send)");
        return;
    }

    // 2. Generate Nonce
    uint8_t nonceRandom[12];
    for (int i = 0; i < 12; i++)
        nonceRandom[i] = random(0, 255);

    // 3. Enkripsi
    encryptData((uint8_t *)payload, encrypted, nonceRandom, encryptedLen);

    // 4. Hitung Panjang Paket Final (Manual)
    String headerPart = "[\"" + id + "\"," + String(port) + ",\"" + String(dstAddress) + "\"," + String(dstPort) + ",1,0,10,0,0,\"";
    size_t hexDataLen = (12 + 16 + encryptedLen) * 2;
    String footerPart = "\"]";

    size_t totalPacketLen = headerPart.length() + hexDataLen + footerPart.length();

    // 5. Kirim via MQTT Streaming
    String topic = "mqtnl@1.0/" + String(dstAddress);

    if (mqttClient.beginPublish(topic.c_str(), totalPacketLen, false))
    {
        // A. Kirim Header
        mqttClient.print(headerPart);

        // B. Stream Nonce (Hex)
        for (size_t i = 0; i < 12; i++)
        {
            mqttClient.write(hex_chars[(nonceRandom[i] >> 4) & 0xF]);
            mqttClient.write(hex_chars[nonceRandom[i] & 0xF]);
        }

        // C. Stream Tag (Hex)
        for (size_t i = 0; i < 16; i++)
        {
            mqttClient.write(hex_chars[(tag[i] >> 4) & 0xF]);
            mqttClient.write(hex_chars[tag[i] & 0xF]);
        }

        // D. Stream Encrypted Payload (Hex)
        for (size_t i = 0; i < encryptedLen; i++)
        {
            mqttClient.write(hex_chars[(encrypted[i] >> 4) & 0xF]);
            mqttClient.write(hex_chars[encrypted[i] & 0xF]);
        }

        // E. Kirim Footer
        mqttClient.print(footerPart);
        mqttClient.endPublish();
    }
    else
    {
        if (DEBUG_LOG == 1)
            Serial.println("❌ MQTT beginPublish Fail (Packet too big?)");
    }

    free(encrypted);
}

void NOS::onMessage(void (*callback)(const char *srcAddress, int srcPort, const char *payload))
{
    messageCallback = callback;
}

void NOS::connectMQTT()
{
    if (!mqttClient.connected())
    {
        if (mqttClient.connect(id.c_str()))
        {
            String topic = "mqtnl@1.0/" + id;
            mqttClient.subscribe(topic.c_str());
            topic = "mqtnl@1.0/*";
            mqttClient.subscribe(topic.c_str());
            if (DEBUG_LOG == 1)
                Serial.println("✓ MQTT Connected");
        }
    }
}

void NOS::mqttCallback(char *topic, byte *payload, unsigned int length)
{
    if (length == 0)
        return;

    // Gunakan Heap untuk buffer terima
    char *buffer = (char *)malloc(length + 1);
    if (!buffer)
        return;

    memcpy(buffer, payload, length);
    buffer[length] = '\0';

    char *json = buffer;
    if (json[0] == '[')
        json++;
    size_t jlen = strlen(json);
    if (jlen > 0 && json[jlen - 1] == ']')
        json[jlen - 1] = '\0';

    char *token;
    int index = 0;

    const char *srcAddress = nullptr;
    int srcPort = 0;
    const char *dstAddress = nullptr;
    int dstPort = 0;
    int packetHeaderFlag = 0;
    const char *message = nullptr;

    token = strtok(json, ",");
    while (token != NULL)
    {
        while (*token == ' ' || *token == '\"')
            token++;
        char *end = token + strlen(token) - 1;
        while (end > token && (*end == '\"' || *end == ' '))
        {
            *end = '\0';
            end--;
        }

        switch (index)
        {
        case 0:
            srcAddress = token;
            break;
        case 1:
            srcPort = atoi(token);
            break;
        case 2:
            dstAddress = token;
            break;
        case 3:
            dstPort = atoi(token);
            break;
        case 7:
            packetHeaderFlag = atoi(token);
            break;
        case 9:
            message = token;
            break;
        }
        token = strtok(NULL, ",");
        index++;
    }

    // Handler: PING / SCAN / DATA
    if (packetHeaderFlag == 1 && dstPort == 65535 && srcAddress)
    {
        char pongData[128];
        snprintf(pongData, sizeof(pongData), "[\"%s\",%d,\"%s\",%d,1,0,10,2,0,\"\"]",
                 instance->id.c_str(), instance->port, srcAddress, srcPort);
        instance->mqttClient.publish(("mqtnl@1.0/" + String(srcAddress)).c_str(), pongData);
    }
    else if (packetHeaderFlag == 3 && dstPort == 65534 && srcAddress)
    {
        char pongData[128];
        snprintf(pongData, sizeof(pongData), "[\"%s\",%d,\"%s\",%d,1,0,10,4,0,\"\"]",
                 instance->id.c_str(), instance->port, srcAddress, srcPort);
        instance->mqttClient.publish(("mqtnl@1.0/" + String(srcAddress)).c_str(), pongData);
    }
    else if (message)
    {
        size_t hexLen = strlen(message);
        if (hexLen >= 24 + TAG_SIZE * 2)
        {
            const int NONCE_HEX_LEN = NONCE_SIZE * 2;
            const int TAG_HEX_LEN = TAG_SIZE * 2;
            const int CIPHER_HEX_LEN = hexLen - NONCE_HEX_LEN - TAG_HEX_LEN;
            int cipherLen = CIPHER_HEX_LEN / 2;

            uint8_t *cipherBytes = (uint8_t *)malloc(cipherLen);
            uint8_t *decrypted = (uint8_t *)malloc(cipherLen + 1);

            if (cipherBytes && decrypted)
            {
                uint8_t nonceBytes[NONCE_SIZE];
                for (int i = 0; i < NONCE_SIZE; i++)
                {
                    char b[3] = {message[i * 2], message[i * 2 + 1], 0};
                    nonceBytes[i] = strtoul(b, NULL, 16);
                }
                uint8_t tagBytes[TAG_SIZE];
                for (int i = 0; i < TAG_SIZE; i++)
                {
                    int s = NONCE_HEX_LEN + i * 2;
                    char b[3] = {message[s], message[s + 1], 0};
                    tagBytes[i] = strtoul(b, NULL, 16);
                }
                for (int i = 0; i < cipherLen; i++)
                {
                    int s = NONCE_HEX_LEN + TAG_HEX_LEN + i * 2;
                    char b[3] = {message[s], message[s + 1], 0};
                    cipherBytes[i] = strtoul(b, NULL, 16);
                }

                if (instance->decryptData(cipherBytes, decrypted, nonceBytes, tagBytes, cipherLen))
                {
                    decrypted[cipherLen] = '\0';
                    if (instance->messageCallback && dstAddress)
                    {
                        if (strcmp(dstAddress, instance->id.c_str()) == 0 && dstPort == instance->port)
                        {
                            instance->messageCallback(srcAddress, srcPort, (char *)decrypted);
                        }
                    }
                }
            }
            if (cipherBytes)
                free(cipherBytes);
            if (decrypted)
                free(decrypted);
        }
    }
    free(buffer);
}

void NOS::encryptData(const uint8_t *input, uint8_t *output, const uint8_t *vnonce, size_t length)
{
    ChaChaPoly chacha;
    chacha.clear();
    chacha.setKey((uint8_t *)key, KEY_SIZE);
    chacha.setIV(vnonce, NONCE_SIZE);
    chacha.encrypt(output, input, length);
    chacha.computeTag(tag, sizeof(tag));
}

bool NOS::decryptData(const uint8_t *input, uint8_t *output, const uint8_t *vnonce, uint8_t *tagBytes, size_t length)
{
    ChaChaPoly chacha;
    chacha.clear();
    chacha.setKey((uint8_t *)key, KEY_SIZE);
    chacha.setIV(vnonce, NONCE_SIZE);
    chacha.decrypt(output, input, length);
    uint8_t verifyTag[16];
    chacha.computeTag(verifyTag, sizeof(verifyTag));
    return (memcmp(tagBytes, verifyTag, 16) == 0);
}
