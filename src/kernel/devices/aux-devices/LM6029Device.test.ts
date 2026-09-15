import { describe, it, expect, vi } from "vitest";

import {
  LM6029Device,
  LCDIOCTL,
  LCD_FRAMEBUFFER_SIZE,
  LCD_WIDTH,
  LCD_HEIGHT,
} from "./LM6029Device";

/**
 * Fake native handle — meniru raspi-lcd-addon/LM6029LCD tanpa menyentuh
 * hardware. Semua method jadi vi.fn() supaya bisa di-assert.
 */
function makeFakeLcd(overrides: Record<string, any> = {}): any {
  return {
    begin: vi.fn(() => true),
    clear: vi.fn(),
    clearDisplay: vi.fn(),
    display: vi.fn(),
    drawPixel: vi.fn(),
    getWidth: vi.fn(() => 128),
    getHeight: vi.fn(() => 64),
    fillScreen: vi.fn(),
    drawLine: vi.fn(),
    drawRect: vi.fn(),
    fillRect: vi.fn(),
    drawCircle: vi.fn(),
    fillCircle: vi.fn(),
    drawTriangle: vi.fn(),
    fillTriangle: vi.fn(),
    drawRoundRect: vi.fn(),
    fillRoundRect: vi.fn(),
    setFont: vi.fn(),
    setTextColor: vi.fn(),
    setTextSize: vi.fn(),
    setTextWrap: vi.fn(),
    setCursor: vi.fn(),
    print: vi.fn(),
    printText: vi.fn(),
    setRotation: vi.fn(),
    drawBitmap: vi.fn(),
    setContrast: vi.fn((v: number) => v),
    getContrast: vi.fn(() => 31),
    setBacklight: vi.fn((v: boolean) => v),
    getBacklight: vi.fn(() => true),
    setDisplayInvert: vi.fn((v: boolean) => v),
    getDisplayInvert: vi.fn(() => false),
    setDisplayOn: vi.fn((v: boolean) => v),
    isDisplayOn: vi.fn(() => true),
    setSpiSpeed: vi.fn((hz: number) => hz),
    getSpiSpeed: vi.fn(() => 7812500),
    ...overrides,
  };
}

/**
 * Fake native handle yang BENAR-BENAR menyimpan piksel — meniru
 * `LM6029ACW_595::drawPixel` + `Adafruit_GFX::drawBitmap` 6-arg, yang HANYA
 * menyalakan piksel untuk bit 1 dan TIDAK menghapus piksel lama (bit 0 tidak
 * ditulis). Dipakai untuk membuktikan semantik "blit = mengganti seluruh
 * layar" pada write() framebuffer.
 */
function makePixelLcd(): { lcd: any; px: Uint8Array } {
  const px = new Uint8Array(LCD_WIDTH * LCD_HEIGHT); // 1 byte per piksel
  const lcd = makeFakeLcd();

  lcd.clear.mockImplementation(() => px.fill(0));
  lcd.clearDisplay.mockImplementation(() => px.fill(0));
  lcd.drawPixel.mockImplementation((x: number, y: number, color: number) => {
    if (x < 0 || x >= LCD_WIDTH || y < 0 || y >= LCD_HEIGHT) return;
    px[y * LCD_WIDTH + x] = color ? 1 : 0;
  });
  lcd.drawBitmap.mockImplementation(
    (x: number, y: number, bmp: Buffer, w: number, h: number, color: number) => {
      const byteWidth = (w + 7) >> 3; // padding scanline = 1 byte penuh
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const b = bmp[j * byteWidth + (i >> 3)];
          // bit 1 → nyalakan; bit 0 → dilewati (piksel lama dibiarkan)
          if (b & (0x80 >> (i & 7))) lcd.drawPixel(x + i, y + j, color);
        }
      }
    },
  );

  return { lcd, px };
}

/** Device siap pakai (sudah init dengan fake hardware). */
function makeReadyDevice(lcd = makeFakeLcd()): {
  dev: LM6029Device;
  lcd: any;
} {
  const dev = new LM6029Device({ native: lcd });
  dev.init({ syslog: () => {} });
  return { dev, lcd };
}

