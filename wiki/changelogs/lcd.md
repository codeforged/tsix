# Changelog LCD LM6029 (Device + Library)

> Changelog untuk driver `/dev/lcd`
> (`src/kernel/devices/aux-devices/LM6029Device.ts`), library userland
> (`src/mirror/lib/lcdLib.ts`), dan native addon npm **`lm6029acw`**.
> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-09-16

### PSEUDO-LCD `/dev/plcd` + emulator GUI — kembangkan app LCD tanpa hardware

- **File:**
  - `src/kernel/devices/aux-devices/PLCDDevice.ts` **(baru)** — driver pseudo
  - `src/kernel/devices/aux-devices/plcdFont5x7.ts` **(baru)** — font 5x7
  - `src/kernel/devices/aux-devices/PLCDDevice.test.ts` **(baru)** — 29 tes
  - `src/kernel/devices/aux-devices/LM6029Device.ts` — helper argumen ioctl
    diekspor (dipakai bersama) + tes C10.50e
  - `src/mirror/lib/lcdLib.ts` — `devicePath`/`setDevicePath()`/`TSIX_LCD_DEV`,
    `isPseudo()`, `getFrameRev()`, `getFrame()`, tipe `LcdPseudoFrame`
  - `src/mirror/opt/plcd/plcd-emulator.ts` + `plcd-panel.js` **(baru)** — viewer
  - `src/mirror/opt/asteracea/menu/lcd-emulator.menu` **(baru)**
- **Latar:** mengembangkan UI LCD selalu butuh panel fisik (dan SPI) — tidak bisa
  dikerjakan sambil jalan, tidak bisa di-uji di CI, dan setiap perubahan layout
  harus di-flash ke board untuk dilihat. Yang dibutuhkan: "panel palsu" yang
  **tidak bisa dibedakan** oleh aplikasi.
- **Perubahan 1 — driver pseudo `PLCDDevice` (`/dev/plcd`).** Nomor ioctl
  (`LCDIOCTL`), bentuk argumen, mode `write()` (string / Buffer 1024 byte / `{op,args}`),
  dan auto-flush **sama persis** dengan LM6029Device; semua gambar diraster
  software ke framebuffer RAM 1024 byte (1 bpp MSB-first). Semantik hardware
  ditiru ketat: DD-RAM terpisah dari panel (`CLEAR` tidak mengubah tampilan,
  `DISPLAY`/flush yang memindahkannya), blit 1024 byte **mengganti** isi layar,
  `rotation` 0..3 memakai pemetaan koordinat Adafruit_GFX (+ `GET_WIDTH/HEIGHT`
  bertukar), dan `invert`/`displayOn` tetap properti kaca panel (byte DD-RAM
  tidak diubah). Dua ioctl khas emulator: `GET_REV` (0x4c51, murah — untuk
  polling) dan `GET_FRAME` (0x4c50, base64 1024 byte + flag tampilan).
- **Perubahan 2 — font 5x7 milik proyek** (`plcdFont5x7.ts`): 99 glyph
  (ASCII 32..126 + `°` + 4 panah) yang ditulis sebagai ASCII-art
  (`".###./#...#/..."`) sehingga bisa ditambah/diedit tanpa tool apa pun.
  Cell & advance-nya sama dengan glcdfont hardware (6 px, baris 8 px) supaya
  tata letak app tidak bergeser. Karakter di luar tabel → kotak placeholder.
  ⚠️ **Sudah digantikan** di entri di bawah (data asli `glcdfont.c` + glyph
  ekstensi) — tabel ASCII-art ini kini tinggal panah `→ ← ↑ ↓` + placeholder.
- **Perubahan 3 — `lcdLib` bisa diarahkan tanpa mengubah app:** opsi
  `new LcdLib(lib, { devicePath })`, `setDevicePath(path)` (menutup FD lama),
  atau env `TSIX_LCD_DEV=/dev/plcd` untuk **semua** instance `lcd` sekaligus.
  Ditambah `isPseudo()`, `getFrameRev()`, `getFrame()` — di panel asli ketiganya
  mengembalikan `false`/`null` (ioctl tak dikenal → `null`), jadi app lama aman.
