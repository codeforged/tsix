# RC.local - System Startup Scripts

## Overview

TSIX implements a traditional Unix-style `/etc/rc.local` boot script system for auto-starting daemons and services during system initialization.

Ada **dua gaya** yang keduanya didukung (backward compatible):

| Gaya | File | Isi | Cocok untuk |
|---|---|---|---|
| **Skrip (baru)** | `/etc/rc.local` | skrip shell ber-shebang `#!/bin/tsh` + bit `x` | daftar perintah sederhana, cepat dibaca |
| **Legacy** | `/etc/rc.local.js` | class TypeScript `export default class` | logika kompleks (polling, kondisi, IPC) |

Saat boot, `init` menjalankan **skrip `/etc/rc.local` lebih dulu** (kalau ada), lalu legacy `/etc/rc.local.js`. Kalau keduanya ada, init mencetak catatan supaya tidak bingung — hapus `.js` setelah migrasi selesai.

> Ini dimungkinkan karena **kernel kini mendukung shebang** di `EXEC`: `exec("/etc/rc.local")` otomatis menjadi `exec("/bin/tsh.js", ["/etc/rc.local", ...args])`. Fitur yang sama membuat `./skrip.sh`, entri cron, dan peluncuran dari Asteracea bisa memanggil skrip executable tanpa tahu isinya.

## How It Works

1. **Boot Sequence**: After kernel initialization and identity setup, `init.ts` (PID 1) executes rc.local (script lalu legacy)
2. **Synchronous Execution**: Init waits for rc.local to complete before spawning login services
3. **Exit Code**: rc.local should exit with code 0 for success, non-zero for failure
4. **Safe mode**: `npm start -- --safe-mode` melewati kedua gaya (startup dimatikan)

## Gaya 1 — Skrip `/etc/rc.local` (disarankan)

Syaratnya sama seperti Linux, dan **semuanya ditegakkan** (kalau belum terpenuhi, init
memberi pesan yang jelas alih-alih gagal senyap):

1. File ada di `/etc/rc.local`
2. Punya bit eksekusi → `chmod +x /etc/rc.local`
3. Baris pertama shebang: `#!/bin/tsh` (boleh juga `#!/bin/sh`, `#!/bin/bash`, atau `#!/usr/bin/env tsh`)

```bash
#!/bin/tsh
# /etc/rc.local — daemon start-up (dibaca init saat boot)

# Tulis panjang boleh disambung dengan \
netfsd --export /mnt/sbak/ --label databank --port 7777 \
  --key c50f67b70e2f0dcf5246ccde04cb1297742ea20a51355eb61807137e003b5c65

# Argumen & variabel juga bisa: $0, $1..$9, $@, $#
```

Membuat & mengaktifkannya dari shell:

```bash
atto /etc/rc.local          # atau cara lain untuk menulis file
chmod +x /etc/rc.local      # wajib — tanpa ini init melewatinya
```

Yang tersedia di dalam skrip: perintah apa pun yang dikenal `tsh` (builtin, aplikasi,
pipa `|`, redirection `>`, background `&`, wildcard), komentar `#`, sambung baris `\`.
Belum ada `if`/`for`/`while` — kalau butuh logika bercabang, tetap pakai gaya legacy.

## Gaya 2 — Legacy `/etc/rc.local.js`

```typescript
import { UserLib } from "../lib/UserLib";

export default class RcLocal {
    async execute(lib: UserLib, args: string[]) {
        // Start daemons here
        await lib.shell.exec("/bin/airtermd.js", [], undefined, undefined, undefined);

        // Exit with success
        await lib.shell.exit(0);
        return "";
    }
}
```

## Migrasi dari `.js` ke skrip

1. Pindahkan `exec()` yang tidak butuh logika ke `/etc/rc.local` (hindari baris yang perlu polling/kondisi).
2. `chmod +x /etc/rc.local`, reboot, periksa boot log (keduanya masih jalan — aman).
3. Setelah yakin, hapus legacy: `rm /etc/rc.local.js` (atau `mv` ke `/etc/rc.local.js.bak`).

## Boot Flow

```
1. Kernel Boot
2. Init (PID 1) starts
3. System Identity Check
4. Execute /etc/rc.local (skrip, jika ada)   ← Daemons start here
5. Execute /etc/rc.local.js (legacy, jika ada)
6. Spawn Login Services (TTY1-6)
7. Display Banner
8. Ready for user login
```

## Common Use Cases

- Start network daemons (`airtermd`, `tsshd`, `netfsd`)
- Initialize background services
- Mount additional filesystems
- Set system-wide configurations
- Start monitoring services

## Debugging

Check boot logs to see rc.local execution:
```bash
# Gaya skrip:
[  OK  ] [INIT] Running startup script /etc/rc.local (#!/bin/tsh)...
[  OK  ] [INIT] Startup script completed.

# Legacy:
[  OK  ] [INIT] Executing startup scripts (/etc/rc.local)...
[  OK  ] [rc.local] Starting system daemons...
[  OK  ] [INIT] Startup scripts completed successfully.
```

Pesan yang mungkin muncul beserta artinya:

| Pesan | Artinya |
|---|---|
| `/etc/rc.local dilewati: belum executable` | jalankan `chmod +x /etc/rc.local` |
| `/etc/rc.local dilewati: shebang tidak ditemukan` | baris pertama harus `#!/bin/tsh` |
| `EXEC: interpreter tidak didukung: ...` | shebang bukan `tsh`/`sh`/`bash` |
| `EXEC: interpreter tidak ditemukan` | `/bin/tsh.js` tidak ada (sistem belum ter-install benar) |
| `Catatan: /etc/rc.local (skrip) DAN /etc/rc.local.js (legacy) sama-sama dijalankan` | keduanya ada — hapus `.js` setelah migrasi |

## Notes

- rc.local runs as **root** (UID 0)
- Services started from rc.local should daemonize themselves
- Use `lib.shell.exec()` (legacy) atau cukup tulis perintahnya (skrip) untuk spawn background processes
- Always exit with proper exit code (0 = success)
