# Changelog Dokumentasi TSIX

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-08-10

### README ditulis ulang (English, no-emoji, nada jujur)
- **File:** `README.md`
- **Perubahan:** Konten diubah ke English, emoji dihapus, bagian install di-update mengikuti model `npm run install`, nada diturunkan (proyek edukasi/eksperimental; "Working" bukan "Stable").
- **Dampak:** Dokumentasi utama konsisten & tidak overpromise.
- **Oleh:** Copilot

### Restrukturisasi dokumentasi: `wiki/course/` resmi, `wiki/*` personal
- **File:** `wiki/README.md`, `wiki/course/README.md`
- **Perubahan:** `wiki/course/` ditetapkan sebagai dokumentasi resmi (index, ToC, format); file longgar di `wiki/` ditandai sebagai catatan kerja penulis + AI.
- **Oleh:** Copilot

### Course selesai: 25 modul (00–24)
- **File:** `wiki/course/*.md`, `wiki/course/toc.md`
- **Perubahan:** Semua modul partial/draft diselesaikan ke `status: done` — snippet diverifikasi dari kode, diagram ASCII, tabel, latihan; status di ToC & index disinkronkan.
- **Oleh:** Copilot

### Dokumentasi TDE disinkronkan dengan kode
- **File:** `wiki/course/18-dome-engine.md`, `19-emerald-widget-toolkit.md`, `20-cashew-component-framework.md`, `21-asteracea-tde.md`, `22-state-replay-persistence.md`
- **Perubahan:** Update mengikuti bugfix/feature TDE terbaru: `maximizable`, DDC, per-app traffic accounting, navigation protection, `/var/run/dome.ready`, daemonize Asteracea, icon/tooltip foreign app, `GUI_WINDOW_MAXIMIZED/UNMAXIMIZED`, `ensureListener`, DataGrid satu scroll container, dst.
- **Oleh:** Copilot

### Rename file course ke kebab-case English
- **File:** `wiki/course/*` (00-overview, 01-philosophy-big-picture, 02-ring-model-privilege, 04-processes-scheduler, `format.md`, `toc.md`)
- **Perubahan:** Penamaan file konsisten lowercase kebab-case English; semua referensi internal diperbarui (termasuk `course-server.ts`).
- **Oleh:** Copilot

### Terjemahan Inggris (`*.en.md`)
- **File:** `wiki/course/*.en.md` (25 modul) + `wiki/course/toc.en.md`
- **Perubahan:** Seluruh course diterjemahkan ke English (frontmatter `lang: en`, `partTitle` Inggris, kode verbatim, link ke sibling `.en.md`).
- **Dampak:** Tersedia `?lang=en` di course server (fallback ke ID).
- **Oleh:** Copilot

### Fix sidebar duplikat di course server
- **File:** `wiki/course/course-server.ts`
- **Masalah:** Sidebar menampilkan modul `.md` dan `.en.md` sekaligus (double entry).
- **Perubahan:** `scanModules(lang)` dedupe per nomor modul sesuai bahasa aktif; link roadmap & redirect ikut bahasa.
- **Dampak:** Sidebar bersih sesuai bahasa terpilih.
- **Oleh:** Copilot

### Build PDF course (English edition)
- **File:** `scripts/build-course-pdf.mjs`, `docs/TSIX-Course-EN.pdf`
- **Perubahan:** Script menggabungkan 25 modul `.en.md` → HTML (`marked`) → PDF (headless Chrome). Output 146 halaman (cover + daftar isi + modul).
- **Oleh:** Copilot
