# Changelog PTY (Pseudo Terminal) TSIX

> Format: `YYYY-MM-DD | Perubahan | Oleh`

---

## 2026-08-29

### Fix: Ctrl+C tidak berfungsi di PTY (pixelterm/tsshd/airtermd) — wiring onInterrupt slave → SIGINT
- **File:** `src/kernel/Syscalls.ts`, `src/kernel/Syscalls.test.ts`
- **Gejala:** Di pixelterm, Ctrl+C tidak memberi respon — proses foreground (mis. `ping`, program lain) tidak berhenti semenjak migrasi ke PTY. Console TTY (tty1..) aman.
- **Akar masalah:** Jalur Ctrl+C di console TTY: `shell.write(pid, "\x03")` → `TTYDevice.ioctl(0x2001)` → `tty.pushInput()` → `tty.onInterrupt()` (sudah di-wire `TTYManager` → kernel kirim SIGINT ke foreground process). Di PTY: `shell.write(pid, "\x03")` → `PTYSlaveDevice.injectInput("\x03")` mengecek `this.onInterrupt` — tetapi **tidak pernah di-set** (satu-satunya setter, master ioctl `0x3001` `SET_SLAVE_INTERRUPT`, tidak dipanggil daemon mana pun). Akibatnya `\x03` dibuang diam-diam → tidak ada SIGINT → program "cuek".
- **Perubahan:** Di handler syscall `PTY_ALLOC` (`src/kernel/Syscalls.ts`), wire `pair.slave.onInterrupt` → kirim `SIGINT` ke foreground process PTY via ttyId negatif `-(ptyId+1)` — mirror pola wiring konsol virtual di `Kernel.ts`/`TTYManager`. Sekali di kernel, berlaku untuk semua daemon (pixelterm/tsshd/airtermd).
- **Test:** 2 test baru di `Syscalls.test.ts` (PTY_ALLOC wire onInterrupt → SIGINT ke foreground; no-op jika tidak ada foreground) — pass. Tidak ada regresi (kegagalan test yang ada sudah pre-existing, bukan dari perubahan ini).
- **Oleh:** Copilot

---

## 2026-08-28

### PTY on-demand — daemon remote & pixelterm tidak lagi pakai slot TTY konsol
- **File:** `src/kernel/PTYManager.ts` (baru), `src/kernel/devices/PTYDevice.ts` (baru, master `/dev/ptmx`), `src/kernel/devices/PTYSlaveDevice.ts` (baru, slave `/dev/pts/N`), `src/common/SyscallCode.ts`, `src/kernel/Syscalls.ts`, `src/kernel/Kernel.ts`, `src/mirror/lib/UserLib.ts`, `src/mirror/opt/tssh/tsshd.ts`, `src/mirror/sbin/airtermd.ts`, `src/mirror/opt/pixelterm/pixelterm.ts`, `wiki/PTY-Pseudo-Terminal.md` (baru), `src/kernel/PTYManager.test.ts` (baru)
- **Masalah:** Sebelumnya daemon terminal remote (`tsshd`, `airtermd`) dan terminal emulator (`pixelterm`) memakai **slot konsol virtual** (`tty3..6`) yang: (1) pre-alokasi di boot → boros RAM (buffer layar penuh meski tidak dipakai), (2) terbatas — jumlah slot = `ttyCount - loginCount`; kalau penuh sesi baru gagal.
- **Perubahan:** Sub-sistem **PTY on-demand** ala Linux:
  - `PTYManager` = allocator dinamis (mirip PortManager). `lib.pty.alloc(rows, cols)` → `{ id, slavePath: "/dev/pts/N", masterPath: "/dev/ptmx" }`; `lib.pty.free(id)` saat selesai.
  - `PTYSlaveDevice` **ringan**: line-based (lineBuffer/inputLines/outputBuffer), TIDAK ada charBuffer layar penuh → hemat RAM.
  - Syscall baru: `PTY_ALLOC = 74`, `PTY_FREE = 75`.
  - Migrasi daemon: `tsshd`/`airtermd` ganti `allocateTTY()` → `lib.pty.alloc()`; `pixelterm` ganti scavenge slot TTY → `lib.pty.alloc()` per instance.
  - Proses di PTY memakai **ttyId negatif** (`-(ptyId+1)`) agar tidak bentrok dengan konsol virtual (1..N). `ps` menampilkan `pts/N`.
  - `lib.shell.exec(path, args, s, e, ttyId, ptyId)` — argumen ke-6 untuk spawn di slave PTY.
- **Dampak:** Sesi remote/pixelterm **tanpa batas** & hemat RAM (tidak pre-alokasi). `ttyCount` bisa dikecilkan bebas tanpa memutus daemon. API: `lib.pty.*` + `exec(..., ptyId)`.
- **Deploy:** edit `src/common/*` + `src/mirror/*` → **`npm run vfs:bootstrap`**; kernel host-side langsung berlaku saat `npm start`.
- **Oleh:** Copilot · **Laporan/konsep:** kakang

### Fix double-echo di pixelterm — kontrak ioctl cmd 10 = SET_RAW_MODE
- **File:** `src/kernel/devices/PTYSlaveDevice.ts`, `src/kernel/devices/PTYDevice.ts`
- **Gejala:** Di pixelterm, prompt + ketikan tampil dobel (`ls` → `ls` ganda); tty1-3 aman.
- **Akar masalah:** `PTYSlaveDevice.ioctl` salah — cmd `10` dikira `INC_READ_REF`, padahal **kontrak `TTYDevice` `cmd 10 = SET_RAW_MODE`** (dipakai `lib.std.setRawMode()`). Akibat `setRawMode(true)` tidak jalan → `injectInput` selalu cooked → echo kernel + echo `tsh` (redraw manual) = **double**.
- **Perubahan:** `PTYSlaveDevice.ioctl` cmd `10` = `SET_RAW_MODE` (via method `setRawMode()`); tambah `clearLineBuffer()`; master `PTYDevice` cmd `10` meneruskan ke slave. Tambah `case 3` (TIOCSWINSZ resize slave). `Syscalls.ts` tambah cabang TIOCSWINSZ untuk PTY slave → resize + kirim SIGWINCH ke proses di PTY (ttyId `-(ptyId+1)`).
- **Dampak:** Raw mode aktif benar → `tsh` yang handle echo (1 salinan), kernel tidak echo → **double hilang**.
- **Oleh:** Copilot

---

## Sebelumnya

- (Tidak ada — fitur baru 2026-08-28.)
