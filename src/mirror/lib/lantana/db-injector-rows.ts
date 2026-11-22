/**
 * db-injector-rows.ts — Ubah bacaan Lantana menjadi baris `sensor_readings`.
 *
 * Dipisah dari lantana-db-injector supaya pemetaan dan query-nya bisa diuji
 * tanpa runtime. Identitas akun/device diambil dari batch (bukan dari tiap
 * bacaan, karena `SensorReading` tidak membawanya).
 *
 * Nilai SELALU dikirim sebagai parameter prepared statement: bacaan bertipe
 * string berasal dari device, jadi tidak boleh disisipkan ke teks SQL.
 *
 * (c) 2026 TSIX Project — Lantana
 */

import type { SensorReading } from "@tsix/lantana/lantana-core";

export const INSERT_SENSOR_READING_SQL =
    "INSERT INTO sensor_readings " +
    "(reading_id, account_id, device_id, scheme_id, label, unit, value, received_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON DUPLICATE KEY UPDATE reading_id = reading_id";

export type SensorReadingRow = [
    readingId: string,
    accountId: string,
    deviceId: string,
    schemeId: number,
    label: string,
    unit: string,
    value: string,
    receivedAt: string,
];

/** `YYYY-MM-DD HH:MM:SS` (UTC) untuk kolom DATETIME. */
export function toSqlDatetime(ms: number): string {
    return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

export interface RowsResult {
    rows: SensorReadingRow[];
    /** Bacaan tanpa readingId — tidak bisa ditulis idempoten, jadi dilewati. */
    skipped: number;
}

export function sensorReadingRows(
    accountId: string,
    deviceId: string,
    readings: readonly SensorReading[],
): RowsResult {
    const rows: SensorReadingRow[] = [];
    let skipped = 0;
    for (const r of readings) {
        if (typeof r?.readingId !== "string" || !r.readingId) {
            skipped++;
            continue;
        }
        rows.push([
            r.readingId,
            accountId,
            deviceId,
            Number(r.schemeId),
            String(r.label ?? ""),
            String(r.unit ?? ""),
            String(r.value),
            toSqlDatetime(Number.isFinite(r.ts) ? r.ts : Date.now()),
        ]);
    }
    return { rows, skipped };
}
