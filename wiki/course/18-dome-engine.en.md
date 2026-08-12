---
module: 18
title: DOME Engine (Display Server)
part: VII
partTitle: GUI & Desktop
status: done
lang: en
rfc: RFC-TSIX-EDU-002
audience: all
---

# DOME Engine (Display Server)

**RFC-TSIX-EDU-002** | Eighteenth module of the TSIX curriculum. Understand DOME: WebSocket relay + primitive DOM producer + compositor (titlebar, drag, resize, focus, replay).

> DOME is the TSIX display server — analogous to X11/Wayland, but rendered as **DOM in the host browser** via WebSocket :8080. The server is monolithic (single daemon, relay + compositor) because of drag/resize latency considerations (a separate compositor = ~2–4ms overhead). The browser client is instead modular: `dome.ts` serves static `dome-client-*.js` modules via `/dome/*.js`.

---

## Learning Objectives

- [ ] Explain DOME's role as a relay + compositor
- [ ] Explain the DOME specification & features
- [ ] Explain the monolithic vs separate-compositor design tradeoff
- [ ] Explain the role of `windowStates` and replay
- [ ] Explain the enforcement of the `maximizable` flag on all maximize paths
- [ ] Explain navigation protection, per-app traffic, DDC modules, and boot readiness
- [ ] Explain the DOME ↔ Kernel ↔ Browser relationship

---

## Core Concepts

### Specification

| Aspect | Description |
|---|---|
| Location | `src/mirror/opt/dome/dome.ts` (server) + thin `dome-client.html` + `dome-client-*.js` modules (browser) |
| Port | WebSocket :8080 |
| Role | Display server (Ring 4 daemon) |
| Model | WS relay + primitive DOM producer + compositor |

### Features

- Window registry, Z-index, event relay
- **State Replay** (`windowStates`): all MOUNT_NODE & UPDATE_PROPS are stored, then re-sent when the browser reconnects (F5)
- **State Pruning** (`pruneWindowState`): when a node is unmounted, DOME cleans up the state — prevents orphan state from leaking into replay
- **Orphan Discard** (browser-side): MOUNT_NODE whose parent is not found is discarded — prevents dialog/modal residue after F5
- **Overlay Layer Search**: `findElementById` searches 3 levels — `win.el` → `__global_start_menu__` → `__tsix_overlay_layer__`
- **Modular client**: browser logic is split into static modules `dome-client-core.js`, `-term.js`, `-codemirror.js`, `-chart.js`, `-dom.js`, `-windows.js`, `-ui.js`, `-ddc.js`, `-res.js`; `dome.ts` reads them from VFS `/opt/dome/*.js` at startup and serves them via `/dome/*.js`
- **`maximizable` flag**: honored on all maximize paths — double-click titlebar, "Maximize" context menu, server guard `maximize_window`, and syscall guard `MAXIMIZE_WINDOW`
- **Maximize while minimized**: the window is first shown at its last position before the rect is measured; restore uses `_origRect` if `_savedRect` is zero
- **Navigation protection**: refresh (F5/Ctrl+R/Cmd+R) and back/forward require confirmation (`protectNavigation()` + `beforeunload`)
- **Per-app traffic accounting**: `TRAFFIC_QUERY` excludes the asking app's own traffic and reports `selfTxBytes`/`selfTxPkts`
- **DDC module**: `dome-client-ddc.js` hosts Native-JS apps (Fabric.js / Three.js via CDN) in a Shadow DOM; DOME relays `DDC_MSG`/`DDC_RESIZE`/`DDC_STOP`; `destroyDDCByWid(wid)` is called when a window is closed
- **Boot readiness**: DOME writes `/var/run/dome.ready`; `rc.local` polls the marker (10s timeout, 200ms interval) before starting Asteracea — replaces `sleep 1s`
- **`ensureListener()`**: attaches a listener once per element per event — replaces the `cloneNode` pattern that dropped old listeners

### Design tradeoff: why monolithic?

| | Separate compositor (X11-style) | Monolithic DOME |
|---|---|---|
| Overhead | ~2–4ms per drag/resize operation | direct, no extra IPC |
| Advantage | modularity | low latency |

> Because the main target is **latency-sensitive drag/resize/focus interaction**, DOME chose to be monolithic. There is a design note & refactor plan in the wiki.

---

## Replay Flow

```
Browser F5 → WebSocket reconnect
  → DOME kirim CREATE_WINDOW (semua window aktif)
  → DOME kirim semua stored states (MOUNT_NODE + UPDATE_PROPS)
  → Jika window sedang maximized, DOME kirim MAXIMIZE_WINDOW ulang
  → Browser build ulang UI + terima event dari user
```

