import { describe, it, expect, vi, beforeEach } from "vitest";

import { PLCDDevice, PLCDIOCTL } from "./PLCDDevice";
import { LCDIOCTL, LCD_FRAMEBUFFER_SIZE } from "./LM6029Device";
import { LCD_GFX_FONTS } from "./lcdFonts";

/** Id font GFX yang dipakai di tes (FreeMono9pt7b / FreeSans9pt7b). */
const MONO = 3;
const SANS = 1;

/**
 * PSEUDO LCD (/dev/plcd) — C10.60..C10.84
 *
 * Fokus: perilakunya harus SEBANDING dengan driver hardware LM6029Device,
 * karena aplikasi (`lcdLib`, `dd`, `cat`) tidak boleh bisa membedakan
 * keduanya. Yang diuji: kontrak ioctl, semantik DD-RAM vs panel (flush),
 * frame blit yang mengganti isi layar, rasterisasi GFX + teks, rotasi,
 * dan ioctl khas emulator (GET_REV / GET_FRAME).
 */

/** Baca satu piksel dari byte DD-RAM (panel space, 1 bpp MSB-first). */
function px(bytes: Buffer, x: number, y: number): number {
  return (bytes[y * 16 + (x >> 3)] >> (7 - (x & 7))) & 1;
}

/** Ambil frame panel sebagai Buffer 1024 byte. */
function frameBytes(dev: PLCDDevice): Buffer {
  const frame: any = dev.ioctl(PLCDIOCTL.GET_FRAME, null);
  return Buffer.from(frame.fb, "base64");
}

/**
 * DISPLAY lalu ambil frame panel.
 * Perintah ioctl gambar TIDAK auto-flush (sama seperti hardware); yang
 * auto-flush hanya write()/PRINT/PRINT_TEXT.
 */
function flushAndFrame(dev: PLCDDevice): Buffer {
  dev.ioctl(LCDIOCTL.DISPLAY, null);
  return frameBytes(dev);
}

/**
 * Hitung posisi piksel nyala satu glyph GFX dari DATA FONT-nya sendiri
 * (bukan angka hardcode) — supaya tes tetap benar kalau font di-regenerate.
 * Koordinat relatif terhadap (cursorX + xOffset, cursorY + yOffset).
 */
function glyphPixels(fontId: number, ch: string): Array<[number, number]> {
  const font = LCD_GFX_FONTS[fontId];
  const g = font.glyphs[ch.charCodeAt(0) - font.first];
  const [offset, w, h, , xOffset, yOffset] = g;
  const bm = Buffer.from(font.bitmaps, "base64");
  const out: Array<[number, number]> = [];
  for (let i = 0; i < w * h; i++) {
    if ((bm[offset + (i >> 3)] >> (7 - (i & 7))) & 1)
      out.push([xOffset + (i % w), yOffset + Math.floor(i / w)]);
  }
  return out;
}

