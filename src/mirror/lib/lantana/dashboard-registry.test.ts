/**
 * dashboard-registry.test.ts — Portable dashboard di dashboard.json.
 */

import { describe, it, expect } from "vitest";
import * as crypto from "crypto";
import { DashboardRegistry } from "./dashboard-registry";

function dashboardProof(accessKey: string, dashboardId: number, nonce: string): string {
    const verifier = crypto.createHash("sha256").update(accessKey).digest();
    return crypto
        .createHmac("sha256", verifier)
        .update(`lantana-dashboard-v1\0${dashboardId}\0${nonce}`)
        .digest("hex");
}

describe("key dashboard", () => {
    it("menerbitkan key dan hanya menyimpan verifier", () => {
        const dashboards = new DashboardRegistry();

        const issued = dashboards.issueAccessKey("root");
        const saved = JSON.stringify(dashboards.toJSON());

        expect(issued.dashboardId).toBeGreaterThanOrEqual(1000);
        expect(dashboards.get("root", issued.dashboardId)?.title).toBe(
            `Dashboard ${issued.dashboardId}`,
        );
        expect(issued.accessKey).toMatch(/^\d{6}$/);
        const proof = dashboardProof(issued.accessKey, issued.dashboardId, "nonce-1");
        expect(dashboards.verifyProof(issued.dashboardId, "nonce-1", proof)?.accountId).toBe("root");
        expect(dashboards.verifyProof(issued.dashboardId, "nonce-2", proof)).toBeNull();
        expect(saved).not.toContain(issued.accessKey);
        expect(saved).toContain("accessKeyHash");
        expect(dashboards.toJSON()[0].accountId).toBe("root");
    });

    it("memakai dashboardId yang ditentukan pemanggil", () => {
        const dashboards = new DashboardRegistry();

        const issued = dashboards.issueAccessKey("root", 4242);

        expect(issued.dashboardId).toBe(4242);
        expect(dashboards.get("root", 4242)?.title).toBe("Dashboard 4242");
    });

    it("mencari dashboard dari access key (mode key-only)", () => {
        const dashboards = new DashboardRegistry();
        const issued = dashboards.issueAccessKey("root", 4242);

        expect(dashboards.findByAccessKey(issued.accessKey)?.dashboard.dashboardId).toBe(4242);
        expect(dashboards.findByAccessKey("000000")).toBeUndefined();
    });

    it("mencari dashboard dari keyTag PSK", () => {
        const dashboards = new DashboardRegistry();
        const issued = dashboards.issueAccessKey("root", 4242);
        const tag = crypto
            .createHash("sha256")
            .update(issued.accessKey, "utf8")
            .digest("hex")
            .slice(0, 16);

        expect(dashboards.findByKeyTag(tag)?.dashboard.dashboardId).toBe(4242);
        expect(dashboards.findByKeyTag("0".repeat(16))).toBeUndefined();
    });

    it("rotasi key mengganti key lama dan tetap bisa dicari", () => {
        const dashboards = new DashboardRegistry();
        const first = dashboards.issueAccessKey("root");

        const rotated = dashboards.rotateAccessKey("root", first.dashboardId);

        expect(rotated.accessKey).not.toBe(first.accessKey);
        expect(dashboards.findByAccessKey(first.accessKey)).toBeUndefined();
        expect(dashboards.findByAccessKey(rotated.accessKey)?.dashboard.dashboardId).toBe(
            first.dashboardId,
        );
    });

    it("menolak dashboardId duplikat atau tidak valid", () => {
        const dashboards = new DashboardRegistry();
        dashboards.issueAccessKey("root", 4242);

        expect(() => dashboards.issueAccessKey("anak", "4242")).toThrow(/sudah dipakai/);
        expect(() => dashboards.issueAccessKey("root", 0)).toThrow(/integer positif/);
        expect(() => dashboards.issueAccessKey("root", -1)).toThrow(/integer positif/);
        expect(() => dashboards.issueAccessKey("root", 1.5)).toThrow(/integer positif/);
        expect(() => dashboards.issueAccessKey("root", "abc")).toThrow(/integer positif/);
    });

    it("menambahkan beberapa dashboard dan mengelola key secara terpisah", () => {
        const dashboards = new DashboardRegistry();
        const issued = dashboards.issueAccessKey("root");
        const second = dashboards.issueAccessKey("root");
        expect(second.dashboardId).not.toBe(issued.dashboardId);

        const firstDashboard = dashboards.get("root", issued.dashboardId)!;
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

        const rotated = dashboards.rotateAccessKey("root", issued.dashboardId);
        expect(rotated.dashboardId).toBe(issued.dashboardId);
        expect(
            dashboards.verifyProof(
                issued.dashboardId,
                "nonce-1",
                dashboardProof(issued.accessKey, issued.dashboardId, "nonce-1"),
            ),
        ).toBeNull();
        expect(
            dashboards.verifyProof(
                rotated.dashboardId,
                "nonce-2",
                dashboardProof(rotated.accessKey, rotated.dashboardId, "nonce-2"),
            )?.accountId,
        ).toBe("root");

        dashboards.revokeAccessKey("root", second.dashboardId);
        expect(
            dashboards.verifyProof(
                second.dashboardId,
                "nonce-3",
                dashboardProof(second.accessKey, second.dashboardId, "nonce-3"),
            ),
        ).toBeNull();
        expect(
            dashboards.verifyProof(
                rotated.dashboardId,
                "nonce-4",
                dashboardProof(rotated.accessKey, rotated.dashboardId, "nonce-4"),
            )?.accountId,
        ).toBe("root");
        expect(firstDashboard.dashboardItems).toHaveLength(1);
        expect(dashboards.listByAccount("root")).toHaveLength(2);
        expect(firstDashboard.title).toBe("Sensor Rumah");

        const restored = DashboardRegistry.fromJSON(
            JSON.parse(JSON.stringify(dashboards.toJSON())),
        );
        expect(restored.get("root", issued.dashboardId)?.title).toBe("Sensor Rumah");
    });

    it("mencari dashboard lintas akun", () => {
        const dashboards = new DashboardRegistry();
        const issued = dashboards.issueAccessKey("anak");
        expect(dashboards.find(issued.dashboardId)?.accountId).toBe("anak");
        expect(dashboards.find(999999)).toBeUndefined();
    });

    it("memperbarui dashboard dengan validasi dan menghapusnya", () => {
        const dashboards = new DashboardRegistry();
        const issued = dashboards.issueAccessKey("root");

        dashboards.update("root", issued.dashboardId, {
            title: "Sensor Rumah",
            dashboardItems: [
                {
                    type: "text",
                    title: "Suhu",
                    icon: "thermostat",
                    updateInterval: 5,
                    deviceId: "device-1",
                    schemeId: 101,
                },
            ],
        });

        expect(dashboards.get("root", issued.dashboardId)).toMatchObject({
            title: "Sensor Rumah",
            dashboardItems: [{ title: "Suhu" }],
        });
        expect(() =>
            dashboards.update("root", issued.dashboardId, {
                dashboardItems: [{ type: "unknown" } as any],
            }),
        ).toThrow(/type tidak dikenal/);

        dashboards.remove("root", issued.dashboardId);
        expect(dashboards.listByAccount("root")).toEqual([]);
        expect(dashboards.find(issued.dashboardId)).toBeUndefined();
    });
});

