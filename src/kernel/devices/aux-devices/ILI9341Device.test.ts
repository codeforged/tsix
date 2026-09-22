import { describe, it, expect, vi, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  ILI9341Device,
  FbDevPanel,
  TFTIOCTL,
  TFT_COLOR,
  TFT_FRAMEBUFFER_SIZE,
  TFT_STRIDE,
  TFT_WIDTH,
  TFT_HEIGHT,
  rgb565,
  hex565,
  unpack565,
  detectFbDevices,
  resolveBacklightPaths,
  type FbVarInfo,
  type TftPanelHandle,
} from "./ILI9341Device";

/**
 * Fake panel — meniru FbDevPanel tanpa menyentuh /dev sama sekali: setiap
 * `present()` menyimpan SALINAN frame supaya isi layar bisa diperiksa.
 */
function makeFakePanel(overrides: Partial<TftPanelHandle> = {}): {
  panel: TftPanelHandle;
  frames: Buffer[];
  closes: () => number;
} {
  const frames: Buffer[] = [];
  let closed = 0;
  const panel: TftPanelHandle = {
    begin: vi.fn(() => true),
    present: vi.fn((frame: Buffer) => {
      frames.push(Buffer.from(frame));
    }),
    setBacklight: vi.fn((on: boolean) => on),
    getBacklight: vi.fn(() => true),
    setBrightness: vi.fn((lvl: number) => lvl),
    getBrightness: vi.fn(() => 255),
    setDisplayOn: vi.fn((on: boolean) => on),
    getDevicePath: vi.fn(() => "/dev/fb1"),
    getFbVar: vi.fn(
      (): FbVarInfo => ({
        device: "/dev/fb1",
        name: "fb_ili9341",
        virtualSize: { w: TFT_WIDTH, h: TFT_HEIGHT },
        bpp: 16,
        stride: TFT_STRIDE,
        brightness: null,
      }),
    ),
    close: vi.fn(() => {
      closed++;
    }),
    ...overrides,
  };
  return { panel, frames, closes: () => closed };
}

/** Device siap pakai (framebuffer palsu sudah "terbuka"). */
function makeReadyDevice(panel = makeFakePanel().panel): {
  dev: ILI9341Device;
  panel: TftPanelHandle;
} {
  const dev = new ILI9341Device({ native: panel });
  dev.init({ syslog: () => {} });
  return { dev, panel };
}

/** Baca satu piksel FRAME yang terakhir di-present (bukan back-buffer). */
function framePixel(frame: Buffer, x: number, y: number): number {
  const o = (y * TFT_WIDTH + x) * 2;
  return frame[o] | (frame[o + 1] << 8);
}

/** Hitung piksel yang tidak sama dengan `color` di frame. */
function countDifferent(frame: Buffer, color: number): number {
  let n = 0;
  for (let i = 0; i < frame.length; i += 2) {
    if ((frame[i] | (frame[i + 1] << 8)) !== color) n++;
  }
  return n;
}

// ================================================================
// WARNA (helper murni)
// ================================================================

describe("ILI9341 — helper warna (C10.100-C10.103)", () => {
  it("C10.100 rgb565 memaket komponen 8-bit & grayscale", () => {
    expect(rgb565(255, 255, 255)).toBe(0xffff);
    expect(rgb565(0, 0, 0)).toBe(0x0000);
    expect(rgb565(255, 0, 0)).toBe(0xf800);
    expect(rgb565(0, 255, 0)).toBe(0x07e0);
    expect(rgb565(0, 0, 255)).toBe(0x001f);
    expect(rgb565(128)).toBe(rgb565(128, 128, 128)); // satu argumen = grayscale
  });

  it("C10.101 rgb565 meng-clamp nilai aneh (negatif/NaN/overflow)", () => {
    expect(rgb565(-50, 0, 0)).toBe(0x0000);
    expect(rgb565(999, 0, 0)).toBe(rgb565(255, 0, 0));
    expect(rgb565("x" as any)).toBe(0x0000);
  });

  it("C10.102 hex565 menerima #RRGGBB & angka 24-bit", () => {
    expect(hex565("#ff0000")).toBe(rgb565(255, 0, 0));
    expect(hex565("00ff00")).toBe(rgb565(0, 255, 0));
    expect(hex565(0x0000ff)).toBe(rgb565(0, 0, 255));
    expect(hex565("#00fff2")).toBe(TFT_COLOR.CYAN_NEON);
    expect(hex565("bukan-warna")).toBe(0);
  });

  it("C10.103 unpack565 membalik pemaketan (presisi 5/6/5)", () => {
    const { r, g, b } = unpack565(rgb565(255, 128, 0));
    expect(r).toBe(255);
    expect(g).toBeGreaterThanOrEqual(124);
    expect(g).toBeLessThanOrEqual(132);
    expect(b).toBe(0);
  });
});

// ================================================================
// METADATA & LIFECYCLE
// ================================================================

