# Changelog VFS / Bootstrap

> Format: `YYYY-MM-DD | Perubahan | Oleh`

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
