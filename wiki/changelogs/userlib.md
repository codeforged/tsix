# Changelog UserLib (Userland Library)

> Changelog untuk `src/mirror/lib/UserLib.ts` + framework `@tsix/Application`
> (std, fs, shell, net, db, pty, keyboard).
> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-08-30

### KeyboardLib — sub-library `keyboard` baru (decoder keyboard CLI)

- **File:** `src/mirror/lib/UserLib.ts`, `src/mirror/lib/Application.ts`
- **Perubahan:**
  - Tambah class **`KeyboardLib`** + interface **`KeyEvent`** di `UserLib.ts` — decoder byte stream terminal (padanan CLI dari `TKeyboard` Cashew).
  - Di-expose sebagai sub-library baru **`lib.keyboard`**; ditambah proxy `keyboard` di `@tsix/Application` (+ `export type { KeyEvent }`).
  - API: `keyboard.enable()` (raw mode) → `keyboard.readKey(): KeyEvent | null` → `keyboard.disable()` (cooked mode).
  - `KeyboardLib` dibangun di atas `StdLib` (pakai `getChar()`/`sleep()`/`setRawMode()`), jadi konsisten dengan sub-library lain.
- **Detail teknis:** lihat `wiki/changelogs/keyboard.md`.
- **Dampak:** UserLib punya kemampuan baca tombol CLI yang reusable — app interaktif (less/atto/dll) bisa pakai `keyboard.readKey()` tanpa menulis decoder sendiri. Sub-library ke-7 setelah std/fs/shell/net/db/pty.
- **Deploy:** `npm run vfs:bootstrap` (userland mirror — tanpa restart kernel).
- **Oleh:** Copilot

---