describe("ILI9341Device — metadata & lifecycle (C10.110-C10.119)", () => {
  it("C10.110 default: name tft, root:root, 0666, tidak disabled", () => {
    const dev = new ILI9341Device();
    expect(dev.name).toBe("tft");
    expect(dev.uid).toBe(0);
    expect(dev.gid).toBe(0);
    expect(dev.mode).toBe(0o666);
    expect(dev.disabled).toBe(false);
  });

  it("C10.110b nama node bisa diganti (mis. /dev/tft2)", () => {
    expect(new ILI9341Device({ name: "tft2" }).name).toBe("tft2");
  });

  it("C10.111 present() false sebelum framebuffer terbuka", () => {
    const dev = new ILI9341Device();
    expect(dev.present()).toBe(false);
    expect(dev.write("x")).toBe(false);
  });

  it("C10.112 init() membuka panel: geometri & ukuran frame", () => {
    const { dev, panel } = makeReadyDevice();
    expect(panel.begin).toHaveBeenCalled();
    expect(dev.present()).toBe(true);
    expect(dev.ioctl(TFTIOCTL.GET_WIDTH, null)).toBe(TFT_WIDTH);
    expect(dev.ioctl(TFTIOCTL.GET_HEIGHT, null)).toBe(TFT_HEIGHT);
    expect(dev.ioctl(TFTIOCTL.GET_STRIDE, null)).toBe(TFT_STRIDE);
    expect(dev.ioctl(TFTIOCTL.GET_FRAMEBUFFER_SIZE, null)).toBe(TFT_FRAMEBUFFER_SIZE);
  });

  it("C10.113 begin() gagal → node tetap tersembunyi", () => {
    const panel = makeFakePanel({ begin: vi.fn(() => false) }).panel;
    const dev = new ILI9341Device({ native: panel });
    dev.init({ syslog: () => {} });
    expect(dev.present()).toBe(false);
    expect(dev.write("x")).toBe(false);
    expect(dev.read()).toContain('"available":false');
    expect(dev.getInfo().lastError).toContain("begin() gagal");
  });

  it("C10.114 disabled=true → tidak dibuka sama sekali", () => {
    const panel = makeFakePanel().panel;
    const dev = new ILI9341Device({ native: panel, disabled: true });
    dev.init({ syslog: () => {} });
    expect(dev.present()).toBe(false);
    expect(panel.begin).not.toHaveBeenCalled();
  });

  it("C10.115 close() melepas FD kernel tapi handle framebuffer dipertahankan", () => {
    const { dev, panel } = makeReadyDevice();
    expect(dev.close()).toBe(true);
    expect(panel.close).not.toHaveBeenCalled();
    expect(dev.present()).toBe(true);
  });

  it("C10.116 node framebuffer dengan geometri/bpp beda DITOLAK", () => {
    const hdmi = makeFakePanel({
      getFbVar: vi.fn((): FbVarInfo => ({
        device: "/dev/fb1",
        name: "bcm2835",
        virtualSize: { w: 1920, h: 1080 },
        bpp: 32,
        stride: 7680,
        brightness: null,
      })),
    });
    const dev = new ILI9341Device({ native: hdmi.panel });
    dev.init({ syslog: () => {} });
    expect(dev.present()).toBe(false);
    expect(dev.getInfo().lastError).toContain("tidak cocok");
    expect(hdmi.closes()).toBe(1); // node ditutup kembali, tidak dipakai
    expect(hdmi.frames.length).toBe(0);
  });

  it("C10.116b node portrait 240x320 (stride 480) juga DITOLAK", () => {
    const portrait = makeFakePanel({
      getFbVar: vi.fn((): FbVarInfo => ({
        device: "/dev/fb1",
        name: "fb_ili9341",
        virtualSize: { w: 240, h: 320 },
        bpp: 16,
        stride: 480,
        brightness: null,
      })),
    });
    const dev = new ILI9341Device({ native: portrait.panel });
    dev.init({ syslog: () => {} });
    expect(dev.present()).toBe(false);
    expect(dev.getInfo().lastError).toContain("buffer tidak cocok");
  });

  it("C10.117 konfigurasi awal diterapkan saat open()", () => {
    const panel = makeFakePanel().panel;
    const dev = new ILI9341Device({
      native: panel,
      rotation: 1,
      invert: true,
      backlight: false,
      brightness: 120,
      displayOn: false,
      autoFlush: false,
      font: 1,
      textColor: TFT_COLOR.RED,
      textSize: 2,
    });
    dev.init({ syslog: () => {} });

    expect(panel.setBrightness).toHaveBeenCalledWith(120);
    expect(panel.setBacklight).toHaveBeenCalledWith(false);
    expect(panel.setDisplayOn).toHaveBeenCalledWith(false);

    const info = dev.getInfo();
    expect(info.rotation).toBe(1);
    expect(info.invert).toBe(true);
    expect(info.autoFlush).toBe(false);
    expect(info.fontId).toBe(1);
    expect(info.textColor).toBe(TFT_COLOR.RED);
    expect(info.textSize).toBe(2);
  });

  it("C10.118 autoRegister mendaftarkan /dev/tft (dan aman tanpa kernel)", () => {
    const kernel: any = { devices: {} };
    ILI9341Device.autoRegister(kernel);
    expect(kernel.devices.tft).toBeInstanceOf(ILI9341Device);
    expect(() => ILI9341Device.autoRegister({} as any)).not.toThrow();
  });

  it("C10.119 ioctl sebelum init → null; BEGIN boleh kapan saja; perintah asing → null", () => {
    const dev = new ILI9341Device(); // tanpa hardware
    expect(dev.ioctl(TFTIOCTL.GET_WIDTH, null)).toBeNull();
    expect(dev.ioctl(0x54ff, null)).toBeNull();
    // BEGIN dicoba kapan saja: hasilnya boolean (false di mesin tanpa TFT,
    // true kalau kebetulan ada /dev/fbN 16 bpp yang cocok) — tak pernah throw.
    expect(typeof dev.ioctl(TFTIOCTL.BEGIN, null)).toBe("boolean");

    const ready = makeReadyDevice().dev;
    expect(ready.ioctl(0x54ff, null)).toBeNull(); // perintah tak dikenal
  });

  it("C10.119b refcount FD kernel (10/11/20/21) tidak menyentuh hardware", () => {
    const { dev } = makeReadyDevice();
    expect(dev.ioctl(10, null)).toBe(0);
    expect(dev.ioctl(20, null)).toBe(0);
    expect(dev.ioctl(11, null)).toBe(0);
    expect(dev.ioctl(21, null)).toBe(0);
    const info = dev.getInfo();
    expect(info.readRefs).toBe(0);
    expect(info.writeRefs).toBe(0);
  });
});

