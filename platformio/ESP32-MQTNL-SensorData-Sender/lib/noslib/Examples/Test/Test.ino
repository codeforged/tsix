
#include <noslib.h>

// === Konfigurasi ===
#define WIFI_SSID     "BabamGo"
#define WIFI_PASSWORD "bismillah"
#define MQTT_SERVER   "192.168.0.105"
#define MQTT_PORT     1883

// Kunci enkripsi 256-bit (32 bytes)
char key[KEY_SIZE] = {
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
  0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F,
  0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17,
  0x18, 0x19, 0x1A, 0x1B, 0x1C, 0x1D, 0x1E, 0x1F
};

// === Inisialisasi NOS ===
NOS nos("myESP", 100, key, MQTT_SERVER, MQTT_PORT);

// === Fungsi: Handler pesan masuk ===
void messageReceived(const char* srcAddress, int srcPort, const char* payload) {
  Serial.printf("Message from %s:%d -> %s\r\n", srcAddress, srcPort, payload);
}

// === Fungsi: Koneksi ke WiFi ===
bool connectToWiFi() {
  Serial.print("WiFi connecting...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  for (int i = 0; i < 20 && WiFi.status() != WL_CONNECTED; ++i) {
    delay(1000);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi connected!");
    Serial.print("IP Address: ");
    Serial.println(WiFi.localIP());
    return true;
  }

  Serial.println("\nWiFi connection failed!");
  return false;
}

// === Setup ===
void setup() {
  Serial.begin(115200);
  delay(1000);

  if (connectToWiFi()) {
    nos.begin();  // Koneksi MQTT dan inisialisasi NOS
    nos.onMessage(messageReceived);
  }
}

// === Loop ===
void loop() {
  nos.loop();  // Harus dipanggil terus-menerus

  static uint32_t lastSent = 0;
  if (millis() - lastSent >= 1000) {
    char data[64];
    sprintf(data, "We're from ESP32 %lu, prepare yourself!", millis());
    nos.sendPacket("dec", 1000, data);
    Serial.println("Packet sent.");
    lastSent = millis();
  }
}
