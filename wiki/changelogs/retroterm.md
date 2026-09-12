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

### 🐞 FIX PENTING: terminal tidak bisa menerima input keyboard

- **File:** `src/mirror/opt/dome/dome-client-term.js`
- **Gejala (dilaporkan kakang):** setelah alignment benar, xterm **tidak bisa diklik/diketik** sama sekali.
- **Akar masalah:** elemen `stage` (pembungkus yang saya tambahkan saat rework centering) diset `pointer-events: none` supaya bezel tidak menghalangi klik. Tapi `stage` adalah **PARENT** dari layer layar dan `.xterm`, dan `pointer-events` **diwariskan** ke anak — jadi seluruh terminal menjadi click-through dan tidak pernah bisa menerima fokus maupun tombol. Ini **regresi** dari perbaikan centering.
- **Perbaikan:** `pointer-events: none` dipindah dari `stage` ke **gambar bezel saja** (elemen yang memang perlu click-through):
  | Elemen | pointer-events | Alasan |
  |---|---|---|
  | `stage` | auto (default) | parent — kalau `none`, anak ikut mati |
  | `bezel` (gambar) | `none` | hanya background, tidak boleh menghalangi |
  | `screen` (layar) | auto | harus bisa diklik |
  | `fx` (scanline/vignette) | `none` | overlay tidak boleh memblokir klik |
- **Verifikasi:** (1) mengukur `computed style` keempat elemen, (2) **mengetik sungguhan** di 3 ukuran window (default, lebar setelah resize, portrait setelah resize) — semua ketikan diterima dan `xterm-helper-textarea` tetap fokus.
- **Catatan proses:** percobaan uji pertama sempat melaporkan "input tidak diterima" — itu **bug di harness uji** (halaman uji belum memasang `term.onData`, yang di bundle asli sudah ada), bukan bug aplikasi. Harness diperbaiki lalu uji diulang.
- **Oleh:** Copilot · **Laporan:** kakang

### Layar tetap persis di tengah saat window di-resize

- **File:** `src/mirror/opt/retroterm/retroterm.ts`, `src/mirror/opt/dome/dome-client-term.js`
- **Permintaan:** saat window di-resize, area layar konsol harus tetap persis di tengah.
- **Masalah sebelumnya:** geometri layar memakai inset **persen window** (`top:15% right:23% bottom:24% left:15%`). Karena itu tidak mengikuti bentuk gambar, layar bergeser dan tidak center saat ukuran berubah. Inset lama juga **salah ukur**: kanan 23% padahal lubang gambar berakhir di 88% → layar tergeser ±11%.
- **Perbaikan:**
  1. **Geometri diukur dari gambar**, bukan ditebak: scanline kecerahan mencari area gelap (tabung) → lubang layar = **kiri 13%, kanan 88%, atas 12%, bawah 78%** (fraksi). Nilai ini dikirim app sebagai `bezel.hole`.
  2. **Bezel digambar aspect-preserving** (`background-size` dihitung, bukan `100% 100%`), jadi casing tidak gepeng di ukuran apa pun.
  3. **Layar diposisikan relatif ke gambar** secara proporsional, lalu **pusat lubang dijadikan pusat window** — itulah yang membuatnya tetap center saat resize. Layout dihitung ulang lewat `ResizeObserver`.
  4. **Skala dibatasi 4 syarat** (ambil terkecil): lubang muat di window **dan** gambar penuh tetap muat walau sudah digeser untuk centering. Tanpa batas ke-2 & ke-3, pada window portrait (mis. 700x1000) gambar menjadi lebih besar dari window sehingga casing kiri/kanan terpotong ±83px — sudah terukur dan diperbaiki.
  5. **Dimensi gambar dibaca dari header JPEG (SOF marker)**, bukan di-hardcode — jadi tetap benar bila `retro-crt.jpg` diganti.
- **Verifikasi (diukur, 10 ukuran window termasuk ekstrem 300x200 & 1400x400):**
  - `offX = 0.00`, `offY = 0.00` → layar **persis center** di semua ukuran
  - `casingMuatt = true` → gambar penuh selalu berada di dalam window
  - sisa ruang **simetris** (kiri == kanan, atas == bawah)
  - hit-test di tengah layar tetap mengembalikan elemen teks terminal
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
