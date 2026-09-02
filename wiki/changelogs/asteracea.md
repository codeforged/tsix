# Changelog Asteracea WM

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-09-02

### Shortcut Alt+S untuk berpindah fokus antar-window

- **File:** `src/mirror/opt/asteracea/asteracea.ts`, `src/mirror/opt/dome/dome.ts`, `src/mirror/opt/dome/dome-client-dom.js`, `src/mirror/opt/dome/dome-client-windows.js`
- **Perubahan:** Tambahkan shortcut global `Alt+S` untuk memfokuskan window aplikasi berikutnya secara bergantian. DOME menyinkronkan perubahan fokus ke Asteracea dan meneruskan perintah fokus ke window target.
- **Dampak:** User dapat berpindah fokus antar-window dengan shortcut keyboard tanpa perlu mengklik taskbar, dengan perilaku yang mirip window switching pada desktop OS.
- **Deploy:** Re-sync file yang berubah ke VFS, restart DOME + Asteracea, lalu hard-refresh browser.
- **Oleh:** Copilot · **Laporan/validasi:** kakang

### Shift-click multi-instance dan perilaku taskbar seperti window manager

- **File:** `src/mirror/opt/asteracea/asteracea.ts`, `src/common/GUITypes.ts`, `src/mirror/opt/dome/dome.ts`, `src/mirror/opt/dome/dome-client-dom.js`, `src/mirror/opt/dome/dome-client-windows.js`
- **Perubahan:**
  - Shift-click pada pinned launcher atau launcher box selalu menjalankan instance aplikasi baru.
  - Instance baru memiliki state dan tombol taskbar sendiri, termasuk tooltip nama aplikasi.
  - Klik tombol taskbar pada window yang tidak fokus kini memfokuskan window terlebih dahulu.
  - Klik tombol taskbar pada window yang sudah fokus baru meminimalkan window.
  - Event klik meneruskan modifier `shiftKey` dari browser melalui DOME ke Asteracea.
  - DOME menyediakan relay `FOCUS_WINDOW` agar Asteracea dapat memfokuskan window target secara langsung.
- **Dampak:** Launcher dan taskbar memiliki perilaku multi-window yang konsisten dengan window manager OS; instance aplikasi tidak saling menimpa dan taskbar tetap informatif.
- **Deploy:** Re-sync file yang berubah ke VFS, restart DOME + Asteracea, lalu hard-refresh browser.
- **Oleh:** Copilot · **Laporan/validasi:** kakang

---

## 2026-08-29

### Taskbar always-on-top (tidak lagi kalah sama window aplikasi)

- **File:** `src/mirror/opt/asteracea/asteracea.ts` + `src/mirror/opt/dome/dome-client-dom.js`
- **Masalah:** Taskbar ada di dalam DOM window WM → saat window aplikasi di-focus (z-index lebih tinggi), taskbar tertutup.
- **Perubahan:**
  - DOME kini mengekstrak `taskbar-wrapper` ke `__tsix_overlay_layer__` (layer di atas semua window, sama seperti `launcher-overlay`) — lihat changelog DOME.
  - `asteracea.ts`: taskbar disembunyikan saat login (`display:none`) lalu ditampilkan lagi (`display:flex`) setelah login sukses, di flow login awal maupun logout — karena taskbar kini hidup di overlay layer yang menutupi login screen.
- **Dampak:** Taskbar selalu terlihat & klikable di atas semua window aplikasi; layar login tetap bersih tanpa taskbar. Deploy: re-sync `asteracea.ts` + `dome-client-dom.js` ke VFS → restart DOME + Asteracea → hard-refresh browser.
- **Oleh:** Copilot

### Crash WM saat eksekusi file tanpa izin eksekusi (EXEC Permission Denied)

- **File:** `src/mirror/opt/asteracea/asteracea.ts`
- **Masalah:** `openApp()` memanggil `shell.exec()` tanpa try/catch. Saat user menjalankan file yang tidak punya flag eksekusi (mis. `chmod -x`), kernel (`Syscalls.ts`, kasus EXEC) melempar `Permission Denied: Cannot execute <path>`. Promise reject → tidak di-catch di click handler (pinned launcher, desktop context menu, `refreshMenus`) → menjadi **Unhandled Rejection**. Handler `unhandledRejection` di `WorkerEntry.ts` memanggil `realExit(1)` → seluruh worker Asteracea (WM) mati (status `EXITED` di `ps`).
- **Perubahan:**
  - `openApp()`: `shell.exec()` dibungkus `try/catch` → error di-log ke syslog (`[asteracea] Failed to launch ...`) dan ditampilkan ke user via `showError()` (popup "Gagal menjalankan aplikasi..." berisi pesan aslinya, mis. `Permission Denied: Cannot execute /opt/...`), lalu `return` bersih tanpa throw.
  - Call-site di-hardening: click handler pinned launcher, DCM (`showDesktopContextMenu`), dan `refreshMenus` yang tadi memanggil `openApp()` tanpa catch sekarang dibungkus `try/catch` (defense-in-depth).