- **Jaminan kompatibilitas hardware (titik terpenting):** default path **tetap
  `/dev/lcd`** — `TSIX_LCD_DEV` kosong = perilaku persis seperti sebelumnya.
  `LCDIOCTL` tidak diubah satu pun; yang ditambahkan hanya dua nomor baru
  (0x4c50/0x4c51) yang **diabaikan hardware** (`null`). Ini dijaga tes
  C10.50e: `LM6029Device` (addon asli, fake handle) → `ioctl(0x4c50/0x4c51)`
  = `null`, `GET_INFO.pseudo` undefined (`isPseudo()` = false), dan perintah
  LCD normal tetap diteruskan ke addon (`drawRect` terpanggil).
- **Perubahan 4 — emulator GUI** (`/opt/plcd/plcd-emulator.js`, menu "System"):
  mem-poll `GET_REV` tiap 80 ms, dan **hanya saat berubah** menarik `GET_FRAME`
  → dikirim ke NJ (`{t:"frame", fb, ...}`) yang menggambar 1 px = 4 px fisik di
  canvas (128x64 → 512x256, `imageSmoothingEnabled = false`). Invert /
  display-off / backlight-off diterapkan di kaca, bukan ke byte DD-RAM. Tombol
  Test Pattern / Clear / Print / Invert / Display / Backlight / Kontras ± /
  Refresh semuanya menulis lewat `lcdLib` ke `/dev/plcd` — jadi panel itu
  sendiri yang membuktikan driver pseudo-nya jalan.
- **Verifikasi:**
  - `npx vitest run` untuk 3 suite terkait → **99 lulus** (hardware 30 + pseudo
    29 + lcdLib 30, termasuk 6 tes baru untuk target device & API pseudo).
  - Rasterisasi diperiksa **sebagai ASCII-art** dari DD-RAM device nyata
    (scene test-LM6029: rect, diagonal, circle, fillCircle, fillTriangle,
    roundRect, teks). Dari cara ini ketemu bug nyata: `roundRect` menggambar dua
    garis horizontal palsu di tengah (kondisi baris datar salah) — sudah
    diperbaiki sebelum ada tes yang menutupinya.
  - Font diperiksa dengan me-render beberapa kalimat (`"Halo TSIX!"`,
    `"0123456789"`, `"!@#$%^&*()"`, `"The quick brown"`) sebagai ASCII-art.
  - NJ diverifikasi di browser sungguhan: NJ dijalankan dengan frame asli dari
    device, lalu piksel canvas dibaca ulang — canvas 512x256, tepi border =
    `11,13,8` (INK), bagian kosong = `172,209,93` (kaca), baris teks berisi
    piksel; event `ready` melaporkan `scale: 4`.
- **Batasan yang disengaja (emulator, bukan replika byte):** kurva bisa beda
  ±1 px dari Adafruit_GFX, dan tidak ada SPI (`GET_SPI_SPEED` = null,
  `SET_SPI_SPEED` no-op) sehingga drag-region/timing hardware tidak bisa diuji
  di sini. Font **sudah bukan** batasan lagi — lihat entri di bawah.
- **Deploy:** `scripts/sync-vfs.ts` untuk `lcdLib.ts`, `plcd-emulator.ts`,
  `plcd-panel.js`, dan `lcd-emulator.menu` + **restart kernel** (node
  `/dev/plcd` didaftarkan saat boot) lalu reload halaman browser.
- **Oleh:** Copilot · **Laporan:** andriansah

### Font asli Adafruit_GFX di pseudo-LCD (`setFont(1..3)` kini glyph-per-glyph sama dengan hardware)

- **File:**
  - `scripts/gen-lcd-fonts.mjs` **(baru)** — generator data font
  - `src/kernel/devices/aux-devices/lcdFonts.ts` **(baru, generated)**
  - `src/kernel/devices/aux-devices/PLCDDevice.ts` — jalur raster font GFX
  - `src/kernel/devices/aux-devices/PLCDDevice.test.ts` — +8 tes (C10.89–C10.96)
- **Latar:** versi pertama pseudo-LCD menggambar **semua** id font dengan font
  5x7 bawaan, jadi teks tampak berbeda dari panel asli — padahal datanya sudah
  ada di addon (`raspi-lcd-addon/src/Fonts/*.h`: FreeSans9, FreeSansBold12,
  FreeMono9). Menyalin data itu manual ke TS = data ganda yang cepat basi.
- **Perubahan 1 — generator, bukan salin manual.** `scripts/gen-lcd-fonts.mjs`
  membaca header `.h` addon (argumen `--fonts-dir=` atau env `LCD_FONTS_DIR`
  kalau repo addon tidak bersebelahan) lalu menulis `lcdFonts.ts`:
  bitmaps sebagai base64 + tabel glyph `[offset, w, h, xAdvance, xOffset,
  yOffset]` + `first/last/yAdvance`. Jalankan ulang kalau font di addon
  berubah; file hasil **di-commit** supaya build tidak bergantung repo addon.
