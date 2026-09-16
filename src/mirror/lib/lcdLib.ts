/**
 * lcdLib.ts — Userland library untuk /dev/lcd (LCD monokrom 128x64 LM6029ACW)
 *
 * Wrapper tingkat tinggi di atas driver LCD kernel (aux-device LM6029Device).
 * Developer aplikasi TIDAK perlu pusing dengan FD & nomor ioctl — cukup
 * panggil method yang manusiawi, persis gaya Adafruit_GFX.
 *
 * ── USAGE ──
 *   import { lcd } from "@tsix/lcdLib";
 *
 *   if (await lcd.isAvailable()) {
 *     await lcd.clear();
 *     await lcd.setTextSize(2);
 *     await lcd.printText("Halo TSIX", 0, 20);
 *     await lcd.setContrast(40);
 *   }
 *
 * Framebuffer 1 bpp (paling cepat, ala `dd`):
 *   const fb = lcd.framebuffer();
 *   fb.clear();
 *   fb.line(0, 0, 127, 63);
 *   fb.text?  → tidak ada font di sini; pakai lcd.printText()
 *   await lcd.blit(fb);   // kirim 1 frame penuh (mengganti isi layar)
 *
 * Instance sendiri (untuk test / dipakai lintas konteks):
 *   import { LcdLib } from "@tsix/lcdLib";
 *   const myLcd = new LcdLib(lib);   // lib = UserLib
 *
 * Panel PALSU (emulator software, tanpa hardware) — node /dev/plcd:
 *   /opt/plcd/launcher /root/graphcalc.ts         // CARA UTAMA (disarankan):
 *                                                 // app tetap bicara ke /dev/lcd,
 *                                                 // LAUNCHER yang membelokkan node.
 *   TSIX_LCD_DEV=/dev/plcd ./app.js               // semua instance `lcd` pindah
 *   new LcdLib().setDevicePath("/dev/plcd")       // hanya instance ini
 *   `LCD_PSEUDO_DEVICE_PATH` di-export supaya tidak perlu hardcode string.
 *   Driver-nya `PLCDDevice` (kernel) + viewer GUI `/opt/plcd/plcd-emulator.js`.
 *
 * ⚠️ JANGAN hardcode `lcd.setDevicePath("/dev/plcd")` di dalam aplikasi: app
 *    harus tetap jujur ke `/dev/lcd` (atau autodetect). Pembelokan device adalah
 *    urusan DEPLOYMENT — pakai launcher di atas (lihat header `launcher.ts`).
 *
 * ── CATATAN ──
 * Konstanta ioctl di bawah HARUS sinkron dengan enum `LCDIOCTL` di driver
 * kernel: src/kernel/devices/aux-devices/LM6029Device.ts
 *
 * (c) 2026 TSIX Project
 */

// ── Perintah ioctl (namespace 0x4C = 'L') — wajib match kernel driver ──
const LCD_BEGIN = 0x4c01; // null   → boolean
const LCD_RESET = 0x4c02; // null   → true (clear + display)
const LCD_CLEAR = 0x4c03; // null   → true (buffer saja)
const LCD_DISPLAY = 0x4c04; // null   → true (flush buffer → panel)

const LCD_DRAW_PIXEL = 0x4c10; // {x,y,color?}            → true
const LCD_FILL_SCREEN = 0x4c11; // {color?} | number       → true
const LCD_DRAW_LINE = 0x4c12; // {x0,y0,x1,y1,color?}    → true
const LCD_DRAW_RECT = 0x4c13; // {x,y,w,h,color?}        → true
const LCD_FILL_RECT = 0x4c14; // {x,y,w,h,color?}        → true
const LCD_DRAW_CIRCLE = 0x4c15; // {x,y,r,color?}          → true
const LCD_FILL_CIRCLE = 0x4c16; // {x,y,r,color?}          → true
const LCD_DRAW_TRIANGLE = 0x4c17; // {x0,y0,x1,y1,x2,y2,c?}  → true
const LCD_FILL_TRIANGLE = 0x4c18; // {x0,y0,x1,y1,x2,y2,c?}  → true
const LCD_DRAW_ROUND_RECT = 0x4c19; // {x,y,w,h,r,color?}      → true
const LCD_FILL_ROUND_RECT = 0x4c1a; // {x,y,w,h,r,color?}      → true
const LCD_DRAW_BITMAP = 0x4c1b; // {x,y,data,w,h,color?}   → true

