import { describe, it, expect, vi } from "vitest";

import {
  LcdLib,
  LcdFramebuffer,
  LcdFont,
  LCD_DEVICE_PATH,
  LCD_WIDTH,
  LCD_HEIGHT,
  LCD_FB_SIZE,
} from "./lcdLib";

/**
 * Nomor ioctl di bawah HARUS sama dengan enum `LCDIOCTL` di driver kernel
 * (src/kernel/devices/aux-devices/LM6029Device.ts) — pola yang sama dengan
 * joystickLib ↔ joystick.ts.
 */
const C = {
  BEGIN: 0x4c01,
  RESET: 0x4c02,
  CLEAR: 0x4c03,
  DISPLAY: 0x4c04,
  DRAW_PIXEL: 0x4c10,
  FILL_SCREEN: 0x4c11,
  DRAW_LINE: 0x4c12,
  DRAW_RECT: 0x4c13,
  FILL_RECT: 0x4c14,
  DRAW_CIRCLE: 0x4c15,
  FILL_CIRCLE: 0x4c16,
  DRAW_TRIANGLE: 0x4c17,
  FILL_TRIANGLE: 0x4c18,
  DRAW_ROUND_RECT: 0x4c19,
  FILL_ROUND_RECT: 0x4c1a,
  DRAW_BITMAP: 0x4c1b,
  SET_FONT: 0x4c20,
  SET_TEXT_COLOR: 0x4c21,
  SET_TEXT_SIZE: 0x4c22,
  SET_TEXT_WRAP: 0x4c23,
  SET_CURSOR: 0x4c24,
  PRINT: 0x4c25,
  PRINT_TEXT: 0x4c26,
  SET_ROTATION: 0x4c27,
  SET_CONTRAST: 0x4c30,
  GET_CONTRAST: 0x4c31,
  SET_BACKLIGHT: 0x4c32,
  GET_BACKLIGHT: 0x4c33,
  SET_INVERT: 0x4c34,
  GET_INVERT: 0x4c35,
  SET_DISPLAY_ON: 0x4c36,
  IS_DISPLAY_ON: 0x4c37,
  SET_SPI_SPEED: 0x4c38,
  GET_SPI_SPEED: 0x4c39,
  GET_INFO: 0x4c40,
  GET_WIDTH: 0x4c41,
  GET_HEIGHT: 0x4c42,
  SET_AUTO_FLUSH: 0x4c43,
  GET_AUTO_FLUSH: 0x4c44,
} as const;

const FD = 7;

const INFO = {
  device: LCD_DEVICE_PATH,
  available: true,
  width: LCD_WIDTH,
  height: LCD_HEIGHT,
  pages: 8,
  framebufferSize: LCD_FB_SIZE,
  spiSpeed: 7812500,
  contrast: 31,
  backlight: true,
  invert: false,
  displayOn: true,
  autoFlush: true,
};

/**
 * Fake UserLib: ioctl "loopback" — perintah set mengembalikan nilai yang
 * dikirim, perintah get mengembalikan nilai tetap (meniru driver).
 */
function makeLib() {
  const ioctl = vi.fn(async (_fd: number, cmd: number, arg: any) => {
    switch (cmd) {
      case C.GET_INFO:
        return INFO;
      case C.GET_WIDTH:
        return LCD_WIDTH;
      case C.GET_HEIGHT:
        return LCD_HEIGHT;
      case C.GET_CONTRAST:
        return 31;
      case C.GET_BACKLIGHT:
        return true;
      case C.GET_INVERT:
        return false;
      case C.IS_DISPLAY_ON:
        return true;
      case C.GET_SPI_SPEED:
        return 7812500;
      case C.GET_AUTO_FLUSH:
        return true;
      case C.SET_FONT:
        return arg?.id;
      case C.SET_CONTRAST:
        return Math.max(0, Math.min(63, Number(arg?.level)));
      case C.SET_ROTATION:
        return arg?.rotation;
      case C.SET_SPI_SPEED:
        return arg?.hz;
      case C.SET_BACKLIGHT:
        return arg?.on;
      case C.SET_INVERT:
        return arg?.invert;
      case C.SET_DISPLAY_ON:
        return arg?.on;
      case C.SET_AUTO_FLUSH:
        return arg?.on;
      case C.BEGIN:
        return true;
      default:
        return true;
    }
  });

  const fs = {
    open: vi.fn(async () => FD),
    close: vi.fn(async () => true),
    read: vi.fn(async () => JSON.stringify(INFO)),
    write: vi.fn(async () => true),
  };

  return { lib: new LcdLib({ fs, std: { ioctl } }), ioctl, fs };
}