- **Perubahan 2 — raster font GFX yang setia.** `PLCDDevice` kini memilih jalur
  raster berdasarkan id font: id 0 (dan id tak dikenal) → font 5x7 bawaan
  (⚠️ sejak entri berikutnya memakai data asli `glcdfont.c` — lihat entri
  "Font 5x8 bawaan (id 0) kini byte-exact");
  id 1..3 → data glyph asli. Dua detail hardware yang ditiru:
  1. **Bitmap dibaca KONTINU** (satu byte untuk 8 piksel berikutnya, tanpa
     padding antar-baris) — persis loop `Adafruit_GFX::write`. Asumsi awal
     "padding per baris" langsung terbantah saat generator memvalidasi offset:
     dengan model kontinu, byte terpakai = panjang array **persis** di ketiga
     font (1150/1150, 2186/2186, 844/844).
  2. **`cursorY` = BASELINE** untuk font GFX (glyph digambar di
     `cursorY + yOffset`), beda dari font 5x7 yang memakai sudut kiri-atas;
     baris baru menambah `yAdvance` (FreeSans9 = 22 px, FreeSansBold12 = 29 px),
     dan `advance` horizontal memakai `xAdvance` per glyph (FreeSans proporsional,
     jadi "i" ≠ "W" — tidak lagi 6 px tetap).
  Karakter di luar rentang font dilewati tanpa memajukan cursor (juga mengikuti
  Adafruit). Mode opaque (`setTextColor(color, bg)`) mengisi kotak glyph dengan
  bg sebelum menggambar.
- **Perubahan 3 — `GET_INFO` melaporkan font efektif:** `fontName` (mis.
  `"FreeMono9pt7b"`), dan `cursorBaseline` (`true` = y adalah baseline) supaya
  viewer/app bisa menyesuaikan tanpa menebak.
- **Verifikasi:**
  - 37 tes pseudo-LCD lulus (+8 baru), semuanya **menurunkan ekspektasi dari
    data font itu sendiri** (bukan angka hardcode) — jadi tetap benar kalau font
    di-regenerate: posisi tiap piksel glyph harus sama dengan data, piksel
    dalam kotak glyph yang tidak nyala harus tetap 0, `yAdvance` untuk `\n`,
    `xAdvance` proporsional, karakter di luar rentang, `size=2`, mode opaque.
  - ASCII-art dari DD-RAM untuk ketiga font: FreeMono9 ("Halo 42!") monospace,
    FreeSans9 proporsional, FreeSansBold12 dua baris dengan jarak 29 px —
    semuanya terbaca sebagai glyph utuh.
- **Dampak:** teks di `/dev/plcd` kini identik dengan panel hardware (termasuk
  metrik & posisi baseline), jadi layout UI bisa disetel tanpa panel fisik.
- **Deploy:** file kernel → **restart kernel** (tidak perlu sync VFS). Generator
  hanya perlu dijalankan ulang kalau font di addon berubah.
- **Oleh:** Copilot · **Laporan:** andriansah

### Font 5x8 bawaan (id 0) kini byte-exact `glcdfont.c` — dan ternyata font pabrik = glcdfont

- **File:** `scripts/gen-lcd-fonts.mjs` (ditambah), `src/kernel/devices/aux-devices/lcdFontClassic.ts` **(baru, generated)**, `PLCDDevice.ts`,
  `PLCDDevice.test.ts` (+4 tes → **41**), `plcdFont5x7.ts` (diubah peran).
- **Latar:** jalur `setFont(0)` masih memakai tabel 5x7 buatan sendiri
  ("setara, bukan salinan byte-per-byte"). Padahal data aslinya sudah ada:
  `raspi-lcd-addon/src/glcdfont.c` — font bawaan Adafruit_GFX, **inilah yang
  benar-benar tampil di panel fisik** saat addon memakai `setFont(0)`/
  `setFont(NULL)`.
- **Perubahan:** generator yang sama kini juga membaca `glcdfont.c` →
  `lcdFontClassic.ts` (256 glyph × 5 byte kolom, sel 6x8 px, base64 + metadata
  `glyphW/cellH/advance/lineHeight/glyphCount/source`). Raster di `PLCDDevice`
  memakai byte itu **apa adanya** (bit0 = baris paling atas), sama dengan
  `_displayBuffer[page*128+x] |= 1 << (y%8)` di addon.
