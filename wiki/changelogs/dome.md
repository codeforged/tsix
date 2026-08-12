# Changelog DOME Engine

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-08-06

### Maximize mengabaikan flag `maximizable` — double-click titlebar & menu taskbar tetap bisa maximize
- **File:** `src/mirror/opt/dome/dome-client-windows.js`, `src/mirror/opt/dome/dome-client-ui.js`, `src/mirror/opt/dome/dome.ts`
- **Masalah:** Properti `maximizable` hanya dipakai untuk menyembunyikan tombol maximize di titlebar; tidak disimpan sebagai state window dan tidak dicek oleh jalur maximize lain. Window dengan `maximizable: false` (mis. `ps-sample1.ts`) tetap bisa di-maximize lewat **double-click titlebar** dan item **"Maximize"** di context menu taskbar (item tidak disable).
- **Perubahan:**
  - `dome-client-windows.js`:
    - State window (`S.windows`) kini menyimpan `maximizable` & `fullscreen` saat `CREATE_WINDOW`.
    - `titleBar.ondblclick` guard: `if (!w._isMaximized && w.maximizable === false) return;` (tetap boleh unmaximize jika sudah maximized).
    - `handleMaximizeWindow` guard: `if (win.maximizable === false) return;` (defense-in-depth).
  - `dome-client-ui.js`:
    - `makeItem()` mendukung opsi `disabled` (abu-abu, cursor `default`, tidak bisa diklik).
    - Item "Maximize" di context menu taskbar: **disabled** saat `maximizable === false` (konsisten dgn tombol titlebar); berubah jadi **"Restore Down"** (unmaximize) saat window sudah maximized.
  - `dome.ts` (guard otoritatif sisi server):
    - Jalur event browser `maximize_window`: `if (entry.maximizable === false) return;` (tidak diteruskan ke app, tidak set `isMaximized`, tidak broadcast).
    - Jalur syscall `case GUIAction.MAXIMIZE_WINDOW`: `if (windows.get(wid)?.maximizable === false) break;`.
- **Dampak:** Semua jalur maximize (titlebar dbl-click, tombol, context menu, syscall app) menghormati flag `maximizable`. Deploy: restart DOME + hard-refresh browser.
- **Oleh:** Copilot

### Maximize saat window minimized — window tetap hidden + rect tersimpan nol (0,0,0,0)
- **File:** `src/mirror/opt/dome/dome-client-windows.js`
- **Masalah:** Saat aplikasi di-minimize lalu user pilih **"Maximize"** di context menu taskbar (klik kanan):
  - `handleMaximizeWindow()` berjalan tapi window masih `display:none` → `getBoundingClientRect()` mengembalikan `(0,0,0,0)` → `_savedRect`/`_unmaximizeRect` tersimpan nol, dan window tidak pernah ditampilkan → **tidak terlihat apa-apa** ("diam saja").
  - Klik kiri taskbar berikutnya (Asteracea kirim `restore_window`) → `handleRestoreWindow()` restore ke `_savedRect` nol → window muncul di **pojok kiri atas dengan ukuran aneh**, sementara `_isMaximized` masih `true` → **titlebar menunjukkan status maximized**.
- **Perubahan:**
  - `handleMaximizeWindow()`: jika window sedang `display:none`, **tampilkan dulu di posisi terakhir** (pakai `_savedRect` dari operasi minimize, restore `minHeight` & tombol titlebar, force reflow) baru lanjut animasi maximize. Dengan begitu rect yang disimpan valid (bukan nol) dan window langsung terlihat maksimal.
  - `handleRestoreWindow()`: safety fallback — jika `_savedRect` berdimensi nol (≤0), pakai `win.el._origRect` sebagai pengganti.
- **Dampak:** Minimize → context menu Maximize kini langsung menampilkan window fullscreen; restore tidak lagi menghasilkan rect aneh. Deploy: restart DOME + hard-refresh browser.
- **Oleh:** Copilot

### Proteksi navigasi — konfirmasi sebelum refresh/back tidak sengaja
- **File:** `src/mirror/opt/dome/dome-client-core.js`
- **Masalah:** User sering tidak sengaja refresh (F5 / Ctrl+R / Cmd+R) atau back gesture (macOS trackpad) di browser TDE → seluruh desktop hilang dan harus menunggu reconnect + replay state.
- **Perubahan:** IIFE `protectNavigation()` di akhir `dome-client-core.js`:
  - Intercept `keydown` F5 / Ctrl+R / Cmd+R (+Shift) di phase capture → `preventDefault()` + `window.confirm` custom ("Yakin mau refresh TDE? OK/Cancel"). Jika OK → set flag `allowReload` + `location.reload()`.
  - `beforeunload` → dialog native browser untuk back/forward, close tab, dan navigasi lain; di-skip jika `allowReload` (agar refresh yang sudah dikonfirmasi tidak prompt ganda).
  - `pointerdown` (once) menandai interaksi — mencegah browser (Chrome 91+) menekan beforeunload pada halaman yang belum disentuh.
