# PixelSpace Protocol & DOME Engine — Developer Guide

**RFC-TSIX-002** | **Version 1.2** | **2026-07-16**

---

## Daftar Isi
1. [Konsep & Arsitektur](#1-konsep--arsitektur)
2. [DOME Engine (Display Server)](#2-dome-engine-display-server)
3. [Asteracea (Window Manager)](#3-asteracea-window-manager)
4. [Memulai — Hello World](#4-memulai--hello-world)
5. [Primitif UI](#5-primitif-ui)
6. [Screen Wrapper](#6-screen-wrapper)
7. [Event Handling](#7-event-handling)
8. [Window Management](#8-window-management)
9. [Aplikasi Lengkap](#9-aplikasi-lengkap)
10. [Referensi API](#10-referensi-api)
11. [State Replay & Pruning](#11-state-replay--pruning)

---

## 1. Konsep & Arsitektur

PixelSpace adalah **protokol display setara X11/Wayland** untuk ekosistem TSIX. Berbeda dengan X11/Wayland yang berbasis pixel-buffer, PixelSpace menggunakan **DOM-Based Remote Rendering** — browser host sebagai GPU, WebSocket sebagai bus data, JSON sebagai format protokol.

### Layer Arsitektur

```
┌──────────────────────────────────────────────────────────┐
│  BROWSER (Host)                                          │
│  Presentation Engine — render DOM nyata                  │
│  index.html statis via DOME, konek WebSocket             │
└────────────────┬─────────────────────────────────────────┘
                 │ WebSocket :8080
┌────────────────▼─────────────────────────────────────────┐
│  DOME ENGINE (Display Server)                            │
│  Window registry, Z-index, focus, state replay           │
└────────────────┬─────────────────────────────────────────┘
                 │ IPC (sendEvent)
┌────────────────▼─────────────────────────────────────────┐
│  KERNEL (Ring 1)                                         │
│  GUIRegistry — otentikasi pid↔wid, GUI_REQ syscall (61)  │
└────────────────┬─────────────────────────────────────────┘
                 │ postMessage (Worker Thread)
┌────────────────▼──────────────────────────────────────────┐
│  USERLAND — Widget Toolkit Layer                          │
│                                                           │
│  ┌───────────────────┐ ┌──────────────────┐ ┌──────────┐  │
│  │ Emerald (GTK-like)│ │ Sapphire (future)│ │ Raw Proto│  │
│  │ Screen, Window,   │ │ Declarative,     │ │ GUI_REQ  │  │
│  │ div(), button(),  │ │ Reactive, VDOM   │ │ langsung │  │
│  │ alert(),confirm() │ │                  │ │          │  │
│  └────────┬──────────┘ └────────┬─────────┘ └────┬─────┘  │
│           └─────────────────────┴────────────────┘        │
│                                 │                         │
│                       PixelSpace Protocol                 │
│                (GUIAction, IDOMNode, IGUIPayload)         │
└───────────────────────────────────────────────────────────┘
```

> **Kunci Arsitektur:** Protokol PixelSpace stabil di tengah.  
> Toolkit (Emerald, Sapphire, dll) bisa berganti-ganti selama bicara protokol yang sama.  
> DOME sebagai display server — satu-satunya yang tahu browser.  
> **Setara: PixelSpace = X11/Wayland, Emerald = GTK/Qt.**

### Catatan Arsitektur: DOME sebagai Kompositor (Pilihan Desain)

Saat ini DOME tidak hanya berperan sebagai **relay + primitive DOM producer** (setara X server / Wayland compositor minimal), tetapi juga merangkap sebagai **kompositor window** — membangun titlebar, tombol minimize/close, drag, resize, dan manajemen focus/z-index langsung di `dome-client.html`.

#### Kenapa Tidak Dipisah Seperti X11/Wayland?

Ideal secara arsitektur, DOME seharusnya hanya menangani:
- **Relay WebSocket** — broadcast payload ke browser
- **Primitive DOM** — `createElement(tag)`, `removeChild`, `setAttribute` via `MOUNT_NODE`/`UNMOUNT_NODE`/`UPDATE_PROPS`

Dan **kompositor terpisah** (idealnya Asteracea) yang menangani dekorasi window via protokol PixelSpace yang sama.

Namun, keputusan untuk menggabungkan peran ini di DOME didasari oleh **pertimbangan latency**:

| Lapisan | Perkiraan Latency |
|---|---|
| `postMessage` Worker↔Kernel | ~0.1–0.5ms |
| SYS `GUI_REQ` processing | ~0.05ms |
| **Total sekali jalan** (Worker → Kernel → DOME) | **~0.5–1ms** |

Jika compositor terpisah sebagai aplikasi TSIX (Ring 4), setiap operasi window (drag, resize, klik close) harus melalui:

```
Browser → DOME relay → Kernel → Compositor (proses terpisah)
  → Compositor kirim aksi → DOME relay → Kernel → Worker asal
  → DOME → Browser
```

Ini berarti **2–4× round-trip latency** (~2–4ms) per operasi. Untuk drag window yang butuh update posisi 60fps (setiap ~16ms), overhead protokol ~3ms bisa memakan ~20% CPU hanya untuk komunikasi.

Dengan dekorasi built-in di DOME:
- **Drag**: `titleBar.onmousedown` → `document.onmousemove` → update `winEl.style.left/top` = **0ms protokol overhead**
- **Resize**: `mousedown` di handle → drag → update ukuran = **0ms protokol overhead**
- **Close/Minimize/Maximize**: tetap via WebSocket, tapi ini operasi diskret (sekali klik), bukan continuous

#### Ringkasan Tradeoff

| Aspek | Monolitik (saat ini) | Compositor Terpisah (ideal) |
|---|---|---|
| **Latency drag/resize** | Minimal (direct DOM) | ~2–4ms ekstra (via protokol) |
| **Arsitektur** | Campur aduk | Bersih, separation of concern |
| **Flexibilitas** | Dekorasi tetap (hardcoded) | Compositor bisa diganti/ganti tema |
| **Kompleksitas** | Sederhana (1 process) | Kompleks (koordinasi antar proses) |
| **State replay** | Bawaan DOME | Perlu sinkronisasi compositor |

**Kesimpulan**: Arsitektur saat ini adalah pilihan desain pragmatis — mengorbankan **kemurnian arsitektural** demi **performa interaksi** (drag/resize). Jika di masa depan compositor terpisah diimplementasikan, latensi bisa diminimalisir dengan teknik seperti *optimistic updates* (compositor update posisi lokal dulu, sync state belakangan) atau *direct DOM access* via iframe terpisah.

Lihat juga: [8.7 DOME Browser-Side Feature Matrix](#87-dome-browser-side-feature-matrix) untuk detail fungsi kompositor yang ada di DOME.

### Alur Data

```
Worker → GUI_REQ syscall → Kernel (auth pid↔wid) → DOME (WS broadcast) → Browser (DOM)
Browser → click/input → DOME (WS receive) → Kernel (SEND_MSG) → Worker (callback)
```

### Keamanan

| Pelanggaran | Sanksi Kernel |
|-------------|---------------|
| Payload format ngaco | `SIGKILL` — proses ditembak mati |
| Modifikasi window milik PID lain | `SIGSEGV` — segmentation fault |
| GUI_REQ tanpa DOME running | Error + rollback CREATE |
| Proses mati mendadak | Semua window auto-dihancurkan |

### Posisi PixelSpace vs Device Driver

PixelSpace **bukan** device driver. Dia **protokol display** — setara X11/Wayland, bukan `/dev/fb0`. Device driver adalah I/O primitif (baca/tulis karakter), PixelSpace adalah protokol display (JSON tree, event klik).

---

## 2. DOME Engine (Display Server)

**DOME** (DOM Engine) adalah display server PixelSpace — jembatan antara Kernel TSIX dan Web Browser host.

### Spesifikasi

| Properti | Nilai |
|----------|-------|
| Port | 8080 (HTTP + WebSocket) |
| Privilege | Ring 4 (akses `require('http')`, `require('ws')`) |
| Startup | Otomatis via `/etc/rc.local.ts` |
| Mode | Daemon (`shell.daemonize()`) |
| File | `/bin/dome.ts` |

### Fitur

- **Window Registry**: `wid` → `pid` → `WebSocket Client ID`
- **Z-Index Manager**: Window stacking order, focus tracking
- **State Replay**: Browser refresh (F5) — semua window + konten balik utuh
- **Fullscreen Support**: Window bisa fullscreen (z-index selalu di bawah)
- **Multi-Client**: Banyak browser bisa konek bersamaan
- **Titlebar Controls**: Minimize (─), Maximize (🗖) / Unmaximize (🗗) toggle, Close (✕)
- **Double-Click Titlebar**: Toggle maximize/unmaximize — baca `_isMaximized` dari window entry
- **Resize 4 Pojok**: Drag handles NW/NE/SW/SE, menggantikan CSS `resize: both`
- **Context Menu Taskbar**: Right-click `.tsix-taskbar-btn[data-wid]` → **Move** (arrow keys + Enter/Escape/click) / **Close** (send close_window)
- **Move Mode**: Arrow keys 8px step, outline hijau + ✚ crosshair tengah + `cursor:move`, update `_origRect` setelah confirm
- **Window State Persistence**: Browser kirim `window_state` via WebSocket tiap drag/resize/unmaximize. Server simpan di `GuedWindowEntry` fields: `winLeft`, `winTop`, `winWidth`, `winHeight`, `isMaximized`. Replay pake state tsb + kirim `MAXIMIZE_WINDOW` kalo perlu.
- **Minimize via [data-wid]**: Minimize animasi cari taskbar button by `[data-wid="xxx"]` — bukan closest by distance
- **Unmaximize via _unmaximizeRect**: Pre-maximize size disimpan di `_unmaximizeRect` (tidak ditimpa MINIMIZE)
- **ResizeObserver guard**: Update `_origRect` cuma kalo `!isMaximized && !animating`
- **State Pruning (pruneWindowState)**: Saat node di-unmount, DOME membersihkan `windowStates` — menghapus MOUNT_NODE & UPDATE_PROPS yang cocok dengan `targetId` atau `node.id`. Mencegah orphan state leak ke replay.
- **Orphan Discard**: Browser-side `handleMountNode` *discard* (bukan fallback ke `win.content`) child nodes yang parent-nya tidak ditemukan. Mencegah residue dialog/modal setelah F5.
- **Overlay Layer Search**: `findElementById` mencari di 3 level: `win.el` → `__global_start_menu__` → `__tsix_overlay_layer__`. Launcher overlay, dialog, modal semuanya bisa ditemukan meskipun diekstrak ke overlay layer.
- **HTML Client Terpisah**: `dome-client.html` file terpisah (bukan inline template literal), dibaca via TSIX sandboxed filesystem API (`fs.open`→`fs.read`→`fs.close`).

### Log

Semua aktivitas DOME tercatat di `/var/log/syslog` dengan tag `[dome]`:
```
tail /var/log/syslog | grep dome
```

---

## 3. Asteracea (Window Manager)

**Asteracea** adalah window manager TSIX TDE — berjalan sebagai aplikasi PixelSpace mandiri. Menggantikan Krisan (legacy) dengan arsitektur yang lebih modular.

### Spesifikasi

| Properti | Nilai |
|----------|-------|
| Mode | Fullscreen frameless (`new Window(..., fullscreen=true, frameless=true)`) |
| Startup | Otomatis via `/etc/rc.local.ts` (setelah DOME) |
| File | `/bin/asteracea.ts` |
| Menu | `/etc/asteracea/menu/*.menu` |

### Fitur

- 🖥️ **Wallpaper** — b64 format file, gradient background
- 🔍 **Launcher** — overlay panel dengan fuzzy search, grid app icons
- 🕐 **Clock** — update setiap 15 detik
- 📋 **Taskbar** — pinned apps + running apps + foreign apps dengan badge RI (Running Indicator)
- 🚀 **Launch** — `shell.exec()` untuk spawn app GUI
- ✨ **Login Screen** — bcrypt auth via `/etc/passwd` + `/etc/shadow`
- 🖱️ **Desktop Context Menu (DCM)** — right-click desktop → Refresh / Change Wallpaper
- 🏷️ **Badge RI** — pulsing green dot pada taskbar button saat app running
- 📌 **Pinned Launcher** — taskbar button dengan ID `pl-${appId}`, data-wid di-update saat window created
- 🌐 **Foreign Apps** — aplikasi dari terminal/shell otomatis dapat taskbar button via PID file

### Pinned vs Running Taskbar

| Aspek | Pinned Launcher | Running App (non-pinned) | Foreign App (non-launcher) |
|-------|----------------|-------------------------|---------------------------|
| Button ID | `pl-${app.id}` (fixed) | `tb-${appId}-${pid}` (per PID) | `tb-__foreign_${pid}-${pid}` |
| data-wid | Di-set via `updateProps(pl-${appId}, { data-wid })` | Di-set via `updateProps(tb-..., { data-wid })` | Di-set di mount |
| Badge RI | Include dari awal (`display:none`), di-toggle visible | Di-mount bersamaan button | Di-mount bersamaan button |
| Cleanup | Badge hidden (`display:none`), button tetap | Button di-unmount | Button di-unmount |
| Icon | Dari `.menu` file | Dari `.menu` file | 💻 (fixed) |

### IPC Lifecycle Events

Asteracea listen `ipc_message` untuk:
- `GUI_WINDOW_CREATED` → track wid + set data-wid; foreign app → auto-create TB button
- `GUI_WINDOW_MINIMIZED/RESTORED` → update taskbar button style
- `GUI_WINDOW_CLOSED` → cleanup taskbar + hide badge
- `GUI_WINDOW_ERROR` → tampilkan error popup langsung (tanpa nunggu app exit)
- `contextmenu_desktop` → buka Desktop Context Menu

### Format File Menu

File di `/etc/asteracea/menu/*.menu`:
```
name=Form Demo
icon=📋
command=gui-demo
params=--debug --port 3000
pinned_launcher=true
```

Komen pakai `#`. Satu file = satu menu item.

---

## 4. Memulai — Hello World

File: `/bin/gui-hello-world.ts` — hanya 12 baris!

```typescript
import { Program, std } from "@tsix/Application";
import { Screen, div, h1, paragraph } from "@tsix/emerald";

export const main = Program(async (args: string[]) => {
    const app = new Screen("Hello World");

    await app.mount(div({ id: "root", style: { padding: "24px", textAlign: "center" } },
        h1({ text: "Hello, World! 🌍", style: { color: "#4caf50" } }),
        paragraph({ text: "Powered by PixelSpace + DOME" }),
    ));

    await app.loopUntilClose();
});
```

Jalankan: `gui-hello-world`

---

## 5. Primitif UI

Semua primitif dari `@tsix/emerald` (Emerald Widget Toolkit):

### Factory Functions

| Fungsi | Tag HTML | Contoh |
|--------|----------|--------|
| `div(props, ...children)` | `<div>` | `div({id:"box"}, text("Hi"))` |
| `button(props, ...children)` | `<button>` | `button({id:"btn", text:"OK"})` |
| `input(props)` | `<input>` | `input({id:"email", type:"text"})` |
| `text(content)` | TextNode | `text("Hello")` |
| `span(props, ...children)` | `<span>` | `span({text:"Inline"})` |
| `h1/h2/h3(props, ...children)` | `<h1>`-`<h3>` | `h2({text:"Title"})` |
| `paragraph(props, ...children)` | `<p>` | `paragraph({text:"Desc"})` |
| `textarea(props)` | `<textarea>` | `textarea({id:"bio", rows:5})` |
| `selectBox(props, options)` | `<select>` | `selectBox({id:"lang"}, [...])` |

### Menambah Elemen Baru

Tambah factory function di `src/mirror/lib/emerald.ts`. Browser engine (`dome.ts`) otomatis render semua tag HTML standard via `document.createElement()`.

### Props yang Didukung

| Prop | Browser Behavior |
|------|-----------------|
| `text` | `el.textContent = value` |
| `innerHTML` | `el.innerHTML = value` (render HTML!) |
| `style` | `Object.assign(el.style, value)` — CSS object |
| `disabled` | `el.setAttribute('disabled', '')` |
| `className` | `el.className = value` |
| `placeholder` | `el.setAttribute('placeholder', value)` |
| `type`, `value`, `rows`, `cols`, `href` | `el.setAttribute(key, value)` |
| `key.startsWith('data-')` | `el.setAttribute(key, String(value))` — untuk data-wid dll |
| `onClickId` | Attach click listener + kirim event ke Worker |
| `onInputId` | Attach input listener + kirim event ke Worker |
| `onKeydownId` | Attach keydown listener + kirim event (`value: e.key`) ke Worker |

---

## 6. Screen Wrapper

`Screen` adalah wrapper tingkat tinggi untuk `Window`. Handle mount, setContent, event, flush, dan fullscreen otomatis.

### API

```typescript
class Screen {
    constructor(
        title: string | ScreenOptions,
        lib?: UserLib,
        fullscreen?: boolean,
        width?: number,
        height?: number,
        resizable?: boolean,
        frameless?: boolean,
        maximizable?: boolean,
    )

    // Properties
    readonly win: Window
    running: boolean
    state: Record<string, any>

    // Mount node ke window (parentId opsional)
    async mount(node: IDOMNode, parentId?: string): Promise<void>

    // Clear container + isi ulang — gak numpuk!
    async setContent(containerId: string, ...children: IDOMNode[]): Promise<void>

    // Update properti element (batched, auto-flush)
    async update(targetId: string, props: Record<string, any>): Promise<void>

    // Bind event handler (auto-flush setelah bind)
    async on(targetId: string, event: "click"|"input"|"keydown"|"close", cb: Function): Promise<void>

    // State management
    setState(patch: Record<string, any>): void

    // Stay alive sampai window ditutup — blocking
    async loopUntilClose(): Promise<void>

    // Tutup window + cleanup
    async close(): Promise<void>

    // Lifecycle — Window Management
    async minimize(): Promise<void>
    async restore(): Promise<void>
    async maximize(): Promise<void>
    async unmaximize(): Promise<void>
}
```

### Pattern Dasar

```typescript
// 1. Buat
const app = new Screen("My App");

// 2. Mount UI
await app.mount(div({id:"root"}, ...));

// 3. Bind events (auto-flush)
await app.on("btn", "click", async () => { ... });

// 4. Stay alive
await app.loopUntilClose();
```

---

## 7. Event Handling

### Pattern: Mount → Bind → Loop

```typescript
const app = new Screen("My App");

await app.mount(div({ id: "root" },
    button({ id: "btn-ok", text: "OK" }),
    input({ id: "name", type: "text" }),
));

await app.on("btn-ok", "click", async () => {
    await app.update("btn-ok", { text: "Clicked!" });
});

await app.on("name", "input", async (ev) => {
    // ev.value berisi teks terbaru dari input
    console.log("User typed:", ev.value);
});

await app.loopUntilClose();
```

### Dynamic Content (setContent)

Untuk list yang berubah-ubah (file explorer, daftar item):

```typescript
async function refresh() {
    const items = await fetchData();
    const rows = items.map(item =>
        div({ id: "row-" + item.id, onClickId: "row-" + item.id },
            text(item.name)
        )
    );
    // Auto clear + mount, gak numpuk
    await app.setContent("list-container", ...rows);

    // Re-bind events — perlu setelah setContent
    items.forEach(item => {
        app.on("row-" + item.id, "click", () => handleClick(item));
    });
}
```

---

## 8. Window Management

### 8.2 Event Types (Browser → Worker)

Browser mengirim event ke Worker via DOME:

```typescript
// Event dari titlebar / taskbar / context menu
"close_window"      → Worker: Window.close()
"minimize_window"   → Worker: Window.minimize()
"restore_window"    → Worker: Window.restore()
"maximize_window"   → Worker: Window.maximize()
"unmaximize_window" → Worker: Window.unmaximize()

// Event dari input/button
"click"   → Worker: onClick callback
"input"   → Worker: onInput callback
"keydown" → Worker: onKeydown callback (value: "Enter", "Tab", etc)

// Event dari DOME internal (tidak ke Worker)
"window_state" → Server simpan posisi/size/isMaximized untuk state persistence
```

### 8.3 Window Lifecycle Events (Worker → Parent)

Window mengirim event ke parent process via IPC:

| Event | Dikirim saat |
|-------|-------------|
| `GUI_WINDOW_CREATED` | Constructor selesai |
| `GUI_WINDOW_MINIMIZED` | `minimize()` dipanggil |
| `GUI_WINDOW_RESTORED` | `restore()` dipanggil |
| `GUI_WINDOW_MAXIMIZED` | `maximize()` dipanggil |
| `GUI_WINDOW_UNMAXIMIZED` | `unmaximize()` dipanggil |
| `GUI_WINDOW_CLOSED` | `close()` dipanggil |

### 8.4 DOME Browser-Side Window State

DOME Engine menyimpan state window di `GuedWindowEntry`:

```typescript
interface GuedWindowEntry {
    wid: string; pid: number; title: string;
    zIndex: number; focused: boolean;
    wsClientId: string | null; createdAt: number;
    fullscreen?: boolean; width?: number; height?: number;
    resizable?: boolean; frameless?: boolean; maximizable?: boolean;
    // Persistence state (across browser refresh)
    isMaximized?: boolean;
    winLeft?: number; winTop?: number;
    winWidth?: number; winHeight?: number;
}
```

Browser-side `windows` Map memiliki state tambahan:

```typescript
// Browser-side window entry (window handler)
interface WindowEntry {
    el: HTMLElement;         // DOM element .tsix-window
    content: HTMLElement;   // .tsix-content element
    pid: number;
    // Internal state
    _isMaximized?: boolean;
    _animating?: boolean;
    _savedRect?: { left, top, width, height };     // untuk minimize→restore animasi
    _unmaximizeRect?: { left, top, width, height }; // untuk unmaximize (tidak ditimpa MINIMIZE)
    _taskbarTarget?: { left, top };                 // posisi taskbar button untuk animasi
    _savedResize?: string;
    _savedMinHeight?: string;
}
```

### 8.5 State Persistence (Browser Refresh)

Browser refresh → WebSocket disconnect → reconnect:

1. Server replay `CREATE_WINDOW` dengan `posX: entry.winLeft`, `posY: entry.winTop`, `posW: entry.winWidth`, `posH: entry.winHeight`
2. Browser pake posisi tsb (`msg.posX ?? defaultLeft`, `msg.posY ?? defaultTop`)
3. Kalo `entry.isMaximized = true`, server kirim `MAXIMIZE_WINDOW` setelah CREATE_WINDOW
4. Browser panggil `handleMaximizeWindow` → window jadi full viewport
5. Hasil: posisi, size, dan maximize state tetap utuh setelah refresh

### 8.6 Context Menu Taskbar

Right-click pada `.tsix-taskbar-btn[data-wid]`:

```
Menu:
├── Move   → Arrow keys 8px step + outline hijau + ✚ crosshair
│            Enter confirm / Escape cancel / Click cancel
│            Update _origRect setelah confirm
│
└── Close  → socket.send({ wid, eventType: "close_window" })
```

### 8.7 DOME Browser-Side Feature Matrix

| Fitur | Trigger | Mekanisme |
|---|---|---|
| Double-click titlebar | `titleBar.ondblclick` | Baca `windows.get(wid)._isMaximized`, toggle |
| Drag | `titleBar.onmousedown` | `document.onmousemove`, update `_origRect` |
| Resize 4 pojok | `mousedown` di handle | Drag NW/NE/SW/SE, update `_origRect` |
| Maximize | Tilebar button / double-click | `handleMaximizeWindow` → 100vw×100vh |
| Unmaximize | Titlebar button / double-click | `handleUnmaximizeWindow` → pake `_unmaximizeRect` |
| Minimize | Titlebar button | Animasi ke taskbar button via `[data-wid]` |
| Restore | Taskbar button | Animasi dari taskbar button ke `_savedRect` |
| Context menu | Right-click `.tsix-taskbar-btn` | Menu Move/Close + keyboard/mouse handler |
| Sync state | `syncWindowState(wid)` | Kirim `window_state` ke server tiap drag/resize/unmaximize |

---

## 9. Aplikasi Lengkap

### 9.1 Asteracea — Window Manager
File: `/bin/asteracea.ts` | Fullscreen frameless | Auto-start rc.local
Fitur: Login screen, Wallpaper, App Launcher, Taskbar, Clock, Launch apps.

### 9.2 GUI Demo — Form Interaktif
File: `/bin/gui-demo.ts` | ~100 baris
Fitur: Input, textarea, select, tema, submit. Value dicetak ke CLI + browser.

### 9.3 File Cruiser — VFS Explorer
File: `/bin/file-cruiser.ts` | ~165 baris
Fitur: Browse VFS, klik navigasi, ".." parent, status bar.

### 9.4 Hello World
File: `/bin/gui-hello-world.ts` | ~12 baris
Fitur: Teks "Hello World" di tengah window.

---

## 10. Referensi API

### IDOMNode
```typescript
interface IDOMNode {
    id: string;            // Unik dalam satu window
    tag: string;           // "div", "button", "text", "input", ...
    props: Record<string, any>;
    children: IDOMNode[];
}
```

### IGUIPayload (PixelSpace Protocol)
```typescript
interface IGUIPayload {
    syscall: "GUI_REQ";
    pid: number;
    wid: string;           // Window ID (UUID)
    action: GUIAction;
    targetId?: string;
    node?: IDOMNode;
    props?: Record<string, any>;
}
```

### GUIAction
```typescript
enum GUIAction {
    CREATE_WINDOW     = "CREATE_WINDOW",
    DESTROY_WINDOW    = "DESTROY_WINDOW",
    MOUNT_NODE        = "MOUNT_NODE",
    UNMOUNT_NODE      = "UNMOUNT_NODE",
    UPDATE_PROPS      = "UPDATE_PROPS",
    MINIMIZE_WINDOW   = "MINIMIZE_WINDOW",
    RESTORE_WINDOW    = "RESTORE_WINDOW",
    MAXIMIZE_WINDOW   = "MAXIMIZE_WINDOW",
    UNMAXIMIZE_WINDOW = "UNMAXIMIZE_WINDOW",
    REGISTER_DAEMON   = "REGISTER_DAEMON",
}
```

### BrowserMessage (dari DOME Server ke Browser)
```typescript
interface BrowserMessage {
    type: "CREATE_WINDOW" | "DESTROY_WINDOW"
        | "MOUNT_NODE" | "UNMOUNT_NODE" | "UPDATE_PROPS"
        | "MINIMIZE_WINDOW" | "RESTORE_WINDOW"
        | "MAXIMIZE_WINDOW" | "UNMAXIMIZE_WINDOW"
        | "FOCUS" | "TERM_OUTPUT" | "CM_SET_VALUE";
    wid?: string;
    targetId?: string;
    node?: IDOMNode;
    props?: Record<string, any>;
    data?: string;
    value?: any;
    // Replay fields (state persistence)
    posX?: number;  // saved left position
    posY?: number;  // saved top position
    posW?: number;  // saved width
    posH?: number;  // saved height
}
```

### IBrowserEvent (dari Browser ke DOME Server)
```typescript
interface IBrowserEvent {
    wid: string;
    targetId: string;
    eventType: "click" | "input" | "keydown" | "close_window"
        | "minimize_window" | "restore_window"
        | "maximize_window" | "unmaximize_window"
        | "window_state"     // position/size sync for persistence
        | "term_resize" | "term_input" | "cm_change" | "focus";
    value?: string | number;
}
```

### Syscall
| Kode | Nama | Fungsi |
|------|------|--------|
| 61 | `GUI_REQ` | PixelSpace Protocol — semua operasi GUI |

### File Penting
| File | Peran |
|------|-------|
| `src/common/GUITypes.ts` | Kontrak data (interface, enum) |
| `src/kernel/GUIRegistry.ts` | Window registry + otentikasi |
| `src/kernel/Syscalls.ts` | Handler `GUI_REQ` + security |
| `src/mirror/bin/dome.ts` | DOME Engine (display server) |
| `src/mirror/bin/dome-client.html` | DOME Browser-side engine (presentation, file terpisah) |
| `src/mirror/bin/asteracea.ts` | Asteracea Window Manager |
| `src/mirror/lib/emerald.ts` | Emerald Widget Toolkit `@tsix/emerald` |
| `src/mirror/etc/rc.local.ts` | Auto-start DOME + Asteracea |
| `/etc/asteracea/wm-pid` | PID file — emerald broadcast event ke Asteracea |

---

## 11. State Replay & Pruning

**State Replay** adalah mekanisme DOME untuk memulihkan UI saat browser reconnect (F5). Semua MOUNT_NODE dan UPDATE_PROPS disimpan di `windowStates` (Map<wid, state[]>) dan dikirim ulang ke browser baru via WebSocket.

### Alur Replay

```
Browser F5 → WebSocket reconnect
  → DOME kirim CREATE_WINDOW (semua window aktif)
  → DOME kirim semua stored states (MOUNT_NODE + UPDATE_PROPS)
  → Browser build ulang UI + terima event dari user
```

### State Pruning (`pruneWindowState`)

Saat `UNMOUNT_NODE` dipanggil, DOME membersihkan state terkait dari `windowStates`:

1. **Collect**: Cari MOUNT_NODE yang cocok (via `nodeIds.has(targetId)`), kumpulin SEMUA nodeId dari tree-nya (termasuk child nodes)
2. **Filter**: Hapus MOUNT_NODE yang targetId atau nodeId-nya ada di kumpulan. UPDATE_PROPS hanya dihapus jika targetId exact match

Ini mencegah child states (dari `setContent()`) tetap tersisa setelah parent di-unmount, yang bisa menyebabkan residu DOM saat F5.

```typescript
const allIds = new Set<string>([targetId]);
for (const state of states) {
    if (state?.type === "MOUNT_NODE" && state.node) {
        const nodeIds = new Set<string>();
        collectNodeIds(state.node, nodeIds);
        if (nodeIds.has(targetId)) {
            for (const id of nodeIds) allIds.add(id);
        }
    }
}
const filtered = states.filter((state: any) => {
    if (state?.type === "MOUNT_NODE") {
        const nodeIds = new Set<string>();
        collectNodeIds(state.node, nodeIds);
        if (allIds.has(state.targetId)) return false;
        if ([...nodeIds].some(id => allIds.has(id))) return false;
    }
    if (state?.type === "UPDATE_PROPS") {
        if (state.targetId === targetId) return false;
    }
    return true;
});
```

### Browser-Side Orphan Discard

Di `dome-client.html`, jika `handleMountNode` menerima MOUNT_NODE dengan `targetId` yang tidak ditemukan di DOM, node **di-discard** (dibuang) — bukan di-fallback ke `win.content`. Ini mencegah:

- Wallpaper dialog child states muncul di desktop setelah F5
- Login overlay residue
- Modal/dialog orphan elements

```javascript
if (parent) {
    parent.appendChild(domEl);
} else {
    // DISCARD — parent not found
    console.log('[DEBUG] Orphan discarded:', node.id, targetId);
}
```

### Overlay Layer Search

`findElementById(wid, nodeId)` mencari di 3 level:
1. `win.el.querySelector([data-tsix-id="..."])` — di dalam window
2. `__global_start_menu__` — di start menu global
3. `__tsix_overlay_layer__` — di overlay layer (launcher, dialog)

Ini memungkinkan elemen yang di-extract ke overlay layer (seperti `launcher-grid`) tetap bisa ditemukan oleh mount/replay.

---

## 11. State Replay & Pruning

### Arsitektur Replay

DOME Engine menyimpan riwayat semua operasi GUI (`MOUNT_NODE`, `UPDATE_PROPS`) per window di `windowStates` map. Saat browser connect/reconnect:

```
Browser Connect
     │
     ▼
Server → broadcast CREATE_WINDOW (dengan saved posX/posY/posW/posH)
Server → broadcast semua MOUNT_NODE states (urutan FIFO)
Server → broadcast semua UPDATE_PROPS states
Server → broadcast MAXIMIZE_WINDOW jika entry.isMaximized
```

Browser memproses pesan berurutan di `socket.onmessage`. Setiap state di-replay persis seperti saat pertama kali dikirim — `buildDOM` membuat elemen HTML, `handleUpdateProps` mengaplikasikan properti.

### WindowState Pruning (pruneWindowState)

Saat node di-unmount, DOME membersihkan `windowStates` untuk mencegah state leak:

```typescript
function pruneWindowState(wid: string, targetId: string): void {
    const states = windowStates.get(wid) || [];
    const filtered = states.filter((state: any) => {
        if (state?.type === "MOUNT_NODE") {
            const nodeIds = new Set<string>();
            collectNodeIds(state.node, nodeIds);
            if (state.targetId === targetId || nodeIds.has(targetId))
                return false; // Hapus yang cocok
        }
        if (state?.type === "UPDATE_PROPS") {
            if (state.targetId === targetId) return false;
        }
        return true;
    });
    windowStates.set(wid, filtered);
}
```

Pruning **hanya** menghapus state yang exact match `targetId` atau `node.id`. Anak-anak dari node tersebut (misalnya file rows yang di-mount via `setContent` di dalam dialog) TIDAK ikut terhapus — mereka adalah MOUNT_NODE terpisah dengan `targetId` sendiri.

### Handling Orphan Nodes di Browser

Browser-side `handleMountNode` memiliki fallback yang aman:

```javascript
if (targetId) {
    const parent = findElementById(wid, targetId);
    if (parent) {
        parent.appendChild(domEl);     // ✅ Parent ditemukan
    } else {
        // ❌ Parent tidak ditemukan — DISCARD!
        // Jangan fallback ke win.content! Ini mencegah
        // residue dialog/modal/wallpaper muncul setelah F5
    }
}
```

Jika parent tidak ditemukan (misalnya dialog sudah di-close sebelum F5), node **di-discard** (dibuang) — bukan di-fallback ke `win.content`. Ini mencegah `setContent` children dari dialog/modal yang sudah ditutup muncul sebagai residu di desktop setelah refresh.

### findElementById — Overlay Layer Search

`findElementById` mencari parent element di 3 level:

| Level | Target | Contoh |
|-------|--------|--------|
| 1 | `win.el.querySelector()` | Taskbar elements: `tb-pinned`, `clock`, `btn-start` |
| 2 | `__global_start_menu__` | Start menu (global, di document.body) |
| 3 | `__tsix_overlay_layer__` | Overlay: `launcher-grid`, `launcher-search` |

Elemen yang diekstrak ke `__tsix_overlay_layer__` (seperti launcher grid, taskbar pinned, dll) tetap bisa ditemukan karena `findElementById` mencari di overlay layer sebagai fallback.

### Minimize / Restore via [data-wid]

Minimize/Restore animation menggunakan **helper function**:

```javascript
function getTaskbarBtnTarget(wid) {
    const btn = document.querySelector('[data-wid="' + wid + '"]');
    if (!btn) return null;
    const br = btn.getBoundingClientRect();
    return {
        left: (br.left + br.width / 2 - 60) + 'px',
        top: (br.top + br.height / 2 - 14) + 'px',
    };
}
```

- **Minimize**: Panggil `getTaskbarBtnTarget(wid)` saat minimize → animasi ke posisi TB button.
- **Restore**: Panggil `getTaskbarBtnTarget(wid)` LAGI saat restore (fresh lookup) → animasi dari posisi TB terkini ke saved position.

Mengapa fresh lookup? Karena taskbar bisa berubah (app lain buka/tutup) antara minimize dan restore. Fresh lookup memastikan animasi restore selalu dari posisi TB yang benar.

### Kaleidoskop: Riwayat Perubahan Sesi Ini

| No | Masalah | Root Cause | Solusi |
|----|---------|------------|--------|
| 1 | HTML client inline di `dome.ts` | Template literal 1300+ baris | Ekstrak ke `dome-client.html` |
| 2 | Node.js `fs.readFileSync` dipakai | Sandbox blocks raw require | Ganti ke TSIX `fs.open()`→`fs.read()`→`fs.close()` |
| 3 | Minimize/Restore posisi salah | Selector complex & stale target | Helper `getTaskbarBtnTarget()` dengan fresh lookup |
| 4 | Badge RI tidak muncul di pinned | ID mismatch (`tb-...` vs `pl-...`) | Pakai `pl-${appId}-badge` |
| 5 | Badge RI tidak hilang saat close | Unmount wrong element | Hide badge (`display:none`) instead of unmount |
| 6 | Data-wid tidak di-set untuk pinned | `updateProps(inst.taskbarId, ...)` | Ganti ke `pl-${appId}` |
| 7 | Wallpaper dialog residue after F5 | Child states tidak di-prune | Browser-side discard orphan MOUNT_NODEs |
| 8 | Launcher content spilled after F5 | Fallback `win.content` untuk orphan | Ganti ke **discard** — jangan mount orphan |
| 9 | Minimize position wrong for pinned | TB button ID tidak match | Konsisten pakai `pl-${appId}` |
| 10 | App dari terminal gak dapat TB | Emerald cuma kirim ke parent PID | Broadcast ke Asteracea via `/etc/asteracea/wm-pid` |
| 11 | Foreign app gak muncul di taskbar | Asteracea gak tahu ada window baru | `registerForeignApp()` auto-create TB + waitpid cleanup |

---

## Piagam Antigonon (Aturan Strict untuk AI Agent)

1. **NO DOM di Userland** — `@tsix/emerald` TIDAK boleh sentuh `document.*` atau `window.*`
2. **State-Sync** — Jangan kirim `UPDATE_PROPS` dalam tight loop; gunakan batching
3. **Memory Cleanup** — Setiap node di-unmount, bersihkan event listener
4. **Type Safety** — Semua payload harus sesuai `IGUIPayload`, payload cacat → `SIGKILL`

---

*PixelSpace Protocol v1.2 — TSIX Desktop Environment*  
*"Your pixels, your space." 🎨*
