#include <Arduino.h>
#include <Wire.h>
#include <INA226.h>
#include <SimpleKalmanFilter.h>
#include <noslib.h>
#include <ESP8266WiFi.h>
#include <Ticker.h>
#include <ESP8266HTTPClient.h>
#include <ESP8266httpUpdate.h>
#include <ArduinoOTA.h>
#include <DailyLogger.h>
#include <EEPROM.h>
#include <ESP8266WebServer.h>
#include <DNSServer.h>
#include <ctype.h>

// ==================== CONFIGURATION STRUCTURE (NEW) ====================
#define EEPROM_SIZE 512
#define CONFIG_MAGIC 0xA8 // Penanda validitas EEPROM

const uint16_t DEFAULT_PUB_INTERVAL = 5; // 5 Detik
const double DEFAULT_V_FACTOR = 3.26;
const double DEFAULT_C_FACTOR = 2.52940;
const double DEFAULT_V2_FACTOR = 38.69287;
// V2_FACTOR untuk tiap device:
// device Bogor = 38.69287

// device UI
// Calib V-Factor   : 3.26781
// Calib C-Factor   : 2.94600
// Calib V2-Factor  : 35.31099

// device Situraja
// Calib V-Factor   : 3.09712
// Calib C-Factor   : 3.45566
// Calib V2-Factor  : 33.81150

struct WifiAuth
{
  char ssid[21];
  char pass[21];
};

struct SystemConfig
{
  char deviceId[31];
  uint8_t logIntervalSec;
  uint16_t publishIntervalSec;
  double voltageFactor;
  double currentFactor;
  double voltage2Factor;
  WifiAuth wifiCreds[3];
  char mqttServer[64];
  uint16_t mqttPort;
  char otaServer[64];
  uint16_t otaPort;
  uint8_t magic;
};

SystemConfig sysConfig;

// Default Values
const char *DEFAULT_DEVICE_ID = "WP-UI-01";
const uint8_t DEFAULT_LOG_INTERVAL = 5; // 5 Detik

// ===== OTA CONFIGURATION =====
#define DEFAULT_OTA_SERVER "iot-hub.site"
#define DEFAULT_OTA_PORT 4000
#define CLASS_ID "LOGGER-IV-V4"
#define FIRMWARE_VERSION "2.5.5"

// ===== IoT Gateway =====
#define DEFAULT_MQTT_SERVER "iot-hub.site"
#define DEFAULT_MQTT_PORT 1883
#define DESTINATION_ADDRESS "iot-gateway" // production
// #define DESTINATION_ADDRESS "espiot-dev" // development

// ===== LED STATUS =====
#define LED_PIN D4
#define DEBUG_LOG true

enum LEDStatus
{
  LED_OFF = 0,
  LED_WIFI_CONNECTING = 1,
  LED_STANDBY = 2,
  LED_SENDING = 3,
  LED_CHECKING_UPDATE = 4,
  LED_DOWNLOADING = 5,
  LED_PREPARING_REBOOT = 6,
  LED_SD_ERROR = 7
};
LEDStatus currentLEDStatus = LED_OFF;
unsigned long lastLEDToggle = 0;
bool ledState = false;

// Global variables
float lastFiltered_V = 0.0;
float lastFiltered_A = 0.0;
float filteredRPM = 0.0;
float filteredVoltage2 = 0.0;
int currentWifiIndex = 0; // Untuk rotasi WiFi

// ===== CAPTIVE PORTAL =====
ESP8266WebServer *portalServer = nullptr;
DNSServer *dnsServer = nullptr;
bool isAPMode = false;
bool portalActive = false;
int wifiFailCount = 0;
unsigned long apModeStartTime = 0;
const byte DNS_PORT = 53;
const char *AP_SSID = "PowerTelemetry-Setup";

// ===== CONFIG MODE (BOOT) =====
const unsigned long CONFIG_MODE_TIMEOUT = 60000; // 1 menit
unsigned long configModeStartTime = 0;
bool isConfigMode = false;
bool configModeTimeoutPrinted = false;

// ===== RPM & VOLTAGE2 SENSORS =====
// NOTE: GPIO16 (D0) on ESP8266 does NOT support external interrupts.
// In this board SPI (SD) uses D5/D6/D7 and I2C uses D1/D2 in the schematic,
// so we avoid those pins. Using `GPIO3` (RX) is a practical alternative
// for an interrupt-capable input when UART RX is not actively needed
// during operation. Be aware this may interfere with USB-Serial RX
// during flashing or if you rely on Serial input.
const int RPM_PIN = 3; // GPIO3 (RX) — change if you prefer a different free pin
const int PULSES_PER_REV = 1;
// Minimum time between valid pulses from sensor (debounce)
// Increased from 100us to reduce false triggers from noise.
// const unsigned long DEBOUNCE_TIME_US = 500; // 5 ms
// // Ignore pulses that are unrealistically close (e.g., electrical noise)
// const unsigned long MIN_PULSE_INTERVAL_US = 2000; // 30 ms -> ignores >2000 RPM spikes

const unsigned long DEBOUNCE_TIME_US = 10000; // 5 ms
// Maximum expected RPM (safety clamp)
const float MAX_EXPECTED_RPM = 1000.0;
volatile unsigned long lastValidPulseTime = 0;
volatile unsigned long pulseInterval = 0;

const int VOLTAGE2_PIN = A0; // Analog pin untuk voltage divider

// ===== WATCHDOG =====
Ticker watchdogTicker;
const unsigned long WATCHDOG_TIMEOUT = 30000;
void watchdogFeed() { ESP.wdtFeed(); }
void watchdogEnable() { watchdogTicker.attach_ms(WATCHDOG_TIMEOUT / 2, watchdogFeed); }

// ===== RPM INTERRUPT HANDLER =====
void IRAM_ATTR handleRPMInterrupt()
{
  unsigned long currentTime = micros();
  if (currentTime - lastValidPulseTime > DEBOUNCE_TIME_US)
  {
    pulseInterval = currentTime - lastValidPulseTime;
    lastValidPulseTime = currentTime;
  }
}

// ===== ADDITIONAL SENSORS SETUP =====
void setupAdditionalSensors()
{
  // RPM Setup - Sekarang dipanggil setelah config mode timeout
  // pinMode(RPM_PIN, INPUT_PULLUP);
  // attachInterrupt(digitalPinToInterrupt(RPM_PIN), handleRPMInterrupt, FALLING);

  // Voltage2 pin sudah analog, tidak perlu pinMode
}

// ===== ACTIVATE RPM SENSOR MODE =====
void activateRPMSensorMode()
{
  Serial.println(F("\n=========================================="));
  Serial.println(F("⏱️  CONFIG MODE TIMEOUT!"));
  Serial.println(F("🚫 Serial RX disabled for interactive config"));
  Serial.println(F("✅ RPM Sensor Mode ACTIVATED (GPIO3/RX)"));
  Serial.println(F("==========================================\n"));

  // Setup RPM sensor interrupt on GPIO3 (RX pin)
  pinMode(RPM_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(RPM_PIN), handleRPMInterrupt, FALLING);

  // Disable Serial RX (still can TX for monitoring)
  Serial.end();
  Serial.begin(115200, SERIAL_8N1, SERIAL_TX_ONLY); // TX only mode

  isConfigMode = false;
  Serial.println(F("ℹ️  Note: Serial output still active for monitoring"));
}

// ===== INA226 & SENSOR =====
INA226 ina226(0x40);
// device UI = 0x40
// device STRJ = 0x44

SimpleKalmanFilter currentFilter(2, 2.0, 0.75);
SimpleKalmanFilter voltageFilter(2, 2.0, 0.5);
SimpleKalmanFilter rpmFilter(2, 5.0, 0.1);
SimpleKalmanFilter voltage2Filter(2, 2.0, 0.5);

char key[KEY_SIZE] = {0x81, 0xFF, 0x71, 0xED, 0x57, 0x4E, 0x54, 0x59, 0x76, 0x90, 0xAE, 0x7B, 0x04, 0xE4, 0xEF, 0x5F,
                      0xC8, 0x74, 0x97, 0xFE, 0x10, 0xB6, 0xB0, 0x37, 0xCB, 0x03, 0x1A, 0xF7, 0xC7, 0xD6, 0x76, 0x19};

// ===== INSTANCE DECLARATIONS =====
NOS *nos = nullptr;
DailyLogger dailyLogger(D8);

// ===== TIMING =====
unsigned long lastReadTime = 0;
const unsigned long READ_INTERVAL = 100;

unsigned long lastPublishTime = 0;
// const unsigned long PUBLISH_INTERVAL = 5000;

const unsigned long WIFI_CHECK_INTERVAL = 15000;       // Cek wifi tiap 15 detik
unsigned long lastWiFiCheckTime = WIFI_CHECK_INTERVAL; // Paksa cek wifi di loop pertama

const unsigned long OTA_CHECK_INTERVAL = 15 * 60000;
unsigned long lastOtaCheckTime = OTA_CHECK_INTERVAL;

unsigned long lastLogTime = 0;
// LOG_INTERVAL diambil dari sysConfig.logIntervalSec

const unsigned long TIME_SYNC_INTERVAL = 10 * 60000;
unsigned long lastTimeSyncTime = 0;
unsigned long epochOffset = 0;
bool timeSynced = false;

// ===== FORWARD DECLARATIONS =====
void checkForUpdates(bool force = false);

// ===== TIME SYNC FUNCTIONS =====
unsigned long getCurrentTimestamp()
{
  if (!timeSynced)
    return 0;
  return (millis() / 1000) + epochOffset;
}

void requestTimeSync()
{
  if (DEBUG_LOG)
    Serial.println("⏳ Requesting time sync from server...");
  if (WiFi.status() != WL_CONNECTED || !nos)
    return;
  nos->sendPacket(DESTINATION_ADDRESS, 1000, "time.sync");
}

void handleTimeSyncResponse(unsigned long serverTimestamp)
{
  unsigned long currentMillis = millis();
  epochOffset = serverTimestamp - (currentMillis / 1000);
  timeSynced = true;
  if (DEBUG_LOG)
  {
    Serial.print("✓ Time synced: ");
    Serial.println(serverTimestamp);
  }
}

void formatUptime(unsigned long uptimeMs, char *buffer, size_t bufferSize)
{
  unsigned long totalSeconds = uptimeMs / 1000;
  unsigned long days = totalSeconds / 86400;
  unsigned long hours = (totalSeconds % 86400) / 3600;
  unsigned long minutes = (totalSeconds % 3600) / 60;
  unsigned long seconds = totalSeconds % 60;
  snprintf(buffer, bufferSize, "%lu day %02lu:%02lu:%02lu", days, hours, minutes, seconds);
}

