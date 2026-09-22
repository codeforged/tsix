import { describe, it, expect, vi, afterEach } from "vitest";

import {
  TftLib,
  TftFramebuffer,
  TftFont,
  TFT_COLOR,
  TFT_DEVICE_PATH,
  TFT_DEVICE_ENV,
  TFT_WIDTH,
  TFT_HEIGHT,
  TFT_STRIDE,
  TFT_FB_SIZE,
  rgb,
  rgb565,
  hex565,
  unpack565,
  type TftLibOptions,
} from "./tftLib";

/**
 * Nomor ioctl di bawah HARUS sama dengan enum `TFTIOCTL` di driver kernel
 * (src/kernel/devices/aux-devices/ILI9341Device.ts) — pola yang sama dengan
 * lcdLib ↔ LM6029Device.
 */
const C = {
  BEGIN: 0x5401,
  RESET: 0x5402,
  CLEAR: 0x5403,
  DISPLAY: 0x5404,
  DRAW_PIXEL: 0x5410,
  FILL_SCREEN: 0x5411,
  DRAW_LINE: 0x5412,
  DRAW_RECT: 0x5413,
  FILL_RECT: 0x5414,
  DRAW_CIRCLE: 0x5415,
  FILL_CIRCLE: 0x5416,
  DRAW_TRIANGLE: 0x5417,
  FILL_TRIANGLE: 0x5418,
  DRAW_ROUND_RECT: 0x5419,
  FILL_ROUND_RECT: 0x541a,
  DRAW_BITMAP: 0x541b,
  GET_PIXEL: 0x541c,
  SET_FONT: 0x5420,
  SET_TEXT_COLOR: 0x5421,
  SET_TEXT_SIZE: 0x5422,
  SET_TEXT_WRAP: 0x5423,
  SET_CURSOR: 0x5424,
  PRINT: 0x5425,
  PRINT_TEXT: 0x5426,
  SET_ROTATION: 0x5427,
  SET_BACKLIGHT: 0x5430,
  GET_BACKLIGHT: 0x5431,
  SET_DISPLAY_ON: 0x5432,
  IS_DISPLAY_ON: 0x5433,
  SET_INVERT: 0x5434,
  GET_INVERT: 0x5435,
  SET_BRIGHTNESS: 0x5436,
  GET_BRIGHTNESS: 0x5437,
  SET_FB_DEVICE: 0x5438,
  GET_FB_DEVICE: 0x5439,
  GET_INFO: 0x5440,
  GET_WIDTH: 0x5441,
  GET_HEIGHT: 0x5442,
  SET_AUTO_FLUSH: 0x5443,
  GET_AUTO_FLUSH: 0x5444,
  GET_FB_SIZE: 0x5445,
  GET_STRIDE: 0x5446,
} as const;

const FD = 9;

const INFO = {
  device: TFT_DEVICE_PATH,
  available: true,
  width: TFT_WIDTH,
  height: TFT_HEIGHT,
  panelWidth: TFT_WIDTH,
  panelHeight: TFT_HEIGHT,
  bpp: 16,
  stride: TFT_STRIDE,
  framebufferSize: TFT_FB_SIZE,
  fbDevice: "/dev/fb1",
  fbName: "fb_ili9341",
  fbVirtualSize: { w: TFT_WIDTH, h: TFT_HEIGHT },
  rotation: 0,
  invert: false,
  displayOn: true,
  backlight: true,
  brightness: 255,
  autoFlush: true,
  fontId: 0,
  textColor: TFT_COLOR.WHITE,
  textBg: null,
  textSize: 1,
  textWrap: true,
  cursorX: 0,
  cursorY: 0,
  frames: 0,
  lastError: null,
};

/**
 * Fake UserLib: ioctl "loopback" — perintah set mengembalikan nilai yang
 * dikirim, perintah get mengembalikan nilai tetap (meniru driver).
 */