const LCD_SET_FONT = 0x4c20; // id | {id}               → id terpakai
const LCD_SET_TEXT_COLOR = 0x4c21; // {color,bg?}             → true
const LCD_SET_TEXT_SIZE = 0x4c22; // {size} | number         → true
const LCD_SET_TEXT_WRAP = 0x4c23; // boolean                 → true
const LCD_SET_CURSOR = 0x4c24; // {x,y}                   → true
const LCD_PRINT = 0x4c25; // string                  → true
const LCD_PRINT_TEXT = 0x4c26; // {text,x,y,size?}        → true
const LCD_SET_ROTATION = 0x4c27; // {rotation} | number     → rotation

const LCD_SET_CONTRAST = 0x4c30; // {level} | number        → level terpakai
const LCD_GET_CONTRAST = 0x4c31; // null                    → number
const LCD_SET_BACKLIGHT = 0x4c32; // boolean | {on}          → boolean
const LCD_GET_BACKLIGHT = 0x4c33; // null                    → boolean
const LCD_SET_INVERT = 0x4c34; // boolean | {invert}      → boolean
const LCD_GET_INVERT = 0x4c35; // null                    → boolean
const LCD_SET_DISPLAY_ON = 0x4c36; // boolean | {on}          → boolean
const LCD_IS_DISPLAY_ON = 0x4c37; // null                    → boolean
const LCD_SET_SPI_SPEED = 0x4c38; // {hz} | number           → hz terpakai
const LCD_GET_SPI_SPEED = 0x4c39; // null                    → number

const LCD_GET_INFO = 0x4c40; // null                    → LcdInfo
const LCD_GET_WIDTH = 0x4c41; // null                    → number
const LCD_GET_HEIGHT = 0x4c42; // null                    → number
const LCD_SET_AUTO_FLUSH = 0x4c43; // boolean | {on}          → boolean
const LCD_GET_AUTO_FLUSH = 0x4c44; // null                    → boolean

// ── Khas PSEUDO-LCD (/dev/plcd) — lihat driver kernel PLCDDevice ──
const LCD_GET_FRAME = 0x4c50; // null                    → LcdPseudoFrame (fb base64)
const LCD_GET_REV = 0x4c51; // null                    → number

/** Path device LCD di VFS. */
export const LCD_DEVICE_PATH = "/dev/lcd";

/**
 * Node PSEUDO-LCD (emulator software, tanpa SPI) — driver kernel `PLCDDevice`.
 * Nomor ioctl & bentuk argumennya sama persis dengan `/dev/lcd`, jadi aplikasi
 * bisa diuji (dan dilihat di browser lewat DDC) tanpa hardware.
 */
export const LCD_PSEUDO_DEVICE_PATH = "/dev/plcd";

/**
 * Env untuk mengarahkan SEMUA instance `lcd` ke node lain — mis.
 * `TSIX_LCD_DEV=/dev/plcd` membuat app yang tidak diubah sama sekali tetap
 * bicara ke panel palsu (berguna untuk uji UI tanpa hardware).
 */
export const LCD_DEVICE_ENV = "TSIX_LCD_DEV";

/** Geometri panel. */
export const LCD_WIDTH = 128;
export const LCD_HEIGHT = 64;
/** Ukuran framebuffer 1 bpp MSB-first row-major: 128*64/8 = 1024 byte. */
export const LCD_FB_SIZE = (LCD_WIDTH * LCD_HEIGHT) / 8;

// ================================================================
// TYPES
// ================================================================

/** Nomor font Adafruit yang dikenali driver. */
export type LcdFontId = 0 | 1 | 2 | 3;

/** Konstanta font siap pakai (hindari magic number). */
export const LcdFont = {
  /** Font default 5x7 dari Adafruit (glcdfont). */
  DEFAULT: 0 as LcdFontId,
  FREE_SANS_9: 1 as LcdFontId,
  FREE_SANS_BOLD_12: 2 as LcdFontId,
  FREE_MONO_9: 3 as LcdFontId,
};

/** Nama tiap font (untuk log/CLI). */
export const LCD_FONT_NAMES: Record<number, string> = {
  0: "default 5x7",
  1: "FreeSans9pt7b",
  2: "FreeSansBold12pt7b",
  3: "FreeMono9pt7b",
};

