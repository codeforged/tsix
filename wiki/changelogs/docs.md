# Changelog Dokumentasi TSIX

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-09-15

### Dokumentasi bus SPI portabel (Pi ↔ Orange Pi)
- **File:** `wiki/lcd-lm6029.md`, `wiki/changelogs/lcd.md`
- **Perubahan:** §2.1 menjelaskan nomor bus SPI berbeda antar-SBC (Pi `/dev/spidev0.0`, Orange Pi `/dev/spidev3.0`) dan bahwa addon mengauto-deteksi `/dev/spidev*` (dengan override `LM6029_SPI_DEV` / opsi `spiDevice`); §8 Troubleshooting menambahkan kasus "pindah board: layar kosong padahal `begin()` sukses"; tabel CLI mencatat `test-LM6029 info` menampilkan bus terpakai.
- **Dampak:** Prosedur pindah board Pi ↔ Orange Pi tidak lagi menuntut edit `#define`/hardcode path di source addon.
- **Oleh:** Copilot

### Klarifikasi semantik framebuffer pada dokumentasi LCD
- **File:** `wiki/lcd-lm6029.md`, `wiki/changelogs/lcd.md`
- **Perubahan:** §4 (Framebuffer 1 bpp) menjelaskan bahwa `blit()` **mengganti** isi layar (driver membersihkan buffer panel dulu) sehingga `fb.clear()` + `blit()` = layar bersih, dan bahwa present mengikuti `setAutoFlush()` (butuh `flush()` manual bila OFF). §5 tabel mode `write()` dan §8 Troubleshooting ditambahkan: buffer 1024 byte = ganti frame, sedangkan `drawBitmap` ioctl tetap bersifat "cap", plus dua penyebab umum frame framebuffer tidak muncul.
- **Dampak:** Dokumen tidak lagi menyiratkan `blit()` bersifat auto-flush tanpa syarat; perilaku frame kosong dan hantu piksel kini terdokumentasi.
- **Oleh:** Copilot

## 2026-09-14

### Dokumentasi LCD LM6029ACW + changelog subsistem LCD
- **File:** `wiki/lcd-lm6029.md` (baru), `wiki/changelogs/lcd.md` (baru), `wiki/Home.md`
- **Perubahan:** Halaman wiki baru untuk rantai `/dev/lcd` → `@tsix/lcdLib` → addon npm `lm6029acw` — berisi diagram lapisan, urutan resolusi addon, tabel API lengkap, layout bit framebuffer 1 bpp, tabel namespace ioctl `0x4C`, CLI `test-LM6029`, dan troubleshooting. Changelog subsistem baru `changelogs/lcd.md`; keduanya didaftarkan di `Home.md` (tabel **Devices** + **Complete Wiki**).
- **Dampak:** Device LCD kini punya dokumentasi mandiri setara MCP23017; pola 3 lapisan (driver HAL → library userland → addon npm) tercatat sebagai rujukan untuk device berikutnya.
- **Oleh:** Copilot

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
