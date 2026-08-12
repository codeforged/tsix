# Documentation: Secure OTA via MQTNL

This document provides a comprehensive overview of the Over-The-Air (OTA) update system implemented using the MQTNL protocol within the TSIX ecosystem.

## 1. Architecture Overview
The system follows a **Pull-based Architecture** where the edge device (ESP8266/ESP32) is responsible for initiating the update check and pulling data chunks from the server.

- **Storage**: Binary firmwares are stored in `/etc/esp-ota/firmwares/` on the TSIX VFS.
- **Server**: A stateless MQTNL server (`/bin/ota-server.ts`) handles requests.
- **Client**: The `NosOTA` C++ library on the ESP device manages the flashing process.
- **Security**: All traffic is encrypted using **ChaCha20-Poly1305** via MQTNL session keys.

## 2. Protocol Specification (JSON over MQTNL)

### 2.1 Update Check (`ota.info`)
**Request:**
```json
{ "cmd": "ota.info" }
```
**Response:**
```json
{
  "cmd": "ota.info_res",
  "version": "1.0.1",
  "size": 306736
}
```

### 2.2 Data Pull (`ota.read`)
**Request:**
```json
{
  "cmd": "ota.read",
  "offset": 2048,
  "len": 2048
}
```
**Response:**
```json
{
  "cmd": "ota.data",
  "offset": 2048,
  "data": "BASE64_ENCODED_BINARY_CHUNK...",
  "eof": false
}
```

## 3. Configuration & Tuning

### Chunk Size
The system is tuned for **2048 bytes** by default.
- **ESP Side**: Defined in `lib/nosOTA/nosOTA.h` as `NOS_OTA_CHUNK_SIZE`.
- **Server Side**: Defined in `/bin/ota-server.ts` as `DEFAULT_CHUNK_SIZE`.

> [!IMPORTANT]
> Increasing the chunk size to 4096+ may cause **Out-Of-Memory (OOM)** crashes on ESP8266 devices due to the RAM requirements of JSON parsing and Base64 decoding.

### Multi-Device Support
The server supports concurrent updates. It caches the firmware in RAM to prevent disk I/O bottlenecks and displays a non-scrolling progress bar for all active devices:
`[OTA] Active: 01 (40%), 102 (12%)`

## 4. VFS Internals (Critical Notes)
To ensure binary integrity, the TSIX VFS was patched during this implementation:
1. **Binary Encoding**: `HostVFS` must use `binary` (latin1) encoding to prevent UTF-8 corruption of firmwares.
2. **Size Metadata**: `BKFS` uses a dedicated `size` column because SQLite's `length()` function truncates at the first null byte (`00`).

### Robustness Tuning (Internet/Hotspot Mode)
For unstable connections (high jitter, high latency), use the following "Safe Mode" settings:
- **Chunk Size**: 1024 bytes (reduces fragmentation risk).
- **Timeout**: 10,000ms (10 seconds to allow for jitter).
- **Retries**: 15 (maximum patience).
- **Out-of-Sync Handling**: `NosOTA` now forces a fresh request if it detects a late/duplicate packet from the broker to "kick" the stream back to life.

## 5. Troubleshooting
- **Timeout Errors**: Occur if the MQTT broker is congested or the chunk size is too large for the network.
- **JSON Parsing Error**: Ensure the payload is "clean" (stripped of null-padding) before parsing.
- **Not Enough Space**: Check that the ESP partition table has a large enough OTA slot for the binary file.

---
*Developed for the TSIX Edge Management System.*
