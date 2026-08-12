# Changelog Install & Scripts TSIX

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-08-10

### Script instalasi `npm run install` (Fresh Install Agent)
- **File:** `scripts/install.ts`, `package.json`
- **Perubahan:** Script interaktif baru: prompt hostname/user/broker MQTT/port/verbose/path DB/password root → tulis `src/sysconfig.json` → buat DB `.db` baru → sync `src/mirror` + `src/common` (`/lib/common`) → mode eksekusi/SetUID → seed passwd/shadow/group → fstab hanya `/tmp` ramfs → crontab kosong. Tidak bergantung pada `sysconfig.json` yang sudah ada (memakai config default & membuatnya). `version` diambil otomatis dari `Kernel.ts`; `distroName` & `creator` tidak diinput (identitas bawaan).
- **Dampak:** Fresh install cukup satu perintah; tidak perlu `vfs:bootstrap` terpisah.
- **Oleh:** Copilot

### Path DB default bersama dari `sysconfig.json`
- **File:** `scripts/lib/db-path.ts`, `scripts/vfs-bootstrap.ts`, `scripts/create-bkfs.ts`, `scripts/sync-vfs.ts`, `scripts/sync-tde.ts`, `scripts/vfs-pull.ts`, `scripts/clean_bloat.js`
- **Perubahan:** Helper `getDefaultDbPath()` membaca `kernel.database` dari `src/sysconfig.json` (fallback `system.db`). Semua script memakainya, menggantikan hardcode `system.db`/`system2.db`.
- **Dampak:** Path DB selalu sinkron dengan hasil instalasi.
- **Oleh:** Copilot

### Mode eksekusi & SetUID untuk direktori binary
- **File:** `scripts/sync-vfs.ts`, `scripts/vfs-bootstrap.ts`, `scripts/install.ts`
- **Masalah:** Script sync hanya chmod `/bin/`; `/sbin`, `/usr/bin`, `/usr/local/bin` dibiarkan `0644` → `shutdown`/`reboot` & daemon `/sbin/*` kena `Permission denied`.
- **Perubahan:** Helper `isSetuidBinary`/`isExecutableBinary`/`applyBinaryMode`: `/bin` → 0755, `/sbin` → 0744 (root-only), `/usr/bin` & `/usr/local/bin` → 0755; SetUID 4755 untuk `login`/`passwd`/`sudo`.
- **Dampak:** Semua binary di direktori eksekusi bisa dijalankan dari PATH.
- **Oleh:** Copilot

### Fresh install: fstab & crontab dibersihkan
- **File:** `scripts/install.ts`
- **Perubahan:** `/etc/fstab.json` pada image fresh hanya berisi `/tmp` ramfs (mount dev `/mnt/shared`, `/mnt/sbak` dihapus); `/etc/crontab` kosong.
- **Dampak:** Image distribusi tidak membawa mount/cron bawaan developer.
- **Oleh:** Copilot
