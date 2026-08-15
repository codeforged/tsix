# Changelog Emerald Widget Toolkit

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-08-15

### ConnectedTabulator — DataGrid baru berbasis Tabulator v6 (browser-side, theme-aware)
- **File:**
  - `src/mirror/lib/emerald.ts` — class `ConnectedTabulator` (API identik `ConnectedDataGrid`)
  - `src/mirror/lib/cashew.ts` — class `TTabulatorGrid` (API identik `TDataGrid`)
  - `src/mirror/opt/dome/dome-client-tabulator.js` **(baru)** — widget browser-side Tabulator
  - `src/mirror/opt/dome/dome-client.html` — CDN Tabulator 6.3.0 (JS + CSS `midnight`)
  - `src/mirror/opt/dome/dome-client-dom.js` — special-case tag `tabulator` di `buildDOM()`
  - `src/mirror/opt/dome/dome.ts` — relay `TB_*` (8 pesan) + static asset `dome-client-tabulator.js`
  - `src/mirror/opt/file-cruiser/file-cruiser.ts` — migrasi daftar file ke `ConnectedTabulator`
  - `src/mirror/opt/taskmgr/taskmgr.ts` — migrasi ke `ConnectedTabulator`
  - `src/mirror/usr/bin/bitshark.ts` — migrasi ke `TTabulatorGrid`
  - `src/mirror/opt/test/tab-demo.ts`, `tab-demo-csh.ts` **(baru)** — demo emerald & cashew
- **Latar belakang:** `ConnectedDataGrid` (render virtual-DOM app-side) sudah lama buggy (race `setContent`/mount, scroll reset saat seleksi, repaint sel di luar viewport, traffic IPC per-cell) dan sudah beberapa kali diperbaiki namun tidak tuntas. Pilihan: tambahkan grid browser-side yang stabil alih-alih memperbaiki yang lama.
- **Perubahan:**
  - **Widget baru** `ConnectedTabulator` (Emerald) & `TTabulatorGrid` (Cashew) — **ditambahkan, TIDAK menggantikan** `ConnectedDataGrid`/`TDataGrid` yang lama. Semua render (sort, resize kolom, selection, scroll) ditangani **Tabulator v6 di sisi browser** → bebas bug render, traffic IPC jauh lebih kecil (data dikirim sekali, render di browser).
  - **API 100% identik** dengan `ConnectedDataGrid`/`TDataGrid` → aplikasi consumer cukup ganti class, tidak perlu ubah logika. Ditambah `toggleSort()` di `TTabulatorGrid` (superset).
  - Komunikasi app→browser via relay DOME `TB_DATA / TB_APPEND / TB_COLS / TB_SORT / TB_SELECT / TB_CLEAR_SELECT / TB_DESTROY / TB_THEME` (pola `TChart`/uPlot); browser→app via event `tb_sort / tb_rowclick / tb_contextmenu / tb_select` (masuk ke `bindHandler`).
  - **Row-key stabil** via field `_tsixKey` (WeakMap app-side, objek user tidak dimutasi) → `selectedIndex`/`getRecord` tahan sort/refresh; `appendData()` inkremental (hanya baris baru dikirim).
  - **Race safety:** queue app-side `pendingDome` sampai PID DOME ter-resolve (`ensureDomePid`) + retry browser-side `withGrid` menunggu `initTabulator`.
  - **Theme-aware:** CSS Tabulator v6 hasil kompilasi memakai warna hardcoded (bukan CSS vars) → override stylesheet memetakan ke CSS var theme TSIX (`--bg/--surface/--accent/--text/--border/--accent-bg`) + push `TB_THEME` (warna `theme.colors`) saat mount & saat `THEME_CHANGED` → grid ikut dark/light theme secara otomatis.
  - `mount()` mendapat callback opsional ke-5 `onSelectionChange(index, record|null)` — menangani deselect (Tabulator toggle seleksi saat baris terpilih diklik lagi).
  - **Migrasi:** File Cruiser (daftar file + seleksi + double-click, field tersembunyi `_name/_isDir/_mode`, baris virtual `..`), Task Manager (`ConnectedTabulator`), bitshark (`TTabulatorGrid`).