describe("LcdLib — device & lifecycle", () => {
  it("C11.01 open device sekali (lazy) lewat lcdLib", async () => {
    const { lib, fs } = makeLib();
    expect(fs.open).not.toHaveBeenCalled();
    await lib.clear();
    await lib.flush();
    expect(fs.open).toHaveBeenCalledTimes(1);
    expect(fs.open).toHaveBeenCalledWith(LCD_DEVICE_PATH, "w+");
  });

  it("C11.02 isAvailable() dari GET_INFO.available", async () => {
    const { lib } = makeLib();
    expect(await lib.isAvailable()).toBe(true);
  });

  it("C11.03 getInfo/getWidth/getHeight", async () => {
    const { lib } = makeLib();
    const info = await lib.getInfo();
    expect(info?.device).toBe(LCD_DEVICE_PATH);
    expect(info?.framebufferSize).toBe(LCD_FB_SIZE);
    expect(await lib.getWidth()).toBe(LCD_WIDTH);
    expect(await lib.getHeight()).toBe(LCD_HEIGHT);
  });

  it("C11.04 clear/flush/display/reset memakai ioctl yang benar", async () => {
    const { lib, ioctl } = makeLib();
    await lib.clear();
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.CLEAR, null);
    await lib.flush();
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.DISPLAY, null);
    await lib.display();
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.DISPLAY, null);
    await lib.reset();
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.RESET, null);
  });

  it("C11.05 close() melepas FD & bisa dibuka lagi", async () => {
    const { lib, fs } = makeLib();
    await lib.clear();
    await lib.close();
    expect(fs.close).toHaveBeenCalledWith(FD);
    await lib.clear();
    expect(fs.open).toHaveBeenCalledTimes(2);
  });

  it("C11.06 tanpa UserLib → error jelas, tidak crash", async () => {
    const saved = (global as any)._tsixLib;
    (global as any)._tsixLib = undefined;
    try {
      const orphan = new LcdLib(null);
      await expect(orphan.clear()).rejects.toThrow(/UserLib tidak tersedia/);
      expect(await orphan.isAvailable()).toBe(false);
      expect(await orphan.getInfo()).toBeNull();
      expect(await orphan.readRaw()).toBeNull();
    } finally {
      (global as any)._tsixLib = saved;
    }
  });
});

