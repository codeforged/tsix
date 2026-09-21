/**
 * tftLib.ts — Userland library untuk /dev/tft (TFT warna 320x240 ILI9341)
 *
 * Wrapper tingkat tinggi di atas driver TFT kernel (`ILI9341Device`).
 * Developer aplikasi TIDAK perlu pusing dengan FD & nomor ioctl — cukup
 * panggil method yang manusiawi, persis gaya Adafruit_GFX berwarna.
 *
 * ── USAGE ──
 *   import { tft, rgb } from "@tsix/tftLib";
 *
 *   if (await tft.isAvailable()) {
 *     await tft.setRotation(0);              // 0 = 320x240 landscape
 *     await tft.fillScreen(TFT_COLOR.PANEL_BG);
 *     await tft.setTextColor(rgb(0, 255, 242), TFT_COLOR.BLACK);
 *     await tft.setTextSize(3);
 *     await tft.printText("Halo TSIX", 12, 20);
 *     await tft.flush();                     // present ke /dev/fb1
 *   }
 *
 * ── ANIMASI 60 FPS: JANGAN GAMBAR LEWAT SYSCALL ──
 * Tiap `await tft.xxx()` adalah satu round-trip IPC ke worker kernel, dan tiap
 * flush memindahkan 150 KB. Karena itu gambar-lah LOKAL di `TftFramebuffer`
 * (nol syscall, RGB565) lalu present **sekali** per frame:
 *
 *   const fb = tft.framebuffer();
 *   for (;;) {
 *     fb.clear();
 *     fb.fillCircle(x, y, 20, rgb(255, 64, 0));
 *     fb.line(0, 239, 319, 0, rgb(0, 120, 255));
 *     await tft.blit(fb);        // 1 syscall per frame (auto-flush)
 *   }
 *
 * Teks tetap lewat `printText()` (font ada di kernel, bukan di framebuffer):
 * gambar primitif lokal dulu, cetak teks, lalu `blit()`/`flush()` sekali.
 *
 * ── WARNA ──
 * Semua warna adalah RGB565 16-bit (format buffer /dev/fbN). Helper:
 *   rgb(0, 255, 242)      → komponen 8-bit
 *   rgb("#00fff2")        → string hex
 *   rgb(0x00fff2)         → angka 24-bit (0xRRGGBB, di atas 0xFF)
 *   rgb(200)              → grayscale 8-bit
 * Palet siap pakai: `TFT_COLOR` (BLACK, WHITE, CYAN_NEON, PANEL_BG, ...).
 * Nilai 565 mentah (hasil `TFT_COLOR.*`/`rgb565()`) dikirim langsung sebagai
 * argumen `color` — jangan diputar ulang lewat `rgb()`.
 *
 * ── CATATAN ──
 * Konstanta ioctl di bawah HARUS sinkron dengan enum `TFTIOCTL` di driver
 * kernel: src/kernel/devices/aux-devices/ILI9341Device.ts
 *
 * (c) 2026 TSIX Project
 */

// ── Perintah ioctl (namespace 0x54 = 'T') — wajib match kernel driver ──
const T_BEGIN = 0x5401; // null → boolean
const T_RESET = 0x5402; // null → true (isi hitam + flush)
const T_CLEAR = 0x5403; // null → true (back-buffer saja)
const T_DISPLAY = 0x5404; // null → true (flush back-buffer → /dev/fbN)

const T_DRAW_PIXEL = 0x5410; // {x,y,color?}              → true
const T_FILL_SCREEN = 0x5411; // {color?} | number         → true
const T_DRAW_LINE = 0x5412; // {x0,y0,x1,y1,color?}      → true
const T_DRAW_RECT = 0x5413; // {x,y,w,h,color?}          → true
const T_FILL_RECT = 0x5414; // {x,y,w,h,color?}          → true
const T_DRAW_CIRCLE = 0x5415; // {x,y,r,color?}            → true
const T_FILL_CIRCLE = 0x5416; // {x,y,r,color?}            → true
const T_DRAW_TRIANGLE = 0x5417; // {x0,y0,x1,y1,x2,y2,color?} → true
const T_FILL_TRIANGLE = 0x5418; // {x0,y0,x1,y1,x2,y2,color?} → true
const T_DRAW_ROUND_RECT = 0x5419; // {x,y,w,h,r,color?}        → true
const T_FILL_ROUND_RECT = 0x541a; // {x,y,w,h,r,color?}        → true
const T_DRAW_BITMAP = 0x541b; // {x,y,data,w,h,color?}     → true
const T_GET_PIXEL = 0x541c; // {x,y} | null              → RGB565 | null

