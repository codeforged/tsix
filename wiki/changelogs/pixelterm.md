# Changelog PixelTerm

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-08-05

### Fix resize multi-instance — status bar atto ikut cursor di SEMUA pixelterm
- **File:** `src/mirror/opt/pixelterm/pixelterm.ts`, `src/mirror/bin/tsh.ts`, `src/mirror/bin/atto.ts`, `src/mirror/opt/dome/dome-client-term.js`
- **Masalah (iterasi panjang):** Di pixelterm ke-2+, status bar atto tidak mengikuti cursor (harus resize manual dulu di instance pertama). Akar masalah:
  - `getScreenInfo()` atto = ukuran device TTY yang dibuat kernel dengan ukuran **host terminal** (bukan ukuran window pixelterm) → status bar ter-draw di luar layar.
  - xterm.js hanya mengirim `term_resize` saat ukuran **berubah**; saat konstruksi terminal sudah dibuat pas ukuran fit → `term_resize` tidak pernah dikirim → pixelterm tidak pernah tahu ukuran asli.
- **Perubahan:**
  - `dome-client-term.js`: setelah konstruksi xterm, **selalu kirim `term_resize` awal** (bukan hanya saat ukuran berubah) → pixelterm selalu tahu ukuran asli.
  - `pixelterm.ts`: helper `applyTtySize(rows, cols)` → `fs.ioctl(ttyFd, 3, {lines, columns})` = **TIOCSWINSZ** — kernel resize device TTY per-instance, update env `LINES`/`COLUMNS` semua proses di TTY itu, & kirim SIGWINCH. Dipanggil setelah `initResize` (timeout 100→400ms) dan setiap `term_resize`.
  - `tsh.ts`: flag `foregroundPid` — redraw prompt di-skip saat ada foreground app (atto) berjalan (cegah SIGWINCH/IPC RESIZE menimpa layar atto).
  - `atto.ts`: `refreshScreenSize()` self-heal di `renderCursorOnly()` — redraw penuh jika ukuran berubah.
- **Dampak:** atto di pixelterm ke-1, ke-2, dst. langsung dapat ukuran benar — status `R:C` ikut cursor tanpa resize manual. Deploy: file client (`term.js`) butuh restart DOME + hard-refresh; file app cukup relaunch.
- **Oleh:** Copilot

### Tooltip row:col saat resize terminal
- **File:** `src/mirror/opt/dome/dome-client-term.js`
- **Perubahan:** Overlay kecil di pojok kanan-bawah xterm (`initResizeTooltip`) menampilkan `R:<rows>  C:<cols>` saat terminal di-resize, auto-hilang setelah 1,5 detik. `pointer-events:none` (tidak mengganggu klik); aman dibangun ulang saat recreate tema (guard `isConnected`).
- **Oleh:** Copilot

### Hapus resize grip sendiri milik xterm
- **File:** `src/mirror/opt/dome/dome-client-dom.js`
- **Perubahan:** Hapus `el.style.resize = "both"` pada node `xterm` di `buildDOM` — titik resize native di pojok kanan-bawah xterm dihilangkan; resize mengikuti window saja (via `ResizeObserver(fit)` di dome-client-term.js).
- **Oleh:** Copilot

---

## 2026-07-31

### Auto-focus terminal setelah launch
- **File:** `src/mirror/bin/pixelterm.ts`, `src/mirror/bin/dome-client.html`, `src/mirror/bin/dome.ts`
- **Perubahan:**
  - `pixelterm.ts`: Helper `termFocus()` mengirim pesan `TERM_FOCUS` ke DOME setelah shell spawn (+250ms delay biar xterm & window siap).
  - `dome.ts`: Relay `TERM_FOCUS` ke browser (tambah ke whitelist).
  - `dome-client.html`: `handleTermFocus` → `el._xterm.focus()`; fallback `_pendingFocus` di `initXterm`.
- **Dampak:** User langsung bisa mengetik di PixelTerm tanpa klik area terminal dulu.
- **Oleh:** Copilot

---

## 2026-07-30

### Selection color fix — transparent canvas background
- **File:** `src/mirror/bin/dome-client.html`
- **Perubahan:**
  - xterm.js canvas renderer ngisi background tiap sel text canvas → bikin opaque → nutup selection layer di belakangnya
  - Fix: set `background: "rgba(0,0,0,0)"` di theme terminal biar text canvas transparan
  - Background visual tetap dari CSS `.xterm-viewport`
  - Selection color dari `termTheme.selection` jadi kelihatan karna gak ketutup text canvas
- **Dampak:** Selection di PixelTerm tampil penuh (di bawah teks maupun spasi).
- **Oleh:** Copilot

---

## 2026-07-28

### Alokasi TTY diperluas ke range 7-32
- **File:** `src/mirror/bin/pixelterm.ts`
- **Perubahan:** Range alokasi TTY isolasi dari `7-12` jadi `7-32`, menyesuaikan kapasitas TTY Manager yang sekarang 32.
- **Dampak:** Lebih banyak slot TTY tersedia untuk multi-instance pixelterm.
- **Oleh:** andriansah

---

## 2026-07-27

### Migrasi dari pipe I/O ke isolated TTY
- **File:** `src/mirror/bin/pixelterm.ts`
- **Perubahan:** Hapus `shell.pipe()` dan pipe-based I/O. Ganti dengan alokasi TTY terisolasi (7-12) + `shell.read(pid)` / `shell.write(pid, data)` via TTY buffer.
- **Detail:**
  - Hapus 2x `shell.pipe()` dan passing pipe FD ke `shell.exec()`
  - Alokasi TTY scavenge dari range 7-12 (cek `shell.ps()` untuk TTY yang tidak terpakai)
  - Clear TTY buffer via `fs.ioctl(ttyFd, 1, null)` sebelum spawn shell
  - Spawn shell dengan `ttyId` → kernel otomatis bind stdin/stdout/stderr ke `/dev/ttyX`
  - Output: `shell.read(pid)` → baca dari TTY `outputBuffer` (ioctl 0x2002) → kirim ke xterm
  - Input: `shell.write(pid, data)` → inject ke TTY `inputBuffer` (ioctl 0x2001) → dibaca shell
  - Hapus cleanup `fs.close(shOutR)` / `fs.close(shInW)` karena tidak ada pipe
- **Dampak:** Pixelterm tidak lagi mengganggu TTY parent (TTY1). Shell berjalan di TTY terisolasi yang tidak tampil di host console.
- **Oleh:** Copilot