describe("LcdLib — grafik & teks", () => {
  it("C11.07 setAutoFlush + isAutoFlush", async () => {
    const { lib, ioctl } = makeLib();
    expect(await lib.setAutoFlush(false)).toBe(false);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.SET_AUTO_FLUSH, { on: false });
    expect(await lib.isAutoFlush()).toBe(true);
  });

  it("C11.08 primitive grafis pakai ioctl yang tepat", async () => {
    const { lib, ioctl } = makeLib();
    await lib.drawPixel(1, 2);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.DRAW_PIXEL, { x: 1, y: 2, color: 1 });
    await lib.fillScreen(0);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.FILL_SCREEN, { color: 0 });
    await lib.drawLine(1, 2, 3, 4);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.DRAW_LINE, { x0: 1, y0: 2, x1: 3, y1: 4, color: 1 });
    await lib.drawRect(1, 2, 3, 4);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.DRAW_RECT, { x: 1, y: 2, w: 3, h: 4, color: 1 });
    await lib.fillRect(1, 2, 3, 4);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.FILL_RECT, { x: 1, y: 2, w: 3, h: 4, color: 1 });
    await lib.drawCircle(5, 6, 7);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.DRAW_CIRCLE, { x: 5, y: 6, r: 7, color: 1 });
    await lib.fillCircle(5, 6, 7);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.FILL_CIRCLE, { x: 5, y: 6, r: 7, color: 1 });
    await lib.drawTriangle(1, 2, 3, 4, 5, 6);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.DRAW_TRIANGLE, {
      x0: 1, y0: 2, x1: 3, y1: 4, x2: 5, y2: 6, color: 1,
    });
    await lib.fillTriangle(1, 2, 3, 4, 5, 6);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.FILL_TRIANGLE, {
      x0: 1, y0: 2, x1: 3, y1: 4, x2: 5, y2: 6, color: 1,
    });
    await lib.drawRoundRect(1, 2, 3, 4, 5);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.DRAW_ROUND_RECT, { x: 1, y: 2, w: 3, h: 4, r: 5, color: 1 });
    await lib.fillRoundRect(1, 2, 3, 4, 5);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.FILL_ROUND_RECT, { x: 1, y: 2, w: 3, h: 4, r: 5, color: 1 });
  });

  it("C11.09 konstanta LcdFont", () => {
    expect(LcdFont.DEFAULT).toBe(0);
    expect(LcdFont.FREE_SANS_9).toBe(1);
    expect(LcdFont.FREE_SANS_BOLD_12).toBe(2);
    expect(LcdFont.FREE_MONO_9).toBe(3);
  });

  it("C11.10 teks: font, warna, ukuran, cursor, print", async () => {
    const { lib, ioctl } = makeLib();
    expect(await lib.setFont(LcdFont.FREE_MONO_9)).toBe(3);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.SET_FONT, { id: 3 });

    await lib.setTextColor(1);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.SET_TEXT_COLOR, { color: 1 });
    await lib.setTextColor(0, 1);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.SET_TEXT_COLOR, { color: 0, bg: 1 });

    await lib.setTextSize(2);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.SET_TEXT_SIZE, { size: 2 });
    await lib.setTextWrap(false);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.SET_TEXT_WRAP, { wrap: false });
    await lib.setCursor(3, 4);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.SET_CURSOR, { x: 3, y: 4 });
    await lib.print("Halo");
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.PRINT, { text: "Halo" });
    await lib.printText("Halo", 1, 2, 2);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.PRINT_TEXT, { text: "Halo", x: 1, y: 2, size: 2 });
  });

  it("C11.11 printCentered menghitung x dari lebar font default", async () => {
    const { lib, ioctl } = makeLib();
    await lib.printCentered("AAAA", 10, 1); // 4 * 6 * 1 = 24 → (128-24)/2 = 52
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.PRINT_TEXT, { text: "AAAA", x: 52, y: 10, size: 1 });
  });

  it("C11.12 drawBitmap mengirim byte bitmap", async () => {
    const { lib, ioctl } = makeLib();
    const bmp = new Uint8Array(16).fill(0xff);
    await lib.drawBitmap(1, 2, bmp, 8, 16);
    const [, cmd, arg] = ioctl.mock.calls[ioctl.mock.calls.length - 1];
    expect(cmd).toBe(C.DRAW_BITMAP);
    expect(arg.x).toBe(1);
    expect(arg.y).toBe(2);
    expect(arg.w).toBe(8);
    expect(arg.h).toBe(16);
    expect(arg.color).toBe(1);
    expect(arg.data).toBe(bmp);
  });
});

describe("LcdLib — kontrol tampilan", () => {
  it("C11.13 kontras di-clamp dan getter bekerja", async () => {
    const { lib, ioctl } = makeLib();
    expect(await lib.setContrast(200)).toBe(63);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.SET_CONTRAST, { level: 200 });
    expect(await lib.getContrast()).toBe(31);
  });

  it("C11.14 backlight / invert / displayOn / spiSpeed / rotation", async () => {
    const { lib, ioctl } = makeLib();
    expect(await lib.setBacklight(false)).toBe(false);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.SET_BACKLIGHT, { on: false });
    expect(await lib.getBacklight()).toBe(true);

    expect(await lib.setInvert(true)).toBe(true);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.SET_INVERT, { invert: true });
    expect(await lib.getInvert()).toBe(false);

    expect(await lib.setDisplayOn(true)).toBe(true);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.SET_DISPLAY_ON, { on: true });
    expect(await lib.isDisplayOn()).toBe(true);

    expect(await lib.setSpiSpeed(32000000)).toBe(32000000);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.SET_SPI_SPEED, { hz: 32000000 });
    expect(await lib.getSpiSpeed()).toBe(7812500);

    expect(await lib.setRotation(1)).toBe(1);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.SET_ROTATION, { rotation: 1 });
  });

  it("C11.15 readRaw() mengembalikan JSON string dari device", async () => {
    const { lib } = makeLib();
    const raw = await lib.readRaw();
    expect(raw).toContain('"device":"/dev/lcd"');
  });
});

