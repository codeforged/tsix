import { describe, it, expect } from "vitest";
import { NullDevice } from "./NullDevice";

describe("NullDevice (C6)", () => {
    const dev = new NullDevice();

    // C6.01
    it("C6.01 /dev/null – write discards data", () => {
        expect(dev.write("anything")).toBe(true);
        expect(dev.write("more data")).toBe(true);
        expect(dev.write("")).toBe(true);
        // Writing to null should always succeed and discard
    });

    // C6.02
    it("C6.02 /dev/null – read returns EOF (empty string)", () => {
        const result = dev.read();
        expect(result).toBe("");
        // Should always return empty, regardless of writes
        dev.write("something");
        expect(dev.read()).toBe("");
    });

    // C6.03
    it("C6.03 ioctl returns true for any command", () => {
        expect(dev.ioctl(0, null)).toBe(true);
        expect(dev.ioctl(99, "anything")).toBe(true);
    });
});
