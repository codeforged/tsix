---
module: 22
title: State Replay & Persistence
part: VII
partTitle: GUI & Desktop
status: done
lang: en
rfc: RFC-TSIX-EDU-002
audience: all
---

# State Replay & Persistence

**RFC-TSIX-EDU-002** | Module twenty-two of the TSIX curriculum. Understand how the UI is restored when the browser reconnects (F5): `windowStates`, `pruneWindowState`, orphan discard, findElementById across 3 layers, and navigation protection (`allowReload`).

> F5 in the browser should **not clear the desktop**. Since navigation protection (DOME 2026-08-06), refresh requires confirmation first. DOME stores all MOUNT_NODE & UPDATE_PROPS in `windowStates` and resends them to the new browser after reload is confirmed. Pruning ensures no orphan state leaks into the replay.

---

## Learning Objectives

- [ ] Explain the State Replay mechanism
- [ ] Explain `pruneWindowState` and why it is needed
- [ ] Explain browser-side orphan discard
- [ ] Explain `findElementById` across 3 layers
- [ ] Explain navigation protection (`allowReload`) and replay after reload
- [ ] Explain the `_savedRect` → `_origRect` fallback during restore
- [ ] Explain the bug scenarios that are prevented (dialog residue after F5)

---

## Core Concepts

### State Replay

`windowStates` = `Map<wid, state[]>` — stores all MOUNT_NODE & UPDATE_PROPS as "replay payloads".

**Lifecycle** (in `dome.ts`, server side):

- `CREATE_WINDOW` → `windowStates.set(wid, [])` — initializes the state history.
- `MOUNT_NODE` → push `{ type, wid, node, targetId }` to the array.
- `UPDATE_PROPS` → push `{ type, wid, targetId, props }` to the array.
- `UNMOUNT_NODE` → `pruneWindowState(wid, targetId)` then broadcast.
- `DESTROY_WINDOW` → `windowStates.delete(wid)` — the history is cleared.

**Replay on reconnect (F5):**

```
Browser F5 → WebSocket reconnect
  → DOME kirim CREATE_WINDOW (semua window aktif)
  → DOME kirim semua stored states (MOUNT_NODE + UPDATE_PROPS)
  → jika entry.isMaximized → kirim MAXIMIZE_WINDOW (status maximize dipulihkan)
  → DOME kirim tema terakhir (lastThemeColors)
  → Browser build ulang UI + terima event dari user
```

On the browser side, when the socket `onclose` fires, all windows from the old session are discarded (`state.windows.clear()`). Then `onopen` is ready to receive the replay from the server.

### State Pruning (`pruneWindowState`)

When `UNMOUNT_NODE` is called, DOME cleans up the related state:

1. **Collect**: for each MOUNT_NODE state, gather ALL nodeIds from its tree (including children) via `collectNodeIds`.
2. **Filter**: remove the MOUNT_NODE if `state.targetId === targetId`, or if any nodeId in its tree equals `targetId`. UPDATE_PROPS is only removed when `state.targetId === targetId` (exact match).

This prevents **child states** (from `setContent()`) from lingering after the parent is unmounted → prevents DOM residue on F5.

### Browser-side orphan discard

If `handleMountNode` receives a MOUNT_NODE whose `targetId` is not found in the DOM, the node **is discarded** — not a fallback to `win.content`. This prevents:

- Wallpaper dialog child states from appearing on the desktop after F5
- Login overlay residue
- Orphan modal/dialog elements

### Overlay layer search

`findElementById(wid, nodeId)` searches at 3 levels:

1. `win.el.querySelector([data-tsix-id=...])` — inside the window
2. `__global_start_menu__` — global start menu
3. `__tsix_overlay_layer__` — overlay layer (launcher, dialog)

This allows elements that were extracted to the overlay (e.g. `launcher-grid`) to still be found by mount/replay.

### Navigation Protection (refresh confirmation)

Since DOME 2026-08-06, refresh no longer runs directly. The `protectNavigation()` IIFE in `dome-client-core.js` uses the `allowReload` flag:

- **F5 / Ctrl+R / Cmd+R** is intercepted in the capture phase → `preventDefault()` → `window.confirm("Yakin mau refresh TDE? ...")` dialog.
  - **OK** → sets `allowReload = true`, then `location.reload()`.
  - **Cancel** → the page stays intact, no reload.
- **back/forward, close tab, other navigation** → the `beforeunload` event shows the native browser dialog. It is skipped when `allowReload` is set (so an already-confirmed refresh does not prompt twice).
- `pointerdown` (once) marks interaction — prevents Chrome 91+ from disabling `beforeunload` on pages that have not been touched yet.

After a confirmed reload, **state replay still works**: DOME resends CREATE_WINDOW + stored states to the new WebSocket connection, so the desktop is fully restored.

### Safe restore (`_savedRect` → `_origRect`)

When a window is restored (e.g. after minimize), `handleRestoreWindow` uses `_savedRect`. If `_savedRect` has zero dimensions (`width <= 0 || height <= 0`) — e.g. leftover from maximize while the window is still `display:none` — the code **falls back to `win.el._origRect`**. This prevents the window from being restored to `(0,0,0,0)` (top-left corner with odd dimensions).

---

## Snippet (code level)

### Pruning (`pruneWindowState`)

