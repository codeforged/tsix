/**
 * PLCD DEVICE (/dev/plcd) — PSEUDO LCD (EMULATOR) 128x64 MONOKROM
 *
 * "Panel palsu" yang menipu userland: nomor ioctl, bentuk argumen, mode
 * penulisan, dan perilaku frame-nya SAMA PERSIS dengan driver asli
 * (`LM6029Device` / `/dev/lcd`) — bedanya, semua gambar diraster oleh
 * software ke framebuffer RAM (1024 byte, 1 bpp MSB-first), bukan dikirim ke
 * bus SPI. Aplikasi yang memakai `lcdLib` (atau menulis langsung ke
 * `/dev/lcd`) bisa diarahkan ke sini tanpa perubahan kode:
 *
 *     TSIX_LCD_DEV=/dev/plcd  ./app.js      # singleton `lcd` ikut pindah
 *     new LcdLib().setDevicePath("/dev/plcd")
 *
 * Untuk melihat "panel"-nya, jalankan aplikasi emulator GUI (browser/DDC)
 * yang mem-poll ioctl `PLCDIOCTL.GET_REV` lalu menarik frame lewat
 * `PLCDIOCTL.GET_FRAME` (base64 1024 byte) dan menggambarnya di canvas.
 *
 * ── SEMANTIK YANG SENGAJA DISAMAKAN DENGAN HARDWARE ──
 *  - DD-RAM terpisah dari yang tampil: `clear()`/gambar hanya mengubah buffer
 *    kerja; `display()`/`flush()` yang memindahkannya ke panel (→ `rev` naik).
 *    Jadi `rev` = "isi panel berubah", bukan "ada perintah gambar".
 *  - `write(Buffer 1024 byte)` = SATU FRAME UTUH yang MENGGANTI isi layar
 *    (buffer dibersihkan dulu, ala `dd`). Buffer lebih pendek = teks.
 *  - `SET_INVERT` / `SET_DISPLAY_ON` adalah properti tampilan panel, bukan isi
 *    DD-RAM: `GET_FRAME` mengembalikan byte mentah + flag-nya, viewer yang
 *    menerapkan efeknya (persis seperti kaca panel).
 *  - `rotation` 0..3 memakai pemetaan koordinat Adafruit_GFX; `GET_WIDTH` /
 *    `GET_HEIGHT` ikut bertukar saat rotasi 1/3.
 *
 * ── FONT ──
 *  - id 0 (dan id tak dikenal) → font 5x8 klasik dari `glcdfont.c` addon
 *    (`lcdFontClassic.ts`): byte-nya SAMA dengan yang tampil di panel fisik
 *    saat addon memakai `setFont(0)`/`setFont(NULL)`.
 *  - id 1..3 → data glyph Adafruit_GFX asli dari addon (`lcdFonts.ts`).
 *  - Karakter di luar jangkauan font (mis. panah U+2192) memakai tabel
 *    ekstensi `plcdFont5x7.ts`; yang tidak ada di situ digambar kotak kosong.
 *
 * ── BATASAN (jujur, karena ini emulator) ──
 *  - Kurva (circle/roundRect) memakai rasterisasi software sendiri; bisa
 *    berbeda 1 px dari Adafruit_GFX asli.
 *  - Tidak ada SPI, jadi `GET_SPI_SPEED` → null dan `SET_SPI_SPEED` no-op.
 *
 * (c) 2026 TSIX Project
 */

import { IDevice, KContext } from "../IDevice";
import {
  LCDIOCTL,
  LCD_WIDTH,
  LCD_HEIGHT,
  LCD_PAGES,
  LCD_FRAMEBUFFER_SIZE,
  asBuffer,
  boolFrom,
  num,
  positional,
  toByteBuffer,
} from "./LM6029Device";
import {
  PLCD_FONT_H,
  PLCD_FONT_W,
  plcdGlyph,
  rowsToGlyph,
} from "./plcdFont5x7";
import { LCD_GFX_FONTS, type LcdGfxFont } from "./lcdFonts";
import {
  LCD_CLASSIC_FONTS,
  type LcdClassicFont,
} from "./lcdFontClassic";