/** Status perangkat — hasil GET_INFO. */
export interface LcdInfo {
  /** Path node, mis. "/dev/lcd". */
  device: string;
  /** true kalau panel benar-benar siap dipakai. */
  available: boolean;
  /**
   * true kalau node ini panel PALSU (software/emulator, mis. `/dev/plcd`) —
   * driver hardware tidak mengisi field ini.
   */
  pseudo?: boolean;
  width: number;
  height: number;
  pages: number;
  framebufferSize: number;
  /** Clock SPI aktual (Hz), atau null bila panel belum hidup. */
  spiSpeed: number | null;
  /**
   * Bus SPI yang dipakai driver, mis. "/dev/spidev0.0" (Raspberry Pi) atau
   * "/dev/spidev3.0" (Orange Pi). Addon mengauto-deteksi dari /dev/spidev*.
   */
  spiDevice?: string | null;
  contrast: number | null;
  backlight: boolean | null;
  invert: boolean | null;
  displayOn: boolean | null;
  /** write() otomatis flush ke panel. */
  autoFlush: boolean;
  /** Jumlah frame yang sudah di-flush. */
  frames?: number;
  lastError?: string | null;
}

/** Opsi warna: 1 = piksel nyala, 0 = mati (panel monokrom). */
export type LcdColor = 0 | 1;

/**
 * Satu frame panel dari PSEUDO-LCD (`/dev/plcd`) — hasil ioctl GET_FRAME.
 * Viewer (mis. `/opt/plcd/plcd-emulator.js`) memakai ini untuk menggambar
 * isi panel di browser.
 */
export interface LcdPseudoFrame {
  /** Revisi panel: naik HANYA saat flush (isi panel benar-benar berubah). */
  rev: number;
  /** Jumlah frame yang sudah di-flush sejak boot. */
  frames: number;
  width: number;
  height: number;
  /** Properti TAMPILAN (kaca panel), bukan isi DD-RAM. */
  invert: boolean;
  displayOn: boolean;
  backlight: boolean;
  contrast: number;
  rotation: number;
  autoFlush: boolean;
  /** Isi DD-RAM panel: base64 dari 1024 byte, 1 bpp MSB-first row-major. */
  fb: string;
}

// ================================================================
// FRAMEBUFFER 1 BPP (mono, row-major MSB-first)
// ================================================================

/**
 * LcdFramebuffer — back-buffer 1024 byte untuk panel monokrom.
 *
 * Layout byte = raster scanline 1 bpp, bit MSB = piksel paling kiri:
 *   byteIndex = y * (width/8) + (x >> 3)   , bit = 0x80 >> (x & 7)
 *
 * Ini format yang sama dengan `drawBitmap()` Adafruit_GFX, jadi buffer bisa
 * langsung di-blit penuh lewat `lcd.blit(fb)` tanpa konversi.
 *
 * (Beda dengan `FrameBuffer` di @tsix/framebuffer yang berwarna RGBA untuk
 * DDC/browser — kelas ini khusus panel mono.)
 */
export class LcdFramebuffer {
  readonly width = LCD_WIDTH;
  readonly height = LCD_HEIGHT;
  readonly stride = LCD_WIDTH / 8;
  /** Byte mentah 1 bpp — siap dikirim ke device. */
  readonly bytes: Uint8Array;

  constructor() {
    this.bytes = new Uint8Array(LCD_FB_SIZE);
  }

  /** Kosongkan buffer. color 0 = hitam semua, 1 = nyala semua. */
  public clear(color: LcdColor = 0): this {
    this.bytes.fill(color ? 0xff : 0x00);
    return this;
  }

  /** Nyalakan/matikan satu piksel. Koordinat di luar panel diabaikan. */
  public setPixel(x: number, y: number, color: LcdColor = 1): this {
    x = x | 0;
    y = y | 0;
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return this;
    const idx = y * this.stride + (x >> 3);
    const mask = 0x80 >> (x & 7);
    if (color) this.bytes[idx] |= mask;
    else this.bytes[idx] &= ~mask & 0xff;
    return this;
  }

  /** Baca satu piksel (0/1). */
  public getPixel(x: number, y: number): LcdColor {
    x = x | 0;
    y = y | 0;
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return 0;
    return ((this.bytes[y * this.stride + (x >> 3)] >> (7 - (x & 7))) & 1) as LcdColor;
  }

  /** Balik warna satu piksel. */
  public togglePixel(x: number, y: number): this {
    return this.setPixel(x, y, this.getPixel(x, y) ? 0 : 1);
  }

  /** Garis horizontal. */
  public hLine(x: number, y: number, w: number, color: LcdColor = 1): this {
    for (let i = 0; i < w; i++) this.setPixel(x + i, y, color);
    return this;
  }

