/**
 * lantana-core.test.ts — Unit test untuk Lantana core
 *
 * Menguji:
 *  - detectFormat: deteksi biner vs plaintext
 *  - parsePlainPayload: format plaintext (LANTANA|<nodeId>|... & legacy id:val;)
 *  - parseBinaryPayload: frame biner Lantana (0x4C 0x01 ...)
 *  - parsePayload: dispatcher
 *  - getPortConfig: filter port enabled
 */

import { describe, it, expect } from "vitest";
import {
    detectFormat,
    parsePlainPayload,
    parseBinaryPayload,
    parsePayload,
    getPortConfig,
    LantanaConfig,
} from "./lantana-core";

const config: LantanaConfig = {
    ports: {
        "1000": { tenant: "default", keyHex: "ab", enabled: true, mode: "auto" },
        "1001": { tenant: "tenant-b", keyHex: "cd", enabled: false, mode: "auto" },
    },
    deviceCategories: {},
    sensorCategories: {},
};

describe("detectFormat", () => {
    it("mendeteksi Buffer biner (magic 0x42 MQTNL)", () => {
        const buf = Buffer.from([0x42, 0x01, 0x00]);
        expect(detectFormat(buf)).toBe("binary");
    });

    it("mendeteksi Buffer biner (magic 0x4C frame Lantana)", () => {
        const buf = Buffer.from([0x4c, 0x01, 0x00]);
    });

    it("mendeteksi Buffer plaintext (bukan 0x42)", () => {
        const buf = Buffer.from("01:25", "utf8");
        expect(detectFormat(buf)).toBe("plain");
    });

    it("mendeteksi string JSON Buffer biner", () => {
        const s = JSON.stringify({ type: "Buffer", data: [0x42, 0x01, 0x00] });
        expect(detectFormat(s)).toBe("binary");
    });

    it("mendeteksi string plaintext", () => {
        expect(detectFormat("LANTANA|node|01:25")).toBe("plain");
        expect(detectFormat("01:25;02:60")).toBe("plain");
    });
});

describe("parsePlainPayload", () => {
    it("mengurai format LANTANA|<nodeId>|<payload>", () => {
        const { nodeId, sensors } = parsePlainPayload(
            "LANTANA|esp32-01|01:25;02:60;03:1013;04:100",
            "fallback",
        );
        expect(nodeId).toBe("esp32-01");
        expect(sensors).toHaveLength(4);
        expect(sensors[0]).toEqual({ id: "01", value: 25 });
        expect(sensors[3]).toEqual({ id: "04", value: 100 });
    });

    it("mengurai format legacy id:val;id:val", () => {
        const { nodeId, sensors } = parsePlainPayload("01:25;02:60", "node-fallback");
        expect(nodeId).toBe("node-fallback");
        expect(sensors).toHaveLength(2);
    });

    it("menangani nilai desimal", () => {
        const { sensors } = parsePlainPayload("01:25.5;02:60.25", "n");
        expect(sensors[0].value).toBeCloseTo(25.5);
        expect(sensors[1].value).toBeCloseTo(60.25);
    });

    it("mengabaikan entri tidak valid", () => {
        const { sensors } = parsePlainPayload("01:25;garbage;;02:60", "n");
        expect(sensors).toHaveLength(2);
    });
});

describe("parseBinaryPayload", () => {
    it("mengurai frame biner Lantana (0x4C 0x01)", () => {
        // Build frame: [0x4C][0x01][nodeLen][node][cnt][sidLen][sid][f32]...
        const parts: Buffer[] = [];
        parts.push(Buffer.from([0x4c, 0x01]));
        const node = Buffer.from("esp32-bin", "utf8");
        parts.push(Buffer.from([node.length]));
        parts.push(node);
        parts.push(Buffer.from([2]));
        const sid1 = Buffer.from("01", "utf8");
        parts.push(Buffer.from([sid1.length]));
        parts.push(sid1);
        const v1 = Buffer.alloc(4);
        v1.writeFloatLE(25.5, 0);
        parts.push(v1);
        const sid2 = Buffer.from("02", "utf8");
        parts.push(Buffer.from([sid2.length]));
        parts.push(sid2);
        const v2 = Buffer.alloc(4);
        v2.writeFloatLE(60.25, 0);
        parts.push(v2);
        const frame = Buffer.concat(parts);

        const { nodeId, sensors } = parseBinaryPayload(frame, "fallback");
        expect(nodeId).toBe("esp32-bin");
        expect(sensors).toHaveLength(2);
        expect(sensors[0]).toEqual({ id: "01", value: 25.5 });
        expect(sensors[1].value).toBeCloseTo(60.25);
    });

    it("fallback ke teks jika frame tidak dikenal", () => {
        const buf = Buffer.from("LANTANA|nodeX|01:10", "utf8");
        const { nodeId, sensors } = parseBinaryPayload(buf, "fallback");
        expect(nodeId).toBe("nodeX");
        expect(sensors[0]).toEqual({ id: "01", value: 10 });
    });
});

describe("parsePayload", () => {
    it("menangani input plaintext string", () => {
        const r = parsePayload("LANTANA|esp32-01|01:25", "fallback");
        expect(r.format).toBe("plain");
        expect(r.nodeId).toBe("esp32-01");
    });

    it("menangani input Buffer biner", () => {
        const buf = Buffer.from([0x42, 0x01, 0x00]);
        const r = parsePayload(buf, "fallback");
        expect(r.format).toBe("binary");
        expect(r.nodeId).toBe("fallback");
        expect(r.sensors).toEqual([]);
    });
});

describe("getPortConfig", () => {
    it("mengembalikan config port yang enabled", () => {
        const p = getPortConfig(config, 1000);
        expect(p).not.toBeNull();
        expect(p!.tenant).toBe("default");
    });

    it("mengembalikan null untuk port yang disabled", () => {
        expect(getPortConfig(config, 1001)).toBeNull();
    });

    it("mengembalikan null untuk port tidak terdaftar", () => {
        expect(getPortConfig(config, 9999)).toBeNull();
    });
});