/** Warna piksel panel monokrom: 1 = nyala, 0 = mati. */
type Pix = 0 | 1;

/** Glyph pengganti untuk karakter yang belum ada di tabel font. */
const FALLBACK_GLYPH = rowsToGlyph("#####/#...#/#...#/#...#/#...#/#...#/#####");

/**
 * Cache bitmap font Adafruit_GFX: id font → byte (decode base64 sekali saja).
 * Ukurannya kecil (844–2186 byte per font), jadi aman ditahan di memori.
 */
const _gfxBitmapCache = new Map<number, Uint8Array>();

/** Ambil bitmap font GFX (null kalau data rusak / id tidak punya GFX font). */
function gfxBitmaps(fontId: number, font: LcdGfxFont): Uint8Array | null {
  const cached = _gfxBitmapCache.get(fontId);
  if (cached) return cached;
  try {
    const bytes = new Uint8Array(Buffer.from(font.bitmaps, "base64"));
    _gfxBitmapCache.set(fontId, bytes);
    return bytes;
  } catch (e: any) {
    return null;
  }
}

/** Cache bitmap font klasik 5x8: id font → byte (decode base64 sekali saja). */
const _classicBitmapCache = new Map<number, Uint8Array>();

/** Ambil bitmap font klasik (null kalau data rusak). */
function classicBitmaps(
  fontId: number,
  font: LcdClassicFont,
): Uint8Array | null {
  const cached = _classicBitmapCache.get(fontId);
  if (cached) return cached;
  try {
    const bytes = new Uint8Array(Buffer.from(font.bitmaps, "base64"));
    if (!bytes.length) return null;
    _classicBitmapCache.set(fontId, bytes);
    return bytes;
  } catch (e: any) {
    return null;
  }
}

/** Nama font efektif untuk GET_INFO (id tak dikenal → nama font klasik). */
function fontNameOf(fontId: number): string {
  const gfx = LCD_GFX_FONTS[fontId];
  if (gfx) return gfx.name;
  return (LCD_CLASSIC_FONTS[fontId] ?? LCD_CLASSIC_FONTS[0]).name;
}

// ================================================================
// IOCTL KHAS PSEUDO-DEVICE (namespace 0x4C, lanjutan milik LM6029Device)
// ================================================================

export enum PLCDIOCTL {
  /**
   * arg: null → `{ rev, frames, width, height, invert, displayOn, backlight,
   * contrast, rotation, fb }` — `fb` = base64 dari 1024 byte DD-RAM panel.
   * Dipakai aplikasi emulator (viewer) untuk menggambar isi panel.
   */
  GET_FRAME = 0x4c50,
  /**
   * arg: null → number. Revisi panel: naik HANYA saat flush (isi panel benar-
   * benar berubah). Viewer cukup poll ini (murah) sebelum menarik frame.
   */
  GET_REV = 0x4c51,
}

// ================================================================
// DRIVER
// ================================================================

export class PLCDDevice implements IDevice {
  public name: string;
  public uid = 0;
  public gid = 0;
  /** Default 0666 — sama seperti /dev/lcd: display bersama. */
  public mode = 0o666;
  public disabled: boolean;

  private kctx: KContext | null = null;

  /** DD-RAM — buffer gambar (belum tentu tampil). */
  private workFb = new Uint8Array(LCD_FRAMEBUFFER_SIZE);
  /** Isi panel yang sedang tampil (hasil flush terakhir). */
  private panelFb = new Uint8Array(LCD_FRAMEBUFFER_SIZE);
  /** Revisi panel (naik saat flush) & jumlah frame yang sudah di-flush. */
  private rev = 0;
  private frames = 0;

  // ── State hardware yang ditiru ──
  private contrast = 31;
  private backlight = true;
  private invert = false;
  private displayOn = true;
  private rotation = 0;
  private autoFlush = true;

  // ── State teks ──
  private fontId = 0;
  private textColor: Pix = 1;
  /** null = mode transparan (latar tidak ditulis). */
  private textBg: Pix | null = null;
  private textSize = 1;
  private textWrap = true;
  private cursorX = 0;
  private cursorY = 0;

  private readRefs = 0;
  private writeRefs = 0;
  private lastError: string | null = null;

