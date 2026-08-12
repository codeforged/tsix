# Guide: Integrating Secure NosOTA into Your Firmware

Integrating Over-The-Air (OTA) updates is now faster and more secure. The `NosOTA` library encapsulates WiFi, MQTNL, Serial CLI, and persistent configuration.

## 1. Copy the Library Files
Copy the following directory into your Project's `lib/` folder:
- `lib/nosOTA/` (The secure OTA core)
- `lib/noslib/` (MQTNL communication layer)

## 2. Basic Setup (main.cpp)

### A. Initialization
Define your `NOS` and `NosOTA` instances globally:
```cpp
#include <nosOTA.h>

const uint8_t shared_key[32] = { ... }; // Your 32-byte session key
NOS nos("MY-DEVICE", 100, (const char*)shared_key, "", 1883); 
NosOTA ota(&nos);

// Boilerplate MQTNL callback
void handleNOSMessage(const char *src, int port, const char *payload) {
    ota.handleMessage(src, port, payload);
}
```

### B. Setup Function
Initialize the library in `setup()`:
```cpp
void setup() {
    Serial.begin(115200);
    ota.begin();                // 1. Mounts FS & loads config
    ota.setKey(shared_key);     // 2. Passes key for re-init
    ota.setFWVersion("1.0.8");  // 3. Set your version
    ota.connectWiFi();          // 4. orchestration (WiFi + MQTNL)
    
    nos.onMessage(handleNOSMessage);
}
```

### C. Loop Function
Add the handlers to your main `loop()`:
```cpp
void loop() {
    nos.loop();          // MQTNL processing
    ota.loop();          // OTA state machine
    ota.handleSerial();   // Interactive CLI (WiFi/OTA setup)
}
```

## 3. Security: Activation Key (AK)
To prevent unauthorized cloning, updates require a 6-digit **Activation Key**:
1. Generate keys on TSIX server: `ota-gen-ak 100`.
2. Set the key on device via CLI: `set-ak ABCDEF`.
3. Valid keys are **Single-Use** and removed from the server after success.

## 4. CLI Commands
The library provides a built-in interactive Serial terminal (`115200` baud):
- `set-wifi <ssid> <pass>` : Configure Access Point.
- `set-mqtt <host> <port>` : Target MQTT broker address.
- `set-ota  <host> <port>` : Target OTA server address.
- `set-ak   <key>`          : Enter 6-digit Activation Key.
- `save`                   : Comit settings to Flash.
- `fw-update`              : Start the secure OTA process.
- `status` / `version`     : Check current device state.

---
**Security Note**: Encryption is managed automatically via ChaChaPoly/MQTNL. Ensure the `shared_key` is identical on the ESP and the OTA Host (TSIX).