// ===== EEPROM HELPER FUNCTIONS =====
void saveConfig()
{
  sysConfig.magic = CONFIG_MAGIC;
  EEPROM.put(0, sysConfig);
  EEPROM.commit();
  Serial.println(F("✅ Config Saved to EEPROM"));
}

void loadConfig()
{
  EEPROM.get(0, sysConfig);
  // Sanitize loaded strings to remove non-printable chars (prevents CLI/parsing issues)
  auto sanitize = [](char *str, size_t maxlen)
  {
    if (!str)
      return;
    size_t j = 0;
    for (size_t i = 0; i < maxlen && str[i] != '\0'; ++i)
    {
      if (isprint((unsigned char)str[i]))
      {
        str[j++] = str[i];
      }
    }
    str[j] = '\0';
  };

  // Sanitize known string fields
  sanitize(sysConfig.deviceId, sizeof(sysConfig.deviceId));
  sanitize(sysConfig.mqttServer, sizeof(sysConfig.mqttServer));
  sanitize(sysConfig.otaServer, sizeof(sysConfig.otaServer));
  for (int i = 0; i < 3; ++i)
  {
    sanitize(sysConfig.wifiCreds[i].ssid, sizeof(sysConfig.wifiCreds[i].ssid));
    sanitize(sysConfig.wifiCreds[i].pass, sizeof(sysConfig.wifiCreds[i].pass));
  }
  if (sysConfig.magic != CONFIG_MAGIC)
  {
    Serial.println(F("⚠️ New Config Again! Resetting defaults..."));
    strncpy(sysConfig.deviceId, DEFAULT_DEVICE_ID, 30);
    sysConfig.logIntervalSec = DEFAULT_LOG_INTERVAL;

    // [TAMBAH] Default Pub Interval
    sysConfig.publishIntervalSec = DEFAULT_PUB_INTERVAL;

    // [TAMBAH] Default MQTT & OTA
    strncpy(sysConfig.mqttServer, DEFAULT_MQTT_SERVER, 63);
    sysConfig.mqttPort = DEFAULT_MQTT_PORT;
    strncpy(sysConfig.otaServer, DEFAULT_OTA_SERVER, 63);
    sysConfig.otaPort = DEFAULT_OTA_PORT;

    sysConfig.voltageFactor = DEFAULT_V_FACTOR;
    sysConfig.currentFactor = DEFAULT_C_FACTOR;
    sysConfig.voltage2Factor = DEFAULT_V2_FACTOR;

    // ... (kode reset wifi tetap sama) ...

    saveConfig();
  }
}

// ===== SERIAL CLI HANDLER (UPDATED WITH HELP) =====
void printHelp()
{
  Serial.println(F("\n================ COMMAND HELP ================"));

  Serial.println(F("[1]  Check Status"));
  Serial.println(F("     Syntax : info"));
  Serial.println(F("     Desc   : Show Device ID, Interval, & WiFi List"));

  Serial.println(F("\n[2]  Set Device ID"));
  Serial.println(F("     Syntax : set_id <new_id>"));
  Serial.println(F("     Example: set_id WP-Bandung-01"));
  Serial.println(F("     Note   : Device ID max 30 chars"));

  Serial.println(F("\n[3]  Set Log Interval (Seconds)"));
  Serial.println(F("     Syntax : set_log_interval <seconds>"));
  Serial.println(F("     Example: set_log_interval 10"));

  Serial.println(F("\n[4]  Set MQTNL Publish Interval (Seconds)"));
  Serial.println(F("     Syntax : set_pub_interval <seconds>"));
  Serial.println(F("     Example: set_pub_interval 10"));

  Serial.println(F("\n[5]  Add New WiFi Credentials"));
  Serial.println(F("     Syntax : wifi_add <ssid> <password>"));
  Serial.println(F("     Example: wifi_add MyHomeRaasia 12345678"));
  Serial.println(F("     Note   : Auto-selects empty slot (Max 3), ssid and password max 20 chars"));

  Serial.println(F("\n[6]  Update WiFi Slot"));
  Serial.println(F("     Syntax : wifi_update <index> <ssid> <password>"));
  Serial.println(F("     Example: wifi_update 0 KantorAman rahasia123"));
  Serial.println(F("     Note   : Index is 0, 1 or 2, ssid and password max 20 chars"));

  Serial.println(F("\n[7]  Delete WiFi Slot"));
  Serial.println(F("     Syntax : wifi_del <index>"));
  Serial.println(F("     Example: wifi_del 1"));

  Serial.println(F("\n[8]  Set MQTT Server"));
  Serial.println(F("     Syntax : set_mqtt_server <host>"));
  Serial.println(F("\n[9]  Set MQTT Port"));
  Serial.println(F("     Syntax : set_mqtt_port <port>"));

  Serial.println(F("\n[10] Set OTA Server"));
  Serial.println(F("     Syntax : set_ota_server <host>"));
  Serial.println(F("\n[11] Set OTA Port"));
  Serial.println(F("     Syntax : set_ota_port <port>"));

  Serial.println(F("\n[12] set_v_factor <f> : Set Voltage Calibration Factor"));
  Serial.println(F("[13] set_c_factor <f> : Set Current Calibration Factor"));
  Serial.println(F("[14] reboot           : Restart System"));
  Serial.println(F("[15] factory_reset    : Reset to Defaults"));

  Serial.println(F("========================================"));
}

// ===== SERIAL CLI HANDLER (NEW) =====
void printInfo()
{
  Serial.println(F("\n===== DEVICE INFO ====="));
  Serial.printf("Device ID        : %s\n", sysConfig.deviceId);
  if (timeSynced)
  {
    time_t now = getCurrentTimestamp();
    struct tm *timeinfo = localtime(&now);
    char timeStr[25];
    strftime(timeStr, sizeof(timeStr), "%Y-%m-%d %H:%M:%S", timeinfo);
    Serial.printf("Device Time  : %s\n", timeStr);
  }
  else
  {
    Serial.println(F("Device Time      : Not Synced (Waiting for Server...)"));
  }
  Serial.printf("Log Interval     : %d seconds\n", sysConfig.logIntervalSec);
  Serial.printf("MQTT Server      : %s:%d\n", sysConfig.mqttServer, sysConfig.mqttPort);
  Serial.printf("OTA Server       : %s:%d\n", sysConfig.otaServer, sysConfig.otaPort);
  Serial.printf("Publish Interval : %d seconds\n", sysConfig.publishIntervalSec);
  Serial.printf("FW Version       : %s\n", FIRMWARE_VERSION);
  Serial.printf("Calib V-Factor   : %.5f\n", sysConfig.voltageFactor);
  Serial.printf("Calib C-Factor   : %.5f\n", sysConfig.currentFactor);
  Serial.printf("Calib V2-Factor  : %.5f\n", sysConfig.voltage2Factor);

  // ===== WIFI STATUS =====
  String statusStr;
  if (WiFi.status() == WL_CONNECTED)
  {
    statusStr = "CONNECTED to " + WiFi.SSID() + " (IP: " + WiFi.localIP().toString() + ")";
  }
  else
  {
    statusStr = "DISCONNECTED";
  }
  Serial.printf("WiFi Status     : %s\n", statusStr.c_str());

  // ===== SD CARD STATUS (SIMPLE CHECK) =====
  // Kita coba buka folder root "/"
  File root = SD.open("/");
  if (root)
  {
    Serial.println(F("SD Status       : MOUNTED / READY"));
    root.close(); // Tutup lagi biar aman
  }
  else
  {
    Serial.println(F("SD Status       : NOT DETECTED / ERROR"));
  }

  // ===== CREDENTIALS =====
  Serial.println(F("--- WiFi Credentials ---"));
  for (int i = 0; i < 3; i++)
  {
    Serial.printf("[%d] SSID: %-15s | PASS: %s\n", i,
                  (strlen(sysConfig.wifiCreds[i].ssid) > 0 ? sysConfig.wifiCreds[i].ssid : "<EMPTY>"),
                  (strlen(sysConfig.wifiCreds[i].ssid) > 0 ? sysConfig.wifiCreds[i].pass : ""));
  }
  Serial.printf("LED Status       : %d\n", currentLEDStatus);
  Serial.println(F("======================="));
}

