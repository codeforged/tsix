/**
 * LM6029 LCD DEVICE (/dev/lcd)
 *
 * Driver kernel-land untuk modul LCD monokrom 128x64 (LM6029ACW) yang
 * dikendalikan lewat SPI0 + 2x 74HC595. Semua akses hardware dilakukan oleh
 * native addon `lm6029acw` (N-API); driver ini hanya jembatan tipis ke
 * kontrak `IDevice` (HAL TSIX) — "Everything is a File".
 *
 * ── AKSES USERLAND ──
 *   const fd = await lib.fs.open("/dev/lcd", "w+");
 *   await lib.std.ioctl(fd, LCDIOCTL.SET_CONTRAST, { level: 40 });
 *   await lib.std.ioctl(fd, LCDIOCTL.PRINT_TEXT,
 *                       { text: "Halo TSIX", x: 0, y: 20, size: 2 });
 *   await lib.std.ioctl(fd, LCDIOCTL.DISPLAY, null);
 *   await lib.fs.close(fd);
 *
 * ── DUA MODE PENULISAN ──
 * 1. FRAMEBUFFER (ala /dev/fb0, sekali jalan):
 *      write(Buffer 1024 byte) → blit penuh 128x64, 1 bpp MSB-first
 *      row-major (raster scanline, format drawBitmap Adafruit_GFX).
 *      Buffer panel dibersihkan dulu, jadi frame baru benar-benar
 *      MENGGANTI isi layar (bukan menumpuk) — frame kosong = clear layar.
 *      Cocok untuk `dd`, snapshot layar, atau lib framebuffer TSIX.
 * 2. PERINTAH:
 *      write("teks")                        → cetak di cursor
 *      write({ op: "fillRect", args: [..] }) → panggil primitive GFX
 *      ioctl(fd, LCDIOCTL.*, arg)            → kontrol lengkap
 *
 * ── AUTO-FLUSH ──
 * write() otomatis memanggil display() (autoFlush default ON) supaya `cat`
 * / `dd` langsung tampil. Perintah ioctl TIDAK auto-flush — panggil
 * LCDIOCTL.DISPLAY sendiri setelah menggambar beberapa objek (lebih cepat).
 *
 * ── HARDWARE ──
 * Addon membuka bus SPI yang tersedia; SPI harus di-enable (raspi-config /
 * orangepi-config). Path tidak di-hardcode: addon mengauto-deteksi
 * /dev/spidev* (Raspberry Pi /dev/spidev0.0, Orange Pi /dev/spidev3.0),
 * bisa dipaksa lewat opsi `spiDevice` atau env `LM6029_SPI_DEV`. Pin
 * kontrol (RD/WR/RS/RES/CS/LED) ada di 74HC595, bukan GPIO JavaScript.
 *
 * Referensi native: paket npm `lm6029acw` (src/LM6029ACW_595.h)
 *
 * (c) 2026 TSIX Project
 */

import { IDevice, KContext } from "../IDevice";
import * as os from "os";
import * as path from "path";

// ================================================================
// GEOMETRI PANEL
// ================================================================

/** Lebar panel dalam piksel. */
export const LCD_WIDTH = 128;
/** Tinggi panel dalam piksel. */
export const LCD_HEIGHT = 64;
/** Jumlah "page" (8 baris vertikal per page) pada controller KS0108-like. */
export const LCD_PAGES = 8;
/** Ukuran framebuffer 1 bpp MSB-first row-major: 128 * 64 / 8 = 1024 byte. */
export const LCD_FRAMEBUFFER_SIZE = (LCD_WIDTH * LCD_HEIGHT) / 8;

/**
 * Nama modul native yang dicari — paket npm `lm6029acw`.
 * `raspi-lcd-addon` dipertahankan sebagai alias lama supaya setup dev yang
 * sudah jalan tidak langsung rusak. Diurut dari yang paling diutamakan.
 */
const ADDON_MODULE_NAMES = ["lm6029acw", "raspi-lcd-addon"];

// ================================================================
// TIPE NATIVE ADDON (bentuk permukaan paket lm6029acw)
// ================================================================

