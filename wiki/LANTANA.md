# Lantana — IoT Stack Komprehensif (TSIX)

**Lantana** adalah stack IoT multi-device untuk TSIX. Satu daemon menjalankan 3 layer
yang terpisah per file (separation of concern):

```
MQTNL port 1000 ─▶ lantana-listener.ts      (raw ingest — biner/plaintext auto-detect)
   │  in-process
   ▼
   lantana-device-bank.ts                   (registry multi-device + sensor + kategori + heartbeat)
   │
   ▼
   lantana-distributor.ts                   (normalisasi + enrich dataAgeMs + tenant → broadcast)
   │  IPC (LANTANA_SENSOR_DATA / LANTANA_DEVICE_STATUS / LANTANA_SNAPSHOT)
   ├──▶ lantana-dashboard     (GUI, dijalankan manual)
   ├──▶ lantana-db-injector   (MySQL via DbLib/mysqld)
   └──▶ lantana-file-logger   (history ke /var/log/lantana/)
```

## Lokasi file

| Komponen | Path |
|---|---|
| Config | `src/mirror/etc/lantana/config.json` → `/etc/lantana/config.json` |
| Shared core (types, parser, config loader) | `src/mirror/lib/lantana/lantana-core.ts` |
| Layer 1 — Listener | `src/mirror/lib/lantana/lantana-listener.ts` |
| Layer 2 — Device Bank | `src/mirror/lib/lantana/lantana-device-bank.ts` |
| Layer 3 — Distributor | `src/mirror/lib/lantana/lantana-distributor.ts` |
| Daemon utama | `src/mirror/opt/lantana/lantana.ts` |
| Consumer — Dashboard | `src/mirror/opt/lantana/lantana-dashboard.ts` |
| Consumer — DB Injector | `src/mirror/opt/lantana/lantana-db-injector.ts` |
| Consumer — File Logger | `src/mirror/opt/lantana/lantana-file-logger.ts` |
| Test parser | `src/mirror/lib/lantana/lantana-core.test.ts` |

> Modul layer ditaruh di `lib/lantana/` agar bisa di-import sebagai `@tsix/lantana/*`
> (resolver worker `@tsix/` → `/lib/`). Entry/consumer di `opt/lantana/`.

## Cara pakai

```sh
# Auto-start saat boot (sudah di-enable di rc.local)
#   /opt/lantana/lantana.js

# Manual
lantana            # start daemon (background)
lantana --fg       # foreground debug
lantana --stop     # stop via pidfile

# Consumer (dijalankan manual)
lantana-dashboard [target] [tenant]          # GUI (dari Asteracea/CLI)
lantana-db-injector <target> --db host user pass dbname [tenant]
lantana-file-logger <target> [tenant]
```

`target` bisa berupa PID atau UUID Lantana (`5f4e2a91-...`), default ke UUID.

## Format data — biner ATAU plaintext

Listener otomatis mendeteksi format dari payload MQTNL:

- **Biner**: frame sensor Lantana `0x4C 0x01` (atau payload MQTNL binary v1.1 `0x42`).
  Struktur frame:
  ```
  [0x4C][0x01][nodeLen:1][nodeId...][cnt:1]
  per sensor: [sidLen:1][sid...][value:4 float32 LE]
  ```
- **Plaintext**: `LANTANA|<nodeId>|<sensorId:value;sensorId:value;...>` (ber-nodeId,
  protokol baru) ATAU `sensorId:value;sensorId:value;...` (kompatibel `iot-listener` lama).

Contoh plaintext: `LANTANA|esp32-01|01:25;02:60;03:1013;04:100`

## Config (`/etc/lantana/config.json`)

```jsonc
{
  "ports": {
    "1000": { "tenant": "default", "keyHex": "...", "enabled": true, "mode": "auto" }
  },
  "deviceCategories": { "esp32": { "label": "ESP32", "icon": "🔧" }, ... },
  "sensorCategories": { "temp": { "label": "Temperature", "unit": "°C", ... }, ... },
  "sensorIdMap": { "01": "temp", "02": "hum", "03": "pres", "04": "light" }
}
```

- **Key** (ChaCha20) diambil dari config per port — bukan hardcode. Struktur `ports`
  berbentuk map `{ port → { tenant, keyHex, enabled } }` sehingga siap di-extend ke
  multi-port/multi-key (tenant berbeda) tanpa rombak besar.
- **Kategori device & sensor statis** di config (keputusan: dinamis dari device = fase 2).
- `sensorIdMap` memetakan id sensor (`01`) ke kategori (`temp`).

## Konsep

- **Device Bank**: registry in-memory semua device (nodeId) + sensor. Heartbeat/health
  dihitung dari `lastDataAt`:
  - `dataAgeMs <= 15s` → `ONLINE`
  - `<= 60s` → `STALE`
  - `> 60s` → `OFFLINE`
- **Distributor**: menerima raw → enrich (kategori, label, tenant, dataAgeMs, status)
  → broadcast `LANTANA_SENSOR_DATA` ke consumer terdaftar (filter per tenant).
- **Consumer** mendaftar via `LANTANA_REGISTER` (dengan filter tenant opsional) dan bisa
  minta `LANTANA_SNAPSHOT` untuk data terkini.
- **Tenant**: tiap data ditandai tenant (asal port) — consumer bisa memilah per user.

## Status / fase berikutnya

- [x] 3 layer daemon (listener, device-bank, distributor) + config `/etc/lantana/`
- [x] Format biner + plaintext (auto-detect)
- [x] Multi-device + kategori statis + heartbeat/umur data + tenant
- [x] Consumer: dashboard (GUI), db-injector (MySQL), file-logger (VFS history)
- [x] Auto-start daemon di `rc.local`
- [ ] Telegram (tunda)
- [ ] Firmware ESP32 asli (tunda — simulator sudah sinkron nodeId & biner)
- [ ] Kategori dinamis dari device; UI register/edit device manual (fase 2)
- [ ] Multi-key per port (opsi B/C) — struktur config sudah siap

## Catatan

- File lama `/sbin/iot-listener.ts` **dibiarkan** (tidak dihapus), tidak di-enable di
  `rc.local`, sehingga tidak konflik port 1000.
- Sinkronisasi ke VFS via `npm run vfs:bootstrap` (semua `.ts` di `/opt`/`/lib` di-transpile
  otomatis ke `.js`; `.json` ikut ter-sync).
