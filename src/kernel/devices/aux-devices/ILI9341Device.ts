/**
 * ILI9341 TFT DEVICE (/dev/tft)
 *
 * Driver kernel-land untuk modul TFT **berwarna 320x240** (controller
 * ILI9341, umumnya dipakai bersama board breakout "2.4/2.8 inch SPI TFT").
 *
 * ── KENAPA BEDA DARI /dev/lcd (LM6029) ──
 * Panel ILI9341 di TSIX TIDAK dibuka lewat SPI langsung dari Node, melainkan
 * lewat **Linux framebuffer** yang sudah disediakan kernel host (driver
 * `fbtft` / `fb_ili9341`), biasanya di `/dev/fb1`. Itu jalur yang sama
 * dengan skrip Node biasa yang menulis RGB565 ke `/dev/fb1` — sudah terbukti
 * jalan di hardware, tanpa native addon tambahan.
 *
 * Jadi pembagian tugasnya:
 *   - HOST KERNEL (fbtft/fb_ili9341) : init panel, SPI, refresh DD-RAM.
 *   - DRIVER INI (TSIX, software)    : back-buffer RGB565 + rasterisasi
 *                                      primitive & teks, lalu `fs.writeSync`
 *                                      satu frame penuh ke /dev/fbN.
 * Efeknya: nol dependensi native, tapi semua primitive digambar di CPU
 * (sama seperti PLCDDevice menggambar panel monokrom di software).
 *
 * ── AKSES USERLAND ──
 *   import { tft, rgb } from "@tsix/tftLib";
 *   await tft.setRotation(0);
 *   await tft.fillScreen(rgb(0, 0, 0));
 *   await tft.printText("Halo TSIX", 10, 20, 3);
 *   await tft.setTextColor(rgb(0, 255, 242));
 *   await tft.flush();
 *
 * Lewat file mentah (Everything is a File):
 *   const fd = await lib.fs.open("/dev/tft", "w+");
 *   await lib.std.ioctl(fd, TFTIOCTL.SET_ROTATION, { rotation: 0 });
 *   await lib.std.ioctl(fd, TFTIOCTL.FILL_SCREEN, { color: 0x0000 });
 *   await lib.std.ioctl(fd, TFTIOCTL.DISPLAY, null);
 *
 * ── TIGA MODE PENULISAN ──
 * 1. FRAMEBUFFER (ala /dev/fbN, sekali jalan):
 *      write(Buffer 153600 byte) → salin sebagai SATU FRAME penuh RGB565
 *      little-endian 320x240 (stride 640 byte). `write(buf, offset)` menyalin
 *      `buf` ke byte ke-`offset` frame — persis semantik `pwrite()` fbdev,
 *      jadi mengirim beberapa baris saja (mis. 640 byte = 1 baris) juga sah
 *      dan baris lain tidak tersentuh.
 *      Cocok untuk `dd`, snapshot layar, atau klien grafis yang menggambar
 *      sendiri di luar TSIX.
 * 2. PERINTAH:
 *      write("teks")                         → cetak di cursor
 *      write({ op: "fillRect", args: [..] }) → panggil primitive GFX
 *      ioctl(fd, TFTIOCTL.*, arg)            → kontrol lengkap
 * 3. TEKS & GRAFIK LEVEL TINGGI: lihat `@tsix/tftLib` (userland).
 *
 * ── AUTO-FLUSH ──
 * write() otomatis memanggil display() (autoFlush default ON) supaya `cat` /
 * `dd` langsung tampil. Perintah ioctl TIDAK auto-flush — gambar beberapa
 * objek lebih dulu, lalu panggil TFTIOCTL.DISPLAY sekali (jauh lebih cepat:
 * satu flush = 150 KB memcpy, jadi jangan flush per piksel).
 *
 * ── WARNA ──
 * Semua `color` adalah angka **RGB565** 16-bit (0x0000..0xFFFF) — format yang
 * sama dengan isi /dev/fbN. Helper `rgb565(r,g,b)`, `hex565("#00fff2")`, dan
 * palet `TFT_COLOR` ada di modul ini; userland memakai `rgb()` dari tftLib.
 * String "#RRGGBB" juga diterima langsung oleh ioctl (enak untuk CLI/JSON).
 *
 * ── HARDWARE / FRAMEBUFFER ──
 * Path framebuffer TIDAK di-hardcode: opsi `fbDevice` → env `TSIX_TFT_FB` →
 * auto-deteksi /dev/fb1../dev/fb9 (dipilih yang `/sys/class/graphics/fbN`
 * menyebut nama `fb_ili9341`, atau resolusi 320x240, atau 16 bpp). Sebelum
 * dipakai, node divalidasi (16 bpp + 320x240 + stride 640) supaya frame
 * driver ini tidak pernah ditulis ke framebuffer yang layout-nya beda.
 * `/dev/fb0` SENGAJA tidak pernah dipilih otomatis — di Raspberry Pi itu HDMI.
 *
 * Referensi host: `fb_ili9341` (fbtft), `fbset`, `/sys/class/graphics/fbN/`.
 * Catatan: fbdev tidak punya ioctl INVON/kontras, jadi `SET_INVERT` diemulasi
 * driver (XOR saat flush), dan kecerahan/backlight hanya benar-benar dikirim
 * bila `backlightPath` (atau env `TSIX_TFT_BL`) diisi eksplisit — tanpa itu
 * statusnya disimpan tapi hardware tidak disentuh.
 *
 * (c) 2026 TSIX Project
 */

import { IDevice, KContext } from "../IDevice";
import * as fs from "fs";
import * as path from "path";
import {
  asBuffer,
  bool,
  boolFrom,
  num,
  positional,
  toByteBuffer,
} from "./LM6029Device";
import { LCD_GFX_FONTS, type LcdGfxFont } from "./lcdFonts";
import { LCD_CLASSIC_FONTS, type LcdClassicFont } from "./lcdFontClassic";
import { PLCD_FONT_H, PLCD_FONT_W, plcdGlyph, rowsToGlyph } from "./plcdFont5x7";

// ================================================================
// GEOMETRI PANEL
// ================================================================

/** Lebar panel dalam piksel (landscape / rotation 0). */
export const TFT_WIDTH = 320;
/** Tinggi panel dalam piksel (landscape / rotation 0). */
export const TFT_HEIGHT = 240;
/** Kedalaman warna: RGB565. */
export const TFT_BPP = 16;
/** Byte per baris scanline (stride): 320 * 2 = 640 byte. */
export const TFT_STRIDE = TFT_WIDTH * (TFT_BPP / 8);
/** Ukuran satu frame penuh: 640 * 240 = 153600 byte. */
export const TFT_FRAMEBUFFER_SIZE = TFT_STRIDE * TFT_HEIGHT;

/** Path framebuffer default (Raspberry Pi: fb0 = HDMI, fb1 = TFT fbtft). */
export const TFT_DEFAULT_FB_DEVICE = "/dev/fb1";

/**
 * Env untuk memaksa path framebuffer host, mis.
 * `TSIX_TFT_FB=/dev/fb2` (dipakai kalau auto-deteksi salah pilih).
 */
export const TFT_FB_ENV = "TSIX_TFT_FB";

/** Env untuk path sysfs kecerahan/backlight TFT (opsional). */
export const TFT_BACKLIGHT_ENV = "TSIX_TFT_BL";

// ================================================================
// WARNA (RGB565)
// ================================================================

