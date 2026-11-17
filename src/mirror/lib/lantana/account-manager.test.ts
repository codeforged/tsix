/**
 * account-manager.test.ts — Akun parent-child dan AccessKey.
 */

import { describe, it, expect } from "vitest";
import * as crypto from "crypto";
import { AccountError, AccountManager } from "./account-manager";
import { derivePsk } from "./lantana-psk";

function dashboardProof(accessKey: string, dashboardId: number, nonce: string): string {
    const verifier = crypto.createHash("sha256").update(accessKey).digest();
    return crypto
        .createHmac("sha256", verifier)
        .update(`lantana-dashboard-v1\0${dashboardId}\0${nonce}`)
        .digest("hex");
}

describe("hierarki akun", () => {
    it("membuat root dan child dengan parent yang benar", () => {
        const mgr = new AccountManager();
        mgr.createRoot("root");
        mgr.createChild("root", "anak");

        expect(mgr.get("root")!.parentId).toBeNull();
        expect(mgr.get("anak")!.parentId).toBe("root");
        expect(mgr.listChildren("root").map((a) => a.accountId)).toEqual(["anak"]);
    });

    it("menolak accountId duplikat", () => {
        const mgr = new AccountManager();
        mgr.createRoot("root");
        expect(() => mgr.createRoot("root")).toThrow(AccountError);
    });

    it("menolak child tanpa parent terdaftar", () => {
        const mgr = new AccountManager();
        expect(() => mgr.createChild("tidak-ada", "anak")).toThrow(/parent tidak ditemukan/);
    });

    it("canManage hanya untuk diri sendiri dan keturunan", () => {
        const mgr = new AccountManager();
        mgr.createRoot("root");
        mgr.createChild("root", "anak");
        mgr.createChild("anak", "cucu");
        mgr.createRoot("lain");

        expect(mgr.canManage("root", "anak")).toBe(true);
        expect(mgr.canManage("root", "cucu")).toBe(true);
        expect(mgr.canManage("anak", "cucu")).toBe(true);
        expect(mgr.canManage("anak", "root")).toBe(false);
        expect(mgr.canManage("lain", "cucu")).toBe(false);
    });

    it("menolak hapus akun yang masih punya child", () => {
        const mgr = new AccountManager();
        mgr.createRoot("root");
        mgr.createChild("root", "anak");
        expect(() => mgr.remove("root")).toThrow(/masih punya child/);
        mgr.remove("anak");
        mgr.remove("root");
        expect(mgr.has("root")).toBe(false);
    });
});

describe("izin", () => {
    it("default menolak semua", () => {
        const mgr = new AccountManager();
        const acc = mgr.createRoot("root");
        expect(acc.permissions.allowedInjectSchemes).toEqual([]);
        expect(acc.permissions.allowedQuerySchemes).toEqual([]);
        expect(acc.permissions.allowedCommandDevices).toEqual([]);
    });

    it("menormalisasi rentang dan membuang entri tidak valid", () => {
        const mgr = new AccountManager();
        const acc = mgr.createRoot("root", {
            allowedInjectSchemes: [100, { from: 201, to: 205 }, { from: 9, to: 1 } as any, -5 as any],
            allowedQuerySchemes: [{ from: 100, to: 103 }],
            allowedCommandDevices: ["dev-1", "dev-1", ""],
        });
        expect(acc.permissions.allowedInjectSchemes).toEqual([100, { from: 201, to: 205 }]);
        expect(acc.permissions.allowedQuerySchemes).toEqual([{ from: 100, to: 103 }]);
        expect(acc.permissions.allowedCommandDevices).toEqual(["dev-1"]);
    });
});

