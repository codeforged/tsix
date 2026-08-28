# Emerald in a Nutshell

**Tuntunan Lengkap Membuat Aplikasi GUI Berbasis TSIX Menggunakan Emerald Widget Toolkit**

> Versi 1.4 | 2026-08-15

---

## Daftar Isi

1. [Apa Itu Emerald?](#1-apa-itu-emerald)
2. [Arsitektur & Alur Data](#2-arsitektur--alur-data)
3. [Memulai: Hello World](#3-memulai-hello-world)
4. [Factory Functions: Membangun UI](#4-factory-functions-membangun-ui)
5. [Screen: High-Level Wrapper](#5-screen-high-level-wrapper)
6. [Event Handling](#6-event-handling)
7. [Dynamic Content & setContent](#7-dynamic-content--setcontent)
8. [Alert, Confirm & Question](#8-alert-confirm--question)
9. [File Dialogs](#9-file-dialogs)
10. [Window Manager Pattern](#10-window-manager-pattern)
11. [Connected Widgets — Self-Rendering Components](#11-connected-widgets--self-rendering-components)
12. [Managed Timers](#12-managed-timers)
13. [Studi Kasus: Aplikasi Lengkap](#13-studi-kasus-aplikasi-lengkap)
14. [Referensi Cepat API](#14-referensi-cepat-api)
15. [Best Practices & Anti-Patterns](#15-best-practices--anti-patterns)

---

## 1. Apa Itu Emerald?

**Emerald** (`@tsix/emerald`) adalah high-level GUI toolkit untuk ekosistem TSIX. Diibaratkan di dunia Linux, Emerald adalah **GTK/Qt**-nya TSIX — menyediakan `Window`, `Screen`, factory functions (`div()`, `button()`, `input()`, dll), serta komponen siap pakai seperti `alert()`, `confirm()`, dan file dialogs.

Semua UI yang kamu bangun dengan Emerald dirender di **browser host** melalui **PixelSpace Protocol** — bukan pixel buffer seperti X11/Wayland, melainkan **DOM-Based Remote Rendering** via JSON.

### Posisi Emerald dalam Arsitektur

```
┌─────────────────────────────────────────┐
│              BROWSER (Host)             │
│  Render DOM nyata, tangkap klik/input   │
└────────────────┬────────────────────────┘
                 │ WebSocket :8080
┌────────────────▼────────────────────────┐
│    DOME: DOM-Engine (Display Server)    │
│  Window registry, Z-index, relay event  │
└────────────────┬────────────────────────┘
                 │ GUI_REQ syscall (61)
┌────────────────▼────────────────────────┐
│            KERNEL (Ring 1)              │
│  Otentikasi pid↔wid, routing syscall    │
└────────────────┬────────────────────────┘
                 │ postMessage (Worker)
┌────────────────▼────────────────────────┐
│ EMERALD — Widget Toolkit (kamu di sini) │
│  Screen, Window, div(), button(), ...   │
└─────────────────────────────────────────┘
```

> **Kunci:** Aplikasi GUI TSIX tidak punya akses ke `document`, `window`, atau API browser apa pun. Semua UI dibangun sebagai **Virtual DOM Tree** (`IDOMNode`) yang dikirim via syscall.

---

## 2. Arsitektur & Alur Data

### Alur Mounting UI

```
Worker App                  Kernel                  DOME                    Browser
─────┬───────────────────────┬───────────────────────┬───────────────────────┬─────
     │ GUI_REQ (MOUNT_NODE)  │                       │                       │
     │──────────────────────►│                       │                       │
     │                       │ gui_request event     │                       │
     │                       │──────────────────────►│                       │
     │                       │                       │ WebSocket JSON        │
     │                       │                       │──────────────────────►│
     │                       │                       │                       │ createElement
     │                       │                       │                       │ appendChild
```

### Alur Event (Klik/Input dari Browser)

```
Browser                  DOME                    Kernel                  Worker App
─────┬───────────────────┬───────────────────────┬───────────────────────┬─────
     │ WebSocket JSON    │                       │                       │
     │──────────────────►│                       │                       │
     │                   │ SEND_MSG ke pid       │                       │
     │                   │──────────────────────►│                       │
     │                   │                       │ ipc_message event     │
     │                   │                       │──────────────────────►│
     │                   │                       │                       │ callback
     │                   │                       │                       │ updateProps
```

### Operasi GUI (GUIAction)

| Action              | Kegunaan                           |
| ------------------- | ---------------------------------- |
| `CREATE_WINDOW`     | Bikin jendela baru                 |
| `DESTROY_WINDOW`    | Hancurkan jendela                  |
| `MOUNT_NODE`        | Pasang elemen ke parent            |
| `UNMOUNT_NODE`      | Lepas elemen                       |
| `UPDATE_PROPS`      | Ubah properti elemen               |
| `MINIMIZE_WINDOW`   | Sembunyikan jendela                |
| `RESTORE_WINDOW`    | Kembalikan jendela (dari minimize) |
| `MAXIMIZE_WINDOW`   | Perbesar jendela ke layar penuh    |
| `UNMAXIMIZE_WINDOW` | Kembalikan jendela dari maximize   |

---

## 3. Memulai: Hello World

### Struktur Dasar Aplikasi

```typescript
import { Program } from "@tsix/Application";
import { Screen, div, h1, paragraph } from "@tsix/emerald";

export const main = Program(async (args: string[]) => {
  // 1. Buat Screen (jendela)
  const app = new Screen({ title: "Judul Aplikasi" });

  // 2. Mount UI tree
  await app.mount(
    div(
      { id: "root", style: { padding: "24px" } },
      h1({ text: "Hello, World! 🌍" }),
      paragraph({ text: "Aplikasi TSIX pertamaku!" }),
    ),
  );

  // 3. Loop sampai window ditutup
  await app.loopUntilClose();
});
```

### Tiga Langkah Wajib

1. **`new Screen({ title: "..." })`** — buat jendela
2. **`app.mount(node)`** — pasang UI
3. **`app.loopUntilClose()`** — stay alive

> **PENTING:** `loopUntilClose()` itu **blocking** — dia akan menahan eksekusi sampai user menutup jendela. Selalu letakkan di akhir `main()`.

---

## 4. Factory Functions: Membangun UI

Semua factory functions menghasilkan **`IDOMNode`** — objek Virtual DOM yang akan dirender browser.

### 4.1 `text(content)` — Text Node

```typescript
text("Hello World");
// → <TextNode>Hello World</TextNode>
```

### 4.2 `div(props?, ...children)` — Container

```typescript
div(
  { id: "box", style: { padding: "16px", background: "#16213e" } },
  text("Konten di dalam div"),
);
```

### 4.3 `button(props?, ...children)` — Tombol

```typescript
// Tombol sederhana dengan teks
button({ id: "btn1", text: "Klik Saya!" });

// Tombol dengan style kustom
button({
  id: "btn-submit",
  text: "✅ Submit",
  onClickId: "btn-submit", // WAJIB untuk event handling
  style: {
    background: "#4caf50",
    color: "white",
    padding: "10px 20px",
    borderRadius: "6px",
    cursor: "pointer",
  },
});
```

> **Props spesial button:** `text` (teks di dalam), `disabled` (`"1"` untuk disable)

### 4.4 `input(props)` — Input Field

```typescript
input({
  id: "email",
  type: "text",
  placeholder: "email@contoh.com",
  value: "default@mail.com", // nilai awal
  style: { width: "100%", padding: "8px" },
});
```

> **Type yang didukung:** `"text"`, `"password"`, `"number"`, dll.

### 4.5 `textarea(props)` — Multiline Input

```typescript
textarea({
  id: "bio",
  placeholder: "Ceritakan tentang dirimu...",
  rows: 5, // jumlah baris
  style: { width: "100%" },
});
```

### 4.6 `span(props?, ...children)` — Inline Text

```typescript
span({ text: "Status: ", style: { color: "#888" } });
```

### 4.7 `h1/h2/h3(props?, ...children)` — Headings

```typescript
h2({ text: "Judul Section", style: { color: "#4caf50", fontSize: "18px" } });
```

### 4.8 `paragraph(props?, ...children)` — Paragraf

```typescript
paragraph({
  text: "Ini adalah paragraf panjang...",
  style: { lineHeight: "1.6", color: "#ccc" },
});
```

### 4.9 `selectBox(props, options)` — Dropdown

```typescript
selectBox({ id: "bahasa" }, [
  { value: "id", text: "🇮🇩 Bahasa Indonesia" },
  { value: "en", text: "🇬🇧 English" },
  { value: "jp", text: "🇯🇵 日本語" },
]);
```

### 4.10 `badge(props?)` — Dot Indikator

```typescript
badge(); // dot hijau, berdenyut
badge({ color: "#f44336" }); // dot merah, berdenyut
badge({ color: "#ff9800", pulse: false }); // dot oranye, statis
badge({ size: 8 }); // custom ukuran (default: 6px)
```

### 4.11 `taskbarButton(props)` — Tombol Taskbar

```typescript
// Tombol taskbar dengan icon + label
taskbarButton({ icon: "📝", label: "Notepad" });

// Dengan badge indikator + status active
taskbarButton({
  icon: "📝",
  label: "Notepad",
  badge: badge({ color: "#f44336" }),
  active: true,
});
```

### 4.12 `image(props)` — Gambar `<img>`

Factory function untuk menampilkan gambar dari path file atau base64.

```typescript
// Dari path file (src)
image({ id: "logo", src: "/path/to/logo.png", alt: "Logo" });

// Dari base64 (b64) — akan otomatis jadi data URI
image({
  id: "avatar",
  b64: "iVBORw0KGgo...", // string base64
  mime: "image/png",    // default: "image/png"
  alt: "Avatar",
});

// Dengan style
image({
  id: "photo",
  b64: "iVBORw0KGgo...",
  alt: "Foto",
  style: { maxWidth: "100%", borderRadius: "8px" },
});
```

> **PENTING:** `b64` hanya diproses **saat mount** (factory function). Untuk update gambar runtime, jangan pakai `update({ b64: ... })` — gunakan `update({ src: ... })` langsung dengan data URI (lihat [§7.1](#71-update-image-runtime-pola-updateimagefromfile)).

### 4.13 `sensorCard(props)` — Sensor Card

Kartu sensor dengan nilai besar, unit, dan progress bar.

```typescript
sensorCard({
  id: "temp-01",
  label: "Temperature",
  unit: "°C",
  icon: "🌡️",
  color: "#f44336",
  min: 0,
  max: 100,
  value: 42.5,
});
```

**Progress bar** otomatis terisi sesuai `(value - min) / (max - min)`. Update lewat `app.update("bar-{id}", { style: { width: ... } })`.

### 4.14 `relayCard(props)` — Relay Card

Kartu status relay ON/OFF.

```typescript
relayCard({ id: "fan", label: "FAN", icon: "🌀", color: "#4caf50", active: true });
```

**Dynamic:** Update text via `app.update("rs-{id}", { text: on ? "🟢 ON" : "⚫ OFF" })` dan border via `app.update("rc-{id}", { style: { borderColor: ... } })`.

### 4.15 `lineChart(props)` — Line Chart

Chart garis dengan opsi fill dan spline.

```typescript
lineChart({
  id: "chart-temp",
  title: "🌡️ Temperature",
  data: [30, 35, 42, 38, 45, 40],
  color: "#f44336",
  spline: true,
  fill: true,
  width: 240,
  height: 150,
  min: 0,
  max: 100,
});
```

Untuk update data, gunakan `buildLineChartSvg()` → `app.update(containerId, { innerHTML: svgStr })`.

### 4.16 `radialGauge(props)` — Radial Gauge

Gauge lingkaran 260° dengan needle, arc progress, dan label value.

```typescript
radialGauge({
  id: "gauge-hum",
  value: 67,
  min: 0,
  max: 100,
  color: "#2196f3",
  label: "💧 Humidity",
  unit: "%",
  size: 120,
});
```

**Smooth animation:** CSS transition `stroke-dashoffset 0.2s` — update via `app.update("rg-arc-{id}", { style: { strokeDashoffset: newValue } })`.

### 4.17 `verticalGauge(props)` — Vertical Gauge

Gauge vertikal dengan tube, water fill, dan glass reflection. Cocok untuk water level, fuel, dll.

```typescript
verticalGauge({
  id: "water-tank",
  value: 75,
  color: "#2196f3",
  label: "💧 Water Level",
  unit: "%",
});
```

Internal SVG menggunakan `transform: translateY()` dengan CSS transition — animasi smooth saat value di-update via `app.update("wg-water-{id}", { style: { transform: ... } })`.

### 4.18 `sevenSegment(props)` — Seven-Segment Display

Display LED 7-segment ala kalkulator dengan skewX effect.

```typescript
sevenSegment({ value: 42.5, digits: 4, decimals: 1, color: "#4caf50" });
sevenSegment({ value: 1023, digits: 4, color: "#f44336" });

// Dengan label
sevenSegment({
  id: "seg-pres",
  digits: 4,
  decimals: 1,
  color: "#7ffa73",
  value: 1013,
  label: "🌀 Pressure",
});
```

**Props:** `value` (angka), `digits` (jumlah digit), `decimals` (desimal), `color` (warna LED), `offColor` (warna mati, default `darken(color, 0.2)`), `label` (teks di bawah).

### 4.19 `indicatorLamp(props)` — Indicator Lamp

Lampu indikator ON/OFF dengan efek glow. Menggunakan `<img src="data:image/svg+xml,...">` di backend.

```typescript
indicatorLamp({ color: "#ff9800", label: "☀️ LIGHT", size: 36, on: true });
```

**Props:** `color`, `on` (boolean), `size` (px), `label`.

### 4.20 `toggleSwitch(props)` — Toggle Switch

Switch ON/OFF dengan animasi knob geser (SVG inline).

```typescript
toggleSwitch({ id: "fan-sw", color: "#4caf50", on: false, label: "🌀 FAN" });
```

**Event:** Pasang `onClickId` pada wrapper, lalu bind `app.on(wrapId, "click", handler)`.

### 4.21 `slider(props)` — Range Slider

Slider range `<input type="range">` dengan label dan value display.

```typescript
slider({
  id: "fan-speed",
  value: 50,
  min: 10,
  max: 100,
  color: "#4caf50",
  label: "🌀 FAN SPEED",
  unit: "%",
});
```

**Event:** Slider otomatis pasang `onInputId="sl-input-{id}"`. Bind handler:
```typescript
app.win.bindHandler("sl-input-fan-speed", "input", (ev: any) => {
  const val = parseInt(ev?.value) || 0;
  app.update("sl-val-fan-speed", { text: val + "%" });
});
```

### Props Tambahan untuk `image()`

| Prop     | Browser Behavior                                    |
| -------- | --------------------------------------------------- |
| `src`    | `el.setAttribute('src', value)` — URL/path gambar   |
| `b64`    | Otomatis dikonversi jadi `data:...;base64,` saat mount |
| `mime`   | MIME type untuk b64 (`"image/png"`, `"image/jpeg"`, dll) |
| `alt`    | `el.setAttribute('alt', value)`                     |
| `width`  | `el.setAttribute('width', value)`                   |
| `height` | `el.setAttribute('height', value)`                  |
| `loading`| `"lazy"` / `"eager"`                                |

### Props yang Didukung Browser

| Prop                                    | Browser Behavior                                |
| --------------------------------------- | ----------------------------------------------- |
| `text`                                  | `el.textContent = value`                        |
| `innerHTML`                             | `el.innerHTML = value` (render HTML!)           |
| `style`                                 | `Object.assign(el.style, value)` — CSS object   |
| `disabled`                              | `el.setAttribute('disabled', '')`               |
| `className`                             | `el.className = value`                          |
| `placeholder`                           | `el.setAttribute('placeholder', value)`         |
| `type`, `value`, `rows`, `cols`, `href` | `el.setAttribute(key, value)`                   |
| `onClickId`                             | Attach click listener + kirim event ke Worker   |
| `onInputId`                             | Attach input listener + kirim event ke Worker   |
| `onKeydownId`                           | Attach keydown listener + kirim event ke Worker |

---

## 5. Screen: High-Level Wrapper

`Screen` adalah wrapper tingkat tinggi untuk `Window`. Semua aplikasi normal menggunakan `Screen`.

### Constructor

```typescript
// Pola object-based (direkomendasikan):
new Screen({
    title: "Judul Aplikasi",
    lib?: UserLib,           // Opsional (auto-detect)
    fullscreen?: boolean,    // true = fullscreen (default: false)
    width?: number,          // Lebar window (default: auto)
    height?: number,         // Tinggi window (default: auto)
    resizable?: boolean,     // Bisa di-resize (default: true)
    frameless?: boolean,     // Tanpa title bar (default: false)
    maximizable?: boolean,   // Bisa di-maximize (default: true)
})

// Pola positional (legacy, tetap didukung):
new Screen(title, lib?, fullscreen?, width?, height?, resizable?, frameless?, maximizable?)
```

### API Lengkap

```typescript
class Screen {
    readonly win: Window           // Akses Window mentah
    get wid(): string              // Window ID
    running: boolean               // Status hidup
    state: Record<string, any>     // State aplikasi

    // === MOUNTING ===
    async mount(node: IDOMNode, parentId?: string): Promise<void>
    async setContent(containerId: string, ...children: IDOMNode[]): Promise<void>
    async update(targetId: string, props: Record<string, any>): Promise<void>

    // === EVENTS ===
    async on(targetId: string, event: "click"|"input"|"keydown"|"close",
             cb: (ev: IGUIEventIPC) => void): Promise<void>

    // === LIFECYCLE ===
    async loopUntilClose(): Promise<void>
    async close(): Promise<void>
    async minimize(): Promise<void>
    async restore(): Promise<void>

    // === DIALOGS ===
    async alert(title: string, message?: string): Promise<void>
    async confirm(title: string, message: string,
                  buttons?: string[]): Promise<string>
    async openFileDialog(fs: any, opts?: {...})
        : Promise<{path, filename, directory} | null>
    async saveFileDialog(fs: any, opts?: {...})
        : Promise<{path, filename, directory} | null>

    // === VISIBILITY ===
    async setVisible(targetId: string, visible: boolean): Promise<void>
    async setEnabled(targetId: string, enabled: boolean): Promise<void>

    // === NOTIFICATION ===
    async notifyDesktop(title: string, message: string): Promise<void>

    // === IMAGE ===
    async updateImageFromFile(fsLib: any, elementId: string, filePath: string): Promise<void>

    // === STATE ===
    setState(patch: Record<string, any>): void
}
```

### `setVisible(targetId, visible)` — Show/Hide

```typescript
await app.setVisible("btn-disconnect", false);  // sembunyikan
await app.setVisible("btn-disconnect", true);   // tampilkan lagi
```

> Mengubah `style.display` via `app.update()` — set `""` untuk show, `"none"` untuk hide.

### `setEnabled(targetId, enabled)` — Enable/Disable

```typescript
await app.setEnabled("btn-save", false);  // disable tombol
await app.setEnabled("btn-save", true);   // enable lagi
```

> Mengubah `disabled` attribute — set `""` untuk disable, `undefined` untuk enable.

### `notifyDesktop(title, message)` — Desktop Notification

Kirim notifikasi ke Asteracea Window Manager (muncul sebagai toast di taskbar).

```typescript
await app.notifyDesktop("🔥 Alert", "Temperature above threshold!");
await app.notifyDesktop("✅ Done", "File berhasil disalin.");
```

> Aman dipanggil kapan saja — jika Asteracea tidak berjalan, error di-catch silently.

### Pattern Dasar

```typescript
const app = new Screen({ title: "My App", width: 800, height: 600 });

// 1. Mount UI
await app.mount(div({ id: "root" }, ...));

// 2. Bind events (auto-flush ke browser)
await app.on("btn", "click", async () => { ... });

// 3. Stay alive
await app.loopUntilClose();
```

---

## 6. Event Handling

### 6.1 Click Event

```typescript
// 1. Beri onClickId saat mount
await app.mount(button({ id: "btn-ok", text: "OK", onClickId: "btn-ok" }));

// 2. Bind handler dengan Screen.on()
await app.on("btn-ok", "click", async () => {
  await app.update("btn-ok", { text: "✅ Sudah Diklik!" });
});
```

### 6.2 Input Event

```typescript
// 1. Beri onInputId saat mount
await app.mount(
  input({
    id: "nama",
    type: "text",
    onInputId: "nama",
    placeholder: "Nama lengkap...",
  }),
);

// 2. Bind handler
let nama = "";
await app.on("nama", "input", (ev: any) => {
  // ev.value berisi teks terbaru
  if (ev.value !== undefined) nama = String(ev.value);
});
```

### 6.3 Keydown Event

```typescript
await app.on("search-input", "keydown", async (ev: any) => {
  if (ev.value === "Enter") {
    await doSearch();
  } else if (ev.value === "Tab") {
    await doAutocomplete();
  }
});
```

### 6.4 Close Event

```typescript
await app.on("__window__", "close", async () => {
  // Cleanup sebelum window ditutup
  await saveData();
});
```

### 6.5 Update Props (Realtime UI)

```typescript
// Update teks
await app.update("status", { text: "Loading..." });

// Update style (WARNING: harus kirim SEMUA properti style!)
await app.update("btn", {
  style: {
    background: "#4caf50",
    color: "white",
    padding: "10px 20px",
    border: "2px solid #4caf50",
  },
});

// Disable tombol
await app.update("btn-save", { disabled: "1" });
```

> **WARNING:** Saat meng-update `style`, kamu harus mengirim **semua properti style** yang diinginkan, bukan hanya yang berubah. Browser akan mengganti seluruh `el.style` dengan nilai baru.

### 6.6 SVG Widget Update Pattern (data-tsix-id + CSS Transitions)

Widget kaya `radialGauge`, `verticalGauge`, `lineChart` menggunakan **SVG inline** di dalam `innerHTML`. Untuk update value dengan animasi smooth, **jangan replace innerHTML** — pakai targeted update via `data-tsix-id`:

```typescript
// ✅ Smooth — update specific SVG element via data-tsix-id
await app.update("wg-water-tank-1", {
  style: { transform: "translateY(50px)" }  // CSS transition otomatis
});

await app.update("wg-val-tank-1", {
  text: "75"  // update value text
});

// ✅ Radial gauge arc
await app.update("rg-arc-gauge-hum", {
  style: { strokeDashoffset: "150" }
});
```

**Cara kerja:**
1. Factory function (`radialGauge`, `verticalGauge`) pasang `data-tsix-id` pada elemen SVG kunci
2. DOME browser engine cari elemen via `[data-tsix-id="..."]`
3. `style` object di-set via `Object.assign(el.style, value)` — **CSS transition hidup!**
4. `text` di-set via `el.textContent` — no transition needed

**Elemen yang bisa di-target:**

| Widget | data-tsix-id | CSS Transition |
|--------|-------------|----------------|
| `verticalGauge` | `wg-water-{id}`, `wg-grad-{id}`, `wg-surface-{id}`, `wg-val-{id}` | `transform 0.2s` |
| `radialGauge` | `rg-arc-{id}`, `rg-needle-group-{id}`, `rg-val-{id}` | `stroke-dashoffset 0.2s`, `transform 0.2s` |
| `sensorCard` | `sv-{id}`, `bar-{id}` | `width 0.3s` |
| `lineChart` | `lc-html-{id}` (innerHTML) | — |

---

## 7. Dynamic Content & setContent

Untuk list yang berubah-ubah (file explorer, search results, dll), gunakan `setContent()`:

```typescript
// Container statis (mount sekali)
await app.mount(div({ id: "list-container" }));

// Fungsi refresh — panggil setiap data berubah
async function refreshList() {
  const items = await fetchItems(); // ambil data terbaru

  // Bangun row untuk setiap item
  const rows = items.map((item, i) =>
    div(
      {
        id: `row-${i}`,
        onClickId: `row-${i}`,
        style: {
          display: "flex",
          padding: "6px 10px",
          background: i % 2 === 0 ? "#16213e" : "#0f3460",
          cursor: "pointer",
        },
      },
      span({ text: `📄 ${item.name}` }),
    ),
  );

  // Clear + mount — gak numpuk!
  await app.setContent("list-container", ...rows);

  // Re-bind event handlers — WAJIB setelah setContent!
  for (let i = 0; i < items.length; i++) {
    await app.on(`row-${i}`, "click", () => {
      handleItemClick(items[i]);
    });
  }
}
```

> **PENTING:** Setelah `setContent()`, semua event handler di dalam container tersebut hilang. Kamu **harus re-bind** semua handler.

### Pattern: File Explorer

Lihat `file-cruiser.ts` untuk contoh lengkap navigasi folder, file list refresh dengan `setContent`.

> **⚠️ WARNING:** `setContent()` menggunakan `UPDATE_PROPS(containerId, { innerHTML: "" })` untuk clear container, lalu `MOUNT_NODE(child, containerId)` untuk setiap child. Pastikan container target ada di DOM saat `setContent` dipanggil — child yang parent-nya tidak ditemukan akan **di-discard** (bukan di-fallback ke window content) oleh DOME browser engine.

```typescript
// Navigasi: ganti currentDir, panggil refreshList()
async function enterDir(name: string) {
  currentPath = currentPath.replace(/\/$/, "") + "/" + name;
  await refreshList();
}

// Double-click detection
let lastClick = { id: "", time: 0 };
win.onClick(rowId, () => {
  const now = Date.now();
  if (lastClick.id === rowId && now - lastClick.time < 400) {
    // Double click!
    enterDir(name);
  } else {
    lastClick = { id: rowId, time: now };
  }
});
```

### Pattern: Tab Completion (Keydown)

```typescript
await app.on("path-input", "keydown", async (ev: any) => {
  if (ev.value === "Enter") {
    await refreshList();
  } else if (ev.value === "Tab") {
    const completed = await tabCompletePath(currentPath);
    currentPath = completed;
    await app.update("path-input", { value: currentPath });
  }
});
```

### 7.1 Update Image Runtime — `screen.updateImageFromFile()`

Karena `image()` hanya memproses `b64` → `src` **saat mount**, untuk meng-update gambar secara dinamis kamu harus panggil method built-in `updateImageFromFile()` yang sudah tersedia di `Screen`.

```typescript
// 1. Mount image element dulu (bisa dengan b64 placeholder kosong)
await app.mount(
  div(
    { id: "img-container", style: { display: "flex", justifyContent: "center" } },
    image({ id: "preview", alt: "Preview", style: { maxWidth: "100%", maxHeight: "200px" } }),
  ),
);

// 2. Update gambar secara dinamis dari file VFS
await app.updateImageFromFile(fs, "preview", "/mnt/shared/foto.jpg");

// Bisa dipanggil kapan saja — ganti gambar runtime
await app.on("btn-ganti", "click", async () => {
  const file = await app.openFileDialog(fs, { filter: [".jpg", ".jpeg", ".png"] });
  if (file) {
    await app.updateImageFromFile(fs, "preview", file.path);
  }
});
```

> **KENAPA bukan `app.update({ b64: ... })`?** Karena `b64` hanya diproses oleh factory `image()` saat node dibuat (mount). Saat `update()` dijalankan, Emerald mengirim props mentah ke DOME, yang kemudian di-set sebagai attribute HTML. Browser tidak akan otomatis mengkonversi `b64` ke `src` — jadi harus langsung pakai `src` dengan data URI lengkap. `updateImageFromFile()` menangani semua ini secara internal.

> **SIGNATURE:** `async updateImageFromFile(fsLib: any, elementId: string, filePath: string): Promise<void>`

---

## 8. Alert, Confirm & Question

### alert(title, message?)

Dialog pesan dengan tombol OK. Return Promise yang resolve saat user klik OK.

```typescript
// Pesan sederhana
await app.alert("File berhasil disimpan!");

// Dengan message tambahan
await app.alert("⚠️ Error", "Gagal menyimpan file: permission denied");

// Preview file
await app.alert("📄 Preview: " + filename, content.substring(0, 200) + "...");
```

### confirm(title, message, buttons?)

Dialog konfirmasi dengan beberapa tombol. Return **label tombol** yang diklik.

```typescript
// Konfirmasi default (OK, Cancel)
const ans = await app.confirm("Hapus file?", "Data tidak bisa dikembalikan.");
if (ans === "OK") {
  /* hapus */
}

// Custom buttons
const ans = await app.confirm(
  "Simpan perubahan?",
  "Dokumen telah dimodifikasi.",
  ["Yes", "No", "Cancel"],
);
if (ans === "Yes") {
  /* simpan */
} else if (ans === "Cancel") {
  /* batal */
}

// Tombol pertama (index 0) selalu warna hijau (primary)
```

> **Styling:** Alert pakai border hijau + ikon 💬, Confirm pakai border oranye + ikon ⚠️.

### 8.3 `question(title, message, defaultValue?)` — Modal Input Field

Dialog dengan input field dan tombol OK/Cancel. Return **string** yang diketik user, atau **`null`** jika Cancel.

```typescript
const nama = await app.question("Siapa Namamu?", "Ketik nama panggilanmu:");
if (nama !== null) {
    await app.update("greeting", { text: "👋 Halo, " + nama + "!" });
} else {
    // User tekan Cancel — tidak terjadi apa-apa
}

// Dengan default value
const rename = await app.question(
    "Rename File",
    "Nama baru:",
    "default.txt", // nilai awal di input
);

// Enter juga trigger submit — keydown event listener otomatis
```

> **Enter:** User bisa tekan Enter di input field untuk submit (sama seperti klik OK).

---

## 9. File Dialogs

### openFileDialog(fs, opts?)

Dialog buka file native dengan tree navigasi dan file list.

```typescript
const file = await app.openFileDialog(fs, {
  title: "📂 Buka File",
  startDir: "/home",
  filter: [".ts", ".js", ".json", ".txt", ".md"], // ekstensi yang ditampilkan
});

if (file) {
  // file.path      → "/home/user/document.ts"
  // file.filename  → "document.ts"
  // file.directory → "/home/user"

  // Baca isi file
  const fd = await fs.open(file.path);
  const content = await fs.read(fd);
  await fs.close(fd);
} else {
  // User tekan Cancel
}
```

### saveFileDialog(fs, opts?)

Dialog simpan file.

```typescript
const file = await app.saveFileDialog(fs, {
  title: "💾 Simpan File",
  startDir: "/tmp",
  defaultName: "output.txt",
});

if (file) {
  const content = `# Data Report\nTimestamp: ${new Date().toISOString()}\n`;
  await fs.writeFile(file.path, content);
  await app.alert("✅ Tersimpan!", `File: ${file.path}`);
}
```

### Fitur File Dialog

- **Tree panel kiri:** navigasi folder (expand/collapse)
- **File panel kanan:** daftar file + folder
- **Filter ekstensi:** di `openFileDialog`, file non-matching auto-disembunyikan
- **Double-click:** folder → masuk, file → pilih
- **Path bar:** menampilkan direktori saat ini
- **Save mode:** ada input field untuk nama file

---

## 10. Window Manager Pattern

Emerald bisa digunakan untuk membuat **Window Manager** (seperti Asteracea) — aplikasi fullscreen yang me-launch dan mengontrol aplikasi lain.

### Konsep Kunci

```typescript
import { Window } from "@tsix/emerald";

// 1. Window Manager buat fullscreen window-nya sendiri
const wm = new Window({ title: "TSIX WM", fullscreen: true, frameless: true });

// 2. Launch child app
const proc = await shell.exec("/bin/gui-hello-world.ts", []);

// 3. Dengarkan lifecycle event dari child
const lib = (global as any)._tsixLib;
lib.onEvent("ipc_message", (msg: any) => {
  const payload = msg?.data || msg;

  if (payload.type === "GUI_WINDOW_CREATED") {
    // Child app baru jalan — catat pid + wid
  } else if (payload.type === "GUI_WINDOW_MINIMIZED") {
    // Child diminimze — update taskbar
  } else if (payload.type === "GUI_WINDOW_RESTORED") {
    // Child direstore — update taskbar
  } else if (payload.type === "GUI_WINDOW_CLOSED") {
    // Child ditutup — hapus dari taskbar
  }
});

// 4. Kontrol child window
// Minimize window child
await wm.sendGuiAction(childWid, "MINIMIZE_WINDOW");

// Atau — kirim event langsung ke child PID
await shell.send(childPid, {
  type: "GUI_EVENT",
  wid: childWid,
  targetId: "__window__",
  eventType: "minimize_window",
});
```

### IPC Lifecycle Events

Setiap aplikasi Emerald otomatis mengirim event ke **dua tujuan**:

1. **Parent process** (langsung) — untuk backward compatibility
2. **Asteracea WM** — via `/etc/asteracea/wm-pid` (dengan deduplikasi)

| Event                    | Dikirim saat...            | Tujuan |
| ------------------------ | -------------------------- | ------ |
| `GUI_WINDOW_CREATED`     | Constructor Window selesai | Parent + Asteracea |
| `GUI_WINDOW_MINIMIZED`   | `minimize()` dipanggil     | Parent + Asteracea |
| `GUI_WINDOW_RESTORED`    | `restore()` dipanggil      | Parent + Asteracea |
| `GUI_WINDOW_MAXIMIZED`   | `maximize()` dipanggil     | Parent + Asteracea |
| `GUI_WINDOW_UNMAXIMIZED` | `unmaximize()` dipanggil   | Parent + Asteracea |
| `GUI_WINDOW_CLOSED`      | `close()` dipanggil        | Parent + Asteracea |

> **Kenapa dua tujuan?** Aplikasi yang dijalankan dari terminal punya parent = terminal (bukan Asteracea). Broadcast ke Asteracea via PID file memastikan semua aplikasi GUI — termasuk yang dijalankan dari terminal, shell, atau file-cruiser — tetap mendapat taskbar button.

### Arsitektur Decoupled

Tidak ada coupling langsung antara Window Manager, Emerald, dan DOME. Semua komunikasi lewat:

```
Window Manager ──(shell.send)──► Kernel ──(ipc_message)──► Child App
Window Manager ◄──(GUI_REQ)──── Kernel ◄──(MOUNT_NODE)──── Child App
Emerald ──(baca /etc/asteracea/wm-pid)──► Asteracea WM (broadcast)
```

---

## 11. Connected Widgets — Self-Rendering Components

**Connected Widgets** adalah kelas widget yang mengelola state internal-nya sendiri dan otomatis me-render ulang saat `setValue()` / `setOn()` / `setData()` dipanggil. Cocok untuk dashboard IoT dengan banyak widget yang perlu update real-time.

### Konsep

Setiap Connected Widget:

1. **`build()`** — buat `IDOMNode` tree awal (dipanggil sekali saat mount)
2. **`mount(screen)`** — registrasi ke Screen
3. **`setValue(val)`** — update state + panggil `render()` internal
4. **`render(screen)`** — kirim targeted `s.update()` ke DOME — **CSS transitions jalan!**

### Daftar Connected Widgets

| Class | Widget | Method Update |
|-------|--------|---------------|
| `ConnectedSensorCard` | Sensor dengan bar | `setValue(val)` |
| `ConnectedLineChart` | Line chart | `setData(data[])` |
| `ConnectedRadialGauge` | Radial gauge | `setValue(val)` |
| `ConnectedVerticalGauge` | Vertical gauge | `setValue(val)` |
| `ConnectedSevenSegment` | 7-segment display | `setValue(val)` |
| `ConnectedIndicatorLamp` | Indicator lamp | `setOn(bool)` |
| `ConnectedToggle` | Toggle switch + click | `setOn(bool)` + `mount(screen, onChangeCb)` |
| `ConnectedRelayCard` | Relay card | `setOn(bool)` |
| `ConnectedDataGrid` | Data grid (sort/resize, render app-side) | `setData(rows)`, `appendData(rows)`, `setColumns(cols)` |
| `ConnectedTabulator` | Data grid via Tabulator v6 (render browser-side) | `setData(rows)`, `appendData(rows)`, `setColumns(cols)`, `toggleSort(key)` |

### Pola Dasar

```typescript
import {
  ConnectedSensorCard, ConnectedRadialGauge,
  ConnectedVerticalGauge, ConnectedToggle,
} from "@tsix/emerald";

// 1. Buat instance
const tempSensor = new ConnectedSensorCard({
  id: "01", label: "Temperature", unit: "°C",
  icon: "🌡️", color: "#f44336", min: 0, max: 100,
});

const humGauge = new ConnectedRadialGauge({
  id: "gauge-hum", min: 0, max: 100,
  color: "#2196f3", label: "💧 Humidity",
  unit: "%", size: 110, value: 50,
});

const fanToggle = new ConnectedToggle({
  id: "fan-sw", label: "🌀 FAN", color: "#4caf50", on: false,
});

// 2. Build nodes + mount
await app.mount(div({ style: { display: "flex", gap: "10px" } },
  tempSensor.build(),
  humGauge.build(),
  fanToggle.build(),
));

// 3. Mount ke screen (aktifkan self-rendering)
await tempSensor.mount(app);
await humGauge.mount(app);

// 4. Toggle with callback
await fanToggle.mount(app, async () => {
  // Called setiap kali toggle diklik
  console.log("FAN:", fanToggle.on ? "ON" : "OFF");
});

// 5. Update — render OTOMATIS!
await tempSensor.setValue(42.5);  // → smooth CSS transition
await humGauge.setValue(67);      // → smooth arc animation
```

### ConnectedToggle — Wiring Pattern

`ConnectedToggle` membutuhkan **callback** di `mount()` karena toggle harus memberitahu parent saat state berubah:

```typescript
const fanToggle = new ConnectedToggle({
  id: "fan-sw", label: "🌀 FAN", color: "#4caf50", on: false,
});

// Callback dipanggil setiap toggle diklik
await fanToggle.mount(app, async () => {
  await fanRelay.setOn(fanToggle.on); // sync relay
});
```

> **PENTING:** `ConnectedToggle` otomatis handle klik dan update visual — kamu cukup baca `toggle.on` di callback.

### ConnectedTabulator — Data Grid (browser-side, sortable + resizable + theme-aware)

`ConnectedTabulator` adalah data grid berbasis **Tabulator v6** yang dirender 100% di sisi browser (pola custom widget ala `codemirror`/`xterm`/lightweight-charts — lihat §13.3). Berbeda dari `ConnectedDataGrid` (render virtual-DOM app-side), **sort, resize kolom, selection, dan scroll ditangani Tabulator sendiri** → bebas bug render/setContent dan traffic IPC jauh lebih kecil (data dikirim sekali, render di browser).

```typescript
import { ConnectedTabulator } from "@tsix/emerald";

const grid = new ConnectedTabulator({
  id: "sensor",
  columns: [
    { key: "node_id", label: "Node", width: 150 },
    { key: "value", label: "Nilai", width: 80, align: "right" },
    { key: "timestamp", label: "Waktu", width: "40%" },
  ],
  height: "100%",        // number = px, atau string "300px"
  maxRows: 500,          // opsional — batas baris di tampilan
});

// 1. Build node + mount window (taruh di container flex dengan minHeight:0)
await app.mount(div({ id: "wrap", style: { flex: "1", minHeight: "0" } }, grid.build()));

// 2. Mount ke screen + callback
await grid.mount(
  app,
  (key, dir) => { /* onSort(key, dir) */ },
  (index, record) => { /* onRowClick — index = row-key STABIL */ },
  (index, record, x, y) => { /* onRowContextMenu */ },
  (index, record) => { /* onSelectionChange — record null saat deselect */ },
);

// 3. Update data
await grid.setData(rows);        // ganti penuh
await grid.appendData(newRows);  // inkremental — hanya baris baru dikirim
await grid.setColumns(cols);
await grid.toggleSort("value");  // programmatic sort asc/desc

// 4. Seleksi (row-key stabil, tahan sort/refresh)
grid.selectedIndex;   // -1 jika tak ada
const rec = grid.selectedRecord; // copy record terpilih
const r = grid.getRecord(index);
await grid.setSelectedIndex(index);
await grid.clearSelection();
```

**Properti kolom (`DataGridColumn`):** `key`, `label`, `width` (number px atau string `"40%"`), `align` (`"left"|"center"|"right"`), `sortable` (default `true`), `resizable` (default `true`).

**Field tersembunyi:** Tabulator hanya merender kolom yang terdaftar — field ekstra di data (mis. `_name`, `_isDir`) aman dipakai untuk logika app tanpa tampil (pola dipakai File Cruiser untuk path/exec).

**Theme-aware:** grid otomatis mengikuti theme aktif TSIX (dark/light) — warna dipetakan ke CSS var theme dan di-push ulang saat `THEME_CHANGED`.

**Cashew (Delphi-style):** `TTabulatorGrid` membungkus class ini dengan API identik `TDataGrid` — tinggal ganti class:

```typescript
import { TTabulatorGrid } from "@tsix/cashew";
const grid = new TTabulatorGrid("sensor", columns, [], { height: 300 });
form.add(grid);
grid.onRowClick = (idx, rec) => { /* idx = row-key stabil */ };
await grid.setData(rows);
```

> **PENTING:** Penggunaan membutuhkan DOME yang memuat `dome-client-tabulator.js` — setelah update perlu **restart DOME** + hard-refresh browser (sekali).

### Studi Kasus: IoT Dashboard (`gui-test.ts`)

Lihat `src/mirror/bin/gui-test.ts` untuk contoh lengkap penggunaan semua Connected Widgets dalam satu dashboard:

- **4 sensor cards** (temp, humidity, pressure, light)
- **Line chart** untuk temperature history
- **Radial gauge** untuk humidity
- **7-segment display** untuk pressure
- **Indicator lamp** untuk light
- **2 vertical gauges** untuk water level + fuel
- **2 toggles** + **2 relay cards** (FAN, LAMP)
- **Slider** untuk fan speed
- **Simulasi data** tiap 1 detik dengan `app.setInterval()`
- **Desktop notification** saat temperature >= 64°C

```typescript
// Contoh loop utama:
app.setInterval(async () => {
  const data = simulateSensors();
  for (const s of sensorCards) await s.setValue(data[s.sensorId]);
  await tempChart.setData(history["01"]);
  await humGauge.setValue(data["02"]);
  await presSeg.setValue(data["03"]);
  await lightLamp.setOn(data["04"] > 30);
  await waterGauge.setValue(Math.round(...));
  await fuelGauge.setValue(Math.round(...));
}, 1000);
```

---

## 12. Managed Timers

> **⚠️ MANDATORY:** Mulai TSIX v1.2, **semua aplikasi GUI dilarang menggunakan `setInterval()` dan `setTimeout()` global.** Gunakan `app.setInterval()` dan `app.setTimeout()` yang terdaftar di Screen Timer Registry.

### Mengapa?

Setiap `setInterval`/`setTimeout` yang tidak di-clear saat window ditutup akan menyebabkan **Unhandled Rejection** karena callback mencoba mengakses window yang sudah di-destroy:

```
[Worker Fatal] Unhandled Rejection: Error: @tsix/gui: Window 'xxx' has been destroyed.
    at Window.ensureAlive (...)
    at Window.updateProps (...)
    at Screen.update (...)
    at Timeout._onTimeout (...)
```

Dengan Managed Timers, semua timer otomatis di-clear oleh `Screen.close()` — **zero leak, zero crash.**

### API

```typescript
class Screen {
    // Managed interval — auto-clear on close
    setInterval(cb: () => void, ms: number): ReturnType<typeof setInterval>

    // Managed timeout — auto-clear on close
    setTimeout(cb: () => void, ms: number): ReturnType<typeof setTimeout>
}
```

### Cara Kerja

1. `app.setInterval(cb, ms)` — bungkus `setInterval` global, simpan ID di `_timers[]`, guard `app.running`
2. `app.setTimeout(cb, ms)` — bungkus `setTimeout` global, simpan ID di `_timers[]`, guard `app.running`
3. `app.close()` — `clearInterval` semua ID di `_timers[]`, kosongkan array
4. Callback hanya dieksekusi jika `app.running === true`

### Pola Sebelum vs Sesudah

```typescript
// ❌ SEBELUM (bahaya — leak, crash on close)
const interval = setInterval(() => {
    updateData();
}, 1000);
app.win.onClose(() => clearInterval(interval));

// ✅ SESUDAH (aman — auto-managed)
app.setInterval(() => {
    updateData();
}, 1000);
// Tidak perlu onClose handler — Screen.close() clear otomatis
```

### Best Practice: Main Loop

```typescript
export const main = Program(async (_args: string[]) => {
    const app = new Screen({ title: "My App", width: 800, height: 600 });
    await app.mount(/* ... */);

    // Managed interval — auto-clear on close, zero leak
    app.setInterval(async () => {
        const data = await fetchSensorData();
        await updateUI(data);
    }, 1000);

    await app.loopUntilClose();
    // ↑ close() otomatis di dalam loopUntilClose()
    // ↑ clearInterval semua timer
});
```

### Internals

```typescript
export class Screen {
    private _timers: ReturnType<typeof setInterval>[] = [];

    setInterval(cb: () => void, ms: number): ReturnType<typeof setInterval> {
        const id = setInterval(() => { if (this.running) cb(); }, ms);
        this._timers.push(id);
        return id;
    }

    setTimeout(cb: () => void, ms: number): ReturnType<typeof setTimeout> {
        const id = setTimeout(() => { if (this.running) cb(); }, ms);
        this._timers.push(id);
        return id;
    }

    async close() {
        this.running = false;
        for (const id of this._timers) clearInterval(id);
        this._timers = [];
        await this.win.close();
    }
}
```

---

## 13. Studi Kasus: Aplikasi Lengkap

### 13.1 Form Demo (gui-demo.ts)

Aplikasi form lengkap dengan input, textarea, selectBox, radio-style button group, dan file dialogs.

**Pola yang ditunjukkan:**

- Form field helper (`formField()`)
- Input tracking via `on("input")`
- Tema selection dengan update style
- File open/save dialogs
- Submit + reset

```typescript
// Helper: bungkus label + input
function formField(label: string, ...children: any[]) {
    return div({ style: { marginBottom: "14px" } },
        paragraph({ text: label, style: { fontSize: "13px", color: "#aaa" } }),
        ...children,
    );
}

// Two-column layout
await app.mount(div({ style: { display: "flex", gap: "20px" } },
    div({ style: { flex: "1" } },
        formField("Nama", input({ id: "nama", ... })),
        formField("Email", input({ id: "email", ... })),
    ),
    div({ style: { width: "320px" } },
        // File dialog buttons + result box
    ),
));
```

### 13.2 File Cruiser (file-cruiser.ts)

VFS explorer dengan navigasi, toolbar, dan operasi file (view, info, copy, cut, paste, rename, delete, execute).

**Pola yang ditunjukkan:**

- Tree panel + file panel (split layout)
- Path navigation (input + ".." parent)
- Double-click detection untuk masuk folder
- Toolbar dengan enable/disable tombol berdasarkan seleksi
- Tab completion untuk path input
- Daftar file dirender `ConnectedTabulator` (sort/resize/select native di browser, double-click app-side)

```typescript
// Toolbar dengan tombol dinamis
await app.update("tb-view", { disabled: hasSelection ? undefined : "1" });
await app.update("tb-exec", { disabled: isExecutable ? undefined : "1" });

// Split panel layout
div(
  { style: { display: "flex", gap: "6px", flex: "1" } },
  div({ style: { width: "190px" } } /* tree */),
  div({ style: { flex: "1" } } /* file list */),
);
```

### 13.3 Eucalyptus (eucalyptus.ts)

Text editor dengan CodeMirror — menunjukkan integrasi komponen **non-standard HTML tag** (`"codemirror"`).

**Pola yang ditunjukkan:**

- Tag kustom (`tag: "codemirror"` dirender khusus oleh DOME)
- IPC langsung ke DOME (`shell.send(domePid, ...)`)
- Double-click pada tree explorer
- Save/Save As flow

```typescript
// Tag kustom — bukan HTML standard
{ id: "cm-editor", tag: "codemirror", props: {
    mode: "javascript", theme: "dracula", value: ""
}, children: [] }

// Kirim perintah langsung ke DOME
await shell.send(domePid, {
    type: "CM_SET_VALUE",
    wid: app.wid,
    targetId: "cm-editor",
    value: "console.log('hello');"
});
```

### 13.4 Layout Demo (layout-demo.ts)

Demo layout CSS kompleks: header, sidebar, stats cards, list items, footer.

**Pola yang ditunjukkan:**

- Grid cards (2 cols)
- Sidebar navigation
- Composite helper components (`sidebarItem()`, `statCard()`, `listItem()`)
- Confirm → Alert chaining

```typescript
// Helper: komponen reusable
function statCard(icon: string, label: string, value: string, color: string) {
    return div({ style: { flex: "1", padding: "16px", ... } },
        div({ style: { display: "flex", justifyContent: "space-between" } },
            span({ text: icon }),
            span({ text: value, style: { color } }),
        ),
        span({ text: label }),
    );
}
```

### 13.5 Asteracea — Window Manager

Window manager dengan login screen, wallpaper, app launcher, taskbar, clock, dan fuzzy search.

**Pola yang ditunjukkan:**

- Fullscreen frameless window
- BCRYPT-based login dengan `/etc/passwd` + `/etc/shadow`
- Wallpaper dari file b64
- Launcher overlay dengan search
- Taskbar dengan pinned apps + running apps
- Minimize/restore via IPC

---

## 14. Referensi Cepat API

### Factory Functions

```typescript
// Semua dari "@tsix/emerald"
text(content: string): IDOMNode
div(props?, ...children): IDOMNode
button(props?, ...children): IDOMNode
input(props?): IDOMNode
textarea(props?): IDOMNode
span(props?, ...children): IDOMNode
h1/h2/h3(props?, ...children): IDOMNode
paragraph(props?, ...children): IDOMNode
selectBox(props?, options: {value,text}[]): IDOMNode
badge(props?): IDOMNode
taskbarButton(props?): IDOMNode
image(props?): IDOMNode

// Widget cards
sensorCard(props): IDOMNode
relayCard(props): IDOMNode
lineChart(props): IDOMNode
radialGauge(props): IDOMNode
verticalGauge(props): IDOMNode
sevenSegment(props): IDOMNode
indicatorLamp(props): IDOMNode
toggleSwitch(props): IDOMNode
slider(props): IDOMNode
dataGrid(props): IDOMNode  // tabel statis (tanpa interaksi sort)

// SVG Builders (untuk update manual via innerHTML)
buildLineChartSvg(props): string
buildRadialGaugeSvg(props): string
buildSevenSegmentHtml(props): string
buildVerticalGaugeSvg(props): string
buildIndicatorLampImg(props): { innerHTML: string; glowSize: number }
buildToggleSwitchSvg(props): string
buildToggleSwitchImg(props): string

// Utility
darken(hex: string, ratio?: number): string
isLightColor(hex: string): boolean   // true jika warna terang (untuk theme-aware widget)
```

### Connected Widget Classes

```typescript
// Self-rendering — panggil setValue/setOn/setData untuk trigger render()
class ConnectedSensorCard { build(), mount(screen), setValue(val) }
class ConnectedLineChart { build(), mount(screen), setData(data[]) }
class ConnectedRadialGauge { build(), mount(screen), setValue(val) }
class ConnectedVerticalGauge { build(), mount(screen), setValue(val) }
class ConnectedSevenSegment { build(), mount(screen), setValue(val) }
class ConnectedIndicatorLamp { build(), mount(screen), setOn(bool) }
class ConnectedToggle { build(), mount(screen, onChangeCb?), setOn(bool) }
class ConnectedRelayCard { build(), mount(screen), setOn(bool) }
class ConnectedDataGrid { build(), mount(screen, onSort?, onRowClick?, onRowContextMenu?), setData(), appendData(), setColumns(), toggleSort() }
class ConnectedTabulator { build(), mount(screen, onSort?, onRowClick?, onRowContextMenu?, onSelectionChange?), setData(), appendData(), setColumns(), toggleSort(), getRecord(), setSelectedIndex(), clearSelection() }
```

### Screen API

```typescript
class Screen {
    constructor({ title, lib?, fullscreen?, width?, height?, resizable?, frameless?, maximizable? }: ScreenOptions)
    // atau constructor(title, lib?, fullscreen?, width?, height?, resizable?, frameless?, maximizable?)
    readonly win: Window
    get wid(): string

    async mount(node: IDOMNode, parentId?: string): Promise<void>
    async setContent(containerId: string, ...children: IDOMNode[]): Promise<void>
    async update(targetId: string, props: Record<string, any>): Promise<void>

    async on(targetId, "click"|"input"|"keydown"|"close", cb): Promise<void>
    async loopUntilClose(): Promise<void>
    async close(): Promise<void>
    async minimize(): Promise<void>
    async restore(): Promise<void>
    async maximize(): Promise<void>
    async unmaximize(): Promise<void>

    async alert(title: string, message?: string): Promise<void>
    async confirm(title, message, buttons?: string[]): Promise<string>
    async question(title: string, message?: string, defaultValue?: string): Promise<string | null>
    async openFileDialog(fs, opts?): Promise<{path,filename,directory}|null>
    async saveFileDialog(fs, opts?): Promise<{path,filename,directory}|null>

    // Visibility
    async setVisible(targetId: string, visible: boolean): Promise<void>
    async setEnabled(targetId: string, enabled: boolean): Promise<void>

    // Notification
    async notifyDesktop(title: string, message: string): Promise<void>

    // Image runtime update
    async updateImageFromFile(fsLib: any, elementId: string, filePath: string): Promise<void>

    // Managed timers (auto-clear on close)
    setInterval(cb: () => void, ms: number): ReturnType<typeof setInterval>
    setTimeout(cb: () => void, ms: number): ReturnType<typeof setTimeout>
}
```

### Window API (akses via `screen.win`)

```typescript
class Window {
  readonly wid: string;

  async mount(node: IDOMNode, parentId?: string): Promise<void>;
  async updateProps(
    targetId: string,
    props: Record<string, any>,
  ): Promise<void>;
  async unmount(targetId: string): Promise<void>;
  async setContent(containerId: string, ...children: IDOMNode[]): Promise<void>;

  onClick(targetId, callback): void;
  onInput(targetId, callback): void;
  onKeydown(targetId, callback): void;
  onClose(callback): void;

  async close(): Promise<void>;
  async minimize(targetWid?: string): Promise<void>;
  async restore(targetWid?: string): Promise<void>;
  async maximize(targetWid?: string): Promise<void>;
  async unmaximize(targetWid?: string): Promise<void>;
  async sendGuiAction(
    targetWid,
    action,
    targetId?,
    props?,
    node?,
  ): Promise<any>;
  async flush(): Promise<void>;
}
```

### IDOMNode

```typescript
interface IDOMNode {
  id: string; // Unik dalam satu window (UUID)
  tag: string; // "div", "button", "input", "text", "span", ...
  props: Record<string, any>; // text, style, disabled, onClickId, onInputId, ...
  children: IDOMNode[]; // Child nodes (rekursif)
}
```

### IGUIEventIPC (diterima di callback)

```typescript
interface IGUIEventIPC {
  type: "GUI_EVENT";
  wid: string; // Window ID
  targetId: string; // ID elemen yang trigger event
  eventType: string; // "click", "input", "keydown", "close_window", ...
  value?: any; // Payload tambahan (isi input, key yang ditekan)
}
```

---

## 15. Best Practices & Anti-Patterns

### ✅ Best Practices

1. **WAJIB: Gunakan `app.setInterval()` / `app.setTimeout()` — JANGAN pakai global `setInterval` / `setTimeout`.**

   ```typescript
   // ❌ SALAH — timer tidak ter-manage, leak, crash on close
   setInterval(() => { updateData(); }, 1000);

   // ✅ BENAR — auto-clear on close, zero leak
   app.setInterval(() => { updateData(); }, 1000);
   ```

   Setiap timer yang tidak di-clear akan menyebabkan **Unhandled Rejection** saat window ditutup. Lihat [§12 Managed Timers](#12-managed-timers).

2. **Gunakan `Screen`, bukan `Window` langsung.**
   `Screen` otomatis handle batched flush, event cleanup, dan lifecycle. `Window` hanya untuk window manager atau kasus khusus.

2. **Buat helper function untuk komponen reusable.**

   ```typescript
   function formField(label: string, ...children: any[]) {
     return div(
       { style: { marginBottom: "14px" } },
       paragraph({ text: label, style: { color: "#aaa" } }),
       ...children,
     );
   }
   ```

3. **Gunakan `setContent()` untuk list dinamis.**
   Jangan mount/unmount manual satu-satu. `setContent()` clear container + mount ulang dalam satu operasi.

4. **Selalu re-bind event setelah `setContent()`.**
   Container yang di-clear kehilangan semua handler. Bind ulang setelah isi ulang.

5. **Gunakan `onClickId` di props awal.**
   Browser memasang event listener saat `createElement`. Kalau event handler di-bind via `UPDATE_PROPS` setelah mount, ada potensi race condition.

6. **Update style: kirim objek lengkap.**

   ```typescript
   // ❌ SALAH — hanya kirim yang berubah
   await app.update("btn", { style: { background: "#f44336" } });

   // ✅ BENAR — kirim semua properti style
   await app.update("btn", {
     style: {
       background: "#f44336",
       color: "white",
       padding: "8px 16px",
       border: "none",
       borderRadius: "6px",
     },
   });
   ```

7. **Gunakan `flush()` setelah batch event binding.**
   ```typescript
   const w = (app as any).win;
   for (const item of items) {
     w.onClick(item.id, () => handleClick(item));
   }
   await w.flush(); // Kirim semua onClickId sekaligus
   ```

### ❌ Anti-Patterns

1. **Jangan mount node tanpa ID.**
   Setiap `IDOMNode` harus punya `id` unik (auto-generated oleh factory functions).

2. **Jangan panggil `update()` dalam tight loop.**
   Emerald sudah auto-batch via `scheduleFlush()`. Tapi kalau kamu update ribuan elemen, pertimbangkan `setContent()` untuk rebuild container.

3. **Jangan akses `document` atau `window` di userland.**
   Kode aplikasi TSIX berjalan di Worker Thread — tidak ada DOM. Semua rendering terjadi di browser host.

4. **Jangan lupa `loopUntilClose()`.**
   Tanpa ini, `main()` langsung selesai dan window hilang.

5. **Jangan mount ke ID yang tidak ada.**
   Kalau `parentId` tidak ditemukan di browser, mount gagal.

6. **Jangan gunakan `disabled: true` — gunakan `disabled: "1"`.**
   Browser DOM menggunakan string untuk attribute `disabled`.

---

## Lampiran: Daftar File Contoh

| File                                | Deskripsi                       | Baris |
| ----------------------------------- | ------------------------------- | ----- |
| `src/mirror/bin/gui-hello-world.ts` | Hello World — 3 langkah dasar   | ~12   |
| `src/mirror/bin/gui-demo.ts`        | Form + file dialogs + image     | ~170  |
| `src/mirror/bin/file-cruiser.ts`    | VFS Explorer + toolbar          | ~165  |
| `src/mirror/bin/eucalyptus.ts`      | Text Editor + CodeMirror        | ~200  |
| `src/mirror/bin/layout-demo.ts`     | Grid, sidebar, cards            | ~100  |
| `src/mirror/bin/pixelterm.ts`       | Terminal Emulator via xterm.js  | ~160  |
| `src/mirror/bin/asteracea.ts`       | Window Manager (Asteracea)      | ~900  |
| `src/mirror/opt/image-viewer/image-viewer.ts` | Image Viewer (explorer + `TImage` preview) | ~130 |
| `src/mirror/lib/emerald.ts`         | Emerald Toolkit source          | ~1220 |

---

_Emerald Widget Toolkit — "Your pixels, your space." 🎨_
