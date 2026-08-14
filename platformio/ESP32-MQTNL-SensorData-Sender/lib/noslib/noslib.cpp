#include "noslib.h"

NOS* NOS::instance = nullptr; 

NOS::NOS(const char* id, const uint16_t port, const char* key, const char* mqttServer, int mqttPort)
    : id(id), port(port), key(key), mqttServer(mqttServer), mqttPort(mqttPort), mqttClient(espClient) {
}

bool NOS::begin() {
    instance = this;  // Simpan instance saat `begin()` dipanggil
    // bool connected = connectWiFi(ssid, password);
    // if (!connected) return false;

    // // connectMQTT();

    // connectWiFi(ssid, password);
    mqttClient.setServer(mqttServer, mqttPort);
    mqttClient.setCallback(mqttCallback);
    connectMQTT();

    return true;
}

void NOS::loop() {
    if (!mqttClient.connected()) {
        uint32_t now = millis();
        if (now - lastReconnectAttempt > 5000) {
            lastReconnectAttempt = now;
            if (connectMQTT()) {
                lastReconnectAttempt = 0;
            }
        }
    } else {
        mqttClient.loop();
    }
}

void NOS::sendPacket(const char* dstAddress, int dstPort, const char* payload) {
    if (!mqttClient.connected()) return;

    static const char hexChars[] = "0123456789abcdef";
    unsigned int length = strlen(payload) + 1;
    uint8_t encrypted[length];
    uint8_t nonceRandom[12];
    
    // Use hardware RNG for security
    for (int i = 0; i < 12; i++) {
#ifdef ESP8266
        nonceRandom[i] = (uint8_t)random(256);
#else
        nonceRandom[i] = (uint8_t)esp_random();
#endif
    }
    
    encryptData((uint8_t *)payload, encrypted, nonceRandom, length);

    char outputHEX[length * 2 + 1];
    for (size_t i = 0; i < length; i++) {
        outputHEX[i * 2] = hexChars[(encrypted[i] >> 4) & 0x0F];
        outputHEX[i * 2 + 1] = hexChars[encrypted[i] & 0x0F];
    }
    outputHEX[length * 2] = '\0';

    char nonceHEX[12 * 2 + 1];
    for (size_t i = 0; i < 12; i++) {
        nonceHEX[i * 2] = hexChars[(nonceRandom[i] >> 4) & 0x0F];
        nonceHEX[i * 2 + 1] = hexChars[nonceRandom[i] & 0x0F];
    }
    nonceHEX[12 * 2] = '\0';

    char tagHEX[16 * 2 + 1];
    for (size_t i = 0; i < 16; i++) {
        tagHEX[i * 2] = hexChars[(tag[i] >> 4) & 0x0F];
        tagHEX[i * 2 + 1] = hexChars[tag[i] & 0x0F];
    }
    tagHEX[16 * 2] = '\0';

    char data[256];
    snprintf(data, sizeof(data), "[\"%s\",%d,\"%s\",%d,1,0,10,0,0,\"%s%s%s\"]", 
             id.c_str(), port, dstAddress, dstPort, nonceHEX, tagHEX, outputHEX);

    char pubStr[64];
    snprintf(pubStr, sizeof(pubStr), "mqtnl@1.0/%s", dstAddress);
    
    mqttClient.publish(pubStr, data);
}

void NOS::onMessage(void (*callback)(const char* srcAddress, int srcPort, const char* payload)) {
    messageCallback = callback;
}

bool NOS::connectMQTT() {
    if (!mqttClient.connected()) {
        if (mqttClient.connect(id.c_str())) {
            String topic = "mqtnl@1.0/" + id;
            mqttClient.subscribe(topic.c_str());
            topic = "mqtnl@1.0/*";
            mqttClient.subscribe(topic.c_str());
            return true;
        }
    }
    return false;
}