function makeLib(options: TftLibOptions = {}) {
  const ioctl = vi.fn(async (_fd: number, cmd: number, arg: any) => {
    switch (cmd) {
      case C.GET_INFO:
        return INFO;
      case C.GET_WIDTH:
        return TFT_WIDTH;
      case C.GET_HEIGHT:
        return TFT_HEIGHT;
      case C.GET_FB_SIZE:
        return TFT_FB_SIZE;
      case C.GET_STRIDE:
        return TFT_STRIDE;
      case C.GET_FB_DEVICE:
        return "/dev/fb1";
      case C.GET_BACKLIGHT:
        return true;
      case C.GET_BRIGHTNESS:
        return 255;
      case C.IS_DISPLAY_ON:
        return true;
      case C.GET_INVERT:
        return false;
      case C.GET_AUTO_FLUSH:
        return true;
      case C.GET_PIXEL:
        return TFT_COLOR.CYAN_NEON;
      case C.SET_FONT:
        return arg?.id;
      case C.SET_ROTATION:
        return arg?.rotation;
      case C.SET_BRIGHTNESS:
        return Math.max(0, Math.min(255, Number(arg?.level)));
      case C.SET_BACKLIGHT:
        return arg?.on;
      case C.SET_DISPLAY_ON:
        return arg?.on;
      case C.SET_INVERT:
        return arg?.invert;
      case C.SET_AUTO_FLUSH:
        return arg?.on;
      case C.SET_FB_DEVICE:
        return arg?.path;
      case C.SET_TEXT_COLOR:
        return true;
      case C.PRINT_TEXT:
        return true;
      default:
        return true;
    }
  });

  const fs = {
    open: vi.fn(async (_path: string, _mode: string) => FD),
    close: vi.fn(async (_fd: number) => {}),
    write: vi.fn(async (_fd: number, _data: Uint8Array) => true),
    read: vi.fn(async (_fd: number) => JSON.stringify(INFO)),
  };

  return { lib: new TftLib({ fs, std: { ioctl } }, options), ioctl, fs };
}

describe("TftLib — lifecycle & device (C11.40-C11.47)", () => {
  it("C11.40 open device sekali (lazy) lewat tftLib", async () => {
    const { lib, fs } = makeLib();
    expect(fs.open).not.toHaveBeenCalled();
    await lib.clear();
    await lib.flush();
    expect(fs.open).toHaveBeenCalledTimes(1);
    expect(fs.open).toHaveBeenCalledWith(TFT_DEVICE_PATH, "w+");
  });

  it("C11.41 isAvailable() dari GET_INFO.available", async () => {
    const { lib } = makeLib();
    expect(await lib.isAvailable()).toBe(true);
    const dead = new TftLib({ fs: { open: async () => -1 } });
    expect(await dead.isAvailable()).toBe(false);
  });

  it("C11.42 getInfo/getWidth/getHeight/getStride/getFramebufferSize", async () => {
    const { lib } = makeLib();
    const info = await lib.getInfo();
    expect(info?.fbName).toBe("fb_ili9341");
    expect(info?.fbDevice).toBe("/dev/fb1");
    expect(await lib.getWidth()).toBe(TFT_WIDTH);
    expect(await lib.getHeight()).toBe(TFT_HEIGHT);
    expect(await lib.getStride()).toBe(TFT_STRIDE);
    expect(await lib.getFramebufferSize()).toBe(TFT_FB_SIZE);
    expect(await lib.getFbDevice()).toBe("/dev/fb1");
  });

  it("C11.43 clear/flush/display/reset memakai ioctl yang benar", async () => {
    const { lib, ioctl } = makeLib();
    await lib.clear(TFT_COLOR.NAVY);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.CLEAR, { color: TFT_COLOR.NAVY });
    await lib.flush();
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.DISPLAY, null);
    await lib.display();
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.DISPLAY, null);
    await lib.reset(TFT_COLOR.BLACK);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.RESET, { color: TFT_COLOR.BLACK });
  });

  it("C11.44 close() melepas FD & bisa dibuka lagi", async () => {
    const { lib, fs } = makeLib();
    await lib.clear();
    await lib.close();
    expect(fs.close).toHaveBeenCalledWith(FD);
    await lib.clear();
    expect(fs.open).toHaveBeenCalledTimes(2);
  });

  it("C11.45 tanpa UserLib → error jelas, tidak crash", async () => {
    const orphan = new TftLib(null);
    await expect(orphan.clear()).rejects.toThrow(/UserLib tidak tersedia/);
  });

  it("C11.46 fd gagal dibuka → pesan menyebut driver/framebuffer", async () => {
    const lib = new TftLib({ fs: { open: async () => -1 }, std: { ioctl: vi.fn() } });
    await expect(lib.clear()).rejects.toThrow(/Gagal buka \/dev\/tft[\s\S]*fb1/);
  });

  it("C11.47 setAutoFlush + isAutoFlush + begin + setFbDevice", async () => {
    const { lib, ioctl } = makeLib();
    expect(await lib.setAutoFlush(false)).toBe(false);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.SET_AUTO_FLUSH, { on: false });
    expect(await lib.isAutoFlush()).toBe(true);
    expect(await lib.begin()).toBe(true);
    expect(await lib.setFbDevice("/dev/fb2")).toBe("/dev/fb2");
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.SET_FB_DEVICE, { path: "/dev/fb2" });
  });
});

