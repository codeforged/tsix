# Changelog Init (PID 1) TSIX

> Format: `YYYY-MM-DD | Perubahan | Oleh`

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