// ================================================================
// GAMBAR
// ================================================================

describe("ILI9341Device — primitive GFX (C10.120-C10.125)", () => {
  it("C10.120 FILL_SCREEN + GET_PIXEL (angka, string hex, objek rgb)", () => {
    const { dev } = makeReadyDevice();
    dev.ioctl(TFTIOCTL.FILL_SCREEN, { color: rgb565(0, 0, 0) });
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: 5, y: 5 })).toBe(0x0000);

    dev.ioctl(TFTIOCTL.FILL_SCREEN, { color: "#00fff2" });
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: 5, y: 5 })).toBe(TFT_COLOR.CYAN_NEON);

    dev.ioctl(TFTIOCTL.FILL_SCREEN, { color: { r: 255, g: 0, b: 0 } });
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: 5, y: 5 })).toBe(TFT_COLOR.RED);
  });

  it("C10.121 CLEAR hanya mengubah back-buffer; DISPLAY yang men-present", () => {
    const { dev, panel } = makeReadyDevice();
    const frames = (panel.present as any).mock.calls.length;
    dev.ioctl(TFTIOCTL.FILL_SCREEN, { color: TFT_COLOR.WHITE });
    expect((panel.present as any).mock.calls.length).toBe(frames); // belum flush
    dev.ioctl(TFTIOCTL.DISPLAY, null);
    expect((panel.present as any).mock.calls.length).toBe(frames + 1);
    expect(dev.getInfo().frames).toBe(1);
  });

  it("C10.122 DRAW_PIXEL menerima objek bernama & array posisional", () => {
    const { dev } = makeReadyDevice();
    dev.ioctl(TFTIOCTL.FILL_SCREEN, { color: 0 });
    dev.ioctl(TFTIOCTL.DRAW_PIXEL, { x: 10, y: 20, color: TFT_COLOR.GREEN });
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: 10, y: 20 })).toBe(TFT_COLOR.GREEN);
    dev.ioctl(TFTIOCTL.DRAW_PIXEL, [11, 20, TFT_COLOR.BLUE]);
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: 11, y: 20 })).toBe(TFT_COLOR.BLUE);
  });

  it("C10.123 line/rect/fillRect/circle/fillCircle/triangle/roundRect menggambar", () => {
    const { dev } = makeReadyDevice();
    dev.ioctl(TFTIOCTL.FILL_SCREEN, { color: 0 });

    dev.ioctl(TFTIOCTL.DRAW_LINE, { x0: 0, y0: 0, x1: 19, y1: 0, color: TFT_COLOR.RED });
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: 9, y: 0 })).toBe(TFT_COLOR.RED);

    dev.ioctl(TFTIOCTL.DRAW_RECT, { x: 0, y: 10, w: 10, h: 10, color: TFT_COLOR.GREEN });
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: 0, y: 10 })).toBe(TFT_COLOR.GREEN);
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: 5, y: 15 })).toBe(0x0000); // outline saja

    dev.ioctl(TFTIOCTL.FILL_RECT, { x: 20, y: 10, w: 10, h: 10, color: TFT_COLOR.BLUE });
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: 25, y: 15 })).toBe(TFT_COLOR.BLUE);

    dev.ioctl(TFTIOCTL.DRAW_CIRCLE, { x: 100, y: 100, r: 10, color: TFT_COLOR.CYAN });
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: 110, y: 100 })).toBe(TFT_COLOR.CYAN);
    dev.ioctl(TFTIOCTL.FILL_CIRCLE, { x: 100, y: 100, r: 5, color: TFT_COLOR.MAGENTA });
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: 100, y: 100 })).toBe(TFT_COLOR.MAGENTA);

    dev.ioctl(TFTIOCTL.DRAW_TRIANGLE, { x0: 200, y0: 0, x1: 220, y1: 0, x2: 210, y2: 20, color: TFT_COLOR.YELLOW });
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: 210, y: 0 })).toBe(TFT_COLOR.YELLOW);
    dev.ioctl(TFTIOCTL.FILL_TRIANGLE, { x0: 200, y0: 40, x1: 220, y1: 40, x2: 210, y2: 60, color: TFT_COLOR.ORANGE });
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: 210, y: 50 })).toBe(TFT_COLOR.ORANGE);

    dev.ioctl(TFTIOCTL.FILL_ROUND_RECT, { x: 250, y: 100, w: 40, h: 40, r: 8, color: TFT_COLOR.GRAY });
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: 270, y: 120 })).toBe(TFT_COLOR.GRAY);
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: 250, y: 100 })).toBe(0x0000); // sudut dibulatkan
  });

  it("C10.124 GET_PIXEL mengembalikan null di luar layar", () => {
    const { dev } = makeReadyDevice();
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: -1, y: 0 })).toBeNull();
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: TFT_WIDTH, y: 0 })).toBeNull();
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: 0, y: TFT_HEIGHT })).toBeNull();
  });

  it("C10.125 SET_ROTATION menukar geometri logika & memetakan koordinat", () => {
    const { dev } = makeReadyDevice();
    dev.ioctl(TFTIOCTL.FILL_SCREEN, { color: 0 });
    expect(dev.ioctl(TFTIOCTL.SET_ROTATION, { rotation: 1 })).toBe(1);
    expect(dev.ioctl(TFTIOCTL.GET_WIDTH, null)).toBe(TFT_HEIGHT);
    expect(dev.ioctl(TFTIOCTL.GET_HEIGHT, null)).toBe(TFT_WIDTH);
    // Di rotasi 1, sudut logika (0,0) = sudut kanan-atas fisik.
    dev.ioctl(TFTIOCTL.DRAW_PIXEL, { x: 0, y: 0, color: TFT_COLOR.RED });
    dev.ioctl(TFTIOCTL.SET_ROTATION, { rotation: 0 });
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: TFT_WIDTH - 1, y: 0 })).toBe(TFT_COLOR.RED);

    expect(dev.ioctl(TFTIOCTL.SET_ROTATION, { rotation: -1 })).toBe(3);
    expect(dev.ioctl(TFTIOCTL.SET_ROTATION, { rotation: 7 })).toBe(3);
  });
});

