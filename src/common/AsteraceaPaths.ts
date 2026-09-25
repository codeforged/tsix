/**
 * AsteraceaPaths.ts — SATU SUMBER KEBENARAN path Asteracea (WM/desktop TDE).
 *
 * KENAPA ADA: path desktop Asteracea dulu ditulis sebagai literal di banyak
 * berkas (`asteracea.ts`, `lib/theme.ts`, `lib/emerald.ts`, `lib/ddc.ts`,
 * `opt/pixelterm`, `opt/retroterm`, `userland/WorkerEntry.ts`, plus dokumentasi)
 * dan semuanya menunjuk ke `/opt/asteracea/*`. Akibatnya:
 *
 *   - data config/aset ikut menumpuk di `/opt` (yang semestinya kode) — `/etc`
 *     sudah lama dipakai aplikasi lain (`/etc/air-type`, `/etc/lantana`);
 *   - state runtime (PID, trust list, log) bercampur dengan berkas image,
 *     padahal state tidak boleh ikut ter-backup/ter-overwrite sebagai config;
 *   - dokumentasi (mis. `wiki/ASTERACEA_WM.md`) sudah menulis `/etc/asteracea/...`
 *     sementara kode masih `/opt/asteracea/...` — dua kebenaran yang berbeda.
 *
 * PEMBAGIAN (FHS):
 *   - `/etc/asteracea/**`      → CONFIG & aset milik node: menu launcher, tema,
 *                                preferensi, wallpaper (bisa disunting admin).
 *   - `/var/lib/asteracea/**`  → STATE persisten: daftar trust/block (hasil
 *                                keputusan user, bukan config).
 *   - `/var/run/asteracea/**`  → STATE runtime: PID file WM (hilang saat reboot).
 *   - `/var/log/asteracea/**`  → LOG: `desktop-notif.log`.
 *   - `/opt/asteracea/**`      → KODE saja (`asteracea.ts` + sidecar `.js`).
 *
 * CATATAN: `src/userland/WorkerEntry.ts` SENGAJA TIDAK meng-import modul ini
 * (worker entry dijalankan di HOST tanpa transpiler — `require("../common/X")`
 * hanya aman untuk berkas yang punya sidecar `.js` di repo, lihat komentar
 * `vfsBytesToUtf8` di sana). Path PID WM disalin lokal di berkas itu.
 *
 * (c) 2026 TSIX Project
 */

// ─── CONFIG (/etc) ────────────────────────────────────────────────────────
/** Direktori config Asteracea (menu, tema, preferensi). */
export const ASTERACEA_CONFIG_DIR = "/etc/asteracea";
/** `*.menu` — daftar aplikasi launcher (dibaca `loadMenuFromFiles()`). */
export const ASTERACEA_MENU_DIR = ASTERACEA_CONFIG_DIR + "/menu";
/** Direktori tema (`theme-*.json`) — argumen `dir` untuk `theme.*`. */
export const ASTERACEA_THEME_DIR = ASTERACEA_CONFIG_DIR;
/** `prefs.json` — preferensi WM (notifikasi, autorun, tema aktif, themeDir). */
export const ASTERACEA_PREFS_FILE = ASTERACEA_CONFIG_DIR + "/prefs.json";
/** `current-theme` — fallback tema terakhir (dipakai `theme.loadCurrent()`). */
export const ASTERACEA_CURRENT_THEME_FILE = ASTERACEA_CONFIG_DIR + "/current-theme";
/** `wallpaper.json` — wallpaper aktif ({ type, mime, value }). */
export const ASTERACEA_WALLPAPER_CONFIG = ASTERACEA_CONFIG_DIR + "/wallpaper.json";
/** Folder wallpaper: `default.b64` (bawaan) + `current-wp.b64` (pilihan user). */
export const ASTERACEA_WALLPAPER_DIR = ASTERACEA_CONFIG_DIR + "/wallpaper";
export const ASTERACEA_WALLPAPER_DEFAULT = ASTERACEA_WALLPAPER_DIR + "/default.b64";
export const ASTERACEA_WALLPAPER_CURRENT = ASTERACEA_WALLPAPER_DIR + "/current-wp.b64";
/** Nada notifikasi desktop (aset audio). */
export const ASTERACEA_RINGTONE_FILE = ASTERACEA_CONFIG_DIR + "/notif-ringtone.mp3";

// ─── STATE persisten (/var/lib) ───────────────────────────────────────────
/** Trust DB WM: `trusted.list` / `blocked.list` (+ varian DDC). */
export const ASTERACEA_STATE_DIR = "/var/lib/asteracea";
export const ASTERACEA_TRUSTED_FILE = ASTERACEA_STATE_DIR + "/trusted.list";
export const ASTERACEA_BLOCKED_FILE = ASTERACEA_STATE_DIR + "/blocked.list";
/** Trust NJ/DDC — dipisah karena kunci-nya nama app, bukan path command. */
export const ASTERACEA_DDC_TRUSTED_FILE = ASTERACEA_STATE_DIR + "/ddc-trusted.list";
export const ASTERACEA_DDC_BLOCKED_FILE = ASTERACEA_STATE_DIR + "/ddc-blocked.list";

// ─── STATE runtime (/var/run) ─────────────────────────────────────────────
/** PID file WM — dibaca Emerald & WorkerEntry untuk broadcast event window. */
export const ASTERACEA_RUN_DIR = "/var/run/asteracea";
export const ASTERACEA_WM_PID_FILE = ASTERACEA_RUN_DIR + "/wm-pid";

// ─── LOG (/var/log) ───────────────────────────────────────────────────────
export const ASTERACEA_LOG_DIR = "/var/log/asteracea";
/** Riwayat notifikasi desktop (auto-rotation, lihat `prefs.maxLog`). */
export const ASTERACEA_NOTIF_LOG_FILE = ASTERACEA_LOG_DIR + "/desktop-notif.log";