const T_SET_FONT = 0x5420; // {id} | number             → id
const T_SET_TEXT_COLOR = 0x5421; // {color,bg?}               → true
const T_SET_TEXT_SIZE = 0x5422; // {size} | number           → true
const T_SET_TEXT_WRAP = 0x5423; // boolean                   → true
const T_SET_CURSOR = 0x5424; // {x,y}                     → true
const T_PRINT = 0x5425; // {text} | string           → true
const T_PRINT_TEXT = 0x5426; // {text,x,y,size?}          → true
const T_SET_ROTATION = 0x5427; // {rotation} | number       → 0..3

const T_SET_BACKLIGHT = 0x5430; // boolean | {on}            → boolean
const T_GET_BACKLIGHT = 0x5431; // null                      → boolean
const T_SET_DISPLAY_ON = 0x5432; // boolean | {on}            → boolean
const T_IS_DISPLAY_ON = 0x5433; // null                      → boolean
const T_SET_INVERT = 0x5434; // boolean | {invert}        → boolean
const T_GET_INVERT = 0x5435; // null                      → boolean
const T_SET_BRIGHTNESS = 0x5436; // {level} | number (0..255) → level
const T_GET_BRIGHTNESS = 0x5437; // null                      → number | null
const T_SET_FB_DEVICE = 0x5438; // {path} | string           → path | null
const T_GET_FB_DEVICE = 0x5439; // null                      → string | null

const T_GET_INFO = 0x5440; // null                      → TftInfo
const T_GET_WIDTH = 0x5441; // null                      → number
const T_GET_HEIGHT = 0x5442; // null                      → number
const T_SET_AUTO_FLUSH = 0x5443; // boolean                    → boolean
const T_GET_AUTO_FLUSH = 0x5444; // null                       → boolean
const T_GET_FB_SIZE = 0x5445; // null                      → number
const T_GET_STRIDE = 0x5446; // null                      → number

// ================================================================
// KONSTANTA & WARNA
// ================================================================

/** Path device TFT di VFS. */
export const TFT_DEVICE_PATH = "/dev/tft";

/**
 * Env untuk mengarahkan SEMUA instance `tft` ke node lain —
 * mis. `TSIX_TFT_DEV=/dev/tft2` (dipakai launcher/deployment, bukan app).
 */
export const TFT_DEVICE_ENV = "TSIX_TFT_DEV";

/** Geometri panel (rotation 0 = landscape). */
export const TFT_WIDTH = 320;
export const TFT_HEIGHT = 240;
export const TFT_BPP = 16;
/** Byte per baris scanline: 640. */
export const TFT_STRIDE = TFT_WIDTH * (TFT_BPP / 8);
/** Ukuran satu frame penuh: 153600 byte. */
export const TFT_FB_SIZE = TFT_STRIDE * TFT_HEIGHT;

/** Clamp ke 0..255 (nilai aneh/NaN → 0). */
function clamp255(v: any): number {
  const n = Math.floor(Number(v));
  return !Number.isFinite(n) ? 0 : n < 0 ? 0 : n > 255 ? 255 : n;
}

/** Komponen 8-bit → RGB565. Satu argumen = grayscale: `rgb(0x1f)`. */
export function rgb565(r: number, g?: number, b?: number): number {
  const R = clamp255(r);
  const G = clamp255(g === undefined ? r : g);
  const B = clamp255(b === undefined ? r : b);
  return ((R & 0xf8) << 8) | ((G & 0xfc) << 3) | (B >> 3);
}

