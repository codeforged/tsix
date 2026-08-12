#include "tsixOTA.h"
#include <LittleFS.h>
#if defined(ESP8266)
#include <ESP8266WiFi.h>
#include <libb64/cdecode.h>
#elif defined(ESP32)
#include <WiFi.h>
#include <mbedtls/base64.h>
#endif

// ============================================================
// NOS Implementation (Plain mode, no encryption)
// ============================================================

#define DEBUG_LOG 0
TSIXSocket *TSIXSocket::instance = nullptr;

TSIXSocket::TSIXSocket(const char *id, const uint16_t port, const char *mqttServer, int mqttPort)
    : id(id), port(port), mqttServer(mqttServer), mqttPort(mqttPort), mqttClient(espClient)
{
}

void TSIXSocket::init(const char *id, const uint16_t port, const char *mqttServer, int mqttPort)
{
    this->id = id;
    this->port = port;
    this->mqttServer = mqttServer;

    mqttClient.setServer(mqttServer, mqttPort);
    mqttClient.setCallback(mqttCallback);
}

bool TSIXSocket::begin()
{
    instance = this;
    mqttClient.setServer(mqttServer, mqttPort);
    mqttClient.setCallback(mqttCallback);
    mqttClient.setBufferSize(6144);

    if (DEBUG_LOG == 1)
        Serial.println("✓ MQTT buffer size set to 6144 bytes");

    connectMQTT();
    return true;
}

void TSIXSocket::loop()
{
    if (!mqttClient.connected())
    {
        connectMQTT();
    }
    mqttClient.loop();
}

void TSIXSocket::sendPacket(const char *dstAddress, int dstPort, const char *payload)
{
    sendPacketRaw(dstAddress, dstPort, (const uint8_t *)payload, strlen(payload));
}

void TSIXSocket::sendPacketRaw(const char *dstAddress, int dstPort, const uint8_t *payload, size_t length)
{
    if (DEBUG_LOG == 1)
    {
        Serial.printf("📤 Send Raw (%u bytes) -> %s\n", length, dstAddress);
    }

    // Binary Header (MQTNL v1.1)
    size_t sAddrLen = id.length();
    size_t dAddrLen = strlen(dstAddress);
    size_t headerSize = 2 + 1 + sAddrLen + 2 + 1 + dAddrLen + 2 + 2 + 2 + 4 + 1 + 1;

    size_t totalPayloadLen = length;
    size_t totalPacketLen = headerSize + totalPayloadLen;
    String topic = "mqtnl@1.1/" + String(dstAddress);

    if (mqttClient.beginPublish(topic.c_str(), totalPacketLen, false))
    {
        // Magic Byte & Proto Ver
        mqttClient.write(0x42);
        mqttClient.write(0x01);

        // Src Address
        mqttClient.write((uint8_t)sAddrLen);
        mqttClient.print(id);
        mqttClient.write((uint8_t)(port & 0xFF));
        mqttClient.write((uint8_t)((port >> 8) & 0xFF));

        // Dst Address
        mqttClient.write((uint8_t)dAddrLen);
        mqttClient.print(dstAddress);
        mqttClient.write((uint8_t)(dstPort & 0xFF));
        mqttClient.write((uint8_t)((dstPort >> 8) & 0xFF));

        // Sequence (PacketCount, Index) - default 1/0
        mqttClient.write(0x01); mqttClient.write(0x00);
        mqttClient.write(0x00); mqttClient.write(0x00);

        // Data Size (Payload only)
        uint32_t ds = (uint32_t)totalPayloadLen;
        mqttClient.write((uint8_t)(ds & 0xFF));
        mqttClient.write((uint8_t)((ds >> 8) & 0xFF));
        mqttClient.write((uint8_t)((ds >> 16) & 0xFF));
        mqttClient.write((uint8_t)((ds >> 24) & 0xFF));

        // Flag & Forwarded
        mqttClient.write(0x0A); // FLAG_DATA
        mqttClient.write(0x00);

        // Plain payload
        mqttClient.write(payload, length);
        if (DEBUG_LOG == 1) Serial.println("  (Mode: PLAIN)");

        mqttClient.endPublish();
    }
}

void TSIXSocket::onMessage(void (*callback)(const char *srcAddress, int srcPort, const uint8_t *payload, size_t length))
{
    messageCallback = callback;
}

