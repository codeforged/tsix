import { describe, expect, it } from "vitest";
import {
    buildControlTree,
    deviceTitle,
    findPayload,
    nodeIdOf,
    type AccountView,
    type ControlTreeData,
    type SchemeView,
} from "./control-panel-tree";

function account(accountId: string, parentId: string | null = null): AccountView {
    return {
        accountId,
        parentId,
        permissions: {
            allowedInjectSchemes: [],
            allowedQuerySchemes: [],
            allowedCommandDevices: [],
        },
        hasAccessKey: true,
        children: 0,
        dashboards: [],
    };
}

function scheme(
    schemeId: number,
    ownerAccountId: string,
    label: string,
    unit?: string,
): SchemeView {
    return { schemeId, ownerAccountId, label, unit, type: "number" };
}

function makeData(): ControlTreeData {
    return {
        accounts: [account("juragan"), account("anak", "juragan"), account("tetangga")],
        devices: [
            {
                accountId: "juragan",
                deviceId: "7f352db1-c787-4976-b441-d1bf7387fe49",
                meta: { name: "Sensor A", city: "Bandung" },
            },
            {
                accountId: "tetangga",
                deviceId: "aaaa1111-bbbb-cccc-dddd-eeeeffff0000",
                meta: {},
            },
        ],
        schemes: [
            scheme(102, "juragan", "Kelembaban", "%"),
            scheme(101, "juragan", "Suhu", "°C"),
        ],
        dashboards: [
            {
                accountId: "juragan",
                dashboardId: 1000,
                title: "Sensor Rumah",
                hasAccessKey: true,
                dashboardItems: [
                    {
                        type: "text",
                        title: "Suhu Ruangan",
                        icon: "thermostat",
                        updateInterval: 5,
                        deviceId: "7f352db1-c787-4976-b441-d1bf7387fe49",
                        schemeId: 101,
                    },
                    {
                        type: "lineChart",
                        title: "Tekanan",
                        icon: "bolt",
                        updateInterval: 5,
                        scrollAfter: 7,
                        deviceId: "7f352db1-c787-4976-b441-d1bf7387fe49",
                        schemeId: 103,
                    },
                ],
            },
        ],
    };
}

describe("buildControlTree", () => {
    it("menyusun akun → grup → entri → item dashboard", () => {
        const nodes = buildControlTree(makeData());

        expect(nodes.map((node) => node.id)).toEqual([
            "server",
            "acc:juragan",
            "acc:tetangga",
        ]);

        const juragan = nodes[1];
        expect(juragan.expanded).toBe(true);
        expect(juragan.children?.map((child) => child.id)).toEqual([
            "grp:juragan:devices",
            "grp:juragan:schemes",
            "grp:juragan:dashboards",
            "acc:anak",
        ]);

        const devices = juragan.children?.[0];
        expect(devices?.label).toBe("Device (1)");
        expect(devices?.children?.[0]).toMatchObject({
            id: "dev:juragan:7f352db1-c787-4976-b441-d1bf7387fe49",
            label: "Sensor A",
            hint: "Bandung",
        });

        const schemes = juragan.children?.[1];
        expect(schemes?.label).toBe("Scheme (2)");
        expect(schemes?.children?.map((child) => child.label)).toEqual([
            "101 · Suhu",
            "102 · Kelembaban",
        ]);

        const dashboards = juragan.children?.[2];
        expect(dashboards?.label).toBe("Portable Dashboard (1)");
        const dashboard = dashboards?.children?.[0];
        expect(dashboard).toMatchObject({
            id: "dash:juragan:1000",
            label: "Sensor Rumah",
            hint: "2 item",
        });
        expect(dashboard?.children?.map((child) => child.id)).toEqual([
            "item:juragan:1000:0",
            "item:juragan:1000:1",
        ]);

        // Akun tetangga tidak melihat device/scheme/dashboard milik juragan.
        const tetangga = nodes[2];
        expect(tetangga.children?.[0].label).toBe("Device (1)");
        expect(tetangga.children?.[1].label).toBe("Scheme (0)");
        expect(tetangga.children?.[2].label).toBe("Portable Dashboard (0)");
    });

    it("menampilkan akun yang parent-nya hilang sebagai akun root", () => {
        const nodes = buildControlTree({
            accounts: [account("root"), account("yatim", "tidak-ada")],
            devices: [],
            schemes: [],
            dashboards: [],
        });

        expect(nodes.map((node) => node.id)).toEqual([
            "server",
            "acc:root",
            "acc:yatim",
        ]);
    });
});

describe("payload pohon", () => {
    it("mengembalikan data yang tepat untuk setiap baris", () => {
        const nodes = buildControlTree(makeData());

        expect(findPayload(nodes, "acc:juragan")).toMatchObject({
            kind: "account",
            account: { accountId: "juragan" },
        });
        expect(findPayload(nodes, "grp:juragan:schemes")).toMatchObject({
            kind: "group",
            group: "schemes",
        });
        expect(findPayload(nodes, "sch:juragan:101")).toMatchObject({
            kind: "scheme",
            scheme: { schemeId: 101 },
        });
        expect(findPayload(nodes, "dash:juragan:1000")).toMatchObject({
            kind: "dashboard",
            dashboard: { dashboardId: 1000 },
        });
        expect(findPayload(nodes, "item:juragan:1000:1")).toMatchObject({
            kind: "item",
            itemIndex: 1,
            item: { title: "Tekanan" },
        });
        expect(findPayload(nodes, "tidak-ada")).toBeNull();
    });

    it("bolak-balik id ↔ payload untuk semua jenis entri", () => {
        const nodes = buildControlTree(makeData());
        for (const id of [
            "server",
            "acc:juragan",
            "grp:juragan:devices",
            "dev:juragan:7f352db1-c787-4976-b441-d1bf7387fe49",
            "sch:juragan:101",
            "dash:juragan:1000",
            "item:juragan:1000:0",
        ]) {
            const payload = findPayload(nodes, id);
            expect(payload, id).not.toBeNull();
            expect(nodeIdOf(payload!), id).toBe(id);
        }
    });

    it("memakai nama device atau potongan device ID", () => {
        expect(
            deviceTitle({
                accountId: "a",
                deviceId: "7f352db1-c787",
                meta: { name: "Sensor A" },
            }),
        ).toBe("Sensor A");
        expect(
            deviceTitle({ accountId: "a", deviceId: "7f352db1-c787", meta: {} }),
        ).toBe("7f352db1");
    });
});
