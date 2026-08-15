# Changelog File Cruiser

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-08-15

### Navigasi Back / Forward — riwayat folder di toolbar
- **File:** `src/mirror/opt/file-cruiser/file-cruiser.ts`
- **Perubahan:**
  - Toolbar: tambah tombol `⬅ Back` & `➡ Forward` sebelum `🏠 Home` (auto-disable saat stack kosong).
  - Riwayat navigasi dua stack (`historyBack` / `historyForward`) + helper `navigateTo()`, `goBack()`, `goForward()`.
  - Semua jalur ganti direktori kini lewat `navigateTo()`: `enterDir`, `goUp`, `goHome`, tombol Go (`navigateToPath`), klik tree, klik root tree → otomatis tercatat di riwayat (dedupe path berurutan, forward di-reset saat navigasi baru).
  - `refreshSelection()` update state disabled tombol Back/Forward.
- **Dampak:** Penjelajahan folder lebih natural; user bisa kembali/maju ke folder yang pernah dikunjungi.
- **Oleh:** Copilot · **Permintaan:** kakang

---

## 2026-07-28

### Info panel — custom modal dua kolom
- **File:** `src/mirror/bin/file-cruiser.ts` — `infoSel()`
- **Perubahan:** Ganti `app.alert()` dengan custom modal Emerald. Info ditampilkan dalam layout dua kolom (label:kiri bold 90px, value:kanan monospace). Ditambahkan Path, Size, Modified (DD Mon YYYY HH:mm), Owner+UID, Group+GID, Mode+octal, Type. Untuk direktori, Size diisi jumlah file (`3d/12f`).
- **Dampak:** Info file lebih rapi, navigasi lebih informatif.
- **Oleh:** Copilot

### Emerald alert — white-space pre-wrap
- **File:** `src/mirror/lib/emerald.ts` — `alert()`
- **Perubahan:** Tambah `whiteSpace: "pre-wrap"` biar `\n` di-render sebagai baris baru di alert.
- **Dampak:** Semua alert multi-line jadi rapi kebawah.
- **Oleh:** Copilot

### Kolom Modified Date — file panel
- **File:** `src/mirror/bin/file-cruiser.ts` — `refreshList()`, `fmtDate()`
- **Perubahan:** Tambah kolom "Modified" di file list. Format: `today HH:mm`, `yesterday HH:mm`, atau `DD Mon`. Fungsi `fmtDate()` baru.
- **Dampak:** User tahu kapan file terakhir diubah.
- **Oleh:** Copilot

### Size direktori — file panel menampilkan item count
- **File:** `src/mirror/bin/file-cruiser.ts` — `refreshList()`
- **Perubahan:** Sebelumnya direktori nunjukin `<DIR>`. Sekarang async `fs.ls()` untuk hitung jumlah isi (`3d/12f`). Fungsi `sz()` tetap dipakai sebagai fallback untuk regular file.
- **Dampak:** User langsung tau isi direktori tanpa perlu masuk.
- **Oleh:** Copilot

### Tree panel — klik "/" navigasi ke root
- **File:** `src/mirror/bin/file-cruiser.ts` — tree panel `h3` + handler
- **Perubahan:** Judul "📂 /" di tree panel dikasih `onClickId` + cursor pointer. Klik → `currentPath = "/"` → refresh list.
- **Dampak:** Navigasi ke root dari panel tree.
- **Oleh:** Copilot

### Baris ".." — alignment kolom konsisten
- **File:** `src/mirror/bin/file-cruiser.ts` — `refreshList()`
- **Perubahan:** Ditambahkan span kosong untuk kolom size dan date agar sejajar dengan baris file lainnya.
- **Dampak:** Tabel tetap rapi meski ada baris parent directory.
- **Oleh:** Copilot

---

## 2026-07-26

### Fix clipboard reset di tree panel
- **File:** `src/mirror/bin/file-cruiser.ts` — `refreshTree()`
- **Perubahan:** Hapus `clipboard = null` dari tree `onClick` handler.
- **Dampak:** Copy file → pindah direktori via tree → Paste tetap jalan. Sebelumnya clipboard ke-reset tiap navigasi tree.
- **Oleh:** Copilot

---