// ================================================================
// TEKS
// ================================================================

describe("ILI9341Device — teks (C10.126-C10.129)", () => {
  /** Hitung piksel yang bukan latar (0) di seluruh back-buffer. */
  function litCount(dev: ILI9341Device): number {
    let n = 0;
    for (let y = 0; y < TFT_HEIGHT; y++) {
      for (let x = 0; x < TFT_WIDTH; x++) {
        if ((dev.ioctl(TFTIOCTL.GET_PIXEL, { x, y }) as number) !== 0) n++;
      }
    }
    return n;
  }

  it("C10.126 PRINT_TEXT menggambar glyph & PRINT memakai cursor", () => {
    const { dev } = makeReadyDevice();
    dev.ioctl(TFTIOCTL.FILL_SCREEN, { color: 0 });
    dev.ioctl(TFTIOCTL.SET_TEXT_COLOR, { color: TFT_COLOR.WHITE });
    dev.ioctl(TFTIOCTL.PRINT_TEXT, { text: "A", x: 0, y: 0, size: 1 });
    expect(litCount(dev)).toBeGreaterThan(0);
    expect(dev.getInfo().cursorX).toBe(0); // PRINT_TEXT tidak memindahkan cursor

    dev.ioctl(TFTIOCTL.SET_CURSOR, { x: 0, y: 20 });
    dev.ioctl(TFTIOCTL.PRINT, { text: "A" });
    expect(dev.getInfo().cursorX).toBe(6); // advance glcdfont 5x7 = 6 px
    expect(dev.getInfo().cursorY).toBe(20);
  });

  it("C10.126b SET_TEXT_SIZE memperbesar glyph (piksel lebih banyak)", () => {
    const small = makeReadyDevice().dev;
    small.ioctl(TFTIOCTL.FILL_SCREEN, { color: 0 });
    small.ioctl(TFTIOCTL.SET_TEXT_COLOR, { color: TFT_COLOR.WHITE });
    small.ioctl(TFTIOCTL.PRINT_TEXT, { text: "H", x: 0, y: 0, size: 1 });

    const big = makeReadyDevice().dev;
    big.ioctl(TFTIOCTL.FILL_SCREEN, { color: 0 });
    big.ioctl(TFTIOCTL.SET_TEXT_COLOR, { color: TFT_COLOR.WHITE });
    big.ioctl(TFTIOCTL.PRINT_TEXT, { text: "H", x: 0, y: 0, size: 3 });

    expect(litCount(big)).toBeGreaterThan(litCount(small));
  });

  it("C10.127 SET_TEXT_COLOR dengan bg = opaque (latar glyph ikut ditulis)", () => {
    const { dev } = makeReadyDevice();
    dev.ioctl(TFTIOCTL.FILL_SCREEN, { color: 0 });
    dev.ioctl(TFTIOCTL.SET_TEXT_COLOR, { color: TFT_COLOR.WHITE, bg: TFT_COLOR.MAROON });
    dev.ioctl(TFTIOCTL.PRINT_TEXT, { text: "i", x: 0, y: 0, size: 1 });
    // Sel 6x8 terisi: piksel yang bukan bagian glyph pasti berwarna bg.
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: 5, y: 0 })).toBe(TFT_COLOR.MAROON);
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: 10, y: 10 })).toBe(0); // di luar sel
  });

  it("C10.128 SET_FONT 1 (Adafruit GFX) memakai baseline & memajukan cursor", () => {
    const { dev } = makeReadyDevice();
    dev.ioctl(TFTIOCTL.FILL_SCREEN, { color: 0 });
    dev.ioctl(TFTIOCTL.SET_TEXT_COLOR, { color: TFT_COLOR.WHITE });
    expect(dev.ioctl(TFTIOCTL.SET_FONT, { id: 1 })).toBe(1);
    dev.ioctl(TFTIOCTL.PRINT_TEXT, { text: "Hi", x: 4, y: 20, size: 1 });
    expect(litCount(dev)).toBeGreaterThan(0);
    // PRINT_TEXT memulihkan cursor lama (belum pernah dipindah → 0)...
    expect(dev.getInfo().cursorX).toBe(0);
    // ...sedangkan PRINT memajukan cursor (xAdvance glyph GFX).
    dev.ioctl(TFTIOCTL.SET_CURSOR, { x: 4, y: 20 });
    dev.ioctl(TFTIOCTL.PRINT, { text: "Hi" });
    expect(dev.getInfo().cursorX).toBeGreaterThan(4);
  });

  it("C10.129 karakter di luar tabel (panah U+2192) tetap tampil", () => {
    const { dev } = makeReadyDevice();
    dev.ioctl(TFTIOCTL.FILL_SCREEN, { color: 0 });
    dev.ioctl(TFTIOCTL.SET_TEXT_COLOR, { color: TFT_COLOR.WHITE });
    dev.ioctl(TFTIOCTL.PRINT_TEXT, { text: "→", x: 0, y: 0, size: 1 });
    expect(litCount(dev)).toBeGreaterThan(0);
  });

  it("C10.129b SET_TEXT_WRAP membungkus baris saat melewati tepi kanan", () => {
    const wrapOn = makeReadyDevice().dev;
    wrapOn.ioctl(TFTIOCTL.FILL_SCREEN, { color: 0 });
    wrapOn.ioctl(TFTIOCTL.SET_TEXT_WRAP, true);
    wrapOn.ioctl(TFTIOCTL.SET_CURSOR, { x: 0, y: 0 });
    wrapOn.ioctl(TFTIOCTL.PRINT, { text: "x".repeat(TFT_WIDTH / 6 + 2) });
    expect(wrapOn.getInfo().cursorY).toBe(8); // pindah baris

    const wrapOff = makeReadyDevice().dev;
    wrapOff.ioctl(TFTIOCTL.FILL_SCREEN, { color: 0 });
    wrapOff.ioctl(TFTIOCTL.SET_TEXT_WRAP, false);
    wrapOff.ioctl(TFTIOCTL.SET_CURSOR, { x: 0, y: 0 });
    wrapOff.ioctl(TFTIOCTL.PRINT, { text: "x".repeat(TFT_WIDTH / 6 + 2) });
    expect(wrapOff.getInfo().cursorY).toBe(0);
  });
});