- **Dua perilaku Adafruit yang ikut ditiru:**
  1. **Kuirk `_cp437 = false`** — addon tidak pernah memanggil `cp437(true)`,
     jadi kode ≥ 176 digeser +1 sebelum dicari (`if (!_cp437 && (c >= 176))
     c++`). Byte 0xB0 di panel fisik dirender dengan glyph tabel ke-177.
  2. **Sel 8 baris + kolom gap** — descender (`g`, `y`) turun sampai baris 7,
     dan mode opaque mengisi seluruh sel 6x8 (5 kolom glyph + kolom pemisah).
- **Temuan penting (menghemat kode):** font sample pabrik
  `ori-from-lcd-factory/defaultFont.h` — yang dulu berniat dipakai sebagai
  "font ori pabrik" — ternyata **font yang sama** dengan glcdfont, hanya
  disimpan dengan urutan bit terbalik (driver pabrik menulis
  `reverse(pgm_read_byte(defaultFont + c*5 + i))`), 255 glyph (tanpa 0xFF yang
  toh kosong), dan **7 glyph beda ±1 px** di rentang Latin-1/block
  (`0x84 0x8E 0x94 0x99 0xB0 0xB2 0xE1`). Jadi **tidak** ada entri font pabrik
  terpisah di pseudo-LCD — cukup glcdfont. Catatan ini juga ditulis di header
  `lcdFontClassic.ts` + `scripts/gen-lcd-fonts.mjs` supaya tidak diusulkan lagi.
- **`plcdFont5x7.ts` berubah peran:** tabel ASCII/Latin-nya dihapus (diganti
  data asli) dan kini hanya berisi glyph **ekstensi** untuk kode di luar
  0x00..0xFF (panah `→ ← ↑ ↓` untuk UI LCD) + `rowsToGlyph()` untuk placeholder
  kotak. Termasuk `"°"` dihapus dari tabel: 0xB0 ≤ 0xFF, jadi di hardware
  memang dirender sebagai blok shade.
- **Verifikasi:**
  - **41 tes** pseudo-LCD lulus; 4 tes lama (C10.76/79/80/96) ditulis ulang
    karena dulu mengandalkan bentuk glyph buatan sendiri. Sekarang semua
    ekspektasi **diturunkan dari data font**, jadi tetap benar kalau
    diregenerate: piksel nyala harus sama persis dengan data, piksel dalam sel
    yang tidak nyala harus tetap 0, blok `size=2`, kuirk `_cp437`, descender
    baris 7, dan panah dari tabel ekstensi. Ditambah tes provenance
    (C10.100): 256 glyph, `source` menunjuk `glcdfont.c`, glyph spasi kosong,
    dan `'A'` = `7C 12 11 12 7C` (nilai glcdfont yang sudah dikenal).
  - ASCII-art dari framebuffer driver untuk `"Halo 42! g_y"`,
    `"0123456789 -> ok ~"`, dan `"AB"` size 2 — semua glyph terbaca benar.
- **Dampak:** teks default (`setFont(0)`) di `/dev/plcd` kini **identik byte**
  dengan panel fisik; tidak ada lagi glyph "kira-kira".
- **Deploy:** file kernel → **restart kernel** (tanpa sync VFS).
- **Oleh:** Copilot · **Laporan:** andriansah

---

## 2026-09-15

### Bus SPI portabel: auto-deteksi `/dev/spidev*` (Raspberry Pi ↔ Orange Pi)

- **File:**
  - `raspi-lcd-addon/src/LM6029ACW_595.{h,cpp}` (addon `lm6029acw@1.1.0`)
  - `raspi-lcd-addon/src/main.cpp` (binding N-API)
  - `raspi-lcd-addon/README.md`
  - `src/kernel/devices/aux-devices/LM6029Device.ts` (+ test)
  - `src/mirror/lib/lcdLib.ts` (tipe `LcdInfo.spiDevice`)
- **Masalah:** path bus SPI di-hardcode `/dev/spidev0.0`. Setup yang sudah jalan
  di Raspberry Pi (SPI0) langsung rusak begitu dipindah ke Orange Pi, karena bus
  panel di sana ada di `/dev/spidev3.0`. Mengganti hardcode ke `3.0` hanya
  memindahkan masalah ke board lain.