/** Clamp ke 0..255 (nilai aneh/NaN → 0). */
function clamp255(v: any): number {
  const n = Math.floor(num(v));
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

/**
 * Komponen 8-bit → RGB565 (format buffer /dev/fbN).
 * Satu argumen = grayscale: `rgb565(0x1f)`.
 */
export function rgb565(r: number, g?: number, b?: number): number {
  const R = clamp255(r);
  const G = clamp255(g === undefined ? r : g);
  const B = clamp255(b === undefined ? r : b);
  return ((R & 0xf8) << 8) | ((G & 0xfc) << 3) | (B >> 3);
}

/** "#00fff2" / 0x00fff2 → RGB565 (24-bit dipotong ke presisi panel). */
export function hex565(hex: number | string): number {
  let v: number;
  if (typeof hex === "string") {
    const clean = hex.trim().replace(/^#/, "").replace(/^0x/i, "");
    // Hanya terima hex murni: parseInt() longgar ("bukan-warna" → 0xb = 11).
    if (!/^[0-9a-f]{1,6}$/i.test(clean)) return 0;
    v = Number.parseInt(clean, 16);
  } else {
    v = Number(hex);
  }
  if (!Number.isFinite(v)) return 0;
  return rgb565((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
}

/** RGB565 → komponen 8-bit (dipakai GET_PIXEL & uji). */
export function unpack565(c: number): { r: number; g: number; b: number } {
  const v = num(c) & 0xffff;
  const r = (v >> 11) & 0x1f;
  const g = (v >> 5) & 0x3f;
  const b = v & 0x1f;
  // Replikasi bit atas supaya 31 → 255 (pembulatan ke atas seperti panel).
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
  CYAN_NEON: rgb565(0, 255, 242),
  PANEL_BG: rgb565(10, 10, 18),
} as const;

// ================================================================
// PANEL HOST (framebuffer Linux) — bisa disuntik untuk test
// ================================================================

/** Ringkasan `/sys/class/graphics/fbN` (diagnostik, isi GET_INFO). */
export interface FbVarInfo {
  /** Path node, mis. "/dev/fb1". */
  device: string;
  /** Nama driver fbdev, mis. "fb_ili9341" (null bila sysfs tidak terbaca). */
  name: string | null;
  /** Resolusi fisik dari `virtual_size`, mis. { w: 320, h: 240 }. */
  virtualSize: { w: number; h: number } | null;
  /** Bit per piksel dari sysfs (harus 16 untuk panel ini). */
  bpp: number | null;
  /** Stride byte per baris dari sysfs (harus 640). */
  stride: number | null;
  /**
   * Kecerahan 0..255 — hanya ada kalau `backlightPath` diisi eksplisit
   * (TFT tidak punya register kontras; fbdev tidak mengekspos backlight).
   */
  brightness: number | null;
}

/**
 * Kontrak panel host — implementasi produksi `FbDevPanel` (fs + sysfs),
 * implementasi uji: objek tiruan (menangkap buffer frame, tidak menyentuh
 * /dev sama sekali).
 */
export interface TftPanelHandle {
  /** Buka node framebuffer (idempoten; gagal → false, boleh dicoba lagi). */
  begin(devicePath?: string): boolean;
  /** Kirim satu frame penuh (TFT_FRAMEBUFFER_SIZE byte, RGB565 LE). */
  present(frame: Buffer): void;
  /** Nyalakan/matikan backlight → status yang berlaku. */
  setBacklight?(on: boolean): boolean;
  /** Status backlight terakhir. */
  getBacklight?(): boolean;
  /** Kecerahan 0..255 → nilai yang benar-benar dipakai. */
  setBrightness?(level: number): number;
  /** Kecerahan sekarang (null bila tidak diketahui). */
  getBrightness?(): number | null;
  /** Blank/unblank panel (emulasi DISPLAY_ON). */
  setDisplayOn?(on: boolean): boolean;
  /** Path framebuffer yang sedang dipakai (null bila belum terbuka). */
  getDevicePath?(): string | null;
  /** Ringkasan sysfs (null bila belum terbuka / tanpa sysfs). */
  getFbVar?(): FbVarInfo | null;
  /** Tutup node (dipakai saat pindah device). */
  close?(): void;
}

export interface FbDevPanelOptions {
  /** Path eksplisit (menang atas auto-deteksi). */
  device?: string;
  /** Path sysfs kecerahan, mis. `/sys/class/backlight/<dev>/brightness`. */
  backlightPath?: string;
  /** Resolusi yang diharapkan untuk auto-deteksi (default 320x240). */
  width?: number;
  height?: number;
}

/** Baca satu atribut sysfs fbdev (null kalau tidak ada / tidak terbaca). */
function readSysfs(dir: string, file: string): string | null {
  try {
    return fs.readFileSync(path.join(dir, file), "utf8").trim();
  } catch (_) {
    return null;
  }
}

/** Nomor fb dari path "/dev/fb1" (null bila bukan pola fbN). */
function fbIndex(device: string): number | null {
  const m = /^\/dev\/fb(\d+)$/.exec(device);
  return m ? Number(m[1]) : null;
}

/** Baca ringkasan /sys/class/graphics/fbN untuk node tertentu. */
export function readFbVar(device: string): FbVarInfo {
  const info: FbVarInfo = {
    device,
    name: null,
    virtualSize: null,
    bpp: null,
    stride: null,
    brightness: null,
  };
  const idx = fbIndex(device);
  if (idx === null) return info;
  const dir = `/sys/class/graphics/fb${idx}`;
  info.name = readSysfs(dir, "name");
  const bpp = readSysfs(dir, "bits_per_pixel");
  info.bpp = bpp === null ? null : Number(bpp);
  const stride = readSysfs(dir, "stride");
  info.stride = stride === null ? null : Number(stride);
  const vs = readSysfs(dir, "virtual_size");
  if (vs) {
    const [w, h] = vs.split(",").map((s) => Number(s.trim()));
    if (Number.isFinite(w) && Number.isFinite(h)) info.virtualSize = { w, h };
  }
  return info;
}

/**
 * Auto-deteksi node framebuffer TFT — urut dari yang paling meyakinkan:
 *   3. nama driver sysfs menyebut `ili9341`
 *   2. resolusi `virtual_size` cocok dengan geometri panel
 *   1. 16 bpp (memang format RGB565, walau ukurannya beda)
 * Node yang tidak lolos ketiganya (mis. HDMI 24/32 bpp) dilewati, dan
 * `/dev/fb0` tidak pernah ikut dipindai (di Raspberry Pi itu HDMI).
 */
export function detectFbDevices(
  width = TFT_WIDTH,
  height = TFT_HEIGHT,
): string[] {
  const hits: Array<{ device: string; rank: number }> = [];
  for (let i = 1; i <= 9; i++) {
    const device = `/dev/fb${i}`;
    try {
      if (!fs.existsSync(device)) continue;
    } catch (_) {
      continue;
    }
    const v = readFbVar(device);
    let rank = 0;
    if (v.name && /ili9341/i.test(v.name)) rank = 3;
    else if (
      v.virtualSize &&
      ((v.virtualSize.w === width && v.virtualSize.h === height) ||
        (v.virtualSize.w === height && v.virtualSize.h === width))
    )
      rank = 2;
    else if (v.bpp === TFT_BPP) rank = 1;
    if (rank > 0) hits.push({ device, rank });
  }
  return hits
    .sort((a, b) => b.rank - a.rank || a.device.localeCompare(b.device))
    .map((h) => h.device);
}

/**
 * FbDevPanel — implementasi produksi: buka /dev/fbN dengan `fs`, kirim frame
 * dengan satu `writeSync` (persis pola skrip Node di host), dan pakai sysfs
 * untuk kecerahan/blank bila tersedia.
 */
export class FbDevPanel implements TftPanelHandle {
  private fd: number | null = null;
  private device: string | null = null;
  private varInfo: FbVarInfo | null = null;
  private backlight = true;
  private brightness = 255;
  private displayOn = true;
  private blPath: string | null;

  constructor(private options: FbDevPanelOptions = {}) {
    this.blPath = options.backlightPath || null;
  }

  /** Path sysfs blank milik node aktif (null bila tidak ada). */
  private blankPath(): string | null {
    const idx = this.device ? fbIndex(this.device) : null;
    if (idx === null) return null;
    const p = `/sys/class/graphics/fb${idx}/blank`;
    try {
      return fs.existsSync(p) ? p : null;
    } catch (_) {
      return null;
    }
  }

  public begin(devicePath?: string): boolean {
    if (this.fd !== null) return true;

    const forced = this.options.device || devicePath;
    const fromEnv = process.env[TFT_FB_ENV];
    const target = (forced || fromEnv || "").trim();

    const candidates = target ? [target] : detectFbDevices(this.options.width ?? TFT_WIDTH, this.options.height ?? TFT_HEIGHT);
    if (!candidates.length) return false;

    for (const cand of candidates) {
      try {
        // "w" sama seperti skrip host (fbdev tidak punya konsep truncate).
        this.fd = fs.openSync(cand, "w");
        this.device = cand;
        this.varInfo = readFbVar(cand);
        return true;
      } catch (_) {
        this.fd = null;
      }
    }
    return false;
  }

  public getDevicePath(): string | null {
    return this.device;
  }

  public getFbVar(): FbVarInfo | null {
    if (!this.varInfo) return null;
    return { ...this.varInfo, brightness: this.blPath ? this.brightness : null };
  }

  /** Kirim frame penuh ke node framebuffer (1 syscall write). */
  public present(frame: Buffer): void {
    const fd = this.fd;
    if (fd === null) return;
    fs.writeSync(fd, frame, 0, frame.length, 0);
  }

  public setBacklight(on: boolean): boolean {
    this.backlight = !!on;
    if (this.blPath) {
      try {
        // sysfs backlight: 0 = mati, selainnya kecerahan aktif.
        fs.writeFileSync(this.blPath, String(this.backlight ? this.brightness || 255 : 0));
      } catch (_) {
        /* sysfs read-only / hilang → cukup simpan status */
      }
    }
    return this.backlight;
  }

  public getBacklight(): boolean {
    return this.backlight;
  }

  public setBrightness(level: number): number {
    const lvl = Math.max(0, Math.min(255, Math.floor(num(level))));
    this.brightness = lvl;
    if (this.blPath && this.backlight) {
      try {
        fs.writeFileSync(this.blPath, String(lvl));
      } catch (_) {
        /* diabaikan — lihat catatan getFbVar() */
      }
    }
    return lvl;
  }

  public getBrightness(): number | null {
    return this.blPath ? this.brightness : null;
  }

  /** Blank/unblank lewat /sys/class/graphics/fbN/blank (bila ada). */
  public setDisplayOn(on: boolean): boolean {
    this.displayOn = !!on;
    const p = this.blankPath();
    if (p) {
      try {
        // 0 = unblank, 1 = normal blank (FB_BLANK_NORMAL).
        fs.writeFileSync(p, on ? "0" : "1");
      } catch (_) {
        /* tidak fatal: status tetap dipegang driver */
      }
    }
    return this.displayOn;
  }

  public close(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch (_) {
        /* abaikan */
      }
      this.fd = null;
    }
    this.device = null;
  }
}

// ================================================================
// IOCTL (namespace 0x54 = 'T', unik antar driver: LCD 0x4C, joy 0x4A)
// ================================================================

export enum TFTIOCTL {
  // ── Lifecycle ──
  /** arg: null → boolean (buka /dev/fbN + siapkan back-buffer) */
  BEGIN = 0x5401,
  /** arg: null → true (isi hitam + flush) */
  RESET = 0x5402,
  /** arg: null → true (kosongkan back-buffer, belum dikirim ke panel) */
  CLEAR = 0x5403,
  /** arg: null → true (kirim back-buffer → /dev/fbN) */
  DISPLAY = 0x5404,

  // ── Pixel & primitive GFX ──
  /** arg: { x, y, color=0xffff } → true */
  DRAW_PIXEL = 0x5410,
  /** arg: { color=0 } | number → true */
  FILL_SCREEN = 0x5411,
  /** arg: { x0, y0, x1, y1, color=0xffff } → true */
  DRAW_LINE = 0x5412,
  /** arg: { x, y, w, h, color=0xffff } → true */
  DRAW_RECT = 0x5413,
  /** arg: { x, y, w, h, color=0xffff } → true */
  FILL_RECT = 0x5414,
  /** arg: { x, y, r, color=0xffff } → true */
  DRAW_CIRCLE = 0x5415,
  /** arg: { x, y, r, color=0xffff } → true */
  FILL_CIRCLE = 0x5416,
  /** arg: { x0, y0, x1, y1, x2, y2, color=0xffff } → true */
  DRAW_TRIANGLE = 0x5417,
  /** arg: { x0, y0, x1, y1, x2, y2, color=0xffff } → true */
  FILL_TRIANGLE = 0x5418,
  /** arg: { x, y, w, h, r, color=0xffff } → true */
  DRAW_ROUND_RECT = 0x5419,
  /** arg: { x, y, w, h, r, color=0xffff } → true */
  FILL_ROUND_RECT = 0x541a,
  /**
   * arg: { x, y, data: Buffer, w, h, color=0xffff } → true.
   * Data 1 bpp MSB-first (λ = w*h*2 byte) atau RGB565 mentah (λ = w*h*2).
   */
  DRAW_BITMAP = 0x541b,
  /** arg: { x, y } | null → RGB565 piksel di ruang LOGIKA, null bila di luar. */
  GET_PIXEL = 0x541c,

  // ── Teks ──
  /** arg: { id } | number → id (0 = glcdfont 5x7, 1..3 = font GFX) */
  SET_FONT = 0x5420,
  /** arg: { color, bg? } → true (bg null/undefined = transparan) */
  SET_TEXT_COLOR = 0x5421,
  /** arg: { size } | number → true */
  SET_TEXT_SIZE = 0x5422,
  /** arg: boolean → true */
  SET_TEXT_WRAP = 0x5423,
  /** arg: { x, y } → true */
  SET_CURSOR = 0x5424,
  /** arg: { text } | string → true (flush bila autoFlush ON) */
  PRINT = 0x5425,
  /** arg: { text, x, y, size=1 } → true (flush bila autoFlush ON) */
  PRINT_TEXT = 0x5426,
  /** arg: { rotation } | number → rotation 0..3 */
  SET_ROTATION = 0x5427,

  // ── Kontrol tampilan ──
  /** arg: boolean | { on } → boolean (butuh backlightPath agar nyata) */
  SET_BACKLIGHT = 0x5430,
  /** arg: null → boolean */
  GET_BACKLIGHT = 0x5431,
  /** arg: boolean | { on } → boolean (blank/unblank via sysfs bila ada) */
  SET_DISPLAY_ON = 0x5432,
  /** arg: null → boolean */
  IS_DISPLAY_ON = 0x5433,
  /** arg: boolean | { invert } → boolean (emulasi XOR saat flush) */
  SET_INVERT = 0x5434,
  /** arg: null → boolean */
  GET_INVERT = 0x5435,
  /** arg: { level } | number (0..255) → level terpakai */
  SET_BRIGHTNESS = 0x5436,
  /** arg: null → number | null (null = tidak ada backlight sysfs) */
  GET_BRIGHTNESS = 0x5437,
  /** arg: { path } | string → path (pindah node framebuffer, re-open) */
  SET_FB_DEVICE = 0x5438,
  /** arg: null → string | null */
  GET_FB_DEVICE = 0x5439,

  // ── Info & tuning ──
  /** arg: null → { device, available, width, height, ... } */
  GET_INFO = 0x5440,
  /** arg: null → number (lebar logika, ikut rotation) */
  GET_WIDTH = 0x5441,
  /** arg: null → number (tinggi logika, ikut rotation) */
  GET_HEIGHT = 0x5442,
  /** arg: boolean → boolean (write() auto-flush) */
  SET_AUTO_FLUSH = 0x5443,
  /** arg: null → boolean */
  GET_AUTO_FLUSH = 0x5444,
  /** arg: null → number (ukuran frame penuh: 153600) */
  GET_FRAMEBUFFER_SIZE = 0x5445,
  /** arg: null → number (byte per baris: 640) */
  GET_STRIDE = 0x5446,
}

/** Nama op yang diterima lewat `write({ op, args })`. */
const WRITE_OPS = new Set([
  "clear",
  "clearDisplay",
  "display",
  "flush",
  "fillScreen",
  "drawPixel",
  "drawLine",
  "drawRect",
  "fillRect",
  "drawCircle",
  "fillCircle",
  "drawTriangle",
  "fillTriangle",
  "drawRoundRect",
  "fillRoundRect",
  "drawBitmap",
  "setFont",
  "setTextColor",
  "setTextSize",
  "setTextWrap",
  "setCursor",
  "print",
  "printText",
  "setRotation",
  "setBacklight",
  "setBrightness",
  "setDisplayInvert",
  "setDisplayOn",
]);

// ================================================================
// OPSI DRIVER
// ================================================================

export interface ILI9341Options {
  /** Nama node di /dev (default: "tft"). */
  name?: string;
  /**
   * Path framebuffer host, mis. "/dev/fb1". Kosong = env `TSIX_TFT_FB` lalu
   * auto-deteksi (lihat `detectFbDevices`).
   */
  fbDevice?: string;
  /**
   * Path sysfs kecerahan (opsional), mis.
   * `/sys/class/backlight/rpi_backlight/brightness`. Kosong = env
   * `TSIX_TFT_BL`, kalau tidak ada juga → SET_BACKLIGHT/SET_BRIGHTNESS hanya
   * menyimpan status (tidak menyentuh hardware); TFT lewat fbtft memang tidak
   * mengekspos backlight sendiri.
   */
  backlightPath?: string;
  /** Rotasi awal 0..3 (default: 0 = 320x240 landscape). */
  rotation?: number;
  /** Warna latar awal saat buffer dibuat (default: hitam). */
  background?: number;
  /** Inversi tampilan awal (default: false). */
  invert?: boolean;
  /** Backlight awal (default: true). */
  backlight?: boolean;
  /** Kecerahan awal 0..255 (default: 255). */
  brightness?: number;
  /** Display ON awal (default: true). */
  displayOn?: boolean;
  /** write() otomatis flush ke panel (default: true). */
  autoFlush?: boolean;
  /** Font awal: 0 = glcdfont 5x7, 1..3 = Adafruit GFX (default: 0). */
  font?: number;
  /** Warna teks awal (default: putih). */
  textColor?: number;
  /** Warna latar teks awal (null/undefined = transparan). */
  textBg?: number | null;
  /** Ukuran teks awal (default: 1). */
  textSize?: number;
  /** Nonaktifkan driver (tidak dibuka saat boot). */
  disabled?: boolean;
  /** Panel siap pakai — untuk embedding / unit test (melewati fs). */
  native?: TftPanelHandle;
}

// ================================================================
// HELPER FONT (cache bitmap base64)
// ================================================================

/** Glyph pengganti untuk karakter yang belum ada di tabel font ekstensi. */
const FALLBACK_GLYPH = rowsToGlyph("#####/#...#/#...#/#...#/#...#/#...#/#####");

/** Cache bitmap font GFX: id font → byte (decode base64 sekali saja). */
const _gfxBitmapCache = new Map<number, Uint8Array>();

/** Cache bitmap font klasik 5x8: id font → byte. */
const _classicBitmapCache = new Map<number, Uint8Array>();

/** Decode base64 → bytes dengan cache per-id (null kalau data rusak). */
function cachedBitmaps(
  cache: Map<number, Uint8Array>,
  id: number,
  b64: string,
): Uint8Array | null {
  const hit = cache.get(id);
  if (hit) return hit;
  try {
    const bytes = new Uint8Array(Buffer.from(b64, "base64"));
    if (!bytes.length) return null;
    cache.set(id, bytes);
    return bytes;
  } catch (_) {
    return null;
  }
}

// ================================================================
// DRIVER
// ================================================================

export class ILI9341Device implements IDevice {
  public name: string;
  public uid = 0;
  public gid = 0;
  /** Default 0666 — display bersama, semua user boleh menggambar. */
  public mode = 0o666;
  public disabled: boolean;

  private kctx: KContext | null = null;
  private panel: TftPanelHandle | null = null;
  private injected: TftPanelHandle | null;
  private panelOptions: FbDevPanelOptions;

  private initialized = false;
  private autoFlush: boolean;

  // Geometri & status tampilan
  private rotation = 0;
  private invert = false;
  private displayOn = true;
  private backlight = true;
  private brightness = 255;

  // Teks
  private fontId = 0;
  private textColor: number = TFT_COLOR.WHITE;
  private textBg: number | null = null;
  private textSize = 1;
  private textWrap = true;
  private cursorX = 0;
  private cursorY = 0;

  // Statistik
  private readRefs = 0;
  private writeRefs = 0;
  private frames = 0;
  private lastError: string | null = null;

  // Back-buffer RGB565 (satu ArrayBuffer, dua view: piksel & byte)
  private readonly ab = new ArrayBuffer(TFT_FRAMEBUFFER_SIZE);
  private readonly fb: Uint16Array;
  private readonly bytes: Buffer;
  /** Buffer bantu untuk emulasi invert (dialokasikan saat dibutuhkan). */
  private invertScratch: Uint16Array | null = null;
  private invertScratchBytes: Buffer | null = null;

  constructor(options: ILI9341Options = {}) {
    this.name = options.name || "tft";
    this.disabled = options.disabled === true;
    this.injected = options.native || null;
    this.panelOptions = {
      device: options.fbDevice,
      backlightPath: options.backlightPath || process.env[TFT_BACKLIGHT_ENV],
    };
    this.autoFlush = options.autoFlush !== false;
    this.rotation = ((Math.floor(num(options.rotation)) % 4) + 4) % 4;
    this.invert = options.invert === true;
    this.backlight = options.backlight !== false;
    this.brightness = Math.max(0, Math.min(255, num(options.brightness ?? 255)));
    this.displayOn = options.displayOn !== false;
    this.fontId = num(options.font);
    this.textColor = options.textColor === undefined ? TFT_COLOR.WHITE : num(options.textColor) & 0xffff;
    this.textBg = options.textBg === undefined || options.textBg === null ? null : num(options.textBg) & 0xffff;
    this.textSize = Math.max(1, Math.floor(num(options.textSize) || 1));

    this.fb = new Uint16Array(this.ab);
    this.bytes = Buffer.from(this.ab);
    this.fb.fill(num(options.background) & 0xffff);
  }

  // ================================================================
  // LIFECYCLE (IDevice)
  // ================================================================

  /** Dipanggil Kernel saat boot — coba buka framebuffer TFT. */
  public init(ctx: KContext): void {
    this.kctx = ctx;
    if (this.disabled) {
      this.log("Driver dinonaktifkan (disabled=true), dilewati.");
      return;
    }

    if (this.open()) {
      const v = this.panel?.getFbVar?.() ?? null;
      this.log(
        `ILI9341 siap: ${TFT_WIDTH}x${TFT_HEIGHT} RGB565 di /dev/${this.name}` +
          ` → ${this.panel?.getDevicePath?.() ?? "(?)"}` +
          (v?.name ? ` [${v.name}]` : "") +
          ` (${TFT_FRAMEBUFFER_SIZE} byte/frame, stride ${TFT_STRIDE})`,
      );
    } else {
      this.log(
        "ILI9341 tidak terdeteksi: " +
          (this.lastError ??
            `tidak ada /dev/fbN ${TFT_BPP} bpp yang cocok. Set ${TFT_FB_ENV}=/dev/fbX kalau node-nya bukan /dev/fb1.`) +
          " Node /dev disembunyikan dari `ls /dev`.",
      );
    }
  }

  /**
   * open(): lazy-open — buka node framebuffer + terapkan konfigurasi awal.
   * Aman dipanggil berulang; gagal → bisa dicoba lagi (mis. dopo `modprobe`).
   */
  public open(): boolean {
    if (this.initialized) return true;

    const panel = this.getPanel();
    if (!panel) {
      this.fail("open", new Error("Panel framebuffer tidak tersedia."));
      return false;
    }

    try {
      if (!panel.begin(this.panelOptions.device)) {
        this.lastError =
          `begin() gagal membuka node framebuffer ` +
          `(dicoba: ${this.panelOptions.device || process.env[TFT_FB_ENV] || "auto-detect /dev/fb1../dev/fb9"})`;
        return false;
      }

      // Tolak node yang jelas bukan panel ini. Tanpa cek ini, buffer
      // 320x240 RGB565 bisa ditulis ke framebuffer lain (mis. HDMI
      // 1920x1080 @32 bpp) dan hasilnya layar rusak tanpa pesan jelas.
      const bad = this.validateFb(panel.getFbVar?.() ?? null);
      if (bad) {
        panel.close?.();
        this.lastError = `node framebuffer tidak cocok: ${bad}`;
        return false;
      }

      // Konfigurasi awal — hanya sekali, saat begin sukses pertama.
      panel.setBrightness?.(this.brightness);
      panel.setBacklight?.(this.backlight);
      panel.setDisplayOn?.(this.displayOn);

      this.initialized = true;
      this.lastError = null;
      return true;
    } catch (e: any) {
      this.fail("open", e);
      return false;
    }
  }

  /**
   * close(): handle framebuffer SENGAJA dipertahankan supaya close/open
   * berulang (refcount FD dari kernel) tidak menghapus isi layar dan tidak
   * perlu re-open node. Pindah node: pakai TFTIOCTL.SET_FB_DEVICE.
   */
  public close(): boolean {
    this.log("Device ditutup (handle framebuffer dipertahankan).");
    return true;
  }

  /** present() → true hanya saat node framebuffer benar-benar terbuka. */
  public present(): boolean {
    return this.initialized && !this.disabled;
  }

  // ================================================================
  // I/O (IDevice)
  // ================================================================

  /** read() → snapshot status sebagai JSON string. */
  public read(): any {
    return JSON.stringify(this.getInfo());
  }

  /**
   * write(): terima Buffer (frame / potongannya), string (teks), atau
   * objek { op, args }. Auto-flush bila autoFlush ON (default).
   *
   * Buffer disalin ke back-buffer pada byte ke-`offset` (default 0) — jadi
   * `write(frame153600)` = ganti seluruh layar, dan `write(baris640, 640)`
   * hanya menimpa baris kedua. Panjang yang melewati ujung frame ditolak.
   */
  public write(data: any, offset?: number): boolean {
    if (!this.initialized || !this.panel) return false;

    try {
      const raw = toByteBuffer(data);
      if (raw) {
        const at = Math.max(0, Math.floor(num(offset)));
        if (at + raw.length > TFT_FRAMEBUFFER_SIZE) {
          this.fail(
            "write",
            new Error(
              `Blok ${raw.length} byte @${at} melewati frame ` +
                `(${TFT_FRAMEBUFFER_SIZE} byte).`,
            ),
          );
          return false;
        }
        raw.copy(this.bytes, at);
        if (this.autoFlush) this.flush();
        return true;
      }

      if (typeof data === "string") {
        this.print(data);
        if (this.autoFlush) this.flush();
        return true;
      }

      if (data && typeof data === "object" && typeof data.op === "string") {
        const args = Array.isArray(data.args) ? data.args : [];
        this.applyOp(data.op, args);
        if (this.autoFlush && data.op !== "display" && data.op !== "flush")
          this.flush();
        return true;
      }

      return false;
    } catch (e: any) {
      this.fail("write", e);
      return false;
    }
  }

  /** ioctl(): kontrol lengkap panel + kompatibilitas refcount FD kernel. */
  public ioctl(cmd: number, arg: any): any {
    // Refcount FD dari kernel (open/close) — bukan perintah hardware.
    switch (cmd) {
      case 10:
        this.readRefs++;
        return 0;
      case 11:
        this.readRefs = Math.max(0, this.readRefs - 1);
        return 0;
      case 20:
        this.writeRefs++;
        return 0;
      case 21:
        this.writeRefs = Math.max(0, this.writeRefs - 1);
        return 0;
    }

    // BEGIN boleh kapan saja untuk mencoba menghidupkan node framebuffer.
    if (cmd === TFTIOCTL.BEGIN) return this.open();

    if (!this.initialized || !this.panel) {
      // Selalu kembalikan nilai (bukan undefined) agar userland tidak crash.
      return null;
    }

    try {
      switch (cmd) {
        // ── Lifecycle ──
        case TFTIOCTL.RESET: {
          const [color] = positional(arg, ["color"]);
          this.fb.fill(color === undefined ? TFT_COLOR.BLACK : this.color(color, TFT_COLOR.BLACK));
          this.flush();
          return true;
        }
        case TFTIOCTL.CLEAR: {
          const [color] = positional(arg, ["color"]);
          this.fb.fill(color === undefined ? TFT_COLOR.BLACK : this.color(color, TFT_COLOR.BLACK));
          return true;
        }
        case TFTIOCTL.DISPLAY:
          this.flush();
          return true;

        // ── Primitive GFX ──
        case TFTIOCTL.DRAW_PIXEL: {
          const [x, y, color] = positional(arg, ["x", "y", "color"]);
          this.setPixel(num(x), num(y), this.color(color, TFT_COLOR.WHITE));
          return true;
        }
        case TFTIOCTL.FILL_SCREEN: {
          const [color] = positional(arg, ["color"]);
          this.fb.fill(this.color(color, TFT_COLOR.BLACK));
          return true;
        }
        case TFTIOCTL.DRAW_LINE: {
          const [x0, y0, x1, y1, color] = positional(arg, ["x0", "y0", "x1", "y1", "color"]);
          this.line(num(x0), num(y0), num(x1), num(y1), this.color(color, TFT_COLOR.WHITE));
          return true;
        }
        case TFTIOCTL.DRAW_RECT:
        case TFTIOCTL.FILL_RECT: {
          const [x, y, w, h, color] = positional(arg, ["x", "y", "w", "h", "color"]);
          const c = this.color(color, TFT_COLOR.WHITE);
          const fn = cmd === TFTIOCTL.DRAW_RECT ? this.rect : this.fillRect;
          fn.call(this, num(x), num(y), num(w), num(h), c);
          return true;
        }
        case TFTIOCTL.DRAW_CIRCLE:
        case TFTIOCTL.FILL_CIRCLE: {
          const [x, y, r, color] = positional(arg, ["x", "y", "r", "color"]);
          const c = this.color(color, TFT_COLOR.WHITE);
          const fn = cmd === TFTIOCTL.DRAW_CIRCLE ? this.circle : this.fillCircle;
          fn.call(this, num(x), num(y), num(r), c);
          return true;
        }
        case TFTIOCTL.DRAW_TRIANGLE:
        case TFTIOCTL.FILL_TRIANGLE: {
          const [x0, y0, x1, y1, x2, y2, color] = positional(arg, [
            "x0", "y0", "x1", "y1", "x2", "y2", "color",
          ]);
          const c = this.color(color, TFT_COLOR.WHITE);
          const fn = cmd === TFTIOCTL.DRAW_TRIANGLE ? this.triangle : this.fillTriangle;
          fn.call(this, num(x0), num(y0), num(x1), num(y1), num(x2), num(y2), c);
          return true;
        }
        case TFTIOCTL.DRAW_ROUND_RECT:
        case TFTIOCTL.FILL_ROUND_RECT: {
          const [x, y, w, h, r, color] = positional(arg, ["x", "y", "w", "h", "r", "color"]);
          const c = this.color(color, TFT_COLOR.WHITE);
          const fn = cmd === TFTIOCTL.DRAW_ROUND_RECT ? this.roundRect : this.fillRoundRect;
          fn.call(this, num(x), num(y), num(w), num(h), num(r), c);
          return true;
        }
        case TFTIOCTL.DRAW_BITMAP: {
          const [x, y, data, w, h, color] = positional(arg, ["x", "y", "data", "w", "h", "color"]);
          const buf = asBuffer(data);
          const iw = num(w);
          const ih = num(h);
          const c = this.color(color, TFT_COLOR.WHITE);
          if (buf.length >= iw * ih * 2) this.drawRgb565Bitmap(num(x), num(y), buf, iw, ih);
          else this.drawMonoBitmap(num(x), num(y), buf, iw, ih, c);
          return true;
        }
        case TFTIOCTL.GET_PIXEL: {
          const [x, y] = positional(arg, ["x", "y"]);
          return this.getPixel(num(x), num(y));
        }

        // ── Teks ──
        case TFTIOCTL.SET_FONT: {
          const [id] = positional(arg, ["id"]);
          this.fontId = num(id);
          return this.fontId;
        }
        case TFTIOCTL.SET_TEXT_COLOR: {
          const [color, bg] = positional(arg, ["color", "bg"]);
          this.textColor = this.color(color, TFT_COLOR.WHITE);
          this.textBg = bg === undefined || bg === null ? null : this.color(bg, TFT_COLOR.BLACK);
          return true;
        }
        case TFTIOCTL.SET_TEXT_SIZE: {
          const [size] = positional(arg, ["size"]);
          this.textSize = Math.max(1, Math.floor(num(size) || 1));
          return true;
        }
        case TFTIOCTL.SET_TEXT_WRAP:
          this.textWrap = boolFrom(arg, ["wrap"]);
          return true;
        case TFTIOCTL.SET_CURSOR: {
          const [x, y] = positional(arg, ["x", "y"]);
          this.cursorX = Math.floor(num(x));
          this.cursorY = Math.floor(num(y));
          return true;
        }
        case TFTIOCTL.PRINT: {
          const [text] = positional(arg, ["text"]);
          this.print(String(text ?? ""));
          if (this.autoFlush) this.flush();
          return true;
        }
        case TFTIOCTL.PRINT_TEXT: {
          const [text, x, y, size] = positional(arg, ["text", "x", "y", "size"]);
          this.printText(
            String(text ?? ""),
            num(x),
            num(y),
            size === undefined ? 1 : num(size),
          );
          if (this.autoFlush) this.flush();
          return true;
        }
        case TFTIOCTL.SET_ROTATION: {
          const [rotation] = positional(arg, ["rotation"]);
          this.rotation = ((Math.floor(num(rotation)) % 4) + 4) % 4;
          return this.rotation;
        }

        // ── Kontrol tampilan ──
        case TFTIOCTL.SET_BACKLIGHT: {
          const on = boolFrom(arg, ["on", "value"]);
          this.backlight = this.panel.setBacklight ? !!this.panel.setBacklight(on) : on;
          return this.backlight;
        }
        case TFTIOCTL.GET_BACKLIGHT:
          return this.panel.getBacklight ? !!this.panel.getBacklight() : this.backlight;
        case TFTIOCTL.SET_DISPLAY_ON: {
          const on = boolFrom(arg, ["on", "value"]);
          this.displayOn = this.panel.setDisplayOn ? !!this.panel.setDisplayOn(on) : on;
          return this.displayOn;
        }
        case TFTIOCTL.IS_DISPLAY_ON:
          return this.displayOn;
        case TFTIOCTL.SET_INVERT: {
          this.invert = boolFrom(arg, ["invert", "on", "value"]);
          return this.invert;
        }
        case TFTIOCTL.GET_INVERT:
          return this.invert;
        case TFTIOCTL.SET_BRIGHTNESS: {
          const [level] = positional(arg, ["level"]);
          const lvl = Math.max(0, Math.min(255, Math.floor(num(level))));
          this.brightness = this.panel.setBrightness
            ? Math.max(0, Math.min(255, Math.floor(num(this.panel.setBrightness(lvl)))))
            : lvl;
          return this.brightness;
        }
        case TFTIOCTL.GET_BRIGHTNESS:
          return this.panel.getBrightness ? this.panel.getBrightness() : null;
        case TFTIOCTL.SET_FB_DEVICE: {
          const [p] = positional(arg, ["path", "device"]);
          const next = String(p ?? "").trim();
          if (!next) return this.getFbDevice();
          return this.setFbDevice(next);
        }
        case TFTIOCTL.GET_FB_DEVICE:
          return this.getFbDevice();

        // ── Info & tuning ──
        case TFTIOCTL.GET_INFO:
          return this.getInfo();
        case TFTIOCTL.GET_WIDTH:
          return this.logicalWidth();
        case TFTIOCTL.GET_HEIGHT:
          return this.logicalHeight();
        case TFTIOCTL.SET_AUTO_FLUSH:
          this.autoFlush = boolFrom(arg, ["on", "autoFlush", "value"]);
          return this.autoFlush;
        case TFTIOCTL.GET_AUTO_FLUSH:
          return this.autoFlush;
        case TFTIOCTL.GET_FRAMEBUFFER_SIZE:
          return TFT_FRAMEBUFFER_SIZE;
        case TFTIOCTL.GET_STRIDE:
          return TFT_STRIDE;

        default:
          return null;
      }
    } catch (e: any) {
      this.fail(`ioctl(0x${cmd.toString(16)})`, e);
      return null;
    }
  }

  // ================================================================
  // AUTO-REGISTER (dipanggil Kernel.loadAuxDevices)
  // ================================================================

  /**
   * STATIC AUTO-REGISTER METHOD
   * Mendaftarkan node /dev/tft. Kernel memanggil init() belakangan, jadi
   * framebuffer baru dibuka setelah semua driver terdaftar.
   */
  static autoRegister(kernel: any): void {
    try {
      if (!kernel || typeof kernel !== "object" || !kernel.devices) return;
      kernel.devices["tft"] = new ILI9341Device();
    } catch (e: any) {
      // Framebuffer tidak ada bukan error fatal — node cukup tidak terdaftar.
    }
  }

  // ================================================================
  // INFO
  // ================================================================

  /** Info status (dipakai read() & TFTIOCTL.GET_INFO). */
  public getInfo(): Record<string, any> {
    const alive = this.initialized && !!this.panel;
    const v = alive ? this.panel!.getFbVar?.() ?? null : null;
    return {
      device: `/dev/${this.name}`,
      available: alive,
      width: this.logicalWidth(),
      height: this.logicalHeight(),
      panelWidth: TFT_WIDTH,
      panelHeight: TFT_HEIGHT,
      bpp: TFT_BPP,
      stride: TFT_STRIDE,
      framebufferSize: TFT_FRAMEBUFFER_SIZE,
      /** Path framebuffer host, mis. "/dev/fb1" (null bila belum terbuka). */
      fbDevice: alive ? this.panel!.getDevicePath?.() ?? null : null,
      /** Nama driver fbdev dari sysfs, mis. "fb_ili9341". */
      fbName: v?.name ?? null,
      /** Resolusi fisik menurut sysfs (validasi cepat salah node). */
      fbVirtualSize: v?.virtualSize ?? null,
      rotation: this.rotation,
      invert: this.invert,
      displayOn: this.displayOn,
      backlight: alive
        ? this.panel!.getBacklight
          ? !!this.panel!.getBacklight()
          : this.backlight
        : null,
      brightness: alive && this.panel!.getBrightness ? this.panel!.getBrightness() : null,
      autoFlush: this.autoFlush,
      fontId: this.fontId,
      textColor: this.textColor,
      textBg: this.textBg,
      textSize: this.textSize,
      textWrap: this.textWrap,
      cursorX: this.cursorX,
      cursorY: this.cursorY,
      readRefs: this.readRefs,
      writeRefs: this.writeRefs,
      frames: this.frames,
      lastError: this.lastError,
    };
  }

  /** Path framebuffer aktif (null bila belum terbuka). */
  public getFbDevice(): string | null {
    return this.panel?.getDevicePath?.() ?? null;
  }

  /**
   * Pindah node framebuffer: tutup node lama, buka yang baru. Dipakai saat
   * auto-deteksi salah pilih (mis. `tft setDevice /dev/fb2`) — TIDAK
   * kehilangan isi back-buffer, jadi layar bisa langsung di-flush ulang.
   */
  public setFbDevice(devicePath: string): string | null {
    try {
      this.panel?.close?.();
    } catch (_) {
      /* abaikan */
    }
    this.panel = null;
    this.initialized = false;
    this.panelOptions = { ...this.panelOptions, device: devicePath };
    // Node yang dipilih eksplisit tetap divalidasi (lihat validateFb).
    const ok = this.open();
    return ok ? this.getFbDevice() : null;
  }

  // ================================================================
  // GEOMETRI & PIKEL
  // ================================================================

  /** Lebar LOGIKA (mengikuti rotation; 1/3 = portrait). */
  private logicalWidth(): number {
    return this.rotation % 2 === 1 ? TFT_HEIGHT : TFT_WIDTH;
  }

  /** Tinggi LOGIKA (mengikuti rotation; 1/3 = portrait). */
  private logicalHeight(): number {
    return this.rotation % 2 === 1 ? TFT_WIDTH : TFT_HEIGHT;
  }

  /**
   * Validasi node framebuffer terhadap geometri panel. Return alasan penolakan
   * (string) atau null kalau cocok/tak bisa diverifikasi.
   *
   * Yang diperiksa: 16 bpp, `virtual_size` **persis** 320x240, dan (bila ada)
   * `stride` = 640. Framebuffer portrait 240x320 juga ditolak: byte/frame-nya
   * kebetulan sama (153600), tapi stride-nya 480 sehingga layout piksel driver
   * ini akan meleset — panel portrait harus dikonfigurasi 320x240 di host
   * (mis. lewat `rotate` fbtft), bukan diterima apa adanya.
   *
   * sysfs bisa tidak ada (kernel tanpa CONFIG_FB_*_SYSFS, container, atau node
   * non-fbN) — di situ driver menerima apa adanya dan mengandalkan pemilihan
   * node yang benar (opsi `fbDevice` / env / auto-deteksi).
   */
  private validateFb(v: FbVarInfo | null): string | null {
    if (!v) return null;
    if (v.bpp !== null && v.bpp !== TFT_BPP)
      return `${v.device} ${v.bpp} bpp (butuh ${TFT_BPP} bpp RGB565)`;
    if (v.stride !== null && v.stride !== TFT_STRIDE)
      return `${v.device} stride ${v.stride} B (butuh ${TFT_STRIDE} B = ${TFT_WIDTH} px @ ${TFT_BPP} bpp)`;
    if (v.virtualSize) {
      const { w, h } = v.virtualSize;
      if (w !== TFT_WIDTH || h !== TFT_HEIGHT)
        return `${v.device} ${w}x${h} (butuh ${TFT_WIDTH}x${TFT_HEIGHT})`;
    }
    return null;
  }

  /** Normalisasi argumen warna: number | "#RRGGBB" | { r,g,b } | { hex }. */
  private color(v: any, fallback = 0): number {
    if (v === undefined || v === null) return fallback & 0xffff;
    if (typeof v === "string") return hex565(v);
    if (typeof v === "object") {
      if (typeof v.r === "number") return rgb565(num(v.r), num(v.g), num(v.b));
      if (typeof v.hex === "string" || typeof v.hex === "number") return hex565(v.hex);
      if (v.color !== undefined) return this.color(v.color, fallback);
      return fallback & 0xffff;
    }
    return num(v) & 0xffff;
  }

  /** Tulis piksel di ruang LOGIKA (rotasi ala Adafruit_GFX). */
  private setPixel(x: number, y: number, color: number): void {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.logicalWidth() || y >= this.logicalHeight())
      return;

    let px = x;
    let py = y;
    switch (this.rotation) {
      case 1:
        px = TFT_WIDTH - 1 - y;
        py = x;
        break;
      case 2:
        px = TFT_WIDTH - 1 - x;
        py = TFT_HEIGHT - 1 - y;
        break;
      case 3:
        px = y;
        py = TFT_HEIGHT - 1 - x;
        break;
    }
    if (px < 0 || px >= TFT_WIDTH || py < 0 || py >= TFT_HEIGHT) return;
    this.fb[py * TFT_WIDTH + px] = color & 0xffff;
  }

  /** Baca piksel di ruang LOGIKA (null bila di luar layar). */
  private getPixel(x: number, y: number): number | null {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.logicalWidth() || y >= this.logicalHeight())
      return null;
    let px = x;
    let py = y;
    switch (this.rotation) {
      case 1:
        px = TFT_WIDTH - 1 - y;
        py = x;
        break;
      case 2:
        px = TFT_WIDTH - 1 - x;
        py = TFT_HEIGHT - 1 - y;
        break;
      case 3:
        px = y;
        py = TFT_HEIGHT - 1 - x;
        break;
    }
    if (px < 0 || px >= TFT_WIDTH || py < 0 || py >= TFT_HEIGHT) return null;
    return this.fb[py * TFT_WIDTH + px];
  }

  // ================================================================
  // PRIMITIVE GFX (software rasterizer, rotation-aware)
  // ================================================================

  private hLine(x: number, y: number, w: number, color: number): void {
    for (let i = 0; i < w; i++) this.setPixel(x + i, y, color);
  }

  private vLine(x: number, y: number, h: number, color: number): void {
    for (let i = 0; i < h; i++) this.setPixel(x, y + i, color);
  }

  /** Garis Bresenham (midpoint) — sama seperti LcdFramebuffer userland. */
  private line(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: number,
  ): void {
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
  }

  private rect(x: number, y: number, w: number, h: number, color: number): void {
    if (w <= 0 || h <= 0) return;
    if (w === 1) return this.vLine(x, y, h, color);
    if (h === 1) return this.hLine(x, y, w, color);
    this.hLine(x, y, w, color);
    this.hLine(x, y + h - 1, w, color);
    this.vLine(x, y, h, color);
    this.vLine(x + w - 1, y, h, color);
  }

  private fillRect(x: number, y: number, w: number, h: number, color: number): void {
    if (w <= 0 || h <= 0) return;
    for (let j = 0; j < h; j++) this.hLine(x, y + j, w, color);
  }

  private circle(cx: number, cy: number, r: number, color: number): void {
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
  }

  private fillCircle(cx: number, cy: number, r: number, color: number): void {
    r = Math.abs(Math.floor(r));
    for (let dy = -r; dy <= r; dy++) {
      const dx = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy)));
      this.hLine(cx - dx, cy + dy, 2 * dx + 1, color);
    }
  }

  private triangle(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: number,
  ): void {
    this.line(x0, y0, x1, y1, color);
    this.line(x1, y1, x2, y2, color);
    this.line(x2, y2, x0, y0, color);
  }

  /** Segitiga terisi (scanline; y diratakan lebih dulu). */
  private fillTriangle(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: number,
  ): void {
    const pts: Array<[number, number]> = [
      [Math.floor(x0), Math.floor(y0)],
      [Math.floor(x1), Math.floor(y1)],
      [Math.floor(x2), Math.floor(y2)],
    ];
    pts.sort((a, b) => a[1] - b[1]);
    const [ax, ay] = pts[0];
    const [bx, by] = pts[1];
    const [cx, cy] = pts[2];

    const interp = (
      xa: number,
      ya: number,
      xb: number,
      yb: number,
      y: number,
    ): number => (yb === ya ? xa : xa + ((xb - xa) * (y - ya)) / (yb - ya));

    for (let y = ay; y <= cy; y++) {
      const xs: number[] = [];
      if (y >= ay && y <= by) xs.push(interp(ax, ay, bx, by, y));
      if (y >= by && y <= cy) xs.push(interp(bx, by, cx, cy, y));
      if (y >= ay && y <= cy) xs.push(interp(ax, ay, cx, cy, y));
      if (xs.length === 0) continue;
      const xMin = Math.round(Math.min(...xs));
      const xMax = Math.round(Math.max(...xs));
      this.hLine(xMin, y, xMax - xMin + 1, color);
    }
  }

  /**
   * Inset busur sudut untuk baris ke-`i` dari tepi (0..r-1).
   * Aproksimasi rasterisasi software — boleh beda 1 px dari ILI9341 asli.
   */
  private cornerInset(i: number, r: number): number {
    const dy = r - i - 0.5;
    if (dy <= 0) return 0;
    const dx = Math.round(Math.sqrt(Math.max(0, r * r - dy * dy)));
    return Math.max(0, r - dx);
  }

  private roundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    color: number,
  ): void {
    if (w <= 0 || h <= 0) return;
    r = Math.max(0, Math.floor(r));
    if (r === 0) return this.rect(x, y, w, h, color);
    const rr = Math.min(r, Math.floor(Math.min(w, h) / 2));
    for (let i = 0; i < h; i++) {
      const inset = i < rr
        ? this.cornerInset(i, rr)
        : i >= h - rr
          ? this.cornerInset(h - 1 - i, rr)
          : 0;
      const xL = x + inset;
      const xR = x + w - 1 - inset;
      if (xL > xR) continue;
      if (i === 0 || i === h - 1) this.hLine(xL, y + i, xR - xL + 1, color);
      else {
        this.setPixel(xL, y + i, color);
        this.setPixel(xR, y + i, color);
      }
    }
  }

  private fillRoundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    color: number,
  ): void {
    if (w <= 0 || h <= 0) return;
    r = Math.max(0, Math.floor(r));
    if (r === 0) return this.fillRect(x, y, w, h, color);
    const rr = Math.min(r, Math.floor(Math.min(w, h) / 2));
    for (let i = 0; i < h; i++) {
      const inset = i < rr
        ? this.cornerInset(i, rr)
        : i >= h - rr
          ? this.cornerInset(h - 1 - i, rr)
          : 0;
      const xL = x + inset;
      const xR = x + w - 1 - inset;
      if (xL > xR) continue;
      this.hLine(xL, y + i, xR - xL + 1, color);
    }
  }

  /**
   * Bitmap mono 1 bpp MSB-first (format `drawBitmap` Adafruit_GFX).
   * Bit 1 → piksel `color`; bit 0 dilewati (transparan).
   */
  private drawMonoBitmap(
    x: number,
    y: number,
    data: Uint8Array,
    w: number,
    h: number,
    color: number,
  ): void {
    if (!data || !data.length || w <= 0 || h <= 0) return;
    const stride = (w + 7) >> 3;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const idx = j * stride + (i >> 3);
        if (idx >= data.length) return;
        if (data[idx] & (0x80 >> (i & 7))) this.setPixel(x + i, y + j, color);
      }
    }
  }

  /**
   * Blit bitmap RGB565 mentah (w*h*2 byte, little-endian) — jalur cepat untuk
   * sprite/frame yang sudah berwarna (mis. hasil render app sendiri).
   */
  private drawRgb565Bitmap(
    x: number,
    y: number,
    data: Uint8Array,
    w: number,
    h: number,
  ): void {
    if (!data || !data.length || w <= 0 || h <= 0) return;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const o = (j * w + i) * 2;
        if (o + 1 >= data.length) return;
        const c = data[o] | (data[o + 1] << 8);
        this.setPixel(x + i, y + j, c);
      }
    }
  }

  // ================================================================
  // TEKS
  // ================================================================

  /** Cetak di posisi cursor aktif lalu majukan cursor (gaya Adafruit print). */
  private print(text: string): void {
    this.drawText(text, this.cursorX, this.cursorY, this.textSize);
  }

  /**
   * Cetak di (x,y) tanpa mengubah cursor permanen — sama dengan kontrak
   * `TFTIOCTL.PRINT_TEXT` (cursor disimpan & dipulihkan).
   */
  private printText(text: string, x: number, y: number, size: number): void {
    const saveX = this.cursorX;
    const saveY = this.cursorY;
    this.cursorX = x;
    this.cursorY = y;
    this.drawText(text, x, y, size);
    this.cursorX = saveX;
    this.cursorY = saveY;
  }

  /**
   * Raster teks ke back-buffer + majukan cursor (wrap bila diaktifkan).
   * Id 1..3 memakai glyph Adafruit_GFX (`lcdFonts.ts`), id lain (0 dan id tak
   * dikenal) memakai font 5x8 klasik glcdfont (`lcdFontClassic.ts`) — data
   * font yang sama dipakai `/dev/lcd` & `/dev/plcd`, jadi teks tampil identik
   * di semua panel TSIX.
   */
  private drawText(text: string, x: number, y: number, size: number): void {
    const sz = Math.max(1, Math.floor(size) || 1);
    const gfx = LCD_GFX_FONTS[this.fontId];
    if (gfx) return this.drawTextGfx(text, x, y, sz, gfx);
    const classic = LCD_CLASSIC_FONTS[this.fontId] ?? LCD_CLASSIC_FONTS[0];
    return this.drawText5x7(text, x, y, sz, classic);
  }

  /**
   * Jalur font 5x8 klasik: cursor = sudut kiri-atas glyph, advance 6 px,
   * tinggi baris 8 px — metrik & byte glyph sama dengan `Adafruit_GFX::write`.
   */
  private drawText5x7(
    text: string,
    x: number,
    y: number,
    sz: number,
    font: LcdClassicFont,
  ): void {
    const bm = cachedBitmaps(_classicBitmapCache, this.fontId, font.bitmaps);
    const advance = font.advance * sz;
    const lineHeight = font.lineHeight * sz;
    let cx = Math.floor(x);
    let cy = Math.floor(y);

    for (const ch of text) {
      if (ch === "\n") {
        cx = 0;
        cy += lineHeight;
        continue;
      }
      if (ch === "\r") continue;
      if (this.textWrap && cx + advance > this.logicalWidth()) {
        cx = 0;
        cy += lineHeight;
      }
      const code = this.classicCode(ch, font);
      if (code === null) this.drawExtensionGlyph(cx, cy, ch, sz);
      else this.drawClassicGlyph(cx, cy, code, sz, font, bm);
      cx += advance;
    }
    this.cursorX = cx;
    this.cursorY = cy;
  }

  /**
   * Kode byte untuk font klasik, atau null kalau karakter tidak bisa
   * dialamatkan font ini (di luar 0..255) → pakai font ekstensi TSIX.
   */
  private classicCode(ch: string, font: LcdClassicFont): number | null {
    const c = ch.charCodeAt(0);
    if (c > 0xff) return null;
    // `_cp437` di Adafruit_GFX bawaannya false → kode ≥ 176 digeser +1.
    const code = c >= 176 ? c + 1 : c;
    return code < font.glyphCount ? code : null;
  }

  /** Gambar satu glyph font klasik (5 kolom × 8 baris; bit0 = baris atas). */
  private drawClassicGlyph(
    x: number,
    y: number,
    code: number,
    size: number,
    font: LcdClassicFont,
    bm: Uint8Array | null,
  ): void {
    if (this.textBg !== null)
      this.fillRect(x, y, font.advance * size, font.cellH * size, this.textBg);
    if (!bm) return;
    for (let i = 0; i < font.glyphW; i++) {
      const col = bm[code * font.glyphW + i] ?? 0;
      for (let r = 0; r < font.cellH; r++) {
        if (!((col >> r) & 1)) continue;
        this.fillRect(x + i * size, y + r * size, size, size, this.textColor);
      }
    }
  }

  /**
   * Jalur font Adafruit_GFX (mis. FreeSans9pt7b):
   *   - `cursorY` adalah BASELINE; glyph digambar di
   *     `(cursorX + xOffset, cursorY + yOffset)`, baris baru + `yAdvance`.
   *   - Bitmap dibaca KONTINU (tanpa padding antar-baris).
   * Karakter di luar rentang font dilewati tanpa memajukan cursor.
   */
  private drawTextGfx(
    text: string,
    x: number,
    y: number,
    size: number,
    font: LcdGfxFont,
  ): void {
    const bm = cachedBitmaps(_gfxBitmapCache, this.fontId, font.bitmaps);
    if (!bm) {
      // Data GFX tak terbaca → font klasik, supaya teks tetap tampil.
      return this.drawText5x7(text, x, y, size, LCD_CLASSIC_FONTS[0]);
    }

    let cx = Math.floor(x);
    let cy = Math.floor(y);
    for (const ch of text) {
      if (ch === "\n" || ch === "\r") {
        cx = 0;
        cy += font.yAdvance * size;
        continue;
      }
      const idx = ch.charCodeAt(0) - font.first;
      if (idx < 0 || idx >= font.glyphs.length) continue;

      const [offset, w, h, xAdvance, xOffset, yOffset] = font.glyphs[idx];
      if (this.textWrap && cx + xAdvance * size > this.logicalWidth()) {
        cx = 0;
        cy += font.yAdvance * size;
      }

      const gx = cx + xOffset;
      const gy = cy + yOffset;
      if (this.textBg !== null) this.fillRect(gx, gy, w * size, h * size, this.textBg);

      const pixels = w * h;
      for (let i = 0; i < pixels; i++) {
        const byte = bm[offset + (i >> 3)];
        if (byte === undefined) break;
        if (!((byte >> (7 - (i & 7))) & 1)) continue;
        this.fillRect(
          gx + (i % w) * size,
          gy + Math.floor(i / w) * size,
          size,
          size,
          this.textColor,
        );
      }
      cx += xAdvance * size;
    }
    this.cursorX = cx;
    this.cursorY = cy;
  }

  /**
   * Glyph dari font ekstensi TSIX (`plcdFont5x7.ts`) untuk karakter di luar
   * jangkauan font bitmap — mis. panah U+2192. Yang tidak ada di tabel
   * digambar kotak kosong (bukan hilang tanpa jejak).
   */
  private drawExtensionGlyph(x: number, y: number, ch: string, size: number): void {
    const glyph = plcdGlyph(ch) ?? FALLBACK_GLYPH;
    for (let c = 0; c < PLCD_FONT_W; c++) {
      const col = glyph[c];
      for (let r = 0; r < PLCD_FONT_H; r++) {
        const on = (col >> r) & 1;
        if (on) this.fillRect(x + c * size, y + r * size, size, size, this.textColor);
        else if (this.textBg !== null)
          this.fillRect(x + c * size, y + r * size, size, size, this.textBg);
      }
    }
  }

  // ================================================================
  // OP DARI write({ op, args }) — nama op sama dengan LM6029Device
  // ================================================================

  private applyOp(op: string, args: any[]): boolean {
    if (!WRITE_OPS.has(op)) return false;
    switch (op) {
      case "clear":
      case "clearDisplay":
        this.fb.fill(TFT_COLOR.BLACK);
        return true;
      case "display":
      case "flush":
        this.flush();
        return true;
      case "fillScreen":
        this.fb.fill(this.color(args[0], TFT_COLOR.BLACK));
        return true;
      case "drawPixel":
        this.setPixel(num(args[0]), num(args[1]), this.color(args[2], TFT_COLOR.WHITE));
        return true;
      case "drawLine":
        this.line(num(args[0]), num(args[1]), num(args[2]), num(args[3]), this.color(args[4], TFT_COLOR.WHITE));
        return true;
      case "drawRect":
        this.rect(num(args[0]), num(args[1]), num(args[2]), num(args[3]), this.color(args[4], TFT_COLOR.WHITE));
        return true;
      case "fillRect":
        this.fillRect(num(args[0]), num(args[1]), num(args[2]), num(args[3]), this.color(args[4], TFT_COLOR.WHITE));
        return true;
      case "drawCircle":
        this.circle(num(args[0]), num(args[1]), num(args[2]), this.color(args[3], TFT_COLOR.WHITE));
        return true;
      case "fillCircle":
        this.fillCircle(num(args[0]), num(args[1]), num(args[2]), this.color(args[3], TFT_COLOR.WHITE));
        return true;
      case "drawTriangle":
        this.triangle(num(args[0]), num(args[1]), num(args[2]), num(args[3]), num(args[4]), num(args[5]), this.color(args[6], TFT_COLOR.WHITE));
        return true;
      case "fillTriangle":
        this.fillTriangle(num(args[0]), num(args[1]), num(args[2]), num(args[3]), num(args[4]), num(args[5]), this.color(args[6], TFT_COLOR.WHITE));
        return true;
      case "drawRoundRect":
        this.roundRect(num(args[0]), num(args[1]), num(args[2]), num(args[3]), num(args[4]), this.color(args[5], TFT_COLOR.WHITE));
        return true;
      case "fillRoundRect":
        this.fillRoundRect(num(args[0]), num(args[1]), num(args[2]), num(args[3]), num(args[4]), this.color(args[5], TFT_COLOR.WHITE));
        return true;
      case "drawBitmap": {
        const data = asBuffer(args[2]);
        const w = num(args[3]);
        const h = num(args[4]);
        if (data.length >= w * h * 2) this.drawRgb565Bitmap(num(args[0]), num(args[1]), data, w, h);
        else this.drawMonoBitmap(num(args[0]), num(args[1]), data, w, h, this.color(args[5], TFT_COLOR.WHITE));
        return true;
      }
      case "setFont":
        this.fontId = num(args[0]);
        return true;
      case "setTextColor":
        this.textColor = this.color(args[0], TFT_COLOR.WHITE);
        this.textBg = args[1] === undefined || args[1] === null ? null : this.color(args[1], TFT_COLOR.BLACK);
        return true;
      case "setTextSize":
        this.textSize = Math.max(1, Math.floor(num(args[0]) || 1));
        return true;
      case "setTextWrap":
        this.textWrap = bool(args[0]);
        return true;
      case "setCursor":
        this.cursorX = Math.floor(num(args[0]));
        this.cursorY = Math.floor(num(args[1]));
        return true;
      case "print":
        this.print(String(args[0] ?? ""));
        return true;
      case "printText":
        this.printText(String(args[0] ?? ""), num(args[1]), num(args[2]), args[3] === undefined ? 1 : num(args[3]));
        return true;
      case "setRotation":
        this.rotation = ((Math.floor(num(args[0])) % 4) + 4) % 4;
        return true;
      case "setBacklight":
        this.backlight = this.panel?.setBacklight ? !!this.panel.setBacklight(bool(args[0])) : bool(args[0]);
        return true;
      case "setBrightness":
        this.brightness = Math.max(0, Math.min(255, Math.floor(num(args[0]))));
        this.panel?.setBrightness?.(this.brightness);
        return true;
      case "setDisplayInvert":
        this.invert = bool(args[0]);
        return true;
      case "setDisplayOn":
        this.displayOn = this.panel?.setDisplayOn ? !!this.panel.setDisplayOn(bool(args[0])) : bool(args[0]);
        return true;
      default:
        return false;
    }
  }

  // ================================================================
  // INTERNAL
  // ================================================================

  /** Ambil panel: inject > opsi > FbDevPanel produksi (lazy). */
  private getPanel(): TftPanelHandle | null {
    if (this.panel) return this.panel;
    if (this.injected) {
      this.panel = this.injected;
      return this.panel;
    }
    this.panel = new FbDevPanel(this.panelOptions);
    return this.panel;
  }

  /**
   * Kirim back-buffer → node framebuffer, hitung frame.
   *
   * `invert` diemulasi di sini (XOR 16-bit) karena fbdev tidak punya ioctl
   * INVON: salinan ter-inversi dibuat sekali per frame, dan hanya saat
   * invert aktif — jalur normal tetap satu memcpy tanpa alokasi.
   */
  private flush(): void {
    if (!this.panel) return;
    if (this.invert) {
      if (!this.invertScratch) {
        this.invertScratch = new Uint16Array(TFT_WIDTH * TFT_HEIGHT);
        this.invertScratchBytes = Buffer.from(this.invertScratch.buffer);
      }
      const src = this.fb;
      const dst = this.invertScratch;
      for (let i = 0; i < src.length; i++) dst[i] = ~src[i] & 0xffff;
      this.panel.present(this.invertScratchBytes!);
    } else {
      this.panel.present(this.bytes);
    }
    this.frames++;
  }

  /** Log ke syslog kernel bila tersedia. */
  private log(msg: string): void {
    try {
      this.kctx?.syslog(`[tft] ${msg}`);
    } catch (_) {
      /* ignore */
    }
  }

  /** Catat error runtime + syslog. */
  private fail(where: string, e: any): void {
    const msg = e?.message || String(e);
    this.lastError = `${where}: ${msg}`;
    console.error(`[ILI9341] ${where} error: ${msg}`);
    this.log(`${where} error: ${msg}`);
  }
}

// Plugin Export: harus export default class yang implement IDevice
export default ILI9341Device;