describe("LM6029Device — metadata & lifecycle (C10.30-C10.34)", () => {
  it("C10.30 defaults: name lcd, root:root, 0666, not disabled", () => {
    const dev = new LM6029Device();
    expect(dev.name).toBe("lcd");
    expect(dev.uid).toBe(0);
    expect(dev.gid).toBe(0);
    expect(dev.mode).toBe(0o666);
    expect(dev.disabled).toBe(false);
  });

  it("C10.30b custom name is respected", () => {
    const dev = new LM6029Device({ name: "lcd0" });
    expect(dev.name).toBe("lcd0");
  });

  it("C10.31 present() false before hardware is up", () => {
    const dev = new LM6029Device();
    expect(dev.present()).toBe(false);
  });

  it("C10.32 init() opens hardware and reports presence", () => {
    const lcd = makeFakeLcd();
    const { dev } = makeReadyDevice(lcd);
    expect(lcd.begin).toHaveBeenCalledWith(0);
    expect(dev.present()).toBe(true);
    expect(dev.ioctl(LCDIOCTL.GET_WIDTH, null)).toBe(128);
    expect(dev.ioctl(LCDIOCTL.GET_HEIGHT, null)).toBe(64);
  });

  it("C10.33 init() with failing begin() stays hidden", () => {
    const lcd = makeFakeLcd({ begin: vi.fn(() => false) });
    const dev = new LM6029Device({ native: lcd });
    dev.init({ syslog: () => {} });
    expect(dev.present()).toBe(false);
    expect(dev.write("x")).toBe(false);
    expect(dev.read()).toContain('"available":false');
  });

  it("C10.34 disabled device is skipped on init", () => {
    const dev = new LM6029Device({ native: makeFakeLcd(), disabled: true });
    dev.init({ syslog: () => {} });
    expect(dev.present()).toBe(false);
  });

  it("C10.34b close() returns true and keeps the handle usable", () => {
    const { dev } = makeReadyDevice();
    expect(dev.close()).toBe(true);
    expect(dev.present()).toBe(true);
  });

  it("C10.34c initial options are applied on open", () => {
    const lcd = makeFakeLcd();
    const dev = new LM6029Device({
      native: lcd,
      contrast: 40,
      backlight: false,
      invert: true,
      displayOn: true,
      rotation: 2,
      spiSpeed: 32000000,
    });
    dev.init({ syslog: () => {} });
    expect(lcd.begin).toHaveBeenCalledWith(32000000);
    expect(lcd.setContrast).toHaveBeenCalledWith(40);
    expect(lcd.setBacklight).toHaveBeenCalledWith(false);
    expect(lcd.setDisplayInvert).toHaveBeenCalledWith(true);
    expect(lcd.setDisplayOn).toHaveBeenCalledWith(true);
    expect(lcd.setRotation).toHaveBeenCalledWith(2);
  });
});

describe("LM6029Device — autoRegister (C10.35)", () => {
  it("C10.35 autoRegister exists and registers /dev/lcd", () => {
    expect(typeof LM6029Device.autoRegister).toBe("function");
    const kernel: any = { devices: {} };
    LM6029Device.autoRegister(kernel);
    expect(kernel.devices.lcd).toBeInstanceOf(LM6029Device);
  });

  it("C10.35b autoRegister tolerates a broken kernel object", () => {
    expect(() => LM6029Device.autoRegister(undefined)).not.toThrow();
    expect(() => LM6029Device.autoRegister({})).not.toThrow();
  });
});

describe("LM6029Device — ioctl IDevice compliance (C10.36-C10.40)", () => {
  it("C10.36 fd refcount ioctls never touch hardware", () => {
    const { dev, lcd } = makeReadyDevice();
    expect(dev.ioctl(10, null)).toBe(0); // INC_READ_REF
    expect(dev.ioctl(20, null)).toBe(0); // INC_WRITE_REF
    expect(dev.ioctl(11, null)).toBe(0); // DEC_READ_REF
    expect(dev.ioctl(21, null)).toBe(0); // DEC_WRITE_REF
    expect(lcd.display).not.toHaveBeenCalled();
  });

  it("C10.37 unknown command returns null (never undefined)", () => {
    const { dev } = makeReadyDevice();
    expect(dev.ioctl(0, null)).toBeNull();
    expect(dev.ioctl(0x7fff, null)).toBeNull();
  });

  it("C10.38 ioctl before init returns null but BEGIN is retryable", () => {
    const dev = new LM6029Device({ native: makeFakeLcd({ begin: vi.fn(() => false) }) });
    expect(dev.ioctl(LCDIOCTL.GET_INFO, null)).toBeNull();
    expect(dev.ioctl(LCDIOCTL.BEGIN, null)).toBe(false);
  });

  it("C10.39 GET_INFO reports the panel", () => {
    const { dev } = makeReadyDevice();
    const info = dev.ioctl(LCDIOCTL.GET_INFO, null);
    expect(info.device).toBe("/dev/lcd");
    expect(info.available).toBe(true);
    expect(info.width).toBe(128);
    expect(info.height).toBe(64);
    expect(info.framebufferSize).toBe(1024);
  });

  it("C10.40 read() returns JSON info", () => {
    const { dev } = makeReadyDevice();
    const parsed = JSON.parse(dev.read());
    expect(parsed.available).toBe(true);
    expect(parsed.device).toBe("/dev/lcd");
  });

  it("C10.40b GET_WIDTH/GET_HEIGHT after rotation follow the addon", () => {
    const lcd = makeFakeLcd();
    // Simulasi addon: setelah rotasi 1, width/height bertukar.
    lcd.setRotation = vi.fn(() => {
      lcd.getWidth = vi.fn(() => 64);
      lcd.getHeight = vi.fn(() => 128);
    });
    const { dev } = makeReadyDevice(lcd);
    expect(dev.ioctl(LCDIOCTL.SET_ROTATION, 1)).toBe(1);
    expect(dev.ioctl(LCDIOCTL.GET_WIDTH, null)).toBe(64);
    expect(dev.ioctl(LCDIOCTL.GET_HEIGHT, null)).toBe(128);
  });
});

