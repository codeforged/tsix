# Changelog LCD LM6029 (Device + Library)

> Changelog untuk driver `/dev/lcd`
> (`src/kernel/devices/aux-devices/LM6029Device.ts`), library userland
> (`src/mirror/lib/lcdLib.ts`), dan native addon npm **`lm6029acw`**.
> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

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
- **Deploy:** `npm install` di repo tsix (mengambil addon + build `node-gyp`),
  lalu `npm run vfs:bootstrap` untuk menyinkronkan userland
  (`src/mirror/lib/lcdLib.ts`, `src/mirror/opt/test/test-LM6029.ts`).
- **Detail:** `wiki/lcd-lm6029.md`
- **Oleh:** Copilot
