# Changelog TFT ILI9341 (Device + Library)

> Changelog untuk driver `/dev/tft`
> (`src/kernel/devices/aux-devices/ILI9341Device.ts`) dan library userland
> (`src/mirror/lib/tftLib.ts`).
> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-09-22

### Backlight "tidak bekerja": feedback izin sysfs + konfigurasi awal senyap

- **File:** `src/kernel/devices/aux-devices/ILI9341Device.ts` (`FbDevPanel`:
  `applyInitialConfig`, `sysfsDiag`), `src/mirror/opt/test/test-ILI9341.ts`,
  `ILI9341Device.test.ts` (C10.155-C10.156).
- **Gejala (laporan lapangan):** `/opt/test/test-ILI9341 backlight off` tidak
  mematikan lampu, tanpa penjelasan apa pun. Di boot masih muncul `brightness
  EINVAL` + `fb1/blank` hanya-root.
- **Sebab:** `bl_power` memang ada dan polarnya sudah benar, tapi proses TSIX
  tidak punya izin tulis ke sysfs backlight. Karena nilainya saat boot sudah
  sama (`0`), tulisnya dilewati — jadi tidak ada peringatan tentang `bl_power`
  sama sekali, dan saat app memanggil `setBacklight()` pun tidak ada feedback
  (pesan console kernel tidak sampai ke TTY app).
- **Perubahan:**
    - `applyInitialConfig()` — penerapan konfigurasi awal saat `begin()`:
      **senyap**, hanya menulis atribut yang nilainya berubah & yang boleh
      ditulis. Menghapus noise `EINVAL`/`EACCES` di boot.
    - `sysfsDiag()` + `init()` melaporkan **sekali** di boot, lengkap dengan
      perintah siap-tempel:
      `sudo chmod 666 /sys/class/backlight/fb_ili9341/bl_power .../brightness /sys/class/graphics/fb1/blank`.
    - `SET_BACKLIGHT` mengembalikan **status yang berlaku** (dibaca balik dari
      `bl_power`), bukan yang diminta — jadi app bisa tahu kalau izin tulis
      kurang (permintaan `off` → hasil `on`).
    - `test-ILI9341 backlight on|off` mencetak status berlaku + dir sysfs, dan
      bila gagal menyertakan perintah `chmod` yang perlu dijalankan;
      `brightness` membaca balik nilai sysfs dan menyebut bila panel menolak.
- **Tindakan operator yang diperlukan:** beri izin tulis sysfs (root atau udev
  rule `chmod 0666`). Selama itu belum dilakukan, on/off hanya mengubah status
  di driver — bukan bug, tapi sekarang terlihat jelas di log & output app.
- **Deploy:** restart kernel + `npm run vfs:bootstrap` (app test).
- **Oleh:** Copilot

### Sysfs: tulis hanya bila berubah + pesan galat sesuai sebab (`EINVAL` ≠ `EACCES`)

- **File:** `src/kernel/devices/aux-devices/ILI9341Device.ts` (`FbDevPanel`),
  `src/mirror/lib/tftLib.ts` (`TftInfo.backlightWritable`),
  `ILI9341Device.test.ts` (C10.153-C10.154).
- **Gejala (laporan lapangan, Pi):** log boot menyemburkan tiga peringatan sekaligus:
  `brightness: EINVAL`, `bl_power: EACCES`, `fb1/blank: EACCES` — padahal semua
  nilai yang ditulis sama dengan yang sudah ada di sysfs.
- **Akar masalah:**
    1. Driver menerapkan konfigurasi awal dengan menulis sysfs **tanpa membandingkan**
       nilai sekarang. Menulis nilai yang sama itu sia-sia, dan `brightness` fbtft
       bisa menjawab `EINVAL` (panel menolaknya).
    2. Pesan galatnya mengasumsikan semua kegagalan = urusan izin, jadi `EINVAL`
       ikut disarankan "jalankan sebagai root" — menyesatkan.
