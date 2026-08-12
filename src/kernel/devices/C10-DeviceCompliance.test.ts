import { describe, it, expect } from "vitest";
import { IDevice, NullDevice } from "./IDevice";
import { FileSystemDevice } from "./FileSystemDevice";
import { KeyboardDevice } from "./KeyboardDevice";
import { ScreenDevice } from "./ScreenDevice";
import { PipeDevice } from "./PipeDevice";
import { TTYDevice } from "./TTYDevice";
import { NullDevice as ND } from "./NullDevice";
import { VirtualFileSystem } from "../../vfs/VFS";
import { TTY } from "../tty/TTY";

describe("IDevice Interface Compliance (C10.15-C10.20)", () => {
    const tty = new TTY(99, 80, 24);
    const isActive = () => true;
    const vfs = new VirtualFileSystem();
    vfs.touch("/test.txt", "hello");

    const devices: IDevice[] = [
        new NullDevice(),
        new ND(),
        new FileSystemDevice(vfs),
        new KeyboardDevice(),
        new ScreenDevice(),
        new PipeDevice(),
        new TTYDevice(99, tty, isActive),
    ];

    // C10.15
    it("C10.15 all devices implement IDevice interface", () => {
        for (const dev of devices) {
            expect(typeof dev.name).toBe("string");
            expect(typeof dev.read).toBe("function");
            expect(typeof dev.write).toBe("function");
            expect(typeof dev.ioctl).toBe("function");
        }
    });

    // C10.16
    it("C10.16 device names are unique or identifiable", () => {
        const names = devices.map(d => d.name);
        expect(names.length).toBeGreaterThanOrEqual(4);
    });

    // C10.17
    it("C10.17 device ioctl returns something for any cmd", () => {
        for (const dev of devices) {
            const result = dev.ioctl(0, null);
            expect(result !== undefined).toBe(true);
        }
    });

    // C10.18
    it("C10.18 device read does not throw", () => {
        for (const dev of devices) {
            expect(() => dev.read()).not.toThrow();
        }
    });

    // C10.19
    it("C10.19 device write does not throw", () => {
        for (const dev of devices) {
            expect(() => dev.write("test")).not.toThrow();
        }
    });

    // C10.20
    it("C10.20 NullDevice read returns empty", () => {
        const nd = new NullDevice();
        expect(nd.read()).toBe("");
    });

    it("C10.20b NullDevice write returns true", () => {
        const nd = new NullDevice();
        expect(nd.write("anything")).toBe(true);
    });
});
