# Changelog PixelSpace Samples

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-08-08

### ps-sample1.ts — kirim icon custom di notifikasi GUI_WINDOW_CREATED

- **File:** `src/mirror/root/ps-sample1.ts`
- **Perubahan:** `notifyWm("GUI_WINDOW_CREATED", { title, icon })` — tambah field `icon` pada payload. Asteracea (`registerForeignApp`) kini membaca `payload.icon` → tombol taskbar foreign app menampilkan icon custom (bukan hardcoded 💻).
- **Dampak:** Sample RAW mendemonstrasikan cara set icon taskbar untuk foreign app. Pasangan perubahan di sisi WM: changelog `asteracea.md`.
- **Oleh:** Copilot

## 2026-08-06

### ps-sample1.ts — integrasi RAW PixelSpace dengan Asteracea WM (taskbar + minimize/restore)

- **File:** `src/mirror/root/ps-sample1.ts`
- **Latar:** `ps-sample1.ts` adalah sample **SUPER RAW** — komunikasi langsung via `UserLib.dispatch()` + payload `IGUIPayload`, tanpa toolkit Emerald (berlawanan dengan `ps-sample2.ts` yang memakai `Screen`/factory functions). Setelah ditambah integrasi WM, perilaku window-nya setara Emerald.
- **Perubahan:**
  - Helper `notifyWm(type, extra)` — mengirim notifikasi `GUI_WINDOW_CREATED`/`GUI_WINDOW_CLOSED`/`GUI_WINDOW_MINIMIZED`/`GUI_WINDOW_RESTORED` ke parent process dan ke Asteracea WM (PID dibaca dari `/opt/asteracea/wm-pid`). Meniru `Window.notifyParentWindowEvent()` di Emerald (`emerald.ts`) — sebelumnya `ps-sample1` tidak pernah memberitahu WM sehingga tidak ada tombol taskbar.
  - Panggil `notifyWm("GUI_WINDOW_CREATED", { title })` setelah `CREATE_WINDOW` → Asteracea memanggil `registerForeignApp()` → tombol taskbar muncul.
  - Handler event `minimize_window`/`restore_window` pada `targetId === "__window__"` → kirim `GUI_REQ MINIMIZE_WINDOW`/`RESTORE_WINDOW` + notifikasi `GUI_WINDOW_MINIMIZED`/`GUI_WINDOW_RESTORED` → state & style tombol taskbar sinkron (toggle minimize/restore via klik taskbar berfungsi).
  - Panggil `notifyWm("GUI_WINDOW_CLOSED")` sebelum `DESTROY_WINDOW` → tombol taskbar dihapus dari WM.
- **Dampak:** Aplikasi RAW tanpa Emerald kini punya perilaku window lengkap: tombol taskbar, toggle minimize/restore, cleanup tombol saat tutup. Berguna sebagai dokumentasi hidup (living documentation) lapisan bawah protokol PixelSpace — semua yang dilakukan manual di sini (dispatch, node, event, notify WM) dibungkus Emerald menjadi `Screen`, `div()`, `app.on()`, dan `loopUntilClose()`.
- **Oleh:** Copilot

### ps-sample1.ts — handler maximize/unmaximize + sinkronisasi WM

- **File:** `src/mirror/root/ps-sample1.ts`
- **Masalah:** Saat window di-minimize lalu di-maximize lewat context menu taskbar, `ps-sample1` (RAW) tidak menangani event `maximize_window`/`unmaximize_window` → tidak mengirim `GUI_REQ` dan tidak memberi tahu WM → state WM tidak sinkron (tetap MINIMIZED) sehingga toggle taskbar kacau.
- **Perubahan:**
  - `notifyWm()` menerima tipe baru `GUI_WINDOW_MAXIMIZED` & `GUI_WINDOW_UNMAXIMIZED`.
  - Handler event `maximize_window`/`unmaximize_window` pada `targetId === "__window__"` → kirim `GUI_REQ MAXIMIZE_WINDOW`/`UNMAXIMIZE_WINDOW` + notifikasi ke WM (setara `Window.maximize()`/`unmaximize()` di Emerald).
- **Dampak:** Foreign app RAW kini sinkron penuh dengan WM: minimize → maximize via context menu → klik taskbar jadi minimize toggle (bukan restore no-op).
- **Oleh:** Copilot
