/**
 * monitor-view.ts — Model tampilan monitor device (setara lantana-dashboard).
 *
 * Mengubah daftar device + bacaan terakhir menjadi baris siap-render: judul,
 * metadata, baris sensor, status, dan umur data. Dipisah dari GUI supaya
 * pengelompokan dan format angkanya bisa diuji tanpa membuka window.
 *
 * (c) 2026 TSIX Project
 */

export interface MonitorReading {
    schemeId: number;
    label?: string;
    unit?: string;
    value: unknown;
}

export interface MonitorDevice {
    accountId: string;
    deviceId: string;
    name?: string;
    category?: string;
    group?: string;
    city?: string;
    status?: string;
    dataAgeMs?: number;
    schemeIds?: number[];
}

export interface MonitorDeviceView {
    key: string;
    title: string;
    meta: string;
    sensors: string;
    status: string;
    statusColor: string;
    age: string;
}

export interface MonitorGroupView {
    group: string;
    devices: MonitorDeviceView[];
}

export const MONITOR_EMPTY = "Menunggu data dari daemon Lantana...";

export function monitorLayoutKey(groups: readonly MonitorGroupView[]): string {
    return JSON.stringify(
        groups.map((group) => [
            group.group,
            group.devices.map((device) => device.key),
        ]),
    );
}

export function deviceKey(accountId: string, deviceId: string): string {
    return `${accountId}::${deviceId}`;
}

export function statusColor(status: string): string {
    if (status === "ONLINE") return "#4caf50";
    if (status === "STALE") return "#ff9800";
    return "#f44336";
}

export function ageText(dataAgeMs: number | undefined): string {
    if (dataAgeMs === undefined || !Number.isFinite(dataAgeMs) || dataAgeMs < 0) {
        return "—";
    }
    return `${(dataAgeMs / 1000).toFixed(1)}s ago`;
}

/** `101=20 °C  102=31 %`, atau daftar scheme bila bacaan belum ada. */
export function formatSensors(
    readings: readonly MonitorReading[] | undefined,
    schemeIds: readonly number[] | undefined,
): string {
    if (readings?.length) {
        return readings
            .map(
                (reading) =>
                    `${reading.schemeId}=${reading.value ?? "—"}${
                        reading.unit ? ` ${reading.unit}` : ""
                    }`,
            )
            .join("  ");
    }
    if (schemeIds?.length) return `scheme: ${schemeIds.join(", ")}`;
    return "—";
}

/** Baris metadata device, hanya bagian yang terisi. */
export function deviceMeta(device: MonitorDevice): string {
    const parts = [`akun: ${device.accountId}`];
    if (device.category) parts.push(`cat: ${device.category}`);
    if (device.city) parts.push(device.city);
    if (device.group) parts.push(`grp: ${device.group}`);
    return parts.join(" · ");
}

/**
 * Kelompokkan device per `group` (fallback "Ungrouped"), grup terakhir setelah
 * grup bernama, dan urutkan device berdasarkan nama.
 */
export function groupMonitorDevices(
    devices: Iterable<MonitorDevice>,
    readings: ReadonlyMap<string, readonly MonitorReading[]>,
): MonitorGroupView[] {
    const grouped = new Map<string, MonitorDeviceView[]>();

    for (const device of devices) {
        const key = deviceKey(device.accountId, device.deviceId);
        const status = device.status ?? "OFFLINE";
        const view: MonitorDeviceView = {
            key,
            title: `${device.name?.trim() || device.deviceId} (${device.deviceId})`,
            meta: deviceMeta(device),
            sensors: formatSensors(readings.get(key), device.schemeIds),
            status,
            statusColor: statusColor(status),
            age: ageText(device.dataAgeMs),
        };
        const groupName = device.group?.trim() || "Ungrouped";
        const list = grouped.get(groupName);
        if (list) list.push(view);
        else grouped.set(groupName, [view]);
    }

    return [...grouped.entries()]
        .sort(([left], [right]) =>
            left === "Ungrouped"
                ? 1
                : right === "Ungrouped"
                  ? -1
                  : left.localeCompare(right),
        )
        .map(([group, views]) => ({
            group,
            devices: views.sort((a, b) => a.title.localeCompare(b.title)),
        }));
}

/** Gabungkan bacaan baru ke daftar lama berdasarkan schemeId. */
export function mergeReadings(
    previous: readonly MonitorReading[] | undefined,
    incoming: readonly MonitorReading[],
): MonitorReading[] {
    const merged = new Map<number, MonitorReading>();
    for (const reading of previous ?? []) merged.set(reading.schemeId, reading);
    for (const reading of incoming) merged.set(reading.schemeId, reading);
    return [...merged.values()].sort((a, b) => a.schemeId - b.schemeId);
}