describe("LM6029Device — kontrol tampilan (C10.41-C10.43)", () => {
  it("C10.41 SET_CONTRAST clamps to 0..63", () => {
    const { dev, lcd } = makeReadyDevice();
    dev.ioctl(LCDIOCTL.SET_CONTRAST, { level: 200 });
    expect(lcd.setContrast).toHaveBeenLastCalledWith(63);
    dev.ioctl(LCDIOCTL.SET_CONTRAST, -5);
    expect(lcd.setContrast).toHaveBeenLastCalledWith(0);
    dev.ioctl(LCDIOCTL.SET_CONTRAST, { level: 40 });
    expect(lcd.setContrast).toHaveBeenLastCalledWith(40);
    expect(dev.ioctl(LCDIOCTL.GET_CONTRAST, null)).toBe(31);
  });

  it("C10.42 backlight / invert / displayOn toggle", () => {
    const { dev, lcd } = makeReadyDevice();
    expect(dev.ioctl(LCDIOCTL.SET_BACKLIGHT, false)).toBe(false);
    expect(lcd.setBacklight).toHaveBeenCalledWith(false);
    expect(dev.ioctl(LCDIOCTL.SET_BACKLIGHT, { on: true })).toBe(true);
    expect(lcd.setBacklight).toHaveBeenLastCalledWith(true);
    expect(dev.ioctl(LCDIOCTL.SET_INVERT, true)).toBe(true);
    expect(lcd.setDisplayInvert).toHaveBeenCalledWith(true);
    expect(dev.ioctl(LCDIOCTL.SET_DISPLAY_ON, true)).toBe(true);
    expect(dev.ioctl(LCDIOCTL.IS_DISPLAY_ON, null)).toBe(true);
    expect(dev.ioctl(LCDIOCTL.GET_BACKLIGHT, null)).toBe(true);
  });

  it("C10.43 SPI speed + auto-flush getters/setters", () => {
    const { dev, lcd } = makeReadyDevice();
    expect(dev.ioctl(LCDIOCTL.SET_SPI_SPEED, { hz: 32000000 })).toBe(32000000);
    expect(lcd.setSpiSpeed).toHaveBeenCalledWith(32000000);
    expect(dev.ioctl(LCDIOCTL.GET_SPI_SPEED, null)).toBe(7812500);

    expect(dev.ioctl(LCDIOCTL.GET_AUTO_FLUSH, null)).toBe(true);
    expect(dev.ioctl(LCDIOCTL.SET_AUTO_FLUSH, false)).toBe(false);
    expect(dev.ioctl(LCDIOCTL.GET_AUTO_FLUSH, null)).toBe(false);
  });

  it("C10.43b CLEAR / DISPLAY / RESET drive the driver", () => {
    const { dev, lcd } = makeReadyDevice();
    dev.ioctl(LCDIOCTL.CLEAR, null);
    expect(lcd.clear).toHaveBeenCalledTimes(1);
    dev.ioctl(LCDIOCTL.DISPLAY, null);
    expect(lcd.display).toHaveBeenCalledTimes(1);
    dev.ioctl(LCDIOCTL.RESET, null);
    expect(lcd.clear).toHaveBeenCalledTimes(2);
    expect(lcd.display).toHaveBeenCalledTimes(2);
  });
});