// ===== COMMAND EXECUTOR (SHARED) =====
// Fungsi ini mengembalikan string balasan untuk dikirim ke Serial atau MQTT
String execCommand(String input)
{
  input.trim();
  if (input.length() == 0)
    return "Error: Empty command";

  int space1 = input.indexOf(' ');
  String cmd = (space1 == -1) ? input : input.substring(0, space1);
  String args = (space1 == -1) ? "" : input.substring(space1 + 1);
  String output = "";

  if (cmd.equalsIgnoreCase("info"))
  {
    // === VERSI LENGKAP (Sesuai Request) ===
    output += "\n===== DEVICE INFO =====\n";
    output += "Device ID        : " + String(sysConfig.deviceId) + "\n";

    // Waktu
    if (timeSynced)
    {
      time_t now = getCurrentTimestamp();
      struct tm *timeinfo = localtime(&now);
      char timeStr[25];
      strftime(timeStr, sizeof(timeStr), "%Y-%m-%d %H:%M:%S", timeinfo);
      output += "Device Time      : " + String(timeStr) + "\n";
    }
    else
    {
      output += "Device Time      : Not Synced (Waiting...)\n";
    }

    // Config Dasar
    output += "Log Interval     : " + String(sysConfig.logIntervalSec) + " seconds\n";
    output += "MQTT Server      : " + String(sysConfig.mqttServer) + ":" + String(sysConfig.mqttPort) + "\n";
    output += "OTA Server       : " + String(sysConfig.otaServer) + ":" + String(sysConfig.otaPort) + "\n";
    output += "Publish Interval : " + String(sysConfig.publishIntervalSec) + " seconds\n";
    output += "FW Version       : " + String(FIRMWARE_VERSION) + "\n";
    output += "Calib V-Factor   : " + String(sysConfig.voltageFactor, 5) + "\n";
    output += "Calib C-Factor   : " + String(sysConfig.currentFactor, 5) + "\n";
    output += "Calib V2-Factor  : " + String(sysConfig.voltage2Factor, 5) + "\n";

    // WiFi Status
    String statusStr;
    if (WiFi.status() == WL_CONNECTED)
    {
      statusStr = "CONNECTED to " + WiFi.SSID() + " (IP: " + WiFi.localIP().toString() + ")";
    }
    else
    {
      statusStr = "DISCONNECTED";
    }
    output += "WiFi Status      : " + statusStr + "\n";

    // SD Card Status (Cek Mount sebentar)
    File root = SD.open("/");
    if (root)
    {
      output += "SD Status        : MOUNTED / READY\n";
      root.close();
    }
    else
    {
      output += "SD Status        : NOT DETECTED / ERROR\n";
    }

    // Credentials List
    output += "--- WiFi Credentials ---\n";
    for (int i = 0; i < 3; i++)
    {
      char credBuff[100]; // Buffer aman
      snprintf(credBuff, sizeof(credBuff), "[%d] SSID: %-15s | PASS: %s", i,
               (strlen(sysConfig.wifiCreds[i].ssid) > 0 ? sysConfig.wifiCreds[i].ssid : "<EMPTY>"),
               (strlen(sysConfig.wifiCreds[i].ssid) > 0 ? sysConfig.wifiCreds[i].pass : ""));
      output += String(credBuff) + "\n";
    }

    output += "LED Status       : " + String(currentLEDStatus) + "\n";
    output += "=======================";
  }
  else if (cmd.equalsIgnoreCase("set-id") || cmd.equalsIgnoreCase("set_id"))
  {
    if (args.length() > 0 && args.length() < 30)
    {
      args.toCharArray(sysConfig.deviceId, 30);
      saveConfig();
      output = "Device ID updated to: " + String(sysConfig.deviceId) + " (Reboot required)";
    }
    else
    {
      output = "Error: ID too long or empty.";
    }
  }
  else if (cmd.equalsIgnoreCase("set-log-interval") || cmd.equalsIgnoreCase("set_log_interval"))
  {
    int val = args.toInt();
    if (val > 0 && val < 255)
    {
      sysConfig.logIntervalSec = (uint8_t)val;
      saveConfig();
      output = "Log Interval updated to: " + String(val) + " s";
    }
    else
      output = "Error: Interval must be 1-254";
  }
  else if (cmd.equalsIgnoreCase("set-pub-interval") || cmd.equalsIgnoreCase("set_pub_interval"))
  {
    int val = args.toInt();
    if (val > 0)
    {
      sysConfig.publishIntervalSec = (uint16_t)val;
      saveConfig();
      output = "Publish Interval updated to: " + String(val) + " s";
    }
    else
      output = "Error: Invalid value";
  }
  else if (cmd.equalsIgnoreCase("set-v-factor") || cmd.equalsIgnoreCase("set_v_factor"))
  {
    double val = args.toDouble();
    if (val > 0.0)
    {
      sysConfig.voltageFactor = val;
      saveConfig();
      output = "Voltage Factor updated: " + String(val, 5);
    }
    else
      output = "Error: Must be > 0";
  }
  else if (cmd.equalsIgnoreCase("set-c-factor") || cmd.equalsIgnoreCase("set_c_factor"))
  {
    double val = args.toDouble();
    if (val > 0.0)
    {
      sysConfig.currentFactor = val;
      saveConfig();
      output = "Current Factor updated: " + String(val, 5);
    }
    else
      output = "Error: Must be > 0";
  }
  else if (cmd.equalsIgnoreCase("set-v2-factor") || cmd.equalsIgnoreCase("set_v2_factor"))
  {
    double val = args.toDouble();
    if (val > 0.0)
    {
      sysConfig.voltage2Factor = val;
      saveConfig();
      output = "Voltage2 Factor updated: " + String(val, 5);
    }
    else
      output = "Error: Must be > 0";
  }
  else if (cmd.equalsIgnoreCase("wifi-add") || cmd.equalsIgnoreCase("wifi_add"))
  {
    int sp = args.indexOf(' ');
    if (sp != -1)
    {
      String ssid = args.substring(0, sp);
      String pass = args.substring(sp + 1);
      int slot = -1;
      for (int i = 0; i < 3; i++)
      {
        if (strlen(sysConfig.wifiCreds[i].ssid) == 0)
        {
          slot = i;
          break;
        }
      }
      if (slot != -1)
      {
        ssid.toCharArray(sysConfig.wifiCreds[slot].ssid, 20);
        pass.toCharArray(sysConfig.wifiCreds[slot].pass, 20);
        saveConfig();
        output = "WiFi added to slot [" + String(slot) + "]";
      }
      else
        output = "Slots full. Use wifi-update or wifi-del.";
    }
    else
      output = "Usage: wifi-add <ssid> <pass>";
  }
  else if (cmd.equalsIgnoreCase("wifi-update") || cmd.equalsIgnoreCase("wifi_update"))
  {
    // Format: wifi-update <index> <ssid> <password>
    int sp1 = args.indexOf(' ');
    if (sp1 != -1)
    {
      int idx = args.substring(0, sp1).toInt();
      String rest = args.substring(sp1 + 1);
      int sp2 = rest.indexOf(' ');
      if (sp2 != -1 && idx >= 0 && idx < 3)
      {
        String ssid = rest.substring(0, sp2);
        String pass = rest.substring(sp2 + 1);
        ssid.toCharArray(sysConfig.wifiCreds[idx].ssid, 20);
        pass.toCharArray(sysConfig.wifiCreds[idx].pass, 20);
        saveConfig();
        output = "WiFi slot [" + String(idx) + "] updated.";
      }
      else
        output = "Error: Invalid index or format.";
    }
    else
      output = "Usage: wifi-update <index> <ssid> <pass>";
  }
  else if (cmd.equalsIgnoreCase("wifi-del") || cmd.equalsIgnoreCase("wifi_del"))
  {
    int idx = args.toInt();
    if (idx >= 0 && idx < 3)
    {
      sysConfig.wifiCreds[idx].ssid[0] = '\0';
      sysConfig.wifiCreds[idx].pass[0] = '\0';
      saveConfig();
      output = "WiFi slot [" + String(idx) + "] deleted.";
    }
    else
      output = "Error: Index must be 0-2";
  }
  else if (cmd.equalsIgnoreCase("set-mqtt-server") || cmd.equalsIgnoreCase("set_mqtt_server"))
  {
    if (args.length() > 0)
    {
      args.toCharArray(sysConfig.mqttServer, 64);
      saveConfig();
      output = "MQTT Server set to: " + String(sysConfig.mqttServer);
    }
    else
      output = "Usage: set_mqtt_server <host>";
  }
  else if (cmd.equalsIgnoreCase("set-mqtt-port") || cmd.equalsIgnoreCase("set_mqtt_port"))
  {
    int p = args.toInt();
    if (p > 0)
    {
      sysConfig.mqttPort = p;
      saveConfig();
      output = "MQTT Port set to: " + String(p);
    }
    else
      output = "Usage: set_mqtt_port <port>";
  }
  else if (cmd.equalsIgnoreCase("set-ota-server") || cmd.equalsIgnoreCase("set_ota_server"))
  {
    if (args.length() > 0)
    {
      args.toCharArray(sysConfig.otaServer, 64);
      saveConfig();
      output = "OTA Server set to: " + String(sysConfig.otaServer);
    }
    else
      output = "Usage: set_ota_server <host>";
  }
  else if (cmd.equalsIgnoreCase("set-ota-port") || cmd.equalsIgnoreCase("set_ota_port"))
  {
    int p = args.toInt();
    if (p > 0)
    {
      sysConfig.otaPort = p;
      saveConfig();
      output = "OTA Port set to: " + String(p);
    }
    else
      output = "Usage: set_ota_port <port>";
  }
  else if (cmd.equalsIgnoreCase("fw-update") || cmd.equalsIgnoreCase("fw_update"))
  {
    checkForUpdates(true);
    output = "Update check triggered manually.";
  }
  else if (cmd.equalsIgnoreCase("mem"))
  {
    uint32_t freeHeap = ESP.getFreeHeap();
    uint32_t maxBlock = ESP.getMaxFreeBlockSize(); // Blok terbesar yang bisa di-malloc
    uint8_t frag = ESP.getHeapFragmentation();     // Tingkat "berantakan" memori (0-100%)
    uint32_t freeStack = ESP.getFreeContStack();   // Estimasi sisa stack (aman jika > 500-1000 bytes)

    output += F("\n===== MEMORY DIAGNOSTICS =====\n");

    output += "Free Heap        : " + String(freeHeap) + " bytes\n";
    output += "Max Alloc Block  : " + String(maxBlock) + " bytes\n";
    output += "Heap Frag        : " + String(frag) + "%\n";
    output += "Free Stack       : " + String(freeStack) + " bytes\n";

    output += F("--------------------------------\n");

    // Analisa singkat buat operator
    if (frag > 50)
      output += F("⚠️ WARNING: High Fragmentation!\n");
    if (freeStack < 500)
      output += F("⚠️ WARNING: Low Stack!\n");
    if (freeHeap < 2000)
      output += F("⚠️ WARNING: Low Memory!\n");
    if (frag <= 50 && freeStack >= 500 && freeHeap >= 2000)
      output += F("✅ Status: HEALTHY\n");

    output += F("================================");
  }
  else if (cmd.equalsIgnoreCase("reboot"))
  {
    output = "REBOOT_TRIGGERED"; // Special flag
  }
  else if (cmd.equalsIgnoreCase("factory-reset") || cmd.equalsIgnoreCase("factory_reset"))
  {
    sysConfig.magic = 0x00;
    EEPROM.put(0, sysConfig);
    EEPROM.commit();
    output = "RESET_TRIGGERED"; // Special flag
  }
  else if (cmd.equalsIgnoreCase("exit_conf") || cmd.equalsIgnoreCase("exit-conf"))
  {
    if (isConfigMode)
    {
      output = "EXIT_CONFIG_TRIGGERED"; // Special flag
    }
    else
    {
      output = "Already in normal mode (RPM sensor active)";
    }
  }
  // --- [2] HELP COMMAND (BARU) ---
  else if (cmd.equalsIgnoreCase("help") || cmd.equalsIgnoreCase("?"))
  {
    output += F("\n====== COMMANDS ======\n");
    output += F("info - Device status\n");
    output += F("set-id <id> - Set device ID\n");
    output += F("set-log-interval <sec> - Set log interval\n");
    output += F("set-pub-interval <sec> - Set publish interval\n");
    output += F("wifi-add <ssid> <pass> - Add WiFi (max 3)\n");
    output += F("wifi-update <idx> <ssid> <pass> - Update WiFi slot\n");
    output += F("wifi-del <idx> - Delete WiFi slot\n");
    output += F("set-mqtt-server <host> - Set MQTT server\n");
    output += F("set-mqtt-port <port> - Set MQTT port\n");
    output += F("set-ota-server <host> - Set OTA server\n");
    output += F("set-ota-port <port> - Set OTA port\n");
    output += F("set-v-factor <f> - Voltage calib factor\n");
    output += F("set-c-factor <f> - Current calib factor\n");
    output += F("set-v2-factor <f> - Voltage2 calib factor\n");
    output += F("exit-conf - Exit config, start RPM sensor\n");
    output += F("reboot - Restart system\n");
    output += F("factory-reset - Reset to defaults\n");
    output += F("mem - Show heap & stack stats\n");
    output += F("fw-update - Check firmware update\n");
    output += F("======================");
    return output; // Return help text
  }
  else
  {
    output = "Unknown command: " + cmd;
  }
  return output;
}

