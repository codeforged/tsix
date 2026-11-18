// ─────────────────────────────────────────────────────────────
// SECRETS.SAMPLE.H — credential template (COMMITTED).
// Rename this file to `secrets.h` in the `include/` folder, then fill in
// ─────────────────────────────────────────────────────────────

#ifndef TSIX_SECRETS_SAMPLE_H
#define TSIX_SECRETS_SAMPLE_H

#define TSIX_WIFI_SSID     "Your SSID"
#define TSIX_WIFI_PASSWORD "Your Password"
#define TSIX_MQTT_SERVER   "MQTT Server IP or Hostname"
#define TSIX_MQTT_PORT     1883
#define TSIX_API_KEY       "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// ── Lantana V2 ──
// AccessKey diterbitkan Lantana: `lantana-ctl account key-issue <akun>`.
// deviceId diterbitkan saat `lantana-ctl device add <akun>`.
#define TSIX_ACCOUNT_ID    "juragan"
#define TSIX_DEVICE_ID     "7f352db1-c787-4976-b441-d1bf7387fe49"
#define TSIX_ACCESS_KEY    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// Fingerprint public key server (16 hex char, HURUF BESAR) untuk pinning di
// ESP32 (mode RSA). Lihat: `lantana-ctl server fingerprint`.
// Kosongkan "" untuk sekadar mencetak peringatan tanpa menolak.
#define TSIX_LANTANA_FINGERPRINT ""

#endif // TSIX_SECRETS_SAMPLE_H
