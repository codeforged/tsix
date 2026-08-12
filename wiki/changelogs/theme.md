# Changelog Desktop Theme

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

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