- **Perubahan:**
    - `writeSysfs()`: **baca dulu**, tulis hanya kalau nilainya berubah. Saat boot
      praktis tidak ada tulis sama sekali → log bersih.
    - Sebelum menulis dicek `accessSync(W_OK)`. Kalau tidak boleh tulis: **satu**
      peringatan ringkas (bukan tiga), dan atribut itu **tidak dicoba lagi**.
    - Pesan dibedakan: `EACCES`/`EPERM` → butuh root/udev; `EINVAL` → panel
      menolak nilai/atributnya (fitur tidak didukung); lainnya → pesan generik.
    - Boot log: `Backlight sysfs: /sys/class/backlight/fb_ili9341`
      (+ `— hanya root, kontrol on/off dilewati` bila tidak bisa ditulis), atau
      `Backlight: sysfs tidak ditemukan — opsional, set TSIX_TFT_BL`.
    - `GET_INFO`/`TftInfo` menambah `backlightWritable` — jadi app bisa tahu apakah
      `setBacklight()` benar-benar menyentuh hardware.
- **Catatan lapangan:** pada `fb_ili9341` atribut `brightness` ditolak (`EINVAL`),
  jadi **kecerahan** memang tidak bisa diatur lewat panel ini; on/off tetap lewat
  `bl_power`. Untuk menulis sysfs, TSIX harus punya izin tulis (root / udev rule).
- **Deploy:** restart kernel.
- **Oleh:** Copilot

### Backlight on/off: `bl_power` (0 = NYALA, 1 = MATI) + auto-deteksi `fb_ili9341`

- **File:** `src/kernel/devices/aux-devices/ILI9341Device.ts` (`FbDevPanel`,
  `resolveBacklightPaths`, `detectBacklightDir`), `src/mirror/lib/tftLib.ts`
  (`backlightOn/backlightOff/toggleBacklight`), `src/kernel/devices/aux-devices/
  ILI9341Device.test.ts` (C10.149-C10.152).
- **Gejala:** `tft.setBacklight(false)` tidak mematikan lampu panel. Cara yang
  terbukti di lapangan:

  ```bash
  echo 0 | sudo tee /sys/class/backlight/fb_ili9341/bl_power   # NYALA
  echo 1 | sudo tee /sys/class/backlight/fb_ili9341/bl_power   # MATI
  ```

- **Akar masalah:** dua hal. (1) `FbDevPanel` hanya menulis sysfs kalau
  `backlightPath`/`TSIX_TFT_BL` diisi manual — kalau tidak, status disimpan
  tanpa menyentuh hardware (yang benar-benar terjadi di panel fbtft). (2) File
  yang ditulis dulu `brightness` dengan asumsi `0 = mati`; `bl_power` adalah
  file yang benar untuk on/off, dan **polaritasnya kebalikan**: `0` = NYALA,
  `1` = MATI (FB_BLANK_POWERDOWN).
- **Perubahan:**
    - `bl_power` didahulukan untuk on/off; `brightness` hanya dipakai kalau panel
      tidak punya `bl_power` (tulis 0 = mati, nilai tersimpan = nyala).
    - Deteksi otomatis `/sys/class/backlight`: nama yang sama dengan driver fbdev
      panel (`fb_ili9341`) atau memuat `ili9341`; fallback "satu-satunya entri"
      HANYA kalau node framebuffer TFT sudah teridentifikasi (supaya backlight
      laptop/host tidak pernah tersentuh). `TSIX_TFT_BL`/`backlightPath` menerima
      nama perangkat, direktori, atau filenya langsung.
    - `getBacklight()` membaca `bl_power` (bukan status internal), dan
      `getBrightness()` membaca `brightness` lalu diskalakan `max_brightness` →
      domain 0..255. `GET_INFO` menambah `backlightDir` untuk diagnostik.
    - Kegagalan tulis sysfs (bukan root) dulu **diam-diam diabaikan**; sekarang
      dicatat sekali lewat `console.warn` dengan petunjuk penyebabnya. Boot log
      menampilkan direktori backlight yang terdeteksi (atau bahwa tidak ada).
- **Dampak:** `tft.setBacklight(false)` benar-benar mematikan lampu panel.
- **Penting — hak akses:** sysfs `bl_power` hanya bisa ditulis root. Kalau TSIX
  jalan sebagai user biasa, tambahkan udev rule:

  ```bash
  echo 'SUBSYSTEM=="backlight", ACTION=="add", RUN+="/bin/chmod 666 /sys/class/backlight/%k/bl_power"' \
    | sudo tee /etc/udev/rules.d/60-tsix-backlight.rules
  sudo udevadm control --reload && sudo udevadm trigger --subsystem-match=backlight
  ```

