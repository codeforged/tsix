/**
 * scheme-registry.test.ts — CRUD scheme dan validasi nilai.
 */

import { describe, it, expect } from "vitest";
import { SchemeRegistry, SchemeRegistryError } from "./scheme-registry";
import { LantanaError } from "./lantana-core";

const temp = (over: Partial<any> = {}) => ({
    schemeId: 101,
    ownerAccountId: "root",
    label: "Temperature",
    unit: "°C",
    type: "number" as const,
    min: -40,
    max: 125,
    ...over,
});

describe("SchemeRegistry CRUD", () => {
    it("menambah dan mengambil scheme", () => {
        const reg = new SchemeRegistry();
        reg.add(temp());
        expect(reg.get(101)!.label).toBe("Temperature");
        expect(reg.list()).toHaveLength(1);
    });

    it("menolak schemeId duplikat", () => {
        const reg = new SchemeRegistry();
        reg.add(temp());
        expect(() => reg.add(temp())).toThrow(/sudah ada/);
    });

    it("menolak schemeId di luar 1..65535", () => {
        const reg = new SchemeRegistry();
        expect(() => reg.add(temp({ schemeId: 0 }))).toThrow(SchemeRegistryError);
        expect(() => reg.add(temp({ schemeId: 70000 }))).toThrow(SchemeRegistryError);
    });

    it("menolak rentang min/max yang tidak valid saat membuat scheme", () => {
        const reg = new SchemeRegistry();
        expect(() => reg.add(temp({ min: 200, max: 100 }))).toThrow(/min/);
        expect(() => reg.add(temp({ min: Number.NaN }))).toThrow(/finite/);
    });

    it("hanya pemilik yang boleh update/hapus", () => {
        const reg = new SchemeRegistry();
        reg.add(temp());
        expect(() => reg.update("lain", 101, { label: "x" })).toThrow(/bukan pemilik/);
        expect(() => reg.remove("lain", 101)).toThrow(/bukan pemilik/);
        expect(reg.update("root", 101, { label: "Suhu" }).label).toBe("Suhu");
        reg.remove("root", 101);
        expect(reg.has(101)).toBe(false);
    });

    it("menolak min > max", () => {
        const reg = new SchemeRegistry();
        reg.add(temp());
        expect(() => reg.update("root", 101, { min: 200 })).toThrow(/min/);
    });

    it("round-trip serialisasi", () => {
        const reg = new SchemeRegistry();
        reg.add(temp());
        const restored = SchemeRegistry.fromJSON(JSON.parse(JSON.stringify(reg.toJSON())));
        expect(restored.get(101)).toMatchObject({ label: "Temperature", unit: "°C", max: 125 });
    });
});

describe("validasi nilai", () => {
    it("menerima angka dalam rentang", () => {
        const reg = new SchemeRegistry();
        reg.add(temp());
        expect(reg.validate(101, 25).ok).toBe(true);
    });

    it("menolak scheme tidak dikenal", () => {
        const reg = new SchemeRegistry();
        const r = reg.validate(999, 1);
        expect(r.ok).toBe(false);
        expect(r.error).toBe(LantanaError.UNKNOWN_SCHEME);
    });

    it("menolak tipe salah", () => {
        const reg = new SchemeRegistry();
        reg.add(temp());
        expect(reg.validate(101, "25").ok).toBe(false);
        expect(reg.validate(101, NaN).ok).toBe(false);
    });

    it("menolak nilai di luar min/max", () => {
        const reg = new SchemeRegistry();
        reg.add(temp());
        expect(reg.validate(101, 200).ok).toBe(false);
        expect(reg.validate(101, -50).ok).toBe(false);
    });

    it("memvalidasi boolean dan string", () => {
        const reg = new SchemeRegistry();
        reg.add(temp({ schemeId: 200, type: "boolean", min: undefined, max: undefined }));
        reg.add(temp({ schemeId: 300, type: "string", min: undefined, max: undefined }));

        expect(reg.validate(200, true).ok).toBe(true);
        expect(reg.validate(200, 1).ok).toBe(false);
        expect(reg.validate(300, "ok").ok).toBe(true);
        expect(reg.validate(300, "").ok).toBe(false);
    });
});

describe("batas panjang label/unit", () => {
    const base = { ownerAccountId: "acc", type: "number" as const };

    it("menerima batas maksimal", () => {
        const reg = new SchemeRegistry();
        const s = reg.add({ ...base, schemeId: 1, label: "L".repeat(128), unit: "u".repeat(32) });
        expect(s.label).toHaveLength(128);
    });

    it("menolak label > 128 dan unit > 32 saat add", () => {
        const reg = new SchemeRegistry();
        expect(() => reg.add({ ...base, schemeId: 1, label: "L".repeat(129) })).toThrow(/label maksimal 128/);
        expect(() => reg.add({ ...base, schemeId: 2, label: "Suhu", unit: "u".repeat(33) })).toThrow(/unit maksimal 32/);
        expect(reg.list()).toEqual([]);
    });

    it("menolak patch yang melebihi batas tanpa mengubah scheme", () => {
        const reg = new SchemeRegistry();
        reg.add({ ...base, schemeId: 1, label: "Suhu", unit: "C" });
        expect(() => reg.update("acc", 1, { label: "L".repeat(129) })).toThrow(/label maksimal/);
        expect(() => reg.update("acc", 1, { unit: "u".repeat(33) })).toThrow(/unit maksimal/);
        expect(reg.get(1)).toMatchObject({ label: "Suhu", unit: "C" });
    });
});
