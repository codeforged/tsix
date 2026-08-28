# Changelog Init (PID 1) TSIX

> Format: `YYYY-MM-DD | Perubahan | Oleh`

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