describe("PLCDDevice (C10.60-C10.84)", () => {
  let dev: PLCDDevice;
  let syslog: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    syslog = vi.fn();
    dev = new PLCDDevice();
    dev.init({ syslog } as any);
  });

  // ── Identitas & registrasi ──
  it("C10.60 node default /dev/plcd, mode 0666, uid/gid 0", () => {
    expect(dev.name).toBe("plcd");
    expect(dev.mode).toBe(0o666);
    expect(dev.uid).toBe(0);
    expect(dev.gid).toBe(0);
    expect(dev.disabled).toBe(false);
  });

  it("C10.61 autoRegister mendaftarkan /dev/plcd & tidak melempar", () => {
    const kernel: any = { devices: {} };
    expect(() => PLCDDevice.autoRegister(kernel)).not.toThrow();
    expect(kernel.devices.plcd).toBeInstanceOf(PLCDDevice);
    expect(() => PLCDDevice.autoRegister(null)).not.toThrow();
  });

  // ── Kontrak "hardware ada" (dipakai lcdLib.isAvailable) ──
  it("C10.62 GET_INFO: available + pseudo + geometri + tanpa SPI", () => {
    const info: any = dev.ioctl(LCDIOCTL.GET_INFO, null);
    expect(info.device).toBe("/dev/plcd");
    expect(info.available).toBe(true);
    expect(info.pseudo).toBe(true);
    expect(info.width).toBe(128);
    expect(info.height).toBe(64);
    expect(info.pages).toBe(8);
    expect(info.framebufferSize).toBe(LCD_FRAMEBUFFER_SIZE);
    expect(info.spiSpeed).toBeNull();
    expect(info.spiDevice).toBeNull();
    expect(info.autoFlush).toBe(true);
  });

  it("C10.63 BEGIN selalu berhasil (tidak ada hardware yang perlu dibuka)", () => {
    expect(dev.ioctl(LCDIOCTL.BEGIN, null)).toBe(true);
    expect(dev.present()).toBe(true);
    expect(dev.open()).toBe(true);
  });

  it("C10.64 SET_SPI_SPEED no-op, GET_SPI_SPEED null (pseudo tanpa SPI)", () => {
    expect(dev.ioctl(LCDIOCTL.SET_SPI_SPEED, { hz: 20000000 })).toBe(0);
    expect(dev.ioctl(LCDIOCTL.GET_SPI_SPEED, null)).toBeNull();
  });

  // ── Semantik DD-RAM vs panel ──
  it("C10.65 gambar hanya mengubah buffer kerja; rev naik saat DISPLAY", () => {
    const rev0 = dev.ioctl(PLCDIOCTL.GET_REV, null);
    dev.ioctl(LCDIOCTL.DRAW_PIXEL, { x: 5, y: 5, color: 1 });
    expect(dev.ioctl(PLCDIOCTL.GET_REV, null)).toBe(rev0);
    expect(px(frameBytes(dev), 5, 5)).toBe(0); // belum tampil

    dev.ioctl(LCDIOCTL.DISPLAY, null);
    expect(dev.ioctl(PLCDIOCTL.GET_REV, null)).toBe(rev0 + 1);
    expect(px(frameBytes(dev), 5, 5)).toBe(1);
  });

  it("C10.66 CLEAR membersihkan buffer kerja, panel baru ikut saat DISPLAY", () => {
    dev.ioctl(LCDIOCTL.FILL_SCREEN, { color: 1 });
    dev.ioctl(LCDIOCTL.DISPLAY, null);
    expect(px(frameBytes(dev), 64, 32)).toBe(1);

    dev.ioctl(LCDIOCTL.CLEAR, null);
    expect(px(frameBytes(dev), 64, 32)).toBe(1); // panel belum berubah
    dev.ioctl(LCDIOCTL.DISPLAY, null);
    expect(px(frameBytes(dev), 64, 32)).toBe(0);
  });

  it("C10.67 RESET = clear + display (pakai buffer kerja & panel)", () => {
    dev.ioctl(LCDIOCTL.FILL_SCREEN, { color: 1 });
    dev.ioctl(LCDIOCTL.DISPLAY, null);
    const rev = dev.ioctl(PLCDIOCTL.GET_REV, null);
    dev.ioctl(LCDIOCTL.RESET, null);
    expect(dev.ioctl(PLCDIOCTL.GET_REV, null)).toBe(rev + 1);
    expect(px(frameBytes(dev), 0, 0)).toBe(0);
  });

  // ── Blit frame penuh (write 1024 byte) ──
  it("C10.68 write(1024 byte) MENGGANTI isi layar, bukan menumpuk", () => {
    dev.ioctl(LCDIOCTL.FILL_SCREEN, { color: 1 });
    dev.ioctl(LCDIOCTL.DISPLAY, null);
    expect(px(frameBytes(dev), 100, 50)).toBe(1);

    const frame = Buffer.alloc(LCD_FRAMEBUFFER_SIZE, 0);
    frame[0] = 0xff; // hanya 8 piksel paling kiri baris 0
    expect(dev.write(frame)).toBe(true);

    const bytes = frameBytes(dev);
    let lit = 0;
    for (const b of bytes) for (let i = 0; i < 8; i++) if (b & (1 << i)) lit++;
    expect(lit).toBe(8);
    expect(px(bytes, 0, 0)).toBe(1);
    expect(px(bytes, 100, 50)).toBe(0); // gambar lama hilang
  });

  it("C10.69 write(Buffer pendek) diperlakukan sebagai teks, bukan frame", () => {
    expect(dev.write(Buffer.from("A", "utf8"))).toBe(true);
    const info: any = dev.ioctl(LCDIOCTL.GET_INFO, null);
    expect(info.cursorX).toBe(6); // 1 glyph × advance 6 px
  });

  it("C10.70 blit menghormati autoFlush (OFF → perlu flush manual)", () => {
    dev.ioctl(LCDIOCTL.SET_AUTO_FLUSH, { on: false });
    const frame = Buffer.alloc(LCD_FRAMEBUFFER_SIZE, 0);
    frame[0] = 0x80; // piksel (0,0)
    dev.write(frame);
    expect(px(frameBytes(dev), 0, 0)).toBe(0); // masih di buffer kerja
    dev.ioctl(LCDIOCTL.DISPLAY, null);
    expect(px(frameBytes(dev), 0, 0)).toBe(1);
  });

  // ── Rasterisasi GFX ──
  it("C10.71 drawRect, fillRect, drawLine, drawCircle, fillCircle", () => {
    dev.ioctl(LCDIOCTL.DRAW_RECT, { x: 10, y: 10, w: 20, h: 10, color: 1 });
    dev.ioctl(LCDIOCTL.FILL_RECT, { x: 40, y: 10, w: 4, h: 4, color: 1 });
    dev.ioctl(LCDIOCTL.DRAW_LINE, { x0: 60, y0: 10, x1: 70, y1: 20, color: 1 });
    dev.ioctl(LCDIOCTL.DRAW_CIRCLE, { x: 30, y: 40, r: 10, color: 1 });
    dev.ioctl(LCDIOCTL.FILL_CIRCLE, { x: 90, y: 40, r: 6, color: 1 });
    const b = flushAndFrame(dev);

    expect(px(b, 10, 10)).toBe(1); // sudut rect
    expect(px(b, 15, 15)).toBe(0); // dalam rect = kosong
    expect(px(b, 41, 11)).toBe(1); // fillRect
    expect(px(b, 65, 15)).toBe(1); // garis diagonal
    expect(px(b, 40, 40)).toBe(1); // tepi kanan circle (cx+r)
    expect(px(b, 30, 40)).toBe(0); // tengah circle kosong
    expect(px(b, 90, 40)).toBe(1); // pusat fillCircle
    expect(px(b, 96, 40)).toBe(1); // tepi fillCircle
    expect(px(b, 98, 40)).toBe(0); // di luar radius
  });

  it("C10.72 fillTriangle mengisi area, drawTriangle hanya tepi", () => {
    dev.ioctl(LCDIOCTL.FILL_TRIANGLE, {
      x0: 5,
      y0: 30,
      x1: 45,
      y1: 30,
      x2: 25,
      y2: 5,
      color: 1,
    });
    dev.ioctl(LCDIOCTL.DRAW_TRIANGLE, {
      x0: 60,
      y0: 30,
      x1: 100,
      y1: 30,
      x2: 80,
      y2: 5,
      color: 1,
    });
    const b = flushAndFrame(dev);
    expect(px(b, 25, 29)).toBe(1); // dalam fillTriangle
    expect(px(b, 80, 29)).toBe(0); // dalam drawTriangle = kosong
    expect(px(b, 60, 30)).toBe(1); // tepi bawah drawTriangle
    expect(px(b, 25, 5)).toBe(1); // puncak
  });

  it("C10.73 roundRect: sudut membulat, isi kosong, tepi lurus ada", () => {
    dev.ioctl(LCDIOCTL.DRAW_ROUND_RECT, {
      x: 10,
      y: 10,
      w: 30,
      h: 20,
      r: 5,
      color: 1,
    });
    dev.ioctl(LCDIOCTL.FILL_ROUND_RECT, {
      x: 50,
      y: 10,
      w: 20,
      h: 20,
      r: 6,
      color: 1,
    });
    const b = flushAndFrame(dev);
    expect(px(b, 10, 10)).toBe(0); // sudut luar dibuang
    expect(px(b, 25, 10)).toBe(1); // sisi datar atas
    expect(px(b, 25, 19)).toBe(0); // tengah kosong
    expect(px(b, 15, 29)).toBe(1); // busur bawah-kiri masih ada
    expect(px(b, 50, 10)).toBe(0); // fillRoundRect juga membuang sudut
    expect(px(b, 60, 10)).toBe(1); // sisi datar atas fillRoundRect
    expect(px(b, 60, 20)).toBe(1); // dan isinya penuh
  });

  it("C10.74 drawBitmap: bit 1 → color, bit 0 dilewati (transparan)", () => {
    dev.ioctl(LCDIOCTL.DRAW_PIXEL, { x: 1, y: 0, color: 1 }); // target bagi bit 0
    const bmp = Buffer.from([0b10100000, 0b01000000]); // baris 0 & baris 1
    dev.ioctl(LCDIOCTL.DRAW_BITMAP, {
      x: 0,
      y: 0,
      data: bmp,
      w: 8,
      h: 2,
      color: 1,
    });
    const b = flushAndFrame(dev);
    expect(px(b, 0, 0)).toBe(1); // bit 1
    expect(px(b, 1, 0)).toBe(1); // bit 0 → tidak menghapus piksel lama
    expect(px(b, 2, 0)).toBe(1); // bit 1
    expect(px(b, 1, 1)).toBe(1); // byte kedua → baris 1
    expect(px(b, 0, 1)).toBe(0);
  });

  it("C10.75 write({op,args}) memakai op-name yang sama dengan LM6029Device", () => {
    expect(dev.write({ op: "fillRect", args: [0, 0, 128, 8] })).toBe(true);
    expect(dev.write({ op: "drawPixel", args: [3, 20, 1] })).toBe(true);
    dev.write({ op: "display", args: [] });
    const b = frameBytes(dev);
    expect(px(b, 50, 3)).toBe(1);
    expect(px(b, 3, 20)).toBe(1);
  });

  // ── Teks ──
  it("C10.76 printText meraster glyph 5x7 dan tidak mengubah cursor", () => {
    dev.ioctl(LCDIOCTL.PRINT_TEXT, { text: "A", x: 0, y: 0, size: 1 });
    const b = frameBytes(dev);
    // Baris atas glyph 'A' = ".###." → px(1,0) & px(3,0) nyala, px(0,0) mati.
    expect(px(b, 1, 0)).toBe(1);
    expect(px(b, 3, 0)).toBe(1);
    expect(px(b, 0, 0)).toBe(0);
    // Kaki 'A' ada di kolom 0 baris 6.
    expect(px(b, 0, 6)).toBe(1);

    const info: any = dev.ioctl(LCDIOCTL.GET_INFO, null);
    expect(info.cursorX).toBe(0); // PRINT_TEXT memulihkan cursor
    expect(info.cursorY).toBe(0);
  });

  it("C10.77 print() memajukan cursor & textWrap memindah ke baris baru", () => {
    dev.ioctl(LCDIOCTL.PRINT, { text: "AB" });
    let info: any = dev.ioctl(LCDIOCTL.GET_INFO, null);
    expect(info.cursorX).toBe(12); // 2 × advance 6

    dev.ioctl(LCDIOCTL.SET_TEXT_WRAP, { wrap: true });
    dev.ioctl(LCDIOCTL.SET_CURSOR, { x: 120, y: 8 });
    dev.ioctl(LCDIOCTL.PRINT, { text: "XY" });
    info = dev.ioctl(LCDIOCTL.GET_INFO, null);
    expect(info.cursorY).toBe(16); // 120 + 6 > 128 → pindah baris (8 px)
  });

  it("C10.78 print() memperlakukan \\n sebagai baris baru", () => {
    dev.ioctl(LCDIOCTL.SET_CURSOR, { x: 40, y: 4 });
    dev.ioctl(LCDIOCTL.PRINT, { text: "A\nB" });
    const info: any = dev.ioctl(LCDIOCTL.GET_INFO, null);
    expect(info.cursorX).toBe(6);
    expect(info.cursorY).toBe(12);
  });

  it("C10.79 setTextSize memperbesar glyph (blok size×size)", () => {
    dev.ioctl(LCDIOCTL.SET_TEXT_SIZE, { size: 2 });
    dev.ioctl(LCDIOCTL.PRINT_TEXT, { text: "A", x: 0, y: 0, size: 2 });
    const b = frameBytes(dev);
    // Kolom 1 baris 0..1 nyala (blok 2x2), kolom 0 tetap mati.
    expect(px(b, 2, 0)).toBe(1);
    expect(px(b, 3, 1)).toBe(1);
    expect(px(b, 0, 0)).toBe(0);
    expect(px(b, 0, 2)).toBe(1); // baris ke-2 glyph (kaki kiri 'A') ikut membesar
  });

  it("C10.80 setTextColor(color, bg) → mode opaque menulis latar", () => {
    dev.ioctl(LCDIOCTL.SET_TEXT_COLOR, { color: 0, bg: 1 });
    dev.ioctl(LCDIOCTL.PRINT_TEXT, { text: "A", x: 0, y: 0, size: 1 });
    const b = frameBytes(dev);
    expect(px(b, 0, 0)).toBe(1); // latar (bg=1)
    expect(px(b, 1, 0)).toBe(0); // piksel glyph jadi color=0
  });

  it("C10.81 karakter di luar tabel font → placeholder kotak (tidak crash)", () => {
    dev.ioctl(LCDIOCTL.PRINT_TEXT, { text: "\u2603", x: 0, y: 0, size: 1 });
    const b = frameBytes(dev);
    expect(px(b, 0, 0)).toBe(1); // border kotak placeholder
    expect(px(b, 2, 3)).toBe(0); // dalamnya kosong
  });

  // ── Rotasi & kontrol tampilan ──
  it("C10.82 rotation menukar GET_WIDTH/GET_HEIGHT & memetakan koordinat", () => {
    expect(dev.ioctl(LCDIOCTL.SET_ROTATION, { rotation: 1 })).toBe(1);
    expect(dev.ioctl(LCDIOCTL.GET_WIDTH, null)).toBe(64);
    expect(dev.ioctl(LCDIOCTL.GET_HEIGHT, null)).toBe(128);

    dev.ioctl(LCDIOCTL.DRAW_PIXEL, { x: 0, y: 0, color: 1 }); // logika (0,0)
    dev.ioctl(LCDIOCTL.DISPLAY, null);
    const b = frameBytes(dev);
    expect(px(b, 127, 0)).toBe(1); // panel: sudut kanan-atas
  });

  it("C10.83 kontras di-clamp 0..63, backlight/display/invert tersimpan", () => {
    expect(dev.ioctl(LCDIOCTL.SET_CONTRAST, { level: 99 })).toBe(63);
    expect(dev.ioctl(LCDIOCTL.SET_CONTRAST, { level: -5 })).toBe(0);
    expect(dev.ioctl(LCDIOCTL.SET_BACKLIGHT, { on: false })).toBe(false);
    expect(dev.ioctl(LCDIOCTL.GET_BACKLIGHT, null)).toBe(false);
    expect(dev.ioctl(LCDIOCTL.SET_DISPLAY_ON, { on: false })).toBe(false);
    expect(dev.ioctl(LCDIOCTL.IS_DISPLAY_ON, null)).toBe(false);
    expect(dev.ioctl(LCDIOCTL.SET_INVERT, { invert: true })).toBe(true);
    expect(dev.ioctl(LCDIOCTL.GET_INVERT, null)).toBe(true);
  });

  it("C10.84 GET_FRAME: base64 1024 byte + flag tampilan (DD-RAM tetap mentah)", () => {
    dev.ioctl(LCDIOCTL.FILL_SCREEN, { color: 1 });
    dev.ioctl(LCDIOCTL.SET_INVERT, { invert: true });
    dev.ioctl(LCDIOCTL.SET_DISPLAY_ON, { on: false });
    dev.ioctl(LCDIOCTL.SET_CONTRAST, { level: 40 });
    dev.ioctl(LCDIOCTL.DISPLAY, null);

    const frame: any = dev.ioctl(PLCDIOCTL.GET_FRAME, null);
    expect(typeof frame.fb).toBe("string");
    const bytes = Buffer.from(frame.fb, "base64");
    expect(bytes.length).toBe(LCD_FRAMEBUFFER_SIZE);
    // Invert/display-off adalah properti tampilan: byte DD-RAM tetap asli.
    expect(px(bytes, 10, 10)).toBe(1);
    expect(frame.invert).toBe(true);
    expect(frame.displayOn).toBe(false);
    expect(frame.contrast).toBe(40);
    expect(frame.rev).toBe(dev.ioctl(PLCDIOCTL.GET_REV, null));
    expect(frame.fb.length).toBeGreaterThan(0);
  });

  // ── Ketahanan ──
  it("C10.85 argumen aneh tidak membuat driver melempar", () => {
    expect(() => dev.ioctl(LCDIOCTL.DRAW_RECT, null)).not.toThrow();
    expect(() => dev.ioctl(LCDIOCTL.PRINT_TEXT, {})).not.toThrow();
    expect(() => dev.ioctl(LCDIOCTL.DRAW_BITMAP, { w: 8, h: 2 })).not.toThrow();
    expect(dev.ioctl(0x4cff, null)).toBeNull(); // perintah tak dikenal
    expect(dev.write(12345)).toBe(false);
    expect(dev.write(null)).toBe(false);
  });

  it("C10.86 read() mengembalikan JSON status dengan rev", () => {
    dev.ioctl(LCDIOCTL.DISPLAY, null);
    const info = JSON.parse(dev.read());
    expect(info.device).toBe("/dev/plcd");
    expect(info.pseudo).toBe(true);
    expect(typeof info.rev).toBe("number");
    expect(info.rev).toBe(dev.ioctl(PLCDIOCTL.GET_REV, null));
  });

  it("C10.87 driver disabled: tidak menerima perintah", () => {
    const off = new PLCDDevice({ disabled: true });
    off.init({ syslog } as any);
    expect(off.present()).toBe(false);
    expect(off.write("x")).toBe(false);
    expect(off.ioctl(LCDIOCTL.GET_INFO, null)).toBeNull();
  });

  it("C10.88 snapshot() menyalin DD-RAM panel (tidak membocorkan referensi)", () => {
    dev.ioctl(LCDIOCTL.FILL_SCREEN, { color: 1 });
    dev.ioctl(LCDIOCTL.DISPLAY, null);
    const snap = dev.snapshot();
    expect(snap.length).toBe(LCD_FRAMEBUFFER_SIZE);
    expect(px(Buffer.from(snap), 0, 0)).toBe(1);
    snap[0] = 0;
    expect(px(frameBytes(dev), 0, 0)).toBe(1); // device tidak terpengaruh
  });

  // ── Font Adafruit_GFX asli (data glyph dari addon, bukan 5x7) ──
  it("C10.89 setFont(3) meraster glyph FreeMono9pt7b persis data addon", () => {
    const glyph = "A";
    const [gx, y0] = [2, 20];
    const bits = glyphPixels(MONO, glyph);
    expect(bits.length).toBeGreaterThan(10);

    dev.ioctl(LCDIOCTL.SET_FONT, { id: MONO });
    dev.ioctl(LCDIOCTL.PRINT_TEXT, { text: glyph, x: gx, y: y0, size: 1 });
    const b = flushAndFrame(dev);

    // Semua piksel glyph harus ada di posisi yang sama dengan data font.
    for (const [dx, dy] of bits) expect(px(b, gx + dx, y0 + dy)).toBe(1);

    // Dan di dalam kotak glyph, piksel yang TIDAK nyala di data harus tetap 0.
    const font = LCD_GFX_FONTS[MONO];
    const [offset, w, h, , , ] = font.glyphs[glyph.charCodeAt(0) - font.first];
    const lit = new Set(bits.map(([dx, dy]) => dx + "," + dy));
    let checkedEmpty = 0;
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        if (lit.has(xx + "," + yy)) continue;
        expect(px(b, gx + xx, y0 + yy)).toBe(0);
        checkedEmpty++;
      }
    }
    expect(checkedEmpty).toBeGreaterThan(0);

    const info: any = dev.ioctl(LCDIOCTL.GET_INFO, null);
    expect(info.font).toBe(MONO);
    expect(info.fontName).toBe("FreeMono9pt7b");
    expect(info.cursorBaseline).toBe(true);
  });

  it("C10.90 font GFX: cursorY adalah BASELINE (ink di atas y, sesuai yOffset)", () => {
    const baseline = 30;
    dev.ioctl(LCDIOCTL.SET_FONT, { id: MONO });
    dev.ioctl(LCDIOCTL.PRINT_TEXT, { text: "H", x: 0, y: baseline, size: 1 });
    const b = flushAndFrame(dev);

    const font = LCD_GFX_FONTS[MONO];
    const [, , , , , yOffset] = font.glyphs["H".charCodeAt(0) - font.first];
    expect(yOffset).toBeLessThan(0); // tinggi glyph naik dari baseline
    // Baris paling atas glyph = baseline + yOffset, dan di atasnya harus kosong.
    expect(px(b, 0, baseline + yOffset - 1)).toBe(0);
    expect(px(b, 3, baseline + yOffset)).toBe(1); // cap "H" mulai dari atas
  });

  it("C10.91 font GFX: baris baru memakai yAdvance font (bukan 8 px)", () => {
    const font = LCD_GFX_FONTS[SANS];
    expect(font.yAdvance).not.toBe(8);
    dev.ioctl(LCDIOCTL.SET_FONT, { id: SANS });
    // PRINT_TEXT memulihkan cursor (kontrak LCDIOCTL.PRINT_TEXT), jadi
    // pergeseran baris diperiksa lewat PRINT + cursor aktif.
    dev.ioctl(LCDIOCTL.SET_CURSOR, { x: 4, y: 40 });
    dev.ioctl(LCDIOCTL.PRINT, { text: "A\nB" });
    const info: any = dev.ioctl(LCDIOCTL.GET_INFO, null);
    expect(info.cursorY).toBe(40 + font.yAdvance);
    expect(info.cursorX).toBe(
      font.glyphs["B".charCodeAt(0) - font.first][3],
    );
  });

  it("C10.92 font GFX proporsional: advance pakai xAdvance per glyph", () => {
    const font = LCD_GFX_FONTS[SANS];
    const adv = (ch: string) => font.glyphs[ch.charCodeAt(0) - font.first][3];
    expect(adv("i")).toBeLessThan(adv("W")); // memang proporsional

    dev.ioctl(LCDIOCTL.SET_FONT, { id: SANS });
    dev.ioctl(LCDIOCTL.PRINT, { text: "i" });
    let info: any = dev.ioctl(LCDIOCTL.GET_INFO, null);
    expect(info.cursorX).toBe(adv("i"));
    expect(info.cursorX).not.toBe(6); // bukan advance font 5x7

    dev.ioctl(LCDIOCTL.SET_CURSOR, { x: 0, y: 30 });
    dev.ioctl(LCDIOCTL.PRINT, { text: "W" });
    info = dev.ioctl(LCDIOCTL.GET_INFO, null);
    expect(info.cursorX).toBe(adv("W"));
  });

  it("C10.93 font GFX: karakter di luar rentang dilewati tanpa majukan cursor", () => {
    const font = LCD_GFX_FONTS[MONO];
    expect(font.last).toBe(0x7e);
    dev.ioctl(LCDIOCTL.SET_FONT, { id: MONO });
    dev.ioctl(LCDIOCTL.SET_CURSOR, { x: 10, y: 20 });
    dev.ioctl(LCDIOCTL.PRINT, { text: "\u20ac" }); // € di luar 0x20..0x7E
    const info: any = dev.ioctl(LCDIOCTL.GET_INFO, null);
    expect(info.cursorX).toBe(10); // tidak bergerak
    const b = flushAndFrame(dev);
    let ink = 0;
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 128; x++) if (px(b, x, y)) ink++;
    expect(ink).toBe(0);
  });

  it("C10.94 font GFX: setTextSize(2) menskalakan blok 2x2 & advance", () => {
    const font = LCD_GFX_FONTS[MONO];
    const [, , , xAdvance] = font.glyphs["A".charCodeAt(0) - font.first];
    dev.ioctl(LCDIOCTL.SET_FONT, { id: MONO });
    dev.ioctl(LCDIOCTL.PRINT_TEXT, { text: "A", x: 0, y: 30, size: 2 });
    const info: any = dev.ioctl(LCDIOCTL.GET_INFO, null);
    expect(info.cursorX).toBe(0); // PRINT_TEXT memulihkan cursor

    dev.ioctl(LCDIOCTL.SET_CURSOR, { x: 0, y: 30 });
    dev.ioctl(LCDIOCTL.PRINT, { text: "A" }); // size aktif = 1 (default)
    const after1: any = dev.ioctl(LCDIOCTL.GET_INFO, null);
    expect(after1.cursorX).toBe(xAdvance);
  });

  it("C10.95 font GFX + bg opaque: latar glyph ikut ditulis", () => {
    // Teks di atas layar nyala → piksel glyph jadi 0 ("teks gelap").
    dev.ioctl(LCDIOCTL.FILL_SCREEN, { color: 1 });
    dev.ioctl(LCDIOCTL.SET_FONT, { id: MONO });
    dev.ioctl(LCDIOCTL.SET_TEXT_COLOR, { color: 0, bg: 1 });
    dev.ioctl(LCDIOCTL.PRINT_TEXT, { text: "A", x: 10, y: 30, size: 1 });
    const b = flushAndFrame(dev);
    const bits = glyphPixels(MONO, "A");
    for (const [dx, dy] of bits) expect(px(b, 10 + dx, 30 + dy)).toBe(0);
  });

  it("C10.96 id font tak dikenal → fallback 5x7 (cursorBaseline false)", () => {
    dev.ioctl(LCDIOCTL.SET_FONT, { id: 9 });
    expect(dev.ioctl(LCDIOCTL.SET_FONT, { id: 9 })).toBe(9);
    const info: any = dev.ioctl(LCDIOCTL.GET_INFO, null);
    expect(info.font).toBe(9);
    expect(info.cursorBaseline).toBe(false);
    // Tetap meraster (jalur 5x7): 'A' pada cursorY = sudut atas glyph.
    dev.ioctl(LCDIOCTL.PRINT_TEXT, { text: "A", x: 0, y: 0, size: 1 });
    const b = flushAndFrame(dev);
    expect(px(b, 1, 0)).toBe(1);
  });
});