describe("TftLib — grafik (C11.48-C11.52)", () => {
  it("C11.48 primitive grafis pakai ioctl yang tepat", async () => {
    const { lib, ioctl } = makeLib();
    await lib.drawPixel(1, 2, TFT_COLOR.RED);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.DRAW_PIXEL, { x: 1, y: 2, color: TFT_COLOR.RED });
    await lib.fillScreen(TFT_COLOR.BLUE);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.FILL_SCREEN, { color: TFT_COLOR.BLUE });
    await lib.drawLine(0, 0, 9, 9, TFT_COLOR.GREEN);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.DRAW_LINE, { x0: 0, y0: 0, x1: 9, y1: 9, color: TFT_COLOR.GREEN });
    await lib.drawRect(1, 1, 5, 5, TFT_COLOR.WHITE);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.DRAW_RECT, { x: 1, y: 1, w: 5, h: 5, color: TFT_COLOR.WHITE });
    await lib.fillRect(1, 1, 5, 5, TFT_COLOR.WHITE);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.FILL_RECT, { x: 1, y: 1, w: 5, h: 5, color: TFT_COLOR.WHITE });
    await lib.fillCircle(10, 10, 4, TFT_COLOR.YELLOW);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.FILL_CIRCLE, { x: 10, y: 10, r: 4, color: TFT_COLOR.YELLOW });
    await lib.drawCircle(10, 10, 4, TFT_COLOR.YELLOW);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.DRAW_CIRCLE, { x: 10, y: 10, r: 4, color: TFT_COLOR.YELLOW });
    await lib.fillTriangle(0, 0, 4, 0, 2, 4, TFT_COLOR.ORANGE);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.FILL_TRIANGLE, {
      x0: 0, y0: 0, x1: 4, y1: 0, x2: 2, y2: 4, color: TFT_COLOR.ORANGE,
    });
    await lib.drawTriangle(0, 0, 4, 0, 2, 4, TFT_COLOR.ORANGE);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.DRAW_TRIANGLE, {
      x0: 0, y0: 0, x1: 4, y1: 0, x2: 2, y2: 4, color: TFT_COLOR.ORANGE,
    });
    await lib.fillRoundRect(2, 2, 10, 10, 3, TFT_COLOR.GRAY);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.FILL_ROUND_RECT, {
      x: 2, y: 2, w: 10, h: 10, r: 3, color: TFT_COLOR.GRAY,
    });
    await lib.drawRoundRect(2, 2, 10, 10, 3, TFT_COLOR.GRAY);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.DRAW_ROUND_RECT, {
      x: 2, y: 2, w: 10, h: 10, r: 3, color: TFT_COLOR.GRAY,
    });
  });

  it("C11.49 getPixel membaca warna", async () => {
    const { lib } = makeLib();
    expect(await lib.getPixel(3, 4)).toBe(TFT_COLOR.CYAN_NEON);
  });

  it("C11.50 drawBitmap mengirim byte bitmap (1 bpp) & menerima framebuffer", async () => {
    const { lib, ioctl } = makeLib();
    const mono = new Uint8Array([0x81]);
    await lib.drawBitmap(0, 0, mono, 8, 1, TFT_COLOR.WHITE);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.DRAW_BITMAP, {
      x: 0, y: 0, data: mono, w: 8, h: 1, color: TFT_COLOR.WHITE,
    });

    const sprite = new TftFramebuffer(2, 2);
    sprite.setPixel(0, 0, TFT_COLOR.RED);
    await lib.drawBitmap(0, 0, sprite, 2, 2);
    const call = ioctl.mock.calls.slice(-1)[0];
    expect(call[1]).toBe(C.DRAW_BITMAP);
    expect(call[2].data).toBe(sprite.bytes); // zero-copy: view yang sama
  });

  it("C11.51 setRotation + teks: font, warna, ukuran, cursor, print", async () => {
    const { lib, ioctl } = makeLib();
    expect(await lib.setRotation(1)).toBe(1);
    expect(await lib.setFont(TftFont.FREE_SANS_9)).toBe(1);
    await lib.setTextColor(TFT_COLOR.WHITE, TFT_COLOR.BLACK);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.SET_TEXT_COLOR, { color: TFT_COLOR.WHITE, bg: TFT_COLOR.BLACK });
    await lib.setTextColor(TFT_COLOR.RED);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.SET_TEXT_COLOR, { color: TFT_COLOR.RED });
    await lib.setTextSize(2);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.SET_TEXT_SIZE, { size: 2 });
    await lib.setTextWrap(false);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.SET_TEXT_WRAP, { wrap: false });
    await lib.setCursor(4, 5);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.SET_CURSOR, { x: 4, y: 5 });
    await lib.print("hi");
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.PRINT, { text: "hi" });
    await lib.printText("TSIX", 10, 20, 3);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.PRINT_TEXT, { text: "TSIX", x: 10, y: 20, size: 3 });
  });

  it("C11.52 printCentered menghitung x dari lebar font default (6 px * size)", async () => {
    const { lib, ioctl } = makeLib();
    await lib.printCentered("TSIX", 40, 2);
    expect(ioctl).toHaveBeenLastCalledWith(FD, C.PRINT_TEXT, {
      text: "TSIX",
      x: Math.round((TFT_WIDTH - 4 * 6 * 2) / 2),
      y: 40,
      size: 2,
    });
    await lib.printCentered("TSIX", 40, 1, 240); // lebar logika custom (portrait)
    expect(ioctl.mock.calls.slice(-1)[0][2].x).toBe(Math.round((240 - 24) / 2));
  });
});

