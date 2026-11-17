/**
 * device-registry.test.ts — Penerbitan dan pengikatan deviceId.
 */

import { describe, it, expect } from "vitest";
import { DeviceRegistry, DeviceRegistryError } from "./device-registry";

describe("DeviceRegistry", () => {
    it("menerbitkan deviceId unik dan mengikatnya ke akun", () => {
        const reg = new DeviceRegistry();
        const a = reg.register("account-a", { name: "Sensor Kota", city: "Bandung" });
        const b = reg.register("account-a");

        expect(a.deviceId).not.toBe(b.deviceId);
        expect(a.accountId).toBe("account-a");
        expect(reg.belongsTo("account-a", a.deviceId)).toBe(true);
        expect(reg.belongsTo("account-b", a.deviceId)).toBe(false);
    });

    it("deviceId yang sama tidak dianggap milik akun lain", () => {
        const reg = new DeviceRegistry();
        const a = reg.register("account-a");
        expect(reg.get("account-b", a.deviceId)).toBeUndefined();
    });

    it("metadata bisa diperbarui sebagian", () => {
        const reg = new DeviceRegistry();
        const dev = reg.register("account-a", { name: "Lama", category: "esp" });
        const updated = reg.updateMeta("account-a", dev.deviceId, { name: "Baru", group: "kota-bandung" });

        expect(updated.meta).toEqual({ name: "Baru", category: "esp", group: "kota-bandung" });
    });

    it("membuang metadata kosong", () => {
        const reg = new DeviceRegistry();
        const dev = reg.register("account-a", { name: "   ", city: "" });
        expect(dev.meta).toEqual({});
    });

    it("menolak update device yang tidak terdaftar", () => {
        const reg = new DeviceRegistry();
        expect(() => reg.updateMeta("account-a", "tidak-ada", { name: "x" })).toThrow(DeviceRegistryError);
    });

    it("listByAccount hanya mengembalikan milik akun itu", () => {
        const reg = new DeviceRegistry();
        reg.register("account-a");
        reg.register("account-a");
        reg.register("account-b");
        expect(reg.listByAccount("account-a")).toHaveLength(2);
    });

    it("round-trip serialisasi", () => {
        const reg = new DeviceRegistry();
        const dev = reg.register("account-a", { name: "Satu", group: "g1" });

        const restored = DeviceRegistry.fromJSON(JSON.parse(JSON.stringify(reg.toJSON())));
        expect(restored.get("account-a", dev.deviceId)!.meta).toEqual({ name: "Satu", group: "g1" });
    });
});
