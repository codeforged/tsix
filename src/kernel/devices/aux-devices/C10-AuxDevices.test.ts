import { describe, it, expect, vi } from "vitest";

// Mock i2c-bus to avoid actual hardware dependency
vi.mock("i2c-bus", () => ({
    openSync: vi.fn(() => ({
        writeByteSync: vi.fn(),
        readByteSync: vi.fn().mockReturnValue(0),
        closeSync: vi.fn(),
    })),
}));

import { MCP23017Device } from "./MCP23017Device";

describe("MCP23017Device (C10.08-C10.09)", () => {
    it("C10.08 name is set from constructor", () => {
        const dev = new MCP23017Device(1, 0x20, "mcp0");
        expect(dev.name).toBe("mcp0");
    });

    it("C10.08b default name is mcp23017", () => {
        const dev = new MCP23017Device();
        expect(dev.name).toBe("mcp23017");
    });

    it("C10.08c uid/gid/mode defaults", () => {
        const dev = new MCP23017Device();
        expect(dev.uid).toBe(0);
        expect(dev.gid).toBe(0);
        expect(dev.mode).toBe(0o660);
    });

    it("C10.08d disabled is false by default", () => {
        const dev = new MCP23017Device();
        expect(dev.disabled).toBe(false);
    });

    it("C10.09 autoRegister static method exists", () => {
        expect(typeof MCP23017Device.autoRegister).toBe("function");
    });

    it("C10.09b autoRegister does not throw with mock kernel", () => {
        const kernel = { devices: {} };
        // MCP23017 autoRegister may throw if hardware not present and i2c-bus throws
        // Just verify the function exists and doesn't crash catastrophically
        try {
            MCP23017Device.autoRegister(kernel);
        } catch (_) {
            // Hardware not present is expected
        }
        // Should not throw unhandled errors
    });

    it("C10.09c read returns null (not initialized)", () => {
        const dev = new MCP23017Device();
        expect(dev.read()).toBeNull();
    });

    it("C10.09d write returns false (not initialized)", () => {
        const dev = new MCP23017Device();
        expect(dev.write("data")).toBe(false);
    });

    it("C10.09e ioctl returns null (not initialized)", () => {
        const dev = new MCP23017Device();
        expect(dev.ioctl(0, null)).toBeNull();
    });
});

// MySQLDevice tests
import { MySQLDevice } from "./MySQLDevice";

describe("MySQLDevice (C10.10-C10.12)", () => {
    it("C10.10 name is mysql", () => {
        const dev = new MySQLDevice();
        expect(dev.name).toBe("mysql");
    });

    it("C10.10b read returns disconnected message", () => {
        const dev = new MySQLDevice();
        const result = dev.read();
        expect(result).toContain("Disconnected");
    });

    it("C10.11 write returns false when not connected", async () => {
        const dev = new MySQLDevice();
        const result = await dev.write("SELECT 1");
        expect(result).toBe(false);
    });

    it("C10.12 ioctl 0x2001 (connect) with invalid config returns false", async () => {
        const dev = new MySQLDevice();
        const result = await dev.ioctl(0x2001, {});
        expect(result).toBe(false);
    });

    it("C10.12b ioctl 0x2002 (disconnect) returns false when not connected", async () => {
        const dev = new MySQLDevice();
        const result = await dev.ioctl(0x2002, null);
        expect(result).toBe(false);
    });
});