// ================================================================
// BITMAP & MODE WRITE
// ================================================================

describe("ILI9341Device — bitmap & write() (C10.130-C10.136)", () => {
  it("C10.130 DRAW_BITMAP mono 1 bpp (bit 1 = warna, bit 0 transparan)", () => {
    const { dev } = makeReadyDevice();
    dev.ioctl(TFTIOCTL.FILL_SCREEN, { color: 0 });
    // 8x1 piksel: 0b10000001 → ujung kiri & kanan menyala.
    dev.ioctl(TFTIOCTL.DRAW_BITMAP, {
      x: 0,
      y: 0,
      data: Buffer.from([0x81]),
      w: 8,
      h: 1,
      color: TFT_COLOR.YELLOW,
    });
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: 0, y: 0 })).toBe(TFT_COLOR.YELLOW);
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: 7, y: 0 })).toBe(TFT_COLOR.YELLOW);
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: 3, y: 0 })).toBe(0);
  });

  it("C10.131 DRAW_BITMAP RGB565 mentah (w*h*2 byte) memakai warna asli", () => {
    const { dev } = makeReadyDevice();
    dev.ioctl(TFTIOCTL.FILL_SCREEN, { color: 0 });
    const sprite = Buffer.alloc(2 * 2 * 2);
    sprite.writeUInt16LE(TFT_COLOR.RED, 0);
    sprite.writeUInt16LE(TFT_COLOR.GREEN, 2);
    sprite.writeUInt16LE(TFT_COLOR.BLUE, 4);
    sprite.writeUInt16LE(TFT_COLOR.WHITE, 6);
    dev.ioctl(TFTIOCTL.DRAW_BITMAP, { x: 5, y: 5, data: sprite, w: 2, h: 2 });
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: 5, y: 5 })).toBe(TFT_COLOR.RED);
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: 6, y: 5 })).toBe(TFT_COLOR.GREEN);
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: 5, y: 6 })).toBe(TFT_COLOR.BLUE);
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: 6, y: 6 })).toBe(TFT_COLOR.WHITE);
  });

  it("C10.132 write(153600 byte) = satu frame penuh yang mengganti layar", () => {
    const { dev, panel } = makeReadyDevice();
    const frame = Buffer.alloc(TFT_FRAMEBUFFER_SIZE);
    frame.writeUInt16LE(TFT_COLOR.CYAN_NEON, 0);
    expect(dev.write(frame)).toBe(true);
    const got = (panel.present as any).mock.calls.slice(-1)[0][0] as Buffer;
    expect(got.length).toBe(TFT_FRAMEBUFFER_SIZE);
    expect(framePixel(got, 0, 0)).toBe(TFT_COLOR.CYAN_NEON);

    // Frame kedua benar-benar MENGGANTI (tidak menumpuk).
    const frame2 = Buffer.alloc(TFT_FRAMEBUFFER_SIZE);
    frame2.writeUInt16LE(TFT_COLOR.RED, 0);
    dev.write(frame2);
    const got2 = (panel.present as any).mock.calls.slice(-1)[0][0] as Buffer;
    expect(framePixel(got2, 0, 0)).toBe(TFT_COLOR.RED);
  });

  it("C10.133 write(baris, offset) menimpa sebagian frame (semantik pwrite fbdev)", () => {
    const { dev, panel } = makeReadyDevice();
    dev.ioctl(TFTIOCTL.FILL_SCREEN, { color: 0 });
    dev.ioctl(TFTIOCTL.DISPLAY, null);

    const row = Buffer.alloc(TFT_STRIDE);
    for (let i = 0; i < TFT_STRIDE; i += 2) row.writeUInt16LE(TFT_COLOR.BLUE, i);
    expect(dev.write(row, TFT_STRIDE)).toBe(true); // baris ke-2

    const got = (panel.present as any).mock.calls.slice(-1)[0][0] as Buffer;
    expect(framePixel(got, 0, 0)).toBe(0x0000); // baris 1 tidak tersentuh
    expect(framePixel(got, 0, 1)).toBe(TFT_COLOR.BLUE);
    expect(framePixel(got, 0, 2)).toBe(0x0000);
  });

  it("C10.134 write blok yang melewati ujung frame ditolak + dicatat", () => {
    const { dev } = makeReadyDevice();
    expect(dev.write(Buffer.alloc(10), TFT_FRAMEBUFFER_SIZE - 5)).toBe(false);
    expect(dev.getInfo().lastError).toContain("melewati frame");
  });

  it("C10.135 write(string) mencetak teks; autoFlush mengatur present", () => {
    const { dev, panel } = makeReadyDevice();
    const calls = () => (panel.present as any).mock.calls.length;
    const before = calls();
    expect(dev.write("TSIX")).toBe(true);
    expect(calls()).toBe(before + 1); // autoFlush ON (default)

    dev.ioctl(TFTIOCTL.SET_AUTO_FLUSH, { on: false });
    expect(dev.write("lagi")).toBe(true);
    expect(calls()).toBe(before + 1); // belum present
    dev.ioctl(TFTIOCTL.DISPLAY, null);
    expect(calls()).toBe(before + 2);
    expect(dev.ioctl(TFTIOCTL.GET_AUTO_FLUSH, null)).toBe(false);
  });

  it("C10.136 write({ op, args }) memakai primitive engine yang sama", () => {
    const { dev, panel } = makeReadyDevice();
    expect(dev.write({ op: "fillScreen", args: [TFT_COLOR.PANEL_BG] })).toBe(true);
    expect(dev.write({ op: "drawPixel", args: [1, 1, TFT_COLOR.ORANGE] })).toBe(true);
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: 1, y: 1 })).toBe(TFT_COLOR.ORANGE);
    expect(dev.write({ op: "display", args: [] })).toBe(true);
    const got = (panel.present as any).mock.calls.slice(-1)[0][0] as Buffer;
    expect(framePixel(got, 1, 1)).toBe(TFT_COLOR.ORANGE);
    expect(dev.write({ op: "tidakAda", args: [] })).toBe(true); // op asing diabaikan
  });

  it("C10.136b write(bukan buffer/string/op) → false", () => {
    const { dev } = makeReadyDevice();
    expect(dev.write(42)).toBe(false);
    expect(dev.write(null)).toBe(false);
    expect(dev.write({ tidak: "ada op" })).toBe(false);
  });
});