  constructor(options: { name?: string; disabled?: boolean } = {}) {
    this.name = options.name || "plcd";
    this.disabled = options.disabled === true;
  }

  // ================================================================
  // LIFECYCLE (IDevice)
  // ================================================================

  /** Pseudo-device selalu "siap" — tidak ada hardware yang perlu dibuka. */
  public init(ctx: KContext): void {
    this.kctx = ctx;
    if (this.disabled) {
      this.log("Driver dinonaktifkan (disabled=true), dilewati.");
      return;
    }
    this.log(
      `PLCD siap (PSEUDO ${LCD_WIDTH}x${LCD_HEIGHT} mono, tanpa SPI) di /dev/${this.name}` +
        ` — arahkan app ke sini dengan TSIX_LCD_DEV=/dev/${this.name}`,
    );
  }

  /** Selalu true: panel pseudo hidup selama driver terdaftar di kernel. */
  public open(): boolean {
    return !this.disabled;
  }

  public close(): boolean {
    return true;
  }

  public present(): boolean {
    return !this.disabled;
  }

  // ================================================================
  // I/O (IDevice)
  // ================================================================

  /** read() → snapshot status sebagai JSON string (termasuk `rev`). */
  public read(): any {
    return JSON.stringify(this.getInfo());
  }

  /**
   * write(): string → teks di cursor; Buffer 1024 byte → SATU FRAME utuh
   * (mengganti isi layar); Buffer lain → teks; `{ op, args }` → primitive GFX.
   * Auto-flush mengikuti `setAutoFlush()` (default ON, seperti hardware).
   */
  public write(data: any): boolean {
    if (this.disabled) return false;
    try {
      const raw = toByteBuffer(data);
      if (raw) {
        if (raw.length === LCD_FRAMEBUFFER_SIZE) {
          // Frame penuh: buffer dibersihkan dulu supaya frame baru MENGGANTI
          // isi layar (bukan menumpuk di atas gambar lama).
          this.clearWork();
          this.drawMonoBitmap(0, 0, raw, LCD_WIDTH, LCD_HEIGHT, 1);
        } else {
          this.print(raw.toString("utf8"));
        }
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

  /** ioctl(): kontrak `LCDIOCTL` yang sama dengan LM6029Device + PLCDIOCTL. */
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

    if (this.disabled) return null;

    try {
      switch (cmd) {
        // ── Lifecycle ──
        case LCDIOCTL.BEGIN:
          return true;
        case LCDIOCTL.RESET:
          this.clearWork();
          this.flush();
          return true;
        case LCDIOCTL.CLEAR:
          this.clearWork();
          return true;
        case LCDIOCTL.DISPLAY:
          this.flush();
          return true;

        // ── Primitive GFX ──
        case LCDIOCTL.DRAW_PIXEL: {
          const [x, y, color] = positional(arg, ["x", "y", "color"]);
          this.setPixel(num(x), num(y), this.pix(color, 1));
          return true;
        }
        case LCDIOCTL.FILL_SCREEN: {
          const [color] = positional(arg, ["color"]);
          this.fillScreen(this.pix(color, 1));
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
          this.line(num(x0), num(y0), num(x1), num(y1), this.pix(color, 1));
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
          if (cmd === LCDIOCTL.DRAW_RECT)
            this.rect(num(x), num(y), num(w), num(h), this.pix(color, 1));
          else
            this.fillRect(num(x), num(y), num(w), num(h), this.pix(color, 1));
          return true;
        }
        case LCDIOCTL.DRAW_CIRCLE:
        case LCDIOCTL.FILL_CIRCLE: {
          const [x, y, r, color] = positional(arg, ["x", "y", "r", "color"]);
          if (cmd === LCDIOCTL.DRAW_CIRCLE)
            this.circle(num(x), num(y), num(r), this.pix(color, 1));
          else this.fillCircle(num(x), num(y), num(r), this.pix(color, 1));
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
          const c = this.pix(color, 1);
          if (cmd === LCDIOCTL.DRAW_TRIANGLE)
            this.triangle(num(x0), num(y0), num(x1), num(y1), num(x2), num(y2), c);
          else
            this.fillTriangle(
              num(x0),
              num(y0),
              num(x1),
              num(y1),
              num(x2),
              num(y2),
              c,
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
          if (cmd === LCDIOCTL.DRAW_ROUND_RECT)
            this.roundRect(
              num(x),
              num(y),
              num(w),
              num(h),
              num(r),
              this.pix(color, 1),
            );
          else
            this.fillRoundRect(
              num(x),
              num(y),
              num(w),
              num(h),
              num(r),
              this.pix(color, 1),
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
          this.drawMonoBitmap(
            num(x),
            num(y),
            asBuffer(data),
            num(w),
            num(h),
            this.pix(color, 1),
          );
          return true;
        }

        // ── Teks (semua font id digambar dengan bitmap 5x7 bawaan) ──
        case LCDIOCTL.SET_FONT: {
          const [id] = positional(arg, ["id"]);
          this.fontId = num(id);
          return this.fontId;
        }
        case LCDIOCTL.SET_TEXT_COLOR: {
          const [color, bg] = positional(arg, ["color", "bg"]);
          this.textColor = this.pix(color, 1);
          this.textBg = bg === undefined ? null : this.pix(bg, 0);
          return true;
        }
        case LCDIOCTL.SET_TEXT_SIZE: {
          const [size] = positional(arg, ["size"]);
          this.textSize = Math.max(1, Math.floor(num(size)) || 1);
          return true;
        }
        case LCDIOCTL.SET_TEXT_WRAP:
          this.textWrap = boolFrom(arg, ["wrap"]);
          return true;
        case LCDIOCTL.SET_CURSOR: {
          const [x, y] = positional(arg, ["x", "y"]);
          this.cursorX = num(x);
          this.cursorY = num(y);
          return true;
        }
        case LCDIOCTL.PRINT: {
          const [text] = positional(arg, ["text"]);
          this.print(String(text ?? ""));
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
          this.printText(
            String(text ?? ""),
            num(x),
            num(y),
            size === undefined ? this.textSize : Math.max(1, Math.floor(num(size))),
          );
          if (this.autoFlush) this.flush();
          return true;
        }
        case LCDIOCTL.SET_ROTATION: {
          const [rotation] = positional(arg, ["rotation"]);
          this.rotation = ((Math.floor(num(rotation)) % 4) + 4) % 4;
          return this.rotation;
        }

        // ── Kontrol tampilan ──
        case LCDIOCTL.SET_CONTRAST: {
          const [level] = positional(arg, ["level"]);
          this.contrast = Math.max(0, Math.min(63, num(level)));
          return this.contrast;
        }
        case LCDIOCTL.GET_CONTRAST:
          return this.contrast;
        case LCDIOCTL.SET_BACKLIGHT:
          this.backlight = boolFrom(arg, ["on", "value"]);
          return this.backlight;
        case LCDIOCTL.GET_BACKLIGHT:
          return this.backlight;
        case LCDIOCTL.SET_INVERT:
          this.invert = boolFrom(arg, ["invert", "on", "value"]);
          return this.invert;
        case LCDIOCTL.GET_INVERT:
          return this.invert;
        case LCDIOCTL.SET_DISPLAY_ON:
          this.displayOn = boolFrom(arg, ["on", "value"]);
          return this.displayOn;
        case LCDIOCTL.IS_DISPLAY_ON:
          return this.displayOn;
        case LCDIOCTL.SET_SPI_SPEED:
          // Tidak ada SPI di pseudo-device — diterima tapi no-op.
          return 0;
        case LCDIOCTL.GET_SPI_SPEED:
          return null;

        // ── Info & tuning ──
        case LCDIOCTL.GET_INFO:
          return this.getInfo();
        case LCDIOCTL.GET_WIDTH:
          return this.logicalWidth();
        case LCDIOCTL.GET_HEIGHT:
          return this.logicalHeight();
        case LCDIOCTL.SET_AUTO_FLUSH:
          this.autoFlush = boolFrom(arg, ["on", "autoFlush", "value"]);
          return this.autoFlush;
        case LCDIOCTL.GET_AUTO_FLUSH:
          return this.autoFlush;

        // ── Khas pseudo-device (dipakai viewer/emulator) ──
        case PLCDIOCTL.GET_REV:
          return this.rev;
        case PLCDIOCTL.GET_FRAME:
          return {
            rev: this.rev,
            frames: this.frames,
            width: this.logicalWidth(),
            height: this.logicalHeight(),
            invert: this.invert,
            displayOn: this.displayOn,
            backlight: this.backlight,
            contrast: this.contrast,
            rotation: this.rotation,
            autoFlush: this.autoFlush,
            fb: Buffer.from(this.panelFb).toString("base64"),
          };

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

  /** Mendaftarkan node `/dev/plcd`. Aman dipanggil walau hardware tidak ada. */
  static autoRegister(kernel: any): void {
    try {
      if (!kernel || typeof kernel !== "object" || !kernel.devices) return;
      kernel.devices["plcd"] = new PLCDDevice();
    } catch (_) {
      /* registrasi gagal bukan error fatal */
    }
  }

  // ================================================================
  // STATUS
  // ================================================================

  /** Info status (dipakai read() & LCDIOCTL.GET_INFO). */
  public getInfo(): Record<string, any> {
    return {
      device: `/dev/${this.name}`,
      available: true,
      /** Penanda bahwa ini panel palsu (hardware asli: undefined). */
      pseudo: true,
      width: this.logicalWidth(),
      height: this.logicalHeight(),
      pages: LCD_PAGES,
      framebufferSize: LCD_FRAMEBUFFER_SIZE,
      spiSpeed: null,
      spiDevice: null,
      contrast: this.contrast,
      backlight: this.backlight,
      invert: this.invert,
      displayOn: this.displayOn,
      autoFlush: this.autoFlush,
      rotation: this.rotation,
      font: this.fontId,
      /** Nama font efektif (id 0 = glcdfont, 1..3 = font Adafruit_GFX addon). */
      fontName: fontNameOf(this.fontId),
      /** true = cursorY adalah baseline (font GFX), false = sudut atas glyph. */
      cursorBaseline: !!LCD_GFX_FONTS[this.fontId],
      textSize: this.textSize,
      textColor: this.textColor,
      textBg: this.textBg,
      textWrap: this.textWrap,
      cursorX: this.cursorX,
      cursorY: this.cursorY,
      rev: this.rev,
      frames: this.frames,
      readRefs: this.readRefs,
      writeRefs: this.writeRefs,
      lastError: this.lastError,
    };
  }

  /** Salinan DD-RAM yang sedang tampil (1024 byte) — untuk viewer/test. */
  public snapshot(): Uint8Array {
    return this.panelFb.slice();
  }

  // ================================================================
  // GEOMETRI & PIKEL
  // ================================================================

  private logicalWidth(): number {
    return this.rotation % 2 === 1 ? LCD_HEIGHT : LCD_WIDTH;
  }

  private logicalHeight(): number {
    return this.rotation % 2 === 1 ? LCD_WIDTH : LCD_HEIGHT;
  }

  private pix(v: any, fallback: Pix): Pix {
    if (v === undefined || v === null) return fallback;
    return num(v) ? 1 : 0;
  }

  /** Tulis piksel di ruang LOGIKA (mengikuti rotation ala Adafruit_GFX). */
  private setPixel(x: number, y: number, color: Pix): void {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.logicalWidth() || y >= this.logicalHeight())
      return;

    let px = x;
    let py = y;
    switch (this.rotation) {
      case 1:
        px = LCD_WIDTH - 1 - y;
        py = x;
        break;
      case 2:
        px = LCD_WIDTH - 1 - x;
        py = LCD_HEIGHT - 1 - y;
        break;
      case 3:
        px = y;
        py = LCD_HEIGHT - 1 - x;
        break;
    }
    this.setPanelPixel(px, py, color);
  }

  /** Tulis piksel di ruang PANEL (sudah final, tanpa rotasi). */
  private setPanelPixel(px: number, py: number, color: Pix): void {
    if (px < 0 || px >= LCD_WIDTH || py < 0 || py >= LCD_HEIGHT) return;
    const idx = py * (LCD_WIDTH / 8) + (px >> 3);
    const mask = 0x80 >> (px & 7);
    if (color) this.workFb[idx] |= mask;
    else this.workFb[idx] &= ~mask & 0xff;
  }

  private clearWork(): void {
    this.workFb.fill(0);
  }

  /** Pindahkan buffer kerja → panel. Hanya di sini `rev` naik. */
  private flush(): void {
    this.panelFb.set(this.workFb);
    this.frames++;
    this.rev++;
  }

  // ================================================================
  // PRIMITIVE GFX (software rasterizer)
  // ================================================================

  private fillScreen(color: Pix): void {
    for (let y = 0; y < this.logicalHeight(); y++)
      this.hLine(0, y, this.logicalWidth(), color);
  }

  private hLine(x: number, y: number, w: number, color: Pix): void {
    for (let i = 0; i < w; i++) this.setPixel(x + i, y, color);
  }

  private vLine(x: number, y: number, h: number, color: Pix): void {
    for (let i = 0; i < h; i++) this.setPixel(x, y + i, color);
  }

  /** Garis Bresenham (midpoint). */
  private line(x0: number, y0: number, x1: number, y1: number, color: Pix): void {
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

  private rect(x: number, y: number, w: number, h: number, color: Pix): void {
    if (w <= 0 || h <= 0) return;
    if (w === 1) return this.vLine(x, y, h, color);
    if (h === 1) return this.hLine(x, y, w, color);
    this.hLine(x, y, w, color);
    this.hLine(x, y + h - 1, w, color);
    this.vLine(x, y, h, color);
    this.vLine(x + w - 1, y, h, color);
  }

  private fillRect(x: number, y: number, w: number, h: number, color: Pix): void {
    for (let j = 0; j < h; j++) this.hLine(x, y + j, w, color);
  }

  /** Lingkaran (midpoint algorithm, sama seperti LcdFramebuffer userland). */
  private circle(cx: number, cy: number, r: number, color: Pix): void {
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

  private fillCircle(cx: number, cy: number, r: number, color: Pix): void {
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
    color: Pix,
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
    color: Pix,
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
   * Aproksimasi rasterisasi software — boleh beda 1 px dari Adafruit_GFX.
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
    color: Pix,
  ): void {
    if (w <= 0 || h <= 0) return;
    r = Math.max(0, Math.floor(r));
    if (r === 0) return this.rect(x, y, w, h, color);
    const rr = Math.min(r, Math.floor(Math.min(w, h) / 2));
    for (let i = 0; i < h; i++) {
      const fromTop = i < rr;
      const fromBottom = i >= h - rr;
      const inset = fromTop
        ? this.cornerInset(i, rr)
        : fromBottom
          ? this.cornerInset(h - 1 - i, rr)
          : 0;
      const xL = x + inset;
      const xR = x + w - 1 - inset;
      if (xL > xR) continue;
      if (i === 0 || i === h - 1) {
        // Sisi datar atas/bawah: hanya di baris pertama & terakhir.
        this.hLine(xL, y + i, xR - xL + 1, color);
      } else {
        // Baris lain: dua titik tepi (busur di sudut, atau sisi vertikal).
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
    color: Pix,
  ): void {
    if (w <= 0 || h <= 0) return;
    r = Math.max(0, Math.floor(r));
    if (r === 0) return this.fillRect(x, y, w, h, color);
    const rr = Math.min(r, Math.floor(Math.min(w, h) / 2));
    for (let i = 0; i < h; i++) {
      const fromTop = i < rr;
      const fromBottom = i >= h - rr;
      const inset = fromTop
        ? this.cornerInset(i, rr)
        : fromBottom
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
   * Bit 1 → piksel `color`; bit 0 → dilewati (transparan), sama seperti
   * addon hardware.
   */
  private drawMonoBitmap(
    x: number,
    y: number,
    data: Uint8Array,
    w: number,
    h: number,
    color: Pix,
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

  // ================================================================
  // TEKS
  // ================================================================

  /** Cetak di posisi cursor aktif lalu majukan cursor (gaya Adafruit print). */
  private print(text: string): void {
    this.drawText(text, this.cursorX, this.cursorY, this.textSize);
  }

  /**
   * Cetak di (x,y) tanpa mengubah cursor permanen — sama dengan kontrak
   * `LCDIOCTL.PRINT_TEXT` (cursor disimpan & dipulihkan).
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
   * Raster teks ke framebuffer + majukan cursor (wrap bila diaktifkan).
   * Id 1..3 memakai data glyph Adafruit_GFX asli (`lcdFonts.ts`); id lain
   * (0 dan id tak dikenal) memakai font 5x8 klasik `glcdfont.c`
   * (`lcdFontClassic.ts`) — sama seperti `setFont(0)` di addon.
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
   * tinggi baris 8 px — metrik & byte glyph persis `Adafruit_GFX::write`.
   *
   * Dua perilaku Adafruit yang ikut ditiru:
   *   - `_cp437` bawaannya false → kode ≥ 176 digeser +1 (`if (!_cp437 &&
   *     (c >= 176)) c++`). Kode yang lewat batas tabel (0xFF → 256) tidak
   *     di baca di luar array (sampah di hardware) tapi jadi kotak.
   *   - mode opaque (`setTextColor(color, bg)`) mengisi SELURUH sel 6x8,
   *     termasuk kolom pemisah di kanan glyph.
   * Karakter di luar 0..255 (mis. panah U+2192) memakai tabel ekstensi TSIX.
   */
  private drawText5x7(
    text: string,
    x: number,
    y: number,
    sz: number,
    font: LcdClassicFont,
  ): void {
    const bm = classicBitmaps(this.fontId, font);
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
      if (code === null) this.drawGlyph(cx, cy, ch, sz);
      else this.drawClassicGlyph(cx, cy, code, sz, font, bm);
      cx += advance;
    }
    this.cursorX = cx;
    this.cursorY = cy;
  }

  /**
   * Kode byte karakter untuk font klasik, atau null kalau karakter itu tidak
   * bisa dialamatkan font ini (di luar 0..255) — di situ glyph ekstensi TSIX
   * (`plcdFont5x7.ts`) yang dipakai.
   */
  private classicCode(ch: string, font: LcdClassicFont): number | null {
    const c = ch.charCodeAt(0);
    if (c > 0xff) return null;
    // `_cp437` di Adafruit_GFX bawaannya false → kode ≥ 176 digeser +1.
    const code = c >= 176 ? c + 1 : c;
    return code < font.glyphCount ? code : null;
  }

  /**
   * Gambar satu glyph font klasik (5 kolom × 8 baris; bit0 = baris paling
   * atas — sama dengan `_displayBuffer[...] |= 1 << (y%8)` di addon).
   */
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
   * Jalur font Adafruit_GFX (glyph asli dari addon, mis. FreeMono9pt7b).
   *
   * Dua beda penting dari font 5x7 — keduanya meniru hardware:
   *   1. `cursorY` adalah BASELINE (bukan sudut atas glyph): glyph digambar di
   *      `(cursorX + xOffset, cursorY + yOffset)`, dan baris baru menambah
   *      `yAdvance`.
   *   2. Bitmap dibaca KONTINU: satu byte untuk 8 piksel berikutnya tanpa
   *      padding antar-baris (persis loop `Adafruit_GFX::write`).
   * Karakter di luar rentang font dilewati tanpa memajukan cursor (juga
   * mengikuti Adafruit).
   */
  private drawTextGfx(
    text: string,
    x: number,
    y: number,
    size: number,
    font: LcdGfxFont,
  ): void {
    const bm = gfxBitmaps(this.fontId, font);
    if (!bm) {
      // Data GFX tak terbaca → pakai font klasik (glcdfont) supaya teks tetap
      // tampil, bukan hilang tanpa jejak.
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
      if (this.textBg !== null)
        this.fillRect(gx, gy, w * size, h * size, this.textBg);

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

  /** Gambar satu glyph (5x7) dengan skala `size`, warna teks/latar aktif. */
  private drawGlyph(x: number, y: number, ch: string, size: number): void {
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
    switch (op) {
      case "clear":
      case "clearDisplay":
        this.clearWork();
        return true;
      case "display":
      case "flush":
        this.flush();
        return true;
      case "fillScreen":
        this.fillScreen(this.pix(args[0], 1));
        return true;
      case "drawPixel":
        this.setPixel(num(args[0]), num(args[1]), this.pix(args[2], 1));
        return true;
      case "drawLine":
        this.line(
          num(args[0]),
          num(args[1]),
          num(args[2]),
          num(args[3]),
          this.pix(args[4], 1),
        );
        return true;
      case "drawRect":
        this.rect(
          num(args[0]),
          num(args[1]),
          num(args[2]),
          num(args[3]),
          this.pix(args[4], 1),
        );
        return true;
      case "fillRect":
        this.fillRect(
          num(args[0]),
          num(args[1]),
          num(args[2]),
          num(args[3]),
          this.pix(args[4], 1),
        );
        return true;
      case "drawCircle":
        this.circle(
          num(args[0]),
          num(args[1]),
          num(args[2]),
          this.pix(args[3], 1),
        );
        return true;
      case "fillCircle":
        this.fillCircle(
          num(args[0]),
          num(args[1]),
          num(args[2]),
          this.pix(args[3], 1),
        );
        return true;
      case "drawTriangle":
        this.triangle(
          num(args[0]),
          num(args[1]),
          num(args[2]),
          num(args[3]),
          num(args[4]),
          num(args[5]),
          this.pix(args[6], 1),
        );
        return true;
      case "fillTriangle":
        this.fillTriangle(
          num(args[0]),
          num(args[1]),
          num(args[2]),
          num(args[3]),
          num(args[4]),
          num(args[5]),
          this.pix(args[6], 1),
        );
        return true;
      case "drawRoundRect":
        this.roundRect(
          num(args[0]),
          num(args[1]),
          num(args[2]),
          num(args[3]),
          num(args[4]),
          this.pix(args[5], 1),
        );
        return true;
      case "fillRoundRect":
        this.fillRoundRect(
          num(args[0]),
          num(args[1]),
          num(args[2]),
          num(args[3]),
          num(args[4]),
          this.pix(args[5], 1),
        );
        return true;
      case "drawBitmap":
        this.drawMonoBitmap(
          num(args[0]),
          num(args[1]),
          asBuffer(args[2]),
          num(args[3]),
          num(args[4]),
          this.pix(args[5], 1),
        );
        return true;
      case "setFont":
        this.fontId = num(args[0]);
        return true;
      case "setTextColor":
        this.textColor = this.pix(args[0], 1);
        this.textBg = args[1] === undefined ? null : this.pix(args[1], 0);
        return true;
      case "setTextSize":
        this.textSize = Math.max(1, Math.floor(num(args[0])) || 1);
        return true;
      case "setTextWrap":
        this.textWrap = !!args[0];
        return true;
      case "setCursor":
        this.cursorX = num(args[0]);
        this.cursorY = num(args[1]);
        return true;
      case "print":
        this.print(String(args[0] ?? ""));
        return true;
      case "printText":
        this.printText(
          String(args[0] ?? ""),
          num(args[1]),
          num(args[2]),
          args[3] === undefined ? this.textSize : num(args[3]),
        );
        return true;
      case "setRotation":
        this.rotation = ((Math.floor(num(args[0])) % 4) + 4) % 4;
        return true;
      case "setContrast":
        this.contrast = Math.max(0, Math.min(63, num(args[0])));
        return true;
      case "setBacklight":
        this.backlight = !!args[0];
        return true;
      case "setDisplayInvert":
        this.invert = !!args[0];
        return true;
      case "setDisplayOn":
        this.displayOn = !!args[0];
        return true;
      default:
        // setSpiSpeed dsb → diterima tapi tidak ada efeknya di pseudo-device.
        return false;
    }
  }

  // ================================================================
  // INTERNAL
  // ================================================================

  /** Log ke syslog kernel bila tersedia. */
  private log(msg: string): void {
    try {
      this.kctx?.syslog(`[plcd] ${msg}`);
    } catch (_) {
      /* ignore */
    }
  }

  /** Catat error runtime + syslog. */
  private fail(where: string, e: any): void {
    const msg = e?.message || String(e);
    this.lastError = `${where}: ${msg}`;
    console.error(`[PLCD] ${where} error: ${msg}`);
    this.log(`${where} error: ${msg}`);
  }
}

// Plugin Export: harus export default class yang implement IDevice
export default PLCDDevice;