  /** Garis vertikal. */
  public vLine(x: number, y: number, h: number, color: LcdColor = 1): this {
    for (let i = 0; i < h; i++) this.setPixel(x, y + i, color);
    return this;
  }

  /** Garis bebas (Bresenham). */
  public line(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: LcdColor = 1,
  ): this {
    x0 = x0 | 0;
    y0 = y0 | 0;
    x1 = x1 | 0;
    y1 = y1 | 0;
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.setPixel(x0, y0, color);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
    return this;
  }

  /** Kotak berisi 1 px garis (warna mengikuti `color`). */
  public rect(
    x: number,
    y: number,
    w: number,
    h: number,
    color: LcdColor = 1,
  ): this {
    this.hLine(x, y, w, color);
    this.hLine(x, y + h - 1, w, color);
    this.vLine(x, y, h, color);
    this.vLine(x + w - 1, y, h, color);
    return this;
  }

  /** Kotak terisi. */
  public fillRect(
    x: number,
    y: number,
    w: number,
    h: number,
    color: LcdColor = 1,
  ): this {
    for (let j = 0; j < h; j++) this.hLine(x, y + j, w, color);
    return this;
  }

  /** Lingkaran (midpoint algorithm). */
  public circle(cx: number, cy: number, r: number, color: LcdColor = 1): this {
    cx = cx | 0;
    cy = cy | 0;
    r = Math.abs(r | 0);
    let x = r;
    let y = 0;
    let err = 1 - r;
    while (x >= y) {
      this.setPixel(cx + x, cy + y, color);
      this.setPixel(cx + y, cy + x, color);
      this.setPixel(cx - y, cy + x, color);
      this.setPixel(cx - x, cy + y, color);
      this.setPixel(cx - x, cy - y, color);
      this.setPixel(cx - y, cy - x, color);
      this.setPixel(cx + y, cy - x, color);
      this.setPixel(cx + x, cy - y, color);
      y++;
      if (err < 0) err += 2 * y + 1;
      else {
        x--;
        err += 2 * (y - x) + 1;
      }
    }
    return this;
  }

  /** Lingkaran terisi. */
  public fillCircle(
    cx: number,
    cy: number,
    r: number,
    color: LcdColor = 1,
  ): this {
    r = Math.abs(r | 0);
    for (let dy = -r; dy <= r; dy++) {
      const dx = Math.floor(Math.sqrt(r * r - dy * dy));
      this.hLine(cx - dx, cy + dy, 2 * dx + 1, color);
    }
    return this;
  }

  /** Balik seluruh isi buffer (efek inversi lokal). */
  public invert(): this {
    for (let i = 0; i < this.bytes.length; i++) this.bytes[i] ^= 0xff;
    return this;
  }

  /** Salinan byte (untuk dikirim lewat fs.write). */
  public toBytes(): Uint8Array {
    return this.bytes;
  }
}

// ================================================================
// LIBRARY
// ================================================================

/** Opsi instance — lihat `LcdLib`. */
export interface LcdLibOptions {
  /**
   * Path node device (mis. `/dev/plcd`). Default: env `TSIX_LCD_DEV` bila ada,
   * kalau tidak `/dev/lcd`.
   */
  devicePath?: string;
}

export class LcdLib {
  private _lib: any;
  private fd: number | null = null;
  /** Path device khusus instance ini (opsi constructor / setDevicePath). */
  private _devicePath?: string;

  /**
   * @param lib     UserLib instance (opsional). Default: `(global as any)._tsixLib`
   *                — cocok dipakai dari bin, lib, maupun app.
   * @param options `{ devicePath }` untuk mengarahkan ke node lain (mis. `/dev/plcd`).
   */
  constructor(lib?: any, options: LcdLibOptions = {}) {
    this._lib = lib || null;
    this._devicePath = options.devicePath;
  }

  /**
   * Path node yang sedang dipakai: opsi instance → env `TSIX_LCD_DEV` →
   * `/dev/lcd`. Env dibaca saat pemakaian (lazy), bukan saat import — jadi
   * test/app boleh mengubahnya kapan saja sebelum operasi pertama.
   */
  public get devicePath(): string {
    if (this._devicePath && this._devicePath.trim()) return this._devicePath;
    const fromEnv = this.envDevicePath();
    return fromEnv || LCD_DEVICE_PATH;
  }

