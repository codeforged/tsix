// ─────────────────────────────────────────────────────────────
// VARIAN: ota-mqtnl — Firmware update via MQTNL binary OTA (v1.1)
//
// Protocol (sesuai otad / ota-server TSIX):
//   1. sendRaw request (kanal biner mqtnl@1.1/):
//        {cmd:"ota.info", path, mac, dc, ak}
//      → resp (JSON di kanal biner): {cmd:"ota.info_res", version, size}
//   2. Update.begin(size)
//   3. sendRaw request: {cmd:"ota.read", offset, len, path, mac, dc, ak}
//      → resp chunk biner: [0x55][OFFSET:4 LE][DATA...]
//      → Update.write → offset += len → ulangi sampai selesai
//   4. Update.end(true) → reboot
//
// Trigger: otomatis OTA_DELAY_MS setelah boot, atau ketik "ota" di serial.
// Build: -DAPP_VARIANT_OTA (env ota-esp32 / ota-esp8266)
// ─────────────────────────────────────────────────────────────
#include <Arduino.h>
#include <tsixlib.h>
#if defined(ESP8266)
#include <Updater.h>
#else
#include <Update.h>
#endif

// ── Konfigurasi ──
#define WIFI_SSID     "Your SSID"
#define WIFI_PASSWORD "Your Password"
#define MQTT_SERVER   "192.168.1.204"
#define MQTT_PORT     1883

#define NODE_ID       "ota-device-01"
#define NODE_PORT     100
#define OTA_HOST      "tsix"          // node TSIX tempat ota-server/otad
#define OTA_PORT      4000            // port OTA di node tersebut
#define OTA_PATH      "/etc/esp-ota/firmwares/app.bin"  // path firmware di VFS
#define OTA_AK        "123456"        // activation key (dari portal)
#if defined(ESP8266)
#define OTA_DEVICE_CLASS "esp8266"
#else
#define OTA_DEVICE_CLASS "esp32"
#endif
#define OTA_CHUNK     2048            // ukuran chunk (1280-2048 aman utk ESP8266)
#define OTA_DELAY_MS  5000            // auto-trigger setelah boot

const char apiKey[] =
  "81ff71ed574e54597690ae7b04e4ef5fc87497fe10b6b037cb031af7c7d67619";

TSIX tsix(NODE_ID, NODE_PORT, apiKey, MQTT_SERVER, MQTT_PORT);

// ── State OTA ──
enum OtaState { OTA_IDLE, OTA_REQUEST_INFO, OTA_FETCHING, OTA_DONE, OTA_ERROR };
OtaState otaState = OTA_IDLE;
uint32_t otaSize = 0;
uint32_t otaOffset = 0;
bool otaStarted = false;

static long jsonGetInt(const char *json, const char *key)
{
  char needle[24];
  snprintf(needle, sizeof(needle), "\"%s\":", key);
  const char *p = strstr(json, needle);
  if (!p) return -1;
  return atol(p + strlen(needle));
}

static void otaSendInfo()
{
  char req[192];
  snprintf(req, sizeof(req),
           "{\"cmd\":\"ota.info\",\"path\":\"%s\",\"mac\":\"\",\"dc\":\"%s\",\"ak\":\"%s\"}",
           OTA_PATH, OTA_DEVICE_CLASS, OTA_AK);
  Serial.printf("[OTA] req ota.info -> %s:%d (%s)\n", OTA_HOST, OTA_PORT, OTA_PATH);
  tsix.sendRaw(OTA_HOST, OTA_PORT, req);
}

static void otaSendRead()
{
  char req[192];
  snprintf(req, sizeof(req),
           "{\"cmd\":\"ota.read\",\"offset\":%lu,\"len\":%d,\"path\":\"%s\",\"mac\":\"\",\"dc\":\"%s\",\"ak\":\"%s\"}",
           (unsigned long)otaOffset, OTA_CHUNK, OTA_PATH, OTA_DEVICE_CLASS, OTA_AK);
  tsix.sendRaw(OTA_HOST, OTA_PORT, req);
}

static void otaStart()
{
  if (otaStarted) return;
  otaStarted = true;
  otaState = OTA_REQUEST_INFO;
  otaSize = 0;
  otaOffset = 0;
  otaSendInfo();
}

static void otaHandleJson(const char *json)
{
  if (strstr(json, "ota.error"))
  {
    Serial.printf("[OTA] ERROR: %s\n", json);
    otaState = OTA_ERROR;
  }
  else if (strstr(json, "ota.info_res"))
  {
    long size = jsonGetInt(json, "size");
    if (size <= 0)
    {
      Serial.println("[OTA] size invalid");
      otaState = OTA_ERROR;
      return;
    }
    otaSize = (uint32_t)size;
    if (!Update.begin(otaSize))
    {
      Serial.println("[OTA] Not enough space!");
      otaState = OTA_ERROR;
      return;
    }
    Serial.printf("[OTA] info_res size=%lu, mulai fetch...\n", (unsigned long)otaSize);
    otaState = OTA_FETCHING;
    otaOffset = 0;
    otaSendRead();
  }
}

// ── Callback kanal biner (v1.1) — menerima chunk OTA ──
void onRawMessage(const char *srcAddress, int srcPort, const uint8_t *payload, size_t length)
{
  if (otaState != OTA_REQUEST_INFO && otaState != OTA_FETCHING)
    return;

  if (length >= 5 && payload[0] == 0x55)
  {
    // chunk biner: [0x55][OFFSET:4 LE][DATA...]
    if (otaState != OTA_FETCHING) return;
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
      Serial.println("[OTA] write error!");
      otaState = OTA_ERROR;
      return;
    }
    otaOffset += dataLen;
    Serial.printf("[OTA] %lu/%lu (%d%%)\n", (unsigned long)otaOffset, (unsigned long)otaSize,
                  (int)((otaOffset * 100) / otaSize));
    if (otaOffset >= otaSize)
    {
      if (Update.end(true))
      {
        Serial.println("[OTA] SUCCESS — reboot...");
        delay(1000);
        ESP.restart();
      }
      else
      {
        Serial.println("[OTA] Update.end() failed");
        otaState = OTA_ERROR;
      }
    }
    else
    {
      otaSendRead();
    }
  }
  else
  {
    // respon JSON (ota.info_res / ota.error)
    char *json = (char *)malloc(length + 1);
    if (!json) return;
    memcpy(json, payload, length);
    json[length] = '\0';
    otaHandleJson(json);
    free(json);
  }
}

void setup()
{
  Serial.begin(115200);
  delay(200);

  if (!tsix.connectWiFi(WIFI_SSID, WIFI_PASSWORD))
  {
    Serial.println("[setup] WiFi GAGAL");
    return;
  }

  tsix.begin();
  tsix.onRawMessage(onRawMessage);
  Serial.printf("[setup] OTA device siap (class=%s, path=%s)\n", OTA_DEVICE_CLASS, OTA_PATH);
  Serial.println("      ketik 'ota' di serial untuk update manual.");
}

void loop()
{
  tsix.loop();

  if (Serial.available())
  {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd == "ota")
      otaStart();
  }

  if (!otaStarted && millis() > OTA_DELAY_MS)
    otaStart();
}