/** "#00fff2" / 0x00fff2 (24-bit) → RGB565. */
export function hex565(hex: number | string): number {
  let v: number;
  if (typeof hex === "string") {
    const clean = hex.trim().replace(/^#/, "").replace(/^0x/i, "");
    // Hanya hex murni — parseInt() longgar ("bukan-warna" → 0xb).
    if (!/^[0-9a-f]{1,6}$/i.test(clean)) return 0;
    v = Number.parseInt(clean, 16);
  } else {
    v = Number(hex);
  }
  if (!Number.isFinite(v)) return 0;
  return rgb565((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
}

/**
 * Helper warna serbaguna:
 *   rgb(0, 255, 242)  → komponen 8-bit
 *   rgb("#00fff2")    → string hex
 *   rgb(0x00fff2)     → angka 24-bit (0xRRGGBB, di atas 0xFF)
 *   rgb(200)          → grayscale 8-bit (0..255)
 *
 * CATATAN: angka tunggal di atas 0xFF dianggap 24-bit `0xRRGGBB`, BUKAN
 * RGB565 — untuk nilai 565 mentah (mis. `TFT_COLOR.RED`) kirimkan langsung
 * sebagai `color`, jangan lewat `rgb()`.
 */
export function rgb(r: number | string, g?: number, b?: number): number {
  if (typeof r === "string") return hex565(r);
  if (g === undefined && b === undefined && Number(r) > 0xff) return hex565(r);
  return rgb565(Number(r), g, b);
}

/** RGB565 → komponen 8-bit (untuk menyimpan warna di state app / debug). */
export function unpack565(c: number): { r: number; g: number; b: number } {
  const v = Number(c) & 0xffff;
  const r = (v >> 11) & 0x1f;
  const g = (v >> 5) & 0x3f;
  const b = v & 0x1f;
  return { r: (r << 3) | (r >> 2), g: (g << 2) | (g >> 4), b: (b << 3) | (b >> 2) };
}

/** Palet dasar siap pakai (nilai RGB565, bukan 24-bit). */
export const TFT_COLOR = {
  BLACK: 0x0000,
  WHITE: 0xffff,
  RED: rgb565(255, 0, 0),
  GREEN: rgb565(0, 255, 0),
  BLUE: rgb565(0, 0, 255),
  CYAN: rgb565(0, 255, 255),
  MAGENTA: rgb565(255, 0, 255),
  YELLOW: rgb565(255, 255, 0),
  ORANGE: rgb565(255, 165, 0),
  GRAY: rgb565(128, 128, 128),
  DARK_GRAY: rgb565(64, 64, 64),
  NAVY: rgb565(0, 0, 128),
  GREEN_DARK: rgb565(0, 128, 0),
  MAROON: rgb565(128, 0, 0),
  /** Aksen HUD biru-cyan (dipakai contoh dashboard). */
  CYAN_NEON: rgb565(0, 255, 242),
  /** Latar gelap ala panel instrumen. */
  PANEL_BG: rgb565(10, 10, 18),
} as const;

/** Nomor font yang dikenali driver. */
export type TftFontId = 0 | 1 | 2 | 3;

/** Konstanta font siap pakai (hindari magic number). */
export const TftFont = {
  /** glcdfont 5x7 (default Adafruit). */
  DEFAULT: 0 as TftFontId,
  FREE_SANS_9: 1 as TftFontId,
  FREE_SANS_BOLD_12: 2 as TftFontId,
  FREE_MONO_9: 3 as TftFontId,
};

/** Nama tiap font (untuk log/CLI). */
export const TFT_FONT_NAMES: Record<number, string> = {
  0: "default 5x7",
  1: "FreeSans9pt7b",
  2: "FreeSansBold12pt7b",
  3: "FreeMono9pt7b",
};

// ================================================================
// TYPES
// ================================================================

/** Status perangkat — hasil GET_INFO. */
export interface TftInfo {
  /** Path node, mis. "/dev/tft". */
  device: string;
  /** true kalau framebuffer TFT benar-benar siap dipakai. */
  available: boolean;
  /** Lebar logika (ikut rotasi). */
  width: number;
  /** Tinggi logika (ikut rotasi). */
  height: number;
  /** Geometri fisik panel (tanpa rotasi). */
  panelWidth: number;
  panelHeight: number;
  bpp: number;
  /** Byte per baris (640). */
  stride: number;
  /** Ukuran satu frame penuh (153600). */
  framebufferSize: number;
  /** Node framebuffer host yang dipakai, mis. "/dev/fb1". */
  fbDevice: string | null;
  /** Nama driver fbdev dari sysfs, mis. "fb_ili9341". */
  fbName: string | null;
  /** Resolusi fisik menurut sysfs (validasi cepat salah node). */
  fbVirtualSize: { w: number; h: number } | null;
  rotation: number;
  invert: boolean;
  displayOn: boolean;
  backlight: boolean | null;
  /**
   * Kecerahan 0..255 — null kalau driver tidak dikonfigurasi dengan
   * `backlightPath` (TFT lewat fbtft tidak mengekspos backlight sendiri).
   */
  brightness: number | null;
  autoFlush: boolean;
  fontId: number;
  textColor: number;
  textBg: number | null;
  textSize: number;
  textWrap: boolean;
  cursorX: number;
  cursorY: number;
  frames?: number;
  lastError?: string | null;
}

// ================================================================
// FRAMEBUFFER RGB565 (back-buffer lokal, nol syscall)
// ================================================================

/**
 * TftFramebuffer — back-buffer RGB565 320x240 yang digambar LOKAL di worker
 * userland, lalu dikirim ke panel dengan satu `tft.blit(fb)`.
 *
 * Layout byte = RGB565 little-endian row-major, stride 640 byte — persis isi
 * `/dev/fbN`, jadi `blit()` tidak perlu konversi apa pun.
 *
 * ⚠️ Seperti fbdev asli, urutan byte mengikuti endianness host (ARM/x86 =
 * little-endian). TSIX hanya menargetkan Linux little-endian.
 */
export class TftFramebuffer {
  readonly width: number;
  readonly height: number;
  /** Byte per baris (width * 2). */
  readonly stride: number;
  /** Piksel RGB565 (satu elemen = satu piksel). */
  readonly words: Uint16Array;
  /** Byte mentah — siap dikirim ke device. */
  readonly bytes: Uint8Array;

  constructor(width = TFT_WIDTH, height = TFT_HEIGHT) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.stride = this.width * 2;
    const ab = new ArrayBuffer(this.stride * this.height);
    this.words = new Uint16Array(ab);
    this.bytes = new Uint8Array(ab);
  }

  /** Kosongkan buffer dengan satu warna. */
  public clear(color = 0): this {
    this.words.fill(color & 0xffff);
    return this;
  }

  /** Tulis piksel; koordinat di luar layar diabaikan. */
  public setPixel(x: number, y: number, color: number): this {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return this;
    this.words[y * this.width + x] = color & 0xffff;
    return this;
  }

  /** Baca piksel (0 di luar layar). */
  public getPixel(x: number, y: number): number {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return 0;
    return this.words[y * this.width + x];
  }

  /** Garis horizontal. */
  public hLine(x: number, y: number, w: number, color: number): this {
    for (let i = 0; i < w; i++) this.setPixel(x + i, y, color);
    return this;
  }

  /** Garis vertikal. */
  public vLine(x: number, y: number, h: number, color: number): this {
    for (let i = 0; i < h; i++) this.setPixel(x, y + i, color);
    return this;
  }

  /** Garis bebas (Bresenham). */
  public line(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: number,
  ): this {
    x0 = Math.floor(x0);
    y0 = Math.floor(y0);
    x1 = Math.floor(x1);
    y1 = Math.floor(y1);
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

  /** Kotak bergaris. */
  public rect(x: number, y: number, w: number, h: number, color: number): this {
    if (w <= 0 || h <= 0) return this;
    if (w === 1) return this.vLine(x, y, h, color);
    if (h === 1) return this.hLine(x, y, w, color);
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
    color: number,
  ): this {
    for (let j = 0; j < h; j++) this.hLine(x, y + j, w, color);
    return this;
  }

  /** Lingkaran bergaris (midpoint). */
  public circle(cx: number, cy: number, r: number, color: number): this {
    cx = Math.floor(cx);
    cy = Math.floor(cy);
    r = Math.abs(Math.floor(r));
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
  public fillCircle(cx: number, cy: number, r: number, color: number): this {
    r = Math.abs(Math.floor(r));
    for (let dy = -r; dy <= r; dy++) {
      const dx = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy)));
      this.hLine(cx - dx, cy + dy, 2 * dx + 1, color);
    }
    return this;
  }

  /** Salinan byte (untuk dikirim lewat fs.write / blit). */
  public toBytes(): Uint8Array {
    return this.bytes;
  }
}

// ================================================================
// LIBRARY
// ================================================================

/** Opsi instance — lihat `TftLib`. */
export interface TftLibOptions {
  /**
   * Path node device (mis. `/dev/tft2`). Default: env `TSIX_TFT_DEV` bila ada,
   * kalau tidak `/dev/tft`.
   */
  devicePath?: string;
}

export class TftLib {
  private _lib: any;
  private fd: number | null = null;
  /** Path device khusus instance ini (opsi constructor / setDevicePath). */
  private _devicePath?: string;

  /**
   * @param lib     UserLib instance (opsional). Default: `(global as any)._tsixLib`.
   * @param options `{ devicePath }` untuk mengarahkan ke node lain.
   */
  constructor(lib?: any, options: TftLibOptions = {}) {
    this._lib = lib || null;
    this._devicePath = options.devicePath;
  }

  /** Path node yang sedang dipakai: opsi instance → env → `/dev/tft`. */
  public get devicePath(): string {
    if (this._devicePath && this._devicePath.trim()) return this._devicePath;
    const fromEnv = this.envDevicePath();
    return fromEnv || TFT_DEVICE_PATH;
  }

  /** Baca `TSIX_TFT_DEV` dari environment proses (kalau ada). */
  private envDevicePath(): string {
    try {
      const v = (globalThis as any)?.process?.env?.[TFT_DEVICE_ENV];
      return typeof v === "string" && v.trim() ? v.trim() : "";
    } catch {
      return "";
    }
  }

  /**
   * Arahkan instance ini ke node lain. FD lama ditutup supaya tidak nyangkut.
   */
  public setDevicePath(path: string): this {
    const next = String(path ?? "").trim();
    if (!next || next === this.devicePath) return this;
    this._devicePath = next;
    if (this.fd !== null) {
      const fd = this.fd;
      this.fd = null;
      try {
        void Promise.resolve(this.fs?.close?.(fd)).catch(() => {});
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
        "[tftLib] UserLib tidak tersedia (global._tsixLib kosong?). " +
          "Pastikan dipanggil di lingkungan TSIX Worker.",
      );
    }
    const path = this.devicePath;
    const fd = await this.fs.open(path, "w+");
    if (fd === null || fd === undefined || fd < 0) {
      throw new Error(
        `[tftLib] Gagal buka ${path} (fd=${fd}). ` +
          (path === TFT_DEVICE_PATH
            ? "Pastikan driver ILI9341 sudah di-load kernel & /dev/fb1 ada."
            : `Pastikan driver untuk ${path} sudah di-load kernel.`),
      );
    }
    this.fd = fd;
    return fd;
  }

  /** Kirim ioctl mentah (internal; tersedia untuk perintah baru). */
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

  // ================================================================
  // STATUS & LIFECYCLE
  // ================================================================

  /**
   * Cek apakah TFT ada DAN framebuffer-nya benar-benar siap.
   * (Node /dev/tft bisa ada walau /dev/fbN belum muncul → `available: false`.)
   */
  public async isAvailable(): Promise<boolean> {
    try {
      const info = await this.getInfo();
      return info?.available === true;
    } catch {
      return false;
    }
  }

  /** Coba buka framebuffer lagi (kalau sebelumnya belum ada, mis. setelah modprobe). */
  public async begin(): Promise<boolean> {
    try {
      return !!(await this.cmd(T_BEGIN));
    } catch {
      return false;
    }
  }

  /** Status lengkap driver + panel. */
  public async getInfo(): Promise<TftInfo | null> {
    try {
      return (await this.cmd(T_GET_INFO)) as TftInfo | null;
    } catch {
      return null;
    }
  }

  /** Lebar logika (ikut rotasi). */
  public async getWidth(): Promise<number> {
    return Number(await this.cmd(T_GET_WIDTH)) || TFT_WIDTH;
  }

  /** Tinggi logika (ikut rotasi). */
  public async getHeight(): Promise<number> {
    return Number(await this.cmd(T_GET_HEIGHT)) || TFT_HEIGHT;
  }

  /** Ukuran satu frame penuh (153600 byte). */
  public async getFramebufferSize(): Promise<number> {
    return Number(await this.cmd(T_GET_FB_SIZE)) || TFT_FB_SIZE;
  }

  /** Byte per baris (640). */
  public async getStride(): Promise<number> {
    return Number(await this.cmd(T_GET_STRIDE)) || TFT_STRIDE;
  }

  /** Node framebuffer host yang dipakai, mis. "/dev/fb1". */
  public async getFbDevice(): Promise<string | null> {
    const v = await this.cmd(T_GET_FB_DEVICE);
    return typeof v === "string" ? v : null;
  }

  /**
   * Pindah node framebuffer host (mis. auto-deteksi salah pilih):
   * `await tft.setFbDevice("/dev/fb2")`. Isi back-buffer tidak hilang.
   */
  public async setFbDevice(path: string): Promise<string | null> {
    const v = await this.cmd(T_SET_FB_DEVICE, { path: String(path) });
    return typeof v === "string" ? v : null;
  }

  /** Isi back-buffer dengan satu warna (belum tampil sampai flush/display). */
  public async clear(color: number = TFT_COLOR.BLACK): Promise<boolean> {
    return !!(await this.cmd(T_CLEAR, { color }));
  }

  /** Kirim back-buffer → panel (flush). */
  public async flush(): Promise<boolean> {
    return !!(await this.cmd(T_DISPLAY));
  }

  /** Alias `flush()` — familiar bagi pemakai Adafruit_GFX. */
  public async display(): Promise<boolean> {
    return await this.flush();
  }

  /** Isi hitam lalu langsung tampilkan. */
  public async reset(color: number = TFT_COLOR.BLACK): Promise<boolean> {
    return !!(await this.cmd(T_RESET, { color }));
  }

  /** Auto-flush: kalau ON, print()/blit() langsung tampil tanpa flush manual. */
  public async setAutoFlush(on: boolean): Promise<boolean> {
    return !!(await this.cmd(T_SET_AUTO_FLUSH, { on }));
  }

  /** Status auto-flush. */
  public async isAutoFlush(): Promise<boolean> {
    return !!(await this.cmd(T_GET_AUTO_FLUSH));
  }

  // ================================================================
  // GRAFIK
  // ================================================================

  /** Tulis satu piksel (bypass back-buffer — lambat, hindari di loop). */
  public async drawPixel(
    x: number,
    y: number,
    color: number = TFT_COLOR.WHITE,
  ): Promise<boolean> {
    return !!(await this.cmd(T_DRAW_PIXEL, { x, y, color }));
  }

  /** Baca warna satu piksel dari back-buffer (null bila di luar layar). */
  public async getPixel(x: number, y: number): Promise<number | null> {
    const v = await this.cmd(T_GET_PIXEL, { x, y });
    return v === null || v === undefined ? null : Number(v);
  }

  /** Isi seluruh layar dengan satu warna. */
  public async fillScreen(color: number = TFT_COLOR.BLACK): Promise<boolean> {
    return !!(await this.cmd(T_FILL_SCREEN, { color }));
  }

  /** Garis dari (x0,y0) ke (x1,y1). */
  public async drawLine(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: number = TFT_COLOR.WHITE,
  ): Promise<boolean> {
    return !!(await this.cmd(T_DRAW_LINE, { x0, y0, x1, y1, color }));
  }

  /** Kotak bergaris (outline). */
  public async drawRect(
    x: number,
    y: number,
    w: number,
    h: number,
    color: number = TFT_COLOR.WHITE,
  ): Promise<boolean> {
    return !!(await this.cmd(T_DRAW_RECT, { x, y, w, h, color }));
  }

  /** Kotak terisi. */
  public async fillRect(
    x: number,
    y: number,
    w: number,
    h: number,
    color: number = TFT_COLOR.WHITE,
  ): Promise<boolean> {
    return !!(await this.cmd(T_FILL_RECT, { x, y, w, h, color }));
  }

  /** Lingkaran bergaris. */
  public async drawCircle(
    x: number,
    y: number,
    r: number,
    color: number = TFT_COLOR.WHITE,
  ): Promise<boolean> {
    return !!(await this.cmd(T_DRAW_CIRCLE, { x, y, r, color }));
  }

  /** Lingkaran terisi. */
  public async fillCircle(
    x: number,
    y: number,
    r: number,
    color: number = TFT_COLOR.WHITE,
  ): Promise<boolean> {
    return !!(await this.cmd(T_FILL_CIRCLE, { x, y, r, color }));
  }

  /** Segitiga bergaris. */
  public async drawTriangle(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: number = TFT_COLOR.WHITE,
  ): Promise<boolean> {
    return !!(await this.cmd(T_DRAW_TRIANGLE, { x0, y0, x1, y1, x2, y2, color }));
  }

  /** Segitiga terisi. */
  public async fillTriangle(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: number = TFT_COLOR.WHITE,
  ): Promise<boolean> {
    return !!(await this.cmd(T_FILL_TRIANGLE, { x0, y0, x1, y1, x2, y2, color }));
  }

  /** Kotak sudut membulat (outline). */
  public async drawRoundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    color: number = TFT_COLOR.WHITE,
  ): Promise<boolean> {
    return !!(await this.cmd(T_DRAW_ROUND_RECT, { x, y, w, h, r, color }));
  }

  /** Kotak sudut membulat (terisi). */
  public async fillRoundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    color: number = TFT_COLOR.WHITE,
  ): Promise<boolean> {
    return !!(await this.cmd(T_FILL_ROUND_RECT, { x, y, w, h, r, color }));
  }

  /**
   * Blit bitmap pada (x,y):
   *   - data 1 bpp MSB-first (α = w*h*2 byte) → bit 1 digambar `color`
   *     (bit 0 transparan) — format `drawBitmap` Adafruit_GFX.
   *   - data RGB565 mentah (α = w*h*2 byte)  → warna asli, `color` diabaikan.
   * Driver memilih berdasarkan panjang data.
   */
  public async drawBitmap(
    x: number,
    y: number,
    data: Uint8Array | TftFramebuffer,
    w: number,
    h: number,
    color: number = TFT_COLOR.WHITE,
  ): Promise<boolean> {
    const bytes = data instanceof TftFramebuffer ? data.bytes : data;
    return !!(await this.cmd(T_DRAW_BITMAP, { x, y, data: bytes, w, h, color }));
  }

  // ================================================================
  // TEKS
  // ================================================================

  /** Pilih font (0..3) — lihat `TftFont`. */
  public async setFont(font: number | TftFontId): Promise<number> {
    return Number(await this.cmd(T_SET_FONT, { id: Number(font) }));
  }

  /**
   * Warna teks & latar.
   * @param color RGB565 teks
   * @param bg    bila diisi → latar glyph ikut ditulis (opaque)
   */
  public async setTextColor(color: number, bg?: number | null): Promise<boolean> {
    return !!(await this.cmd(T_SET_TEXT_COLOR, bg === undefined ? { color } : { color, bg }));
  }

  /** Perbesar teks (1 = normal). */
  public async setTextSize(size: number): Promise<boolean> {
    return !!(await this.cmd(T_SET_TEXT_SIZE, { size }));
  }

  /** Word-wrap otomatis saat melewati tepi kanan. */
  public async setTextWrap(wrap: boolean): Promise<boolean> {
    return !!(await this.cmd(T_SET_TEXT_WRAP, { wrap }));
  }

  /** Pindahkan cursor (basis kiri-atas glyph untuk font default 5x7). */
  public async setCursor(x: number, y: number): Promise<boolean> {
    return !!(await this.cmd(T_SET_CURSOR, { x, y }));
  }

  /** Cetak di posisi cursor saat ini (font/ukuran aktif). */
  public async print(text: string): Promise<boolean> {
    return !!(await this.cmd(T_PRINT, { text: String(text ?? "") }));
  }

  /** Cetak sekali di posisi (x,y) — cursor tidak berubah permanen. */
  public async printText(
    text: string,
    x: number,
    y: number,
    size = 1,
  ): Promise<boolean> {
    return !!(await this.cmd(T_PRINT_TEXT, { text: String(text ?? ""), x, y, size }));
  }

  /**
   * Cetak teks rata-tengah horizontal.
   * Lebar karakter diasumsikan 6 px * size (font default 5x7) — untuk font
   * Adafruit kustom hasilnya perkiraan, geser manual bila perlu.
   */
  public async printCentered(
    text: string,
    y: number,
    size = 1,
    width = TFT_WIDTH,
  ): Promise<boolean> {
    const w = String(text ?? "").length * 6 * size;
    const x = Math.max(0, Math.round((width - w) / 2));
    return await this.printText(text, x, y, size);
  }

  /** Rotasi 0..3 (0 = 320x240 landscape, 1 = 240x320 portrait). */
  public async setRotation(rotation: number): Promise<number> {
    return Number(await this.cmd(T_SET_ROTATION, { rotation }));
  }

  // ================================================================
  // KONTROL TAMPILAN
  // ================================================================

  /** Nyalakan/matikan backlight (butuh `backlightPath` di driver agar nyata). */
  public async setBacklight(on: boolean): Promise<boolean> {
    return !!(await this.cmd(T_SET_BACKLIGHT, { on }));
  }

  /** Status backlight. */
  public async getBacklight(): Promise<boolean | null> {
    const v = await this.cmd(T_GET_BACKLIGHT);
    return v === null || v === undefined ? null : !!v;
  }

  /** Blank/unblank panel (blank lewat sysfs bila tersedia, kalau tidak status saja). */
  public async setDisplayOn(on: boolean): Promise<boolean> {
    return !!(await this.cmd(T_SET_DISPLAY_ON, { on }));
  }

  /** Status display. */
  public async isDisplayOn(): Promise<boolean | null> {
    const v = await this.cmd(T_IS_DISPLAY_ON);
    return v === null || v === undefined ? null : !!v;
  }

  /**
   * Inversi warna tampilan (RGB565 dibalik saat flush). Berguna untuk
   * panel dengan polarizer terbalik — diemulasi driver, bukan register panel.
   */
  public async setInvert(invert: boolean): Promise<boolean> {
    return !!(await this.cmd(T_SET_INVERT, { invert }));
  }

  /** Status inversi. */
  public async getInvert(): Promise<boolean | null> {
    const v = await this.cmd(T_GET_INVERT);
    return v === null || v === undefined ? null : !!v;
  }

  /** Kecerahan 0..255 → nilai terpakai (null-bila tidak didukung → no-op). */
  public async setBrightness(level: number): Promise<number> {
    return Number(await this.cmd(T_SET_BRIGHTNESS, { level }));
  }

  /** Kecerahan sekarang (null = driver tanpa backlight sysfs). */
  public async getBrightness(): Promise<number | null> {
    const v = await this.cmd(T_GET_BRIGHTNESS);
    return v === null || v === undefined ? null : Number(v);
  }

  // ================================================================
  // FRAMEBUFFER (jalur cepat untuk animasi penuh-layar)
  // ================================================================

  /** Buat back-buffer lokal baru (RGB565, 153600 byte). */
  public framebuffer(): TftFramebuffer {
    return new TftFramebuffer();
  }

  /**
   * Kirim satu frame penuh dari `TftFramebuffer` (atau byte mentah 153600).
   *
   * Ini SATU syscall per frame: buffer lokal digambar di userland (gratis),
   * lalu disalin ke back-buffer kernel dan di-present ke /dev/fbN (bila
   * auto-flush ON). Pola animasi yang disarankan — jangan menggambar
   * per-piksel lewat ioctl (ratusan round-trip per frame).
   */
  public async blit(fb: TftFramebuffer | Uint8Array): Promise<boolean> {
    const bytes = fb instanceof TftFramebuffer ? fb.bytes : fb;
    if (!bytes || bytes.length !== TFT_FB_SIZE) {
      throw new Error(
        `[tftLib] blit() butuh ${TFT_FB_SIZE} byte (frame penuh ` +
          `${TFT_WIDTH}x${TFT_HEIGHT} RGB565), dapat ${bytes ? bytes.length : 0}.`,
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
// SINGLETON KONVENIEN (gaya lcdLib / joystickLib)
// ================================================================

/** Instance global — pakai lib aktif dari `(global as any)._tsixLib`. */
export const tft = new TftLib();

export default TftLib;
