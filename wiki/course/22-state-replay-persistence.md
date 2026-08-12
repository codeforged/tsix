---
module: 22
title: State Replay & Persistence
part: VII
partTitle: GUI & Desktop
status: done
lang: id
rfc: RFC-TSIX-EDU-002
audience: all
---

# State Replay & Persistence

**RFC-TSIX-EDU-002** | Modul kedua puluh dua kurikulum TSIX. Memahami bagaimana UI dipulihkan saat browser reconnect (F5): `windowStates`, `pruneWindowState`, orphan discard, findElementById di 3 layer, dan proteksi navigasi (`allowReload`).

> F5 di browser seharusnya **tidak menghapus desktop**. Sejak proteksi navigasi (DOME 2026-08-06), refresh butuh konfirmasi dulu. DOME menyimpan semua MOUNT_NODE & UPDATE_PROPS di `windowStates` dan mengirim ulang ke browser baru setelah reload dikonfirmasi. Pruning memastikan tidak ada state orphan yang bocor ke replay.

---

## Tujuan Pembelajaran

- [ ] Menjelaskan mekanisme State Replay
- [ ] Menjelaskan `pruneWindowState` dan mengapa diperlukan
- [ ] Menjelaskan browser-side orphan discard
- [ ] Menjelaskan `findElementById` di 3 layer
- [ ] Menjelaskan proteksi navigasi (`allowReload`) dan replay setelah reload
- [ ] Menjelaskan fallback `_savedRect` → `_origRect` saat restore
- [ ] Menjelaskan skenario bug yang dicegah (dialog residue setelah F5)

---

## Konsep Inti

### State Replay

`windowStates` = `Map<wid, state[]>` — menyimpan semua MOUNT_NODE & UPDATE_PROPS sebagai "replay payloads".

**Lifecycle** (di `dome.ts`, sisi server):

- `CREATE_WINDOW` → `windowStates.set(wid, [])` — inisialisasi riwayat state.
- `MOUNT_NODE` → push `{ type, wid, node, targetId }` ke array.
- `UPDATE_PROPS` → push `{ type, wid, targetId, props }` ke array.
- `UNMOUNT_NODE` → `pruneWindowState(wid, targetId)` lalu broadcast.
- `DESTROY_WINDOW` → `windowStates.delete(wid)` — riwayat dibersihkan.

**Replay saat reconnect (F5):**

```
Browser F5 → WebSocket reconnect
  → DOME kirim CREATE_WINDOW (semua window aktif)
  → DOME kirim semua stored states (MOUNT_NODE + UPDATE_PROPS)
  → jika entry.isMaximized → kirim MAXIMIZE_WINDOW (status maximize dipulihkan)
  → DOME kirim tema terakhir (lastThemeColors)
  → Browser build ulang UI + terima event dari user
```

Sisi browser, saat socket `onclose` semua window sesi lama dibuang (`state.windows.clear()`), lalu `onopen` siap menerima replay dari server.

### State Pruning (`pruneWindowState`)

Saat `UNMOUNT_NODE` dipanggil, DOME membersihkan state terkait:

1. **Collect**: untuk tiap state MOUNT_NODE, kumpulkan SEMUA nodeId dari tree-nya (termasuk child) via `collectNodeIds`.
2. **Filter**: hapus MOUNT_NODE jika `state.targetId === targetId` atau ada nodeId di tree-nya yang sama dengan `targetId`; UPDATE_PROPS hanya dihapus jika `state.targetId === targetId` (exact match).

Ini mencegah **child states** (dari `setContent()`) tersisa setelah parent di-unmount → mencegah residu DOM saat F5.

### Browser-side orphan discard

Jika `handleMountNode` menerima MOUNT_NODE dengan `targetId` yang tidak ditemukan di DOM, node **di-discard** (dibuang) — bukan fallback ke `win.content`. Mencegah:

- Wallpaper dialog child states muncul di desktop setelah F5
- Login overlay residue
- Modal/dialog orphan elements

### Overlay layer search

`findElementById(wid, nodeId)` mencari di 3 level:

1. `win.el.querySelector([data-tsix-id=...])` — di dalam window
2. `__global_start_menu__` — start menu global
3. `__tsix_overlay_layer__` — overlay layer (launcher, dialog)

Ini memungkinkan elemen yang di-extract ke overlay (mis. `launcher-grid`) tetap ditemukan oleh mount/replay.

### Proteksi Navigasi (konfirmasi refresh)

Sejak DOME 2026-08-06, refresh tidak lagi langsung jalan. IIFE `protectNavigation()` di `dome-client-core.js` memakai flag `allowReload`:

- **F5 / Ctrl+R / Cmd+R** di-intercept di fase capture → `preventDefault()` → dialog `window.confirm("Yakin mau refresh TDE? ...")`.
  - **OK** → set `allowReload = true`, lalu `location.reload()`.
  - **Cancel** → halaman tetap utuh, tidak ada reload.
- **back/forward, close tab, navigasi lain** → event `beforeunload` memunculkan dialog native browser; di-skip jika `allowReload` (agar refresh yang sudah dikonfirmasi tidak prompt ganda).
- `pointerdown` (sekali) menandai interaksi — mencegah Chrome 91+ mematikan `beforeunload` pada halaman yang belum disentuh.

Setelah reload yang dikonfirmasi, **state replay tetap bekerja**: DOME mengirim ulang CREATE_WINDOW + stored states ke koneksi WebSocket baru, sehingga desktop ter-restore penuh.

### Restore aman (`_savedRect` → `_origRect`)

Saat window di-restore (mis. setelah minimize), `handleRestoreWindow` memakai `_savedRect`. Jika `_savedRect` berdimensi nol (`width <= 0 || height <= 0`) — mis. sisa maximize saat window masih `display:none` — kode **fallback ke `win.el._origRect`**. Ini mencegah window ter-restore ke `(0,0,0,0)` (pojok kiri atas dengan ukuran aneh).

---

## Snippet (level kode)

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

### Pencarian lintas layer (`findElementById`)

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

### Proteksi navigasi (`protectNavigation`)

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

### Fallback restore (`_savedRect` → `_origRect`)

```js
let saved = win._savedRect;
// Safety: rect nol (mis. sisa maximize saat window masih hidden)
// → jangan restore ke (0,0,0,0), pakai posisi/ukuran asli.
if (saved && (saved.width <= 0 || saved.height <= 0)) {
  saved = win.el._origRect || null;
}
```

---

## Latihan / Praktik

1. Buka beberapa window (termasuk dialog/modal), lalu tekan F5 — muncul dialog konfirmasi; pilih **OK** — amati UI pulih via state replay. Pilih **Cancel** — desktop tidak berubah.
2. Tutup sebuah window yang punya child dialog, lalu F5 (OK) — amati tidak ada residu dialog.
3. Baca `src/mirror/opt/dome/dome.ts` — cari `windowStates`, `pruneWindowState`, dan blok replay saat reconnect.
4. Baca `src/mirror/opt/dome/dome-client-dom.js` — cari orphan discard di `handleMountNode`.
5. Baca `src/mirror/opt/dome/dome-client-core.js` — cari `findElementById` (3 layer) dan `protectNavigation` (`allowReload`).
6. Baca `src/mirror/opt/dome/dome-client-windows.js` — cari fallback `_savedRect` → `_origRect` di `handleRestoreWindow`.

---

## Referensi

- `wiki/PIXELSPACE_DEVELOPER_GUIDE.md` §11
- `wiki/course/00-overview.md` §10
- `src/mirror/opt/dome/dome.ts` (windowStates, pruneWindowState, replay)
- `src/mirror/opt/dome/dome-client-dom.js` (orphan discard)
- `src/mirror/opt/dome/dome-client-core.js` (findElementById, protectNavigation)
- `src/mirror/opt/dome/dome-client-windows.js` (_savedRect → _origRect)

---

*Modul 22 — selesai. Bagian VII tuntas. Lanjut ke [Modul 23 — Development Workflow](23-development-workflow.md).*
