# Changelog LCD LM6029 (Device + Library)

> Changelog untuk driver `/dev/lcd`
> (`src/kernel/devices/aux-devices/LM6029Device.ts`), library userland
> (`src/mirror/lib/lcdLib.ts`), dan native addon npm **`lm6029acw`**.
> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-09-15

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
  `clear()`+`blit()` = frame kosong. Driver 33/33, `lcdLib` 23/23.
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