  /** Baca `TSIX_LCD_DEV` dari environment proses (kalau ada). */
  private envDevicePath(): string {
    try {
      const v = (globalThis as any)?.process?.env?.[LCD_DEVICE_ENV];
      return typeof v === "string" && v.trim() ? v.trim() : "";
    } catch {
      return "";
    }
  }

  /**
   * Arahkan instance ini ke node lain (mis. `LCD_PSEUDO_DEVICE_PATH`).
   * Kalau FD sudah terbuka untuk device sebelumnya, FD itu ditutup dulu supaya
   * tidak ada handle nyangkut — jadi aman dipanggil di tengah umur instance.
   */
  public setDevicePath(path: string): this {
    const next = String(path ?? "").trim();
    if (!next || next === this.devicePath) return this;
    this._devicePath = next;
    if (this.fd !== null) {
      const fd = this.fd;
      this.fd = null;
      try {
        void Promise.resolve(this.fs?.close?.(fd)).catch(() => { });
      } catch {
        /* abaikan */
      }
    }
    return this;
  }

  /** Resolusi lazy — `global._tsixLib` baru tersedia saat runtime worker. */
  private get lib(): any {
    return this._lib || (global as any)._tsixLib || null;
  }

  private get fs(): any {
    return this.lib?.fs;
  }

  private get std(): any {
    return this.lib?.std;
  }

  /** Buka device sekali (lazy, mode "w+") — FD di-cache sampai close(). */
  private async ensureOpen(): Promise<number> {
    if (this.fd !== null) return this.fd;
    if (!this.lib?.fs || !this.lib?.std) {
      throw new Error(
        "[lcdLib] UserLib tidak tersedia (global._tsixLib kosong?). " +
          "Pastikan dipanggil di lingkungan TSIX Worker.",
      );
    }
    const path = this.devicePath;
    const fd = await this.fs.open(path, "w+");
    if (fd === null || fd === undefined || fd < 0) {
      throw new Error(
        `[lcdLib] Gagal buka ${path} (fd=${fd}). ` +
          (path === LCD_DEVICE_PATH
            ? "Pastikan driver LM6029 sudah di-load kernel & SPI aktif."
            : `Pastikan driver untuk ${path} sudah di-load kernel.`),
      );
    }
    this.fd = fd;
    return fd;
  }

  /** Kirim ioctl mentah (dipakai internal; tersedia untuk perintah baru). */
  private async cmd(code: number, arg: any = null): Promise<any> {
    const fd = await this.ensureOpen();
    return await this.std.ioctl(fd, code, arg);
  }

  /** Tutup FD (jika terbuka). Panggil saat app selesai. */
  public async close(): Promise<void> {
    if (this.fd !== null) {
      try {
        await this.fs.close(this.fd);
      } catch {
        /* abaikan */
      }
      this.fd = null;
    }
  }

  /**
   * Cek apakah LCD ada DAN panelnya benar-benar siap.
   * (Node /dev/lcd bisa ada walau SPI/addon belum hidup → `available: false`.)
   */
  public async isAvailable(): Promise<boolean> {
    try {
      const info = await this.getInfo();
      return info?.available === true;
    } catch {
      return false;
    }
  }

  /** Coba hidupkan panel (kalau sebelumnya gagal karena SPI belum siap). */
  public async begin(): Promise<boolean> {
    try {
      return !!(await this.cmd(LCD_BEGIN));
    } catch {
      return false;
    }
  }

  /** Status lengkap driver + panel. */
  public async getInfo(): Promise<LcdInfo | null> {
    try {
      return (await this.cmd(LCD_GET_INFO)) as LcdInfo | null;
    } catch {
      return null;
    }
  }

  /**
   * true kalau node yang dipakai adalah panel PALSU (emulator software).
   * Berguna kalau app ingin menampilkan penanda "simulasi" — app lain tidak
   * perlu tahu apa-apa, karena kontrak ioctl-nya identik.
   */
  public async isPseudo(): Promise<boolean> {
    const info = await this.getInfo();
    return info?.pseudo === true;
  }

  /**
   * [PSEUDO-LCD] Revisi isi panel — murah, jadi aman di-poll berkala.
   * Naik hanya saat flush (isi panel berubah), bukan tiap perintah gambar.
   * Di panel asli (`/dev/lcd`) ioctl ini tidak ada → null.
   */
  public async getFrameRev(): Promise<number | null> {
    try {
      const v = await this.cmd(LCD_GET_REV);
      return v === null || v === undefined ? null : Number(v);
    } catch {
      return null;
    }
  }

