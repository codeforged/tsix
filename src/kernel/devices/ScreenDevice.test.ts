import { describe, it, expect, vi } from "vitest";
import { ScreenDevice } from "./ScreenDevice";

describe("ScreenDevice (C8)", () => {
    const dev = new ScreenDevice();

    // C8.01
    it("C8.01 read returns screen dimensions", () => {
        const info = dev.read();
        expect(info).toBeDefined();
        expect(typeof info.lines).toBe("number");
        expect(typeof info.columns).toBe("number");
        expect(info.lines).toBeGreaterThan(0);
        expect(info.columns).toBeGreaterThan(0);
    });

    // C8.02
    it("C8.02 write returns true", () => {
        const result = dev.write("test output");
        expect(result).toBe(true);
    });

    // C8.03
    it("C8.03 ioctl returns true for any command", () => {
        expect(dev.ioctl(0, null)).toBe(true);
        expect(dev.ioctl(99, "any")).toBe(true);
    });

    // C8.04
    it("C8.04 name is Screen", () => {
        expect(dev.name).toBe("Screen");
    });

    // C8.05
    it("C8.05 clear does not throw", () => {
        // clear() writes ANSI escape to stdout — should not throw
        expect(() => dev.clear()).not.toThrow();
    });
});