describe("AccessKey", () => {
    it("menerbitkan key 64 hex dan memverifikasinya", () => {
        const mgr = new AccountManager();
        mgr.createRoot("root");
        const key = mgr.issueAccessKey("root");

        expect(key).toMatch(/^[0-9a-f]{64}$/);
        expect(mgr.verifyAccessKey("root", key)).toBe(true);
        expect(mgr.verifyAccessKey("root", "deadbeef")).toBe(false);
    });

    it("tidak menyimpan key mentah", () => {
        const mgr = new AccountManager();
        mgr.createRoot("root");
        const key = mgr.issueAccessKey("root");
        const serialized = JSON.stringify(mgr.toJSON());
        expect(serialized).not.toContain(key);
        expect(mgr.get("root")!.credential!.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("menyimpan PSK = SHA-256(accessKey) untuk handshake ESP8266", () => {
        const mgr = new AccountManager();
        mgr.createRoot("root");
        const key = mgr.issueAccessKey("root");

        expect(mgr.getPsk("root")!.equals(derivePsk(key))).toBe(true);
        mgr.revokeAccessKey("root");
        expect(mgr.getPsk("root")).toBeNull();
    });

    it("rotasi mengganti PSK", () => {
        const mgr = new AccountManager();
        mgr.createRoot("root");
        mgr.issueAccessKey("root");
        const oldPsk = Buffer.from(mgr.getPsk("root")!);
        mgr.rotateAccessKey("root");
        expect(mgr.getPsk("root")!.equals(oldPsk)).toBe(false);
    });

    it("rotasi membatalkan key lama", () => {
        const mgr = new AccountManager();
        mgr.createRoot("root");
        const oldKey = mgr.issueAccessKey("root");
        const newKey = mgr.rotateAccessKey("root");

        expect(newKey).not.toBe(oldKey);
        expect(mgr.verifyAccessKey("root", oldKey)).toBe(false);
        expect(mgr.verifyAccessKey("root", newKey)).toBe(true);
    });

    it("pencabutan menolak semua key", () => {
        const mgr = new AccountManager();
        mgr.createRoot("root");
        const key = mgr.issueAccessKey("root");
        mgr.revokeAccessKey("root");

        expect(mgr.hasAccessKey("root")).toBe(false);
        expect(mgr.verifyAccessKey("root", key)).toBe(false);
    });

    it("key akun lain tidak berlaku", () => {
        const mgr = new AccountManager();
        mgr.createRoot("a");
        mgr.createRoot("b");
        const keyA = mgr.issueAccessKey("a");
        mgr.issueAccessKey("b");

        expect(mgr.verifyAccessKey("b", keyA)).toBe(false);
    });

    it("menerbitkan key portable dashboard dan hanya menyimpan verifier", () => {
        const mgr = new AccountManager();
        mgr.createRoot("root");

        const issued = mgr.issuePortableDashboardAccessKey("root");
        const saved = JSON.stringify(mgr.toJSON());

        expect(issued.dashboardId).toBeGreaterThanOrEqual(1000);
        expect(mgr.getPortableDashboard("root", issued.dashboardId)?.title).toBe(
            `Dashboard ${issued.dashboardId}`,
        );
        expect(issued.accessKey).toMatch(/^[0-9a-f]{64}$/);
        const proof = dashboardProof(issued.accessKey, issued.dashboardId, "nonce-1");
        expect(mgr.verifyPortableDashboardProof(issued.dashboardId, "nonce-1", proof)?.accountId).toBe("root");
        expect(mgr.verifyPortableDashboardProof(issued.dashboardId, "nonce-2", proof)).toBeNull();
        expect(saved).not.toContain(issued.accessKey);
        expect(saved).toContain("accessKeyHash");
        expect(Array.isArray(mgr.require("root").portableDashboard)).toBe(true);
    });

    it("menambahkan beberapa dashboard dan mengelola key secara terpisah", () => {
        const mgr = new AccountManager();
        mgr.createRoot("root");
        const issued = mgr.issuePortableDashboardAccessKey("root");
        const second = mgr.issuePortableDashboardAccessKey("root");
        expect(second.dashboardId).not.toBe(issued.dashboardId);

        const account = mgr.require("root");
        const firstDashboard = mgr.getPortableDashboard("root", issued.dashboardId)!;
        firstDashboard.title = "Sensor Rumah";
        firstDashboard.dashboardItems.push({
            id: "temp",
            type: "text",
            title: "Suhu",
            icon: "thermostat",
            updateInterval: 60,
            deviceId: "device-1",
            schemeId: 101,
        });

        const rotated = mgr.rotatePortableDashboardAccessKey("root", issued.dashboardId);
        expect(rotated.dashboardId).toBe(issued.dashboardId);
        expect(
            mgr.verifyPortableDashboardProof(
                issued.dashboardId,
                "nonce-1",
                dashboardProof(issued.accessKey, issued.dashboardId, "nonce-1"),
            ),
        ).toBeNull();
        expect(
            mgr.verifyPortableDashboardProof(
                rotated.dashboardId,
                "nonce-2",
                dashboardProof(rotated.accessKey, rotated.dashboardId, "nonce-2"),
            )?.accountId,
        ).toBe("root");

        mgr.revokePortableDashboardAccessKey("root", second.dashboardId);
        expect(
            mgr.verifyPortableDashboardProof(
                second.dashboardId,
                "nonce-3",
                dashboardProof(second.accessKey, second.dashboardId, "nonce-3"),
            ),
        ).toBeNull();
        expect(
            mgr.verifyPortableDashboardProof(
                rotated.dashboardId,
                "nonce-4",
                dashboardProof(rotated.accessKey, rotated.dashboardId, "nonce-4"),
            )?.accountId,
        ).toBe("root");
        expect(firstDashboard.dashboardItems).toHaveLength(1);
        expect(account.portableDashboard).toHaveLength(2);
        expect(firstDashboard.title).toBe("Sensor Rumah");

        const restored = AccountManager.fromJSON(JSON.parse(JSON.stringify(mgr.toJSON())));
        expect(restored.getPortableDashboard("root", issued.dashboardId)?.title).toBe("Sensor Rumah");
    });
});

describe("serialisasi", () => {
    it("round-trip mempertahankan akun, izin, dan verifier", () => {
        const mgr = new AccountManager();
        mgr.createRoot("root", { allowedInjectSchemes: [{ from: 1, to: 5 }] });
        mgr.createChild("root", "anak");
        const key = mgr.issueAccessKey("anak");

        const restored = AccountManager.fromJSON(JSON.parse(JSON.stringify(mgr.toJSON())));
        expect(restored.get("anak")!.parentId).toBe("root");
        expect(restored.verifyAccessKey("anak", key)).toBe(true);
        expect(restored.get("root")!.permissions.allowedInjectSchemes).toEqual([{ from: 1, to: 5 }]);
    });

    it("round-trip mempertahankan konfigurasi portable dashboard", () => {
        const mgr = new AccountManager();
        mgr.createRoot("root");
        const issued = mgr.issuePortableDashboardAccessKey("root");
        mgr.getPortableDashboard("root", issued.dashboardId)!.dashboardItems.push({
            id: 1,
            type: "radialGauge",
            title: "Kelembapan",
            icon: "water_drop",
            updateInterval: 30,
            deviceId: "device-1",
            schemeId: 102,
        });

        const restored = AccountManager.fromJSON(JSON.parse(JSON.stringify(mgr.toJSON())));
        expect(
            restored.getPortableDashboard("root", issued.dashboardId)?.dashboardItems,
        ).toHaveLength(1);
        expect(
            restored.verifyPortableDashboardProof(
                issued.dashboardId,
                "nonce-1",
                dashboardProof(issued.accessKey, issued.dashboardId, "nonce-1"),
            )?.accountId,
        ).toBe("root");
    });

    it("memigrasikan format object lama menjadi array dan menolak accessKey mentah", () => {
        const legacyRecords = [
            {
                accountId: "root",
                parentId: null,
                permissions: {},
                credential: null,
                portableDashboard: {
                    dashboardId: 1000,
                    title: "Rumah",
                    accessKeyHash: "a".repeat(64),
                    dashboardItems: [],
                },
                createdAt: 1,
            },
        ] as any;
        const restored = AccountManager.fromJSON(legacyRecords);

        expect(Array.isArray(restored.require("root").portableDashboard)).toBe(true);
        expect(restored.getPortableDashboard("root", 1000)?.accessKeyHash).toBe("a".repeat(64));
        expect(Array.isArray(restored.toJSON()[0].portableDashboard)).toBe(true);
        expect(() =>
            AccountManager.fromJSON([
                {
                    ...legacyRecords[0],
                    portableDashboard: [
                        { dashboardId: 1000, accessKey: "raw", dashboardItems: [] },
                    ],
                },
            ]),
        ).toThrow(/accessKey mentah/);
        expect(() =>
            AccountManager.fromJSON([
                legacyRecords[0],
                { ...legacyRecords[0], accountId: "other" },
            ]),
        ).toThrow(/dashboardId duplikat/);
    });
});
