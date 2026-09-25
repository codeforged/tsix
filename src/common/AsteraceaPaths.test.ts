import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
    ASTERACEA_BLOCKED_FILE,
    ASTERACEA_CONFIG_DIR,
    ASTERACEA_CURRENT_THEME_FILE,
    ASTERACEA_DDC_BLOCKED_FILE,
    ASTERACEA_DDC_TRUSTED_FILE,
    ASTERACEA_LOG_DIR,
    ASTERACEA_MENU_DIR,
    ASTERACEA_NOTIF_LOG_FILE,
    ASTERACEA_PREFS_FILE,
    ASTERACEA_RINGTONE_FILE,
    ASTERACEA_RUN_DIR,
    ASTERACEA_STATE_DIR,
    ASTERACEA_THEME_DIR,
    ASTERACEA_TRUSTED_FILE,
    ASTERACEA_WALLPAPER_CONFIG,
    ASTERACEA_WALLPAPER_CURRENT,
    ASTERACEA_WALLPAPER_DEFAULT,
    ASTERACEA_WALLPAPER_DIR,
    ASTERACEA_WM_PID_FILE,
} from "./AsteraceaPaths";

/**
 * ASTERACEA PATHS (D10.01+) — pembagian config/state sesuai FHS.
 *
 * Yang dijaga di sini adalah hasil pemindahan besar (2026-09-25): config desktop
 * yang dulu menumpuk di `/opt/asteracea/*` dipindah ke `/etc/asteracea/*`, sedangkan
 * state runtime ke `/var`. Bug kelas ini senyap — path salah berarti menu launcher
 * kosong, tema tidak ketemu, atau wallpaper hilang setelah reboot — jadi lebih baik
 * dijaga test daripada ditemukan di layar.
 */

const mirror = (rel: string) =>
    fileURLToPath(new URL(`../mirror/${rel}`, import.meta.url));

describe("AsteraceaPaths (D10.01+)", () => {
    it("D10.01 config di /etc, state di /var — tidak ada yang kembali ke /opt", () => {
        const config = [
            ASTERACEA_CONFIG_DIR,
            ASTERACEA_MENU_DIR,
            ASTERACEA_THEME_DIR,
            ASTERACEA_PREFS_FILE,
            ASTERACEA_CURRENT_THEME_FILE,
            ASTERACEA_WALLPAPER_CONFIG,
            ASTERACEA_WALLPAPER_DIR,
            ASTERACEA_WALLPAPER_DEFAULT,
            ASTERACEA_WALLPAPER_CURRENT,
            ASTERACEA_RINGTONE_FILE,
        ];
        for (const p of config) expect(p, p).toMatch(/^\/etc\/asteracea(\/|$)/);

        const state = [
            ASTERACEA_STATE_DIR,
            ASTERACEA_TRUSTED_FILE,
            ASTERACEA_BLOCKED_FILE,
            ASTERACEA_DDC_TRUSTED_FILE,
            ASTERACEA_DDC_BLOCKED_FILE,
        ];
        for (const p of state) expect(p, p).toMatch(/^\/var\/lib\/asteracea(\/|$)/);

        expect(ASTERACEA_RUN_DIR).toMatch(/^\/var\/run\/asteracea$/);
        expect(ASTERACEA_WM_PID_FILE).toMatch(/^\/var\/run\/asteracea\//);
        expect(ASTERACEA_LOG_DIR).toMatch(/^\/var\/log\/asteracea$/);
        expect(ASTERACEA_NOTIF_LOG_FILE).toMatch(/^\/var\/log\/asteracea\//);

        // Tidak ada satupun path yang menunjuk lagi ke folder KODE (/opt).
        for (const p of [...config, ...state, ASTERACEA_WM_PID_FILE, ASTERACEA_NOTIF_LOG_FILE]) {
            expect(p.startsWith("/opt/"), p).toBe(false);
        }
    });

    it("D10.02 path turunan konsisten dengan direktori induknya", () => {
        expect(ASTERACEA_MENU_DIR.startsWith(ASTERACEA_CONFIG_DIR + "/")).toBe(true);
        expect(ASTERACEA_THEME_DIR).toBe(ASTERACEA_CONFIG_DIR);
        expect(ASTERACEA_PREFS_FILE.startsWith(ASTERACEA_CONFIG_DIR + "/")).toBe(true);
        expect(ASTERACEA_WALLPAPER_CONFIG.startsWith(ASTERACEA_CONFIG_DIR + "/")).toBe(true);
        expect(ASTERACEA_WALLPAPER_CURRENT.startsWith(ASTERACEA_WALLPAPER_DIR + "/")).toBe(true);
        expect(ASTERACEA_WALLPAPER_DEFAULT.startsWith(ASTERACEA_WALLPAPER_DIR + "/")).toBe(true);
        expect(ASTERACEA_TRUSTED_FILE.startsWith(ASTERACEA_STATE_DIR + "/")).toBe(true);
        expect(ASTERACEA_WM_PID_FILE.startsWith(ASTERACEA_RUN_DIR + "/")).toBe(true);
        expect(ASTERACEA_NOTIF_LOG_FILE.startsWith(ASTERACEA_LOG_DIR + "/")).toBe(true);
    });

    it("D10.03 berkas di mirror ada di lokasi yang disebut konstanta", () => {
        // Config yang DIKIRIM image — kalau salah satu hilang, konsumennya
        // (asteracea.ts, theme.ts) akan jalan dengan fallback tanpa suara.
        for (const rel of [
            "etc/asteracea/menu",
            "etc/asteracea/menu/set-theme.menu",
            "etc/asteracea/wallpaper",
            "etc/asteracea/wallpaper/current-wp.b64",
            "etc/asteracea/prefs.json",
            "etc/asteracea/wallpaper.json",
            "etc/asteracea/theme-dark.json",
            "etc/asteracea/theme-light.json",
            "etc/asteracea/notif-ringtone.mp3",
            "opt/asteracea/asteracea.ts",
        ]) {
            expect(existsSync(mirror(rel)), rel).toBe(true);
        }
    });

    it("D10.04 /opt/asteracea hanya berisi KODE (config/state tidak menumpuk lagi)", () => {
        const entries = readdirSync(mirror("opt/asteracea"));
        for (const name of entries) {
            expect(name, `/opt/asteracea/${name} bukan kode`).toMatch(
                /^asteracea\.(ts|js)$/,
            );
        }
    });

    it("D10.05 isi config yang dikirim tidak menunjuk path lama", () => {
        const prefs = JSON.parse(readFileSync(mirror("etc/asteracea/prefs.json"), "utf8"));
        expect(prefs.themeDir).toBe(ASTERACEA_THEME_DIR);

        const wallpaper = JSON.parse(
            readFileSync(mirror("etc/asteracea/wallpaper.json"), "utf8"),
        );
        // Nilai ini menunjuk berkas b64 yang harus ada di folder wallpaper.
        expect(wallpaper.value).toBe(ASTERACEA_WALLPAPER_CURRENT);
        expect(wallpaper.value.startsWith(ASTERACEA_CONFIG_DIR + "/")).toBe(true);
    });
});
