# Changelog Install & Scripts TSIX

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-08-13

### Password prompt kini di-masking ('*') — tidak bocor saat diketik
- **File:** `scripts/install.ts`
- **Masalah:** Password (user baru, konfirmasi, dan root) tampil plaintext saat diketik (`Password for 'x' rahasia123`) — tidak aman kalau ada yang melihat layar.
- **Perubahan:** Fungsi `promptPassword()` baru. `readline/promises` tidak punya mode silent, jadi: detach listener readline sementara (agar readline tidak meng-echo plaintext), baca stdin dalam raw-mode (echo terminal mati), tampilkan `*` per karakter, lalu pulihkan state readline. Handle Enter/Ctrl+D (submit), Backspace (hapus), Ctrl+C (batal, exit 130), escape sequence panah (diabaikan). Non-TTY (pipe/redirect) fallback ke prompt biasa. Diterapkan ke `Password for '<user>'`, `Confirm password`, dan `Root password`.
- **Dampak:** Input password tersembunyi seperti di Ubuntu/Unix. Verifikasi PTY: tidak ada plaintext bocor, hash bcrypt tetap cocok.
- **Oleh:** Copilot · **Laporan:** kakang

### Prompt "Default user login" diganti akun user ala Ubuntu (+ home directory)
- **File:** `scripts/install.ts`, `scripts/lib/user-account.ts`, `wiki/course/23-development-workflow.md` (+`.en.md`), `docs/TSIX-Course-ID.html`, `docs/TSIX-Course-EN.html`
- **Masalah:** Prompt `Default user login` tidak berguna — akun `root` sudah pasti dibuat otomatis dari `src/mirror/etc/{passwd,group,shadow}`.
- **Perubahan:** Prompt tersebut dihapus. Diganti pembuatan akun user biasa ala installer Ubuntu: `Username (empty to skip)` → `Password for '<user>'` → `Confirm password`, dengan validasi (username `^[a-z_][a-z0-9_-]*$`, password tidak kosong & harus cocok; username kosong = skip, cukup root). Logika pembuatan dipindah ke helper murni `createUserAccount()` di `scripts/lib/user-account.ts` (bisa diuji terpisah) yang:
  - menambah entri ke `/etc/passwd` (UID ≥ 1000, gid `users` 100, shell `/bin/tsh.ts`),
  - menambah hash bcrypt ke `/etc/shadow` (mode `0640`),
  - menambahkan user sebagai member grup `users` di `/etc/group`,
  - membuat `/home/<username>` (mode `0700`, milik user) — **home directory kini dibuat**.
- **Dampak:** Fresh install bisa langsung punya akun non-root + home, tidak perlu `useradd` manual. Konsisten dengan `/bin/useradd.ts`.
- **Oleh:** Copilot · **Laporan:** kakang

### Address interface otomatis dari hostname — prompt per-interface dihapus
- **File:** `scripts/install.ts`, `README.md`
- **Masalah:** Instalasi interaktif menanyakan address per-interface MQTT (`Address smqtnl0`, `Address smqtnl1`) — terlalu teknis untuk user biasa.
- **Perubahan:** Prompt address per-interface dihapus. Address kini di-derive otomatis dari hostname di semua mode: `interface[0]` = `<hostname>`, `interface[1..n]` = `<hostname>_2`, `_3`, dst.
- **Dampak:** Instalasi lebih ringkas (tidak perlu paham detail jaringan). Daftar pertanyaan installer di README ikut diperbarui.
- **Oleh:** Copilot · **Laporan:** kakang

---

## 2026-08-12