- **Dampak:** Refresh/back butuh konfirmasi dulu; cancel = halaman tetap utuh. Deploy: restart DOME + hard-refresh browser (sekali, untuk memuat JS baru).
- **Oleh:** Copilot

---

## 2026-08-05

### Per-app traffic accounting — observer tidak menghitung dirinya sendiri
- **File:** `src/mirror/opt/dome/dome.ts`, `src/mirror/opt/pixelspace-traffic/pixelspace-traffic.ts`
- **Masalah:** PixelSpace Traffic Monitor (observer) menghitung traffic visualisasi-nya sendiri (chart data + update label) → dengan hanya monitor yang jalan tetap terbaca ±3.3KB/s.
- **Perubahan:**
  - `dome.ts`: tambah **per-app TX accounting** — `broadcastToAll` mencatat bytes/pkts ke `appTraffic[pid]` sesuai sumber pesan:
    - Relay `ipc_message` → `currentSrcPid = msg.fromPid` (sender PID dari kernel SEND_MSG; 3 `await std.log` chart dijadikan `void` biar atribusi bebas race).
    - Render GUI (`gui_request`) → `currentSrcPid = payload.pid`.
    - Pesan browser → `currentSrcPid = 0` (bukan traffic app).
  - `TRAFFIC_QUERY` kini **meng-exclude traffic milik app penanya (self)**: `txBytes/txPkts/appTxBytes` laporannya dikurangi `self.txBytes/self.txPkts`; tambah field baru `selfTxBytes`/`selfTxPkts` (bisa ditampilkan). `appTraffic` di-reset tiap interval.
  - `pixelspace-traffic.ts`: status bar menampilkan `🧿 self-excluded <x>/s` sebagai verifikasi.
- **Dampak:** Monitor jadi pengamat netral — hanya traffic app lain (dan browser events) yang terukur; traffic visualisasi miliknya sendiri di-exclude.
- **Oleh:** Copilot

### Modul client DDC (dome-client-ddc.js) + CDN Fabric.js/Three.js
- **File:** `src/mirror/opt/dome/dome-client-ddc.js` (baru), `src/mirror/opt/dome/dome.ts`, `src/mirror/opt/dome/dome-client.html`, `src/mirror/opt/dome/dome-client-dom.js`, `src/mirror/opt/dome/dome-client-windows.js`
- **Perubahan:**
  - Modul baru `dome-client-ddc.js` — host aplikasi DDC: mount NJ app di Shadow DOM, daftarkan inbound `DDC_MSG`/`DDC_RESIZE`/`DDC_STOP`, expose `TSIX.initDDC(el, wid, props)`.
  - `dome.ts`: relay `DDC_MSG`/`DDC_RESIZE`/`DDC_STOP` + tambah modul ke daftar `DOME_CLIENT_JS`.
  - `dome-client.html`: CDN **fabric.js 5.3.1** & **three.js r128** + `<script>` ddc.
  - `dome-client-dom.js`: special case `tag === "ddc"` di `buildDOM`.
  - `dome-client-windows.js`: panggil `destroyDDCByWid(wid)` saat window ditutup (stop RAF loop DDC — cegah resource leak).
- **Dampak:** Aplikasi Native JavaScript (animasi Fabric/Three) bisa berjalan di window TSIX. Detail lengkap di changelog `ddc.md`.
- **Oleh:** Copilot

---

## 2026-08-04

### Login asteracea selalu gagal — fix listener DOM (cloneNode menghapus listener)
- **File:** `src/mirror/opt/dome/dome-client-dom.js`
- **Masalah:** `handleUpdateProps` memakai `cloneNode` untuk "membersihkan listener lama". Jika satu batch `UPDATE_PROPS` membawa >1 listener props untuk elemen yang sama (mis. field password login asteracea mengirim `{ onInputId, onKeydownId }` sekaligus), clone ke-2 menghapus listener ke-1 (cloneNode tidak menyalin listener) → listener `input` mati → ketikan password tidak terkirim → `loginPass` selalu kosong → login ditolak meski password benar. Gejala lama: login "berhasil" karena field di-prefill `"1"` sehingga tidak pernah butuh mengetik.
- **Perubahan:** Helper baru `ensureListener(el, event, listener)` memasang listener sekali per elemen per event type (dilacak via `el.__tsixL`). Dipakai di `buildDOM()` dan `handleUpdateProps()` untuk `onClickId`, `onContextMenuId`, `onInputId`, `onKeydownId` (menggantikan pola cloneNode).
- **Dampak:** Elemen dengan banyak listener (input + keydown) kini dua-duanya aktif; input aplikasi lain tidak terpengaruh (elemen hasil re-mount tetap fresh). Deploy: sync ke VFS → restart DOME (staticAssets dibaca saat startup) → hard-refresh browser.
- **Oleh:** Copilot