/** Handle instance LM6029LCD dari native addon. */
export interface LM6029NativeHandle {
  begin(speedHz?: number): boolean;
  clear(): void;
  clearDisplay(): void;
  display(): void;
  drawPixel(x: number, y: number, color: number): void;
  getWidth(): number;
  getHeight(): number;
  fillScreen(color: number): void;
  drawLine(x0: number, y0: number, x1: number, y1: number, color: number): void;
  drawRect(x: number, y: number, w: number, h: number, color: number): void;
  fillRect(x: number, y: number, w: number, h: number, color: number): void;
  drawCircle(x: number, y: number, r: number, color: number): void;
  fillCircle(x: number, y: number, r: number, color: number): void;
  drawTriangle(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: number,
  ): void;
  fillTriangle(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: number,
  ): void;
  drawRoundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    color: number,
  ): void;
  fillRoundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    color: number,
  ): void;
  setFont(fontId: number): void;
  setTextColor(color: number, bg?: number): void;
  setTextSize(size: number): void;
  setTextWrap(wrap: boolean): void;
  setCursor(x: number, y: number): void;
  print(text: string): void;
  printText(text: string, x: number, y: number, size?: number): void;
  setRotation(rotation: number): void;
  drawBitmap(
    x: number,
    y: number,
    bitmap: Buffer,
    w: number,
    h: number,
    color: number,
  ): void;
  setContrast(level: number): number;
  getContrast(): number;
  setBacklight(on: boolean): boolean;
  getBacklight(): boolean;
  setDisplayInvert(invert: boolean): boolean;
  getDisplayInvert(): boolean;
  setDisplayOn(on: boolean): boolean;
  isDisplayOn(): boolean;
  setSpiSpeed(hz: number): number;
  getSpiSpeed(): number;
  // Opsional: hanya ada di addon lm6029acw >= 1.1.0 (auto-deteksi bus SPI).
  setSpiDevice?(path: string): void;
  getSpiDevicePath?(): string;
  getSpiProbeLog?(): string;
}

/** Bentuk modul hasil require(). */
export interface LM6029NativeModule {
  LM6029LCD: new () => LM6029NativeHandle;
}

// ================================================================
// IOCTL (namespace 0x4C = 'L', unik antar driver)
// ================================================================

export enum LCDIOCTL {
  // ── Lifecycle ──
  /** arg: null → boolean (coba buka bus SPI + init panel) */
  BEGIN = 0x4c01,
  /** arg: null → true (clear + display) */
  RESET = 0x4c02,
  /** arg: null → true (bersihkan buffer, belum dikirim ke panel) */
  CLEAR = 0x4c03,
  /** arg: null → true (flush buffer → panel) */
  DISPLAY = 0x4c04,

  // ── Pixel & primitive GFX ──
  /** arg: { x, y, color=1 } → true */
  DRAW_PIXEL = 0x4c10,
  /** arg: { color=1 } | number → true */
  FILL_SCREEN = 0x4c11,
  /** arg: { x0, y0, x1, y1, color=1 } → true */
  DRAW_LINE = 0x4c12,
  /** arg: { x, y, w, h, color=1 } → true */
  DRAW_RECT = 0x4c13,
  /** arg: { x, y, w, h, color=1 } → true */
  FILL_RECT = 0x4c14,
  /** arg: { x, y, r, color=1 } → true */
  DRAW_CIRCLE = 0x4c15,
  /** arg: { x, y, r, color=1 } → true */
  FILL_CIRCLE = 0x4c16,
  /** arg: { x0, y0, x1, y1, x2, y2, color=1 } → true */
  DRAW_TRIANGLE = 0x4c17,
  /** arg: { x0, y0, x1, y1, x2, y2, color=1 } → true */
  FILL_TRIANGLE = 0x4c18,
  /** arg: { x, y, w, h, r, color=1 } → true */
  DRAW_ROUND_RECT = 0x4c19,
  /** arg: { x, y, w, h, r, color=1 } → true */
  FILL_ROUND_RECT = 0x4c1a,
  /** arg: { x, y, data: Buffer, w, h, color=1 } → true */
  DRAW_BITMAP = 0x4c1b,

  // ── Teks ──
  /** arg: { id } | number — 0=default 5x7, 1=FreeSans9, 2=FreeSansBold12, 3=FreeMono9 → id */
  SET_FONT = 0x4c20,
  /** arg: { color, bg? } → true */
  SET_TEXT_COLOR = 0x4c21,
  /** arg: { size } | number → true */
  SET_TEXT_SIZE = 0x4c22,
  /** arg: boolean → true */
  SET_TEXT_WRAP = 0x4c23,
  /** arg: { x, y } → true */
  SET_CURSOR = 0x4c24,
  /** arg: string → true (flush bila autoFlush ON) */
  PRINT = 0x4c25,
  /** arg: { text, x, y, size=1 } → true (flush bila autoFlush ON) */
  PRINT_TEXT = 0x4c26,
  /** arg: { rotation } | number → rotation */
  SET_ROTATION = 0x4c27,

