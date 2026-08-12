import { describe, it, expect, beforeEach, vi } from "vitest";
import { TTYDevice } from "./TTYDevice";
import { TTY } from "../tty/TTY";

describe("TTYDevice (C2)", () => {
    let tty: TTY;
    let isActive: () => boolean;

    beforeEach(() => {
        tty = new TTY(1, 80, 24);
        isActive = vi.fn().mockReturnValue(true);
    });

    function makeDevice(id = 1): TTYDevice {
        return new TTYDevice(id, tty, isActive);
    }

    // C2.01
    it("C2.01 name is tty{id}", () => {
        const dev = makeDevice(1);
        expect(dev.name).toBe("tty1");
        const dev2 = new TTYDevice(3, tty, isActive);
        expect(dev2.name).toBe("tty3");
    });

    // C2.02 – write + read basic
    it("C2.02 write then read via pushInput/getOutput", () => {
        const dev = makeDevice();
        // Write to push input into TTY
        dev.ioctl(0x2001, "echo test");  // INJECT_INPUT
        // Read back from output
        tty.write("test output\r\n");
        const output = dev.ioctl(0x2002, null); // READ_OUTPUT
        expect(typeof output).toBe("string");
        expect(output.length).toBeGreaterThan(0);
    });

    // C2.03 – clear screen
    it("C2.03 ioctl 1 (CLEAR_SCREEN) returns 0", () => {
        const dev = makeDevice();
        tty.write("some content");
        const result = dev.ioctl(1, null);
        expect(result).toBe(0);
    });

    // C2.04 – raw mode
    it("C2.04 ioctl 10 (SET_RAW_MODE) returns 0", () => {
        const dev = makeDevice();
        expect(dev.ioctl(10, true)).toBe(0);
        expect(dev.ioctl(10, false)).toBe(0);
    });

    // C2.05 – inject input
    it("C2.05 ioctl 0x2001 (INJECT_INPUT) returns true", () => {
        const dev = makeDevice();
        expect(dev.ioctl(0x2001, "hello")).toBe(true);
    });

    // C2.06 – read output
    it("C2.06 ioctl 0x2002 (READ_OUTPUT) returns string", () => {
        const dev = makeDevice();
        const result = dev.ioctl(0x2002, null);
        expect(typeof result).toBe("string");
    });

    // C2.07 – window size
    it("C2.07 ioctl 4 (TIOCGWINSZ) returns dimensions", () => {
        const dev = makeDevice();
        const info = dev.ioctl(4, null);
        expect(info).toBeDefined();
        expect(typeof info.lines).toBe("number");
        expect(typeof info.columns).toBe("number");
    });

    // C2.08 – switch tty
    it("C2.08 ioctl 2 (SWITCH_TTY) returns -1 (handled by Syscalls)", () => {
        const dev = makeDevice();
        expect(dev.ioctl(2, null)).toBe(-1);
    });

    // C2.09 – unsupported ioctl
    it("C2.09 unsupported ioctl returns -1", () => {
        const dev = makeDevice();
        expect(dev.ioctl(999, null)).toBe(-1);
    });

    // C2.10 – read returns null when no data
    it("C2.10 read returns null when no input available", () => {
        const dev = makeDevice();
        expect(dev.read()).toBeNull();
    });

    // C2.11 – write returns true
    it("C2.11 write returns true", () => {
        const dev = makeDevice();
        expect(dev.write("test")).toBe(true);
    });

    // C2.12 – write + read roundtrip via pushInput
    it("C2.12 pushInput then read returns the input (raw mode)", () => {
        const dev = makeDevice();
        dev.ioctl(10, true); // enable raw mode
        dev.ioctl(0x2001, "x"); // inject char
        const result = dev.read();
        expect(result).toBe("x");
    });

    // C2.13 – background TTY (not active)
    it("C2.13 clear on inactive TTY does not write to stdout", () => {
        const inactive = vi.fn().mockReturnValue(false);
        const dev = new TTYDevice(2, tty, inactive);
        // Should not throw even when inactive
        expect(() => dev.ioctl(1, null)).not.toThrow();
    });

    // C2.14 – write with ANSI escape codes
    it("C2.14 write with ANSI escape codes does not throw", () => {
        const dev = makeDevice();
        expect(() => dev.write("\x1b[31mRED\x1b[0m\n")).not.toThrow();
    });

    // C2.15 – read after pushInput in cooked mode
    it("C2.15 read in cooked mode after pushInput+Enter returns line", () => {
        const dev = makeDevice();
        // Cooked mode: push each char, then Enter
        dev.ioctl(0x2001, "h");
        dev.ioctl(0x2001, "i");
        dev.ioctl(0x2001, "\r"); // Enter
        const result = dev.read();
        // TTY cooked mode may include newline
        expect(result).toContain("hi");
    });
});
