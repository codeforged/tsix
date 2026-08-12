import { describe, it, expect } from "vitest";
import { KeyboardDevice } from "./KeyboardDevice";

describe("KeyboardDevice (C7)", () => {
    const kb = new KeyboardDevice();

    it("C7.01 name is Keyboard", () => {
        expect(kb.name).toBe("Keyboard");
    });

    it("C7.02 read returns string or null (no stdin data available)", () => {
        const result = kb.read();
        // read() returns string|null; null when no data available
        expect(result === null || typeof result === "string").toBe(true);
    });

    it("C7.03 ioctl 0 returns -1 (unsupported by KeyboardDevice)", () => {
        expect(kb.ioctl(0, null)).toBe(-1);
    });

    it("C7.04 ioctl 1 enables raw mode without throw", () => {
        expect(() => kb.ioctl(1, null)).not.toThrow();
    });

    it("C7.05 ioctl unsupported cmd returns -1", () => {
        expect(kb.ioctl(999, null)).toBe(-1);
    });
});
