---
module: 19
title: Emerald Widget Toolkit
part: VII
partTitle: GUI & Desktop
status: done
lang: id
rfc: RFC-TSIX-EDU-002
audience: all
---

# Emerald Widget Toolkit

**RFC-TSIX-EDU-002** | Modul kesembilan belas kurikulum TSIX. Memahami layer toolkit GUI di atas protocol stabil: Screen wrapper, factory functions, dan connected widgets self-rendering.

> Emerald (`@tsix/emerald`) adalah GTK/Qt-nya TSIX. Semua UI dibangun sebagai **Virtual DOM Tree** (`IDOMNode`) dan dikirim via syscall — aplikasi **tidak punya akses** ke `document`, `window`, atau API browser apa pun.

---

## Tujuan Pembelajaran

- [ ] Menjelaskan posisi Emerald dalam tumpukan GUI
- [ ] Menjelaskan factory functions (`div`, `button`, `input`, ...)
- [ ] Menjelaskan Screen wrapper & pola mount → bind → loop
- [ ] Menjelaskan connected widgets (self-rendering), termasuk `ConnectedDataGrid`
- [ ] Menjelaskan `ensureListener()` — listener props persisten lintas `UPDATE_PROPS` (bug `cloneNode` diperbaiki)

---

## Konsep Inti

### Posisi dalam arsitektur

```
BROWSER → DOME (display server) → KERNEL (auth) → EMERALD (kamu di sini)
```

### Struktur dasar app

```ts
import { Program } from "@tsix/Application";
import { Screen, div, h1, paragraph } from "@tsix/emerald";

export const main = Program(async (args: string[]) => {
  // 1. Buat Screen (jendela)
  // 2. Bangun Virtual DOM tree dengan factory functions
  // 3. Mount, bind event, loop
});
```

### Factory functions

Factory menghasilkan `IDOMNode`. Daftar lengkap ada di `src/mirror/lib/emerald.ts`:

- Dasar: `text()`, `div()`, `span()`, `h1()`/`h2()`/`h3()`, `paragraph()`, `button()`, `input()`, `textarea()`, `selectBox()`, `image()`
- IoT: `lineChart()`, `radialGauge()`, `verticalGauge()`, `sevenSegment()`, `indicatorLamp()`, `toggleSwitch()`, `sensorCard()`, `relayCard()`, `badge()`, `taskbarButton()`
- Tabel: `dataGrid()` (statis), `slider()`

`alert()`, `confirm()`, `question()`, `openFileDialog()`, `saveFileDialog()` **bukan factory** — itu method pada `Window`/`Screen` yang menampilkan modal dialog overlay, bukan menghasilkan `IDOMNode`.

### Pattern dasar: Mount → Bind → Loop

```ts
const screen = new Screen({ title: "App", width: 400, height: 300 });
await screen.mount(
  div({ id: "root", style: { padding: "16px" } },
    h1({ text: "Hello" }),
    button({ id: "btn", text: "Klik" }),
  ),
);
// bind event → updateProps (di-batch & auto-flush) → loop
await screen.on("btn", "click", async () => {
  await screen.update("btn", { text: "✅ Diklik!" });
});
```

### Connected widgets (self-rendering)

Widget "connected" me-render dirinya sendiri dan memperbarui layar secara mandiri — pola yang lebih tinggi dari factory biasa. Pola umum: `build()` → `mount(screen)` → `setData()`/`setValue()`, memakai **targeted update** (bukan `setContent` penuh).

Kelas `Connected*` di `emerald.ts`:

- `ConnectedLineChart`, `ConnectedRadialGauge`, `ConnectedSevenSegment`, `ConnectedIndicatorLamp`
- `ConnectedVerticalGauge`, `ConnectedToggle`, `ConnectedSensorCard`, `ConnectedRelayCard`
- `ConnectedDataGrid` — tabel data interaktif: sort asc/desc, resize kolom (drag native), seleksi row berbasis kunci stabil, `appendData()` inkremental & opsi `maxRows`. Satu scroll container (header `th` sticky) — scroll horizontal & vertikal otomatis sinkron.

> [!IMPORTANT] **Listener props & `ensureListener()` (bug `cloneNode` sudah diperbaiki).**
> Empat listener props — `onClickId`, `onContextMenuId`, `onInputId`, `onKeydownId` — dipasang oleh DOME client lewat helper `ensureListener()` di `src/mirror/opt/dome/dome-client-dom.js` (dipakai di `buildDOM()` dan `handleUpdateProps()`), **sekali per elemen per event type** (dilacak via `el.__tsixL`). Dulu `handleUpdateProps` meng-clone node untuk "membersihkan listener lama" — `cloneNode` tidak menyalin listener, jadi jika satu batch `UPDATE_PROPS` membawa beberapa listener props sekaligus (mis. `onInputId` + `onKeydownId` di field password), listener yang baru dipasang bisa hilang. Dengan `ensureListener`, listener **persisten lintas `UPDATE_PROPS`** — tidak hilang dan tidak dobel. Best practice tetap berlaku: set listener props (`onClickId`, `onInputId`, dst) **saat mount-time** (di `build()`/`mount()`), lalu daftarkan callback via `screen.on()` / `win.bindHandler()`.

---

## Kode Sumber

| File | Peran |
|---|---|
| `src/mirror/lib/emerald.ts` | Widget toolkit `@tsix/emerald` |
| `src/mirror/lib/theme.ts` | Tema |
| `src/mirror/lib/cashew.ts` | Layer di atas Emerald (Modul 20) |
| `src/mirror/opt/dome/dome-client-dom.js` | DOME client DOM engine — `buildDOM()`, `handleUpdateProps()`, `ensureListener()` |
| `src/mirror/root/ps-sample2.ts`, `ps-sample3.ts` | Praktik |

---

## Latihan / Praktik

1. Baca `wiki/emerald-in-a-nutshell.md` — kerjakan Hello World sampai studi kasus lengkap.
2. Bangun form dengan input + button; bind event klik yang mengubah teks.
3. Gunakan `alert()`/`confirm()` — amati bagaimana ia tampil sebagai window overlay.
4. Baca `src/mirror/lib/emerald.ts` — cari implementasi `Screen` dan `setContent`.
5. Bangun `ConnectedDataGrid` dengan sort & resize kolom; pakai `appendData()` untuk data real-time dan `maxRows` untuk membatasi baris.

---

## Referensi

- `wiki/emerald-in-a-nutshell.md`, `wiki/cashew-in-a-nutshell.md`
- `wiki/PIXELSPACE_DEVELOPER_GUIDE.md` §5-7
- `src/mirror/lib/emerald.ts`, `src/mirror/lib/theme.ts`

---

*Modul 19 — selesai. Lanjut ke [Modul 20 — Cashew Component Framework](20-cashew-component-framework.md).*