void handleSerialCLI()
{
  if (Serial.available())
  {
    String input = Serial.readStringUntil('\n');

    // Reset config mode timeout saat ada input
    if (isConfigMode)
    {
      configModeStartTime = millis();
      configModeTimeoutPrinted = false; // Reset flag countdown
    }

    String result = execCommand(input);

    // Handle special flags
    if (result == "REBOOT_TRIGGERED")
    {
      Serial.println("🔄 Rebooting via CLI...");
      delay(1000);
      ESP.restart();
    }
    else if (result == "RESET_TRIGGERED")
    {
      Serial.println("⚠️ Factory Reset via CLI...");
      delay(1000);
      ESP.restart();
    }
    else if (result == "EXIT_CONFIG_TRIGGERED")
    {
      Serial.println("\n✅ Exiting config mode by user command...");
      delay(500);
      activateRPMSensorMode();
    }
    else
    {
      Serial.println(result);
    }
  }
}

// ===== HELPER: LED Control =====
void setLEDStatus(LEDStatus status)
{
  currentLEDStatus = status;
  lastLEDToggle = millis();
  ledState = false;
}

void updateLED()
{

  unsigned long currentTime = millis();
  unsigned long elapsed = currentTime - lastLEDToggle;

  switch (currentLEDStatus)
  {
  case LED_SD_ERROR:
    // Kedip sangat cepat (100ms) tanda bahaya
    if (elapsed >= 100)
    {
      ledState = !ledState;
      lastLEDToggle = currentTime;
    }
    digitalWrite(LED_PIN, ledState ? LOW : HIGH);
    break;
  case LED_OFF:
    digitalWrite(LED_PIN, HIGH); // LED OFF (active LOW)
    break;

  case LED_WIFI_CONNECTING:
    // Pattern: 500ms on, 500ms off
    if (elapsed >= 500)
    {
      ledState = !ledState;
      lastLEDToggle = currentTime;
    }
    digitalWrite(LED_PIN, ledState ? LOW : HIGH);
    break;

  case LED_STANDBY:
    // Pattern: 50ms on, 40ms off, 50ms on, 3000ms off (heartbeat)
    if (elapsed < 50)
    {
      digitalWrite(LED_PIN, LOW); // ON
    }
    else if (elapsed < 150)
    {
      digitalWrite(LED_PIN, HIGH); // OFF
    }
    else if (elapsed < 200)
    {
      digitalWrite(LED_PIN, LOW); // ON
    }
    else if (elapsed < 2000)
    {
      digitalWrite(LED_PIN, HIGH); // OFF
    }
    else
    {
      lastLEDToggle = currentTime; // Reset
    }
    break;

  case LED_SENDING:
    // Pattern: Solid ON while sending, OFF when done
    digitalWrite(LED_PIN, LOW); // Always ON
    break;

  case LED_CHECKING_UPDATE:
    // Pattern: Fast blink 100ms on, 100ms off
    if (elapsed >= 100)
    {
      ledState = !ledState;
      lastLEDToggle = currentTime;
    }
    digitalWrite(LED_PIN, ledState ? LOW : HIGH);
    break;

  case LED_DOWNLOADING:
    // Pattern: Triple pulse - 200ms on, 100ms off, 200ms on, 100ms off, 200ms on, 2000ms off
    if (elapsed < 200)
    {
      digitalWrite(LED_PIN, LOW); // ON
    }
    else if (elapsed < 300)
    {
      digitalWrite(LED_PIN, HIGH); // OFF
    }
    else if (elapsed < 500)
    {
      digitalWrite(LED_PIN, LOW); // ON
    }
    else if (elapsed < 600)
    {
      digitalWrite(LED_PIN, HIGH); // OFF
    }
    else if (elapsed < 800)
    {
      digitalWrite(LED_PIN, LOW); // ON
    }
    else if (elapsed < 2800)
    {
      digitalWrite(LED_PIN, HIGH); // OFF
    }
    else
    {
      lastLEDToggle = currentTime; // Reset
    }
    break;
  case LED_PREPARING_REBOOT:
    // Pattern: Rapid blink 150ms on, 150ms off
    if (elapsed >= 150)
    {
      ledState = !ledState;
      lastLEDToggle = currentTime;
    }
    digitalWrite(LED_PIN, ledState ? LOW : HIGH);
    break;
  }
}

// ===== GLOBALS FOR NOS CALLBACK =====
char *globalJsonBuffer = nullptr;
int globalJsonOffset = 0;
int globalRecordsInChunk = 0;
const int JSON_BUFF_SIZE = 2048;
const int MAX_RECORDS_PER_CHUNK = 5;
const char *globalTargetAddr = nullptr;
int globalTargetPort = 0;
int globalCurrentChunkIdx = 0;
int globalTotalChunks = 0;
int globalTotalSentRecords = 0; // Total records sent across all chunks

void sendDataCallback(LogEntry entry)
{
  if (!globalJsonBuffer || !nos)
    return;
  ESP.wdtFeed();

  if (globalRecordsInChunk > 0)
  {
    globalJsonOffset += snprintf(globalJsonBuffer + globalJsonOffset, JSON_BUFF_SIZE - globalJsonOffset, ",");
  }

  int written = snprintf(globalJsonBuffer + globalJsonOffset, JSON_BUFF_SIZE - globalJsonOffset,
                         "{\"ts\":%lu,\"v\":%.2f,\"a\":%.2f,\"rpm\":%.0f,\"v2\":%.2f,\"status\":%d}",
                         (unsigned long)entry.timestamp, entry.voltage, entry.current, entry.rpm, entry.voltage2, entry.status);

  if (written < 0 || written >= (JSON_BUFF_SIZE - globalJsonOffset))
  {
    globalRecordsInChunk = MAX_RECORDS_PER_CHUNK;
  }
  else
  {
    globalJsonOffset += written;
    globalRecordsInChunk++;
  }

  if (globalRecordsInChunk >= MAX_RECORDS_PER_CHUNK)
  {
    snprintf(globalJsonBuffer + globalJsonOffset, JSON_BUFF_SIZE - globalJsonOffset, "],\"sent_records\":%d}", globalRecordsInChunk);
    nos->sendPacket(globalTargetAddr, globalTargetPort, globalJsonBuffer);
    globalTotalSentRecords += globalRecordsInChunk;
    delay(5);
    ESP.wdtFeed();
    globalCurrentChunkIdx++;
    globalRecordsInChunk = 0;
    globalJsonOffset = 0;
    globalJsonOffset += snprintf(globalJsonBuffer, JSON_BUFF_SIZE,
                                 "{\"device_id\":\"%s\",\"chunk\":%d,\"total_chunks\":%d,\"data\":[",
                                 sysConfig.deviceId, globalCurrentChunkIdx, globalTotalChunks);
  }
}

void wipePathRecursive(const char *path)
{
  File dir = SD.open(path);
  if (!dir || !dir.isDirectory())
    return;
  while (true)
  {
    File entry = dir.openNextFile();
    if (!entry)
      break;
    String entryName = entry.name();
    if (entryName == "." || entryName == "..")
    {
      entry.close();
      continue;
    }
    String entryPath = String(path);
    if (!entryPath.endsWith("/"))
      entryPath += "/";
    entryPath += entryName;
    if (entry.isDirectory())
    {
      entry.close();
      wipePathRecursive(entryPath.c_str());
      SD.rmdir(entryPath.c_str());
    }
    else
    {
      entry.close();
      SD.remove(entryPath.c_str());
    }
    ESP.wdtFeed();
  }
  dir.close();
}

