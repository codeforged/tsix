/**
 * lantana-store.test.ts — Perilaku saat file state belum ada / rusak.
 *
 * `fs` dimock dengan perilaku VFS: readFile melempar bila file tidak ada.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const disk = new Map<string, string>();
const modes = new Map<string, number>();

vi.mock("@tsix/Application", () => {
    const fs = {
        mkdir: async () => true,
        chmod: async (path: string, mode: number) => {
            modes.set(path, mode);
            return true;
        },
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
    LANTANA_PSK_PATH,
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

describe("SEC-15: PSK terpisah + file state 0600", () => {
    beforeEach(() => {
        disk.clear();
        modes.clear();
    });

    it("PSK ditulis ke file terpisah, bukan accounts.json; semua file state 0600", async () => {
        const state = await loadState();
        state.accounts.createRoot("juragan");
        state.accounts.issueAccessKey("juragan");
        const psk = state.accounts.getPsk("juragan")!.toString("hex");

        await saveState(state);

        expect(disk.get(LANTANA_ACCOUNTS_PATH)).not.toContain(psk);
        expect(JSON.parse(disk.get(LANTANA_PSK_PATH)!)).toEqual({ juragan: psk });
        for (const p of [
            LANTANA_ACCOUNTS_PATH,
            LANTANA_DASHBOARDS_PATH,
            LANTANA_DEVICES_PATH,
            LANTANA_SCHEMES_PATH,
            LANTANA_PSK_PATH,
        ]) {
            expect(modes.get(p), p).toBe(0o600);
        }

        const again = await loadState();
        expect(again.accounts.getPsk("juragan")!.toString("hex")).toBe(psk);
    });

    it("accounts.json lama yang memuat PSK dimigrasikan saat load", async () => {
        const psk = "cd".repeat(32);
        disk.set(
            LANTANA_ACCOUNTS_PATH,
            JSON.stringify([
                {
                    accountId: "juragan",
                    parentId: null,
                    permissions: {},
                    credential: { salt: "00", hash: "11", psk, issuedAt: 1 },
                    createdAt: 1,
                },
            ]),
        );

        const state = await loadState();

        expect(state.accounts.getPsk("juragan")!.toString("hex")).toBe(psk);
        expect(disk.get(LANTANA_ACCOUNTS_PATH)).not.toContain(psk);
        expect(JSON.parse(disk.get(LANTANA_PSK_PATH)!)).toEqual({ juragan: psk });
        expect(modes.get(LANTANA_ACCOUNTS_PATH)).toBe(0o600);
    });

    it("file yang sudah ada tetap di-chmod 0600 saat load", async () => {
        disk.set(LANTANA_ACCOUNTS_PATH, "[]\n");
        await loadState();
        expect(modes.get(LANTANA_ACCOUNTS_PATH)).toBe(0o600);
    });

    it("psk.json rusak dilaporkan dengan jelas", async () => {
        disk.set(LANTANA_PSK_PATH, "{rusak");
        await expect(loadState()).rejects.toThrow(/psk\.json/);
    });
});