### `/opt` ditambahkan ke direktori eksekusi — GUI app bisa dijalankan user non-root
- **File:** `scripts/install.ts`, `scripts/sync-vfs.ts`, `scripts/vfs-bootstrap.ts`
- **Masalah:** `EXEC_DIRS` hanya berisi `/bin`, `/sbin`, `/usr/bin`, `/usr/local/bin`. Aplikasi GUI di `/opt/<app>/` (asteracea, dome, iot-dashboard, taskmgr, dll) tidak diberi flag `x` → user non-root tidak bisa menjalankan tanpa `chmod`/`sudo` (`chmod: cannot access ... Permission denied` karena file milik root).
- **Perubahan:** Tambah `"/opt"` ke `EXEC_DIRS` di ketiga script → entry `.js`/`.ts` di `/opt/<app>/` di-chmod `0755` (owner root rwx, group & others r-x) oleh `applyBinaryMode` saat install/bootstrap/sync.
- **Dampak:** App `/opt` langsung bisa dijalankan user non-root tanpa `chmod` manual. Catatan: untuk sistem yang sudah ada, jalankan `npm run vfs:bootstrap` (atau `npm run install`) agar mode diterapkan ulang. Mode hanya diterapkan ke `.js`/`.ts` (bukan `.menu`/config/asset).
- **Oleh:** Copilot · **Laporan/reproduksi:** kakang

---

## 2026-08-10

### Script instalasi `npm run install` (Fresh Install Agent)
- **File:** `scripts/install.ts`, `package.json`
- **Perubahan:** Script interaktif baru: prompt hostname/user/broker MQTT/port/verbose/path DB/password root → tulis `src/sysconfig.json` → buat DB `.db` baru → sync `src/mirror` + `src/common` (`/lib/common`) → mode eksekusi/SetUID → seed passwd/shadow/group → fstab hanya `/tmp` ramfs → crontab kosong. Tidak bergantung pada `sysconfig.json` yang sudah ada (memakai config default & membuatnya). `version` diambil otomatis dari `Kernel.ts`; `distroName` & `creator` tidak diinput (identitas bawaan).
- **Dampak:** Fresh install cukup satu perintah; tidak perlu `vfs:bootstrap` terpisah.
- **Oleh:** Copilot

### Path DB default bersama dari `sysconfig.json`
- **File:** `scripts/lib/db-path.ts`, `scripts/vfs-bootstrap.ts`, `scripts/create-bkfs.ts`, `scripts/sync-vfs.ts`, `scripts/sync-tde.ts`, `scripts/vfs-pull.ts`, `scripts/clean_bloat.js`
- **Perubahan:** Helper `getDefaultDbPath()` membaca `kernel.database` dari `src/sysconfig.json` (fallback `system.db`). Semua script memakainya, menggantikan hardcode `system.db`/`system2.db`.
- **Dampak:** Path DB selalu sinkron dengan hasil instalasi.
- **Oleh:** Copilot

### Mode eksekusi & SetUID untuk direktori binary
- **File:** `scripts/sync-vfs.ts`, `scripts/vfs-bootstrap.ts`, `scripts/install.ts`
- **Masalah:** Script sync hanya chmod `/bin/`; `/sbin`, `/usr/bin`, `/usr/local/bin` dibiarkan `0644` → `shutdown`/`reboot` & daemon `/sbin/*` kena `Permission denied`.
- **Perubahan:** Helper `isSetuidBinary`/`isExecutableBinary`/`applyBinaryMode`: `/bin` → 0755, `/sbin` → 0744 (root-only), `/usr/bin` & `/usr/local/bin` → 0755; SetUID 4755 untuk `login`/`passwd`/`sudo`.
- **Dampak:** Semua binary di direktori eksekusi bisa dijalankan dari PATH.
- **Oleh:** Copilot

### Fresh install: fstab & crontab dibersihkan
- **File:** `scripts/install.ts`
- **Perubahan:** `/etc/fstab.json` pada image fresh hanya berisi `/tmp` ramfs (mount dev `/mnt/shared`, `/mnt/sbak` dihapus); `/etc/crontab` kosong.
- **Dampak:** Image distribusi tidak membawa mount/cron bawaan developer.
- **Oleh:** Copilot