---

## Snippets (code level)

### State pruning (condensed)

```ts
const allIds = new Set<string>([targetId]);
for (const state of states) {
    if (state?.type === "MOUNT_NODE" && state.node) {
        const nodeIds = new Set<string>();
        collectNodeIds(state.node, nodeIds);
        if (nodeIds.has(targetId)) for (const id of nodeIds) allIds.add(id);
    }
}
// Hapus MOUNT_NODE (parent atau node di dalam tree) & UPDATE_PROPS (target exact match)
```

### Browser orphan discard

```js
if (parent) {
    parent.appendChild(domEl);
} else {
    console.log('[DEBUG] Orphan discarded:', node.id, targetId); // DISCARD
}
```

### Maximize guard — all paths honor the `maximizable` flag

```js
// dome-client-windows.js — double-click titlebar & handleMaximizeWindow
if (!w._isMaximized && w.maximizable === false) return; // titlebar dbl-click
if (win.maximizable === false) return;                   // handleMaximizeWindow
```

```ts
// dome.ts — guard otoritatif sisi server (event browser + syscall)
if (event.eventType === "maximize_window") {
    if (entry.maximizable === false) return;
}
// syscall GUIAction.MAXIMIZE_WINDOW
if (windows.get(wid)?.maximizable === false) break;
```

### Safe restore — fallback when the saved rect is zero

```js
// dome-client-windows.js — handleRestoreWindow
let saved = win._savedRect;
if (saved && (saved.width <= 0 || saved.height <= 0)) {
    saved = win.el._origRect || null; // jangan restore ke (0,0,0,0)
}
```

### ensureListener — listeners are not duplicated and not lost

```js
// dome-client-dom.js — dipakai buildDOM() & handleUpdateProps()
function ensureListener(el, event, listener) {
    if (!el.__tsixL) el.__tsixL = Object.create(null);
    if (!el.__tsixL[event]) {
        el.addEventListener(event, listener);
        el.__tsixL[event] = true;
    }
}
```

### Per-app traffic — the observer does not count itself

```ts
// dome.ts — TRAFFIC_QUERY meng-exclude traffic app penanya
const self = appTraffic.get(payload.pid) || { txBytes: 0, txPkts: 0 };
const stats = {
    ...wsTraffic,
    txBytes: Math.max(0, wsTraffic.txBytes - self.txBytes),
    txPkts: Math.max(0, wsTraffic.txPkts - self.txPkts),
    selfTxBytes: self.txBytes, // traffic milik app penanya
    selfTxPkts: self.txPkts,
};
```

### DDC cleanup — stop the RAF loop when the window is closed

```js
// dome-client-windows.js — handleDestroyWindow (safety net)
if (typeof TSIX.destroyDDCByWid === "function") {
    TSIX.destroyDDCByWid(wid); // stop semua runtime DDC window ini
}
```

---

## Practice / Hands-on

1. Open `http://localhost:8080` — observe the DOME client in the browser.
2. Press F5 while several windows are open — observe the navigation confirmation prompt and the state replay.
3. Read `src/mirror/opt/dome/dome.ts` — find `windowStates`, `pruneWindowState`, the `maximizable` guard, the `DDC_*` relay, and `TRAFFIC_QUERY`.
4. Read `src/mirror/opt/dome/dome-client-windows.js` — find `handleMaximizeWindow` (maximize-while-minimized) and `handleRestoreWindow`.
5. Read `src/mirror/opt/dome/dome-client-core.js` — find `protectNavigation()`.
6. Read `src/mirror/opt/dome/dome-client-ddc.js` — find `initDDC` and `destroyDDCByWid`.
7. Read `src/mirror/opt/dome/dome-client-dom.js` — find `ensureListener`.
8. Read `src/mirror/etc/rc.local.ts` — find the polling of `/var/run/dome.ready` before starting Asteracea.

---

## References

- `wiki/PIXELSPACE_DEVELOPER_GUIDE.md` §2, §11
- `wiki/course/00-overview.en.md` §10
- `wiki/changelogs/dome.md` — DOME change history
- `src/mirror/opt/dome/dome.ts` + `src/mirror/opt/dome/dome-client-*.js`
- `src/mirror/etc/rc.local.ts` — polling of `/var/run/dome.ready`

---

*Module 18 — done. Continue to [Module 19 — Emerald Widget Toolkit](19-emerald-widget-toolkit.en.md).*
