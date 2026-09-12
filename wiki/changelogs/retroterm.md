# Changelog RetroTerm

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-09-12

### 🐞 FIX PENTING: teks "tenggelam" ke dasar window setelah resize

- **File:** `src/mirror/opt/dome/dome-client-term.js`
- **Gejala (dilaporkan kakang):** setelah ganti font, saat window di-resize tulisan console **tenggelam ke dasar window**.
- **Akar masalah — DUA sebab, keduanya dari perubahan font sebelumnya:**
  1. **Ukuran sel diestimasi, bukan diukur.** `fit()` memakai `_cellW = fontSize * 0.6`, padahal lebar sel sebenarnya tergantung font (terukur **8.82px** untuk fontSize 16, bukan 9.6). Akibatnya `cols`/`rows` dihitung **lebih banyak dari yang muat** → xterm.js auto-scroll ke bawah → teks tampak tenggelam. Terukur: estimasi memberi `cols 104`, sedangkan ruang nyata muat `109–113`.
  2. **Font bitmap dimuat ASINKRON.** Font dari data URI harus di-decode dulu; saat `term.open()` ukuran sel masih memakai font fallback, lalu berubah setelah font siap — **tapi `cols`/`rows` tidak pernah dihitung ulang**. Terbukti di log: `fit()` pertama memberi `rows 46`, setelah font siap menjadi `rows 36` (46 baris tidak muat di window).
- **Perbaikan:**
  - Tambah **`measureCell(term, el, fontSize)`** — mengukur ukuran sel **sebenarnya** dengan 3 tingkat fallback: (a) `term._core._renderService.dimensions.css.cell`, (b) elemen `.xterm-char-measure-element` yang dibuat xterm (berisi 32 karakter), (c) estimasi terakhir. `fit()` kini memakai hasil pengukuran ini.
  - **Re-fit setelah font siap:** `document.fonts.ready` + polling `document.fonts.check()` (maks 10× @120ms) sebagai jaring kedua untuk browser yang tidak memicu `ready` pada font yang baru disuntik.
- **Verifikasi (diukur di browser):** `scrollTop = 0` (tidak ada scroll), `scrollHeight == clientHeight` (684 = 684), `jarakAtasKeBaris = 0`, dan log `fit()` menunjukkan re-fit benar-benar terjadi (cols 109 → 113, rows 46 → 36).
- **Dampak:** teks kembali menempel dari atas dan resize mengubah COLUMNS/LINES dengan benar.
- **Oleh:** Copilot · **Laporan:** kakang

### Dukungan font bitmap (opt-in) — mis. Tandy 1000 / Web437

- **File:** `src/mirror/opt/retroterm/retroterm.ts`, `src/mirror/opt/dome/dome-client-term.js`
- **Permintaan:** ganti font console dengan font bitmap era 80-an (mis. `Web437Tandy1K-II225L-2y`).
- **Cara pakai:** taruh file font di **`/opt/retroterm/fonts/`** — tidak perlu ubah kode. App mem-probe daftar `FONT_FILES` dan memakai yang **pertama ketemu**. Kalau tidak ada, otomatis fallback ke font monospace sistem (tidak error).
  - Kandidat nama yang dicoba: `Web437_Tandy1K-II_225L.woff2`, `…_225L-2y.woff2`, `Web437Tandy1K-II225L-2y.woff2`, `tandy.woff2`, dst (varian `.woff2/.woff/.ttf/.otf`).
  - Ukuran font default **16px** (`FONT_SIZE`) — bitmap Tandy ~8x16, jadi 16px = kelipatan pas.