// ================================================================
// KONTROL TAMPILAN & INFO
// ================================================================

describe("ILI9341Device — kontrol tampilan & info (C10.137-C10.146)", () => {
  it("C10.137 invert diemulasi: frame yang dikirim = XOR 16-bit", () => {
    const { dev, panel } = makeReadyDevice();
    dev.ioctl(TFTIOCTL.FILL_SCREEN, { color: TFT_COLOR.BLACK });
    expect(dev.ioctl(TFTIOCTL.SET_INVERT, { invert: true })).toBe(true);
    dev.ioctl(TFTIOCTL.DISPLAY, null);
    const got = (panel.present as any).mock.calls.slice(-1)[0][0] as Buffer;
    expect(countDifferent(got, 0xffff)).toBe(0); // hitam → putih semua

    dev.ioctl(TFTIOCTL.SET_INVERT, { invert: false });
    dev.ioctl(TFTIOCTL.DISPLAY, null);
    const normal = (panel.present as any).mock.calls.slice(-1)[0][0] as Buffer;
    expect(countDifferent(normal, 0x0000)).toBe(0);
    expect(dev.ioctl(TFTIOCTL.GET_INVERT, null)).toBe(false);
  });

  it("C10.138 backlight / brightness / displayOn diteruskan ke panel", () => {
    const { dev, panel } = makeReadyDevice();
    expect(dev.ioctl(TFTIOCTL.SET_BACKLIGHT, { on: false })).toBe(false);
    expect(panel.setBacklight).toHaveBeenLastCalledWith(false);
    expect(dev.ioctl(TFTIOCTL.GET_BACKLIGHT, null)).toBe(true); // fake panel: selalu true

    expect(dev.ioctl(TFTIOCTL.SET_BRIGHTNESS, { level: 300 })).toBe(255); // clamp
    expect(dev.ioctl(TFTIOCTL.SET_BRIGHTNESS, { level: -5 })).toBe(0);
    expect(dev.ioctl(TFTIOCTL.SET_BRIGHTNESS, { level: 99 })).toBe(99);
    expect(panel.setBrightness).toHaveBeenLastCalledWith(99);
    expect(dev.ioctl(TFTIOCTL.GET_BRIGHTNESS, null)).toBe(255);

    expect(dev.ioctl(TFTIOCTL.SET_DISPLAY_ON, { on: false })).toBe(false);
    expect(dev.ioctl(TFTIOCTL.IS_DISPLAY_ON, null)).toBe(false);
  });

  it("C10.139 SET_FB_DEVICE memindahkan node (close lama + buka baru)", () => {
    const panel = makeFakePanel({
      getDevicePath: vi.fn(() => "/dev/fb2"),
    });
    const dev = new ILI9341Device({ native: panel.panel });
    dev.init({ syslog: () => {} });
    expect(dev.getFbDevice()).toBe("/dev/fb2");
    expect(dev.ioctl(TFTIOCTL.SET_FB_DEVICE, { path: "/dev/fb3" })).toBe("/dev/fb2");
    expect(panel.closes()).toBe(1);
    expect(dev.present()).toBe(true); // dibuka lagi pada node baru
  });

  it("C10.140 GET_INFO memuat status framebuffer host & konfigurasi", () => {
    const { dev } = makeReadyDevice();
    const info = dev.getInfo();
    expect(info.device).toBe("/dev/tft");
    expect(info.available).toBe(true);
    expect(info.fbDevice).toBe("/dev/fb1");
    expect(info.fbName).toBe("fb_ili9341");
    expect(info.fbVirtualSize).toEqual({ w: TFT_WIDTH, h: TFT_HEIGHT });
    expect(info.bpp).toBe(16);
    expect(info.framebufferSize).toBe(TFT_FRAMEBUFFER_SIZE);
    expect(info.frames).toBe(0);
    expect(info.lastError).toBeNull();
    expect(JSON.parse(dev.read()).device).toBe("/dev/tft");
  });

  it("C10.141 RESET mengisi warna & langsung present", () => {
    const { dev, panel } = makeReadyDevice();
    expect(dev.ioctl(TFTIOCTL.RESET, { color: TFT_COLOR.NAVY })).toBe(true);
    const got = (panel.present as any).mock.calls.slice(-1)[0][0] as Buffer;
    expect(countDifferent(got, TFT_COLOR.NAVY)).toBe(0);
  });

  it("C10.142 drawBitmap lewat write({op}) menerima Buffer hasil JSON (IPC)", () => {
    const { dev } = makeReadyDevice();
    dev.ioctl(TFTIOCTL.FILL_SCREEN, { color: 0 });
    const json = JSON.parse(JSON.stringify(Buffer.from([0x80]))); // {type:"Buffer",data:[128]}
    expect(
      dev.write({ op: "drawBitmap", args: [0, 0, json, 8, 1, TFT_COLOR.WHITE] }),
    ).toBe(true);
    expect(dev.ioctl(TFTIOCTL.GET_PIXEL, { x: 0, y: 0 })).toBe(TFT_COLOR.WHITE);
  });
});