  // ── Kontrol tampilan ──
  /** arg: { level } | number (0..63, di-clamp) → nilai terpakai */
  SET_CONTRAST = 0x4c30,
  /** arg: null → number */
  GET_CONTRAST = 0x4c31,
  /** arg: boolean → boolean */
  SET_BACKLIGHT = 0x4c32,
  /** arg: null → boolean */
  GET_BACKLIGHT = 0x4c33,
  /** arg: boolean → boolean */
  SET_INVERT = 0x4c34,
  /** arg: null → boolean */
  GET_INVERT = 0x4c35,
  /** arg: boolean → boolean */
  SET_DISPLAY_ON = 0x4c36,
  /** arg: null → boolean */
  IS_DISPLAY_ON = 0x4c37,
  /** arg: { hz } | number → hz terpakai (pembulatan pangkat dua oleh hardware) */
  SET_SPI_SPEED = 0x4c38,
  /** arg: null → number */
  GET_SPI_SPEED = 0x4c39,

  // ── Info & tuning ──
  /** arg: null → { device, available, width, height, ... } */
  GET_INFO = 0x4c40,
  /** arg: null → number */
  GET_WIDTH = 0x4c41,
  /** arg: null → number */
  GET_HEIGHT = 0x4c42,
  /** arg: boolean → boolean (write() auto-flush) */
  SET_AUTO_FLUSH = 0x4c43,
  /** arg: null → boolean */
  GET_AUTO_FLUSH = 0x4c44,
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
  "setFont",
  "setTextColor",
  "setTextSize",
  "setTextWrap",
  "setCursor",
  "print",
  "printText",
  "setRotation",
  "drawBitmap",
  "setContrast",
  "setBacklight",
  "setDisplayInvert",
  "setDisplayOn",
  "setSpiSpeed",
]);

// ================================================================
// OPSI DRIVER
// ================================================================

export interface LM6029Options {
  /** Nama node di /dev (default: "lcd"). */
  name?: string;
  /** Clock SPI yang diminta (Hz). Default addon: 10 MHz. */
  spiSpeed?: number;
  /**
   * Bus SPI eksplisit, mis. "/dev/spidev3.0" (Orange Pi) atau
   * "/dev/spidev0.0" (Raspberry Pi). Kosong = biarkan addon
   * mengauto-deteksi dari /dev/spidev* (default; env LM6029_SPI_DEV juga
   * dihormati oleh addon).
   */
  spiDevice?: string;
  /** Kontras awal 0..63 (EVR). Default addon: 31. */
  contrast?: number;
  /** Backlight awal (default: true). */
  backlight?: boolean;
  /** Inversi tampilan awal (default: false). */
  invert?: boolean;
  /** Display ON awal (default: true). */
  displayOn?: boolean;
  /** Rotasi awal 0..3 (default: 0). */
  rotation?: number;
  /** write() otomatis flush ke panel (default: true). */
  autoFlush?: boolean;
  /** Nonaktifkan driver (tidak dibuka saat boot). */
  disabled?: boolean;
  /** Path eksplisit ke folder/modul native addon (mis. saat dev). */
  addonPath?: string;
  /** Handle native siap pakai — untuk embedding / unit test (melewati require). */
  native?: LM6029NativeHandle;
}

// ================================================================
// HELPER
// ================================================================

/**
 * Helper koersi argumen ioctl LCD.
 *
 * Diekspor karena kontrak ioctl LCD (0x4c) dipakai BERSAMA oleh driver asli
 * (LM6029Device) dan pseudo-device (`PLCDDevice`) — pseudo-device memakai
 * nomor perintah & bentuk argumen yang sama persis supaya userland
 * (`lcdLib`, `cat`, `dd`) tidak bisa membedakan keduanya.
 */

/** Ambil argumen posisional dari objek bernama ATAU array ATAU scalar. */
export function positional(arg: any, names: string[]): any[] {
  if (Array.isArray(arg)) return arg;
  if (arg !== null && typeof arg === "object") return names.map((k) => arg[k]);
  if (names.length <= 1) return [arg];
  return [];
}

/** Koersi ke number (NaN → 0). */
export function num(v: any): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Koersi ke boolean longgar (1 / "1" / "true" / true). */
export function bool(v: any): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

/**
 * Ambil nilai boolean dari scalar, array, atau object bernama.
 * Contoh: false, [true], { on: true }, { invert: true }.
 */
export function boolFrom(arg: any, keys: string[]): boolean {
  if (Array.isArray(arg)) return bool(arg[0]);
  if (arg !== null && typeof arg === "object") {
    for (const k of keys) {
      if (k in arg) return bool(arg[k]);
    }
    return false;
  }
  return bool(arg);
}

/**
 * Normalisasi data biner lintas-IPC: Buffer, Uint8Array, array byte, atau
 * Buffer yang sudah lewat syscall/JSON ({ type: "Buffer", data: [...] }).
 * Return null kalau bukan data biner.
 */
export function toByteBuffer(v: any): Buffer | null {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (v && typeof v === "object" && v.type === "Buffer" && Array.isArray(v.data))
    return Buffer.from(v.data);
  if (Array.isArray(v)) return Buffer.from(v);
  return null;
}

