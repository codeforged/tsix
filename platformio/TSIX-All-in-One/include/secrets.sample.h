// ─────────────────────────────────────────────────────────────
// SECRETS.SAMPLE.H — template kredensial (DI-COMMIT).
// Salin file ini menjadi `secrets.h` di folder `include/`, lalu isi
// kredensial WiFi/MQTT/API key kamu. `secrets.h` TIDAK ikut di-commit
// (lihat .gitignore), jadi kredensial asli tidak pernah masuk git.
// ─────────────────────────────────────────────────────────────
#ifndef TSIX_SECRETS_SAMPLE_H
#define TSIX_SECRETS_SAMPLE_H

#define TSIX_WIFI_SSID     "Your SSID"
#define TSIX_WIFI_PASSWORD "Your Password"
#define TSIX_MQTT_SERVER   "192.168.1.204"
#define TSIX_MQTT_PORT     1883
#define TSIX_API_KEY       "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

#endif // TSIX_SECRETS_SAMPLE_H