describe("serialisasi", () => {
    it("round-trip mempertahankan dashboard, item, dan createdAt", () => {
        const dashboards = new DashboardRegistry();
        const issued = dashboards.issueAccessKey("root");
        dashboards.get("root", issued.dashboardId)!.dashboardItems.push({
            id: 1,
            type: "radialGauge",
            title: "Kelembapan",
            icon: "water_drop",
            updateInterval: 30,
            deviceId: "device-1",
            schemeId: 102,
        });
        const record = dashboards.toJSON()[0];
        record.createdAt = 1700000000000;

        const restored = DashboardRegistry.fromJSON(
            JSON.parse(JSON.stringify(dashboards.toJSON())),
        );
        expect(restored.get("root", issued.dashboardId)?.dashboardItems).toHaveLength(1);
        expect(restored.toJSON()[0].createdAt).toBe(1700000000000);
        expect(
            restored.verifyProof(
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
                portableDashboard: {
                    dashboardId: 1000,
                    title: "Rumah",
                    accessKeyHash: "a".repeat(64),
                    dashboardItems: [],
                },
                createdAt: 1,
            },
        ] as any;
        const restored = DashboardRegistry.fromJSON(legacyRecords);

        expect(restored.listByAccount("root")).toHaveLength(1);
        expect(restored.get("root", 1000)?.accessKeyHash).toBe("a".repeat(64));
        expect(Array.isArray(restored.toJSON()[0].portableDashboard)).toBe(true);
        expect(() =>
            DashboardRegistry.fromJSON([
                {
                    ...legacyRecords[0],
                    portableDashboard: [
                        { dashboardId: 1000, accessKey: "raw", dashboardItems: [] },
                    ],
                },
            ]),
        ).toThrow(/accessKey mentah/);
        expect(() =>
            DashboardRegistry.fromJSON([
                legacyRecords[0],
                { ...legacyRecords[0], accountId: "other" },
            ]),
        ).toThrow(/dashboardId duplikat/);
    });

    it("impor legacy tidak menggandakan dashboardId yang sudah ada", () => {
        const dashboards = new DashboardRegistry();
        const issued = dashboards.issueAccessKey("root");

        dashboards.importLegacy("root", {
            dashboardId: issued.dashboardId,
            title: "Duplikat",
            dashboardItems: [],
        });
        dashboards.importLegacy("root", {
            dashboardId: 2000,
            title: "Tambahan",
            dashboardItems: [],
        });

        expect(dashboards.listByAccount("root")).toHaveLength(2);
        expect(dashboards.get("root", issued.dashboardId)?.title).toBe(
            `Dashboard ${issued.dashboardId}`,
        );
        expect(dashboards.get("root", 2000)?.title).toBe("Tambahan");
    });
});