void TSIXSocket::connectMQTT()
{
    if (!mqttClient.connected())
    {
        // String clientId = id + "-OTA";
        if (mqttClient.connect(id.c_str()))
        {
            String topic = "mqtnl@1.1/" + id;
            mqttClient.subscribe(topic.c_str());
            topic = "mqtnl@1.1/*";
            mqttClient.subscribe(topic.c_str());
            if (DEBUG_LOG == 1)
                Serial.println("✓ MQTT v1.1 Connected & Subscribed");
        }
        else
        {
            if (DEBUG_LOG == 1)
                Serial.println("❌ MQTT Connection Failed! Check Broker IP/Port.");
        }
    }
}

void TSIXSocket::mqttCallback(char *topic, byte *payload, unsigned int length)
{
    if (length < 2) return;
    if (DEBUG_LOG == 1) Serial.printf("📥 Recv Packet (len: %d) on topic: %s\n", length, topic);

    // Detect MQTNL v1.1 Binary
    if (payload[0] == 0x42 && payload[1] == 0x01)
    {
        size_t offset = 2;

        uint8_t sAddrLen = payload[offset++];
        char srcAddress[32];
        memcpy(srcAddress, payload + offset, sAddrLen);
        srcAddress[sAddrLen] = '\0';
        offset += sAddrLen;

        uint16_t srcPort = payload[offset] | (payload[offset + 1] << 8);
        offset += 2;

        uint8_t dAddrLen = payload[offset++];
        char dstAddress[32];
        memcpy(dstAddress, payload + offset, dAddrLen);
        dstAddress[dAddrLen] = '\0';
        offset += dAddrLen;

        uint16_t dstPort = payload[offset] | (payload[offset + 1] << 8);
        offset += 2;

        if (DEBUG_LOG == 1) Serial.printf("  - MQTNL 1.1: From %s:%d -> To %s:%d\n", srcAddress, srcPort, dstAddress, dstPort);

        // Skip Count(2), Index(2)
        offset += 4;

        // Data Size(4)
        uint32_t dataSize = payload[offset] | (payload[offset+1] << 8) | (payload[offset+2] << 16) | (payload[offset+3] << 24);
        offset += 4;

        // Flag(1), Forwarded(1)
        uint8_t flag = payload[offset++];
        uint8_t forwarded = payload[offset++];

        // Plain mode only
        if (DEBUG_LOG == 1) Serial.println("  ✓ Plain Packet Received");
        if (instance->messageCallback)
        {
            if (strcmp(dstAddress, instance->id.c_str()) == 0 && dstPort == instance->port)
            {
                instance->messageCallback(srcAddress, srcPort, payload + offset, length - offset);
            }
        }
        return;
    }
}

// ============================================================
// NosOTA Implementation
// ============================================================

NosOTA::NosOTA(TSIXSocket *nos_instance)
{
    this->nos = nos_instance;
    this->state = STATE_IDLE;
    this->chunkSize = NOS_OTA_CHUNK_SIZE;
    this->decodeBuffer = nullptr;
    memset(&config, 0, sizeof(NosConfig));
}

bool NosOTA::begin()
{
    if (!LittleFS.begin())
    {
        LittleFS.format();
        if (!LittleFS.begin())
            return false;
    }
    return loadConfig();
}

void NosOTA::saveConfig()
{
    File f = LittleFS.open(CONFIG_PATH, "w");
    if (f)
    {
        f.write((uint8_t *)&config, sizeof(NosConfig));
        f.close();
        Serial.println("[NOS] Config saved to Flash.");
    }
}

bool NosOTA::loadConfig()
{
    if (!LittleFS.exists(CONFIG_PATH))
        return false;
    File f = LittleFS.open(CONFIG_PATH, "r");
    if (f)
    {
        f.read((uint8_t *)&config, sizeof(NosConfig));
        f.close();
        return true;
    }
    return false;
}

void NosOTA::setWiFi(const char *ssid, const char *pass)
{
    strncpy(config.ssid, ssid, sizeof(config.ssid));
    strncpy(config.password, pass, sizeof(config.password));
}

void NosOTA::setMQTT(const char *host, int port)
{
    strncpy(config.mqttServer, host, sizeof(config.mqttServer));
    config.mqttPort = port;
}

