# Changelog Image Viewer

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-08-29

### Ikon folder rusak (mojibake) — emoji tersimpan dengan encoding salah
- **File:** `src/mirror/opt/image-viewer/image-viewer.ts`
- **Masalah:** Ikon folder tertutup tampil sebagai `�` (replacement char) di explorer, sementara Eucalyptus & File-Cruiser baik-baik saja. Source `image-viewer.ts` di repo tersimpan dalam kondisi **mojibake** (emoji `📂`/`📁`/`🖼️`/`📄` rusak menjadi `≡ƒôé`, `∩┐╜`, `≡ƒû╝∩╕Å`), sehingga saat di-transpile & dirender browser menjadi `�`.
- **Perubahan:** Ganti semua emoji mojibake dengan UTF-8 yang benar (`📂` expanded, `📁` tertutup, `🖼️` file gambar, `📄` file lain).
- **Dampak:** Ikon folder/file tampil benar. Deploy: sync `image-viewer.ts` → relaunch app.
- **Oleh:** Copilot

### Heading explorer statis "📂 Files" → direktori aktif
- **File:** `src/mirror/opt/image-viewer/image-viewer.ts`
- **Perubahan:** Heading panel kiri kini menampilkan `📂 <startDir>` (direktori aktif), bukan label statis "📂 Files".
- **Oleh:** Copilot

### Navigasi keyboard hanya muter di direktori root — tidak bisa jangkau file di subdirektori
- **File:** `src/mirror/opt/image-viewer/image-viewer.ts`
- **Masalah:** Saat dibuka **independen** (dari launcher, tanpa argumen file), `startDir = /` yang isinya hanya direktori → `navList` lama hanya berisi entry level-1 → ArrowUp/Down hanya memutar di direktori root dan **tidak pernah menjangkau file** di dalam subdirektori yang di-expand. (Bekerja jika dibuka dari file-cruiser karena ada argumen file → startDir langsung folder berisi file.)
- **Perubahan:**
  - `selected` diubah dari `name` → `fp` (full path) agar unik di semua level tree.
  - `buildNavList()` kini **rekursif** — menelusuri tree terlihat (flattened), termasuk **file di subdirektori yang di-expand** (`expandedDirs`). Navigasi mengikuti apa yang benar-benar tampil di explorer.
  - Klik entry menyinkronkan `selected = fp` + rebuild `navList` (bukan cuma level-1).
  - Tambah dukungan **Enter** (`activateSelected`) untuk expand/tutup folder, atau buka file.
- **Dampak:** Dari `/`, user bisa ArrowDown/Up menelusuri semua direktori, Enter untuk expand, lalu lanjut navigasi sampai ke file gambar dan membukanya. Deploy: sync `image-viewer.ts` → relaunch app.
- **Oleh:** Copilot · **Laporan/reproduksi:** kakang
