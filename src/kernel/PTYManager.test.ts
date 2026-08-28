import { describe, it, expect, beforeEach } from "vitest";
import { PTYManager } from "./PTYManager";
import { PTYDevice } from "./devices/PTYDevice";
import { PTYSlaveDevice } from "./devices/PTYSlaveDevice";

describe("PTYManager (Pseudo Terminal)", () => {
    let manager: PTYManager;

    beforeEach(() => {
        manager = new PTYManager();
    });

    it("starts empty", () => {
        expect(manager.count()).toBe(0);
        expect(manager.list()).toEqual([]);
    });

    it("alloc creates a master+slave pair", () => {
        const pair = manager.alloc();
        expect(pair.id).toBe(0);
        expect(pair.master).toBeInstanceOf(PTYDevice);
        expect(pair.slave).toBeInstanceOf(PTYSlaveDevice);
        expect(pair.slave.name).toBe("pts/0");
        expect(manager.count()).toBe(1);
    });

    it("alloc increments id sequentially (on-demand)", () => {
        const p1 = manager.alloc();
        const p2 = manager.alloc();
        expect(p1.id).toBe(0);
        expect(p2.id).toBe(1);
        expect(manager.count()).toBe(2);
    });

    it("free removes a pair", () => {
        const pair = manager.alloc();
        expect(manager.free(pair.id)).toBe(true);
        expect(manager.count()).toBe(0);
        expect(manager.get(pair.id)).toBeUndefined();
    });

    it("free of unknown id returns false", () => {
        expect(manager.free(99)).toBe(false);
    });

    it("get/getMaster/getSlave return the pair", () => {
        const pair = manager.alloc();
        expect(manager.get(pair.id)).toBe(pair);
        expect(manager.getMaster(pair.id)).toBe(pair.master);
        expect(manager.getSlave(pair.id)).toBe(pair.slave);
    });

    it("slave write is captured by master read (shared output buffer)", () => {
        const pair = manager.alloc();
        pair.slave.write("hello");
        expect(pair.master.read()).toBe("hello");
        // buffer drained after read (single source)
        expect(pair.master.read()).toBe("");
    });

    it("master write injects input into slave line discipline", () => {
        const pair = manager.alloc();
        pair.master.write("ls");
        // Not a full line yet — nothing readable in cooked mode
        expect(pair.slave.read()).toBeNull();
        pair.master.write("\n");
        expect(pair.slave.read()).toBe("ls\n");
    });

    it("slave getOutput drains its output buffer", () => {
        const pair = manager.alloc();
        pair.slave.write("abc");
        expect(pair.slave.getOutput()).toBe("abc");
        expect(pair.slave.getOutput()).toBe("");
    });

    it("master ioctl TIOCSWINSZ resizes slave", () => {
        const pair = manager.alloc();
        pair.master.ioctl(3, { lines: 40, columns: 120 });
        expect(pair.slave.height).toBe(40);
        expect(pair.slave.width).toBe(120);
    });
});
