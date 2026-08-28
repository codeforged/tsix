# 🖥️ PTY (Pseudo Terminal) — On-Demand Terminal

> **TL;DR**: PTY adalah "tty dinamis/on-demand" ala Linux. Dibuat saat dibutuhkan (ada sesi `tsshd`/`airtermd`/`pixelterm`), dibebaskan saat selesai. Tidak pre-alokasi seperti konsol virtual (`tty1..N`) → **hemat RAM** dan **tanpa batas jumlah sesi**.

---

## Kenapa PTY?

Sebelumnya daemon terminal remote (`tsshd`, `airtermd`) dan terminal emulator (`pixelterm`) memakai **slot konsol virtual** (`tty3..6`) yang:

- **Pre-alokasi di boot** — buffer layar penuh dialokasikan meski tidak dipakai → boros RAM.
- **Terbatas** — jumlah slot = `ttyCount - loginCount`; kalau penuh, sesi baru gagal.

PTY menyelesaikan keduanya: alokasi **on-demand** dan **hampir tak terbatas**.

| | Konsol Virtual (`tty1..N`) | PTY (`/dev/pts/N`) |
|---|---|---|
| Alokasi | Pre-alokasi saat boot | On-demand (`lib.pty.alloc()`) |
| Jumlah | Tetap (`ttyCount`) | Dinamis (hampir tak terbatas) |
| RAM | Buffer layar penuh per TTY | Line-based ringan (tanpa buffer layar) |
| Pemakaian | `login` lokal + `Alt+F1..F6` | `tsshd`, `airtermd`, `pixelterm` |
| Render ke layar host | ✅ | ❌ (output ditampung, dibaca daemon) |

---

## Arsitektur

```
  Daemon (tsshd/airtermd/pixelterm)
        │  lib.pty.alloc() → { id, slavePath, masterPath }
        ▼
  ┌─────────────┐   onOutput    ┌──────────────────┐
  │ PTYDevice   │  (shared      │ PTYSlaveDevice   │
  │ (master)    │◀── buffer ───▶│ (/dev/pts/N)     │
  │ /dev/ptmx   │               │                  │
  └─────────────┘               └────────┬─────────┘
        │  write()/ioctl                 │  stdin/stdout proses
        └──────────► injectInput ◄───────┘  (login/shell)
```

- **Master** (`PTYDevice`) — dipegang daemon. `write()` → inject input ke slave; `read()` → ambil output slave.
- **Slave** (`PTYSlaveDevice`, `/dev/pts/N`) — dipakai proses (login/shell) sebagai stdin/stdout/stderr.
- **Satu sumber output** — slave menulis ke `outputBuffer`; master & `lib.shell.read(pid)` membaca buffer yang sama (tanpa duplikasi/leak).

### PCB ttyId untuk proses di PTY

Proses yang berjalan di slave PTY diberi `ttyId = -(ptyId + 1)` (negatif) agar **tidak bentrok** dengan konsol virtual (`1..N`). Routing SIGINT/Ctrl+C per-sesi tetap bisa lewat ttyId ini.

---

## API Userland

```ts
// 1. Alokasi PTY
const pty = await lib.pty.alloc(24, 80);
// → { id: 0, slavePath: "/dev/pts/0", masterPath: "/dev/ptmx" }

// 2. Jalankan proses di slave PTY (argumen ke-6 exec = ptyId)
const proc = await lib.shell.exec(
  "/bin/login.ts", [], undefined, undefined, undefined, pty.id,
);

// 3. Baca output & tulis input (via PID — otomatis route ke slave PTY)
const output = await lib.shell.read(proc.pid);   // ioctl 0x2002
await lib.shell.write(proc.pid, "ls\n");         // ioctl 0x2001 (injectInput)

// 4. Resize slave (TIOCSWINSZ)
const fd = await lib.fs.open(`/dev/pts/${pty.id}`, "w+");
await lib.fs.ioctl(fd, 3, { lines: 40, columns: 120 });
await lib.fs.close(fd);

// 5. Bebaskan PTY saat sesi selesai
await lib.pty.free(pty.id);
```

---

## Syscall Baru

| Code | Nama | Args | Return |
|------|------|------|--------|
| 74 | `PTY_ALLOC` | `{ rows?, cols? }` | `{ id, slavePath, masterPath }` |
| 75 | `PTY_FREE` | `id: number` | `boolean` |

Handler ada di `src/kernel/Syscalls.ts` → memanggil `kernel.getPTYManager()`.

---

## File Terkait

| File | Peran |
|------|-------|
| `src/kernel/PTYManager.ts` | Allocator on-demand (master+slave pair) |
| `src/kernel/devices/PTYDevice.ts` | Master (`/dev/ptmx`) |
| `src/kernel/devices/PTYSlaveDevice.ts` | Slave (`/dev/pts/N`) — line-based, ringan |
| `src/kernel/Syscalls.ts` | Handler `PTY_ALLOC`/`PTY_FREE`, EXEC `ptyId`, READ/WRITE deteksi `pts/`, OPEN `/dev/pts/N`, `ls /dev` |
| `src/mirror/lib/UserLib.ts` | `PtyLib` + `UserLib.pty` + `exec(..., ptyId)` |
| `src/mirror/opt/tssh/tsshd.ts` | Migrasi ke PTY (ganti `allocateTTY`) |
| `src/mirror/sbin/airtermd.ts` | Migrasi ke PTY |
| `src/mirror/opt/pixelterm/pixelterm.ts` | Migrasi ke PTY |

---

## Konfigurasi TTY (sysconfig → `shell`)

`ttyCount` & `loginCount` tetap mengontrol jumlah **konsol virtual** + **login lokal** (di `init.ts`):

```jsonc
"shell": {
  "ttyCount": 6,     // total konsol virtual (tty1..6)
  "loginCount": 2    // login di TTY2..3 (TTY1 = console utama)
}
```

Daemon remote **tidak lagi** mengambil slot dari range ini — mereka pakai PTY. Jadi `ttyCount` bisa dikecilkan bebas untuk hemat RAM tanpa memutus tsshd/pixelterm.

---

## Catatan

- `.js` sidecar di VFS di-transpile ulang dari `.ts` saat `npm run vfs:bootstrap` — edit sumber `.ts` cukup, jangan edit `UserLib.js` manual.
- Sidecar `UserLib.js` di repo adalah artefak build lama; runtime memuat UserLib dari VFS Memory Cache (`/lib/UserLib.ts` via `hijackRequire`).
- Milestone berikutnya (opsional): PTY sudah mengisolasi sesi; bisa diperluas dengan session persistence / `tmux`-style detach.