void NosOTA::setOTA(const char *host, int port)
{
    strncpy(config.otaHost, host, sizeof(config.otaHost));
    config.otaPort = port;
}

void NosOTA::setAK(const char *ak)
{
    strncpy(config.activationKey, ak, sizeof(config.activationKey));
}

void NosOTA::connectWiFi()
{
    if (!config.ssid[0])
    {
        Serial.println("[NOS] Error: WiFi SSID not set.");
        return;
    }
    Serial.printf("\n[NOS] Connecting to %s...", config.ssid);
    WiFi.disconnect();
    WiFi.begin(config.ssid, config.password);

    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < 15000)
    {
        delay(500);
        Serial.print(".");
    }

    if (WiFi.status() == WL_CONNECTED)
    {
        Serial.println("\n[NOS] WiFi Connected!");
        if (nos && config.mqttServer[0])
        {
            Serial.printf("[NOS] Initializing MQTNL on %s:%d\n", config.mqttServer, config.mqttPort);
            nos->init("OTA-DEVICE", 100, config.mqttServer, config.mqttPort);
            nos->begin();
        }
    }
    else
    {
        Serial.println("\n[NOS] WiFi Connection Failed.");
    }
}

void NosOTA::handleSerial()
{
    while (Serial.available())
    {
        char c = Serial.read();
        if (c == '\r' || c == '\n')
        {
            if (cmdBuf.length() > 0)
            {
                Serial.println();
                cmdBuf.trim();

                if (cmdBuf.startsWith("set-wifi "))
                {
                    int s1 = cmdBuf.indexOf(' ', 9);
                    if (s1 > 0)
                    {
                        setWiFi(cmdBuf.substring(9, s1).c_str(), cmdBuf.substring(s1 + 1).c_str());
                        Serial.println("OK. Use 'save' then 'reconnect'.");
                    }
                }
                else if (cmdBuf.startsWith("set-mqtt "))
                {
                    int s1 = cmdBuf.indexOf(' ', 9);
                    if (s1 > 0)
                    {
                        setMQTT(cmdBuf.substring(9, s1).c_str(), cmdBuf.substring(s1 + 1).toInt());
                        Serial.println("OK.");
                    }
                }
                else if (cmdBuf.startsWith("set-ota "))
                {
                    int s1 = cmdBuf.indexOf(' ', 8);
                    if (s1 > 0)
                    {
                        setOTA(cmdBuf.substring(8, s1).c_str(), cmdBuf.substring(s1 + 1).toInt());
                        Serial.println("OK.");
                    }
                }
                else if (cmdBuf.startsWith("set-ak "))
                {
                    setAK(cmdBuf.substring(7).c_str());
                    Serial.println("Activation Key set.");
                }
                else if (cmdBuf == "save")
                    saveConfig();
                else if (cmdBuf == "connect" || cmdBuf == "reconnect")
                    connectWiFi();
                else if (cmdBuf == "status")
                {
                    Serial.println("\n--- NOS/OTA STATUS ---");
                    Serial.printf("DevClass: %s\n", deviceClass);
                    Serial.printf("Version: %s\n", fwVersion);
                    Serial.printf("SSID: %s\n", config.ssid);
                    Serial.printf("MQTT: %s:%d\n", config.mqttServer, config.mqttPort);
                    Serial.printf("OTA Server: %s:%d\n", config.otaHost, config.otaPort);
                    Serial.printf("AK: %s\n", config.activationKey);
                    Serial.println("----------------------");
                }
                else if (cmdBuf == "version")
                {
                    Serial.printf("FIRMWARE_VERSION: %s\n", fwVersion);
                }
                else if (cmdBuf == "check-update")
                    checkUpdate();
                else if (cmdBuf.startsWith("fw-update"))
                {
                    bool force = (cmdBuf.indexOf("-f") != -1);
                    String v = "";
                    // Basic parsing for [version]
                    int lastSpace = cmdBuf.lastIndexOf(' ');
                    if (lastSpace >= 9)
                    { // "fw-update" is 9 chars
                        v = cmdBuf.substring(lastSpace + 1);
                        v.trim();
                        if (v == "-f")
                            v = ""; // It was just the force flag
                    }
                    startUpdate(force, v.length() > 0 ? v.c_str() : nullptr);
                }
                else if (cmdBuf == "reboot")
                    ESP.restart();
                else if (cmdBuf == "help")
                {
                    Serial.println("\n--- NOS/OTA CLI HELP ---");
                    Serial.println("set-wifi <ssid> <pass>  : Set WiFi credentials");
                    Serial.println("set-mqtt <host> <port>  : Set MQTT Broker address & port");
                    Serial.println("set-ota  <host> <port>  : Set OTA Server address & port");
                    Serial.println("set-ak   <key>          : Set 6-digit Activation Key");
                    Serial.println("status                  : Show current & saved settings");
                    Serial.println("version                 : Show firmware version");
                    Serial.println("check-update            : Check for new version on server");
                    Serial.println("save                    : Save config to Flash memory");
                    Serial.println("connect                 : Test connection (reconnect)");
                    Serial.println("fw-update [-f] [version] : Initiate OTA update (-f to force)");
                    Serial.println("reboot                  : Restart the device");
                    Serial.println("help                    : Show this menu");
                    Serial.println("------------------------\n");
                }
                else
                {
                    Serial.println("Unknown command. Type 'help'.");
                }

                cmdBuf = "";
                Serial.print("> ");
            }
        }
        else if (c == 8 || c == 127)
        {
            if (cmdBuf.length() > 0)
            {
                cmdBuf.remove(cmdBuf.length() - 1);
                Serial.print("\b \b");
            }
        }
        else
        {
            cmdBuf += c;
            Serial.print(c);
        }
    }
}