// ================================================================
// FbDevPanel & AUTO-DETEKSI (tanpa hardware)
// ================================================================

describe("FbDevPanel — pemilihan node & sysfs (C10.147-C10.148)", () => {
  it("C10.147 detectFbDevices tidak pernah mengembalikan /dev/fb0", () => {
    const list = detectFbDevices();
    expect(list.every((p) => p !== "/dev/fb0")).toBe(true);
    expect(Array.isArray(list)).toBe(true);
  });

  it("C10.148 FbDevPanel.begin() mengembalikan false utk node yang tidak ada", () => {
    const panel = new FbDevPanel({ device: "/dev/fb9999" });
    expect(panel.begin()).toBe(false);
    expect(panel.getDevicePath()).toBeNull();
    expect(panel.setBacklight(false)).toBe(false); // tetap bisa dipanggil
    expect(panel.close?.()).toBeUndefined();
  });
});

/**
 * Backlight panel (C10.149-C10.152) — memakai sysfs PALSU di temp dir, jadi
 * uji ini tidak pernah menyentuh `/sys/class/backlight` asli (mis. backlight
 * laptop yang kebetulan ada di mesin dev).
 */
function makeFakeBacklightDir(opts: { max?: number; writeMax?: boolean } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tsix-bl-"));
  fs.writeFileSync(path.join(dir, "bl_power"), "0"); // 0 = nyala
  fs.writeFileSync(path.join(dir, "brightness"), "128");
  if (opts.writeMax !== false) {
    fs.writeFileSync(path.join(dir, "max_brightness"), String(opts.max ?? 255));
  }
  return dir;
}

