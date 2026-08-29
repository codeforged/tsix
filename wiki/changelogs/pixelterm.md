# Changelog PixelTerm

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-08-29

### Fix: Ctrl+C mencetak "^C" dobel (ping/sleep) — pixelterm ikut menulis ^C
- **File:** `src/mirror/opt/pixelterm/pixelterm.ts`
- **Gejala:** Saat Ctrl+C pada program yang handle SIGINT (mis. `ping`, `sleep`), karakter `^C` tampil **2x** (baris kosong di antaranya).
- **Akar masalah:** Dua pihak mencetak `^C`: `pixelterm` menulis `termWrite("^C\r\n")` (echo manual ke xterm), DAN app mencetaknya sendiri di handler SIGINT (`ping.ts` → `"\n^C\n"`, `sleep.ts` → `"\n^C\nInterrupted!"`, `tsh.ts` → `"^C\n"`). Console TTY tidak pernah echo `\x03` — konvensi TSIX: **app yang mencetak `^C`**, bukan terminal.
- **Perubahan:** Hapus `await termWrite("^C\r\n")` di handler `term_input` Ctrl+C. Kini `^C` muncul sekali (dari handler app) dan konsisten dengan console TTY. Bonus: app TUI raw mode (mis. `atto`) tidak lagi dapat `^C` nyasar ke layar.
- **Oleh:** Copilot

---

## 2026-08-28

### Migrasi ke PTY on-demand — tidak lagi scavenge slot TTY konsol
- **File:** `src/mirror/opt/pixelterm/pixelterm.ts`, `src/kernel/PTYManager.ts`, `src/mirror/lib/UserLib.ts`
- **Masalah:** Pixelterm memakai slot TTY konsol (scan `ttyId` di range daemon) yang terbatas & pre-alokasi; tabrakan antar instance mungkin.
- **Perubahan:** Setiap instance `lib.pty.alloc(24,80)` → shell di-spawn di slave `pts/N` via `shell.exec(..., ptyId)`. Resize via `/dev/pts/N` (TIOCSWINSZ ioctl 3). PTY di-`free` saat shell exit.
- **Dampak:** Instance pixelterm unlimited, tanpa tabrakan, hemat RAM. (Lihat `wiki/changelogs/pty.md` untuk detail + fix double-echo.)
- **Oleh:** Copilot

---

## 2026-08-15

### Fix resize atto saat pixelterm dijalankan non-root — /dev/ttyN kini world-accessible
- **File:** `src/kernel/devices/TTYDevice.ts`, `src/mirror/opt/pixelterm/pixelterm.ts`
- **Gejala:** atto tidak mau resize (layar tetap 80x24 / status bar tidak ikut) ketika pixelterm dijalankan **non-root**; kalau root aman.
- **Akar masalah:** `applyTtySize()` membuka `/dev/ttyN` dengan `"w+"` lalu `ioctl(fd, 3)` (TIOCSWINSZ). Device `/dev/ttyN` default `mode = 0o600` (root-only, dari `device.mode ?? 0o600` di syscall OPEN) → non-root ditolak `Permission Denied`, error ditelan `catch` → TIOCSWINSZ tidak pernah jalan → `tty.height/width` tidak di-update → `getScreenInfo()` atto stale 80x24 & tanpa SIGWINCH; hanya IPC RESIZE fallback yang jalan (heuristik "deepest child" → tidak konsisten).
- **Perubahan:**
  - `TTYDevice.ts`: default `uid=0, gid=0, mode=0o666` — semua user boleh membuka `/dev/ttyN` untuk kontrol terminal (TIOCSWINSZ, clear, dan `less`/`more` yang buka `/dev/tty` dengan "r"). Konsisten dengan model keamanan existing (shell.write/read/send via PID tidak punya ownership check); root tetap bisa chmod/chown per-device.
  - `pixelterm.ts`: `applyTtySize()` kini log warning sekali jika open `/dev/ttyN` ditolak (tidak lagi gagal diam-diam).
- **Deploy:** kernel perlu restart agar mode device baru aktif; pixelterm cukup relaunch.
- **Oleh:** Copilot

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