void NosOTA::checkUpdate()
{
    if (state != STATE_IDLE && state != STATE_SUCCESS && state != STATE_ERROR)
    {
        Serial.println("[OTA] busy.");
        return;
    }
    if (!isJsonConfig)
    {
        Serial.println("[OTA] Update check only works with JSON config.");
        return;
    }
    Serial.println("[OTA] Checking for updates...");
    onlyCheck = true;
    state = STATE_REQUESTING_CONFIG;
    requestInfo(fwPath);
}

void NosOTA::startUpdate(bool force, const char *version)
{
    if (state != STATE_IDLE && state != STATE_SUCCESS && state != STATE_ERROR)
    {
        Serial.println("[OTA] Update already in progress.");
        return;
    }
    Serial.println("[OTA] Starting Update Flow...");
    onlyCheck = false;
    forceUpdate = force;
    if (forceUpdate)
        Serial.println("[OTA] Forced update enabled.");
    if (version)
        Serial.printf("[OTA] Requested Version: %s\n", version);

    if (isJsonConfig)
    {
        state = STATE_REQUESTING_CONFIG;
        requestInfo(fwPath, version);
    }
    else
    {
        state = STATE_REQUESTING_INFO;
        requestInfo(fwPath, version);
    }
}

void NosOTA::requestInfo(const char *path, const char *version)
{
    strncpy(activePath, path, sizeof(activePath));
    if (version)
        strncpy(activeVersion, version, sizeof(activeVersion));
    else
        activeVersion[0] = '\0';

    char req[384];
    String mac = WiFi.macAddress();
    if (activeVersion[0] != '\0')
    {
        snprintf(req, sizeof(req), "{\"cmd\":\"ota.info\",\"ak\":\"%s\",\"path\":\"%s\",\"mac\":\"%s\",\"dc\":\"%s\",\"v\":\"%s\"}",
                 config.activationKey, path, mac.c_str(), deviceClass, activeVersion);
    }
    else
    {
        snprintf(req, sizeof(req), "{\"cmd\":\"ota.info\",\"ak\":\"%s\",\"path\":\"%s\",\"mac\":\"%s\",\"dc\":\"%s\"}",
                 config.activationKey, path, mac.c_str(), deviceClass);
    }
    nos->sendPacket(config.otaHost, config.otaPort, req);
    lastRequestTime = millis();
}