// ===== NOS MESSAGE HANDLER (FULL LOGIC RESTORED) =====
void handleNOSMessage(const char *srcAddress, int srcPort, const char *payload)
{
  if (!srcAddress || !payload || !nos)
    return;

  // 1. TIME SYNC
  if (payload[0] == '{' && strstr(payload, "\"timestamp\""))
  {
    const char *tsPos = strstr(payload, "\"timestamp\":");
    if (tsPos)
    {
      unsigned long serverTimestamp = strtoul(tsPos + 12, NULL, 10);
      if (serverTimestamp > 0)
        handleTimeSyncResponse(serverTimestamp);
    }
    return;
  }

  // 2. LOG.STATUS
  if (strstr(payload, "log.status"))
  {
    char statusResponse[450]; // [OPSIONAL] Saya naikkan sedikit buffer-nya biar aman
    char uptimeStr[25];
    formatUptime(millis(), uptimeStr, sizeof(uptimeStr));

    // --- [BARU] Cek Status SD Card ---
    bool isSdMounted = false;
    File root = SD.open("/");
    if (root)
    {
      isSdMounted = true;
      root.close();
    }
    // ---------------------------------

    uint32_t todayRecords = 0;
    if (timeSynced)
    {
      char path[32];
      time_t now = getCurrentTimestamp() + (7 * 3600); // GMT+7

      struct tm *t = localtime(&now);
      sprintf(path, "/%04d/%02d/%02d.bin", t->tm_year + 1900, t->tm_mon + 1, t->tm_mday);
      Serial.print("Checking log file: ");
      Serial.println(path);
      File f = SD.open(path, FILE_READ);
      if (f)
      {
        todayRecords = f.size() / 24; // 24 bytes per record (6 fields)
        f.close();
      }
    }
    unsigned long currentTimestamp = timeSynced ? getCurrentTimestamp() : 0;

    // [MODIFIKASI] Tambahkan "sd_status":... ke dalam JSON
    snprintf(statusResponse, sizeof(statusResponse),
             "{\"device_id\":\"%s\",\"uptime\":\"%s\",\"wifi\":%s,\"sd_status\":%s,\"records\":%d,\"fw_version\":\"%s\",\"voltage\":%.2f,\"current\":%.2f,\"rpm\":%.0f,\"voltage2\":%.2f,\"interval\":%d,\"time_synced\":%s,\"timestamp\":%lu}",
             sysConfig.deviceId,
             uptimeStr,
             WiFi.status() == WL_CONNECTED ? "true" : "false",
             isSdMounted ? "true" : "false", // <--- Value status SD Card
             todayRecords,
             FIRMWARE_VERSION,
             lastFiltered_V,
             lastFiltered_A,
             filteredRPM,      // Tambah RPM
             filteredVoltage2, // Tambah voltage2
             sysConfig.logIntervalSec,
             timeSynced ? "true" : "false",
             currentTimestamp);

    nos->sendPacket(srcAddress, srcPort, statusResponse);
    ESP.wdtFeed();
  }

  // 3. LOG.DATA.RANGE
  else if (strstr(payload, "log.data.range"))
  {
    uint32_t startTime = 0;
    uint32_t endTime = 0;
    char *startPos = strstr(payload, "start=");
    if (startPos)
      startTime = (uint32_t)atol(startPos + 6);
    char *endPos = strstr(payload, "end=");
    if (endPos)
      endTime = (uint32_t)atol(endPos + 4);

    if (startTime == 0 || endTime == 0)
      return;

    globalJsonBuffer = (char *)malloc(JSON_BUFF_SIZE);
    if (!globalJsonBuffer)
      return;

    // Estimate total chunks based on time range (rough estimate)
    uint32_t rangeSeconds = endTime - startTime;
    uint32_t estimatedRecords = (rangeSeconds / sysConfig.logIntervalSec) + 1;
    int estimatedChunks = (estimatedRecords + MAX_RECORDS_PER_CHUNK - 1) / MAX_RECORDS_PER_CHUNK;
    if (estimatedChunks == 0)
      estimatedChunks = 1;

    globalTargetAddr = srcAddress;
    globalTargetPort = srcPort;
    globalCurrentChunkIdx = 1;
    globalRecordsInChunk = 0;
    globalTotalChunks = estimatedChunks;
    globalTotalSentRecords = 0;

    globalJsonOffset = snprintf(globalJsonBuffer, JSON_BUFF_SIZE,
                                "{\"device_id\":\"%s\",\"chunk\":1,\"total_chunks\":%d,\"total_records\":%d,\"start\":%lu,\"end\":%lu,\"data\":[",
                                sysConfig.deviceId, estimatedChunks, estimatedRecords, (unsigned long)startTime, (unsigned long)endTime);

    dailyLogger.readRange(startTime, endTime, sendDataCallback);

    if (globalRecordsInChunk > 0 || globalCurrentChunkIdx == 1)
    {
      snprintf(globalJsonBuffer + globalJsonOffset, JSON_BUFF_SIZE - globalJsonOffset, "],\"sent_records\":%d}", globalRecordsInChunk);
      nos->sendPacket(srcAddress, srcPort, globalJsonBuffer);
      globalTotalSentRecords += globalRecordsInChunk;
      globalCurrentChunkIdx++;
      delay(50);
    }
    snprintf(globalJsonBuffer, JSON_BUFF_SIZE,
             "{\"device_id\":\"%s\",\"chunk\":%d,\"total_chunks\":%d,\"data\":[],\"sent_records\":0}",
             sysConfig.deviceId, globalCurrentChunkIdx, globalCurrentChunkIdx);
    nos->sendPacket(srcAddress, srcPort, globalJsonBuffer);

    free(globalJsonBuffer);
    globalJsonBuffer = nullptr;
    ESP.wdtFeed();
  }

  // // 4. LOG.DATA (LIMIT)
  // else if (strstr(payload, "log.data"))
  // {
  //   int limit = 10;
  //   char *limitPos = strstr(payload, "limit=");
  //   if (limitPos)
  //     limit = atoi(limitPos + 6);
  //   if (limit > 500)
  //     limit = 500;

  //   if (!timeSynced)
  //   {
  //     nos->sendPacket(srcAddress, srcPort, "{\"error\":\"Time not synced\",\"data\":[]}");
  //     return;
  //   }

  //   // Pakai logIntervalSec dari EEPROM untuk estimasi window
  //   uint32_t windowSeconds = (limit * (sysConfig.logIntervalSec * 1000) / 1000) * 1.5;
  //   time_t endTime = getCurrentTimestamp();
  //   time_t startTime = endTime - windowSeconds;

  //   char path[32];
  //   time_t now = getCurrentTimestamp();
  //   struct tm *t = localtime(&now);
  //   sprintf(path, "/%04d/%02d/%02d.bin", t->tm_year + 1900, t->tm_mon + 1, t->tm_mday);

  //   uint32_t totalRecs = 0;
  //   File f = SD.open(path, FILE_READ);
  //   if (f)
  //   {
  //     totalRecs = f.size() / 16;
  //     f.close();
  //   }

  //   int estimatedChunks = (totalRecs + MAX_RECORDS_PER_CHUNK - 1) / MAX_RECORDS_PER_CHUNK;
  //   if (estimatedChunks == 0)
  //     estimatedChunks = 1;

  //   globalJsonBuffer = (char *)malloc(JSON_BUFF_SIZE);
  //   if (!globalJsonBuffer)
  //     return;

  //   globalTargetAddr = srcAddress;
  //   globalTargetPort = srcPort;
  //   globalCurrentChunkIdx = 1;
  //   globalRecordsInChunk = 0;

  //   globalJsonOffset = snprintf(globalJsonBuffer, JSON_BUFF_SIZE,
  //                               "{\"device_id\":\"%s\",\"chunk\":1,\"total_chunks\":%d,\"total_records\":%d,\"data\":[",
  //                               sysConfig.deviceId, estimatedChunks, totalRecs);

  //   dailyLogger.readRange(startTime, endTime, sendDataCallback);

  //   if (globalRecordsInChunk > 0 || globalCurrentChunkIdx == 1)
  //   {
  //     snprintf(globalJsonBuffer + globalJsonOffset, JSON_BUFF_SIZE - globalJsonOffset, "]}");
  //     nos->sendPacket(srcAddress, srcPort, globalJsonBuffer);
  //     globalCurrentChunkIdx++;
  //     delay(50);
  //   }
  //   int finalChunk = (globalCurrentChunkIdx > estimatedChunks) ? globalCurrentChunkIdx : estimatedChunks;
  //   snprintf(globalJsonBuffer, JSON_BUFF_SIZE,
  //            "{\"device_id\":\"%s\",\"chunk\":%d,\"total_chunks\":%d,\"data\":[]}",
  //            sysConfig.deviceId, finalChunk, finalChunk);
  //   nos->sendPacket(srcAddress, srcPort, globalJsonBuffer);

  //   free(globalJsonBuffer);
  //   globalJsonBuffer = nullptr;
  //   ESP.wdtFeed();
  // }

  // 4. LOG.DATA (LIMIT)
  else if (strstr(payload, "log.data"))
  {
    int limit = 10;
    char *limitPos = strstr(payload, "limit=");
    if (limitPos)
      limit = atoi(limitPos + 6);
    if (limit > 500)
      limit = 500;

    if (!timeSynced)
    {
      nos->sendPacket(srcAddress, srcPort, "{\"error\":\"Time not synced\",\"data\":[]}");
      return;
    }

    uint32_t windowSeconds = (limit * sysConfig.logIntervalSec) * 1.5;
    time_t endTime = getCurrentTimestamp();
    time_t startTime = endTime - windowSeconds;

    char path[32];
    time_t now = getCurrentTimestamp() + (7 * 3600); // GMT+7
    struct tm *t = localtime(&now);
    sprintf(path, "/%04d/%02d/%02d.bin", t->tm_year + 1900, t->tm_mon + 1, t->tm_mday);

    uint32_t totalRecs = 0;
    File f = SD.open(path, FILE_READ);
    if (f)
    {
      totalRecs = f.size() / 24; // 24 bytes per record (6 fields)
      f.close();
    }
    int estimatedChunks = (totalRecs + MAX_RECORDS_PER_CHUNK - 1) / MAX_RECORDS_PER_CHUNK;
    if (estimatedChunks == 0)
      estimatedChunks = 1;

    globalJsonBuffer = (char *)malloc(JSON_BUFF_SIZE);
    if (!globalJsonBuffer)
      return;

    globalTargetAddr = srcAddress;
    globalTargetPort = srcPort;
    globalCurrentChunkIdx = 1;
    globalRecordsInChunk = 0;
    globalTotalChunks = estimatedChunks;
    globalTotalSentRecords = 0;

    globalJsonOffset = snprintf(globalJsonBuffer, JSON_BUFF_SIZE,
                                "{\"device_id\":\"%s\",\"chunk\":1,\"total_chunks\":%d,\"total_records\":%d,\"data\":[",
                                sysConfig.deviceId, estimatedChunks, totalRecs);

    dailyLogger.readRange(startTime, endTime, sendDataCallback);

    if (globalRecordsInChunk > 0 || globalCurrentChunkIdx == 1)
    {
      snprintf(globalJsonBuffer + globalJsonOffset, JSON_BUFF_SIZE - globalJsonOffset, "],\"sent_records\":%d}", globalRecordsInChunk);
      nos->sendPacket(srcAddress, srcPort, globalJsonBuffer);
      globalTotalSentRecords += globalRecordsInChunk;
      globalCurrentChunkIdx++;
      delay(50);
    }

    int finalChunk = (globalCurrentChunkIdx > estimatedChunks) ? globalCurrentChunkIdx : estimatedChunks;
    snprintf(globalJsonBuffer, JSON_BUFF_SIZE,
             "{\"device_id\":\"%s\",\"chunk\":%d,\"total_chunks\":%d,\"data\":[],\"sent_records\":0}",
             sysConfig.deviceId, finalChunk, finalChunk);
    nos->sendPacket(srcAddress, srcPort, globalJsonBuffer);

    free(globalJsonBuffer);
    globalJsonBuffer = nullptr;
    ESP.wdtFeed();
  }

  // 5. FETCH-ALL
  else if (strstr(payload, "fetch-all"))
  {
    if (!timeSynced)
    {
      nos->sendPacket(srcAddress, srcPort, "{\"data\":[]}");
      return;
    }

    time_t now = getCurrentTimestamp() + (7 * 3600); // GMT+7
    struct tm *t = localtime(&now);
    t->tm_hour = 0;
    t->tm_min = 0;
    t->tm_sec = 0;
    time_t startOfDay = mktime(t);

    char path[32];
    sprintf(path, "/%04d/%02d/%02d.bin", t->tm_year + 1900, t->tm_mon + 1, t->tm_mday);
    if (DEBUG_LOG)
    {
      Serial.print("Checking log file: ");
      Serial.println(path);
    }
    uint32_t totalRecs = 0;
    File f = SD.open(path, FILE_READ);
    if (f)
    {
      totalRecs = f.size() / 24; // 24 bytes per record (6 fields)
      f.close();
    }
    int estimatedChunks = (totalRecs + MAX_RECORDS_PER_CHUNK - 1) / MAX_RECORDS_PER_CHUNK;
    if (estimatedChunks == 0)
      estimatedChunks = 1;

    globalJsonBuffer = (char *)malloc(JSON_BUFF_SIZE);
    if (!globalJsonBuffer)
      return;

    globalTargetAddr = srcAddress;
    globalTargetPort = srcPort;
    globalCurrentChunkIdx = 1;
    globalRecordsInChunk = 0;
    globalTotalChunks = estimatedChunks;
    globalTotalSentRecords = 0;

    globalJsonOffset = snprintf(globalJsonBuffer, JSON_BUFF_SIZE,
                                "{\"device_id\":\"%s\",\"chunk\":1,\"total_chunks\":%d,\"total_records\":%d,\"range_type\":\"today\",\"data\":[",
                                sysConfig.deviceId, estimatedChunks, totalRecs);

    dailyLogger.readRange(startOfDay - 7 * 3600, now - 7 * 3600, sendDataCallback);

    if (globalRecordsInChunk > 0 || globalCurrentChunkIdx == 1)
    {
      snprintf(globalJsonBuffer + globalJsonOffset, JSON_BUFF_SIZE - globalJsonOffset, "],\"sent_records\":%d}", globalRecordsInChunk);
      nos->sendPacket(srcAddress, srcPort, globalJsonBuffer);
      globalTotalSentRecords += globalRecordsInChunk;
      globalCurrentChunkIdx++;
      delay(50);
    }

    int finalChunk = (globalCurrentChunkIdx > estimatedChunks) ? globalCurrentChunkIdx : estimatedChunks;
    snprintf(globalJsonBuffer, JSON_BUFF_SIZE,
             "{\"device_id\":\"%s\",\"chunk\":%d,\"total_chunks\":%d,\"data\":[],\"sent_records\":0}",
             sysConfig.deviceId, finalChunk, finalChunk);
    nos->sendPacket(srcAddress, srcPort, globalJsonBuffer);

    free(globalJsonBuffer);
    globalJsonBuffer = nullptr;
    ESP.wdtFeed();
  }

  // 6. SD.FORMAT
  else if (strstr(payload, "sd.format"))
  {
    if (WiFi.status() != WL_CONNECTED)
      return;
    nos->sendPacket(srcAddress, srcPort, "{\"status\":\"processing\",\"message\":\"Wiping SD Card content...\"}");
    ESP.wdtFeed();
    bool success = false;
    File root = SD.open("/");
    if (root)
    {
      wipePathRecursive("/");
      success = true;
    }
    char response[128];
    if (success)
      snprintf(response, sizeof(response), "{\"status\":\"formatted\",\"device_id\":\"%s\",\"message\":\"SD Card Wiped. Rebooting...\"}", sysConfig.deviceId);
    else
      snprintf(response, sizeof(response), "{\"status\":\"error\",\"device_id\":\"%s\",\"message\":\"Mount Failed\"}", sysConfig.deviceId);
    nos->sendPacket(srcAddress, srcPort, response);
    delay(2000);
    ESP.restart();
  }

  // 7. REMOTE CLI (HEAP SAFE VERSION)
  else if (strstr(payload, "cli:"))
  {
    // [HEAP] Alokasi memori dinamis 2.5KB untuk help text yang panjang
    // Cukup untuk command help yang verbose setelah escape JSON
    size_t buffSize = 2560;
    char *responseBuff = (char *)malloc(buffSize);

    if (responseBuff != nullptr) // Pastikan alokasi berhasil (Heap cukup)
    {
      String cmdLine = String(payload).substring(4);
      String result = execCommand(cmdLine);

      // Formatting JSON String:
      // Kita perlu escape karakter newline (\n) dan quote (") agar JSON valid
      result.replace("\\", "\\\\"); // Escape backslash dulu
      result.replace("\"", "\\\""); // Escape double quote
      result.replace("\n", "\\n");  // Escape new line

      if (result == "REBOOT_TRIGGERED")
      {
        snprintf(responseBuff, buffSize, "{\"device_id\":\"%s\",\"cli_resp\":\"Command OK. Rebooting device now...\"}", sysConfig.deviceId);
        nos->sendPacket(srcAddress, srcPort, responseBuff);

        free(responseBuff); // Hapus buffer sebelum delay/restart
        delay(1000);
        ESP.restart();
      }
      else if (result == "RESET_TRIGGERED")
      {
        snprintf(responseBuff, buffSize, "{\"device_id\":\"%s\",\"cli_resp\":\"Command OK. Factory Resetting now...\"}", sysConfig.deviceId);
        nos->sendPacket(srcAddress, srcPort, responseBuff);

        free(responseBuff); // Hapus buffer
        delay(1000);
        ESP.restart();
      }
      else
      {
        // Kirim hasil normal
        // Gunakan snprintf untuk proteksi overflow buffer (meski buffer sudah besar)
        int written = snprintf(responseBuff, buffSize,
                               "{\"device_id\":\"%s\",\"cli_resp\":\"%s\"}",
                               sysConfig.deviceId,
                               result.c_str());

        // Cek jika string terpotong (opsional, untuk debug)
        if (written >= (int)buffSize)
        {
          Serial.println("⚠️ Warning: CLI Response truncated!");
        }

        nos->sendPacket(srcAddress, srcPort, responseBuff);

        // [PENTING] Wajib free memori agar tidak Memory Leak!
        free(responseBuff);
      }
    }
    else
    {
      Serial.println("❌ ERROR: Heap full! Cannot allocate CLI buffer.");
      // Opsional: Kirim pesan error pendek (bikin buffer kecil di stack cuma buat error)
      nos->sendPacket(srcAddress, srcPort, "{\"error\":\"Device Heap Full\"}");
    }

    ESP.wdtFeed();
  }
}

