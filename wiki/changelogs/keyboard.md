# Changelog Keyboard (CLI) — KeyboardLib

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-08-30

### KeyboardLib — decoder keyboard CLI reusable (padanan CLI dari TKeyboard)

- **File:** `src/mirror/lib/UserLib.ts`, `src/mirror/lib/Application.ts`, `src/mirror/opt/test/cli-read-keyboard.ts` (baru)
- **Latar:** Demo `cli-read-keyboard` (versi CLI dari `gui-read-keyboard`) awalnya berisi ~430 baris decoder di dalam file app. Agar reusable, seluruh decoder dipindah ke class `KeyboardLib` di UserLib (seperti `TKeyboard`/`Keyboard` yang reusable di GUI).
- **Perubahan:**
  - **`KeyboardLib` + interface `KeyEvent`** di `UserLib.ts` — decoder byte stream terminal:
    - printable chars, control char (`Ctrl+A..Z`, `Tab`, `Enter`, `Backspace`, dst.)
    - escape sequence **CSI/SS3** (Arrow, Home/End, PageUp/PageDown, Del, Insert, F1..F12)
    - modifier **Shift/Alt/Ctrl** lewat param `;N` (mis. `\x1b[1;5A` → Ctrl+Up) dan `27;mod;code~`
    - `Alt+<char>`, `Alt+Escape`, `Alt+Backspace`
    - ESC tunggal dideteksi via **timeout 120ms** (tidak hang) + mekanisme `pendingChar` supaya byte yang datang telat tidak hilang.
  - **API:** `keyboard.enable()` (raw mode) → `keyboard.readKey(): KeyEvent | null` → `keyboard.disable()` (cooked mode). Di-expose sebagai `lib.keyboard` + proxy `keyboard` di `@tsix/Application` (+ export type `KeyEvent`).
  - **`cli-read-keyboard`** (`opt/test`): kini lapisan tipis (~48 baris) di atas `lib.keyboard` — enable → loop `readKey()` → tampilkan → keluar di Ctrl+C/Ctrl+D.
- **Dampak:** App CLI interaktif lain (mis. `less`, `atto`, atau app baru) bisa reuse decoder keyboard tanpa menulis sendiri. Catatan: terminal tidak mengirim event keyup & auto-repeat — semua tampil sebagai "down".
- **Deploy:** `npm run vfs:bootstrap` (semua userland mirror — tanpa restart kernel).
- **Oleh:** Copilot

---
