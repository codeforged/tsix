# Changelog Desktop Theme

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-09-08

### Pola menyelaraskan warna UI dengan tema aktif Asteracea (didokumentasikan)

- **File:**
  - `src/mirror/opt/test/pli-app.ts` + `pli-plot.js` — contoh theme-aware (PLI simulation, Cashew + DDC)
  - `src/mirror/opt/test/regression-app.ts` + `regression-plot.js` — pasangan app DDC lain
  - `wiki/cashew-in-a-nutshell.md`, `wiki/emerald-in-a-nutshell.md` — dokumentasi
- **Perubahan:** Mendokumentasikan pola menyelaraskan UI dgn tema aktif:
  1. **Widget DOM** → pakai CSS variables (`var(--bg)`, `var(--surface)`, `var(--accent)`, dst.) yang di-set browser via `WINDOW_THEME` → otomatis ikut light ↔ dark saat theme di-switch.
  2. **Nilai JS non-CSS** (slider color, argumen widget IoT, palet canvas DDC) → baca `theme.colors` setelah `await theme.loadCurrent()`.
  3. **Canvas DDC (NJ)** tidak bisa pakai `var()` → host kirim palet warna via handshake `ready` (NJ kirim `{event:"ready"}` di akhir `onInit`; host baru kirim `update_config` berisi palet saat `ddcApp.on("ready")`, plus fallback `setTimeout` sekali) — mencegah race saat NJ belum siap.
  4. Bereaksi saat theme di-switch runtime → dengarkan `THEME_CHANGED` via `_tsixLib.onEvent`.
- **Contoh:** `src/mirror/opt/test/pli-app.ts`.
- **Oleh:** Copilot

## 2026-07-26

### Theme system — init
- **File:** `src/mirror/etc/asteracea/theme-dark.json`, `theme-light.json`, `Theme.ts`
- **Perubahan:** Theme terpusat pake JSON + `ThemeProvider` singleton.
- **Detail:**
  - `theme-dark.json` — Dracula Emerald (dark theme, existing colors)
  - `theme-light.json` — Solarized Light (bright theme)
  - `Theme.ts` — class dengan `load()`, `switchTo()`, `discover()`, helper `card()` & `button()`
- **Oleh:** Copilot

---