/** Buffer primitif GFX yang valid untuk drawBitmap (fallback: buffer kosong). */
export function asBuffer(v: any): Buffer {
  return toByteBuffer(v) ?? Buffer.alloc(0);
}

// ================================================================
// DRIVER
// ================================================================

export class LM6029Device implements IDevice {
  public name: string;
  public uid = 0;
  public gid = 0;
  /** Default 0666 — display bersama, semua user boleh menggambar. */
  public mode = 0o666;
  public disabled: boolean;

  private kctx: KContext | null = null;
  private lcd: LM6029NativeHandle | null = null;
  private injected: LM6029NativeHandle | null;
  private addonPathOverride?: string;
  private addonModule: LM6029NativeModule | null | undefined = undefined;

  private initialized = false;
  private autoFlush: boolean;
  private width = LCD_WIDTH;
  private height = LCD_HEIGHT;

  private spiSpeed?: number;
  private spiDevice?: string;
  private initialContrast?: number;
  private initialBacklight?: boolean;
  private initialInvert?: boolean;
  private initialDisplayOn?: boolean;
  private initialRotation?: number;

  private readRefs = 0;
  private writeRefs = 0;
  private frames = 0;
  private lastError: string | null = null;

  constructor(options: LM6029Options = {}) {
    this.name = options.name || "lcd";
    this.disabled = options.disabled === true;
    this.injected = options.native || null;
    this.addonPathOverride = options.addonPath;
    this.autoFlush = options.autoFlush !== false;
    this.spiSpeed = options.spiSpeed;
    this.spiDevice = options.spiDevice;
    this.initialContrast = options.contrast;
    this.initialBacklight = options.backlight;
    this.initialInvert = options.invert;
    this.initialDisplayOn = options.displayOn;
    this.initialRotation = options.rotation;
  }

  // ================================================================
  // LIFECYCLE (IDevice)
  // ================================================================

  /** Dipanggil Kernel saat boot — coba hidupkan panel. */
  public init(ctx: KContext): void {
    this.kctx = ctx;
    if (this.disabled) {
      this.log("Driver dinonaktifkan (disabled=true), dilewati.");
      return;
    }

    if (this.open()) {
      const hz = this.safe(() => this.lcd!.getSpiSpeed());
      const bus = this.safe(() => this.lcd!.getSpiDevicePath?.() ?? null);
      this.log(
        `LM6029 siap: ${this.width}x${this.height} di /dev/${this.name}` +
          (bus ? ` via ${bus}` : "") +
          (hz ? ` (SPI ~${Math.round(num(hz) / 1000)} kHz)` : ""),
      );
    } else {
      this.log(
        "LM6029 tidak terdeteksi (addon lm6029acw atau bus SPI belum siap). " +
          "Node /dev disembunyikan dari `ls /dev`.",
      );
    }
  }

  /**
   * open(): Lazy-open — muat addon lalu begin(). Aman dipanggil berulang;
   * kalau sudah hidup langsung true. Gagal → bisa dicoba lagi nanti (hotplug).
   */
  public open(): boolean {
    if (this.initialized) return true;

    const lcd = this.getNative();
    if (!lcd) {
      this.fail(
        "open",
        new Error(
          `Native addon '${ADDON_MODULE_NAMES[0]}' tidak ditemukan. ` +
            `Jalankan \`npm i ${ADDON_MODULE_NAMES[0]}\` atau set TSIX_LCD_ADDON_PATH.`,
        ),
      );
      return false;
    }

    try {
      // Bus SPI eksplisit (opsi `spiDevice`) menang atas auto-deteksi addon.
      if (this.spiDevice && typeof lcd.setSpiDevice === "function") {
        lcd.setSpiDevice(this.spiDevice);
      }

      const ok = lcd.begin(this.spiSpeed ?? 0);
      if (!ok) {
        const probe = this.safe(() => lcd.getSpiProbeLog?.() ?? "");
        this.lastError =
          "begin() gagal membuka bus SPI" +
          (probe ? ` (${probe})` : "") +
          (typeof lcd.setSpiDevice === "function"
            ? ""
            : " — addon lama: bus di-hardcode /dev/spidev0.0, update lm6029acw");
        return false;
      }

      // Terapkan konfigurasi awal hanya sekali (saat pertama begin sukses).
      if (this.initialRotation !== undefined)
        lcd.setRotation(num(this.initialRotation));
      if (this.initialContrast !== undefined)
        lcd.setContrast(Math.max(0, Math.min(63, num(this.initialContrast))));
      if (this.initialBacklight !== undefined)
        lcd.setBacklight(!!this.initialBacklight);
      if (this.initialInvert !== undefined)
        lcd.setDisplayInvert(!!this.initialInvert);
      if (this.initialDisplayOn !== undefined)
        lcd.setDisplayOn(!!this.initialDisplayOn);

      this.width = num(lcd.getWidth()) || LCD_WIDTH;
      this.height = num(lcd.getHeight()) || LCD_HEIGHT;
      this.initialized = true;
      this.lastError = null;
      return true;
    } catch (e: any) {
      this.fail("open", e);
      return false;
    }
  }

