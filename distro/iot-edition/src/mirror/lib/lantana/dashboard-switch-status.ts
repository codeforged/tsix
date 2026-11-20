import { PortableDashboard, ReadingValue } from "@tsix/lantana/lantana-core";

type SwitchReading = { schemeId: number; value: ReadingValue; ts: number };

export interface DashboardSwitchStatusUpdate {
    itemId: string;
    itemIndex: number;
    value: boolean;
    updatedAt: number;
}

export function dashboardSwitchStatusUpdates(
    dashboard: PortableDashboard,
    deviceId: string,
    readings: readonly SwitchReading[],
    fallbackUpdatedAt: number,
    canRead: (schemeId: number) => boolean = () => true,
): DashboardSwitchStatusUpdate[] {
    const readingsByScheme = new Map(readings.map((reading) => [reading.schemeId, reading]));
    const updates: DashboardSwitchStatusUpdate[] = [];

    dashboard.dashboardItems.forEach((item, itemIndex) => {
        if (
            item.type !== "switch" ||
            item.deviceId !== deviceId ||
            item.schemeId === undefined ||
            !canRead(item.schemeId)
        ) {
            return;
        }
        const reading = readingsByScheme.get(item.schemeId);
        if (!reading) return;

        const value =
            typeof reading.value === "boolean"
                ? reading.value
                : reading.value === 1
                  ? true
                  : reading.value === 0
                    ? false
                    : null;
        if (value === null) return;

        updates.push({
            itemId: String(item.id ?? `${itemIndex}:${item.deviceId}:${item.schemeId}`),
            itemIndex,
            value,
            updatedAt: Number.isFinite(reading.ts) ? reading.ts : fallbackUpdatedAt,
        });
    });

    return updates;
}