### dome-client monolitik dipisah menjadi modul statis
- **File:** `src/mirror/opt/dome/dome-client.html` → modul: `dome-client-core.js`, `dome-client-term.js`, `dome-client-codemirror.js`, `dome-client-chart.js`, `dome-client-dom.js`, `dome-client-windows.js`, `dome-client-ui.js`
- **Perubahan:** Logika JS inline dipisah per fungsi ke modul statis. `dome.ts` memuat semua modul dari VFS `/opt/dome/*.js` ke `staticAssets` saat startup dan menyajikannya via rute `/dome/*.js`; HTML kini tipis (CSS + tag `<script>`).
- **Dampak:** Kode client terorganisir per tanggung jawab (core/term/codemirror/chart/dom/windows/ui); debug lebih mudah. Backup monolit lama: `dome-client.html.bak`.
- **Oleh:** Copilot

### Boot readiness — penanda `/var/run/dome.ready`
- **File:** `src/mirror/opt/dome/dome.ts`, `src/mirror/etc/rc.local.ts`
- **Masalah:** Asteracea memanggil `CREATE_WINDOW` sebelum DOME terdaftar sebagai GUI daemon → kernel melempar `"GUI_REQ: DOME engine is not running"` → layar blank dengan background khas dome saat boot.
- **Perubahan:** DOME menulis `/var/run/dome.ready` (berisi PID) di callback `server.listen`. `rc.local` menghapus penanda, memulai `/opt/dome/dome.js`, lalu mempoll penanda (timeout 10s, interval 200ms) sebelum menjalankan `/opt/asteracea/asteracea.js` (menggantikan sleep 1000ms).
- **Dampak:** Tidak ada lagi race antara DOME dan Asteracea saat boot.
- **Oleh:** Copilot

---

## 2026-08-03

### DataGrid — resize kolom scope fix (header + body ikut resize)
- **File:** `src/mirror/bin/dome-client.html`
- **Masalah:** Setelah ConnectedDataGrid pindah ke satu scroll container, handler resize kolom mencari scope via `table.parentElement` (thead-scroll yang sudah tidak ada) → colgroup body tidak ikut resize saat drag, dan event `col_resized` dikirim ke targetId salah.
- **Perubahan:** Scope resize kini `table.closest(".tsix-dgrid")` — wrapper grid (selalu berisi semua colgroup header & body). Komentar header-table-wrapper sudah tidak ada (diperbarui).
- **Dampak:** Drag resize kolom kembali menyinkronkan header + body. `col_resized` dikirim ke `targetId` grid yang benar.
- **Oleh:** Copilot

### DataGrid — hapus kompensasi lebar manual & relay scroll
- **File:** `src/mirror/bin/dome-client.html`
- **Perubahan:**
  - Blok khusus `tsix-dgrid` yang mengatur `hdr.style.width = calc(100% - scrollbarWidth)` **dihapus** — alignment lebar kini dikelola oleh satu scroll container di sisi app (lihat changelog Cashew).
  - Relay event `scroll` dari `body-scroll` ke worker **dihapus** — tidak diperlukan lagi karena header & body berada dalam satu container (scroll horizontal otomatis sinkron).
- **Dampak:** Tidak ada lagi kompensasi lebar scrollbar yang rapuh. Kode dome-client lebih sederhana.
- **Oleh:** Copilot

---

## 2026-08-02

### `<option selected>` — buildDOM menangani properti `selected`
- **File:** `src/mirror/bin/dome-client.html` — `buildDOM()`
- **Masalah:** Properti `selected` pada node `<option>` tidak di-handle di loop props `buildDOM` — jatuh tanpa cabang, diam-diam diabaikan. Akibatnya `<select>` selalu menampilkan option pertama (mis. "(semua)") meskipun `selectedIndex` sudah diset. (`value` pada `<input>` sudah di-handle → input text normal, hanya combobox yang salah.)
- **Perubahan:** Tambah cabang `else if (key === "selected") { el.selected = !!value; }` sebelum penanganan `value`.
- **Dampak:** Semua `TComboBox` Cashew dengan `selectedIndex != 0` kini menampilkan pilihan yang benar saat mount (dialog filter Bitshark, dll). Fix level framework — berlaku untuk semua aplikasi.
- **Oleh:** Copilot

