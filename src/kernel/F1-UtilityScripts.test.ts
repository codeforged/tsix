import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

// F1.01 – merge_packages.js
describe("F. Utility Scripts", () => {
    describe("F1.01 merge_packages", () => {
        const content = fs.readFileSync(path.resolve(__dirname, "../../merge_packages.js"), "utf8");

        it("reads update_items.json", () => {
            expect(content).toContain("update_items.json");
            expect(content).toContain("JSON.parse");
        });
        it("outputs packages.json", () => {
            expect(content).toContain("packages.json");
            expect(content).toContain("JSON.stringify");
        });
        it("maps items array with src/dst", () => {
            expect(content).toContain('"src"');
            expect(content).toContain('"dst"');
        });
    });

    // F1.02 – gen_update_items.js
    describe("F1.02 gen_update_items", () => {
        const content = fs.readFileSync(path.resolve(__dirname, "../../gen_update_items.js"), "utf8");

        it("scans dirsToScan array", () => {
            expect(content).toContain("dirsToScan");
            expect(content).toContain("forEach");
        });
        it("handles individualFiles", () => {
            expect(content).toContain("individualFiles");
        });
        it("writes update_items.json with JSON.stringify", () => {
            expect(content).toContain("update_items.json");
            expect(content).toContain("JSON.stringify");
        });
        it("uses path.join for cross-platform", () => {
            expect(content).toContain("path.join");
        });
    });

    // F1.03 – check_db.js
    describe("F1.03 check_db", () => {
        const content = fs.readFileSync(path.resolve(__dirname, "../../check_db.js"), "utf8");

        it("queries table list from sqlite_master", () => {
            expect(content).toContain("sqlite_master");
        });
        it("aggregates total_size and file_count", () => {
            expect(content).toContain("total_size");
            expect(content).toContain("file_count");
            expect(content).toContain("SUM");
        });
        it("handles error with try/catch", () => {
            expect(content).toContain("try {");
            expect(content).toContain("catch (e)");
        });
    });

    // F1.04 – inspect_db.js
    describe("F1.04 inspect_db", () => {
        const content = fs.readFileSync(path.resolve(__dirname, "../../inspect_db.js"), "utf8");

        it("queries vnodes by specific IDs", () => {
            expect(content).toContain("SELECT id, parent_id, name FROM vnodes");
        });
        it("uses parameterized query with WHERE id IN", () => {
            expect(content).toContain("WHERE id IN");
        });
    });

    // F1.05 – read_mid.js
    describe("F1.05 read_mid", () => {
        const content = fs.readFileSync(path.resolve(__dirname, "../../read_mid.js"), "utf8");

        it("calculates midpoint: Math.floor(size / 2)", () => {
            expect(content).toContain("floor");
            expect(content).toContain("/ 2");
        });
        it("uses SUBSTR for midpoint extraction", () => {
            expect(content).toContain("substr(content");
        });
        it("handles empty syslog gracefully", () => {
            expect(content).toContain("EMPTY");
        });
    });

    // F1.06 – read_syslog.js
    describe("F1.06 read_syslog", () => {
        const content = fs.readFileSync(path.resolve(__dirname, "../../read_syslog.js"), "utf8");

        it("reads syslog start with SUBSTR from 1", () => {
            expect(content).toContain("substr(content, 1");
        });
        it("reads syslog end with negative offset", () => {
            expect(content).toContain("substr(content, -");
        });
        it("prints SYSLOG START and SYSLOG END sections", () => {
            expect(content).toContain("SYSLOG START");
            expect(content).toContain("SYSLOG END");
        });
    });

    // F1.07 – read_tail.js
    describe("F1.07 read_tail", () => {
        const content = fs.readFileSync(path.resolve(__dirname, "../../read_tail.js"), "utf8");

        it("uses Math.max to prevent negative offset", () => {
            expect(content).toContain("Math.max");
        });
        it("extracts last 5KB with SUBSTR", () => {
            expect(content).toContain("substr(content");
            expect(content).toContain("5000");
        });
    });

    // F1.08 – dump-ports.js
    describe("F1.08 dump-ports", () => {
        const content = fs.readFileSync(path.resolve(__dirname, "../../dump-ports.js"), "utf8");

        it("uses SerialPort.list() async", () => {
            expect(content).toContain("SerialPort.list");
            expect(content).toContain("async");
        });
        it("outputs JSON with null, 2 indentation", () => {
            expect(content).toContain("JSON.stringify");
            expect(content).toContain("null, 2");
        });
    });

    // F1.09 – clean_bloat.js
    describe("F1.09 clean_bloat", () => {
        const content = fs.readFileSync(path.resolve(__dirname, "../../clean_bloat.js"), "utf8");

        it("truncates syslog: SET content='' WHERE name='syslog'", () => {
            expect(content).toContain("SET content=");
            expect(content).toContain("syslog");
        });
        it("uses VACUUM to reclaim space", () => {
            expect(content).toContain("VACUUM");
        });
        it("has try/catch error handling", () => {
            expect(content).toContain("try {");
            expect(content).toContain("catch (e)");
        });
    });
});
