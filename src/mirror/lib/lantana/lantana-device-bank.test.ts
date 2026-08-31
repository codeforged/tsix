/**
 * lantana-device-bank.test.ts — Unit test untuk Lantana Device Bank
 *
 * Menguji:
 *  - resolveGroup: pengelompokan device per tenant (deviceGroupMap)
 *  - kategori & grup diterapkan saat upsert (device baru vs lama)
 *  - listDevices meneruskan group ke DeviceStatusInfo
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DeviceBank } from "./lantana-device-bank";

// Mock penuh modul core — TIDAK memuat @tsix/Application (fs VFS) agar test
// bisa jalan tanpa runtime TSIX. Sediakan hanya simbol yang dipakai DeviceBank.
vi.mock("@tsix/lantana/lantana-core", () => {
    return {
        DEVICE_STALE_MS: 15000,
        DEVICE_OFFLINE_MS: 60000,
        loadConfig: vi.fn(async () => ({
            ports: {},
            deviceCategories: {
                esp: { label: "ESP", icon: "🔧" },
                generic: { label: "Generic Device", icon: "📡" },
            },
            sensorCategories: {
                temp: { label: "Temperature", unit: "°C" },
                generic: { label: "Sensor", unit: "" },
            },
            deviceGroupMap: {
                "Juragan Sensor": {
                    "esp8266-dev-01": "client-a",
                    "esp8266-dev-02": "client-a",
                    "esp8266-dev-03": "client-b",
                },
            },
        })),
    };
});

const upsert = (
    bank: DeviceBank,
    nodeId: string,
    tenant: string = "Juragan Sensor",
    port: number = 1001,
    sensors: { id: string; value: number }[] = [{ id: "01", value: 25 }],
) =>
    bank.upsert(nodeId, tenant, port, "plain", sensors, Date.now(), nodeId, 100);

describe("DeviceBank group (deviceGroupMap)", () => {
    let bank: DeviceBank;

    beforeEach(async () => {
        bank = new DeviceBank();
        await bank.init();
    });

    it("memberi group sesuai deviceGroupMap saat device baru di-upsert", async () => {
        const dev = upsert(bank, "esp8266-dev-01");
        expect(dev.group).toBe("client-a");
        const dev2 = upsert(bank, "esp8266-dev-03");
        expect(dev2.group).toBe("client-b");
    });

    it("tidak memberi group untuk node yang tidak terdaftar di deviceGroupMap", async () => {
        const dev = upsert(bank, "esp32-999");
        expect(dev.group).toBeUndefined();
    });

    it("kategori device tetap berjalan normal (tidak terganggu group)", async () => {
        const dev = upsert(bank, "esp8266-dev-01");
        expect(dev.category).toBe("esp"); // heuristic: mengandung "esp"
        expect(dev.group).toBe("client-a");
    });

    it("listDevices meneruskan group ke DeviceStatusInfo", async () => {
        upsert(bank, "esp8266-dev-01");
        upsert(bank, "esp8266-dev-02");
        const devices = bank.listDevices(Date.now());
        const byNode = Object.fromEntries(devices.map((d) => [d.nodeId, d.group]));
        expect(byNode["esp8266-dev-01"]).toBe("client-a");
        expect(byNode["esp8266-dev-02"]).toBe("client-a");
    });
});

describe("DeviceBank kategori (tidak regresi)", () => {
    let bank: DeviceBank;

    beforeEach(async () => {
        bank = new DeviceBank();
        await bank.init();
    });

    it("infer kategori dari nodeId (fallback generic)", async () => {
        const dev = upsert(bank, "esp32-01");
        expect(dev.category).toBe("esp");
        const gen = upsert(bank, "something-else");
        expect(gen.category).toBe("generic");
    });
});

describe("DeviceBank multi-tenant (nodeId sama, tenant beda)", () => {
    let bank: DeviceBank;

    beforeEach(async () => {
        bank = new DeviceBank();
        await bank.init();
    });

    it("tidak konflik: nodeId yang sama di tenant berbeda jadi entri terpisah", async () => {
        upsert(bank, "dev-01", "Juragan Sensor", 1001, [{ id: "01", value: 25 }]);
        upsert(bank, "dev-01", "Tenant Lain", 1002, [{ id: "01", value: 99 }]);

        expect(bank.size).toBe(2);

        const a = bank.getDevice("dev-01", "Juragan Sensor")!;
        const b = bank.getDevice("dev-01", "Tenant Lain")!;
        expect(a.tenant).toBe("Juragan Sensor");
        expect(b.tenant).toBe("Tenant Lain");
        expect(a.sensors.get("01")!.value).toBe(25);
        expect(b.sensors.get("01")!.value).toBe(99);
    });

    it("group per tenant tidak saling timpa", async () => {
        upsert(bank, "esp8266-dev-01", "Juragan Sensor");
        upsert(bank, "esp8266-dev-01", "Tenant Lain");
        expect(bank.getDevice("esp8266-dev-01", "Juragan Sensor")!.group).toBe("client-a");
        expect(bank.getDevice("esp8266-dev-01", "Tenant Lain")!.group).toBeUndefined();
    });

    it("listDevices menampilkan keduanya", async () => {
        upsert(bank, "dev-01", "Juragan Sensor");
        upsert(bank, "dev-01", "Tenant Lain");
        const devices = bank.listDevices(Date.now());
        const pairs = devices.map((d) => `${d.tenant}::${d.nodeId}`);
        expect(pairs).toContain("Juragan Sensor::dev-01");
        expect(pairs).toContain("Tenant Lain::dev-01");
        expect(devices).toHaveLength(2);
    });
});