- **Perubahan (addon `lm6029acw@1.1.0`):**
  - `begin()` tidak lagi hardcode bus. Urutan percobaan: preferensi eksplisit →
    `/dev/spidev0.0` (default Pi) → sisa `/dev/spidev*` urut lexicographic
    (menemukan `/dev/spidev3.0` di Orange Pi). Bus pertama yang bisa dibuka
    dipakai; bila bukan pilihan pertama, satu baris peringatan ditulis ke
    `stderr`. Satu binary jalan di Pi maupun Orange Pi tanpa konfigurasi.
  - API baru: `setSpiDevice(path)`, `getSpiDevicePath()`, `getSpiProbeLog()`;
    `begin(speedHz?, devicePath?)` menerima path (urutan argumen bebas).
  - Override lewat env `LM6029_SPI_DEV` untuk service/daemon tanpa ubah kode.
  - `begin()` ulang (hotplug) tidak lagi membocorkan FD SPI lama.
- **Perubahan (sisi TSIX):**
  - `LM6029Options.spiDevice` — paksa bus dari kernel/userland; diteruskan ke
    addon sebelum `begin()` (diabaikan dengan aman oleh addon lama).
  - `GET_INFO` melaporkan `spiDevice` (bus yang benar-benar dipakai) dan
    `lastError` saat gagal memuat jejak bus yang dicoba; `test-LM6029`
    menampilkannya di baris status dan `info`.
  - Pesan log/error tidak lagi mengasumsikan `/dev/spidev0.0`.
- **Test:** `LM6029Device.test.ts` +4 (`C10.50`..`C10.50d`: urutan
  `setSpiDevice` → `begin()`, tanpa opsi = auto, addon lama tetap aman, error
  memuat probe log). Total driver 37/37, `lcdLib` 23/23. Addon di-build
  (`node-gyp`) dan di-smoke-test untuk jalur auto/env/setSpiDevice.
- **Deploy:** `lm6029acw@1.1.0` perlu `npm publish` dari repo addon, lalu di
  TSIX `npm i lm6029acw@latest` + `npm run vfs:bootstrap` (menyinkronkan
  `lcdLib.ts` & `test-LM6029.ts` ke VFS). Addon lama yang belum di-update tetap
  jalan seperti sebelumnya — bus di-hardcode `/dev/spidev0.0`.
- **Detail:** `wiki/lcd-lm6029.md` §2.1 & §8; `raspi-lcd-addon/README.md`
- **Oleh:** Copilot

### Fix: write() framebuffer 1024 byte sekarang benar-benar MENGGANTI layar

- **File:**
  - `src/kernel/devices/aux-devices/LM6029Device.ts`
  - `src/kernel/devices/aux-devices/LM6029Device.test.ts`
  - `src/mirror/lib/lcdLib.ts` (+ `lcdLib.test.ts`)
  - `src/mirror/opt/test/test-LM6029.ts`
- **Masalah:** `write(1024 byte)` (jalur `lcd.blit()`, `dd`, dan scene 7 demo)
  hanya memanggil `drawBitmap()`. Karena `Adafruit_GFX::drawBitmap()` 6-arg
  hanya **menyalakan** piksel untuk bit 1 dan melewati bit 0, frame baru
  menumpuk di atas frame lama:
  - `fb.clear()` + `blit()` **tidak menghapus** apa pun (frame kosong = no-op);
  - animasi meninggalkan "hantu" piksel dari frame sebelumnya;
  - scene 7 demo tampil bercampur sisa scene 6.
  Ini bertentangan dengan kontrak yang didokumentasikan ("blit penuh",
  "menggantikan seluruh isi layar").
- **Perubahan:**
  - Driver `write()`: buffer panel dibersihkan (`lcd.clear()`) **sebelum**
    `drawBitmap()` pada jalur 1024 byte — satu frame penuh kini mengganti isi
    layar, dan frame kosong berarti clear. Semantik `LCDIOCTL.DRAW_BITMAP`
    (stamp/cap pada posisi `x,y`) **tidak** diubah.
  - `lcdLib.blit()`: dokumentasi kontrak diperjelas (mengganti layar + present
    mengikuti `setAutoFlush()`) dan diberi **guard ukuran**: buffer ≠ 1024 byte
    melempar error, bukan diam-diam dicetak sebagai teks oleh driver.
  - Demo `test-LM6029`: scene 7 kini `flush()` eksplisit (suite mematikan
    auto-flush, jadi `blit()` saja tidak menampilkan apa pun) dan `contrast`
    memakai `blit()` agar pola gradasi tidak menumpuk di atas gambar lama.
