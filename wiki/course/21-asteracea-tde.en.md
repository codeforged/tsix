---
module: 21
title: Asteracea & TDE
part: VII
partTitle: GUI & Desktop
status: done
lang: en
rfc: RFC-TSIX-EDU-002
audience: all
---

# Asteracea & TDE

**RFC-TSIX-EDU-002** | Twenty-first module of the TSIX curriculum. Understand the TSIX Window Manager: an ordinary PixelSpace app (fullscreen frameless) that manages the lifecycle of other GUI apps.

> Key point: **Asteracea is not part of the kernel/DOME** — it is an ordinary PixelSpace app (Ring 4, sandboxed worker) that runs fullscreen. It launches, controls, and manages the lifecycle of other GUI apps.

---

## Learning Objectives

- [ ] Explain Asteracea's position in the architecture
- [ ] Explain the queue-based IPC philosophy (MessageBus)
- [ ] Explain the taskbar (pinned/running/foreign)
- [ ] Explain the launcher & fuzzy search
- [ ] Explain lifecycle events via `/opt/asteracea/wm-pid`

---

## Core Concepts

### Specification

| Aspect | Description |
|---|---|
| Location | `src/mirror/opt/asteracea/asteracea.ts` |
| Mode | Fullscreen, frameless |
| Model | Queue-based IPC (`MessageBus`) |
| Protocol | PixelSpace Protocol via DOME |
| Privilege | Ring 4 (sandboxed worker) |
| Auto-start | `/etc/rc.local.ts` (after DOME is ready — poll `/var/run/dome.ready`) |

### Queue-based philosophy

All events enter a FIFO queue (`MessageBus`) and are processed one by one — preventing race conditions and starvation:

```
App A ──(shell.send)──► Kernel ──(ipc_message)──► MessageBus Queue ──► handlers
App B ──(GUI_REQ)─────► DOME  ──(ipc_message)──► MessageBus Queue ──► handlers
Browser ──(click)─────► DOME  ──(shell.send)────► MessageBus Queue ──► handlers
```

![Desktop notification flow: app → kernel → Asteracea → browser](/wiki/diagram/ASTERACEA_WM-1.png)
*Source: [`wiki/diagram/ASTERACEA_WM-1.mmd`](/wiki/diagram/ASTERACEA_WM-1.mmd)*

### Components

- **Taskbar**: pinned / running / foreign windows
- **Launcher**: start menu + **fuzzy search** for apps
- **Login** & **wallpaper**
- **Desktop Context Menu (DCM)**
- **App State Manager**

### IPC lifecycle events

The WM listens for `GUI_WINDOW_*` lifecycle events: `GUI_WINDOW_CREATED`, `GUI_WINDOW_MINIMIZED`, `GUI_WINDOW_RESTORED`, `GUI_WINDOW_MAXIMIZED`, `GUI_WINDOW_UNMAXIMIZED`, `GUI_WINDOW_CLOSED`, and `GUI_WINDOW_ERROR`. Other GUI apps communicate with the WM through `/opt/asteracea/wm-pid` (PID file) — Emerald broadcasts events to Asteracea.

### Fixes & Latest Features

To stay in sync with the real code, the following behaviors were added:

- **Daemonize** — `main` starts with `shell.daemonize("Asteracea Window Manager")`. The process detaches from the tty1 console; stdio is redirected to `/dev/null`. Logs still go to `/var/log/syslog` via VFS (`std.log`/`std.error`), and GUI rendering stays normal because it goes through DOME.
- **Taskbar icon & tooltip for foreign apps** — the `GUI_WINDOW_CREATED` handler forwards `payload.icon || "💻"` to `registerForeignApp()`. The icon is used for the taskbar button; `title` (the window title) becomes the tooltip via the `title` prop (translated to `data-tt` in DOME). Foreign apps can now show a custom icon.
- **`GUI_WINDOW_MAXIMIZED` / `GUI_WINDOW_UNMAXIMIZED` handlers** — both call `transitionTo(appId, "RUNNING")` and set the active taskbar style (same as `GUI_WINDOW_RESTORED`). WM state stays in sync after maximizing via the taskbar context menu; the next taskbar click becomes a minimize toggle.
- **Login without password prefill** — the password field is no longer filled with `value: "1"` (initialized as `loginPass = ""`). The old prefill would "stick" in front of the new password and make login always fail after `passwd` changes the password.
- **Wallpaper persistence** — before writing `/opt/asteracea/wallpaper/current-wp.b64`, `showWallpaperDialog` creates the `/opt/asteracea/wallpaper` folder (inside a try-catch). Previously the folder did not exist → `fs.writeFile` failed silently → blank wallpaper after reboot.

---

## Source Code

| File | Role |
|---|---|
| `src/mirror/opt/asteracea/asteracea.ts` | Window manager |
| `src/mirror/opt/asteracea/menu/*.menu` | Launcher menu configuration |
| `src/mirror/etc/rc.local.ts` | Auto-start DOME + Asteracea (poll `/var/run/dome.ready`) |

---

## Exercises / Practice

1. Log in to TSIX — observe the desktop: taskbar, launcher, wallpaper.
2. Open the launcher and type part of an app name — observe fuzzy search.
3. Read `wiki/ASTERACEA_WM.md` — learn about the MessageBus and the App State Manager.
4. Read `src/mirror/opt/asteracea/asteracea.ts` — find the `GUI_WINDOW_*` lifecycle handlers.

---

## References

- `wiki/ASTERACEA_WM.md` — complete WM documentation
- `wiki/PIXELSPACE_DEVELOPER_GUIDE.md` §3, §9
- `wiki/course/00-overview.md` §10
- `src/mirror/opt/asteracea/asteracea.ts`, `src/mirror/opt/asteracea/menu/*.menu`

---

*Module 21 — done. Continue to [Module 22 — State Replay & Persistence](22-state-replay-persistence.en.md).*
