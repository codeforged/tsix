---
module: 18
title: DOME Engine (Display Server)
part: VII
partTitle: GUI & Desktop
status: done
lang: id
rfc: RFC-TSIX-EDU-002
audience: all
---

# DOME Engine (Display Server)

**RFC-TSIX-EDU-002** | Modul kedelapan belas kurikulum TSIX. Memahami DOME: relay WebSocket + primitive DOM producer + kompositor (titlebar, drag, resize, focus, replay).

> DOME adalah display server TSIX — analog X11/Wayland, tapi dirender sebagai **DOM di browser host** via WebSocket :8080. Server-nya monolitik (satu daemon, relay + kompositor) karena pertimbangan latency drag/resize (kompositor terpisah = overhead ~2–4ms). Client browser justru modular: `dome.ts` menyajikan modul statis `dome-client-*.js` via `/dome/*.js`.

---

## Tujuan Pembelajaran

- [ ] Menjelaskan peran DOME sebagai relay + kompositor
- [ ] Menjelaskan spesifikasi & fitur DOME
- [ ] Menjelaskan tradeoff desain monolitik vs kompositor terpisah
- [ ] Menjelaskan peran `windowStates` dan replay
- [ ] Menjelaskan enforcement flag `maximizable` di semua jalur maximize
- [ ] Menjelaskan proteksi navigasi, per-app traffic, modul DDC, dan boot readiness
- [ ] Menjelaskan hubungan DOME ↔ Kernel ↔ Browser

---

## Konsep Inti

### Spesifikasi

| Aspek | Deskripsi |
|---|---|
| Lokasi | `src/mirror/opt/dome/dome.ts` (server) + `dome-client.html` tipis + modul `dome-client-*.js` (browser) |
| Port | WebSocket :8080 |
| Peran | Display server (Ring 4 daemon) |
| Model | Relay WS + primitive DOM producer + kompositor |

### Fitur

- Window registry, Z-index, relay event
- **State Replay** (`windowStates`): semua MOUNT_NODE & UPDATE_PROPS disimpan, dikirim ulang saat browser reconnect (F5)
- **State Pruning** (`pruneWindowState`): saat node di-unmount, DOME membersihkan state — mencegah orphan state leak ke replay
- **Orphan Discard** (browser-side): MOUNT_NODE dengan parent yang tidak ditemukan di-discard — mencegah residu dialog/modal setelah F5
- **Overlay Layer Search**: `findElementById` mencari di 3 level — `win.el` → `__global_start_menu__` → `__tsix_overlay_layer__`
- **Client modular**: logika browser dipisah ke modul statis `dome-client-core.js`, `-term.js`, `-codemirror.js`, `-chart.js`, `-dom.js`, `-windows.js`, `-ui.js`, `-ddc.js`, `-res.js`; `dome.ts` membacanya dari VFS `/opt/dome/*.js` saat startup dan menyajikannya via `/dome/*.js`
- **Flag `maximizable`**: dihormati di semua jalur maximize — double-click titlebar, context menu "Maximize", guard server `maximize_window`, dan guard syscall `MAXIMIZE_WINDOW`
- **Maximize saat minimized**: window ditampilkan dulu di posisi terakhir sebelum rect diukur; restore memakai `_origRect` jika `_savedRect` nol
- **Proteksi navigasi**: refresh (F5/Ctrl+R/Cmd+R) dan back/forward butuh konfirmasi (`protectNavigation()` + `beforeunload`)
- **Per-app traffic accounting**: `TRAFFIC_QUERY` meng-exclude traffic app penanya sendiri dan melaporkan `selfTxBytes`/`selfTxPkts`
- **Modul DDC**: `dome-client-ddc.js` menghost aplikasi Native-JS (Fabric.js / Three.js via CDN) di Shadow DOM; DOME merelay `DDC_MSG`/`DDC_RESIZE`/`DDC_STOP`; `destroyDDCByWid(wid)` dipanggil saat window ditutup
- **Boot readiness**: DOME menulis `/var/run/dome.ready`; `rc.local` mem-poll penanda (timeout 10s, interval 200ms) sebelum start Asteracea — menggantikan `sleep 1s`
- **`ensureListener()`**: memasang listener sekali per elemen per event — menggantikan pola `cloneNode` yang menghapus listener lama

### Tradeoff desain: kenapa monolitik?

| | Kompositor terpisah (X11-style) | DOME monolitik |
|---|---|---|
| Overhead | ~2–4ms per operasi drag/resize | langsung, tanpa IPC ekstra |
| Keuntungan | modularitas | latency rendah |

> Karena target utama adalah **interaksi drag/resize/focus** yang sensitif latency, DOME memilih monolitik. Ada catatan desain & rencana refactor di wiki.

---

## Alur Replay

```
Browser F5 → WebSocket reconnect
  → DOME kirim CREATE_WINDOW (semua window aktif)
  → DOME kirim semua stored states (MOUNT_NODE + UPDATE_PROPS)
  → Jika window sedang maximized, DOME kirim MAXIMIZE_WINDOW ulang
  → Browser build ulang UI + terima event dari user
```

---

## Snippet (level kode)

### State pruning (ringkas)

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

### Maximize guard — semua jalur hormati flag `maximizable`

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

### Restore aman — fallback saat rect tersimpan nol

```js
// dome-client-windows.js — handleRestoreWindow
let saved = win._savedRect;
if (saved && (saved.width <= 0 || saved.height <= 0)) {
    saved = win.el._origRect || null; // jangan restore ke (0,0,0,0)
}
```

### ensureListener — listener tidak dobel & tidak hilang

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

### Per-app traffic — observer tidak menghitung dirinya sendiri

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

### DDC cleanup — hentikan RAF loop saat window ditutup

```js
// dome-client-windows.js — handleDestroyWindow (safety net)
if (typeof TSIX.destroyDDCByWid === "function") {
    TSIX.destroyDDCByWid(wid); // stop semua runtime DDC window ini
}
```

---

## Latihan / Praktik

1. Buka `http://localhost:8080` — amati DOME client di browser.
2. Tekan F5 saat beberapa window terbuka — amati prompt konfirmasi navigasi dan state replay.
3. Baca `src/mirror/opt/dome/dome.ts` — temukan `windowStates`, `pruneWindowState`, guard `maximizable`, relay `DDC_*`, dan `TRAFFIC_QUERY`.
4. Baca `src/mirror/opt/dome/dome-client-windows.js` — cari `handleMaximizeWindow` (maximize-while-minimized) dan `handleRestoreWindow`.
5. Baca `src/mirror/opt/dome/dome-client-core.js` — cari `protectNavigation()`.
6. Baca `src/mirror/opt/dome/dome-client-ddc.js` — cari `initDDC` dan `destroyDDCByWid`.
7. Baca `src/mirror/opt/dome/dome-client-dom.js` — cari `ensureListener`.
8. Baca `src/mirror/etc/rc.local.ts` — cari polling `/var/run/dome.ready` sebelum start Asteracea.

---

## Referensi

- `wiki/PIXELSPACE_DEVELOPER_GUIDE.md` §2, §11
- `wiki/course/00-overview.md` §10
- `wiki/changelogs/dome.md` — riwayat perubahan DOME
- `src/mirror/opt/dome/dome.ts` + `src/mirror/opt/dome/dome-client-*.js`
- `src/mirror/etc/rc.local.ts` — polling `/var/run/dome.ready`

---

*Modul 18 — selesai. Lanjut ke [Modul 19 — Emerald Widget Toolkit](19-emerald-widget-toolkit.md).*