describe("FbDevPanel — backlight sysfs (C10.149-C10.152)", () => {
  const tmpDirs: string[] = [];
  const mk = (opts: { max?: number; writeMax?: boolean } = {}): string => {
    const dir = makeFakeBacklightDir(opts);
    tmpDirs.push(dir);
    return dir;
  };
  const readBl = (dir: string, file: string): string =>
    fs.readFileSync(path.join(dir, file), "utf8").trim();

  afterAll(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("C10.149 resolveBacklightPaths(): terima direktori, file, & max_brightness", () => {
    const dir = mk({ max: 100 });

    const fromDir = resolveBacklightPaths(dir, null);
    expect(fromDir?.dir).toBe(dir);
    expect(fromDir?.power).toBe(path.join(dir, "bl_power"));
    expect(fromDir?.brightness).toBe(path.join(dir, "brightness"));
    expect(fromDir?.max).toBe(100);

    // Menunjuk FILE juga sah (bentuk nilai env TSIX_TFT_BL) — direktorinya dipakai.
    expect(resolveBacklightPaths(path.join(dir, "bl_power"), null)?.dir).toBe(dir);
    expect(resolveBacklightPaths(path.join(dir, "brightness"), null)?.dir).toBe(dir);

    // Direktori tanpa `max_brightness` → skala default 0..255.
    expect(resolveBacklightPaths(mk({ writeMax: false }), null)?.max).toBe(255);

    // Path tidak ada & tanpa petunjuk fbdev → tidak ada perangkat backlight.
    expect(resolveBacklightPaths("/nonexistent/bl-dir", null)).toBeNull();
  });

  it("C10.150 setBacklight(): bl_power 0=NYALA / 1=MATI (polaritas kebalikan)", () => {
    const dir = mk();
    const panel = new FbDevPanel({ backlightPath: dir });

    expect(panel.getBacklightDir()).toBe(dir);
    expect(panel.getBacklight()).toBe(true); // file berisi "0" = nyala

    expect(panel.setBacklight(false)).toBe(false);
    expect(readBl(dir, "bl_power")).toBe("1"); // MATI → tulis 1, bukan 0
    expect(panel.getBacklight()).toBe(false);

    expect(panel.setBacklight(true)).toBe(true);
    expect(readBl(dir, "bl_power")).toBe("0"); // NYALA → tulis 0
    expect(panel.getBacklight()).toBe(true);
  });

  it("C10.151 setBrightness(): 0..255 diskalakan ke max_brightness", () => {
    const dir = mk({ max: 100 });
    const panel = new FbDevPanel({ backlightPath: dir });

    expect(panel.setBrightness(128)).toBe(128);
    expect(readBl(dir, "brightness")).toBe("50"); // 128/255 * 100
    expect(panel.getBrightness()).toBe(128); // dibaca ulang dari sysfs

    expect(panel.setBrightness(300)).toBe(255); // clamp ke 0..255
    expect(readBl(dir, "brightness")).toBe("100");

    // Saat lampu mati `brightness` TIDAK ditulis (bisa menyalakan lampu lagi),
    // jadi sysfs tetap 100 → yang terbaca kembali = 255.
    panel.setBacklight(false);
    expect(panel.setBrightness(64)).toBe(64); // nilainya tetap disimpan
    expect(readBl(dir, "brightness")).toBe("100");
    expect(panel.getBrightness()).toBe(255);
  });

  it("C10.152 tanpa bl_power/brightness: hanya status, getBrightness() null", () => {
    const dir = mk({ writeMax: false });
    fs.rmSync(path.join(dir, "bl_power"));
    fs.rmSync(path.join(dir, "brightness"));
    const panel = new FbDevPanel({ backlightPath: dir });

    expect(panel.getBacklightDir()).toBe(dir); // direktorinya tetap dikenali
    expect(panel.getBacklight()).toBe(true); // jatuh ke status tersimpan
    expect(panel.setBacklight(false)).toBe(false);
    expect(panel.getBacklight()).toBe(false);
    expect(panel.getBrightness()).toBeNull();
  });
});
