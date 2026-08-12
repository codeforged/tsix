import { describe, it, expect, vi } from "vitest";

// Mock serialport to avoid actual hardware dependency
vi.mock("serialport", () => ({
    SerialPort: vi.fn().mockImplementation(function (this: any, opts: any) {
        this.path = opts.path;
        this.baudRate = opts.baudRate;
        this.isOpen = false;
        this._listeners = {};
        this.on = vi.fn((event: string, cb: Function) => {
            this._listeners[event] = cb;
        });
        this.open = vi.fn((cb: Function) => {
            this.isOpen = true;
            if (cb) cb(null);
        });
        this.write = vi.fn((data: any, cb: Function) => {
            if (cb) cb(null);
        });
        this.close = vi.fn(() => { this.isOpen = false; });
        this.update = vi.fn();
        return this;
    }),
}));

import { SerialDevice } from "./SerialDevice";

describe("SerialDevice (C9)", () => {
    it("C9.01 name is set from constructor", () => {
        const dev = new SerialDevice("/dev/ttyUSB0", "ttyUSB0");
        expect(dev.name).toBe("ttyUSB0");
    });

    it("C9.02 uid defaults to 0, gid to 100", () => {
        const dev = new SerialDevice("/dev/ttyUSB0", "ttyUSB0");
        expect(dev.uid).toBe(0);
        expect(dev.gid).toBe(100);
    });

    it("C9.03 mode defaults to 0o660", () => {
        const dev = new SerialDevice("/dev/ttyUSB0", "ttyUSB0");
        expect(dev.mode).toBe(0o660);
    });

    it("C9.04 open returns true (lazy open)", () => {
        const dev = new SerialDevice("/dev/ttyUSB0", "ttyUSB0");
        const result = dev.open();
        expect(result).toBe(true);
    });

    it("C9.05 read returns empty string when no data", () => {
        const dev = new SerialDevice("/dev/ttyUSB0", "ttyUSB0");
        const result = dev.read();
        expect(result).toBe("");
    });

    it("C9.06 write returns true after open", () => {
        const dev = new SerialDevice("/dev/ttyUSB0", "ttyUSB0");
        dev.open();
        const result = dev.write("AT\r\n");
        expect(result).toBe(true);
    });

    it("C9.07 ioctl 0x101 returns baudRate", () => {
        const dev = new SerialDevice("/dev/ttyUSB0", "ttyUSB0", 115200);
        const rate = dev.ioctl(0x101, null);
        expect(rate).toBe(115200);
    });

    it("C9.08 close returns true", () => {
        const dev = new SerialDevice("/dev/ttyUSB0", "ttyUSB0");
        const result = dev.close();
        expect(result).toBe(true);
    });
});