void NosOTA::requestChunk()
{
    if (state == STATE_REQUESTING_CONFIG || state == STATE_FETCHING_CONFIG)
    {
        // Legacy JSON request for the initial .json metadata file
        char req[384];
        String mac = WiFi.macAddress();
        snprintf(req, sizeof(req), "{\"cmd\":\"ota.read\",\"offset\":%lu,\"len\":%lu,\"path\":\"%s\",\"mac\":\"%s\",\"dc\":\"%s\"}",
                 (unsigned long)currentOffset, (unsigned long)chunkSize, activePath, mac.c_str(), deviceClass);
        nos->sendPacket(config.otaHost, config.otaPort, req);
        state = STATE_FETCHING_CONFIG;
    }
    else
    {
        // [HIGH-SPEED] ASCII mini-request for firmware chunks
        // Format: "R <offset> <length>"
        char req[32];
        int reqLen = snprintf(req, sizeof(req), "R %lu %lu", (unsigned long)currentOffset, (unsigned long)chunkSize);
        nos->sendPacketRaw(config.otaHost, config.otaPort, (const uint8_t *)req, reqLen);
        state = STATE_REQUESTING_CHUNK;
    }

    lastRequestTime = millis();
}

void NosOTA::handleMessage(const char *srcAddress, int srcPort, const uint8_t *payload, size_t length)
{
    if (config.otaPort != srcPort)
        return;
    if (!isUpdating())
        return;
    if (length == 0)
        return;

    // Detect Binary OTA Packet (Magic 0x55)
    if (payload[0] == 0x55)
    {
        if (length < 5)
            return;
        uint32_t offset = payload[1] | (payload[2] << 8) | (payload[3] << 16) | (payload[4] << 24);
        const uint8_t *data = payload + 5;
        size_t dataLen = length - 5;

        processDataChunkBinary(offset, data, dataLen);
        return;
    }

    // Fallback: JSON (for ota.info_res and ota.error)
    char *json = (char *)malloc(length + 1);
    if (!json)
        return;
    memcpy(json, payload, length);
    json[length] = '\0';

    if (!strstr(json, "\"cmd\":\"ota."))
    {
        free(json);
        return;
    }

    String cmd = extractJsonString(json, "cmd");
    if (cmd == "ota.info_res")
    {
        if (state == STATE_REQUESTING_CONFIG)
            processConfigResponse(json);
        else if (state == STATE_REQUESTING_INFO)
            processInfoResponse(json);
    }
    else if (cmd == "ota.data" && state == STATE_FETCHING_CONFIG)
    {
        processDataChunk(json);
    }
    else if (cmd == "ota.error")
    {
        String msg = extractJsonString(json, "msg");
        endWithError(msg.c_str());
    }

    free(json);
}

void NosOTA::processConfigResponse(const char *payload)
{
    long fsize = extractJsonInt(payload, "size");
    if (fsize <= 0 || fsize > 2048)
    { // Config should be small
        endWithError("Invalid config size.");
        return;
    }

    totalFirmwareSize = (uint32_t)fsize;
    if (decodeBuffer)
        free(decodeBuffer);
    decodeBuffer = (uint8_t *)malloc(totalFirmwareSize + 1);
    if (!decodeBuffer)
    {
        endWithError("OOM (Config)");
        return;
    }

    currentOffset = 0;
    retryCount = 0;
    state = STATE_FETCHING_CONFIG;
    requestChunk(); // Reuse requestChunk since it uses activePath which is currently the JSON
}

void NosOTA::processInfoResponse(const char *payload)
{
    long fsize = extractJsonInt(payload, "size");
    if (fsize <= 0)
    {
        endWithError("Invalid firmware size.");
        return;
    }

    totalFirmwareSize = (uint32_t)fsize;
    if (!Update.begin(totalFirmwareSize, U_FLASH))
    {
        endWithError("Not enough space.");
        return;
    }

    // Memory Optimization: Pre-allocate decoding buffer
    size_t decodeCapacity = chunkSize + 128;
    if (decodeBuffer)
        free(decodeBuffer);
    decodeBuffer = (uint8_t *)malloc(decodeCapacity);
    if (!decodeBuffer)
    {
        endWithError("OOM (Info)");
        return;
    }

    currentOffset = 0;
    retryCount = 0;
    requestChunk();
}