describe("LcdFramebuffer — back-buffer 1 bpp", () => {
  it("C11.16 ukuran & layout MSB-first row-major", () => {
    const fb = new LcdFramebuffer();
    expect(fb.width).toBe(LCD_WIDTH);
    expect(fb.height).toBe(LCD_HEIGHT);
    expect(fb.stride).toBe(LCD_WIDTH / 8);
    expect(fb.bytes.length).toBe(LCD_FB_SIZE);

    fb.setPixel(0, 0, 1);
    expect(fb.bytes[0]).toBe(0x80); // bit MSB = x paling kiri
    fb.setPixel(7, 0, 1);
    expect(fb.bytes[0]).toBe(0x81);
    fb.setPixel(8, 0, 1);
    expect(fb.bytes[1]).toBe(0x80); // byte berikutnya
    fb.setPixel(0, 1, 1);
    expect(fb.bytes[16]).toBe(0x80); // y menambah stride
  });

  it("C11.17 setPixel/getPixel/togglePixel + koordinat luar diabaikan", () => {
    const fb = new LcdFramebuffer();
    fb.setPixel(5, 5, 1);
    expect(fb.getPixel(5, 5)).toBe(1);
    fb.setPixel(5, 5, 0);
    expect(fb.getPixel(5, 5)).toBe(0);
    fb.togglePixel(5, 5);
    expect(fb.getPixel(5, 5)).toBe(1);
    expect(() => fb.setPixel(-1, 999, 1)).not.toThrow();
    expect(fb.getPixel(-1, 0)).toBe(0);
    expect(fb.getPixel(0, LCD_HEIGHT)).toBe(0);
  });

  it("C11.18 clear/hLine/vLine/line/rect/fillRect", () => {
    const fb = new LcdFramebuffer();
    fb.clear(1);
    expect(fb.bytes.every((b) => b === 0xff)).toBe(true);
    fb.clear();
    expect(fb.bytes.every((b) => b === 0x00)).toBe(true);

    fb.hLine(0, 3, 4, 1);
    expect(fb.getPixel(0, 3)).toBe(1);
    expect(fb.getPixel(3, 3)).toBe(1);
    fb.vLine(10, 0, 4, 1);
    expect(fb.getPixel(10, 3)).toBe(1);

    fb.clear();
    fb.line(0, 0, 9, 9, 1);
    expect(fb.getPixel(0, 0)).toBe(1);
    expect(fb.getPixel(9, 9)).toBe(1);

    fb.clear();
    fb.rect(0, 0, 5, 5, 1);
    expect(fb.getPixel(0, 0)).toBe(1);
    expect(fb.getPixel(4, 0)).toBe(1);
    expect(fb.getPixel(2, 2)).toBe(0); // outline saja
    fb.fillRect(0, 0, 5, 5, 1);
    expect(fb.getPixel(2, 2)).toBe(1);
  });

  it("C11.19 circle/fillCircle/invert", () => {
    const fb = new LcdFramebuffer();
    fb.circle(20, 20, 5, 1);
    expect(fb.getPixel(25, 20)).toBe(1);
    expect(fb.getPixel(20, 20)).toBe(0);

    fb.clear();
    fb.fillCircle(20, 20, 5, 1);
    expect(fb.getPixel(20, 20)).toBe(1);
    expect(fb.getPixel(20, 25)).toBe(1);

    fb.invert();
    expect(fb.getPixel(20, 20)).toBe(0);
  });

  it("C11.20 blit() mengirim 1024 byte lewat fs.write", async () => {
    const { lib, fs } = makeLib();
    const fb = lib.framebuffer();
    fb.fillRect(0, 0, 8, 8, 1);
    expect(await lib.blit(fb)).toBe(true);
    expect(fs.write).toHaveBeenCalledWith(FD, fb.bytes);
    expect(fb.bytes.length).toBe(LCD_FB_SIZE);
  });
});