// ===== CAPTIVE PORTAL FUNCTIONS =====

// Save new WiFi credentials to sysConfig.wifiCreds[0]
void saveNewWiFiCredentials(const char *ssid, const char *password)
{
  strncpy(sysConfig.wifiCreds[0].ssid, ssid, 20);
  sysConfig.wifiCreds[0].ssid[20] = '\0';
  strncpy(sysConfig.wifiCreds[0].pass, password, 20);
  sysConfig.wifiCreds[0].pass[20] = '\0';

  // Save to EEPROM
  EEPROM.put(0, sysConfig);
  EEPROM.commit();

  if (DEBUG_LOG)
  {
    Serial.printf("✅ Saved new WiFi credentials: %s\n", ssid);
  }
}

// Handle captive portal root page
void handlePortalRoot()
{
  String html = R"rawliteral(
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PowerTelemetry WiFi Setup</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      max-width: 480px;
      width: 100%;
      padding: 32px;
    }
    h1 {
      color: #333;
      font-size: 24px;
      margin-bottom: 8px;
      text-align: center;
    }
    .subtitle {
      color: #666;
      font-size: 14px;
      text-align: center;
      margin-bottom: 24px;
    }
    .status {
      background: #f0f4ff;
      border-left: 4px solid #667eea;
      padding: 12px 16px;
      border-radius: 8px;
      margin-bottom: 24px;
      font-size: 14px;
      color: #333;
    }
    .network-list {
      max-height: 300px;
      overflow-y: auto;
      margin-bottom: 20px;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
    }
    .network-item {
      padding: 14px 16px;
      border-bottom: 1px solid #f0f0f0;
      cursor: pointer;
      transition: background 0.2s;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .network-item:hover {
      background: #f8f9ff;
    }
    .network-item.selected {
      background: #e8edff;
      border-left: 3px solid #667eea;
    }
    .network-item:last-child {
      border-bottom: none;
    }
    .network-name {
      font-weight: 500;
      color: #333;
      flex: 1;
    }
    .signal {
      display: flex;
      align-items: center;
      gap: 4px;
      color: #666;
      font-size: 12px;
    }
    .signal-bar {
      width: 3px;
      background: #ccc;
      border-radius: 2px;
    }
    .signal-bar.active {
      background: #667eea;
    }
    .form-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      margin-bottom: 8px;
      color: #333;
      font-weight: 500;
      font-size: 14px;
    }
    input[type="password"] {
      width: 100%;
      padding: 12px 16px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 15px;
      transition: border 0.3s;
    }
    input[type="password"]:focus {
      outline: none;
      border-color: #667eea;
    }
    .btn {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(102, 126, 234, 0.4);
    }
    .btn:active {
      transform: translateY(0);
    }
    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }
    .loading {
      display: none;
      text-align: center;
      margin-top: 16px;
      color: #667eea;
      font-size: 14px;
    }
    .loading.active {
      display: block;
    }
    .spinner {
      border: 3px solid #f3f3f3;
      border-top: 3px solid #667eea;
      border-radius: 50%;
      width: 24px;
      height: 24px;
      animation: spin 1s linear infinite;
      margin: 0 auto 8px;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .scan-btn {
      width: 100%;
      padding: 10px;
      background: white;
      color: #667eea;
      border: 2px solid #667eea;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      margin-bottom: 16px;
      transition: all 0.2s;
    }
    .scan-btn:hover {
      background: #f8f9ff;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>⚡ PowerTelemetry</h1>
    <p class="subtitle">WiFi Configuration</p>

    <div class="status" id="status">
      Scanning for WiFi networks...
    </div>

    <button class="scan-btn" onclick="scanWiFi()">🔄 Rescan Networks</button>

    <div class="network-list" id="networkList">
      <div style="padding: 20px; text-align: center; color: #999;">
        Loading networks...
      </div>
    </div>

    <div class="form-group">
      <label for="password">WiFi Password</label>
      <input type="password" id="password" placeholder="Enter password">
    </div>

    <button class="btn" id="connectBtn" onclick="connectWiFi()" disabled>
      Connect to WiFi
    </button>

    <div class="loading" id="loading">
      <div class="spinner"></div>
      <div>Connecting to WiFi...</div>
    </div>
  </div>

  <script>
    let selectedSSID = '';

    function scanWiFi() {
      document.getElementById('status').textContent = 'Scanning for WiFi networks...';
      document.getElementById('networkList').innerHTML = '<div style="padding: 20px; text-align: center; color: #999;">Scanning...</div>';

      fetch('/scan')
        .then(r => r.json())
        .then(data => {
          if (data.networks && data.networks.length > 0) {
            document.getElementById('status').textContent = 'Found ' + data.networks.length + ' networks. Select one to continue.';
            renderNetworks(data.networks);
          } else {
            document.getElementById('status').textContent = 'No networks found. Try rescanning.';
            document.getElementById('networkList').innerHTML = '<div style="padding: 20px; text-align: center; color: #999;">No networks found</div>';
          }
        })
        .catch(e => {
          document.getElementById('status').textContent = 'Scan failed. Please try again.';
        });
    }

    function renderNetworks(networks) {
      let html = '';
      networks.forEach((net, idx) => {
        let signalBars = '';
        let strength = Math.min(4, Math.floor((net.rssi + 100) / 12.5));
        for (let i = 0; i < 4; i++) {
          let height = (i + 1) * 3 + 2;
          let active = i < strength ? 'active' : '';
          signalBars += '<div class="signal-bar ' + active + '" style="height: ' + height + 'px"></div>';
        }

        html += '<div class="network-item" onclick="selectNetwork(\'' + net.ssid + '\')">';
        html += '<div class="network-name">' + net.ssid + (net.secure ? ' 🔒' : '') + '</div>';
        html += '<div class="signal">' + signalBars + '</div>';
        html += '</div>';
      });
      document.getElementById('networkList').innerHTML = html;
    }

    function selectNetwork(ssid) {
      selectedSSID = ssid;
      document.querySelectorAll('.network-item').forEach(item => {
        item.classList.remove('selected');
        if (item.textContent.includes(ssid)) {
          item.classList.add('selected');
        }
      });
      document.getElementById('connectBtn').disabled = false;
      document.getElementById('status').textContent = 'Selected: ' + ssid;
    }

    function connectWiFi() {
      if (!selectedSSID) {
        alert('Please select a network first');
        return;
      }

      let password = document.getElementById('password').value;
      document.getElementById('loading').classList.add('active');
      document.getElementById('connectBtn').disabled = true;
      document.getElementById('status').textContent = 'Connecting to ' + selectedSSID + '...';

      fetch('/connect', {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: 'ssid=' + encodeURIComponent(selectedSSID) + '&password=' + encodeURIComponent(password)
      })
      .then(r => r.json())
      .then(data => {
        if (data.status === 'success') {
          document.getElementById('status').textContent = '✅ Connected! Device is restarting...';
          setTimeout(() => {
            document.getElementById('status').textContent = 'Setup complete. You can close this page.';
          }, 3000);
        } else {
          document.getElementById('loading').classList.remove('active');
          document.getElementById('connectBtn').disabled = false;
          document.getElementById('status').textContent = '❌ Connection failed: ' + (data.message || 'Unknown error');
        }
      })
      .catch(e => {
        document.getElementById('loading').classList.remove('active');
        document.getElementById('connectBtn').disabled = false;
        document.getElementById('status').textContent = '❌ Connection failed. Please try again.';
      });
    }

    // Auto-scan on load
    window.onload = function() {
      scanWiFi();
    };
  </script>
</body>
</html>
)rawliteral";

  portalServer->send(200, "text/html", html);
}

