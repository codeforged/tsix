/**
 * lantana-store.test.ts — Perilaku saat file state belum ada / rusak.
 *
 * `fs` dimock dengan perilaku VFS: readFile melempar bila file tidak ada.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const disk = new Map<string, string>();

vi.mock("@tsix/Application", () => {
    const fs = {
        mkdir: async () => true,
        readFile: async (path: string) => {
            if (!disk.has(path)) throw new Error(`File not found: ${path}`);
            return disk.get(path)!;
        },
        writeFile: async (path: string, content: string) => {
            disk.set(path, content);
            return true;
        },
    };
    return { fs };
});

import { loadState, saveState } from "./lantana-store";
import { LantanaStoreError } from "./lantana-store";
import {
    LANTANA_ACCOUNTS_PATH,
    LANTANA_DASHBOARDS_PATH,
    LANTANA_DEVICES_PATH,
    LANTANA_SCHEMES_PATH,
} from "./lantana-core";

describe("loadState", () => {
    beforeEach(() => disk.clear());

    it("membuat file kosong bila belum ada, bukan crash", async () => {
        const state = await loadState();

        expect(state.accounts.list()).toEqual([]);
        expect(state.dashboards.list()).toEqual([]);
        expect(state.devices.size).toBe(0);
        expect(state.schemes.list()).toEqual([]);
        expect(disk.get(LANTANA_ACCOUNTS_PATH)).toBe("[]\n");
        expect(disk.get(LANTANA_DASHBOARDS_PATH)).toBe("[]\n");
        expect(disk.get(LANTANA_DEVICES_PATH)).toBe("[]\n");
        expect(disk.get(LANTANA_SCHEMES_PATH)).toBe("[]\n");
    });

    it("membaca state yang sudah ada", async () => {
        disk.set(
            LANTANA_ACCOUNTS_PATH,
            JSON.stringify([
                {
                    accountId: "root",
                    parentId: null,
                    permissions: {
                        allowedInjectSchemes: [101],
                        allowedQuerySchemes: [],
                        allowedCommandDevices: [],
                    },
                    credential: null,
                    createdAt: 1,
                },
            ]),
        );

        const state = await loadState();
        expect(state.accounts.get("root")!.permissions.allowedInjectSchemes).toEqual([101]);
    });

    it("membaca dashboard dari file terpisah", async () => {
        disk.set(
            LANTANA_DASHBOARDS_PATH,
            JSON.stringify([
                {
                    accountId: "root",
                    portableDashboard: [
                        {
                            dashboardId: 1000,
                            title: "Sensor Rumah",
                            accessKeyHash: "a".repeat(64),
                            dashboardItems: [],
                        },
                    ],
                    createdAt: 1,
                },
            ]),
        );

        const state = await loadState();
        expect(state.dashboards.get("root", 1000)?.title).toBe("Sensor Rumah");
        expect(JSON.stringify(state.accounts.toJSON())).not.toContain("portableDashboard");
    });

    it("memindahkan portableDashboard lama dari accounts.json ke dashboard.json", async () => {
        disk.set(
            LANTANA_ACCOUNTS_PATH,
            JSON.stringify([
                {
                    accountId: "root",
                    parentId: null,
                    permissions: {},
                    credential: null,
                    portableDashboard: {
                        dashboardId: 1000,
                        accessKeyHash: "a".repeat(64),
                        dashboardItems: [],
                    },
                    createdAt: 1,
                },
            ]),
        );

        const state = await loadState();
        const savedAccount = JSON.parse(disk.get(LANTANA_ACCOUNTS_PATH)!)[0];
        const savedDashboards = JSON.parse(disk.get(LANTANA_DASHBOARDS_PATH)!);

        expect(state.dashboards.listByAccount("root")).toHaveLength(1);
        expect(savedAccount.portableDashboard).toBeUndefined();
        expect(savedDashboards[0].accountId).toBe("root");
        expect(savedDashboards[0].portableDashboard[0].accessKeyHash).toBe("a".repeat(64));
    });

    it("melaporkan file rusak dengan jelas", async () => {
        disk.set(LANTANA_ACCOUNTS_PATH, "{bukan json");
        await expect(loadState()).rejects.toThrow(LantanaStoreError);
    });

    it("melaporkan dashboard.json rusak dengan jelas", async () => {
        disk.set(LANTANA_DASHBOARDS_PATH, "{bukan json");
        await expect(loadState()).rejects.toThrow(/dashboard\.json/);
    });

    it("tidak menimpa file yang sudah ada", async () => {
        disk.set(LANTANA_DEVICES_PATH, "[]\n");
        await loadState();
        expect(disk.get(LANTANA_DEVICES_PATH)).toBe("[]\n");
    });
});

describe("saveState", () => {
    beforeEach(() => disk.clear());

    it("menulis keempat file state", async () => {
        const state = await loadState();
        state.accounts.createRoot("root");
        state.dashboards.issueAccessKey("root");
        state.devices.register("root", { name: "Dev" });
        state.schemes.add({
            schemeId: 101,
            ownerAccountId: "root",
            label: "Suhu",
            type: "number",
        });

        await saveState(state);

        expect(JSON.parse(disk.get(LANTANA_ACCOUNTS_PATH)!)[0].accountId).toBe("root");
        expect(JSON.parse(disk.get(LANTANA_DASHBOARDS_PATH)!)[0].accountId).toBe("root");
        expect(JSON.parse(disk.get(LANTANA_DEVICES_PATH)!)).toHaveLength(1);
        expect(JSON.parse(disk.get(LANTANA_SCHEMES_PATH)!)[0].schemeId).toBe(101);
    });
});