describe("TftLib — kontrol tampilan (C11.53-C11.55)", () => {
  it("C11.53 backlight / displayOn / invert", async () => {
    const { lib } = makeLib();
    expect(await lib.setBacklight(false)).toBe(false);
    expect(await lib.getBacklight()).toBe(true);
    expect(await lib.setDisplayOn(false)).toBe(false);
    expect(await lib.isDisplayOn()).toBe(true);
    expect(await lib.setInvert(true)).toBe(true);
    expect(await lib.getInvert()).toBe(false);
  });

  it("C11.53b backlightOn/backlightOff/toggleBacklight = pembungkus setBacklight", async () => {
    const { lib, ioctl } = makeLib();

    expect(await lib.backlightOff()).toBe(false);
    expect(ioctl.mock.calls.slice(-1)[0][2].on).toBe(false);

    expect(await lib.backlightOn()).toBe(true);
    expect(ioctl.mock.calls.slice(-1)[0][2].on).toBe(true);

    // getBacklight() mock selalu true → toggle = matikan lampu.
    expect(await lib.toggleBacklight()).toBe(false);
    expect(ioctl.mock.calls.slice(-1)[0][2].on).toBe(false);
  });

  it("C11.54 brightness di-clamp & getter bekerja", async () => {
    const { lib } = makeLib();
    expect(await lib.setBrightness(300)).toBe(255);
    expect(await lib.setBrightness(-10)).toBe(0);
    expect(await lib.setBrightness(128)).toBe(128);
    expect(await lib.getBrightness()).toBe(255);
  });

  it("C11.55 readRaw() mengembalikan JSON string dari device", async () => {
    const { lib } = makeLib();
    const raw = await lib.readRaw();
    expect(typeof raw).toBe("string");
    expect(JSON.parse(raw!).available).toBe(true);
  });
});