- **Implementasi:**
  - App membaca font dari VFS sebagai **`latin1`** lalu base64 → data URI, disuntik ke `<head>` sebagai `@font-face` oleh `installCrtFont()`. Dilakukan **sekali per family** (tidak menumpuk style saat tema di-reload).
  - Font dipasang **sebelum** objek `Terminal` dibuat, supaya glyph pertama sudah benar (menghindari reflow 1 frame).
  - `fontWeight` diset `normal` saat font kustom dipakai — bitmap tidak punya bold asli, dan sintesis bold membuat glyph buram.
  - `fit()` kini menurunkan ukuran sel dari `fontSize` (`_cellW = fontSize*0.6`, `_cellH = fontSize`) — sebelumnya hardcode `8.4`/`16`, yang membuat COLUMNS/LINES salah saat font lebih besar.
  - `.xterm-viewport` dibuat transparan **hanya saat CRT aktif**, supaya efek tabung terlihat di belakang teks; PixelTerm tetap memakai warna temanya.
- **⚠️ Kenapa `latin1` WAJIB:** font itu **biner**, sedangkan `fs.readFile` mengembalikan string per-karakter. Diuji dengan `arial.ttf` (1.045.720 byte): jalur `latin1` round-trip **identik**, sedangkan jalur `utf8` **merusak 306.957 byte (29%)** — font akan gagal dimuat. Pola ini sama dengan `resbank.ts`/TImage.
- **Verifikasi (diukur di browser):** `@font-face` terpasang, `document.fonts.check("16px 'TSIXRetroMono'")` = **true**, lebar teks **berbeda** dari monospace generik (142.27 vs 87.97 px untuk 10× "M") → font benar-benar terpakai, bukan fallback. `fontFamily` computed di baris xterm = `TSIXRetroMono, monospace`. Input keyboard tetap jalan (`echo font-ok` diterima).
- **Catatan:** `retro-crt.jpg` sekarang tidak dipakai lagi oleh app (frame dilepas) — file dibiarkan di tempatnya, tidak masalah.
- **Deploy:** `npm run vfs:bootstrap` untuk sisi app; **file font cukup ditaruh** di `src/mirror/opt/retroterm/fonts/` lalu jalankan bootstrap.
- **Prasyarat yang ikut diperbaiki:** `scripts/vfs-bootstrap.ts` & `scripts/install.ts` **sebelumnya tidak mengenal** ekstensi `.woff2/.woff/.ttf/.otf/.eot` — file font akan **dilewati diam-diam** (tidak pernah sampai VFS). Keduanya kini memasukkan ekstensi font sebagai **biner latin1**. Diuji: `arial.ttf` (1.045.720 byte) → ter-sync ke `/opt/retroterm/fonts/`, `Buffer.compare` **identik**, TTF magic `0x00010000` benar.
- **Oleh:** Copilot · **Laporan:** kakang

### Frame monitor dilepas + efek cembung khas CRT

- **File:** `src/mirror/opt/retroterm/retroterm.ts`, `src/mirror/opt/dome/dome-client-term.js`
- **Permintaan:** (1) buang frame gambar monitor — jelek; (2) console mengisi form penuh sehingga resize mengubah COLUMNS/LINES seperti PixelTerm; (3) warna & efek console jangan diubah; (4) tambah efek cembung khas layar CRT.
- **Perubahan:**
  - **Frame gambar dibuang total.** `applyCrtFx()` tidak lagi menerima `bezel`, tidak membuat `<img>`/layer layar/`clip-path`, dan tidak punya perhitungan geometri. Pembacaan `retro-crt.jpg` + pembaca dimensi JPEG (SOF) dihapus dari app. Container kembali `padding:0; height:100%` seperti PixelTerm.
  - **`fit()` kembali mengukur node xterm langsung** (bukan layer layar perantara), jadi resize window langsung mengubah COLUMNS/LINES ke shell.
  - **Efek cembung (baru)** — ilusi tabung CRT:
    1. **`box-shadow` inset ganda** di container: `inset 0 0 44px 12px` (tepi pekat) + `inset 0 0 120px 30px` (sebaran lebar) → kesan kaca melengkung ke dalam.
    2. **Specular highlight** `radial-gradient(ellipse 130% 100% at 28% 8%, rgba(190,255,210,0.075))` → kilau kaca kiri-atas.
    3. **Pantulan kedua** di kanan-bawah (alpha 0.035) → menegaskan kelengkungan.
    4. Plus `border-radius: 18px` (sudut tabung).
  - Parameter bisa diatur dari app: `crt.convex = { radius, edge, highlight }`.
