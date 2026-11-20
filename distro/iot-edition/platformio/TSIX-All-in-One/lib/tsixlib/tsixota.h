#ifndef TSIXOTA_H
#define TSIXOTA_H

#include <Arduino.h>
#include "tsixlib.h"

#if defined(ESP8266)
#include <Updater.h>
#else
#include <Update.h>
#endif

/**
 * TSIXOTA — OTA firmware via kanal biner MQTNL v1.1 (raw).
 *
 * State machine yang dulu menumpuk di src/variants/ota.cpp dipindah ke sini
 * supaya bisa dipakai ulang oleh semua varian/device tanpa duplikasi kode:
 *
 *   1. sendRaw ota.info  → {cmd:"ota.info", path, mac, dc, ak}
 *        resp JSON:       {cmd:"ota.info_res", version, size}
 *   2. Update.begin(size)
 *   3. sendRaw ota.read  → {cmd:"ota.read", offset, len, path, mac, dc, ak}
 *        resp biner:      [0x55][OFFSET:4 LE][DATA...]
 *   4. Update.write → offset += len → sampai size tercapai
 *   5. Update.end(true) → panggil onComplete (app yang reboot sendiri)
 *
 * Class ini mengambil alih callback raw channel TSIX (tsix->onRawMessage()).
 * Cukup satu instance TSIXOTA per device (callback internal static).
 *
 * Contoh pemakaian:
 *   TSIXOTA ota(&tsix);
 *   TSIXOTA::Config cfg;
 *   cfg.host = "tsix"; cfg.port = 4000;
 *   cfg.path = "/firmware.bin"; cfg.activationKey = "123456";
 *   cfg.autoStartDelay = 5000;
 *   ota.begin(cfg);
 *   ota.onProgress(...); ota.onComplete(...); ota.onError(...);
 *   // loop(): tsix.loop(); ota.loop();  |  manual: ota.start();
 */
class TSIXOTA
{
public:
  struct Config
  {
    const char *host = "tsix";         // node TSIX yang menjalankan ota-server/otad
    uint16_t port = 4000;              // port OTA di node tsb
    const char *path = nullptr;        // path firmware di VFS
    const char *activationKey = "";    // activation key (dari portal)
    const char *deviceClass = nullptr; // default: "esp32" (ESP32) / "TestDevice" (ESP8266)
    uint16_t chunk = 2048;             // chunk size (1280-2048 aman utk ESP8266)
    uint32_t autoStartDelay = 0;       // auto-trigger setelah boot (ms); 0 = manual
  };

  typedef void (*ProgressCb)(uint32_t done, uint32_t total);
  typedef void (*CompleteCb)();
  typedef void (*ErrorCb)(const char *msg);

  TSIXOTA(TSIX *tsix) : tsix(tsix) {}

  // Pasang config + ambil alih raw callback; jadwalkan auto-start bila perlu.
  void begin(const Config &cfg);
  // Mulai OTA manual (aman dipanggil berkali-kali).
  void start();
  // Panggil tiap loop() → trigger auto-start saat waktunya tiba.
  void loop();

  void onProgress(ProgressCb cb) { progressCb = cb; }
  void onComplete(CompleteCb cb) { completeCb = cb; }
  void onError(ErrorCb cb) { errorCb = cb; }

  bool isRunning() const { return state == REQUEST_INFO || state == FETCHING; }
  uint32_t done() const { return otaOffset; }
  uint32_t total() const { return otaSize; }

private:
  enum State { IDLE, REQUEST_INFO, FETCHING, DONE, ERROR };

  TSIX *tsix;
  Config cfg;
  State state = IDLE;
  uint32_t otaSize = 0;
  uint32_t otaOffset = 0;
  bool started = false;
  uint32_t startAt = 0;

  ProgressCb progressCb = nullptr;
  CompleteCb completeCb = nullptr;
  ErrorCb errorCb = nullptr;

  void sendInfo();
  void sendRead();
  void handleJson(const char *json);
  void handleRaw(const uint8_t *payload, size_t length);
  void fail(const char *msg);

  static long jsonGetInt(const char *json, const char *key);
  static TSIXOTA *instance;
  static void rawCallback(const char *srcAddress, int srcPort,
                          const uint8_t *payload, size_t length);
};

#endif // TSIXOTA_H
