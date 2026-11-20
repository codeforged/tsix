# Changelog Distro TSIX

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-11-20

### Inventaris file dan TSIX IoT Edition generator

- **File utama:** `scripts/lib/tsix-file-inventory.ts`,
  `scripts/inventory-tsix-files.ts`, `scripts/lib/distro-generator.ts`,
  `scripts/distro-generator.ts`, `distro/manifests/iot-edition.json`,
  `distro/iot-edition/manifest.json`
- **Inventaris:** klasifikasi berbukti dan tag domain diperluas; komponen inti TDE
  (`PixelSpace`, DOME, Asteracea, Emerald, Cashew, Pistachio) dibedakan dari
  aplikasi yang hanya memakai library desktop. Contoh ambigu masuk antrean
  `needs-review`; metadata PlatformIO lokal dan AppleDouble tidak dipindai.
- **Distro:** manifest sumber menentukan scope IoT + TDE; generator meresolusikan
  daftar file, menyalinnya dengan struktur path asal, menulis manifest beserta
  checksum, dan membuat README instalasi. Generator menolak path/symlink yang
  tidak aman serta perubahan manual pada output yang dikelolanya. Draft saat ini
  memuat 404 file sumber.
- **Installer:** paket membawa `scripts/install.ts`, dependensi lokalnya, serta
  metadata npm. Di paket hasil generate, script npm `install` menjadi
  `tsix:install`, agar `npm install` tidak menjalankan pembuat image otomatis.
  Akun lokal dari repo tidak dipaketkan; installer membuat root terkunci dan
  meminta password saat instalasi interaktif.
- **Pemakaian:** `npm run distro:inventory`, `npm run distro:generate -- --check`,
  lalu `npm run distro:generate`.
- **Validasi:** tes terarah lulus (7/7), type-check terarah lulus, dan smoke test
  installer menghasilkan image sementara dengan akun root terkunci serta mode
  `/root` 0700 dan `/etc/shadow` 0640.
- **Catatan draft:** audit tautan menu Asteracea dan sesuaikan port upload
  `platformio.ini` sebelum rilis.
- **Oleh:** Copilot · **Laporan:** kakang
