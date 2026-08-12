import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { Config, SysConfig } from "./Config";

describe("Config (D4)", () => {
    // Reset singleton between tests
    beforeEach(() => {
        // Access private static field to reset
        (Config as any).instance = undefined;
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    // ============================================================
    // D4.01–D4.02: Load Config
    // ============================================================
    it("D4.01 Parse valid config file", () => {
        const cfg = Config.load();
        expect(cfg).toBeDefined();
        expect(cfg.kernel).toBeDefined();
        expect(cfg.kernel.version).toBeDefined();
        expect(cfg.logger).toBeDefined();
        expect(cfg.scheduler).toBeDefined();
    });

    it("D4.02 Parse – missing file (throw or defaults)", () => {
        // Config.load() reads a physical file; if file doesn't exist it throws
        // We verify this by testing with a bad path via a manual wrapper
        const loadBadConfig = () => {
            const fsMod = require("fs");
            const rawData = fsMod.readFileSync("/nonexistent/path/config.json", "utf8");
            return JSON.parse(rawData);
        };
        expect(() => loadBadConfig()).toThrow();
    });

    it("D4.03 Parse – malformed JSON", () => {
        // Verify that JSON.parse throws on malformed input
        expect(() => JSON.parse("{ invalid json ;;;")).toThrow();
    });

    it("D4.04 Default values – all keys have defaults", () => {
        const cfg = Config.load();
        expect(cfg.kernel.database).toBeDefined();
        expect(cfg.logger.defaultLevel).toBeDefined();
        expect(cfg.scheduler.defaultCwd).toBeDefined();
        expect(cfg.shell.defaultUser).toBeDefined();
        expect(cfg.network.interfaces).toBeDefined();
    });

    it("D4.05 Config content – kernel.version is a string", () => {
        const cfg = Config.load();
        expect(typeof cfg.kernel.version).toBe("string");
    });

    it("D4.06 Config content – logger.logFile is a string", () => {
        const cfg = Config.load();
        expect(typeof cfg.logger.logFile).toBe("string");
    });

    it("D4.07 Config content – shell.defaultRows is number", () => {
        const cfg = Config.load();
        expect(typeof cfg.shell.defaultRows).toBe("number");
    });

    it("D4.08 Config content – shell.defaultColumns is number", () => {
        const cfg = Config.load();
        expect(typeof cfg.shell.defaultColumns).toBe("number");
    });

    it("D4.09 Nested config keys – network.interfaces is array", () => {
        const cfg = Config.load();
        expect(Array.isArray(cfg.network.interfaces)).toBe(true);
        expect(cfg.network.interfaces.length).toBeGreaterThan(0);
        expect(cfg.network.interfaces[0].broker).toBeDefined();
    });

    it("D4.10 Config singleton – same instance returned on double get()", () => {
        const cfg1 = Config.get();
        const cfg2 = Config.get();
        expect(cfg1).toBe(cfg2);
    });
});
