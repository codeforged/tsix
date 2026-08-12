---
module: 19
title: Emerald Widget Toolkit
part: VII
partTitle: GUI & Desktop
status: done
lang: en
rfc: RFC-TSIX-EDU-002
audience: all
---

# Emerald Widget Toolkit

**RFC-TSIX-EDU-002** | Module nineteen of the TSIX curriculum. Understand the GUI toolkit layer on top of the stable protocol: the Screen wrapper, factory functions, and self-rendering connected widgets.

> Emerald (`@tsix/emerald`) is the GTK/Qt of TSIX. All UI is built as a **Virtual DOM Tree** (`IDOMNode`) and sent via syscall — applications have **no access** to `document`, `window`, or any browser API.

---

## Learning Objectives

- [ ] Explain the position of Emerald in the GUI stack
- [ ] Explain factory functions (`div`, `button`, `input`, ...)
- [ ] Explain the Screen wrapper & the mount → bind → loop pattern
- [ ] Explain connected widgets (self-rendering), including `ConnectedDataGrid`
- [ ] Explain `ensureListener()` — listener props persistent across `UPDATE_PROPS` (`cloneNode` bug fixed)

---

## Core Concepts

### Position in the architecture

```
BROWSER → DOME (display server) → KERNEL (auth) → EMERALD (kamu di sini)
```

### Basic app structure

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

Factories produce `IDOMNode`. The full list is in `src/mirror/lib/emerald.ts`:

- Basic: `text()`, `div()`, `span()`, `h1()`/`h2()`/`h3()`, `paragraph()`, `button()`, `input()`, `textarea()`, `selectBox()`, `image()`
- IoT: `lineChart()`, `radialGauge()`, `verticalGauge()`, `sevenSegment()`, `indicatorLamp()`, `toggleSwitch()`, `sensorCard()`, `relayCard()`, `badge()`, `taskbarButton()`
- Table: `dataGrid()` (static), `slider()`

`alert()`, `confirm()`, `question()`, `openFileDialog()`, `saveFileDialog()` are **not factories** — they are methods on `Window`/`Screen` that show modal overlay dialogs, not functions that produce `IDOMNode`.

### Basic pattern: Mount → Bind → Loop

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

Connected widgets render themselves and update the screen on their own — a higher-level pattern than plain factories. The common pattern is `build()` → `mount(screen)` → `setData()`/`setValue()`, using **targeted updates** (not a full `setContent`).

The `Connected*` classes in `emerald.ts`:

- `ConnectedLineChart`, `ConnectedRadialGauge`, `ConnectedSevenSegment`, `ConnectedIndicatorLamp`
- `ConnectedVerticalGauge`, `ConnectedToggle`, `ConnectedSensorCard`, `ConnectedRelayCard`
- `ConnectedDataGrid` — interactive data table: asc/desc sort, column resize (native drag), row selection based on stable keys, incremental `appendData()` & `maxRows` option. One scroll container (sticky `th` header) — horizontal & vertical scroll automatically stay in sync.

> [!IMPORTANT] **Listener props & `ensureListener()` (`cloneNode` bug fixed).**
> Four listener props — `onClickId`, `onContextMenuId`, `onInputId`, `onKeydownId` — are installed by the DOME client through the `ensureListener()` helper in `src/mirror/opt/dome/dome-client-dom.js` (used in `buildDOM()` and `handleUpdateProps()`), **once per element per event type** (tracked via `el.__tsixL`). Previously `handleUpdateProps` cloned nodes to "clean up old listeners" — `cloneNode` does not copy listeners, so if one batch of `UPDATE_PROPS` carries several listener props at once (e.g. `onInputId` + `onKeydownId` on a password field), a newly installed listener could be lost. With `ensureListener`, listeners are **persistent across `UPDATE_PROPS`** — not lost and not duplicated. Best practice still applies: set listener props (`onClickId`, `onInputId`, etc.) **at mount time** (in `build()`/`mount()`), then register callbacks via `screen.on()` / `win.bindHandler()`.

---

## Source Code

| File | Role |
|---|---|
| `src/mirror/lib/emerald.ts` | Widget toolkit `@tsix/emerald` |
| `src/mirror/lib/theme.ts` | Theme |
| `src/mirror/lib/cashew.ts` | Layer on top of Emerald (Module 20) |
| `src/mirror/opt/dome/dome-client-dom.js` | DOME client DOM engine — `buildDOM()`, `handleUpdateProps()`, `ensureListener()` |
| `src/mirror/root/ps-sample2.ts`, `ps-sample3.ts` | Practice |

---

## Exercises / Practice

1. Read `wiki/emerald-in-a-nutshell.md` — work through Hello World up to the complete case study.
2. Build a form with an input + button; bind a click event that changes the text.
3. Use `alert()`/`confirm()` — observe how it appears as a window overlay.
4. Read `src/mirror/lib/emerald.ts` — find the `Screen` and `setContent` implementations.
5. Build a `ConnectedDataGrid` with column sort & resize; use `appendData()` for real-time data and `maxRows` to limit rows.

---

## References

- `wiki/emerald-in-a-nutshell.md`, `wiki/cashew-in-a-nutshell.md`
- `wiki/PIXELSPACE_DEVELOPER_GUIDE.md` §5-7
- `src/mirror/lib/emerald.ts`, `src/mirror/lib/theme.ts`

---

*Module 19 — done. Continue to [Module 20 — Cashew Component Framework](20-cashew-component-framework.en.md).*