describe("TftFramebuffer — back-buffer RGB565 (C11.56-C11.61)", () => {
  it("C11.56 ukuran & layout: 320x240, stride 640, 153600 byte", () => {
    const fb = new TftFramebuffer();
    expect(fb.width).toBe(TFT_WIDTH);
    expect(fb.height).toBe(TFT_HEIGHT);
    expect(fb.stride).toBe(TFT_STRIDE);
    expect(fb.bytes.length).toBe(TFT_FB_SIZE);
    expect(fb.words.length).toBe(TFT_WIDTH * TFT_HEIGHT);
    expect(fb.words.buffer).toBe(fb.bytes.buffer); // satu memori, dua view
  });

  it("C11.57 setPixel/getPixel + koordinat luar diabaikan", () => {
    const fb = new TftFramebuffer();
    fb.setPixel(1, 2, TFT_COLOR.RED);
    expect(fb.getPixel(1, 2)).toBe(TFT_COLOR.RED);
    fb.setPixel(-1, 0, TFT_COLOR.RED);
    fb.setPixel(0, TFT_HEIGHT, TFT_COLOR.RED);
    expect(fb.getPixel(-1, 0)).toBe(0); // luar → 0
    expect(fb.getPixel(1, 2)).toBe(TFT_COLOR.RED);
  });

  it("C11.58 byte layout little-endian row-major (siap kirim ke /dev/fbN)", () => {
    const fb = new TftFramebuffer(2, 2);
    fb.setPixel(1, 0, 0x1234);
    const o = 1 * 2;
    expect(fb.bytes[o]).toBe(0x34); // LSB dulu
    expect(fb.bytes[o + 1]).toBe(0x12);
  });

  it("C11.59 clear/hLine/vLine/line/rect/fillRect", () => {
    const fb = new TftFramebuffer(20, 20);
    fb.clear(TFT_COLOR.BLUE);
    expect(fb.getPixel(19, 19)).toBe(TFT_COLOR.BLUE);
    fb.hLine(0, 0, 20, TFT_COLOR.RED);
    expect(fb.getPixel(19, 0)).toBe(TFT_COLOR.RED);
    fb.vLine(0, 0, 20, TFT_COLOR.GREEN);
    expect(fb.getPixel(0, 19)).toBe(TFT_COLOR.GREEN);
    fb.line(0, 0, 19, 19, TFT_COLOR.YELLOW);
    expect(fb.getPixel(10, 10)).toBe(TFT_COLOR.YELLOW);
    fb.rect(5, 5, 4, 4, TFT_COLOR.WHITE);
    expect(fb.getPixel(5, 5)).toBe(TFT_COLOR.WHITE);
    expect(fb.getPixel(6, 6)).toBe(TFT_COLOR.YELLOW); // outline saja
    fb.fillRect(10, 10, 4, 4, TFT_COLOR.ORANGE);
    expect(fb.getPixel(12, 12)).toBe(TFT_COLOR.ORANGE);
  });

  it("C11.60 circle/fillCircle", () => {
    const fb = new TftFramebuffer(40, 40);
    fb.clear();
    fb.circle(20, 20, 10, TFT_COLOR.CYAN);
    expect(fb.getPixel(30, 20)).toBe(TFT_COLOR.CYAN);
    expect(fb.getPixel(20, 20)).toBe(0); // hanya tepi
    fb.fillCircle(20, 20, 5, TFT_COLOR.MAGENTA);
    expect(fb.getPixel(20, 20)).toBe(TFT_COLOR.MAGENTA);
  });

  it("C11.61 clear() + blit() = frame kosong (menghapus layar)", async () => {
    const { lib, fs } = makeLib();
    const fb = lib.framebuffer();
    fb.clear(TFT_COLOR.PANEL_BG);
    await lib.blit(fb);
    expect(fs.write).toHaveBeenCalledTimes(1);
    const sent = fs.write.mock.calls[0][1] as Uint8Array;
    expect(sent.length).toBe(TFT_FB_SIZE);
    expect(sent[0] | (sent[1] << 8)).toBe(TFT_COLOR.PANEL_BG);
  });

  it("C11.61b blit() menolak buffer yang bukan 1 frame penuh", async () => {
    const { lib } = makeLib();
    await expect(lib.blit(new Uint8Array(10))).rejects.toThrow(/butuh 153600 byte/);
  });
});

