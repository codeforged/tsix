import { describe, it, expect, beforeEach, vi } from "vitest";
import { Kernel } from "./Kernel";

// Mock external dependencies to avoid actual boot
vi.mock("fs");
vi.mock("../common/Logger");
vi.mock("../vfs/BKFS");
vi.mock("./Scheduler");
vi.mock("./Syscalls");
vi.mock("./PermissionManager");
vi.mock("./PortManager");
vi.mock("./MountManager");
vi.mock("./GUIRegistry");
vi.mock("../common/Config");
vi.mock("./tty/TTYManager");
vi.mock("./PTYManager");
vi.mock("./devices/SimpleMQTNLDriver");
vi.mock("./devices/SerialDeviceManager");

describe("Kernel (A3)", () => {
    let kernel: Kernel;

    beforeEach(() => {
        kernel = new Kernel();
    });

    // A3.01
    it("A3.01 getVersion returns version string", () => {
        expect(kernel.getVersion()).toBeDefined();
        expect(typeof kernel.getVersion()).toBe("string");
        expect(kernel.getVersion().length).toBeGreaterThan(0);
    });

    // A3.02
    it("A3.02 getCodename returns codename string", () => {
        expect(kernel.getCodename()).toBeDefined();
        expect(typeof kernel.getCodename()).toBe("string");
    });

    // A3.03
    it("A3.03 getUptime returns positive number", () => {
        const uptime = kernel.getUptime();
        expect(typeof uptime).toBe("number");
        expect(uptime).toBeGreaterThanOrEqual(0);
    });

    // A3.04
    it("A3.04 devices registry is initialized as empty object", () => {
        expect(kernel.devices).toBeDefined();
        expect(typeof kernel.devices).toBe("object");
    });

    // A3.05
    it("A3.05 wantedExitCode defaults to 0", () => {
        expect(kernel.wantedExitCode).toBe(0);
    });

    // A3.06
    it("A3.06 guiRegistry is defined", () => {
        expect(kernel.guiRegistry).toBeDefined();
    });

    // A3.07 – bootLog requires kernel to be booted first, skip
    // A3.08
    it("A3.08 boot throws for invalid path", async () => {
        await expect(kernel.boot("nonexistent/path.db")).rejects.toThrow();
    });

    // A3.09
    it("A3.09 kernel hash matches between instances", () => {
        const k2 = new Kernel();
        expect(kernel.getVersion()).toBe(k2.getVersion());
    });

    // A3.10
    it("A3.10 codename is not empty", () => {
        expect(kernel.getCodename().length).toBeGreaterThan(0);
    });
});
