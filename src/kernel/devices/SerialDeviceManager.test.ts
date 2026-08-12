import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock serialport
vi.mock("serialport", () => ({
    SerialPort: {
        list: vi.fn().mockResolvedValue([]),
    },
}));

import { SerialDeviceManager } from "./SerialDeviceManager";

describe("SerialDeviceManager (C10.13-C10.14)", () => {
    let kernel: any;

    beforeEach(() => {
        kernel = {
            devices: {},
            syslog: vi.fn(),
        };
    });

    it("C10.13 startAutoDetection does not throw", () => {
        const mgr = new SerialDeviceManager(kernel);
        expect(() => mgr.startAutoDetection(100)).not.toThrow();
    });

    it("C10.13b stopAutoDetection does not throw", () => {
        const mgr = new SerialDeviceManager(kernel);
        mgr.startAutoDetection(100);
        expect(() => mgr.stopAutoDetection()).not.toThrow();
    });

    it("C10.13c stopAutoDetection with no interval no-ops", () => {
        const mgr = new SerialDeviceManager(kernel);
        expect(() => mgr.stopAutoDetection()).not.toThrow();
    });

    it("C10.14 constructor accepts kernel", () => {
        const mgr = new SerialDeviceManager(kernel);
        expect(mgr).toBeDefined();
    });
});
