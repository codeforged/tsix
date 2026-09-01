#include "tsixota.h"
#include <string.h>
#include <stdlib.h>

TSIXOTA *TSIXOTA::instance = nullptr;

// ============================================================
// Lifecycle
// ============================================================
void TSIXOTA::begin(const Config &config)
{
  cfg = config;
  if (!cfg.deviceClass)
  {
#if defined(ESP8266)
    cfg.deviceClass = "TestDevice";
#else
    cfg.deviceClass = "esp32";
#endif
  }
  instance = this;
  if (tsix)
    tsix->onRawMessage(rawCallback);
  if (cfg.autoStartDelay > 0)
    startAt = millis() + cfg.autoStartDelay;
}

void TSIXOTA::start()
{
  if (started || !tsix || !cfg.path)
    return;
  started = true;
  state = REQUEST_INFO;
  otaSize = 0;
  otaOffset = 0;
  sendInfo();
}

void TSIXOTA::loop()
{
  if (!started && cfg.autoStartDelay > 0 && millis() >= startAt)
    start();
}

// ============================================================
// Requests (binary channel v1.1 via TSIX::sendRaw)
// ============================================================
void TSIXOTA::sendInfo()
{
  char req[192];
  snprintf(req, sizeof(req),
           "{\"cmd\":\"ota.info\",\"path\":\"%s\",\"mac\":\"\",\"dc\":\"%s\",\"ak\":\"%s\"}",
           cfg.path, cfg.deviceClass, cfg.activationKey);
  Serial.printf("[OTA] req ota.info -> %s:%u (%s)\n", cfg.host, (unsigned)cfg.port, cfg.path);
  if (tsix)
    tsix->sendRaw(cfg.host, cfg.port, req);
}

void TSIXOTA::sendRead()
{
  char req[192];
  snprintf(req, sizeof(req),
           "{\"cmd\":\"ota.read\",\"offset\":%lu,\"len\":%u,\"path\":\"%s\",\"mac\":\"\",\"dc\":\"%s\",\"ak\":\"%s\"}",
           (unsigned long)otaOffset, (unsigned)cfg.chunk, cfg.path, cfg.deviceClass, cfg.activationKey);
  if (tsix)
    tsix->sendRaw(cfg.host, cfg.port, req);
}

// ============================================================
// Response handling
// ============================================================
long TSIXOTA::jsonGetInt(const char *json, const char *key)
{
  char needle[24];
  snprintf(needle, sizeof(needle), "\"%s\":", key);
  const char *p = strstr(json, needle);
  if (!p)
    return -1;
  return atol(p + strlen(needle));
}

void TSIXOTA::handleJson(const char *json)
{
  if (strstr(json, "ota.error"))
  {
    fail(json);
  }
  else if (strstr(json, "ota.info_res"))
  {
    long size = jsonGetInt(json, "size");
    if (size <= 0)
    {
      fail("invalid size");
      return;
    }
    otaSize = (uint32_t)size;
    if (!Update.begin(otaSize))
    {
      fail("not enough space!");
      return;
    }
    Serial.printf("[OTA] info_res size=%lu, starting fetch...\n", (unsigned long)otaSize);
    state = FETCHING;
    otaOffset = 0;
    sendRead();
  }
}

void TSIXOTA::handleRaw(const uint8_t *payload, size_t length)
{
  if (state != REQUEST_INFO && state != FETCHING)
    return;

  if (length >= 5 && payload[0] == 0x55)
  {
    // binary chunk: [0x55][OFFSET:4 LE][DATA...]
    if (state != FETCHING)
      return;
    uint32_t offset = (uint32_t)payload[1] | ((uint32_t)payload[2] << 8) |
                      ((uint32_t)payload[3] << 16) | ((uint32_t)payload[4] << 24);
    if (offset != otaOffset)
    {
      Serial.printf("[OTA] skip stale chunk (offset %lu != %lu)\n",
                    (unsigned long)offset, (unsigned long)otaOffset);
      return;
    }
    size_t dataLen = length - 5;
    if (Update.write((uint8_t *)(payload + 5), dataLen) != dataLen)
    {
      fail("write error!");
      return;
    }
    otaOffset += dataLen;
    if (progressCb)
      progressCb(otaOffset, otaSize);
    if (otaOffset >= otaSize)
    {
      if (Update.end(true))
      {
        state = DONE;
        if (completeCb)
          completeCb();
      }
      else
      {
        fail("Update.end() failed");
      }
    }
    else
    {
      sendRead();
    }
  }
  else
  {
    // JSON response (ota.info_res / ota.error)
    char *json = (char *)malloc(length + 1);
    if (!json)
      return;
    memcpy(json, payload, length);
    json[length] = '\0';
    handleJson(json);
    free(json);
  }
}

void TSIXOTA::rawCallback(const char *srcAddress, int srcPort,
                          const uint8_t *payload, size_t length)
{
  (void)srcAddress;
  (void)srcPort;
  if (instance)
    instance->handleRaw(payload, length);
}

void TSIXOTA::fail(const char *msg)
{
  if (state == ERROR)
    return;
  state = ERROR;
  Serial.printf("[OTA] ERROR: %s\n", msg);
  if (errorCb)
    errorCb(msg);
}
