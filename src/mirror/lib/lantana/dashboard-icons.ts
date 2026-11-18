/**
 * dashboard-icons.ts — Nama ikon kartu yang dikenali aplikasi Android.
 *
 * Daftar ini harus sama dengan pemetaan `dashboardIcon()` di aplikasi Flutter
 * (`lib/dashboard/dashboard_widgets.dart`). Control panel memakainya sebagai
 * combobox supaya icon tidak salah ketik.
 *
 * (c) 2026 TSIX Project
 */

/** Ikon kartu yang didukung aplikasi Android, urut sesuai pemetaan Flutter. */
export const DASHBOARD_ICONS = [
    "thermostat",
    "water_drop",
    "bolt",
    "power_settings_new",
    "lightbulb",
    "air",
    "speed",
    "sensors",
] as const;

export type DashboardIcon = (typeof DASHBOARD_ICONS)[number];

/**
 * Opsi combobox ikon. Icon lama yang tidak dikenal tetap ditampilkan paling
 * atas supaya menyunting item tidak diam-diam mengganti tampilannya.
 */
export function iconOptions(current?: string): string[] {
    const value = current?.trim();
    if (value && !(DASHBOARD_ICONS as readonly string[]).includes(value)) {
        return [value, ...DASHBOARD_ICONS];
    }
    return [...DASHBOARD_ICONS];
}
