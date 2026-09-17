# Changelog Init (PID 1) TSIX

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-09-17

### Boot menjalankan `/etc/rc.local` bergaya SKRIP (shebang), legacy `.js` tetap jalan

- **File:** `src/mirror/bin/init.ts`
- **Perubahan:** sebelum legacy `/etc/rc.local.js`, init kini menjalankan `/etc/rc.local` sebagai **skrip Unix** — syaratnya file ada, punya bit `x`, dan ber-shebang (`#!/bin/tsh`). Interpreter diterjemahkan kernel (lihat changelog kernel: dukungan shebang di `EXEC`), jadi init cukup `lib.shell.exec("/etc/rc.local")` lalu `waitpid` seperti biasa.
- **Backward compatible:** kalau `/etc/rc.local` tidak ada, alur lama (`/etc/rc.local.js`) persis seperti sebelumnya. Kalau keduanya ada, keduanya dijalankan (skrip dulu) dan init mencetak catatan agar admin menghapus `.js` setelah migrasi.
- **Gagal senyap dihindari:** tiap syarat yang belum terpenuhi menghasilkan pesan jelas — “belum executable (jalankan chmod +x)”, “shebang tidak ditemukan”, lalu error EXEC yang spesifik (`interpreter tidak didukung` / `interpreter tidak ditemukan`).
- **Dampak:** daemon start-up bisa ditulis sebagai daftar perintah sederhana (`netfsd --export ... --key ...`) tanpa class TypeScript; rc.local.ts yang panjang tetap bisa dipakai untuk logika kompleks. Dokumentasi lengkap + resep migrasi: `wiki/RC_LOCAL.md`.
- **Oleh:** Copilot

---

## 2026-09-12

### Seed `/etc/passwd` memakai sidecar `/bin/tsh.js` (bukan `.ts`)

- **File:** `src/kernel/Kernel.ts` (bagian `Security: Seeding /etc/passwd`)
- **Masalah:** Seed default menulis `root:...:/bin/tsh.ts`. Path `.ts` eksplisit melewati preferensi sidecar `.js` di `Syscalls.EXEC` (blok ekstensi hanya jalan bila node tidak ditemukan), sehingga setiap shell dipaksa memakai preload transpiler → **+14.4 MB RSS per worker shell**.
- **Perubahan:** seed → `/bin/tsh.js`. `sysconfig.scheduler.defaultShell` masih bernilai `tsh.ts` dan **tidak dipakai** oleh `Kernel.runInit()` (yang membaca `bootEntry` = `init.js`), jadi hanya seed passwd yang perlu diubah.
- **Dampak:** Instalasi baru langsung memakai jalur cepat `.js` untuk shell. Untuk DB yang sudah ada, lihat `wiki/changelogs/vfs.md` (bootstrap menimpa `/etc/passwd`).
- **Oleh:** Copilot

---

## 2026-08-28

### Jumlah login spawn kini dari `shell.loginCount` (bukan hardcode TTY2-6)
- **File:** `src/mirror/bin/init.ts`, `src/kernel/Kernel.ts`, `src/sysconfig.json`
- **Masalah:** Login di-spawn untuk range TTY yang tetap (`for i=2..2` / komentar TTY2-6) tidak bisa dikonfigurasi untuk hemat RAM.
- **Perubahan:** Baca env `TSIX_TTY_COUNT` & `TSIX_LOGIN_COUNT` (di-set kernel dari sysconfig) → spawn login `TTY2..(1+loginCount)`, di-clamp `Math.min(1+loginCount, ttyCount)`. Komentar diperbarui: daemon remote sudah pakai PTY, bukan slot konsol.
- **Dampak:** `loginCount` mengontrol berapa sesi login aktif saat boot; TTY sisanya kosong (bisa diisi via `openvt`).
- **Oleh:** Copilot

---

## 2026-08-10

### SetUID enforcement di sidecar `.js`
- **File:** `src/mirror/bin/init.ts`
- **Masalah:** `chmod("/bin/passwd.ts", 2541)` & `sudo.ts` (source `.ts`) padahal runtime mengeksekusi sidecar `.js` → SetUID tidak aktif → `sudo` non-root gagal baca `/etc/shadow`.
- **Perubahan:** chmod `2541` (0o4755) kini ke `/bin/passwd.js` & `/bin/sudo.js`.
- **Dampak:** SetUID aktif untuk sudo/passwd sejak boot.
- **Oleh:** Copilot

### Safe mode — skip `/etc/rc.local`
- **File:** `src/mirror/bin/init.ts`
- **Perubahan:** Membaca env `TSIX_SAFE_MODE` (dikirim kernel saat `--safe-mode`); jika `"1"`, print `[INIT] SAFE MODE active` dan melewati eksekusi `/etc/rc.local` (startup daemons). Kode rc.local asli dibungkus `else`.
- **Dampak:** `npm start -- --safe-mode` → boot tanpa daemon → troubleshooting.
- **Oleh:** Copilot