// Handle WiFi scan request
void handleWiFiScan()
{
  if (DEBUG_LOG)
    Serial.println("📡 Scanning WiFi networks...");

  int n = WiFi.scanNetworks();
  String json = "{\"networks\":[";

  for (int i = 0; i < n; i++)
  {
    if (i > 0)
      json += ",";
    json += "{";
    json += "\"ssid\":\"" + WiFi.SSID(i) + "\",";
    json += "\"rssi\":" + String(WiFi.RSSI(i)) + ",";
    json += "\"secure\":" + String(WiFi.encryptionType(i) != ENC_TYPE_NONE ? "true" : "false");
    json += "}";
  }

  json += "]}";
  portalServer->send(200, "application/json", json);

  if (DEBUG_LOG)
    Serial.printf("Found %d networks\n", n);
}

// Handle WiFi connect request
void handleWiFiConnect()
{
  if (!portalServer->hasArg("ssid") || !portalServer->hasArg("password"))
  {
    portalServer->send(400, "application/json", "{\"status\":\"error\",\"message\":\"Missing parameters\"}");
    return;
  }

  String ssid = portalServer->arg("ssid");
  String password = portalServer->arg("password");

  if (DEBUG_LOG)
    Serial.printf("🔌 Attempting to connect to: %s\n", ssid.c_str());

  // Try to connect
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid.c_str(), password.c_str());

  unsigned long startAttempt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startAttempt < 15000)
  {
    delay(100);
    ESP.wdtFeed();
  }

  if (WiFi.status() == WL_CONNECTED)
  {
    if (DEBUG_LOG)
      Serial.printf("✅ Connected to %s! IP: %s\n", ssid.c_str(), WiFi.localIP().toString().c_str());

    // Save credentials
    saveNewWiFiCredentials(ssid.c_str(), password.c_str());

    portalServer->send(200, "application/json", "{\"status\":\"success\",\"message\":\"Connected successfully\"}");

    // Stop captive portal
    if (dnsServer)
    {
      dnsServer->stop();
      delete dnsServer;
      dnsServer = nullptr;
    }
    if (portalServer)
    {
      portalServer->stop();
      delete portalServer;
      portalServer = nullptr;
    }

    isAPMode = false;
    portalActive = false;
    WiFi.softAPdisconnect(true);

    delay(2000);
    ESP.restart();
  }
  else
  {
    if (DEBUG_LOG)
      Serial.println("❌ Connection failed!");

    // Return to AP mode
    WiFi.mode(WIFI_AP);
    WiFi.softAP(AP_SSID);

    portalServer->send(200, "application/json", "{\"status\":\"error\",\"message\":\"Connection failed. Check password.\"}");
  }
}

// Start captive portal
void startCaptivePortal()
{
  if (portalActive)
    return;

  if (DEBUG_LOG)
    Serial.println("\n🌐 Starting Captive Portal...");

  // Stop any existing WiFi connection
  WiFi.disconnect();
  delay(100);

  // Start AP mode
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID);

  IPAddress IP = WiFi.softAPIP();
  if (DEBUG_LOG)
    Serial.printf("✅ AP Started: %s\n", AP_SSID);
  if (DEBUG_LOG)
    Serial.printf("📍 AP IP: %s\n", IP.toString().c_str());

  // Start DNS server for captive portal
  dnsServer = new DNSServer();
  dnsServer->start(DNS_PORT, "*", IP);

  // Start web server
  portalServer = new ESP8266WebServer(80);
  portalServer->on("/", handlePortalRoot);
  portalServer->on("/scan", handleWiFiScan);
  portalServer->on("/connect", HTTP_POST, handleWiFiConnect);
  portalServer->onNotFound(handlePortalRoot); // Redirect all requests to portal
  portalServer->begin();

  isAPMode = true;
  portalActive = true;
  apModeStartTime = millis();

  if (DEBUG_LOG)
    Serial.println("✅ Captive Portal Ready!");

  setLEDStatus(LED_WIFI_CONNECTING);
}

// Stop captive portal
void stopCaptivePortal()
{
  if (!portalActive)
    return;

  if (DEBUG_LOG)
    Serial.println("🛑 Stopping Captive Portal...");

  if (dnsServer)
  {
    dnsServer->stop();
    delete dnsServer;
    dnsServer = nullptr;
  }

  if (portalServer)
  {
    portalServer->stop();
    delete portalServer;
    portalServer = nullptr;
  }

  WiFi.softAPdisconnect(true);
  isAPMode = false;
  portalActive = false;
}

// ===== WIFI CHECK & ROTATION =====
void checkWiFiConnection()
{
  // If in AP mode, handle captive portal requests
  if (portalActive)
  {
    dnsServer->processNextRequest();
    portalServer->handleClient();
    return;
  }

  if (WiFi.status() == WL_CONNECTED)
  {
    wifiFailCount = 0; // Reset fail counter on successful connection
    return;
  }

  if (millis() - lastWiFiCheckTime >= WIFI_CHECK_INTERVAL)
  {
    lastWiFiCheckTime = millis();
    setLEDStatus(LED_WIFI_CONNECTING);

    // Cek apakah slot saat ini valid
    if (strlen(sysConfig.wifiCreds[currentWifiIndex].ssid) == 0)
    {
      // Jika kosong, cari slot berikutnya
      bool found = false;
      for (int i = 0; i < 3; i++)
      {
        currentWifiIndex = (currentWifiIndex + 1) % 3;
        if (strlen(sysConfig.wifiCreds[currentWifiIndex].ssid) > 0)
        {
          found = true;
          break;
        }
      }
      if (!found)
      {
        // Tidak ada credentials sama sekali, langsung start captive portal
        if (DEBUG_LOG)
          Serial.println("❌ No WiFi Credentials configured! Starting Captive Portal...");
        startCaptivePortal();
        return;
      }
    }

    if (DEBUG_LOG)
    {
      Serial.printf("🔄 Connecting to WiFi [%d]: %s ...\n",
                    currentWifiIndex, sysConfig.wifiCreds[currentWifiIndex].ssid);
    }

    WiFi.begin(sysConfig.wifiCreds[currentWifiIndex].ssid, sysConfig.wifiCreds[currentWifiIndex].pass);
    unsigned long startAttemptTime = millis();
    // Tunggu hingga koneksi berhasil atau timeout 10 detik
    while (WiFi.status() != WL_CONNECTED && millis() - startAttemptTime < 10000)
    {
      delay(100);
      ESP.wdtFeed();
    }

    if (WiFi.status() == WL_CONNECTED)
    {
      if (DEBUG_LOG)
        Serial.println("✅ WiFi Connected! Forcing Time Sync...");

      wifiFailCount = 0; // Reset fail counter

      // Reset timer supaya di void loop() nanti langsung dieksekusi
      lastTimeSyncTime = 0;

      // Opsional: Pancing NOS loop sebentar biar MQTT bangun
      if (nos)
        nos->loop();
      requestTimeSync();
    }
    else
    {
      // Connection failed, increment fail count
      wifiFailCount++;

      if (DEBUG_LOG)
        Serial.printf("❌ Failed to connect to %s (Attempt %d/3)\n",
                      sysConfig.wifiCreds[currentWifiIndex].ssid, wifiFailCount);

      // Siapkan index berikutnya untuk percobaan nanti
      currentWifiIndex = (currentWifiIndex + 1) % 3;

      // Jika sudah mencoba semua credentials (3 kali gagal), start captive portal
      if (wifiFailCount >= 3)
      {
        if (DEBUG_LOG)
          Serial.println("❌ All WiFi credentials failed! Starting Captive Portal...");
        startCaptivePortal();
        return;
      }
    }

    setLEDStatus(LED_STANDBY); // LED: Connected/standby pattern
  }
}

// ===== OTA CHECK =====
void checkForUpdates(bool force)

{
  if (WiFi.status() != WL_CONNECTED)
    return;

  if (!force && (millis() - lastOtaCheckTime < OTA_CHECK_INTERVAL))
    return;

  lastOtaCheckTime = millis();

  if (DEBUG_LOG)
    Serial.println("⏳ Checking for OTA update...");

  String checkUrl = "http://" + String(sysConfig.otaServer) + ":" + String(sysConfig.otaPort) + "/does-update-available";
  checkUrl += "?current_version=" + String(FIRMWARE_VERSION) + "&class_id=" + String(CLASS_ID);

  WiFiClient client;
  HTTPClient http;
  if (http.begin(client, checkUrl))
  {
    ESP.wdtFeed();
    int httpCode = http.GET();
    if (httpCode == HTTP_CODE_OK)
    {
      String payload = http.getString();
      if (payload.indexOf("\"update_available\":true") != -1)
      {
        String downloadUrl = "http://" + String(sysConfig.otaServer) + ":" + String(sysConfig.otaPort) + "/firmware.bin?class_id=" + String(CLASS_ID);
        setLEDStatus(LED_DOWNLOADING);
        t_httpUpdate_return ret = ESPhttpUpdate.update(client, downloadUrl, FIRMWARE_VERSION);
        if (ret == HTTP_UPDATE_OK)
          ESP.restart();
      }
    }
    http.end();
  }
  setLEDStatus(LED_STANDBY);
}