void NosOTA::processDataChunkBinary(uint32_t offset, const uint8_t *data, size_t dataLen)
{
    if (offset != currentOffset)
        return;
    state = STATE_FLASHING;

    if (Update.write((uint8_t *)data, dataLen) != dataLen)
    {
        endWithError("Flash write error");
        return;
    }

    currentOffset += dataLen;
    Serial.printf("[OTA] Binary Progress: %d%% (%u/%u)\n",
                  (int)((currentOffset * 100) / totalFirmwareSize),
                  (unsigned int)currentOffset, (unsigned int)totalFirmwareSize);

    if (currentOffset >= totalFirmwareSize)
    {
        if (Update.end(true))
        {
            Serial.println("[OTA] Success! Rebooting...");
            delay(2000);
            ESP.restart();
        }
        else
        {
            endWithError("Update.end() failed");
        }
    }
    else
    {
        retryCount = 0;
        requestChunk();
    }
}

void NosOTA::processDataChunk(const char *payload)
{
    const char *dataKey = "\"data\":\"";
    const char *dataStart = strstr(payload, dataKey);
    if (!dataStart)
    {
        endWithError("No data");
        return;
    }

    dataStart += strlen(dataKey);
    const char *dataEnd = strchr(dataStart, '\"');
    if (!dataEnd)
    {
        endWithError("Malformed b64");
        return;
    }

    size_t b64Len = dataEnd - dataStart;

    if (!decodeBuffer)
    {
        endWithError("Buffer lost");
        return;
    }
    size_t decodedLen = 0;
#if defined(ESP8266)
    decodedLen = base64_decode_chars(dataStart, b64Len, (char *)decodeBuffer + (state == STATE_FETCHING_CONFIG ? currentOffset : 0));
#elif defined(ESP32)
    mbedtls_base64_decode(decodeBuffer + (state == STATE_FETCHING_CONFIG ? currentOffset : 0), chunkSize + 64, &decodedLen, (const unsigned char *)dataStart, b64Len);
#endif

    if (state != STATE_FETCHING_CONFIG)
    {
        if (Update.write(decodeBuffer, decodedLen) != decodedLen)
        {
            endWithError("Flash write error");
            return;
        }
    }

    currentOffset += decodedLen;
    if (state != STATE_REQUESTING_CONFIG)
    {
        Serial.printf("[OTA] Progress: %d%% (%u/%u)\n", (int)((currentOffset * 100) / totalFirmwareSize), (unsigned int)currentOffset, (unsigned int)totalFirmwareSize);
    }

    if (extractJsonBool(payload, "eof"))
    {
        if (state == STATE_FETCHING_CONFIG)
        {
            decodeBuffer[currentOffset] = '\0';
            String json = String((char *)decodeBuffer);
            free(decodeBuffer);
            decodeBuffer = nullptr;

            strncpy(targetVersion, extractJsonString(json.c_str(), "version").c_str(), sizeof(targetVersion));
            strncpy(targetFileName, extractJsonString(json.c_str(), "filename").c_str(), sizeof(targetFileName));
            strncpy(targetName, extractJsonString(json.c_str(), "name").c_str(), sizeof(targetName));
            strncpy(targetRelease, extractJsonString(json.c_str(), "release").c_str(), sizeof(targetRelease));

            if (targetVersion[0] == '\0')
            {
                Serial.println("[OTA] Error parsing version from JSON metadata.");
                if (currentOffset < 256)
                    Serial.printf("[OTA] JSON data: %s\n", (char *)json.c_str());
            }

            Serial.printf("[OTA] Server Version: %s (%s)\n", targetVersion, targetName);
            Serial.printf("[OTA] Device Version: %s\n", fwVersion);

            int cmp = compareVersions(fwVersion, targetVersion);

            if (onlyCheck)
            {
                if (cmp > 0)
                    Serial.println("[OTA] New version available.");
                else if (cmp == 0)
                    Serial.println("[OTA] Device is up-to-date.");
                else
                    Serial.println("[OTA] Device version is newer than server.");
                state = STATE_IDLE;
                return;
            }

            if (cmp > 0 || forceUpdate)
            {
                if (forceUpdate)
                    Serial.println("[OTA] Version check bypassed (Forced).");

                Serial.println("[OTA] New version available. Proceeding...");

                // Resolve relative path if needed
                char actualPath[256];
                if (targetFileName[0] == '.')
                {
                    String base = String(fwPath);
                    int lastSlash = base.lastIndexOf('/');
                    if (lastSlash >= 0)
                    {
                        snprintf(actualPath, sizeof(actualPath), "%s/%s", base.substring(0, lastSlash).c_str(), targetFileName + 2);
                    }
                    else
                    {
                        strncpy(actualPath, targetFileName + 2, sizeof(actualPath));
                    }
                }
                else
                {
                    strncpy(actualPath, targetFileName, sizeof(actualPath));
                }

                state = STATE_REQUESTING_INFO;
                requestInfo(actualPath);
            }
            else if (cmp == 0)
            {
                Serial.println("[OTA] Device is already up-to-date.");
                state = STATE_IDLE;
            }
            else
            {
                Serial.println("[OTA] Device version is newer than server? Skipping.");
                state = STATE_IDLE;
            }
        }
        else
        {
            if (Update.end(true))
            {
                Serial.println("[OTA] Success! Rebooting...");
                if (decodeBuffer)
                {
                    free(decodeBuffer);
                    decodeBuffer = nullptr;
                }
                delay(2000);
                ESP.restart();
            }
            else
            {
                endWithError("Update.end() failed");
            }
        }
    }
    else
    {
        retryCount = 0;
        requestChunk();
    }
}