- **⚠️ Catatan kejujuran teknis:** ini **ilusi visual** (cahaya + bayangan), **bukan distorsi geometris**. Distorsi barrel sejati butuh post-processing GPU (WebGL) atau SVG `feDisplacementMap` yang harus dihitung ulang **tiap frame** pada canvas terminal → berat dan berisiko membuat input terasa lag. Pendekatan ini **nol biaya per-frame**.
- **Efek yang TIDAK diubah** (sesuai permintaan): palet fosfor hijau, tint `rgba(0,255,120,0.045)`, scanlines (period 3, alpha 0.3), vignette 0.5, flicker halus.
- **Verifikasi (diukur di browser):** `jmlImg = 0` (frame benar-benar hilang), `boxShadow` inset ganda terpasang, 4 layer gradient terkonfirmasi (2 radial kilau/pantulan, radial vignette, repeating-linear scanline), `borderRadius: 18px`, dan **input keyboard tetap jalan** (`nano test.txt` diterima) — regresi `pointer-events` tidak terulang.
- **Dampak:** kode lebih sederhana — **−154 baris net** (logika bezel + geometri + pembaca JPEG dibuang).
- **Deploy:** `npm run vfs:bootstrap`.
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

### RetroTerm — terminal emulator CRT / fosfor hijau (baru)

> ⚠️ **Catatan revisi:** entri ini adalah versi AWAL. Bagian **frame/bezel gambar**
> yang disebut di bawah sudah **DIHAPUS** di revisi berikutnya (lihat "Frame monitor
> dilepas + efek cembung"), begitu pula pembaca dimensi JPEG. Yang tersisa dari
> entri ini dan masih berlaku: efek CRT dasar, palet fosfor, menu launcher, dan
> fondasi PixelTerm (PTY dinamis, `freePty()` idempotent, spawn `tsh.js`).

- **File:** `src/mirror/opt/retroterm/retroterm.ts`, `src/mirror/opt/asteracea/menu/retroterm.menu`, `src/mirror/etc/profile`
- **Apa ini:** saudara dari PixelTerm — fungsinya sama (terminal emulator penuh di atas PTY dinamis), tapi tampilannya meniru monitor CRT jadul:
  - ~~**bezel/frame** dari `/opt/retroterm/retro-crt.jpg`~~ → **DIHAPUS** (jelek saat diuji)
  - **scanlines** horizontal (period 3px, alpha 0.3)
  - **vignette** — tepi tabung menggelap (alpha 0.5)
  - **tint fosfor hijau** tipis (`rgba(0,255,120,0.045)`)
  - **flicker** sangat halus (opacity 0.978↔1, 120ms) — bukan strobo
  - **efek cembung** (ditambahkan di revisi berikutnya)
- **Cara kerja:** efek dikerjakan **di sisi browser** oleh `applyCrtFx()` di `dome-client-term.js` — app hanya mengirim deskripsi efek lewat prop `crtTheme` pada node `xterm`. Jadi nol biaya render di worker.
- **Palet:** dipaksa fosfor hijau dan **tidak** ikut tema sistem (sengaja) supaya nuansa CRT konsisten. Warna ANSI di-map ke gradasi hijau, jadi `ls` berwarna tetap terbaca tanpa keluar dari nuansa monokrom-hijau.
- **Menu:** ditambahkan ke launcher Asteracea (`retroterm.menu`, pinned) dan `/opt/retroterm` masuk `PATH` di `/etc/profile`.
- **Dibangun dari PixelTerm** dengan semua perbaikan yang sudah ada: PTY dinamis, `freePty()` idempotent di **semua** jalur tutup (termasuk klik X), dan spawn shell ke sidecar `/bin/tsh.js` (bukan `.ts`) agar worker tidak memakai preload transpiler.
- **Deploy:** `npm run vfs:bootstrap` (wajib — app + aset baru).
- **Oleh:** Copilot · **Laporan:** kakang