  /**
   * [PSEUDO-LCD] Tarik isi panel + status tampilan (warna, invert, dst).
   * Alur viewer: `getFrameRev()` berubah → `getFrame()` → gambar `fb`
   * (decode base64, 1 bpp MSB-first) ke canvas.
   * Di panel asli ioctl ini tidak ada → null.
   */
  public async getFrame(): Promise<LcdPseudoFrame | null> {
    try {
      const v = await this.cmd(LCD_GET_FRAME);
      return v && typeof v === "object" && typeof v.fb === "string"
        ? (v as LcdPseudoFrame)
        : null;
    } catch {
      return null;
    }
  }

  /** Lebar panel (piksel). */
  public async getWidth(): Promise<number> {
    return Number(await this.cmd(LCD_GET_WIDTH)) || LCD_WIDTH;
  }

  /** Tinggi panel (piksel). */
  public async getHeight(): Promise<number> {
    return Number(await this.cmd(LCD_GET_HEIGHT)) || LCD_HEIGHT;
  }

  // ================================================================
  // LIFECYCLE
  // ================================================================

  /** Bersihkan buffer gambar (belum tampil sampai flush/display). */
  public async clear(): Promise<boolean> {
    return !!(await this.cmd(LCD_CLEAR));
  }

  /** Kirim buffer ke panel (flush). */
  public async flush(): Promise<boolean> {
    return !!(await this.cmd(LCD_DISPLAY));
  }

  /** Alias `flush()` — biar familiar bagi pemakai Adafruit_GFX. */
  public async display(): Promise<boolean> {
    return await this.flush();
  }

  /** Bersihkan lalu langsung tampilkan. */
  public async reset(): Promise<boolean> {
    return !!(await this.cmd(LCD_RESET));
  }

  /** Auto-flush: kalau ON, print()/blit() langsung tampil tanpa flush manual. */
  public async setAutoFlush(on: boolean): Promise<boolean> {
    return !!(await this.cmd(LCD_SET_AUTO_FLUSH, { on }));
  }

  /** Status auto-flush. */
  public async isAutoFlush(): Promise<boolean> {
    return !!(await this.cmd(LCD_GET_AUTO_FLUSH));
  }

  // ================================================================
  // GRAFIK
  // ================================================================

  /** Nyalakan/matikan satu piksel. */
  public async drawPixel(x: number, y: number, color: LcdColor = 1): Promise<boolean> {
    return !!(await this.cmd(LCD_DRAW_PIXEL, { x, y, color }));
  }

  /** Isi seluruh layar: 1 = nyala (putih), 0 = mati (hitam). */
  public async fillScreen(color: LcdColor = 1): Promise<boolean> {
    return !!(await this.cmd(LCD_FILL_SCREEN, { color }));
  }

  /** Garis dari (x0,y0) ke (x1,y1). */
  public async drawLine(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: LcdColor = 1,
  ): Promise<boolean> {
    return !!(await this.cmd(LCD_DRAW_LINE, { x0, y0, x1, y1, color }));
  }

  /** Kotak bergaris (outline). */
  public async drawRect(
    x: number,
    y: number,
    w: number,
    h: number,
    color: LcdColor = 1,
  ): Promise<boolean> {
    return !!(await this.cmd(LCD_DRAW_RECT, { x, y, w, h, color }));
  }

  /** Kotak terisi. */
  public async fillRect(
    x: number,
    y: number,
    w: number,
    h: number,
    color: LcdColor = 1,
  ): Promise<boolean> {
    return !!(await this.cmd(LCD_FILL_RECT, { x, y, w, h, color }));
  }

  /** Lingkaran bergaris. */
  public async drawCircle(
    x: number,
    y: number,
    r: number,
    color: LcdColor = 1,
  ): Promise<boolean> {
    return !!(await this.cmd(LCD_DRAW_CIRCLE, { x, y, r, color }));
  }

  /** Lingkaran terisi. */
  public async fillCircle(
    x: number,
    y: number,
    r: number,
    color: LcdColor = 1,
  ): Promise<boolean> {
    return !!(await this.cmd(LCD_FILL_CIRCLE, { x, y, r, color }));
  }

  /** Segitiga bergaris. */
  public async drawTriangle(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: LcdColor = 1,
  ): Promise<boolean> {
    return !!(await this.cmd(LCD_DRAW_TRIANGLE, { x0, y0, x1, y1, x2, y2, color }));
  }

  /** Segitiga terisi. */
  public async fillTriangle(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: LcdColor = 1,
  ): Promise<boolean> {
    return !!(await this.cmd(LCD_FILL_TRIANGLE, { x0, y0, x1, y1, x2, y2, color }));
  }

