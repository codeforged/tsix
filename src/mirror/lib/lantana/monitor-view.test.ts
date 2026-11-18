import { describe, expect, it } from "vitest";
import {
    ageText,
    formatSensors,
    groupMonitorDevices,
    mergeReadings,
    statusColor,
    type MonitorDevice,
} from "./monitor-view";

function device(overrides: Partial<MonitorDevice> = {}): MonitorDevice {
    return {
        accountId: "juragan",
        deviceId: "7f352db1-c787-4976-b441-d1bf7387fe49",
        name: "ESP32 Kebun",
        category: "generic",
        group: "kebun",
        city: "Bandung",
        status: "ONLINE",
        dataAgeMs: 0,
        schemeIds: [101],
        ...overrides,
    };
}

describe("formatSensors", () => {
    it("menampilkan nilai beserta unit", () => {
        expect(
            formatSensors(
                [
                    { schemeId: 101, value: 20, unit: "°C" },
                    { schemeId: 102, value: 31, unit: "%" },
                ],
                [],
            ),
        ).toBe("101=20 °C  102=31 %");
    });

    it("jatuh ke daftar scheme bila bacaan belum ada", () => {
        expect(formatSensors(undefined, [101, 102])).toBe("scheme: 101, 102");
        expect(formatSensors([], [])).toBe("—");
    });
});

describe("ageText dan statusColor", () => {
    it("memformat umur data dalam detik", () => {
        expect(ageText(0)).toBe("0.0s ago");
        expect(ageText(1500)).toBe("1.5s ago");
        expect(ageText(undefined)).toBe("—");
        expect(ageText(-1)).toBe("—");
    });

    it("memetakan status ke warna", () => {
        expect(statusColor("ONLINE")).toBe("#4caf50");
        expect(statusColor("STALE")).toBe("#ff9800");
        expect(statusColor("OFFLINE")).toBe("#f44336");
        expect(statusColor("APA")).toBe("#f44336");
    });
});

describe("groupMonitorDevices", () => {
    it("mengelompokkan device dan menaruh Ungrouped di akhir", () => {
        const readings = new Map([
            ["juragan::dev-1", [{ schemeId: 101, value: 22, unit: "°C" }]],
        ]);
        const groups = groupMonitorDevices(
            [
                device({ deviceId: "dev-1", name: "Sensor B", group: "kebun" }),
                device({ deviceId: "dev-2", name: "Sensor A", group: "kebun" }),
                device({ deviceId: "dev-3", name: "Tanpa Grup", group: undefined }),
            ],
            readings,
        );

        expect(groups.map((group) => group.group)).toEqual(["kebun", "Ungrouped"]);
        expect(groups[0].devices.map((entry) => entry.title)).toEqual([
            "Sensor A (dev-2)",
            "Sensor B (dev-1)",
        ]);
        const sensorB = groups[0].devices.find((entry) => entry.title.includes("dev-1"));
        expect(sensorB?.sensors).toBe("101=22 °C");
        expect(sensorB?.meta).toBe("akun: juragan · cat: generic · Bandung · grp: kebun");
        expect(sensorB?.status).toBe("ONLINE");
        expect(sensorB?.age).toBe("0.0s ago");
    });

    it("memakai deviceId saat nama kosong dan status default OFFLINE", () => {
        const groups = groupMonitorDevices(
            [device({ deviceId: "dev-9", name: "  ", status: undefined })],
            new Map(),
        );

        expect(groups[0].devices[0].title).toBe("dev-9 (dev-9)");
        expect(groups[0].devices[0].status).toBe("OFFLINE");
        expect(groups[0].devices[0].sensors).toBe("scheme: 101");
    });
});

describe("mergeReadings", () => {
    it("menggabungkan bacaan lama dan baru per schemeId", () => {
        const merged = mergeReadings(
            [
                { schemeId: 102, value: 30, unit: "%" },
                { schemeId: 101, value: 20, unit: "°C" },
            ],
            [
                { schemeId: 101, value: 25, unit: "°C" },
                { schemeId: 103, value: 965, unit: "hPa" },
            ],
        );

        expect(merged).toEqual([
            { schemeId: 101, value: 25, unit: "°C" },
            { schemeId: 102, value: 30, unit: "%" },
            { schemeId: 103, value: 965, unit: "hPa" },
        ]);
    });
});