```ts
const collectNodeIds = (node: any, ids: Set<string>): void => {
  if (!node || typeof node !== "object") return;
  if (typeof node.id === "string" && node.id) ids.add(node.id);
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectNodeIds(child, ids);
  }
};

const pruneWindowState = (wid: string, targetId: string): void => {
  const states = windowStates.get(wid) || [];
  const filtered = states.filter((state: any) => {
    if (state?.type === "MOUNT_NODE") {
      const nodeIds = new Set<string>();
      collectNodeIds(state.node, nodeIds);
      // hapus MOUNT_NODE jika targetId-nya = targetId, atau
      // nodeId di dalam tree-nya ada yang = targetId (termasuk child)
      if (state.targetId === targetId || nodeIds.has(targetId))
        return false;
    }
    if (state?.type === "UPDATE_PROPS") {
      if (state.targetId === targetId) return false; // exact match saja
    }
    return true;
  });
  windowStates.set(wid, filtered);
};
```

### Browser orphan discard

```js
if (targetId) {
  const parent = TSIX.findElementById(wid, targetId);
  if (parent) {
    parent.appendChild(domEl);
  } else {
    // Parent not found — discard (jangan fallback ke win.content)
  }
} else {
  win.content.appendChild(domEl);
}
```

### Cross-layer search (`findElementById`)

```js
function findElementById(wid, nodeId) {
  // 1) di dalam window milik app
  const win = state.windows.get(wid);
  if (win) {
    const el = win.el.querySelector(
      '[data-tsix-id="' + CSS.escape(nodeId) + '"]',
    );
    if (el) return el;
  }
  // 2) start menu global
  const gm = document.getElementById("__global_start_menu__");
  if (gm) {
    if (gm.getAttribute("data-tsix-id") === nodeId) return gm;
    const child = gm.querySelector(
      '[data-tsix-id="' + CSS.escape(nodeId) + '"]',
    );
    if (child) return child;
  }
  // 3) overlay layer (launcher, dialog)
  const overlay = document.getElementById("__tsix_overlay_layer__");
  if (overlay) {
    if (overlay.getAttribute("data-tsix-id") === nodeId) return overlay;
    const child = overlay.querySelector(
      '[data-tsix-id="' + CSS.escape(nodeId) + '"]',
    );
    if (child) return child;
  }
  return null;
}
```

### Navigation protection (`protectNavigation`)

```js
(function protectNavigation() {
  let allowReload = false; // true saat user sudah konfirmasi refresh

  // Tandai interaksi user — Chrome 91+ mematikan beforeunload
  // jika halaman belum pernah disentuh.
  document.addEventListener("pointerdown", function () { }, { once: true });

  const isRefreshKey = (e) =>
    e.key === "F5" ||
    ((e.key === "r" || e.key === "R") && (e.ctrlKey || e.metaKey));

  document.addEventListener(
    "keydown",
    function (e) {
      if (!isRefreshKey(e) || e.repeat) return;
      e.preventDefault();
      const ok = window.confirm(
        "Yakin mau refresh TDE?\n\n" +
        "Semua window yang berjalan akan ditutup lalu di-restore " +
        "ulang dari server.\n\n" +
        "OK = refresh, Cancel = batal",
      );
      if (ok) {
        allowReload = true;
        window.location.reload();
      }
    },
    true, // fase capture
  );

  window.addEventListener("beforeunload", function (e) {
    if (allowReload) return; // refresh yang sudah dikonfirmasi
    e.preventDefault();
    e.returnValue = "";
  });
})();
```

### Restore fallback (`_savedRect` → `_origRect`)

```js
let saved = win._savedRect;
// Safety: rect nol (mis. sisa maximize saat window masih hidden)
// → jangan restore ke (0,0,0,0), pakai posisi/ukuran asli.
if (saved && (saved.width <= 0 || saved.height <= 0)) {
  saved = win.el._origRect || null;
}
```

---

## Exercises / Practice

1. Open several windows (including dialog/modal), then press F5 — a confirmation dialog appears. Choose **OK** — observe the UI restored via state replay. Choose **Cancel** — the desktop is unchanged.
2. Close a window that has a child dialog, then F5 (OK) — observe no dialog residue.
3. Read `src/mirror/opt/dome/dome.ts` — find `windowStates`, `pruneWindowState`, and the replay block on reconnect.
4. Read `src/mirror/opt/dome/dome-client-dom.js` — find the orphan discard in `handleMountNode`.
5. Read `src/mirror/opt/dome/dome-client-core.js` — find `findElementById` (3 layers) and `protectNavigation` (`allowReload`).
6. Read `src/mirror/opt/dome/dome-client-windows.js` — find the `_savedRect` → `_origRect` fallback in `handleRestoreWindow`.

---

## References

- `wiki/PIXELSPACE_DEVELOPER_GUIDE.md` §11
- `wiki/course/00-overview.md` §10
- `src/mirror/opt/dome/dome.ts` (windowStates, pruneWindowState, replay)
- `src/mirror/opt/dome/dome-client-dom.js` (orphan discard)
- `src/mirror/opt/dome/dome-client-core.js` (findElementById, protectNavigation)
- `src/mirror/opt/dome/dome-client-windows.js` (_savedRect → _origRect)

---

*Module 22 — complete. Part VII is done. Continue to [Module 23 — Development Workflow](23-development-workflow.en.md).*
