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

### Marker basi `/var/run/dome.ready` bikin Asteracea start sebelum DOME (regresi migrasi ke skrip)

- **File:** `src/mirror/etc/rc.local`, `scripts/install.ts` (`FSTAB_FRESH`), `src/mirror/bin/rm.ts` (`-f`).
- **Gejala (dilaporkan dari lapangan):** setelah migrasi ke rc.local bergaya skrip, Asteracea dijalankan tetapi instans DOME belum ada sehingga GUI-nya gagal — persis gejala yang dulu hilang saat masih memakai `rc.local.ts`.
- **Akar masalah:** `rc.local.ts` legacy **menghapus** `/var/run/dome.ready` DULU sebelum start DOME (perubahan “Boot readiness” di `changelogs/dome.md`), supaya marker yang ditunggu benar-benar fresh. Langkah itu hilang saat migrasi ke skrip, sedangkan `/var/run` ada di VFS **persisten** → marker boot sebelumnya masih ada → `waitfile` lolos seketika.
- **Perbaikan 1 (di skrip):** `rm -f /var/run/dome.ready` sebelum `/opt/dome/dome.js`, lalu `waitfile /var/run/dome.ready 10000`, baru `/opt/asteracea/asteracea.js`.
- **Perbaikan 2 (`rm.ts`):** TSIX belum punya `-f`; sekarang `rm -f` (beserta flag gabungan `-rf`/`-fr`) didukung — file yang tidak ada tidak lagi menghasilkan error yang mengotori boot log.
- **Perbaikan 3 (akar sistemik):** kernel **menjamin** `/var/run` volatile — `Kernel.ensureVolatileRunDir()` memasang ramfs bila fstab tidak memount-nya (lihat `changelogs/kernel.md`); instalasi baru juga menulis entry `/var/run` eksplisit di `FSTAB_FRESH`. Node lama **tidak perlu** mengedit fstab.
- **Sengaja TIDAK memindahkan penanda ke `/tmp`:** meski `/tmp` sudah ramfs, ia di-mount `0o1777` (world-writable) sehingga penanda bisa dibuat user mana pun — boot akan menganggap DOME siap dan bug yang sama bisa dipicu sengaja. Pembaca penanda hanya `rc.local` (Asteracea tidak memeriksanya), jadi lokasi `/var/run` tetap dipilih karena root-only.
- **Verifikasi:** `rm -f /tidak-ada` → tanpa output; `rm /tidak-ada` → `cannot remove ... No such file or directory`; `rm -rf /tidak-ada` → tanpa output; `rm -f` pada file yang ada → terhapus. Diuji headless lewat harness DME (`scripts/test/worker-dme-smoke.mjs` + syscall `UNLINK`).
- **Verifikasi lapangan (2026-09-17 · andriansah):** `/etc/rc.local` bergaya skrip menjalankan seluruh daemon + `rm -f` + `waitfile` + Asteracea **normal tanpa mengubah fstab** — urutan dome → asteracea terpenuhi dan tidak ada perintah yang menggantung.
- **Oleh:** Copilot · **Laporan:** andriansah

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
