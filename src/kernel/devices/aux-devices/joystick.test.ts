import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    JoystickDevice,
    JoystickState,
    JoystickIOCTL,
} from "./joystick";

describe("JoystickDevice (/dev/joystick)", () => {
    let dev: JoystickDevice;

    beforeEach(() => {
        dev = new JoystickDevice();
        dev.init({ syslog: () => { } });
    });

    afterEach(() => {
        dev.close();
    });

    // C10.15 — kontrak IDevice terpenuhi
    it("C10.15 implements IDevice interface", () => {
        expect(typeof dev.name).toBe("string");
        expect(typeof dev.read).toBe("function");
        expect(typeof dev.write).toBe("function");
        expect(typeof dev.ioctl).toBe("function");
        expect(dev.name).toBe("Joystick");
    });

    // C10.17 — ioctl apa pun tetap mengembalikan nilai (bukan undefined)
    it("C10.17 ioctl(0, null) returns non-undefined", () => {
        expect(dev.ioctl(0, null)).not.toBeUndefined();
    });

    // C10.18/19 — read & write tidak melempar
    it("C10.18 read does not throw", () => {
        expect(() => dev.read()).not.toThrow();
    });

    it("C10.19 write does not throw", () => {
        expect(() => dev.write({ type: "rumble", option: { strong: 0.5 } })).not.toThrow();
        expect(dev.write({ type: "rumble", option: { strong: 0.5 } })).toBe(true);
    });

    it("awalnya tidak terhubung dan kosong", () => {
        const st = dev.ioctl(JoystickIOCTL.GET_STATE, null) as JoystickState;
        expect(st.connected).toBe(false);
        expect(st.axes).toEqual([]);
        expect(st.buttons).toEqual([]);
    });

    it("connect() menyiapkan axes/buttons & menandai connected", () => {
        dev.connect("stick-1", 2, 4);
        expect(dev.ioctl(JoystickIOCTL.IS_CONNECTED, null)).toBe(true);
        const info = dev.ioctl(JoystickIOCTL.GET_INFO, null) as any;
        expect(info.id).toBe("stick-1");
        expect(info.axes).toBe(2);
        expect(info.buttons).toBe(4);
    });

    it("setAxis + GET_AXIS mengembalikan nilai axis", () => {
        dev.connect("stick-1", 2, 2);
        dev.setAxis(0, 0.75);
        dev.setAxis(1, -0.5);
        expect(dev.ioctl(JoystickIOCTL.GET_AXIS, 0)).toBeCloseTo(0.75);
        expect(dev.ioctl(JoystickIOCTL.GET_AXIS, 1)).toBeCloseTo(-0.5);
    });

    it("deadzone meniadakan axis kecil", () => {
        dev.connect("stick-1", 1, 0);
        dev.setAxis(0, 0.02); // di bawah deadzone 0.1
        expect(dev.ioctl(JoystickIOCTL.GET_AXIS, 0)).toBe(0);
        dev.setAxis(0, 0.5);
        expect(dev.ioctl(JoystickIOCTL.GET_AXIS, 0)).toBeCloseTo(0.5);
    });

    it("deadzone bisa diubah via SET_DEADZONE", () => {
        expect(dev.ioctl(JoystickIOCTL.SET_DEADZONE, 0.3)).toBe(0.3);
        expect(dev.ioctl(JoystickIOCTL.GET_DEADZONE, null)).toBe(0.3);
    });

    it("setButton + GET_BUTTON mengembalikan nilai tombol", () => {
        dev.connect("stick-1", 0, 3);
        dev.setButton(0, 1);
        dev.setButton(2, 0.6);
        expect(dev.ioctl(JoystickIOCTL.GET_BUTTON, 0)).toBe(1);
        expect(dev.ioctl(JoystickIOCTL.GET_BUTTON, 2)).toBeCloseTo(0.6);
        // index di luar rentang → 0
        expect(dev.ioctl(JoystickIOCTL.GET_BUTTON, 9)).toBe(0);
    });

    it("updateState() mengganti state sekaligus (mode injection)", () => {
        dev.connect("stick-1", 2, 2);
        dev.updateState({
            connected: true,
            id: "stick-1",
            axes: [0.9, -0.9],
            buttons: [1, 0],
        });
        const st = dev.ioctl(JoystickIOCTL.GET_STATE, null) as JoystickState;
        expect(st.axes[0]).toBeCloseTo(0.9);
        expect(st.axes[1]).toBeCloseTo(-0.9);
        expect(st.buttons[0]).toBe(1);
    });

    it("read() mengembalikan JSON state yang valid", () => {
        dev.connect("stick-1", 1, 1);
        dev.setAxis(0, 0.4);
        dev.setButton(0, 1);
        const parsed = JSON.parse(dev.read()) as JoystickState;
        expect(parsed.connected).toBe(true);
        expect(parsed.axes[0]).toBeCloseTo(0.4);
        expect(parsed.buttons[0]).toBe(1);
    });

    it("calibrateCenters() menjadikan posisi saat ini sebagai titik tengah", () => {
        dev.connect("stick-1", 1, 0);
        dev.setAxis(0, 0.2); // anggap ini posisi "tengah" yang bergeser
        expect(dev.ioctl(JoystickIOCTL.CALIBRATE, null)).toBe(true);
        dev.setAxis(0, 0.2);
        expect(dev.ioctl(JoystickIOCTL.GET_AXIS, 0)).toBe(0); // jadi netral
    });

    it("RESET mengembalikan ke kondisi awal", () => {
        dev.connect("stick-1", 2, 2);
        dev.setAxis(0, 0.8);
        expect(dev.ioctl(JoystickIOCTL.RESET, null)).toBe(true);
        const st = dev.ioctl(JoystickIOCTL.GET_STATE, null) as JoystickState;
        expect(st.connected).toBe(false);
        expect(st.axes).toEqual([]);
    });

    it("disconnect() menandai tidak terhubung", () => {
        dev.connect("stick-1", 1, 1);
        dev.disconnect();
        expect(dev.ioctl(JoystickIOCTL.IS_CONNECTED, null)).toBe(false);
    });

    it("open/close tidak melempar", () => {
        expect(dev.open()).toBe(true);
        expect(dev.close()).toBe(true);
    });
});
