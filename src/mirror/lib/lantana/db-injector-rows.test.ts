import { describe, it, expect } from "vitest";
import {
    INSERT_SENSOR_READING_SQL,
    sensorReadingRows,
    toSqlDatetime,
} from "./db-injector-rows";

const TS = Date.UTC(2026, 10, 23, 5, 30, 15);

describe("sensorReadingRows", () => {
    it("mengisi akun/device dari batch dan readingId dari bacaan", () => {
        const { rows, skipped } = sensorReadingRows("juragan", "dev-1", [
            { readingId: "r-1", schemeId: 101, value: 23.5, label: "Suhu", unit: "°C", ts: TS },
            { readingId: "r-2", schemeId: 102, value: true, label: "Pompa", unit: "", ts: TS },
        ]);

        expect(skipped).toBe(0);
        expect(rows).toEqual([
            ["r-1", "juragan", "dev-1", 101, "Suhu", "°C", "23.5", "2026-11-23 05:30:15"],
            ["r-2", "juragan", "dev-1", 102, "Pompa", "", "true", "2026-11-23 05:30:15"],
        ]);
    });

    it("melewati bacaan tanpa readingId (tidak bisa ditulis idempoten)", () => {
        const { rows, skipped } = sensorReadingRows("juragan", "dev-1", [
            { schemeId: 101, value: 1, label: "A", unit: "", ts: TS },
            { readingId: "", schemeId: 102, value: 2, label: "B", unit: "", ts: TS },
            { readingId: "r-3", schemeId: 103, value: 3, label: "C", unit: "", ts: TS },
        ]);
        expect(skipped).toBe(2);
        expect(rows.map((r) => r[0])).toEqual(["r-3"]);
    });

    it("nilai string berbahaya tetap jadi parameter, bukan teks SQL", () => {
        const evil = "\\' OR 1=1; DROP TABLE sensor_readings; -- ";
        const { rows } = sensorReadingRows("juragan", "dev-1", [
            { readingId: "r-4", schemeId: 104, value: evil, label: evil, unit: "", ts: TS },
        ]);

        expect(rows[0][6]).toBe(evil);
        expect(INSERT_SENSOR_READING_SQL).not.toContain(evil);
        // Satu placeholder per kolom.
        expect(INSERT_SENSOR_READING_SQL.match(/\?/g)).toHaveLength(rows[0].length);
    });
});

describe("toSqlDatetime", () => {
    it("format DATETIME UTC", () => {
        expect(toSqlDatetime(TS)).toBe("2026-11-23 05:30:15");
    });
});