- **Dampak:** Menjalankan file tanpa izin eksekusi kini menampilkan popup error, WM tetap hidup (tidak crash). Perilaku selaras dengan `tsh.ts` yang sudah menampilkan `-bash: <cmd>: Permission denied`. Deploy: re-sync `asteracea.ts` ke VFS + restart Asteracea.
- **Oleh:** Copilot

### Safety net — WM tidak pernah crash; semua error ditangkap & ditampilkan

- **File:** `src/mirror/opt/asteracea/asteracea.ts`
- **Masalah:** Meski crash EXEC sudah diperbaiki, WM masih bisa mati jika ada promise rejection lain yang tidak tertangkap. Contoh nyata: user non-root klik **Reboot** → `shell.shutdown(1)` lempar `Permission Denied: Only root or root group members can shutdown original system` → Unhandled Rejection → `WorkerEntry` memanggil `realExit(1)` → WM crash.
- **Perubahan:**
  - **Safety net global:** di awal `main()` (setelah `win` dibuat), hapus handler fatal bawaan `unhandledRejection`/`uncaughtException` dari `WorkerEntry` via `process.removeAllListeners(...)`, lalu pasang handler baru yang mencatat ke syslog + menampilkan popup error via `handleWmError()`, TAPI tidak meng-exit. → apapun yang terjadi, WM bertahan.
  - `handleWmError(win, kind, msg)` — helper defensif (log + `showError`), keduanya di-try-catch supaya tidak crash lagi.
  - Handler `launcher-reboot`: `shell.shutdown(1)` dibungkus try/catch → gagal (non-root) → popup "Reboot Gagal" + WM tetap hidup (app tidak ditutup dulu); lanjut menutup app hanya setelah shutdown terbukti sukses.
  - Handler `launcher-logout`, `btn-start`, `desktop`, `launcher-search`, dan `win.onClose` dibungkus try/catch (error di-log; jika logout gagal di tengah jalan, desktop dipaksa tampil lagi).
- **Dampak:** Reboot/logout/start-menu/close tidak lagi bisa mematikan WM — error selalu ditangkap & ditampilkan. Deploy: re-sync `asteracea.ts` ke VFS + restart Asteracea.
- **Oleh:** Copilot · **Laporan/reproduksi:** kakang

### Login ulang gagal setelah logout user non-root (switch user → root)

- **File:** `src/mirror/opt/asteracea/asteracea.ts`
- **Masalah:** Setelah login sebagai user non-root, WM drop privilege (setuid) secara permanen → saat logout lalu login ulang (mis. sebagai root), WM tidak bisa lagi baca `/etc/shadow` (0640 root) dan tidak bisa `setgroups`/`setgid`/`setuid` → login gagal.
- **Akar arsitektur:** WM merangkap login manager + desktop session dalam satu proses. Penyelesaian di sisi kernel & helper autentikasi (Saved UID `pcb.suid` + `login.js --verify`) dicatat di changelog **`kernel.md`** — di sini dicatat dampaknya di sisi WM.
- **Perubahan:**
  - `tryLogin` memverifikasi password lewat `/bin/login.js --verify` (SetUID root) alih-alih membaca `/etc/shadow` langsung; hasil dibaca dari file temp (`OK`/`FAIL:...`).
  - Urutan set identitas: **kalau WM belum root, `setuid(0)` dulu** (restore via Saved UID), baru `setgroups` → `setgid` → `setuid` ke user target. Menangani semua arah login ulang (non-root→root, non-root→non-root).
- **Dampak:** Logout dari user non-root lalu login sebagai root (atau user lain) sekarang berfungsi. Deploy: re-sync `asteracea.ts` ke VFS + restart Asteracea (kernel & `login.js` ikut perlu update — lihat `kernel.md`).
- **Oleh:** Copilot · **Laporan/reproduksi:** kakang

---

## 2026-08-08

### Foreign app taskbar button — dukungan custom icon dari payload GUI_WINDOW_CREATED

- **File:** `src/mirror/opt/asteracea/asteracea.ts`
- **Masalah:** Tombol taskbar untuk foreign app (dibuat via `registerForeignApp()`) selalu menampilkan icon `💻` (hardcoded) dan tidak bisa diatur dari sisi aplikasi — tidak seperti app terdaftar di `/opt/asteracea/menu` yang memakai field `icon` dari file `.menu`.
- **Perubahan:**
  - `registerForeignApp()` menerima param baru `icon` (default `"💻"`) → dipakai untuk `entry.icon` dan icon tombol taskbar (`text(icon)`).
  - Handler `GUI_WINDOW_CREATED` meneruskan `payload.icon || "💻"` — foreign app kini bisa mengirim `icon` di notifikasi `GUI_WINDOW_CREATED`.
- **Dampak:** Foreign app (dijalankan dari terminal/shell) bisa menampilkan icon custom di taskbar via payload. Deploy: restart Asteracea.
- **Oleh:** Copilot

## 2026-08-06

### Tooltip taskbar hilang untuk foreign app (tidak terdaftar di /opt/asteracea/menu)

