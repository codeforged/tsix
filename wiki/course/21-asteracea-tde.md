---
module: 21
title: Asteracea & TDE
part: VII
partTitle: GUI & Desktop
status: done
lang: id
rfc: RFC-TSIX-EDU-002
audience: all
---

# Asteracea & TDE

**RFC-TSIX-EDU-002** | Modul kedua puluh satu kurikulum TSIX. Memahami Window Manager TSIX: aplikasi PixelSpace biasa (fullscreen frameless) yang mengelola lifecycle aplikasi GUI lain.

> Poin penting: **Asteracea bukan bagian kernel/DOME** — ia aplikasi PixelSpace biasa (Ring 4, sandboxed worker) yang berjalan fullscreen. Ia me-launch, mengontrol, dan mengelola lifecycle aplikasi GUI lain.

---

## Tujuan Pembelajaran

- [ ] Menjelaskan posisi Asteracea dalam arsitektur
- [ ] Menjelaskan filosofi queue-based IPC (MessageBus)
- [ ] Menjelaskan taskbar (pinned/running/foreign)
- [ ] Menjelaskan launcher & fuzzy search
- [ ] Menjelaskan lifecycle events via `/opt/asteracea/wm-pid`

---

## Konsep Inti

### Spesifikasi

| Aspek | Deskripsi |
|---|---|
| Lokasi | `src/mirror/opt/asteracea/asteracea.ts` |
| Mode | Fullscreen, frameless |
| Model | Queue-based IPC (`MessageBus`) |
| Proto | PixelSpace Protocol via DOME |
| Privilege | Ring 4 (sandboxed worker) |
| Auto-start | `/etc/rc.local.ts` (setelah DOME siap — poll `/var/run/dome.ready`) |

### Filosofi queue-based

Semua event masuk ke antrian FIFO (`MessageBus`) dan diproses satu per satu — mencegah race condition dan starvation:

```
App A ──(shell.send)──► Kernel ──(ipc_message)──► MessageBus Queue ──► handlers
App B ──(GUI_REQ)─────► DOME  ──(ipc_message)──► MessageBus Queue ──► handlers
Browser ──(click)─────► DOME  ──(shell.send)────► MessageBus Queue ──► handlers
```

![Alur notifikasi desktop: app → kernel → Asteracea → browser](/wiki/diagram/ASTERACEA_WM-1.png)
*Sumber: [`wiki/diagram/ASTERACEA_WM-1.mmd`](/wiki/diagram/ASTERACEA_WM-1.mmd)*

### Komponen

- **Taskbar**: pinned / running / foreign windows
- **Launcher**: start menu + **fuzzy search** aplikasi
- **Login** & **wallpaper**
- **Desktop Context Menu (DCM)**
- **App State Manager**

### IPC lifecycle events

WM mendengarkan `GUI_WINDOW_*` lifecycle events: `GUI_WINDOW_CREATED`, `GUI_WINDOW_MINIMIZED`, `GUI_WINDOW_RESTORED`, `GUI_WINDOW_MAXIMIZED`, `GUI_WINDOW_UNMAXIMIZED`, `GUI_WINDOW_CLOSED`, dan `GUI_WINDOW_ERROR`. Aplikasi GUI lain berkomunikasi dengan WM melalui `/opt/asteracea/wm-pid` (PID file) — Emerald broadcast event ke Asteracea.

### Perbaikan & Fitur Terbaru

Agar sinkron dengan kode nyata, beberapa perilaku berikut ditambahkan:

- **Daemonize** — `main` diawali `shell.daemonize("Asteracea Window Manager")`. Proses lepas dari console tty1; stdio dialihkan ke `/dev/null`. Log tetap masuk `/var/log/syslog` via VFS (`std.log`/`std.error`), dan render GUI tetap normal karena lewat DOME.
- **Icon & tooltip taskbar untuk foreign app** — handler `GUI_WINDOW_CREATED` meneruskan `payload.icon || "💻"` ke `registerForeignApp()`. Icon dipakai untuk tombol taskbar; `title` (judul window) menjadi tooltip via prop `title` (diterjemahkan ke `data-tt` di DOME). Foreign app kini bisa menampilkan icon custom.
- **Handler `GUI_WINDOW_MAXIMIZED` / `GUI_WINDOW_UNMAXIMIZED`** — keduanya memanggil `transitionTo(appId, "RUNNING")` dan menetapkan style taskbar aktif (sama seperti `GUI_WINDOW_RESTORED`). State WM tetap sinkron setelah maximize lewat context menu taskbar; klik taskbar berikutnya langsung menjadi minimize toggle.
- **Login tanpa prefill password** — field password tidak lagi diisi `value: "1"` (inisialisasi `loginPass = ""`). Prefill lama akan "menempel" di depan password baru dan membuat login selalu gagal setelah `passwd` mengganti password.
- **Persistensi wallpaper** — sebelum menulis `/opt/asteracea/wallpaper/current-wp.b64`, `showWallpaperDialog` membuat folder `/opt/asteracea/wallpaper` (di-try-catch). Sebelumnya folder tidak ada → `fs.writeFile` gagal diam-diam → wallpaper blank setelah reboot.

---

## Kode Sumber

| File | Peran |
|---|---|
| `src/mirror/opt/asteracea/asteracea.ts` | Window manager |
| `src/mirror/opt/asteracea/menu/*.menu` | Konfigurasi menu launcher |
| `src/mirror/etc/rc.local.ts` | Auto-start DOME + Asteracea (poll `/var/run/dome.ready`) |

---

## Latihan / Praktik

1. Login ke TSIX — amati desktop: taskbar, launcher, wallpaper.
2. Buka launcher dan ketik sebagian nama app — amati fuzzy search.
3. Baca `wiki/ASTERACEA_WM.md` — pelajari MessageBus dan AppState Manager.
4. Baca `src/mirror/opt/asteracea/asteracea.ts` — cari handler lifecycle `GUI_WINDOW_*`.

---

## Referensi

- `wiki/ASTERACEA_WM.md` — dokumentasi lengkap WM
- `wiki/PIXELSPACE_DEVELOPER_GUIDE.md` §3, §9
- `wiki/course/00-overview.md` §10
- `src/mirror/opt/asteracea/asteracea.ts`, `src/mirror/opt/asteracea/menu/*.menu`

---

*Modul 21 — selesai. Lanjut ke [Modul 22 — State Replay & Persistence](22-state-replay-persistence.md).*