- **Deploy:** restart kernel (perubahan driver); `npm run vfs:bootstrap` untuk
  `tftLib.ts`.
- **Oleh:** Copilot

## 2026-09-21

### Demo animasi stress `/opt/test/tft-objs` — semua efek di userland, 1 syscall/frame

- **File:** `src/mirror/opt/test/tft-objs.ts` (baru)
- **Ringkas:** pasangan "versi warna" dari `lcd-objs` (LM6029 128x64): plasma
  latar, starfield 3D, kubus wireframe berputar (dua sumbu), objek memantul
  berputar, spektrum bergradasi, marquee, dan HUD FPS/ms/objek. Semua lapisan
  bisa dinyalakan/dimatikan lewat opsi — jadi satu app ini sekaligus demo visual
  dan alat ukur performa panel.
- **Kunci performa:** SEMUA efek diraster **lokal** di `TftFramebuffer` —
  termasuk HUD & marquee yang memakai **font 3x5 lokal** (bukan `printText()`),
  jadi satu frame tetap **1 syscall** (`blit()` + auto-flush). Nol `Math.sin`
  di dalam loop piksel: LUT 1024 entri (`SIN`/`COS` + pembungkus `sinI()`),
  palet RGB565 di-interpolasi sekali di awal, dan fade jejak memakai aritmetika
  bit per kanal (bukan unpack/repack).
- **Tombol biaya (kalau di Pi terasa berat):** `--plasma R` (1/R² piksel
  dihitung), `--stars`, `--sq/--tri/--cir`, `--bars`, `--trail N`, preset
  **`--lite`** / **`--insane`**, `--fps N` (batasi laju supaya CPU tidak
  jenuh), `--stats` (laporan ms per tahap tiap 2 detik), dan `bench [detik]`.
  Saat `--trail` hidup, plasma otomatis digambar sebagai **grid titik** 1 px
  per blok supaya jejak gerak tetap terlihat di sela-selanya.
- **Teknik raster:** objek berputar memakai raster poligon **scanline even-odd**
  (satu jalur untuk kotak & segitiga), lingkaran berdenyut memakai
  `fillCircle` + cincin, cube memakai rotasi X→Y + proyeksi perspektif
  `3.2/(3.2+z)`, bintang memakai proyeksi `1/z` dengan ramp 8 langkah warna.
- **Hasil ukur headless (CPU Xeon, raster murni — `blit()` masih stub):**
  default **1058 fps / 0.95 ms per frame** (plasma 0.43 · shape 0.34 · bars+hud
  0.06 · blit 0.11); `--insane` (plasma penuh, 320 bintang, 38 objek, trail 2)
  **482 fps / 2.07 ms**; `--lite` **1787 fps / 0.56 ms**; baseline blit tanpa
  efek 0.10 ms. Artinya biaya raster di CPU memang nyata terukur, sedangkan
  biaya IPC + transfer 150 KB baru muncul di hardware asli.
- **Smoke test:** semua preset + `-h` dijalankan headless (UserLib palsu) —
  **0 error**, semua frame yang terkirim tepat **153600 B**.

### TFT ILI9341 320x240 jadi `/dev/tft` — lewat framebuffer host, tanpa addon native

- **File:**
    - `src/kernel/devices/aux-devices/ILI9341Device.ts` (baru)
    - `src/kernel/devices/aux-devices/ILI9341Device.test.ts` (baru)
    - `src/mirror/lib/tftLib.ts` (baru)
    - `src/mirror/lib/tftLib.test.ts` (baru)
    - `src/mirror/opt/test/test-ILI9341.ts` (baru — demo/uji CLI)
- **Perubahan:** panel TFT warna **ILI9341 320x240** (RGB565) kini punya node
  `/dev/tft` dengan kontrak `IDevice` + `static autoRegister(kernel)`, jadi
  terdaftar otomatis oleh `Kernel.loadAuxDevices()` tanpa menyentuh
  `Kernel.ts`/`Syscalls.ts`. Userland memakai `@tsix/tftLib` (`tft` singleton +
  class `TftLib`), jadi tidak ada magic number ioctl di aplikasi.