- **File:** `src/mirror/opt/asteracea/asteracea.ts`
- **Masalah:** Taskbar button untuk aplikasi asing (dibuat via `registerForeignApp()` — dijalankan dari terminal/shell, tidak terdaftar di `/opt/asteracea/menu`) tidak menampilkan tooltip, sementara app terdaftar/pinned punya tooltip. Tooltip TSIX adalah sistem custom `data-tt` di DOME client (bukan native `title`), yang di-set dari prop `title` saat taskbar button di-mount.
- **Perubahan:** Tambah prop `title` pada taskbar button di `registerForeignApp()` — nilainya judul window dari payload `GUI_WINDOW_CREATED` (parameter `title`). Konsisten dengan pinned launcher yang memakai `title: app.label`.
- **Dampak:** Semua taskbar button punya tooltip — baik yang terdaftar di menu maupun foreign app. Deploy: restart Asteracea.
- **Oleh:** Copilot

### State WM tidak sinkron setelah maximize lewat context menu taskbar

- **File:** `src/mirror/opt/asteracea/asteracea.ts`
- **Masalah:** Asteracea hanya menangani notifikasi `GUI_WINDOW_MINIMIZED`/`GUI_WINDOW_RESTORED`/`GUI_WINDOW_CLOSED`. Ketika aplikasi di-minimize lalu di-maximize lewat context menu taskbar, notifikasi `GUI_WINDOW_MAXIMIZED` diabaikan → `appState` tetap `MINIMIZED` → klik kiri taskbar berikutnya mengirim `restore_window` (bukan minimize toggle), sehingga perilaku taskbar membingungkan.
- **Perubahan:** Tambah handler `GUI_WINDOW_MAXIMIZED` dan `GUI_WINDOW_UNMAXIMIZED` → `transitionTo(appId, "RUNNING")` + taskbar style aktif (sama seperti `GUI_WINDOW_RESTORED`).
- **Dampak:** State WM sinkron dengan kondisi window; klik taskbar setelah maximize langsung menjadi minimize toggle. Deploy: restart Asteracea.
- **Oleh:** Copilot

---

## 2026-08-04

### Login fix — prefill password `"1"` dihapus

- **File:** `src/mirror/opt/asteracea/asteracea.ts`, `src/mirror/opt/krisan/krisan.ts`
- **Masalah:** Field password login di-prefill `value: "1"` (password default lama) dan bertipe `password` (ter-mask, karakter awal tak terlihat). Setelah `passwd root` mengganti password, nilai terkirim menjadi `"1" + passwordBaru` → `bcrypt.compareSync` selalu false → login selalu ditolak meski password benar (tsh tidak kena karena baca dari terminal tanpa prefill).
- **Perubahan:** Hapus `value: loginPass` dari input password & inisialisasi `loginPass = ""` di `showLoginScreen` (diterapkan juga ke krisan).
- **Dampak:** Field password mulai kosong; password baru diterima apa adanya. (Bug utama tambahan ada di sisi DOME client — lihat changelog `dome.md`.)
- **Oleh:** Copilot

### Wallpaper blank setelah reboot — folder wallpaper dibuat saat runtime

- **File:** `src/mirror/opt/asteracea/asteracea.ts`
- **Masalah:** `showWallpaperDialog` menulis `/opt/asteracea/wallpaper/current-wp.b64` tapi folder `wallpaper/` tidak pernah dibuat → `fs.writeFile` gagal diam-diam → `wallpaper.json` tersimpan tapi file b64 hilang → wallpaper blank setelah reboot.
- **Perubahan:** Tambah `fs.mkdir("/opt/asteracea/wallpaper")` (di-try-catch) sebelum menulis file b64.
- **Dampak:** Wallpaper persist setelah reboot. Catatan: pengaturan lama tersimpan di path `/etc/asteracea/...` → perlu set ulang sekali setelah re-sync.
- **Oleh:** Copilot

### Daemonize — lepas dari console tty1

- **File:** `src/mirror/opt/asteracea/asteracea.ts`
- **Masalah:** Output asteracea menumpuk di console tty1 dan mengganggu user yang mengetik di sana.
- **Perubahan:** `main` diawali `shell.daemonize("Asteracea Window Manager")` (pola sama dengan DOME). Syscall `DETACH` mengalihkan stdio ke `/dev/null` dan melepas foreground TTY. `std.log`/`std.error` tetap masuk `/var/log/syslog` (via VFS, bukan stdout); render GUI tetap via DOME.
- **Dampak:** Console tty1 bersih. Efek samping: run manual dari tsh langsung kembali ke prompt; Ctrl+C tidak mematikan daemon (gunakan `kill <pid>`).
- **Oleh:** Copilot

### Menu & PATH update untuk FHS restructure

- **File:** `src/mirror/opt/asteracea/menu/*.menu`, `src/mirror/etc/profile`
- **Perubahan:** Command menu di-update: app test → `/opt/test/*.js`, app → `/opt/<app>/<app>.js`, tool → `/usr/bin/*.js`, daemon → `/sbin/*`. `profile` menambahkan `/bin:/sbin:/usr/bin:/opt/asteracea:/opt/mysqld:/opt/<app>...` ke PATH.
- **Dampak:** Launcher & shell menemukan binary setelah relokasi FHS.
- **Oleh:** Copilot