describe("LM6029Device — primitive GFX & teks (C10.44-C10.46)", () => {
  it("C10.44 shape ioctls accept named objects and positional arrays", () => {
    const { dev, lcd } = makeReadyDevice();

    dev.ioctl(LCDIOCTL.FILL_RECT, { x: 1, y: 2, w: 3, h: 4, color: 1 });
    expect(lcd.fillRect).toHaveBeenCalledWith(1, 2, 3, 4, 1);

    dev.ioctl(LCDIOCTL.DRAW_LINE, [0, 0, 10, 10, 1]);
    expect(lcd.drawLine).toHaveBeenCalledWith(0, 0, 10, 10, 1);

    dev.ioctl(LCDIOCTL.FILL_CIRCLE, { x: 5, y: 5, r: 3, color: 1 });
    expect(lcd.fillCircle).toHaveBeenCalledWith(5, 5, 3, 1);

    dev.ioctl(LCDIOCTL.FILL_TRIANGLE, [0, 0, 1, 1, 2, 0, 1]);
    expect(lcd.fillTriangle).toHaveBeenCalledWith(0, 0, 1, 1, 2, 0, 1);

    dev.ioctl(LCDIOCTL.DRAW_PIXEL, { x: 9, y: 9 });
    expect(lcd.drawPixel).toHaveBeenCalledWith(9, 9, 1);

    dev.ioctl(LCDIOCTL.FILL_SCREEN, { color: 0 });
    expect(lcd.fillScreen).toHaveBeenCalledWith(0);
  });

  it("C10.45 text ioctls configure font and print", () => {
    const { dev, lcd } = makeReadyDevice();

    expect(dev.ioctl(LCDIOCTL.SET_FONT, { id: 2 })).toBe(2);
    expect(lcd.setFont).toHaveBeenCalledWith(2);

    dev.ioctl(LCDIOCTL.SET_TEXT_COLOR, { color: 1 });
    expect(lcd.setTextColor).toHaveBeenCalledWith(1);

    dev.ioctl(LCDIOCTL.SET_TEXT_COLOR, { color: 0, bg: 1 });
    expect(lcd.setTextColor).toHaveBeenLastCalledWith(0, 1);

    dev.ioctl(LCDIOCTL.SET_TEXT_SIZE, 2);
    expect(lcd.setTextSize).toHaveBeenCalledWith(2);

    dev.ioctl(LCDIOCTL.SET_CURSOR, { x: 3, y: 4 });
    expect(lcd.setCursor).toHaveBeenCalledWith(3, 4);

    dev.ioctl(LCDIOCTL.PRINT_TEXT, { text: "Halo", x: 0, y: 12, size: 2 });
    expect(lcd.printText).toHaveBeenCalledWith("Halo", 0, 12, 2);
    // autoFlush ON → PRINT_TEXT langsung dikirim ke panel
    expect(lcd.display).toHaveBeenCalled();
  });

  it("C10.46 DRAW_BITMAP forwards the buffer", () => {
    const { dev, lcd } = makeReadyDevice();
    const bmp = Buffer.alloc(16, 0xff);
    dev.ioctl(LCDIOCTL.DRAW_BITMAP, { x: 0, y: 0, data: bmp, w: 8, h: 16, color: 1 });
    expect(lcd.drawBitmap).toHaveBeenCalledWith(0, 0, bmp, 8, 16, 1);
  });

  it("C10.46b DRAW_BITMAP accepts a JSON-serialized buffer (syscall IPC)", () => {
    const { dev, lcd } = makeReadyDevice();
    // Bentuk yang benar-benar sampai ke kernel dari userland.
    const ipc = { type: "Buffer", data: [0xff, 0x00, 0x0f] };
    dev.ioctl(LCDIOCTL.DRAW_BITMAP, { x: 1, y: 2, data: ipc, w: 8, h: 3, color: 1 });
    const passed = lcd.drawBitmap.mock.calls[0][2];
    expect(Buffer.isBuffer(passed)).toBe(true);
    expect([...passed]).toEqual([0xff, 0x00, 0x0f]);
  });
});