describe("TftLib — target device & warna (C11.62-C11.67)", () => {
  afterEach(() => {
    delete (globalThis as any).process?.env?.[TFT_DEVICE_ENV];
  });

  it("C11.62 default devicePath = /dev/tft", () => {
    expect(new TftLib({}).devicePath).toBe(TFT_DEVICE_PATH);
  });

  it("C11.63 setDevicePath memindahkan pembacaan ke node lain", async () => {
    const { lib, fs } = makeLib();
    lib.setDevicePath("/dev/tft2");
    await lib.clear();
    expect(fs.open).toHaveBeenCalledWith("/dev/tft2", "w+");
  });

  it("C11.64 env TSIX_TFT_DEV dipakai bila tidak ada opsi", async () => {
    process.env[TFT_DEVICE_ENV] = "/dev/tft-env";
    const { lib, fs } = makeLib();
    await lib.clear();
    expect(fs.open).toHaveBeenCalledWith("/dev/tft-env", "w+");
  });

  it("C11.65 opsi constructor menang atas env", async () => {
    process.env[TFT_DEVICE_ENV] = "/dev/tft-env";
    const { lib } = makeLib({ devicePath: "/dev/tft-opt" });
    expect(lib.devicePath).toBe("/dev/tft-opt");
  });

  it("C11.66 pindah device menutup FD lama (tidak menyangkut)", async () => {
    const { lib, fs } = makeLib();
    await lib.clear();
    lib.setDevicePath("/dev/tft2");
    expect(fs.close).toHaveBeenCalledWith(FD);
  });

  it("C11.67 helper warna: rgb(), palet, unpack565", () => {
    expect(rgb(0, 255, 242)).toBe(TFT_COLOR.CYAN_NEON);
    expect(rgb("#00fff2")).toBe(TFT_COLOR.CYAN_NEON);
    expect(rgb(0x00fff2)).toBe(TFT_COLOR.CYAN_NEON);
    expect(rgb(200)).toBe(rgb565(200, 200, 200));
    expect(hex565("#00fff2")).toBe(TFT_COLOR.CYAN_NEON);
    expect(unpack565(TFT_COLOR.WHITE)).toEqual({ r: 255, g: 255, b: 255 });
    expect(unpack565(TFT_COLOR.BLACK)).toEqual({ r: 0, g: 0, b: 0 });
    expect(TftFont.DEFAULT).toBe(0);
  });
});