- **Test:** +3 test driver memakai fake LCD yang menyimpan piksel sungguhan
  (meniru `drawBitmap` Adafruit): `C10.48d` urutan clear→drawBitmap, `C10.48e`
  frame kosong menghapus layar, `C10.48f` tanpa hantu piksel antar-frame.
  `lcdLib.test.ts` +3: terima `Uint8Array` mentah, tolak ukuran salah,
  `clear()`+`blit()` = frame kosong. Driver 33/33 dan `lcdLib` 23/23 saat itu
  (naik lagi setelah entri bus SPI di atas).
- **Detail:** `wiki/lcd-lm6029.md` §4 (Framebuffer) & §8 (Troubleshooting)
- **Oleh:** Copilot

## 2026-09-14

### Driver `/dev/lcd` + `@tsix/lcdLib` + addon npm `lm6029acw` (rilis pertama)

- **File:**
  - `src/kernel/devices/aux-devices/LM6029Device.ts` (baru — driver HAL)
  - `src/kernel/devices/aux-devices/LM6029Device.test.ts` (baru)
  - `src/mirror/lib/lcdLib.ts` (baru — library userland)
  - `src/mirror/lib/lcdLib.test.ts` (baru)
  - `src/mirror/opt/test/test-LM6029.ts` (baru — CLI demo/uji)
  - `package.json` (+ `optionalDependencies`)
- **Perubahan:**
  - Tambah driver **`/dev/lcd`** (`LM6029Device`) untuk LCD monokrom 128×64
    LM6029ACW via SPI0 + 2× 74HC595. Mengikuti kontrak `IDevice` +
    `static autoRegister(kernel)`, jadi terdaftar otomatis oleh
    `Kernel.loadAuxDevices()` tanpa menyentuh `Kernel.ts`/`Syscalls.ts`.
  - ioctl **namespace `0x4C` (`'L'`)** — lifecycle, 11 primitive GFX, teks
    (4 font), kontrol tampilan (kontras/backlight/inversi/SPI), info. Argumen
    menerima objek bernama **atau** array posisional.
  - Tiga mode `write()`: **framebuffer 1024 byte** (blit penuh 1 bpp MSB-first
    row-major), teks, dan `{ op, args }`. Buffer yang melewati syscall/IPC
    (ternormalisasi `{ type: "Buffer", data }`) tetap dikenali.
  - Tambah library **`@tsix/lcdLib`** — singleton `lcd` + class `LcdLib`, plus
    helper `LcdFramebuffer` (back-buffer 1 bpp: setPixel/line/rect/circle/…).
    Aplikasi tidak lagi perlu hardcode nomor ioctl.
  - Tambah utilitas **`test-LM6029`** (suite visual 7 scene, sweep kontras,
    sweep SPI, benchmark FPS 4 fase, framebuffer `blit()`).
  - `package.json` tsix: addon native didaftarkan sebagai **`optionalDependencies`**
    (`lm6029acw@^1.0.0`) — sengaja *optional* agar kegagalan build native
    (non-Linux / tanpa compiler) tidak menggagalkan `npm install` TSIX.
- **Native addon:** dipublikasikan sebagai paket npm **`lm6029acw`**
  (<https://www.npmjs.com/package/lm6029acw>), source di
  <https://github.com/codeforged/lm6029acw>. Nama lama `raspi-lcd-addon`
  dipertahankan sebagai **alias** di urutan resolusi driver supaya setup dev
  yang sudah jalan tidak rusak.
- **Degradasi tanpa hardware:** `open()` gagal → `present()` `false` →
  `/dev/lcd` otomatis hilang dari `ls /dev` (udev-like), alasan dicatat syslog.
  Tidak ada crash dan tidak ada node setengah hidup.
- **Test:** driver 30/30, `lcdLib` 20/20, integrasi `lcdLib → driver → hardware
  palsu` 23/23 (termasuk verifikasi urutan resolusi addon: pilih `lm6029acw`,
  fallback ke `raspi-lcd-addon`).
- **Verifikasi hardware:** ✅ diuji langsung pada Raspberry Pi + panel LM6029ACW
  (Node 22.20.0, npm 10.9.3) — seluruh rantai berfungsi sampai panel.
- **Deploy:** `npm install` di repo tsix (mengambil addon + build `node-gyp`),
  lalu `npm run vfs:bootstrap` untuk menyinkronkan userland
  (`src/mirror/lib/lcdLib.ts`, `src/mirror/opt/test/test-LM6029.ts`).
- **Detail:** `wiki/lcd-lm6029.md`
- **Oleh:** Copilot