describe("LM6029Device — write() modes (C10.47-C10.49)", () => {
  it("C10.47 write(string) prints and auto-flushes", () => {
    const { dev, lcd } = makeReadyDevice();
    expect(dev.write("Halo")).toBe(true);
    expect(lcd.print).toHaveBeenCalledWith("Halo");
    expect(lcd.display).toHaveBeenCalledTimes(1);
  });

  it("C10.48 write(1024-byte buffer) blits a full frame", () => {
    const { dev, lcd } = makeReadyDevice();
    const fb = Buffer.alloc(LCD_FRAMEBUFFER_SIZE);
    expect(dev.write(fb)).toBe(true);
    expect(lcd.drawBitmap).toHaveBeenCalledWith(0, 0, fb, 128, 64, 1);
    expect(lcd.display).toHaveBeenCalledTimes(1);
  });

  it("C10.48d full-frame write REPLACES the screen (buffer dibersihkan dulu)", () => {
    const { dev, lcd } = makeReadyDevice();
    const fb = Buffer.alloc(LCD_FRAMEBUFFER_SIZE, 0xaa);
    dev.write(fb);

    // Wajib: clear() dipanggil SEBELUM drawBitmap(), karena drawBitmap
    // (Adafruit_GFX) hanya menyalakan piksel bit-1 dan tidak menghapus piksel
    // lama — tanpa clear() hasilnya "menumpuk", bukan mengganti frame.
    expect(lcd.clear).toHaveBeenCalled();
    expect(lcd.clear.mock.invocationCallOrder[0]).toBeLessThan(
      lcd.drawBitmap.mock.invocationCallOrder[0],
    );
  });

  it("C10.48e frame kosong tetap menghapus layar (bisa dipakai untuk clear)", () => {
    const { lcd, px } = makePixelLcd();
    const dev = new LM6029Device({ native: lcd });
    dev.init({ syslog: () => {} });

    // Frame lama terisi penuh, lalu dikirim frame kosong (semua bit 0).
    px.fill(1);
    expect(dev.write(Buffer.alloc(LCD_FRAMEBUFFER_SIZE))).toBe(true);

    let nyala = 0;
    for (const p of px) nyala += p;
    expect(nyala).toBe(0);
  });

  it("C10.48f framebuffer mengganti frame sebelumnya (tanpa hantu piksel)", () => {
    const { lcd, px } = makePixelLcd();
    const dev = new LM6029Device({ native: lcd });
    dev.init({ syslog: () => {} });

    // Frame 1: hanya pojok kiri-atas.
    const fb1 = Buffer.alloc(LCD_FRAMEBUFFER_SIZE);
    fb1[0] |= 0x80;
    dev.write(fb1);
    expect(px[0]).toBe(1);

    // Frame 2: hanya pojok kanan-atas. Piksel frame 1 harus hilang.
    const fb2 = Buffer.alloc(LCD_FRAMEBUFFER_SIZE);
    fb2[0] |= 0x01;
    dev.write(fb2);

    expect(px[0]).toBe(0); // sisa frame 1 terhapus
    expect(px[7]).toBe(1); // isi frame 2 tampil
    expect(px.reduce((a, b) => a + b, 0)).toBe(1); // total piksel nyala = 1
  });

  it("C10.48b write(short buffer) is treated as text", () => {
    const { dev, lcd } = makeReadyDevice();
    expect(dev.write(Buffer.from("hi"))).toBe(true);
    expect(lcd.print).toHaveBeenCalledWith("hi");
  });

  it("C10.48c write accepts a JSON-serialized 1024-byte framebuffer", () => {
    const { dev, lcd } = makeReadyDevice();
    const fb = Buffer.alloc(LCD_FRAMEBUFFER_SIZE, 0xaa);
    const ipc = { type: "Buffer", data: [...fb] };
    expect(dev.write(ipc)).toBe(true);
    const passed = lcd.drawBitmap.mock.calls[0][2];
    expect(passed.length).toBe(LCD_FRAMEBUFFER_SIZE);
    expect(lcd.drawBitmap).toHaveBeenCalledWith(0, 0, passed, 128, 64, 1);
  });

  it("C10.49 write({op}) dispatches a GFX command", () => {
    const { dev, lcd } = makeReadyDevice();
    expect(dev.write({ op: "fillRect", args: [1, 1, 2, 2, 1] })).toBe(true);
    expect(lcd.fillRect).toHaveBeenCalledWith(1, 1, 2, 2, 1);
    expect(lcd.display).toHaveBeenCalledTimes(1);

    expect(dev.write({ op: "display" })).toBe(true);
    expect(lcd.display).toHaveBeenCalledTimes(2);

    expect(dev.write({ op: "notARealOp" })).toBe(true);
    expect(dev.write(42)).toBe(false);
  });

  it("C10.49b autoFlush=false defers the panel update", () => {
    const lcd = makeFakeLcd();
    const dev = new LM6029Device({ native: lcd, autoFlush: false });
    dev.init({ syslog: () => {} });
    dev.write("Halo");
    expect(lcd.print).toHaveBeenCalled();
    expect(lcd.display).not.toHaveBeenCalled();
    dev.ioctl(LCDIOCTL.DISPLAY, null);
    expect(lcd.display).toHaveBeenCalledTimes(1);
  });
});
