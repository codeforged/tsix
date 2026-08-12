import { describe, it, expect } from "vitest";
import { RandomDevice } from "./RandomDevice";

describe("RandomDevice (C10.05-C10.07)", () => {
    const dev = new RandomDevice();

    it("C10.05 name is RandomDevice", () => {
        expect(dev.name).toBe("RandomDevice");
    });

    it("C10.05b read returns string with newline", () => {
        const val = dev.read();
        expect(typeof val).toBe("string");
        expect(val).toContain("\n");
        expect(parseInt(val)).toBeGreaterThanOrEqual(0);
    });

    it("C10.06 read returns different values (probabilistic)", () => {
        const vals = new Set<string>();
        for (let i = 0; i < 10; i++) {
            vals.add(dev.read());
        }
        // Very unlikely all 10 random numbers are the same
        expect(vals.size).toBeGreaterThan(1);
    });

    it("C10.07 write returns true", () => {
        expect(dev.write("seed")).toBe(true);
    });

    it("C10.07b ioctl returns true", () => {
        expect(dev.ioctl(0, null)).toBe(true);
    });
});
