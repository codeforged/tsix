/**
 * lantana-core.test.ts — Parser dan helper V2.
 */

import { describe, it, expect } from "vitest";
import {
    LantanaError,
    detectFormat,
    encodeBinaryPayload,
    encodePlainPayload,
    parseBinaryPayload,
    parsePayload,
    resolveDaemonTarget,
    schemeInList,
} from "./lantana-core";

describe("parsePlainPayload", () => {
    it("mengurai LANTANA|<deviceId>|scheme:value", () => {
        const r = parsePlainPayloadSafe("LANTANA|dev-1|101:25.5;102:60");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.deviceId).toBe("dev-1");
        expect(r.readings).toEqual([
            { schemeId: 101, value: 25.5 },
            { schemeId: 102, value: 60 },
        ]);
    });

    it("mendukung nilai boolean", () => {
        const r = parsePlainPayloadSafe("LANTANA|dev-1|200:true;201:false");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.readings.map((x) => x.value)).toEqual([true, false]);
    });

    it("menolak format lama tanpa deviceId", () => {
        const r = parsePayload("101:25;102:60");
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toBe(LantanaError.PAYLOAD_INVALID);
    });

    it("menolak schemeId non-numerik", () => {
        const r = parsePayload("LANTANA|dev-1|temp:25");
        expect(r.ok).toBe(false);
    });

    it("menolak payload tanpa bacaan", () => {
        const r = parsePayload("LANTANA|dev-1|");
        expect(r.ok).toBe(false);
    });

    it("menolak deviceId kosong", () => {
        const r = parsePayload("LANTANA||101:25");
        expect(r.ok).toBe(false);
    });
});

describe("parseBinaryPayload", () => {
    it("round-trip frame biner V2 (angka + boolean)", () => {
        const frame = encodeBinaryPayload("dev-bin", [
            { schemeId: 101, value: 25.5 },
            { schemeId: 200, value: true },
            { schemeId: 300, value: "ok" },
        ]);
        const r = parseBinaryPayload(frame);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.deviceId).toBe("dev-bin");
        expect(r.readings).toEqual([
            { schemeId: 101, value: 25.5 },
            { schemeId: 200, value: true },
            { schemeId: 300, value: "ok" },
        ]);
    });

    it("menolak frame versi lama (0x01)", () => {
        const legacy = Buffer.from([0x4c, 0x01, 0x03, 0x64, 0x65, 0x76, 0x01]);
        const r = parseBinaryPayload(legacy);
        expect(r.ok).toBe(false);
    });

    it("menolak frame terpotong", () => {
        const full = encodeBinaryPayload("dev", [{ schemeId: 1, value: 1 }]);
        const r = parseBinaryPayload(full.subarray(0, full.length - 2));
        expect(r.ok).toBe(false);
    });

    it("menolak magic salah", () => {
        const r = parseBinaryPayload(Buffer.from([0x42, 0x02, 0x01]));
        expect(r.ok).toBe(false);
    });
});

describe("detectFormat", () => {
    it("mendeteksi biner dan plain, menolak sisanya", () => {
        expect(detectFormat(Buffer.from([0x4c, 0x02]))).toBe("binary");
        expect(detectFormat("LANTANA|dev|1:2")).toBe("plain");
        expect(detectFormat("101:25")).toBe("unknown");
        expect(detectFormat({})).toBe("unknown");
    });
});

describe("encodePlainPayload", () => {
    it("menghasilkan format yang bisa diparse ulang", () => {
        const text = encodePlainPayload("dev-1", [{ schemeId: 101, value: 3 }]);
        const r = parsePayload(text);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.readings[0]).toEqual({ schemeId: 101, value: 3 });
    });
});

describe("schemeInList", () => {
    it("mencocokkan ID tunggal dan rentang", () => {
        const list = [100, { from: 201, to: 205 }] as any;
        expect(schemeInList(list, 100)).toBe(true);
        expect(schemeInList(list, 101)).toBe(false);
        expect(schemeInList(list, 203)).toBe(true);
        expect(schemeInList(list, 206)).toBe(false);
        expect(schemeInList([], 100)).toBe(false);
        expect(schemeInList(undefined, 100)).toBe(false);
    });
});

function parsePlainPayloadSafe(text: string) {
    return parsePayload(text) as
        | { ok: true; deviceId: string; readings: { schemeId: number; value: any }[] }
        | { ok: false; error: LantanaError; message: string };
}

describe("resolveDaemonTarget", () => {
    it("mengubah PID numerik menjadi number (kernel butuh PID, bukan identity)", () => {
        expect(resolveDaemonTarget("7")).toBe(7);
        expect(resolveDaemonTarget(" 42 ")).toBe(42);
    });

    it("mempertahankan UUID sebagai identity", () => {
        expect(resolveDaemonTarget("5f4e2a91-4b0f-4c9a-b1c3-0a1b2c3d4e5f")).toBe(
            "5f4e2a91-4b0f-4c9a-b1c3-0a1b2c3d4e5f",
        );
    });

    it("default ke UUID Lantana bila argumen kosong", () => {
        expect(resolveDaemonTarget()).toBe("5f4e2a91-4b0f-4c9a-b1c3-0a1b2c3d4e5f");
        expect(resolveDaemonTarget("   ")).toBe("5f4e2a91-4b0f-4c9a-b1c3-0a1b2c3d4e5f");
    });
});