  /** Kotak sudut membulat (outline). */
  public async drawRoundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    color: LcdColor = 1,
  ): Promise<boolean> {
    return !!(await this.cmd(LCD_DRAW_ROUND_RECT, { x, y, w, h, r, color }));
  }

  /** Kotak sudut membulat (terisi). */
  public async fillRoundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    color: LcdColor = 1,
  ): Promise<boolean> {
    return !!(await this.cmd(LCD_FILL_ROUND_RECT, { x, y, w, h, r, color }));
  }

  /**
   * Blit bitmap 1 bpp (MSB-first, lebar kelipatan 8) pada posisi (x,y).
   * Menerima Uint8Array/Buffer atau LcdFramebuffer.
   */
  public async drawBitmap(
    x: number,
    y: number,
    data: Uint8Array | LcdFramebuffer,
    w: number,
    h: number,
    color: LcdColor = 1,
  ): Promise<boolean> {
    const bytes = data instanceof LcdFramebuffer ? data.toBytes() : data;
    return !!(await this.cmd(LCD_DRAW_BITMAP, { x, y, data: bytes, w, h, color }));
  }

  // ================================================================
  // TEKS
  // ================================================================

  /** Pilih font (0..3) — lihat `LcdFont`. */
  public async setFont(font: number | LcdFontId): Promise<number> {
    return Number(await this.cmd(LCD_SET_FONT, { id: Number(font) }));
  }

  /**
   * Warna teks & latar.
   * @param color 1 = piksel nyala (teks "hitam di atas putih" pakai 0)
   * @param bg    bila diisi → mode opaque (latar ikut ditulis)
   */
  public async setTextColor(color: LcdColor, bg?: LcdColor): Promise<boolean> {
    return !!(await this.cmd(LCD_SET_TEXT_COLOR, bg === undefined ? { color } : { color, bg }));
  }

  /** Perbesar teks (1 = normal). */
  public async setTextSize(size: number): Promise<boolean> {
    return !!(await this.cmd(LCD_SET_TEXT_SIZE, { size }));
  }

  /** Word-wrap otomatis saat melewati tepi kanan. */
  public async setTextWrap(wrap: boolean): Promise<boolean> {
    return !!(await this.cmd(LCD_SET_TEXT_WRAP, { wrap }));
  }

  /** Pindahkan cursor (basis-kiri-atas glyph). */
  public async setCursor(x: number, y: number): Promise<boolean> {
    return !!(await this.cmd(LCD_SET_CURSOR, { x, y }));
  }

  /** Cetak di posisi cursor saat ini (pakai font/ukuran aktif). */
  public async print(text: string): Promise<boolean> {
    return !!(await this.cmd(LCD_PRINT, { text: String(text ?? "") }));
  }

  /** Cetak sekali di posisi (x,y) — tidak mengubah cursor permanen. */
  public async printText(
    text: string,
    x: number,
    y: number,
    size = 1,
  ): Promise<boolean> {
    return !!(await this.cmd(LCD_PRINT_TEXT, { text: String(text ?? ""), x, y, size }));
  }

  /**
   * Cetak teks rata-tengah secara horizontal.
   * Lebar karakter diasumsikan 6 px * size (font default 5x7) — untuk font
   * Adafruit kustom hasilnya perkiraan, geser manual bila perlu.
   */
  public async printCentered(
    text: string,
    y: number,
    size = 1,
    width = LCD_WIDTH,
  ): Promise<boolean> {
    const w = String(text ?? "").length * 6 * size;
    const x = Math.max(0, Math.round((width - w) / 2));
    return await this.printText(text, x, y, size);
  }

  // ================================================================
  // KONTROL TAMPILAN
  // ================================================================

  /** Set kontras (EVR 0..63, otomatis di-clamp) → nilai yang dipakai. */
  public async setContrast(level: number): Promise<number> {
    return Number(await this.cmd(LCD_SET_CONTRAST, { level }));
  }

  /** Baca kontras saat ini. */
  public async getContrast(): Promise<number | null> {
    const v = await this.cmd(LCD_GET_CONTRAST);
    return v === null || v === undefined ? null : Number(v);
  }

  /** Nyalakan/matikan backlight (hemat daya). */
  public async setBacklight(on: boolean): Promise<boolean> {
    return !!(await this.cmd(LCD_SET_BACKLIGHT, { on }));
  }

  /** Status backlight. */
  public async getBacklight(): Promise<boolean | null> {
    const v = await this.cmd(LCD_GET_BACKLIGHT);
    return v === null || v === undefined ? null : !!v;
  }

  /** Inversi seluruh tampilan (piksel nyala ⇄ mati). */
  public async setInvert(invert: boolean): Promise<boolean> {
    return !!(await this.cmd(LCD_SET_INVERT, { invert }));
  }

  /** Status inversi. */
  public async getInvert(): Promise<boolean | null> {
    const v = await this.cmd(LCD_GET_INVERT);
    return v === null || v === undefined ? null : !!v;
  }

  /** Display ON/OFF (isi buffer tetap aman saat OFF). */
  public async setDisplayOn(on: boolean): Promise<boolean> {
    return !!(await this.cmd(LCD_SET_DISPLAY_ON, { on }));
  }

  /** Status display. */
  public async isDisplayOn(): Promise<boolean | null> {
    const v = await this.cmd(LCD_IS_DISPLAY_ON);
    return v === null || v === undefined ? null : !!v;
  }

  /**
   * Set clock SPI (Hz) → kecepatan yang benar-benar dipakai hardware.
   * Di Raspberry Pi hanya pangkat dua dari core clock yang tersedia:
   * minta 32 MHz (bukan 25 MHz) untuk dapat ~31.25 MHz.
   */
  public async setSpiSpeed(hz: number): Promise<number> {
    return Number(await this.cmd(LCD_SET_SPI_SPEED, { hz }));
  }

  /** Kecepatan SPI aktual (Hz). */
  public async getSpiSpeed(): Promise<number | null> {
    const v = await this.cmd(LCD_GET_SPI_SPEED);
    return v === null || v === undefined ? null : Number(v);
  }

  /** Rotasi 0..3 (0 = normal, 1 = 90°, ...). */
  public async setRotation(rotation: number): Promise<number> {
    return Number(await this.cmd(LCD_SET_ROTATION, { rotation }));
  }

  // ================================================================
  // FRAMEBUFFER (paling cepat untuk animasi penuh-layar)
  // ================================================================

  /** Buat back-buffer mono baru (kosong, 1024 byte). */
  public framebuffer(): LcdFramebuffer {
    return new LcdFramebuffer();
  }

  /**
   * Kirim framebuffer penuh (1024 byte) ke panel — SATU FRAME UTUH.
   *
   * Driver membersihkan buffer panel lebih dulu, jadi frame ini benar-benar
   * **mengganti** isi layar — bukan menumpuk di atas frame sebelumnya. Karena
   * itu `fb.clear()` + `blit()` = layar bersih (cara menghapus layar dari
   * framebuffer), dan animasi berikutnya tidak meninggalkan "hantu" piksel.
   *
   * Present ke panel mengikuti `setAutoFlush()`: bila auto-flush OFF, panggil
   * `flush()` sendiri setelah `blit()` — kalau tidak, frame tetap di buffer
   * dan panel masih menampilkan gambar lama.
   *
   * Menerima `LcdFramebuffer` atau `Uint8Array` mentah 1024 byte.
   */
  public async blit(fb: LcdFramebuffer | Uint8Array): Promise<boolean> {
    const bytes = fb instanceof LcdFramebuffer ? fb.toBytes() : fb;
    if (!bytes || bytes.length !== LCD_FB_SIZE) {
      // Tanpa guard ini, buffer berukuran salah akan diperlakukan driver
      // sebagai TEKS (write() non-1024 byte = print), bukan sebagai frame.
      throw new Error(
        `[lcdLib] blit() butuh ${LCD_FB_SIZE} byte (frame penuh ` +
          `${LCD_WIDTH}x${LCD_HEIGHT} 1 bpp), dapat ${bytes ? bytes.length : 0}.`,
      );
    }
    const fd = await this.ensureOpen();
    return !!(await this.fs.write(fd, bytes));
  }

  /** Baca status mentah dari device (JSON string), atau null bila gagal. */
  public async readRaw(): Promise<string | null> {
    try {
      const fd = await this.ensureOpen();
      const raw = await this.fs.read(fd);
      return typeof raw === "string" ? raw : null;
    } catch {
      return null;
    }
  }
}

// ================================================================
// SINGLETON KONVENIEN (gaya joystickLib / theme.ts)
// ================================================================

/** Instance global — pakai lib aktif dari `(global as any)._tsixLib`. */
export const lcd = new LcdLib();

export default LcdLib;