- **Pilihan jalur: fbdev host, bukan SPI langsung.** Panel dibuka lewat
  **Linux framebuffer** yang disediakan kernel host (fbtft/`fb_ili9341`,
  umumnya `/dev/fb1`) — **persis jalur yang sudah terbukti jalan** pada skrip
  Node biasa yang menulis RGB565 ke `/dev/fb1`. Konsekuensinya: **nol dependensi
  native** (tidak ada paket addon, tidak ada `node-gyp`), tapi semua primitive
  digambar di CPU oleh driver TS. Ini beda kelas dengan `/dev/lcd` (LM6029),
  yang kontrak hardware-nya ada di addon npm `lm6029acw`.
- **Path bus tidak di-hardcode:** opsi `fbDevice` → env **`TSIX_TFT_FB`** →
  auto-deteksi `/dev/fb1`..`/dev/fb9` (dipilih yang `/sys/class/graphics/fbN`
  menyebut nama `fb_ili9341`, atau resolusi 320x240/240x320, atau 16 bpp).
  **`/dev/fb0` tidak pernah dipilih otomatis** — di Raspberry Pi itu HDMI.
- **Pagar keselamatan node:** sebelum dipakai, node divalidasi terhadap sysfs
  (`bits_per_pixel` = 16, `virtual_size` = **320x240**, `stride` = 640). Node
  yang tidak cocok (mis. HDMI 1920x1080 @32 bpp, atau fbtft portrait 240x320
  yang stride-nya 480 walau byte/frame-nya kebetulan sama) **ditolak** dan
  ditutup kembali — supaya frame driver ini tidak pernah ditulis ke framebuffer
  yang layout-nya beda.
- **Tiga mode `write()`:**
    1. **Framebuffer** — `write(Buffer 153600 B)` = satu frame penuh RGB565
       (stride 640 B) yang **mengganti** layar; `write(buf, offset)` menyalin ke
       byte ke-`offset` (semantik `pwrite()` fbdev), jadi mengirim sebagian
       baris juga sah dan baris lain tidak tersentuh.
    2. **Perintah** — `write({ op, args })` memakai engine primitive yang sama
       (nama op sama dengan `LM6029Device`).
    3. **Teks** — `write("teks")` mencetak di cursor.
- **ioctl namespace `0x54` (`'T'`)** — bebas dari tabrakan (LCD `0x4C`,
  joystick `0x4A`, net `0x10/0x20/0x30/0x51/0x52`): lifecycle, 12 primitive GFX
  + `GET_PIXEL` (baca balik piksel), teks (4 font), kontrol tampilan
  (backlight/kecerahan/blank/inversi), `SET_FB_DEVICE`/`GET_FB_DEVICE`, info.
  Argumen menerima **objek bernama atau array posisional**, dan `color` menerima
  angka RGB565, string `"#RRGGBB"`, atau `{ r, g, b }`.
- **Warna:** helper `rgb565()`, `hex565()`, `unpack565()`, palet `TFT_COLOR`,
  plus `rgb()` di userland (`rgb(0,255,242)` / `rgb("#00fff2")`).
  Parsing hex **ketat** (`/[0-9a-f]{1,6}/`) — `parseInt()` longgar sempat
  membuat `"bukan-warna"` jadi warna hijau (0x0b).
- **Teks:** font yang **sama** dengan `/dev/lcd` & `/dev/plcd` — glcdfont 5x7
  (`lcdFontClassic.ts`) untuk id 0, font Adafruit GFX (`lcdFonts.ts`) untuk
  id 1..3, plus glyph ekstensi TSIX (`plcdFont5x7.ts`) untuk karakter di luar
  tabel. Jadi teks tampil identik di semua panel TSIX; `textColor` + `textBg`
  (opaque/transparan) ikut mendukung rotasi 0..3 (pemetaan Adafruit_GFX).
- **Animasi:** pola yang disarankan = gambar **lokal** di `TftFramebuffer`
  (RGB565, nol syscall) lalu `tft.blit(fb)` **sekali per frame**; driver
  menyalinnya ke back-buffer dan present ke `/dev/fbN` (auto-flush ON).
  Menggambar per piksel lewat ioctl = ratusan round-trip IPC per frame dan
  memang tidak dianjurkan.
