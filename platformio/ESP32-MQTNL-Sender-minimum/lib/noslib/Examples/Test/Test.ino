
#include <noslib.h>

// === Konfigurasi ===
#define WIFI_SSID "BabamGo"
#define WIFI_PASSWORD "bismillah"
#define MQTT_SERVER "192.168.0.105"
#define MQTT_PORT 1883

// API key tenant (string hex) = kunci enkripsi 256-bit — dari portal Lantana
char apiKey[] = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

// === Inisialisasi NOS ===
NOS nos("myESP", 100, apiKey, MQTT_SERVER, MQTT_PORT);

// === Fungsi: Handler pesan masuk ===
void messageReceived(const char *srcAddress, int srcPort, const char *payload)
{
  Serial.printf("Message from %s:%d -> %s\r\n", srcAddress, srcPort, payload);
}

// === Fungsi: Koneksi ke WiFi ===
bool connectToWiFi()
{
  Serial.print("WiFi connecting...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  for (int i = 0; i < 20 && WiFi.status() != WL_CONNECTED; ++i)
  {
    delay(1000);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED)
  {
    Serial.println("\nWiFi connected!");
    Serial.print("IP Address: ");
    Serial.println(WiFi.localIP());
    return true;
  }

  Serial.println("\nWiFi connection failed!");
  return false;
}

// === Setup ===
void setup()
{
  Serial.begin(115200);
  delay(1000);

  if (connectToWiFi())
  {
    nos.begin(); // Koneksi MQTT dan inisialisasi NOS
    nos.onMessage(messageReceived);
  }
}

// === Loop ===
void loop()
{
  nos.loop(); // Harus dipanggil terus-menerus

  static uint32_t lastSent = 0;
  if (millis() - lastSent >= 1000)
  {
    char data[64];
    sprintf(data, "We're from ESP32 %lu, prepare yourself!", millis());
    nos.sendPacket("dec", 1000, data);
    Serial.println("Packet sent.");
    lastSent = millis();
  }
}