void NOS::mqttCallback(char* topic, byte* payload, unsigned int length) {
    // Salin payload ke buffer yang bisa dimodifikasi
    char buffer[512];
    if (length >= sizeof(buffer)) return;  // Hindari overflow

    memcpy(buffer, payload, length);
    buffer[length] = '\0'; // null-terminate string

    // Bersihkan tanda kurung siku [ ]
    char* json = buffer;
    if (json[0] == '[') json++;
    if (json[strlen(json)-1] == ']') json[strlen(json)-1] = '\0';

    // Tokenisasi berdasarkan koma
    char* token;
    int index = 0;

    const char* srcAddress = nullptr;
    int srcPort = 0;
    const char* dstAddress = nullptr;
    int dstPort = 0;
    int packetHeaderFlag = 0;
    const char* message = nullptr;

    token = strtok(json, ",");
    while (token != NULL) {
    // Buang whitespace depan
    while (*token == ' ' || *token == '\"') token++;

    // Buang kutip & spasi belakang
    char* end = token + strlen(token) - 1;
    while (*end == '\"' || *end == ' ') { *end = '\0'; end--; }

    switch (index) {
      case 0: srcAddress = token; break;
      case 1: srcPort = atoi(token); break;
      case 2: dstAddress = token; break;
      case 3: dstPort = atoi(token); break;
      case 7: packetHeaderFlag = atoi(token); break;
      case 9: message = token; break;
    }

    token = strtok(NULL, ",");
    index++;
    }

    // Cek jika ini ping
    if (packetHeaderFlag == 1 && dstPort == 65535) {
        char pongData[100];
        sprintf(pongData, "[\"%s\",%d,\"%s\",%d,1,0,10,2,0,\"\"]", 
                instance->id.c_str(),
                instance->port,
                srcAddress,
                srcPort,
                millis());

        String pongTopic = "mqtnl@1.0/";
        pongTopic += String(srcAddress);
        instance->mqttClient.publish(pongTopic.c_str(), pongData);
        // return;
    }

    // Cek jika ini scan
    if (packetHeaderFlag == 3 && dstPort == 65534) {
        char pongData[100];
        sprintf(pongData, "[\"%s\",%d,\"%s\",%d,1,0,10,4,0,\"\"]", 
                instance->id.c_str(),
                instance->port,
                srcAddress,
                srcPort,
                millis());

        String pongTopic = "mqtnl@1.0/";
        pongTopic += String(srcAddress);
        instance->mqttClient.publish(pongTopic.c_str(), pongData);
        // return;
    }

    if (message) {
        size_t hexLen = strlen(message);
        if (hexLen < 24 + TAG_SIZE * 2) return; // Validasi minimum: nonce (12 byte) + tag (16 byte) = 28 byte (56 hex char)

        const int NONCE_HEX_LEN = NONCE_SIZE * 2; // 24 hex
        const int TAG_HEX_LEN = TAG_SIZE * 2;     // 32 hex
        const int CIPHER_HEX_LEN = hexLen - NONCE_HEX_LEN - TAG_HEX_LEN;

        // 1. Ambil nonce dari awal
        uint8_t nonceBytes[NONCE_SIZE];
        for (int i = 0; i < NONCE_SIZE; i++) {
            char byteStr[3] = { message[i * 2], message[i * 2 + 1], '\0' };
            nonceBytes[i] = strtoul(byteStr, NULL, 16);
        }

        // 2. Ambil tag dari posisi setelah nonce
        uint8_t tagBytes[TAG_SIZE];
        for (int i = 0; i < TAG_SIZE; i++) {
            int tagStart = NONCE_HEX_LEN + i * 2;
            char byteStr[3] = { message[tagStart], message[tagStart + 1], '\0' };
            tagBytes[i] = strtoul(byteStr, NULL, 16);
        }

        // 3. Ambil ciphertext dari posisi setelah tag
        int cipherLen = CIPHER_HEX_LEN / 2;
        uint8_t cipherBytes[cipherLen];
        for (int i = 0; i < cipherLen; i++) {
            int cipherStart = NONCE_HEX_LEN + TAG_HEX_LEN + i * 2;
            char byteStr[3] = { message[cipherStart], message[cipherStart + 1], '\0' };
            cipherBytes[i] = strtoul(byteStr, NULL, 16);
        }

        // 4. Dekripsi
        uint8_t decrypted[cipherLen + 1];
        bool tagValid = instance->decryptData(cipherBytes, decrypted, nonceBytes, tagBytes, cipherLen);

        if (tagValid) {
            decrypted[cipherLen] = '\0';  // Null-terminate

            // 6. Kirim ke message handler jika alamat cocok
            if (!(instance && instance->messageCallback)) return;

            if (strcmp(dstAddress, instance->id.c_str()) == 0 &&
                dstPort == instance->port)
            {
                instance->messageCallback(srcAddress, srcPort, (char*)decrypted);
            }
        } else {
            //memcpy(decrypted, 0, sizeof(decrypted));
        }

        
    }
}

void NOS::encryptData(const uint8_t *input, uint8_t *output, const uint8_t *vnonce, size_t length) {
    ChaChaPoly chacha;
    // uint8_t gentag[16];      
    // Enkripsi
    chacha.clear();
    chacha.setKey((uint8_t*) key, KEY_SIZE);
    chacha.setIV(vnonce, NONCE_SIZE);
    chacha.encrypt(output, input, length);
    chacha.computeTag(tag, sizeof(tag));

    //memcpy(tag, gentag, sizeof(tag));
    // ChaCha chacha;
    // chacha.setKey((uint8_t*) key, KEY_SIZE);
    // chacha.setIV(vnonce, NONCE_SIZE);
    // chacha.encrypt(output, input, length);
}

bool NOS::decryptData(const uint8_t *input, uint8_t *output, const uint8_t *vnonce, uint8_t *tagBytes, size_t length) {
    ChaChaPoly chacha;
    chacha.clear();
    chacha.setKey((uint8_t*) key, KEY_SIZE);
    chacha.setIV(vnonce, NONCE_SIZE);
    uint8_t decrypted[128];
    chacha.decrypt(output, input, length);

    // Verifikasi tag (opsional tapi penting)
    uint8_t verifyTag[16];
    chacha.computeTag(verifyTag, sizeof(verifyTag));
    bool valid = (memcmp(tagBytes, verifyTag, 16) == 0);
    return valid;
    // ChaCha chacha;
    // chacha.setKey((uint8_t*) key, KEY_SIZE);
    // chacha.setIV(vnonce, NONCE_SIZE);
    // chacha.decrypt(output, input, length);
}
