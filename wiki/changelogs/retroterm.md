# Changelog RetroTerm

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-09-12

### RetroTerm — terminal emulator CRT / fosfor hijau (baru)

- **File:** `src/mirror/opt/retroterm/retroterm.ts`, `src/mirror/opt/asteracea/menu/retroterm.menu`, `src/mirror/etc/profile`
- **Apa ini:** saudara dari PixelTerm — fungsinya sama (terminal emulator penuh di atas PTY dinamis), tapi tampilannya meniru monitor CRT jadul:
  - **bezel/frame** dari `/opt/retroterm/retro-crt.jpg`
  - **scanlines** horizontal (period 3px, alpha 0.3)
  - **vignette** — tepi tabung menggelap (alpha 0.5)
  - **tint fosfor hijau** tipis (`rgba(0,255,120,0.045)`)
  - **flicker** sangat halus (opacity 0.978↔1, 120ms) — bukan strobo
- **Cara kerja:** efek dikerjakan **di sisi browser** oleh `applyCrtFx()` di `dome-client-term.js` — app hanya mengirim deskripsi efek lewat prop `crtTheme` pada node `xterm`. Jadi nol biaya render di worker.
- **Palet:** dipaksa fosfor hijau dan **tidak** ikut tema sistem (sengaja) supaya nuansa CRT konsisten. Warna ANSI di-map ke gradasi hijau, jadi `ls` berwarna tetap terbaca tanpa keluar dari nuansa monokrom-hijau.
- **Bezel:** dibaca dari VFS sebagai `latin1` → base64 → data URI (pola sama seperti `resbank.ts`/TImage). Kalau file hilang, app tetap jalan tanpa bezel (non-fatal, hanya dicatat di log).
- **Menu:** ditambahkan ke launcher Asteracea (`retroterm.menu`, pinned) dan `/opt/retroterm` masuk `PATH` di `/etc/profile`.
- **Dibangun dari PixelTerm** dengan semua perbaikan yang sudah ada: PTY dinamis, `freePty()` idempotent di **semua** jalur tutup (termasuk klik X), dan spawn shell ke sidecar `/bin/tsh.js` (bukan `.ts`) agar worker tidak memakai preload transpiler.
- **Deploy:** `npm run vfs:bootstrap` (wajib — app + aset baru).
- **Oleh:** Copilot · **Laporan:** kakang

### 🐞 FIX PENTING: gambar monitor menutupi teks terminal

- **File:** `src/mirror/opt/dome/dome-client-term.js`
- **Gejala (dilaporkan kakang):** RetroTerm hanya menampilkan gambar monitor — teks konsol tidak terlihat sama sekali.
- **Akar masalah:** gambar bezel dipasang sebagai `<img>` dengan `clip-path: polygon(...)` yang dimaksudkan sebagai "bingkai berlubang". **`clip-path: polygon()` tidak mendukung lubang** (butuh subpath dengan arah berlawanan, yang tidak didukung browser). Poligon naif itu menutup lewat garis diagonal yang **melintasi area layar**, sehingga titik tengah layar berada **di dalam** poligon → gambar ikut mengisi area layar dan menutupi teks. Terbukti dengan ray-casting: 3 perpotongan (ganjil) dari titik tengah layar.
- **Perbaikan — ganti pendekatan total:**
  - Gambar bezel kini dipasang sebagai **`background-image` pada container**, bukan elemen yang menutupi.
  - Layar menjadi **kotak opak** (`z-index: 1`) di atasnya → apa pun bentuk casing di gambar, teks tidak mungkin tertutup.
  - Overlay efek (scanline/vignette/tint) tetap `z-index: 2` → di atas teks.
  - Elemen `<img>` bertopeng **dihapus sepenuhnya**; properti `holeTop/holeBottom/holeLeft/holeRight` tidak dipakai lagi.
- **Verifikasi (hit-test DOM, 4 titik di area layar):** seluruh titik mengembalikan elemen **teks terminal** (`xterm-rows` / `xterm-screen` / `terminal`), bukan `<img>`. Ini pengukuran, bukan pembacaan kode.
- **Dampak:** teks terminal kini terlihat di atas bezel, dengan scanline + vignette tetap bekerja.
- **Oleh:** Copilot · **Laporan:** kakang

### Catatan teknis: dua bug yang ditemukan & diperbaiki saat pembuatan

Keduanya ditemukan dengan mengukur di browser, bukan dari membaca kode:

1. **Teks meluber keluar area layar (±42px).** Setelah `.xterm` dipindah ke dalam layer layar yang lebih kecil, `fit()` masih mengukur node **luar** — jadi grid terminal dihitung untuk ukuran window, bukan ukuran layar. Akibatnya teks menembus bezel dan COLUMNS/LINES yang dikirim ke shell juga salah.
   - Diperbaiki: `fit()` dan `ResizeObserver` kini mengukur `._tsix_crt_screen` bila ada, dan `.xterm` dipaksa `width/height: 100%` + `overflow: hidden`.
   - Verifikasi terukur: tinggi `.xterm` **384px → 342px** (tepat sama dengan layer layar), teks terkonfirmasi di dalam area layar.
2. **Urutan pemasangan salah.** `fit()` dipanggil **sebelum** `applyCrtFx()`, padahal layer layar baru ada setelah `applyCrtFx()`. Kini `applyCrtFx()` dijalankan lebih dulu, baru `fit()`.
- **Oleh:** Copilot
