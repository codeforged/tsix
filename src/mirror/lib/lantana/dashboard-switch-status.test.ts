import { describe, expect, it } from "vitest";
import { PortableDashboard, SensorReading } from "./lantana-core";
import { dashboardSwitchStatusUpdates } from "./dashboard-switch-status";

const dashboard: PortableDashboard = {
    dashboardId: 1,
    title: "Rumah",
    dashboardItems: [
        {
            type: "switch",
            title: "Lampu",
            icon: "lightbulb",
            updateInterval: 5,
            deviceId: "dev-1",
            schemeId: 105,
            commandPrefix: "RELAY_1",
        },
        {
            type: "switch",
            title: "Tanpa indikator",
            icon: "lightbulb",
            updateInterval: 5,
            deviceId: "dev-1",
            commandPrefix: "RELAY_2",
        },
        {
            type: "text",
            title: "Suhu",
            icon: "thermostat",
            updateInterval: 5,
            deviceId: "dev-1",
            schemeId: 101,
        },
    ],
};

const reading = (schemeId: number, value: SensorReading["value"]): SensorReading => ({
    schemeId,
    value,
    label: `Scheme ${schemeId}`,
    unit: "",
    ts: 1234,
});

describe("dashboardSwitchStatusUpdates", () => {
    it("matches switch items by device and scheme and preserves false status", () => {
        expect(
            dashboardSwitchStatusUpdates(
                dashboard,
                "dev-1",
                [reading(105, false), reading(101, 22)],
                9999,
            ),
        ).toEqual([
            {
                itemId: "0:dev-1:105",
                itemIndex: 0,
                value: false,
                updatedAt: 1234,
            },
        ]);
    });

    it("ignores non-boolean values and readings for other devices", () => {
        expect(
            dashboardSwitchStatusUpdates(
                dashboard,
                "dev-2",
                [reading(105, 2)],
                9999,
            ),
        ).toEqual([]);
    });

    it("does not produce status for schemes the dashboard account cannot query", () => {
        expect(
            dashboardSwitchStatusUpdates(
                dashboard,
                "dev-1",
                [reading(105, true)],
                9999,
                () => false,
            ),
        ).toEqual([]);
    });
});