- **Batas yang diakui jujur (bukan bug, tapi konsekuensi fbdev):**
    - fbdev tidak punya register INVON/kecerahan → `SET_INVERT` **diemulasi**
      driver (XOR 16-bit saat flush, hanya saat aktif), dan
      `SET_BRIGHTNESS`/`SET_BACKLIGHT` hanya nyata kalau driver dikonfigurasi
      `backlightPath` (sysfs); tanpa itu status disimpan tapi hardware tidak
      disentuh. `SET_DISPLAY_ON` mencoba `/sys/class/graphics/fbN/blank`.
    - Rasterisasi primitive/teks di CPU (perbandingan: satu flush fbdev =
      memcpy 150 KB), jadi kurva bisa beda ±1 px dari rumpun ILI9341 asli.
    - `write()` menyalin ke back-buffer internal driver; flush selalu mengirim
      **seluruh** frame. Kalau ada proses lain menulis langsung ke `/dev/fbN`
      di luar TSIX, flush berikutnya akan menimpanya (model pemilik tunggal).
- **Demo & uji:** `/opt/test/test-ILI9341.ts` — suite 7 scene (palet+rampa,
  primitive, 4 font × 3 ukuran, pola framebuffer, dua jalur bitmap, rotasi 0..3,
  dashboard animasi) plus perintah: `info`, `clear`, `text`, `colors`, `shapes`,
  `fonts`, `fb`, `sprites`, `rotation [0-3]`, `hud [detik]`, `fps [detik]`,
  `fbdev [path]`, `pixel <x> <y>`, `brightness`, `backlight`, `invert`,
  `display`. Benchmark `fps` 8 fase membedakan ongkos IPC vs transfer
  150 KB: `ipc-only` (1 round-trip murni), `raster lokal` (0 syscall), `flush`,
  `frame 1-sys`, dan **`teks hemat`** — pola `blit + printText + flush` yang
  memakai 3 round-trip tetapi **hanya satu transfer 150 KB** (dengan auto-flush
  ON, `blit` dan `printText` masing-masing memicu transfer penuh). Scene `hud`
  memakai pola itu (≈60 fps pada harness headless, dibatasi pacing aplikasi).
- **Smoke test headless:** seluruh perintah demo + `suite --fast` dijalankan di
  Node dengan UserLib palsu (ioctl loopback) — **0 error**, semua frame yang
  terkirim berukuran tepat 153600 B. Berguna karena mesin pengembang saat ini
  terpisah dari Pi.
- **Test:** **45/45** driver + **29/29** `tftLib` (**74 test**, semuanya tanpa
  hardware — panel palsu via injeksi `native`, menangkap salinan frame). Cakupan
  termasuk: validasi node (tolak HDMI), rotasi & pemetaan koordinat, semua
  primitive, dua jalur bitmap (1 bpp mono & RGB565 mentah), teks (klasik/GFX/
  ekstensi/opaque/wrap), mode `write()` (frame penuh, potongan ber-offset,
  blok lewat batas frame → ditolak + dicatat di `lastError`), emulasi invert,
  dan auto-deteksi `detectFbDevices()` (tidak pernah menyentuh `fb0`).
- **Status verifikasi:** logika driver & library terverifikasi lewat test;
  **belum** dijalankan end-to-end di dalam TSIX pada Pi (mesin kerja saat ini
  terpisah dari Pi). Jalur I/O-nya identik dengan skrip host yang sudah terbukti
  menulis RGB565 ke `/dev/fb1`, tetapi klaim "sampai ke kaca panel dari TSIX"
  menunggu uji langsung — resepnya:
  `npm run vfs:bootstrap` (sync `tftLib.ts`) → boot TSIX di Pi →
  `tft.isAvailable()` / `tft.getInfo()` (cek `fbDevice`, `fbName`), lalu
  `fillScreen()` + `printText()` + `flush()`.
- **Deploy:** driver dimuat otomatis (folder `aux-devices`); userland perlu
  `npm run vfs:bootstrap` agar `/lib/tftLib.js` ada di VFS.
- **Oleh:** Copilot
