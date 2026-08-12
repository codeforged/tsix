import { describe, it, expect, beforeEach } from "vitest";
import { GUIRegistry } from "./GUIRegistry";

describe("GUIRegistry", () => {
    let guiRegistry: GUIRegistry;

    beforeEach(() => {
        guiRegistry = new GUIRegistry();
    });

    // ============================================================
    // A8.01–A8.02: Window Creation
    // ============================================================
    it("A8.01 Create window – valid pid", () => {
        const entry = guiRegistry.createWindow("w1", 101, "Test Window");
        expect(entry.wid).toBe("w1");
        expect(entry.pid).toBe(101);
        expect(entry.title).toBe("Test Window");
        expect(entry.focused).toBe(true);
        expect(guiRegistry.getWindowCount()).toBe(1);
    });

    it("A8.02 Create window – uniqueness check", () => {
        guiRegistry.createWindow("w1", 101);
        expect(() => guiRegistry.createWindow("w1", 102)).toThrow("Window 'w1' already exists.");
    });

    // ============================================================
    // A8.03–A8.05: Window Destruction
    // ============================================================
    it("A8.03 Destroy window – valid wid", () => {
        guiRegistry.createWindow("w1", 101);
        expect(guiRegistry.destroyWindow("w1")).toBe(true);
        expect(guiRegistry.getWindowCount()).toBe(0);
    });

    it("A8.04 Destroy window – invalid wid", () => {
        expect(guiRegistry.destroyWindow("w_nonexistent")).toBe(false);
    });

    it("A8.05 Destroy window – auto-cleanup on process exit", () => {
        guiRegistry.createWindow("w1", 101);
        guiRegistry.createWindow("w2", 101);
        guiRegistry.createWindow("w3", 102);

        const destroyedWids = guiRegistry.destroyAllForPid(101);
        expect(destroyedWids.sort()).toEqual(["w1", "w2"]);
        expect(guiRegistry.getWindowCount()).toBe(1);
        expect(guiRegistry.getWindow("w3")).toBeDefined();
    });

    // ============================================================
    // A8.06–A8.10: Window Properties and Routing
    // ============================================================
    it("A8.06 pid<->wid mapping – correct owner lookup", () => {
        guiRegistry.createWindow("w1", 101);
        expect(guiRegistry.isOwner(101, "w1")).toBe(true);
        expect(guiRegistry.isOwner(102, "w1")).toBe(false);
        expect(guiRegistry.getOwner("w1")).toBe(101);
        expect(guiRegistry.getOwner("w_invalid")).toBeNull();
    });

    it("A8.07 MOUNT_NODE routing to gued daemon", () => {
        expect(guiRegistry.isDaemonAlive()).toBe(false);
        guiRegistry.registerDaemon(50);
        expect(guiRegistry.isDaemonAlive()).toBe(true);
        expect(guiRegistry.getDaemonPid()).toBe(50);
    });

    it("A8.08 Event forwarding – click/input/keydown to correct owner pid", () => {
        guiRegistry.createWindow("w_event", 105);
        const event = { type: "click", wid: "w_event" };
        
        // Resolve target pid for event
        const targetPid = guiRegistry.getOwner(event.wid);
        expect(targetPid).toBe(105);
    });

    it("A8.09 Event forwarding – stale wid (window destroyed)", () => {
        guiRegistry.createWindow("w_stale", 105);
        guiRegistry.destroyWindow("w_stale");
        
        const targetPid = guiRegistry.getOwner("w_stale");
        expect(targetPid).toBeNull();
    });

    it("A8.10 Multi-window single process management", () => {
        guiRegistry.createWindow("w1", 200, "Window 1");
        guiRegistry.createWindow("w2", 200, "Window 2");

        expect(guiRegistry.getWindowCountForPid(200)).toBe(2);
        
        const allWids = guiRegistry.getWindowsForPid(200);
        expect(allWids.sort()).toEqual(["w1", "w2"]);

        // Verify focus updates
        expect(guiRegistry.getWindow("w2")!.focused).toBe(true);
        expect(guiRegistry.getWindow("w1")!.focused).toBe(false);

        // Bring w1 to focus
        guiRegistry.setFocus("w1");
        expect(guiRegistry.getWindow("w1")!.focused).toBe(true);
        expect(guiRegistry.getWindow("w2")!.focused).toBe(false);

        // Check top window
        const top = guiRegistry.getTopWindow();
        expect(top!.wid).toBe("w1");
    });
});
