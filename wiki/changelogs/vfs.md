# Changelog VFS / Bootstrap

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-09-12

### CATATAN — akun runtime (`useradd`) hilang dari `/etc/passwd`; `vfs:bootstrap` BUKAN penyebabnya

> ⚠️ Koreksi: dugaan awal (saat kerja optimasi memori) bahwa `vfs:bootstrap` menimpa
> `/etc/passwd` **terbukti SALAH** setelah diuji. Bagian ini ditulis ulang berdasarkan
> hasil verifikasi.

- **Fakta terverifikasi (diuji langsung):** `scripts/vfs-bootstrap.ts` **melewati** file tanpa ekstensi — `syncDir()` punya `if (!isTarget) continue;`, dan `isTarget` hanya mencocokkan `.ts/.js/.json/.html/.css/.menu/.mp3/.wav/.jpg/.jpeg/.png/.gif/.bmp/.svg/.webp/.ico`. Uji A/B: `passwd`, `group`, `shadow`, `motd`, `profile` di DB **identik** sebelum & sesudah `npm run vfs:bootstrap`.
- **Yang MEMANG menimpa:** `scripts/install.ts` — daftar `CRITICAL_ETC` (`passwd`, `group`, `shadow`, dll) sengaja di-`touch` dari `src/mirror/etc/*`. Ini **didesain** untuk fresh install, jadi bukan bug; tapi efek sampingnya perlu diketahui (fresh install mereset akun ke isi sumber).
- **Isi sumber:** `src/mirror/etc/passwd` & `shadow` hanya berisi `root` (di git, sejak awal).
- **Observasi:** pada `system.db` kerja, `passwd` hanya berisi `root`, sementara `shadow` & `group` masih memuat entri `joe`/`joes` buatan **runtime** (`useradd`). Jadi akun `joe` bukan berasal dari git — ia state runtime di DB. Pemicu tepat hilangnya entri di `passwd` **belum teridentifikasi**; yang pasti bukan `vfs:bootstrap` dan bukan seed kernel (seed hanya jalan bila file belum ada).
- **Praktis:** akun yang dibuat runtime dapat hilang dari `/etc/passwd` karena operasi yang menulis ulang file itu dari sumber. Bila perlu, buat ulang dengan `useradd`, atau `usermod -s` untuk memperbaiki field shell. `system.db` bersifat lokal (tidak ikut ter-commit).
- **Oleh:** Copilot · **Laporan:** kakang

### Shell default pindah ke sidecar `.js` — path `.ts` melewati preferensi `.js`
- **File:** `src/mirror/etc/passwd`, `src/kernel/Kernel.ts` (seed), `src/mirror/bin/useradd.ts`, `scripts/lib/user-account.ts`
- **Masalah:** `/etc/passwd` menunjuk `/bin/tsh.ts` (path `.ts` eksplisit). Di `Syscalls.EXEC`, blok preferensi ekstensi `.js`→`.ts` hanya berjalan `if (!node)`; karena `.ts`-nya **ada**, sidecar `.js` tidak pernah dicoba. Akibatnya setiap shell dipaksa memakai preload transpiler (**+14.4 MB RSS/worker**).
- **Perubahan:** shell default → `/bin/tsh.js` di keempat titik (file sumber, seed kernel, `useradd`, dan helper installer). Sidecar `tsh.js` sudah tersedia (mode 755), lebih baru dari `.ts`-nya, dan lolos `node --check`.
- **Dampak:** Worker shell turun dari ~30.6 MB → ~16.2 MB.
- **Deploy:** nilai `/etc/passwd` di DB yang sudah ada harus disesuaikan manual (mis. `usermod -s /bin/tsh.js root`) — `vfs:bootstrap` tidak menyentuhnya.
- **Oleh:** Copilot

### Semua titik spawn `.ts` dipindah ke sidecar `.js`

