# Changelog FHS Restructure

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-08-04

### Komponen dipindah `/etc` → `/opt`
- **Perubahan:** Folder komponen (asteracea, dome, eucalyptus, file-cruiser, iot-dashboard, krisan, mysqld, pixelspace-traffic, pixelterm, set-theme, taskmgr, esp-ota) dipindah dari `/etc/` ke `/opt/<app>/`. `/etc` kini murni config (passwd, shadow, group, fstab, motd, profile, rc.local, crontab, keys, tpkg, tsd). `bash_completion.d` dihapus.
- **Dampak:** Sesuai FHS — software mandiri hidup di `/opt/<app>/`, config di `/etc`.
- **Oleh:** Copilot

### Sweep `/bin` → `/sbin`, `/usr/bin`, `/opt` (FHS)
- **Perubahan:**
  - **`/sbin`** (13) — daemon: airtermd, apply-update, crond, iot-listener, otad, reboot, scpd, shutdown, tpkg, tpkgd, tpkg-setup, userlib-update, vfs-pull.
  - **`/usr/bin`** (19) — tool: airterm, bkfs, bitshark, crontab, debug_tpkg, esp-send, forward, ifconfig, img2b64, ipc-listen, ipc-send, listen_net, nettop, nmap, ota-gen-ak, ping_net, scp, ssh-keygen, sys-diag, tbuild, uuid-gen.
  - **`/opt/<app>`** (7) — aplikasi GUI: eucalyptus, file-cruiser, iot-dashboard, pixelspace-traffic, pixelterm, set-theme, taskmgr.
  - **`/bin`** (48) — coreutils + init/login/tsh/atto.
  - **`/opt/test`** (32) — script test/demo (cashew-demo*, gui-demo, gui-test, gui-hello-world, hello-*, mqtnl-*-demo, test-*, dll.) dipindah dari `/bin`.
- **Referensi di-update:** `rc.local` (daemon → `/sbin/*`), menu asteracea, `profile` (PATH), `crontab`, `tpkg/packages.json` (staging `/tmp/system-updates/bin/` sengaja di-guard), pemanggil path lama di kode.
- **Import relatif disesuaikan:** file `sbin/` pakai `../lib/...`; file `usr/bin/` & `opt/test/` pakai `../../lib/...` (+ `../../../kernel/...`). Alias `@tsix/*`/`@common/*` aman di mana pun.
- **Dampak:** Struktur filesystem mengikuti FHS; `/bin` hanya coreutils; PATH lengkap di profile.
- **Oleh:** Copilot
