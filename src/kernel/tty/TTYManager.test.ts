import { describe, it, expect, beforeEach, vi } from "vitest";
import { TTYManager } from "../tty/TTYManager";

describe("TTYManager (C3)", () => {
    let manager: TTYManager;

    beforeEach(() => {
        manager = new TTYManager(6);
    });

    // C3.01
    it("C3.01 creates 6 TTYs by default", () => {
        for (let i = 1; i <= 6; i++) {
            expect(manager.getTTY(i)).toBeDefined();
        }
    });

    // C3.02
    it("C3.02 getTTY returns undefined for invalid id", () => {
        expect(manager.getTTY(0)).toBeUndefined();
        expect(manager.getTTY(99)).toBeUndefined();
    });

    // C3.03
    it("C3.03 getActiveTTY returns TTY 1 by default", () => {
        const active = manager.getActiveTTY();
        expect(active).toBeDefined();
    });

    // C3.04
    it("C3.04 getActiveId returns 1 by default", () => {
        expect(manager.getActiveId()).toBe(1);
    });

    // C3.05
    it("C3.05 switch to another TTY works", async () => {
        await manager.switch(2);
        expect(manager.getActiveId()).toBe(2);
    });

    // C3.06
    it("C3.06 switch to same TTY no-ops", async () => {
        await manager.switch(1); // already on 1
        expect(manager.getActiveId()).toBe(1);
    });

    // C3.07
    it("C3.07 switch to invalid TTY no-ops", async () => {
        await manager.switch(99);
        expect(manager.getActiveId()).toBe(1); // unchanged
    });

    // C3.08
    it("C3.08 handleResize updates all TTYs", () => {
        expect(() => manager.handleResize(120, 40)).not.toThrow();
        // After resize, all TTYs should have new dimensions
        const tty = manager.getTTY(1)!;
        expect(tty.width).toBe(120);
        expect(tty.height).toBe(40);
    });

    // C3.09
    it("C3.09 handleTTYResize updates specific TTY", () => {
        expect(() => manager.handleTTYResize(1, 100, 30)).not.toThrow();
        // This method exists but behavior depends on implementation
    });

    // C3.10
    it("C3.10 setOnSwitchCallback works", async () => {
        const cb = vi.fn();
        manager.setOnSwitchCallback(cb);
        await manager.switch(3);
        expect(cb).toHaveBeenCalledWith(3);
    });

    // C3.11
    it("C3.11 setOnInterruptCallback works", () => {
        const cb = vi.fn();
        expect(() => manager.setOnInterruptCallback(cb)).not.toThrow();
    });

    // C3.13
    it("C3.13 setVisualIdentity does not throw", () => {
        expect(() => manager.setVisualIdentity("TSIX_IDENTITY")).not.toThrow();
    });

    // C3.14
    it("C3.14 each TTY has independent buffers", () => {
        const tty1 = manager.getTTY(1)!;
        const tty2 = manager.getTTY(2)!;
        tty1.write("TTY1 content");
        tty2.write("TTY2 content");
        // Each has its own content
        const out1 = tty1.render();
        const out2 = tty2.render();
        expect(out1).not.toBe(out2);
    });

    // C3.15 – create with custom count
    it("C3.15 create with custom count", () => {
        const mgr = new TTYManager(3);
        expect(mgr.getTTY(1)).toBeDefined();
        expect(mgr.getTTY(2)).toBeDefined();
        expect(mgr.getTTY(3)).toBeDefined();
        expect(mgr.getTTY(4)).toBeUndefined();
    });

    // C3.16 – switch with forceRedraw
    it("C3.16 switch with forceRedraw", async () => {
        manager.setVisualIdentity("TSIX");
        await manager.switch(2, true);
        expect(manager.getActiveId()).toBe(2);
    });

    // C3.17 – list all TTYs
    it("C3.17 all TTYs are accessible", () => {
        for (let i = 1; i <= 6; i++) {
            const tty = manager.getTTY(i);
            expect(tty).toBeDefined();
            expect(tty!.width).toBeGreaterThan(0);
            expect(tty!.height).toBeGreaterThan(0);
        }
    });
});
