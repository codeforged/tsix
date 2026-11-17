/**
 * lantana-device-bank.test.ts — State terkini, heartbeat, endpoint command.
 */

import { describe, it, expect } from "vitest";
import { DeviceBank } from "./lantana-device-bank";
import { AcceptedReading } from "./lantana-core";

const reading = (schemeId: number, value: number): AcceptedReading => ({
    readingId: `r-${schemeId}`,
    accountId: "acc",
    deviceId: "dev-1",
    schemeId,
    value,
    label: `S${schemeId}`,
    unit: "",
    receivedAt: 1000,
});

describe("DeviceBank", () => {
    it("menyimpan bacaan terbaru per scheme", () => {
        const bank = new DeviceBank();
        bank.upsert("acc", "dev-1", { name: "Satu" }, [reading(101, 25)], { address: "10.0.0.1", port: 4000 }, 1000);
        bank.upsert("acc", "dev-1", { name: "Satu" }, [reading(101, 30), reading(102, 60)], { address: "10.0.0.1", port: 4000 }, 2000);

        const readings = bank.getReadings("acc", "dev-1");
        expect(readings.map((r) => [r.schemeId, r.value])).toEqual([
            [101, 30],
            [102, 60],
        ]);
    });

    it("memisahkan device dengan deviceId sama di akun berbeda", () => {
        const bank = new DeviceBank();
        bank.upsert("acc-a", "dev-1", {}, [reading(101, 10)], { address: "a", port: 1 }, 1000);
        bank.upsert("acc-b", "dev-1", {}, [reading(101, 99)], { address: "b", port: 2 }, 1000);

        expect(bank.size).toBe(2);
        expect(bank.getReadings("acc-a", "dev-1")[0].value).toBe(10);
        expect(bank.getReadings("acc-b", "dev-1")[0].value).toBe(99);
    });

    it("menyimpan endpoint terakhir untuk command balik", () => {
        const bank = new DeviceBank();
        bank.upsert("acc", "dev-1", {}, [reading(101, 1)], { address: "10.0.0.5", port: 4100 }, 1000);
        expect(bank.getEndpoint("acc", "dev-1")).toEqual({ address: "10.0.0.5", port: 4100 });
        expect(bank.getEndpoint("acc", "tidak-ada")).toBeNull();
    });

    it("menghitung status heartbeat dari umur data", () => {
        const bank = new DeviceBank();
        expect(bank.computeStatus(0, 10_000)).toBe("ONLINE");
        expect(bank.computeStatus(0, 30_000)).toBe("STALE");
        expect(bank.computeStatus(0, 120_000)).toBe("OFFLINE");
    });

    it("memakai metadata registry untuk nama/kota/grup", () => {
        const bank = new DeviceBank();
        bank.upsert(
            "acc",
            "dev-1",
            { name: "Sensor Bandung", city: "Bandung", group: "jabar" },
            [reading(101, 1)],
            { address: "a", port: 1 },
            1000,
        );
        const [dev] = bank.listDevices(1000, "acc");
        expect(dev).toMatchObject({
            accountId: "acc",
            deviceId: "dev-1",
            name: "Sensor Bandung",
            city: "Bandung",
            group: "jabar",
            status: "ONLINE",
            schemeIds: [101],
        });
    });

    it("listDevices memfilter per akun", () => {
        const bank = new DeviceBank();
        bank.upsert("acc-a", "d1", {}, [reading(101, 1)], { address: "a", port: 1 }, 1000);
        bank.upsert("acc-b", "d2", {}, [reading(101, 1)], { address: "b", port: 2 }, 1000);

        expect(bank.listDevices(1000)).toHaveLength(2);
        expect(bank.listDevices(1000, "acc-a").map((d) => d.deviceId)).toEqual(["d1"]);
    });

    it("getQueryableReadings menyaring sesuai policy", () => {
        const bank = new DeviceBank();
        bank.upsert("acc", "dev", {}, [reading(101, 1), reading(203, 2)], { address: "a", port: 1 }, 1000);

        const filtered = bank.getQueryableReadings("acc", "dev", (id) => id === 101);
        expect(filtered.map((r) => r.schemeId)).toEqual([101]);
    });
});