- **Dampak:** Grid baru stabil, ringan, dan theme-aware; bug `ConnectedDataGrid` tidak lagi menghalangi app baru. Deploy: re-sync VFS + **restart DOME** (static asset di-cache saat startup) + hard-refresh browser (sekali).
- **Oleh:** Copilot · **Konsep, migrasi & validasi:** kakang

### Alert / Question / File Dialog tidak bisa diklik (tombol OK "cuek") — overlay layer global `pointer-events: none`
- **File:** `src/mirror/lib/emerald.ts`
- **Masalah:** Layer overlay global (`#__tsix_overlay_layer__`) dipasang `pointer-events: none` (dome-client-core.js) agar tidak memblokir klik ke window di bawahnya. `confirm()` eksplisit set `pointerEvents: "auto"`, tetapi `alert()`, `question()`, dan `_fileDialog()` **tidak** — dialog-dialog itu di-mount ke layer tersebut tanpa re-enable → dialog tampil tapi tidak menerima klik sama sekali (OK/Cancel "cuek"). Terlihat di bitshark: popup detail paket (`TDialogs.alert`) tidak bisa di-OK.
- **Perubahan:** Tambahkan `pointerEvents: "auto"` pada overlay + box di `Window.alert()`, `Window.question()`, dan `Screen._fileDialog()` (style `overlay` + `box` di `getStyle`) — konsisten dengan `confirm()`.
- **Dampak:** Semua dialog modal Emerald (alert, confirm, question, open/save file) kini interaktif. Deploy: sync `emerald.ts` ke VFS → restart app yang bersangkutan.
- **Oleh:** Copilot · **Laporan:** kakang (bitshark)

### Context menu (klik kanan) Task Manager tidak muncul — nama event Tabulator salah (`rowContextMenu` → `rowContext`)
- **File:** `src/mirror/opt/dome/dome-client-tabulator.js`
- **Masalah:** Di Tabulator v6, event klik-kanan baris bernama **`rowContext`** — bukan `rowContextMenu` (itu nama *option* `contextMenu`, bukan event). Akibatnya listener tidak pernah terpanggil → `tb_contextmenu` tidak terkirim ke app → `showContextMenu()` di taskmgr tidak pernah dieksekusi → klik kanan tidak memunculkan menu.
- **Perubahan:** Ganti `table.on("rowContextMenu", ...)` → `table.on("rowContext", ...)` + `e.preventDefault()` agar menu konteks native browser tidak ikut muncul. Event outbound tetap `tb_contextmenu` (tidak berubah di sisi app).
- **Dampak:** Context menu Task Manager (Close SIGTERM / Kill SIGKILL) kembali berfungsi. Deploy: sync `dome-client-tabulator.js` ke VFS → **restart DOME** + hard-refresh browser.
- **Oleh:** Copilot · **Laporan:** kakang (taskmgr)

### Title bar dengan ikon — opsi `icon` pada Window/Screen (ikon dulu, baru judul)
- **File:** `src/mirror/lib/emerald.ts`, `src/mirror/opt/dome/dome-client-windows.js`, `src/mirror/opt/dome/dome-client-ui.js`, `src/mirror/opt/dome/dome-client.html`
- **Perubahan:**
  - `WindowOptions`/`ScreenOptions` + opsi baru `icon?: string` (emoji/teks). Diteruskan via `CREATE_WINDOW` → title bar.
  - `dome-client-windows.js`: title bar kini membangun dua span terpisah — `.tsix-titlebar-icon` (kiri) + `.tsix-titlebar-title` (judul). `btnContainer` (`margin-left:auto`) tetap menempel kanan.
  - `dome-client-ui.js` `handleWindowTitle`: query diarahkan ke `.tsix-titlebar-title` (fallback `.tsix-titlebar span`) — update judul tidak salah sasaran ke span ikon.
  - `dome-client.html`: CSS `.tsix-titlebar-icon` (margin-right, ukuran 14px).
  - Contoh: File Cruiser → `new Screen({ title: "File Cruiser", icon: "📁", ... })`.
- **Dampak:** Judul window bisa punya ikon di kiri. Tanpa `icon`, tampilan identik seperti sebelumnya (judul di kiri). Deploy: sync `emerald.ts` + modul DOME ke VFS → **restart DOME** + hard-refresh browser.
- **Oleh:** Copilot · **Permintaan:** kakang