- **File:** `src/mirror/opt/pixelterm/pixelterm.ts`, `src/mirror/opt/tssh/tsshd.ts`, `src/mirror/sbin/airtermd.ts`, `src/mirror/bin/userdel.ts`, `src/mirror/bin/sudo.ts`, `src/mirror/bin/which.ts`, `src/mirror/bin/tsh.ts`, `src/mirror/opt/taskmgr/taskmgr.ts`
- **Masalah:** Pola yang sama berulang di banyak tempat — path `.ts` ditulis eksplisit, atau resolver hanya mencoba `cmd` lalu `cmd.ts` tanpa `cmd.js`.
- **Perubahan:**
  - `tsshd.ts` & `airtermd.ts`: exec `/bin/login.js` (sebelumnya `/bin/login.ts`).
  - `userdel.ts`: exec `/bin/rm.js` (sebelumnya `/bin/rm.ts`).
  - `sudo.ts`: urutan ekstensi `["", ".ts"]` → `["", ".js", ".ts"]` — sebelumnya **setiap perintah via `sudo`** selalu memakai worker `.ts`.
  - `which.ts`: tambah `.js` pada jalur path-langsung (sebelumnya hanya `cmd` + `cmd.ts`).
  - `tsh.ts` (`resolveBinary()`): jalur `cmd.includes("/")` kini mencoba sidecar `.js` sebelum `.ts`.
  - `taskmgr.ts`: filter shell memakai `/^tsh\.(ts|js)$/` agar tetap benar saat shell berganti nama.
- **Dampak:** Hemat ~14.4 MB per proses yang terlibat; tidak ada perubahan perilaku.
- **Deploy:** `npm run vfs:bootstrap` (wajib — runtime mengeksekusi sidecar `.js`).
- **Oleh:** Copilot

---

## 2026-08-28

### PENTING — perubahan `src/common/*` & `src/mirror/lib/*` JUGA wajib `vfs:bootstrap`
- **File:** `src/userland/WorkerEntry.ts` (perilaku), `src/kernel/Kernel.ts` (`rebuildVFSCache`)
- **Masalah:** Setelah menambah enum syscall baru (`PTY_ALLOC`/`PTY_FREE`) di `src/common/SyscallCode.ts`, pixelterm error `Unknown Syscall: undefined`. Akar: worker memuat `@common/*` & `@tsix/*` dari **VFS Memory Cache** (`/lib/common/SyscallCode.ts`, `/lib/UserLib.ts`) yang di-build dari `system.db` saat boot — database belum di-sync → konstanta enum baru = `undefined`.
- **Perubahan (pola kerja):** Edit `src/common/*` + `src/mirror/*` → **WAJIB `npm run vfs:bootstrap`**. File `src/kernel/*` (host-side) langsung berlaku saat `npm start` tanpa sync.
- **Deteksi mismatch:** query `vnodes` untuk `SyscallCode.ts` — cek `content.includes("PTY_ALLOC")`; atau gejala runtime `Unknown Syscall: undefined`.
- **Oleh:** Copilot · **Laporan:** kakang

---

## 2026-08-05

### vfs-bootstrap: sync binary assets (.mp3 / .wav)
- **File:** `scripts/vfs-bootstrap.ts`
- **Masalah:** Bootstrap hanya menyinkronkan `.ts/.js/.json/.html/.css/.menu` — file audio (`mp3`/`wav`) tidak ikut, jadi harus dimasukkan manual ke system.db.
- **Perubahan:** Tambah `.mp3` & `.wav` ke daftar target. Binary dibaca sebagai Buffer lalu disimpan sebagai **latin1 string** (1 byte = 1 char) — kompatibel dengan `Buffer.from(raw, "latin1")` di sisi app (mis. ResourceBank encode base64).
- **Dampak:** File audio di `src/mirror/` kini persist lewat `npm run vfs:bootstrap` (contoh: `footstep.wav` sample DDC 5).
- **Oleh:** Copilot

## 2026-08-04

### `create-bkfs.ts` — pembuat database VFS kosong
- **File:** `scripts/create-bkfs.ts` (npm: `bkfs:create`)
- **Perubahan:** Script untuk membuat `system.db` kosong (schema BKFS). Opsi: `--path <file>` (default `system.db`), `--seed-dirs` (membuat `/bin /dev /etc /home /lib /mnt /opt /root(700) /tmp(1777) /usr /var`), `--force` (backup file existing ke `.bak-<ts>`).
- **Dampak:** Inisialisasi database VFS baru tanpa bootstrap penuh.
- **Oleh:** Copilot

### `vfs-bootstrap.ts` menerima argumen dbPath
- **File:** `scripts/vfs-bootstrap.ts`
- **Perubahan:** Terima path database sebagai argumen positional: `npm run vfs:bootstrap -- data/test.db` (default `system.db`).
- **Dampak:** Bisa bootstrap ke database selain default (pengujian / instalasi perangkat baru).
- **Oleh:** Copilot