---

## 2026-07-31

### TERM_FOCUS relay — auto-focus xterm
- **File:** `src/mirror/bin/dome.ts`, `src/mirror/bin/dome-client.html`
- **Perubahan:**
  - `dome.ts`: Tambah relay `TERM_FOCUS` ke whitelist `ipc_message` → browser (sebelumnya tidak ada di whitelist, jadi auto-focus PixelTerm tidak pernah sampai ke browser).
  - `dome-client.html`: `handleTermFocus` → `el._xterm.focus()`; fallback `_pendingFocus` dipakai di `initXterm` jika pesan datang sebelum xterm siap.
- **Dampak:** PixelTerm bisa fokus terminal secara programatik (langsung ngetik tanpa klik).
- **Oleh:** Copilot

### Native column resize (data-col-resize)
- **File:** `src/mirror/bin/dome-client.html`
- **Perubahan:** Elemen bertanda `data-col-resize="1"` (handle di header th) → drag native di browser (mousedown/mousemove/mouseup) menyesuaikan lebar `<col>` di colgroup, min 60px. Klik pada handle di-stop-propagation biar tidak trigger sort th.
- **Dampak:** Kolom DataGrid bisa di-resize langsung di browser tanpa event relay ke app.
- **Oleh:** Copilot

---

## 2026-07-30

### Lightweight Charts (TradingView) — Real-time IoT Chart
- **File:** `src/mirror/bin/dome-client.html`, `src/mirror/lib/cashew.ts`, `src/mirror/bin/dome.ts`, `src/mirror/bin/cashew-demo3.ts`
- **Latar Belakang:** Awalnya pakai custom SVG line chart (TLineChart) yang bermasalah dengan scroll/flicker. Migrasi ke uPlot gagal karena CDN versioning error dan CSS `min-content` collapse (root div 0x0).
- **Keputusan:** Beralih ke **Lightweight Charts v5.2.0** (TradingView) — library mature, zero CSS dependency, API simple.
- **Perubahan:**

#### `dome-client.html`
- Tambah CDN `lightweight-charts@5.2.0` (standalone production build, di `<head>`)
- Hapus semua kode uPlot (CDN CSS/JS, CSS override, handler)
- Handler baru:
  - `handleChartInit` — create chart via `LightweightCharts.createChart()`, add `LineSeries`, init dari opts
  - `handleChartData` — konversi `[xData, yData]` ke `[{time, value}]`, panggil `series.setData()`
  - `handleChartDestroy` — cleanup chart + resize handler
- **Warna otomatis mengikuti tema aktif** — baca CSS variables `--bg`, `--text`, `--border` dari theme
- **Resize handler** — daftarkan `doResize` ke global `window._tsixChartResizeHandler`, dipanggil via `window.resize`, update width chart via `requestAnimationFrame` + `getBoundingClientRect`
- **Retry mechanism** — 30× retry (200ms) jika element `data-tsix-id` belum di-mount

#### `cashew.ts` — TChart component
- Class baru `TChart extends TComponent`:
  - `tag = "div"`, style `width:100%; height:<props.height>px; minHeight:60px`
  - `bindEventHandler` — set `_wid` dari screen, `_lib` dari `global._tsixLib`
  - `initChart()` — cari DOME PID via `shell.ps()`, kirim CHART_INIT
  - `setData(xData, yData)` — kirim CHART_DATA dengan `[xData, yData]`
  - `buildOpts()` — return `{ width, height, color, label, minValue, maxValue }`
- Semua komunikasi via IPC (`SEND_MSG` syscall → Kernel → DOME worker → WebSocket → browser)

#### `dome.ts`
- Tambah `std.log` di relay CHART_INIT/CHART_DATA/CHART_DESTROY (debugging)

#### `cashew-demo3.ts`
- Demo IoT dashboard pake `TChart("temp-chart")` dengan data real-time dari `TTimer`
- Data diakumulasi (max 60 titik), dikirim full array tiap tick

- **Resolved Issues:**
  - 🐛 uPlot CDN 404 — versi 1.6.30 tidak ada (fix: 1.6.32 + file `.iife.min.js`)
  - 🐛 uPlot CSS `min-content` — root div collapse ke 0x0 (solusi: ganti library)
  - 🐛 structured clone — fungsi di `buildOpts` tidak bisa di-serialize via `worker.postMessage` (solusi: hapus functions dari opts)
  - 🐛 circular dependency height — container `height:100%` vs chart content (solusi: height tetap dari props, width auto via resize handler)

- **Dampak:** Chart real-time bekerja dengan Lightweight Charts, responsive width, tema otomatis, tanpa external CSS.
- **Oleh:** Copilot

---

## 2026-07-27

*(initial)*
