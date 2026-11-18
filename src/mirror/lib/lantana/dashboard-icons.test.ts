import { describe, expect, it } from "vitest";
import { DASHBOARD_ICONS, iconOptions } from "./dashboard-icons";

describe("DASHBOARD_ICONS", () => {
    it("berisi ikon yang dipakai contoh dashboard", () => {
        for (const icon of [
            "thermostat",
            "water_drop",
            "bolt",
            "power_settings_new",
        ]) {
            expect(DASHBOARD_ICONS).toContain(icon);
        }
    });

    it("tidak memiliki duplikat", () => {
        expect(new Set(DASHBOARD_ICONS).size).toBe(DASHBOARD_ICONS.length);
    });
});

describe("iconOptions", () => {
    it("mengembalikan daftar bawaan saat icon kosong atau dikenal", () => {
        expect(iconOptions()).toEqual([...DASHBOARD_ICONS]);
        expect(iconOptions("")).toEqual([...DASHBOARD_ICONS]);
        expect(iconOptions("  ")).toEqual([...DASHBOARD_ICONS]);
        expect(iconOptions("bolt")).toEqual([...DASHBOARD_ICONS]);
    });

    it("mempertahankan icon lama yang tidak dikenal di urutan pertama", () => {
        expect(iconOptions("custom_icon")[0]).toBe("custom_icon");
        expect(iconOptions("custom_icon")).toHaveLength(
            DASHBOARD_ICONS.length + 1,
        );
    });
});