int NosOTA::compareVersions(const char *v1, const char *v2)
{
    if (!v1 || !v2 || v1[0] == '\0' || v2[0] == '\0')
        return (v2 && v2[0] != '\0') ? 1 : 0;
    int a1 = 0, b1 = 0, c1 = 0;
    int a2 = 0, b2 = 0, c2 = 0;
    sscanf(v1, "%d.%d.%d", &a1, &b1, &c1);
    sscanf(v2, "%d.%d.%d", &a2, &b2, &c2);

    if (a2 > a1)
        return 1;
    if (a2 < a1)
        return -1;
    if (b2 > b1)
        return 1;
    if (b2 < b1)
        return -1;
    if (c2 > c1)
        return 1;
    if (c2 < c1)
        return -1;
    return 0; // Equal
}

void NosOTA::endWithError(const char *msg)
{
    Serial.printf("[OTA] ERROR: %s\n", msg);
    Update.end();
    if (decodeBuffer)
    {
        free(decodeBuffer);
        decodeBuffer = nullptr;
    }
    state = STATE_ERROR;
}

bool NosOTA::isUpdating()
{
    return (state == STATE_REQUESTING_CONFIG || state == STATE_FETCHING_CONFIG || state == STATE_REQUESTING_INFO || state == STATE_REQUESTING_CHUNK || state == STATE_FLASHING);
}

void NosOTA::loop()
{
    if (!isUpdating())
        return;
    if (millis() - lastRequestTime > REQUEST_TIMEOUT_MS)
    {
        retryCount++;
        if (retryCount >= MAX_RETRIES)
        {
            endWithError("Max retries reached");
            return;
        }
        if (state == STATE_REQUESTING_INFO || state == STATE_REQUESTING_CONFIG)
            requestInfo(activePath, activeVersion[0] != '\0' ? activeVersion : nullptr);
        else if (state == STATE_REQUESTING_CHUNK || state == STATE_FETCHING_CONFIG)
            requestChunk();
    }
}

String NosOTA::extractJsonString(const char *json, const char *key)
{
    char search[32];
    snprintf(search, sizeof(search), "\"%s\"", key);
    const char *p = strstr(json, search);
    if (!p)
        return "";
    p += strlen(search);

    // Skip to next quote after colon
    while (*p && *p != ':')
        p++;
    if (*p == ':')
        p++;
    while (*p && *p != '\"')
        p++;

    if (*p != '\"')
        return "";
    p++;

    const char *end = strchr(p, '\"');
    if (!end)
        return "";

    size_t len = end - p;
    char buffer[128];
    if (len >= sizeof(buffer))
        len = sizeof(buffer) - 1;
    strncpy(buffer, p, len);
    buffer[len] = '\0';
    return String(buffer);
}

long NosOTA::extractJsonInt(const char *json, const char *key)
{
    char search[32];
    snprintf(search, sizeof(search), "\"%s\":", key);
    const char *p = strstr(json, search);
    if (!p)
        return -1;
    return atol(p + strlen(search));
}

bool NosOTA::extractJsonBool(const char *json, const char *key)
{
    char search[32];
    snprintf(search, sizeof(search), "\"%s\":", key);
    const char *p = strstr(json, search);
    if (!p)
        return false;
    p += strlen(search);
    while (*p == ' ')
        p++;
    return (strncmp(p, "true", 4) == 0);
}