  /**
   * close(): Addon tidak punya API release eksplisit. Handle native sengaja
   * dipertahankan supaya open/close berulang (refcount FD) tidak menghapus
   * isi buffer layar dan tidak perlu re-init SPI.
   */
  public close(): boolean {
    this.log("Device ditutup (handle native dipertahankan).");
    return true;
  }

  /** present() → true hanya saat panel benar-benar sudah ter-init. */
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
   * write(): terima string (teks), Buffer (framebuffer / teks), atau
   * objek { op, args }. Auto-flush bila autoFlush ON (default).
   *
   * Buffer 1024 byte = SATU FRAME penuh dan bersifat mengganti: buffer panel
   * dibersihkan sebelum di-blit. Buffer lebih pendek diperlakukan sebagai teks.
   */
  public write(data: any): boolean {
    if (!this.initialized || !this.lcd) return false;

    try {
      // Biner (Buffer/Uint8Array/hasil JSON dari userland).
      const raw = toByteBuffer(data);
      if (raw) {
        if (raw.length === LCD_FRAMEBUFFER_SIZE) {
          // Blit penuh 1 bpp MSB-first row-major (raster scanline).
          // PENTING: buffer panel dibersihkan dulu. drawBitmap() Adafruit_GFX
          // hanya MENYALA-kan piksel untuk bit 1 dan melewati bit 0, jadi tanpa
          // clear() frame baru akan menumpuk di atas frame lama (hantu piksel)
          // dan frame kosong pun tidak bisa menghapus layar. Dengan clear(),
          // satu write(1024 byte) benar-benar MENGGANTI seluruh isi layar.
          this.lcd.clear();
          this.lcd.drawBitmap(0, 0, raw, LCD_WIDTH, LCD_HEIGHT, 1);
        } else {
          this.lcd.print(raw.toString("utf8"));
        }
        if (this.autoFlush) this.flush();
        return true;
      }

      if (typeof data === "string") {
        this.lcd.print(data);
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

    // BEGIN boleh kapan saja untuk mencoba menghidupkan hardware.
    if (cmd === LCDIOCTL.BEGIN) return this.open();

    if (!this.initialized || !this.lcd) {
      // Selalu kembalikan nilai (bukan undefined) agar userland tidak crash.
      return null;
    }

    const lcd = this.lcd;

    try {
      switch (cmd) {
        // ── Lifecycle ──
        case LCDIOCTL.RESET:
          lcd.clear();
          this.flush();
          return true;
        case LCDIOCTL.CLEAR:
          lcd.clear();
          return true;
        case LCDIOCTL.DISPLAY:
          this.flush();
          return true;

        // ── Primitive GFX ──
        case LCDIOCTL.DRAW_PIXEL: {
          const [x, y, color] = positional(arg, ["x", "y", "color"]);
          lcd.drawPixel(num(x), num(y), color === undefined ? 1 : num(color));
          return true;
        }
        case LCDIOCTL.FILL_SCREEN: {
          const [color] = positional(arg, ["color"]);
          lcd.fillScreen(color === undefined ? 1 : num(color));
          return true;
        }
        case LCDIOCTL.DRAW_LINE: {
          const [x0, y0, x1, y1, color] = positional(arg, [
            "x0",
            "y0",
            "x1",
            "y1",
            "color",
          ]);
          lcd.drawLine(
            num(x0),
            num(y0),
            num(x1),
            num(y1),
            color === undefined ? 1 : num(color),
          );
          return true;
        }
        case LCDIOCTL.DRAW_RECT:
        case LCDIOCTL.FILL_RECT: {
          const [x, y, w, h, color] = positional(arg, [
            "x",
            "y",
            "w",
            "h",
            "color",
          ]);
          const fn = cmd === LCDIOCTL.DRAW_RECT ? lcd.drawRect : lcd.fillRect;
          fn.call(
            lcd,
            num(x),
            num(y),
            num(w),
            num(h),
            color === undefined ? 1 : num(color),
          );
          return true;
        }
        case LCDIOCTL.DRAW_CIRCLE:
        case LCDIOCTL.FILL_CIRCLE: {
          const [x, y, r, color] = positional(arg, ["x", "y", "r", "color"]);
          const fn =
            cmd === LCDIOCTL.DRAW_CIRCLE ? lcd.drawCircle : lcd.fillCircle;
          fn.call(lcd, num(x), num(y), num(r), color === undefined ? 1 : num(color));
          return true;
        }
        case LCDIOCTL.DRAW_TRIANGLE:
        case LCDIOCTL.FILL_TRIANGLE: {
          const [x0, y0, x1, y1, x2, y2, color] = positional(arg, [
            "x0",
            "y0",
            "x1",
            "y1",
            "x2",
            "y2",
            "color",
          ]);
          const fn =
            cmd === LCDIOCTL.DRAW_TRIANGLE
              ? lcd.drawTriangle
              : lcd.fillTriangle;
          fn.call(
            lcd,
            num(x0),
            num(y0),
            num(x1),
            num(y1),
            num(x2),
            num(y2),
            color === undefined ? 1 : num(color),
          );
          return true;
        }
        case LCDIOCTL.DRAW_ROUND_RECT:
        case LCDIOCTL.FILL_ROUND_RECT: {
          const [x, y, w, h, r, color] = positional(arg, [
            "x",
            "y",
            "w",
            "h",
            "r",
            "color",
          ]);
          const fn =
            cmd === LCDIOCTL.DRAW_ROUND_RECT
              ? lcd.drawRoundRect
              : lcd.fillRoundRect;
          fn.call(
            lcd,
            num(x),
            num(y),
            num(w),
            num(h),
            num(r),
            color === undefined ? 1 : num(color),
          );
          return true;
        }
        case LCDIOCTL.DRAW_BITMAP: {
          const [x, y, data, w, h, color] = positional(arg, [
            "x",
            "y",
            "data",
            "w",
            "h",
            "color",
          ]);
          lcd.drawBitmap(
            num(x),
            num(y),
            asBuffer(data),
            num(w),
            num(h),
            color === undefined ? 1 : num(color),
          );
          return true;
        }

        // ── Teks ──
        case LCDIOCTL.SET_FONT: {
          const [id] = positional(arg, ["id"]);
          lcd.setFont(num(id));
          return num(id);
        }
        case LCDIOCTL.SET_TEXT_COLOR: {
          const [color, bg] = positional(arg, ["color", "bg"]);
          if (bg === undefined) lcd.setTextColor(num(color));
          else lcd.setTextColor(num(color), num(bg));
          return true;
        }
        case LCDIOCTL.SET_TEXT_SIZE: {
          const [size] = positional(arg, ["size"]);
          lcd.setTextSize(num(size));
          return true;
        }
        case LCDIOCTL.SET_TEXT_WRAP:
          lcd.setTextWrap(boolFrom(arg, ["wrap"]));
          return true;
        case LCDIOCTL.SET_CURSOR: {
          const [x, y] = positional(arg, ["x", "y"]);
          lcd.setCursor(num(x), num(y));
          return true;
        }
        case LCDIOCTL.PRINT: {
          const [text] = positional(arg, ["text"]);
          lcd.print(String(text ?? ""));
          if (this.autoFlush) this.flush();
          return true;
        }
        case LCDIOCTL.PRINT_TEXT: {
          const [text, x, y, size] = positional(arg, [
            "text",
            "x",
            "y",
            "size",
          ]);
          lcd.printText(
            String(text ?? ""),
            num(x),
            num(y),
            size === undefined ? 1 : num(size),
          );
          if (this.autoFlush) this.flush();
          return true;
        }
        case LCDIOCTL.SET_ROTATION: {
          const [rotation] = positional(arg, ["rotation"]);
          lcd.setRotation(num(rotation));
          this.width = num(lcd.getWidth()) || this.width;
          this.height = num(lcd.getHeight()) || this.height;
          return num(rotation);
        }

        // ── Kontrol tampilan ──
        case LCDIOCTL.SET_CONTRAST: {
          const [level] = positional(arg, ["level"]);
          const clamped = Math.max(0, Math.min(63, num(level)));
          return num(lcd.setContrast(clamped));
        }
        case LCDIOCTL.GET_CONTRAST:
          return num(lcd.getContrast());
        case LCDIOCTL.SET_BACKLIGHT: {
          const on = boolFrom(arg, ["on", "value"]);
          return !!lcd.setBacklight(on);
        }
        case LCDIOCTL.GET_BACKLIGHT:
          return !!lcd.getBacklight();
        case LCDIOCTL.SET_INVERT: {
          const on = boolFrom(arg, ["invert", "on", "value"]);
          return !!lcd.setDisplayInvert(on);
        }
        case LCDIOCTL.GET_INVERT:
          return !!lcd.getDisplayInvert();
        case LCDIOCTL.SET_DISPLAY_ON: {
          const on = boolFrom(arg, ["on", "value"]);
          return !!lcd.setDisplayOn(on);
        }
        case LCDIOCTL.IS_DISPLAY_ON:
          return !!lcd.isDisplayOn();
        case LCDIOCTL.SET_SPI_SPEED: {
          const [hz] = positional(arg, ["hz"]);
          return num(lcd.setSpiSpeed(num(hz)));
        }
        case LCDIOCTL.GET_SPI_SPEED:
          return num(lcd.getSpiSpeed());

        // ── Info & tuning ──
        case LCDIOCTL.GET_INFO:
          return this.getInfo();
        case LCDIOCTL.GET_WIDTH:
          return this.width;
        case LCDIOCTL.GET_HEIGHT:
          return this.height;
        case LCDIOCTL.SET_AUTO_FLUSH:
          this.autoFlush = boolFrom(arg, ["on", "autoFlush", "value"]);
          return this.autoFlush;
        case LCDIOCTL.GET_AUTO_FLUSH:
          return this.autoFlush;

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
   * Mendaftarkan node /dev/lcd. Kernel memanggil init() belakangan, jadi
   * hardware baru dibuka setelah semua driver terdaftar.
   */
  static autoRegister(kernel: any): void {
    try {
      if (!kernel || typeof kernel !== "object" || !kernel.devices) return;
      kernel.devices["lcd"] = new LM6029Device();
    } catch (e: any) {
      // Hardware tidak ada bukan error fatal — node cukup tidak terdaftar.
    }
  }

  // ================================================================
  // INTERNAL
  // ================================================================

  /** Info status (dipakai read() & LCDIOCTL.GET_INFO). */
  public getInfo(): Record<string, any> {
    const alive = this.initialized && !!this.lcd;
    return {
      device: `/dev/${this.name}`,
      available: alive,
      width: this.width,
      height: this.height,
      pages: LCD_PAGES,
      framebufferSize: LCD_FRAMEBUFFER_SIZE,
      spiSpeed: alive ? this.safe(() => this.lcd!.getSpiSpeed()) : null,
      spiDevice: alive
        ? this.safe(() => this.lcd!.getSpiDevicePath?.() ?? null)
        : null,
      contrast: alive ? this.safe(() => this.lcd!.getContrast()) : null,
      backlight: alive ? this.safe(() => this.lcd!.getBacklight()) : null,
      invert: alive ? this.safe(() => this.lcd!.getDisplayInvert()) : null,
      displayOn: alive ? this.safe(() => this.lcd!.isDisplayOn()) : null,
      autoFlush: this.autoFlush,
      readRefs: this.readRefs,
      writeRefs: this.writeRefs,
      frames: this.frames,
      lastError: this.lastError,
    };
  }

  /** Flush buffer → panel, hitung frame. */
  private flush(): void {
    if (!this.lcd) return;
    this.lcd.display();
    this.frames++;
  }

  /** Jalankan op dari `write({ op, args })`. */
  private applyOp(op: string, args: any[]): any {
    if (!this.lcd || !WRITE_OPS.has(op)) return null;
    const lcd = this.lcd;

    switch (op) {
      case "clear":
      case "clearDisplay":
        lcd.clear();
        return true;
      case "display":
      case "flush":
        this.flush();
        return true;
      case "fillScreen":
        lcd.fillScreen(args[0] === undefined ? 1 : num(args[0]));
        return true;
      case "drawPixel":
        lcd.drawPixel(num(args[0]), num(args[1]), args[2] === undefined ? 1 : num(args[2]));
        return true;
      case "drawLine":
        lcd.drawLine(num(args[0]), num(args[1]), num(args[2]), num(args[3]), args[4] === undefined ? 1 : num(args[4]));
        return true;
      case "drawRect":
        lcd.drawRect(num(args[0]), num(args[1]), num(args[2]), num(args[3]), args[4] === undefined ? 1 : num(args[4]));
        return true;
      case "fillRect":
        lcd.fillRect(num(args[0]), num(args[1]), num(args[2]), num(args[3]), args[4] === undefined ? 1 : num(args[4]));
        return true;
      case "drawCircle":
        lcd.drawCircle(num(args[0]), num(args[1]), num(args[2]), args[3] === undefined ? 1 : num(args[3]));
        return true;
      case "fillCircle":
        lcd.fillCircle(num(args[0]), num(args[1]), num(args[2]), args[3] === undefined ? 1 : num(args[3]));
        return true;
      case "drawTriangle":
        lcd.drawTriangle(num(args[0]), num(args[1]), num(args[2]), num(args[3]), num(args[4]), num(args[5]), args[6] === undefined ? 1 : num(args[6]));
        return true;
      case "fillTriangle":
        lcd.fillTriangle(num(args[0]), num(args[1]), num(args[2]), num(args[3]), num(args[4]), num(args[5]), args[6] === undefined ? 1 : num(args[6]));
        return true;
      case "drawRoundRect":
        lcd.drawRoundRect(num(args[0]), num(args[1]), num(args[2]), num(args[3]), num(args[4]), args[5] === undefined ? 1 : num(args[5]));
        return true;
      case "fillRoundRect":
        lcd.fillRoundRect(num(args[0]), num(args[1]), num(args[2]), num(args[3]), num(args[4]), args[5] === undefined ? 1 : num(args[5]));
        return true;
      case "drawBitmap":
        lcd.drawBitmap(num(args[0]), num(args[1]), asBuffer(args[2]), num(args[3]), num(args[4]), args[5] === undefined ? 1 : num(args[5]));
        return true;
      case "setFont":
        lcd.setFont(num(args[0]));
        return true;
      case "setTextColor":
        if (args[1] === undefined) lcd.setTextColor(num(args[0]));
        else lcd.setTextColor(num(args[0]), num(args[1]));
        return true;
      case "setTextSize":
        lcd.setTextSize(num(args[0]));
        return true;
      case "setTextWrap":
        lcd.setTextWrap(bool(args[0]));
        return true;
      case "setCursor":
        lcd.setCursor(num(args[0]), num(args[1]));
        return true;
      case "print":
        lcd.print(String(args[0] ?? ""));
        return true;
      case "printText":
        lcd.printText(String(args[0] ?? ""), num(args[1]), num(args[2]), args[3] === undefined ? 1 : num(args[3]));
        return true;
      case "setRotation":
        lcd.setRotation(num(args[0]));
        this.width = num(lcd.getWidth()) || this.width;
        this.height = num(lcd.getHeight()) || this.height;
        return true;
      case "setContrast":
        lcd.setContrast(Math.max(0, Math.min(63, num(args[0]))));
        return true;
      case "setBacklight":
        lcd.setBacklight(bool(args[0]));
        return true;
      case "setDisplayInvert":
        lcd.setDisplayInvert(bool(args[0]));
        return true;
      case "setDisplayOn":
        lcd.setDisplayOn(bool(args[0]));
        return true;
      case "setSpiSpeed":
        lcd.setSpiSpeed(num(args[0]));
        return true;
      default:
        return null;
    }
  }

  /** Ambil handle native: inject > override path > require kandidat. */
  private getNative(): LM6029NativeHandle | null {
    if (this.lcd) return this.lcd;
    if (this.injected) {
      this.lcd = this.injected;
      return this.lcd;
    }

    const mod = this.loadAddonModule();
    if (!mod || typeof mod.LM6029LCD !== "function") return null;

    this.lcd = new mod.LM6029LCD();
    return this.lcd;
  }

  /** Cari & muat modul native (di-cache, termasuk kegagalan). */
  private loadAddonModule(): LM6029NativeModule | null {
    if (this.addonModule !== undefined) return this.addonModule;

    const candidates: string[] = [];
    if (this.addonPathOverride) candidates.push(this.addonPathOverride);
    if (process.env.TSIX_LCD_ADDON_PATH)
      candidates.push(process.env.TSIX_LCD_ADDON_PATH);
    // Paket npm (nama sekarang + alias lama) — jalur produksi.
    candidates.push(...ADDON_MODULE_NAMES);
    // Sibling repo saat development di mesin yang sama.
    candidates.push(path.join(os.homedir(), "lm6029acw"));
    candidates.push(path.join(os.homedir(), "raspi-lcd-addon"));
    // <repo>/src/kernel/devices/aux-devices → naik 5 level ke <home>.
    candidates.push(
      path.resolve(__dirname, "..", "..", "..", "..", "..", "lm6029acw"),
    );
    candidates.push(
      path.resolve(__dirname, "..", "..", "..", "..", "..", "raspi-lcd-addon"),
    );

    for (const cand of candidates) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require(cand);
        if (mod && typeof mod.LM6029LCD === "function") {
          this.addonModule = mod as LM6029NativeModule;
          return this.addonModule;
        }
      } catch (_) {
        // Coba kandidat berikutnya.
      }
    }

    this.addonModule = null;
    return null;
  }

  /** Panggil fungsi native dengan aman (untuk getInfo). */
  private safe(fn: () => any): any {
    try {
      return fn();
    } catch (e: any) {
      this.lastError = e?.message || String(e);
      return null;
    }
  }

  /** Log ke syslog kernel bila tersedia. */
  private log(msg: string): void {
    try {
      this.kctx?.syslog(`[lcd] ${msg}`);
    } catch (_) {
      /* ignore */
    }
  }

  /** Catat error runtime + syslog. */
  private fail(where: string, e: any): void {
    const msg = e?.message || String(e);
    this.lastError = `${where}: ${msg}`;
    console.error(`[LM6029] ${where} error: ${msg}`);
    this.log(`${where} error: ${msg}`);
  }
}

// Plugin Export: harus export default class yang implement IDevice
export default LM6029Device;