// ==================== SETUP ====================
void setup()
{
  if (isConfigMode)
  {
    Serial.begin(115200);
    Serial.setTimeout(10000);
    delay(500);
  }
  else
  {
    activateRPMSensorMode();
  }
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, HIGH);

  // 1. EEPROM & CONFIG
  EEPROM.begin(EEPROM_SIZE);
  loadConfig();

  Serial.printf("\n===== STARTUP: %s =====\n", sysConfig.deviceId);

  // Start Config Mode Timer
  configModeStartTime = millis();
  Serial.println(F("\n╔════════════════════════════════════════╗"));
  Serial.println(F("║   🔧 CONFIG MODE ACTIVE (60 seconds)  ║"));
  Serial.println(F("║   Serial RX available for setup       ║"));
  Serial.println(F("║   Type 'help' for command list        ║"));
  Serial.println(F("╚════════════════════════════════════════╝\n"));

  // 2. NOS INIT (Menggunakan Device ID dari EEPROM)
  nos = new NOS(sysConfig.deviceId, 100, key, sysConfig.mqttServer, sysConfig.mqttPort);
  nos->begin();
  nos->onMessage(handleNOSMessage); // Registrasi Handler FULL

  // 3. SD CARD
  Serial.println("⏳ Mounting SD Card...");
  if (dailyLogger.begin())
  {
    Serial.println("✅ SD Ready");
  }
  else
  {
    Serial.println("❌ SD Fail / Missing!");
    setLEDStatus(LED_SD_ERROR);
  }

  // 4. SENSOR & WDT
  Wire.begin();
  ina226.begin();
  ina226.configure(0.002, 0.05, 0, 10000);

  watchdogEnable();

  // 5. ADDITIONAL SENSORS (Voltage2 only, RPM after config mode)
  // setupAdditionalSensors(); // Dipanggil setelah config timeout

  // Paksa cek wifi pertama kali
  checkWiFiConnection();
}

// ==================== LOOP ====================
void loop()
{
  // 0. Check Config Mode Timeout
  if (isConfigMode)
  {
    unsigned long elapsed = millis() - configModeStartTime;

    // Print countdown every 15 seconds
    if (!configModeTimeoutPrinted && (elapsed % 15000 < 100))
    {
      unsigned long remaining = (CONFIG_MODE_TIMEOUT - elapsed) / 1000;
      if (remaining > 0)
      {
        // Serial.printf("⏳ Config mode timeout in %lu seconds...\n", remaining);
      }
    }

    // Timeout reached
    if (elapsed >= CONFIG_MODE_TIMEOUT)
    {
      configModeTimeoutPrinted = true;
      activateRPMSensorMode();
    }
  }

  // 1. Check CLI Command (ONLY in config mode)
  if (isConfigMode)
  {
    handleSerialCLI();
  }

  // 2. Standard Routine
  checkWiFiConnection();
  checkForUpdates(false);
  updateLED();

  if (WiFi.status() == WL_CONNECTED && nos)
    nos->loop();
  ArduinoOTA.handle();

  unsigned long currentTime = millis();

  if (currentTime - lastTimeSyncTime >= TIME_SYNC_INTERVAL)
  {
    lastTimeSyncTime = currentTime;
    requestTimeSync();
  }

  if (currentTime - lastReadTime >= READ_INTERVAL)
  {
    lastReadTime = currentTime;

    // Baca Raw Sensor
    // float shunt_mV = ina226.getShuntVoltage(); // Unused
    float bus_V = ina226.getBusVoltage(); // Ini nilai kecil (max ~32V) hasil divider

    // [UBAH LOGIKA VOLTAGE]
    // Hapus "+ (shunt_mV / 1000.0)" karena di Low-Side sensing, referensi VBUS sudah beda.
    // sysConfig.voltageFactor sekarang wajib diisi nilai Rasio Divider (sekitar 3.12)

    // Opsi 1: Filter dulu baru kali Faktor (Lebih smooth grafiknya)
    lastFiltered_V = sysConfig.voltageFactor * voltageFilter.updateEstimate(bus_V);

    float current_mA = ina226.getCurrent_mA();

    // [UBAH] Pakai sysConfig.currentFactor
    float current_A = (current_mA * sysConfig.currentFactor) / 1000.0;

    lastFiltered_A = currentFilter.updateEstimate(current_A);

    // --- RPM Calculation (with debounce + sanity checks) ---
    float calculatedRPM = 0.0;

    // Only calculate RPM when NOT in config mode (sensor active)
    if (!isConfigMode)
    {
      // Snapshot shared variables safely
      noInterrupts();
      unsigned long pi = pulseInterval;
      unsigned long lastPulseTime = lastValidPulseTime;
      interrupts();

      unsigned long timeSinceLastPulse = micros() - lastPulseTime;

      if (pi > 0 && timeSinceLastPulse < 1000000)
      {
        // Compute RPM from last interval; rely on ISR debounce to filter bounces.
        float frequencyHz = 1000000.0 / (float)pi;
        float rpm = (frequencyHz * 60.0) / PULSES_PER_REV;
        // Clamp/ignore unrealistic spikes by falling back to previous filtered value
        if (rpm <= MAX_EXPECTED_RPM)
        {
          calculatedRPM = rpm;
        }
        else
        {
          calculatedRPM = MAX_EXPECTED_RPM;
        }
      }
      else if (timeSinceLastPulse > 1000000)
      {
        // No pulses for >1s => RPM = 0
        calculatedRPM = 0.0;
      }

      filteredRPM = rpmFilter.updateEstimate(calculatedRPM);
    }
    else
    {
      // In config mode, RPM = 0
      filteredRPM = 0.0;
    }

    // --- Voltage2 Reading ---
    // R1 = 300K, R2 = 10K / old
    // R1 = 300K, R2 = 8K2 / new
    int adcValue = analogRead(VOLTAGE2_PIN);
    float rawVoltage2 = (adcValue / 1023.0) * 3.3; // ESP8266 ADC ref 3.3V
    filteredVoltage2 = voltage2Filter.updateEstimate(sysConfig.voltage2Factor * rawVoltage2);
  }

  unsigned long dynamicPubInterval = (unsigned long)sysConfig.publishIntervalSec * 1000;
  if (currentTime - lastPublishTime >= dynamicPubInterval)
  {
    lastPublishTime = currentTime;
    char data[64]; // Perbesar buffer

    snprintf(data, sizeof(data), "01:%.2f;02:%.2f;03:%.0f;04:%.2f", lastFiltered_V, lastFiltered_A, filteredRPM, filteredVoltage2);
    if (DEBUG_LOG)
    {
      Serial.print("Publishing Data: ");
      Serial.println(data);
    }
    // snprintf(data, sizeof(data), "01:%.2f;02:%.2f", lastFiltered_V, lastFiltered_A);

    if (WiFi.status() == WL_CONNECTED && nos)
    {
      setLEDStatus(LED_SENDING); // LED: Solid ON while sending
      updateLED();
      nos->sendPacket(DESTINATION_ADDRESS, 1000, data);
      delay(500);                // Brief delay to ensure sending completes
      setLEDStatus(LED_STANDBY); // LED: Back to standby after sending
    }
    // LOGGING DENGAN INTERVAL DINAMIS
    unsigned long dynamicLogInterval = (unsigned long)sysConfig.logIntervalSec * 1000;
    if (currentTime - lastLogTime >= dynamicLogInterval)
    {
      lastLogTime = currentTime;
      if (timeSynced)
      {
        time_t now = getCurrentTimestamp();
        uint8_t status = (WiFi.status() == WL_CONNECTED) ? 1 : 2;
        dailyLogger.log(now, lastFiltered_V, lastFiltered_A, filteredRPM, filteredVoltage2, status); // Lengkap dengan RPM & Voltage2
      }
    }
  }
}

// ==================== I2C SCANNER ====================
// #include <Arduino.h>
// #include <Wire.h>

// void setup()
// {
//   Wire.begin();

//   Serial.begin(115200);
//   while (!Serial)
//     ; // Leonardo: wait for Serial Monitor
//   Serial.println("\nI2C Scanner");
// }

// void loop()
// {
//   int nDevices = 0;

//   Serial.println("Scanning...");

//   for (byte address = 1; address < 127; ++address)
//   {
//     // The i2c_scanner uses the return value of
//     // the Wire.endTransmission to see if
//     // a device did acknowledge to the address.
//     Wire.beginTransmission(address);
//     byte error = Wire.endTransmission();

//     if (error == 0)
//     {
//       Serial.print("I2C device found at address 0x");
//       if (address < 16)
//       {
//         Serial.print("0");
//       }
//       Serial.print(address, HEX);
//       Serial.println("  !");

//       ++nDevices;
//     }
//     else if (error == 4)
//     {
//       Serial.print("Unknown error at address 0x");
//       if (address < 16)
//       {
//         Serial.print("0");
//       }
//       Serial.println(address, HEX);
//     }
//   }
//   if (nDevices == 0)
//   {
//     Serial.println("No I2C devices found\n");
//   }
//   else
//   {
//     Serial.println("done\n");
//   }
//   delay(5000); // Wait 5 seconds for next scan
// }

// ==================== END OF FILE ====================

// INA226 diagnostics

// #include <Arduino.h>
// #include <Wire.h>
// #include <INA226.h>

// INA226 ina226(0x44);
// double voltageFactor = 3.26; // Voltage divider ratio

// void setup()
// {
//   Serial.begin(115200);
//   delay(500);
//   Serial.println("INA226 Diagnostics");

//   Wire.begin();
//   ina226.begin();
//   ina226.configure(0.002, 0.05, 0, 10000);
// }

// void loop()
// {
//   float shunt_mV = ina226.getShuntVoltage();
//   float bus_V = voltageFactor * ina226.getBusVoltage();
//   float current_mA = ina226.getCurrent_mA();
//   float power_mW = ina226.getPower_mW();

//   Serial.printf("Shunt Voltage: %.3f mV\n", shunt_mV);
//   Serial.printf("Bus Voltage: %.3f V\n", bus_V);
//   Serial.printf("Current: %.3f mA\n", current_mA);
//   Serial.printf("Power: %.3f mW\n\n", power_mW);

//   delay(1000);
// }