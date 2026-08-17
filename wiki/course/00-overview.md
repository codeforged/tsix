---
module: 00
title: Overview & Peta Mental
part: I
partTitle: Fondasi
status: done
lang: id
rfc: RFC-TSIX-000
audience: all
---

# TSIX Architecture — Overview & Peta Mental

**RFC-TSIX-000** | Peta mental arsitektur TSIX — untuk kontributor (manusia & AI), hobbyst, penggiat edukasi, dan profesional.

> Dokumen ini adalah **peta mental sistem**. Ia menjelaskan *apa*, *di mana*, dan *kenapa* — bukan tutorial per-file. Gunakan sebagai titik masuk sebelum membaca kode, dan sebagai rujukan saat menjelajah subsistem.
>
> Ini adalah **Modul 00** dari kurikulum TSIX. Untuk roadmap lengkap, lihat [`toc.md`](toc.md).

---

## Daftar Isi

1. [Filosofi & Gambaran Besar](#1-filosofi--gambaran-besar)
2. [Model Ring & Batas Privilege](#2-model-ring--batas-privilege)
3. [Boot Sequence (Host → Userland)](#3-boot-sequence)
4. [Kernel Core: Proses, Scheduler, Syscall, IPC](#4-kernel-core)
5. [VFS & Device Drivers (HAL)](#5-vfs--device-drivers-hal)
6. [Worker Thread & Sandboxing](#6-worker-thread--sandboxing)
7. [Networking MQTNL](#7-networking-mqtnl)
8. [TTY & Virtual Console](#8-tty--virtual-console)
9. [Userland: Init, Shell, Aplikasi](#9-userland)
10. [PixelSpace & TDE](#10-pixelspace--tde)
11. [Alur Pengembangan (Sync VFS)](#11-alur-pengembangan)
12. [Insight Desain & Gotchas](#12-insight-desain--gotchas)
13. [Peta Membaca Kode](#13-peta-membaca-kode)

---

## 1. Filosofi & Gambaran Besar

TSIX adalah **sistem operasi simulasi berbasis Node.js + TypeScript**. Ia bukan VM yang mengemulasi CPU — ia membangun **abstraksi OS di atas runtime Node.js yang sudah ada**.

```
┌──────────────────────────────────────────────────────────────────┐
│ HOST — Linux + Node.js + V8                                      │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ MAIN THREAD = KERNEL (Ring 1-2)                            │  │
│  │  • Boot subsistem • Syscall dispatcher • Scheduler         │  │
│  │  • VFS (SQLite) • HAL devices • GUI registry               │  │
│  └───────────────────────────────┬────────────────────────────┘  │
│                                  │ new Worker() + postMessage    │
│  ┌───────────────────────────────┼────────────────────────────┐  │
│  │ WORKER THREAD #1 (Ring 4)     │  WORKER THREAD #N (Ring 4) │  │
│  │  /bin/init.js  (PID 1)        │  /bin/ls.js, /bin/dome.ts, │  │
│  │  /bin/login, /bin/tsh         │  aplikasi user...          │  │
│  └───────────────────────────────┴────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

**Lima prinsip inti:**

1. **"Everything is a File"** — file dan device sama-sama `IDevice`; `read/write` polimorfik. Buka file biasa → `FileSystemDevice`; buka `/dev/tty1` → `TTYDevice`; bahkan pipe, socket, dan display adalah device.

2. **"Distributed by Design"** — IPC bawaan via syscall `SEND_MSG` + identity-based messaging. Proses berkomunikasi lewat identitas (UUID), bukan alamat memori.

3. **"Small, Sharp Tools"** — 80+ utilitas yang saling terhubung lewat pipe & redirection; satu alat mengerjakan satu hal dengan baik, lalu dikombinasikan.

4. **"Security via Simplicity"** — model permission UID/GID, isolasi proses (Worker Thread), dan privilege root yang sederhana namun tegas.

5. **"Unix Fidelity dulu, pragmatis belakangan"** — meniru perilaku & arsitektur Unix/Linux sedekat mungkin; penyimpangan hanya jika runtime Node.js/V8 tidak mampu, dan wajib didokumentasikan.

**Kunci: kernel tidak pernah menjalankan app.** Semua userland (termasuk PID 1 / init) berjalan di Worker Thread. Batas Ring 1/2 vs Ring 4 adalah batas *thread + IPC*, diperkuat `PermissionManager` berbasis uid/gid/mode.

---

## 2. Model Ring & Batas Privilege

Ring adalah **konsep** (dokumentasi), bukan mekanisme hardware/isolasi V8:

| Ring | Isi | File utama |
|------|-----|------------|
| **0** | Host: Linux + Node/V8 | — (reserved) |
| **1** | Kernel core: Scheduler, Syscall, Permission | `src/kernel/*`, `src/common/*` |
| **2** | Driver & FS: HAL devices, VFS backends, MountManager | `src/kernel/devices/*`, `src/vfs/*` |
| **3** | Library framework: UserLib, Application | `src/mirror/lib/*` |
| **4** | Aplikasi: `/bin/*`, `init`, `tsh`, daemon | `src/mirror/bin/*` |

**Batas privilege nyata** ada di dua lapisan:

- **WorkerEntry sandbox** — app hanya boleh `require` framework `@tsix/*` / `@common/*`; `process.exit`/`process.kill` disabotase. App privileged (nama mengandung `server`/`daemon`/`dome`/`tbuild`/`vfs`) dapat akses allow-list modul host (`http`, `ws`, `fs`, `crypto`, `esbuild`, dll).
- **PermissionManager (kernel)** — cek rwx: root (uid 0) bypass → owner → group → others. SetUID bit didukung (mis. `/bin/login` `0o4755`).

> ⚠️ **Catatan kontributor**: status privileged berbasis **substring nama app** — heuristik rapuh. Ini gap arsitektural yang layak diperbaiki (ideally capability-based).

---

## 3. Boot Sequence

```
main.ts
  Config.load()                    → baca sysconfig.json
  new Kernel()                     → Logger, PermissionManager, MountManager, GUIRegistry
  kernel.boot()
    initializeSubsystems()
      mount BKFS("/")              → SQLite system.db (root filesystem)
      processFstab()               → /tmp (RamFS), /mnt/* (HostVFS), /mnt/sbak (BKFS)
      new Scheduler()
      new PermissionManager()
      new PortManager()
      new SyscallDispatcher()      → scheduler.setSyscallHandler(...)
      rebuildVFSCache()            → pre-compile /lib ke memori
    new TTYManager(32) + TTYDevice tty1..32
    devices{}                      → stdin, fb0, stdout, stderr, null
    init network interfaces        → SimpleMQTNLDriver per config
    loadAuxDevices()               → plugin driver (random, mysql, mcp23017)
    SerialDeviceManager            → auto-detect ttyUSB*
    applyDeviceConfigs()           → "udev": mode/uid/gid dari sysconfig
    pastikan /dev ada di VFS
    load RSA identity              → fingerprint visual di TTY
    ensureDefaultAuth()            → seed /etc/passwd + /etc/shadow (root)
    wire keyboard + TTY callbacks  → Ctrl+C → SIGINT fg; Alt+F1-6 → switch
  kernel.runInit()
    resolve /bin/init.js
    createProcess("init", fds:[tty1×3])   → PID 1
    setForegroundProcess(1, 1)
  [init.ts di Worker]
    enforce setuid (passwd, sudo)
    generate/verify RSA identity
    exec /etc/rc.local.js + waitpid
    spawn login TTY2..6 (monitorProcess → respawn)
    spawn login TTY1 (foreground) → loop forever
  keepAlive (100ms di main.ts)
    jika PID 1 EXITED → process.exit(exitCode)  (1 = reboot)
```

**Urutan rc.local (daemon):** `airtermd` (remote access) → `tpkgd` (package server) → `scpd` (SCP) → `otad` (OTA ESP) → `iot-listener` (MQTNL sensor) → `dome` (display server, harus setelah listener) → Asteracea WM (delay 1s, menunggu DOME) → `crond`.

---

## 4. Kernel Core

### 4.1 Proses (PCB)

`interface PCB` di `Scheduler.ts`: `pid`, `ppid`, `name`, `state`, `pc`, `owner/uid/gid/ruid/groups`, `cwd`, `worker?`, `fdTable`, `env`, `exitCode?`, `ttyId?`, `uuid?`.

**Lifecycle:** `READY → RUNNING → BLOCKED → EXITED`

- **Spawn**: `createProcess()` → alokasi pid → PCB → `spawnWorker()` (Worker Thread).
- **Exit**: `EXIT(code)` → cleanup FD → `worker.terminate()`. Event `worker.on("exit")` → reparent orphan ke PID 1 → resolve waitQueue → `reap()` (zombie jika tanpa waiter).
- **waitpid**: jika EXITED → reap + return exitCode; jika belum → daftar di `waitQueue`.
- **daemonize**: `DETACH` → resolve waiters, lepas foreground TTY, kosongkan ttyId.
- **REEXEC**: terminate worker lama, spawn baru dengan **PID/PCB sama** (state `REEXECING` mencegah cleanup hook).

### 4.2 Syscall Dispatch

```
App → UserLib.dispatch(code, args)
  → postMessage({ requestId: uuid, pid, code, args })
  → Kernel: scheduler → syscallHandler.handleRequest(req)
      → validateArgs(code, args)          // kontrak argumen
      → dispatch(pid, code, args)         // switch-case ~65 syscall
      → PermissionManager.check()         // satpam
      → MountManager.resolve()            // path → backend
      → VFS / device / scheduler
  → postMessage({ requestId, success, data|error })
  → UserLib: cocokkan requestId di responseMap → resolve/reject
```

**Korelasi request-response** via `requestId` (UUID) + `responseMap` — murni RPC asinkron, tidak ada urutan dijamin. Banyak syscall bisa in-flight sekaligus.

**Push event** (kernel → worker, tanpa requestId): `{ type, data }`. Tipe: `signal`, `ipc_message` (SEND_MSG), `gui_request` (forwarding ke gued), `resize`.

### 4.3 Sinyal

| Sinyal | Efek |
|---|---|
| **SIGKILL (9)** | Hard kill: `worker.terminate()` langsung |
| **SIGINT (2)** | Graceful: push event, grace 100ms → terminate jika tak ditangani. Default exit 130 |
| **SIGTERM (15)** | Graceful: grace 300ms. Default exit 143. Dipakai SHUTDOWN |
| **SIGSTOP/SIGCONT** | Soft: ubah `pcb.state` BLOCKED/RUNNING + event |
| **SIGSEGV** | Dikirim ke PID yang melanggar kepemilikan window GUI |
| **SIGHUP/USR1/USR2/WINCH** | Push event generik |

**PID 1 diproteksi** dari kill — hanya `SHUTDOWN`/`REBOOT` (root) yang sah. `SHUTDOWN` bertingkat: SIGTERM broadcast → 5s → SIGKILL survivor → flush network 1s → kill PID 1.

### 4.4 MountManager & PortManager

- **MountManager**: array `MountPoint {vfsPath, vfs, type, source, readOnly, uid, gid}`. `mount()` sortir descending by path length; `resolve()` → prefix terpanjang menang → `{vfs, relativePath, mountPoint}`.
- **PortManager**: port virtual 0–65535 untuk MQTNL; `allocatePort`, `allocateRandomPort(10000-20000)` untuk bind(0), `releasePortsByPid()` saat proses exit (jaring pengaman socket bocor).

---

## 5. VFS & Device Drivers (HAL)

### 5.1 Lapisan VFS

```
Aplikasi → syscall OPEN/READ/WRITE
  → MountManager.resolve(path) → backend IVFS
       "/"        → BKFS    (SQLite system.db, persisten)
       "/tmp"     → RamFS   (volatile, in-memory)
       "/mnt/*"   → HostVFS (bridge folder host, anti-escape)
  → path /dev/xxx → kernel.devices[xxx]  (HAL, bypass MountManager)
```

- **IVFS** = satu kontrak (`ls/mkdir/read/touch/stat/chmod/chown/.../readChunk/writeChunk/getSize`) untuk semua backend — memungkinkan "swap backend" tanpa ubah syscall.
- **BKFS**: file = baris di tabel `vnodes` (parent_id tree). Chunked I/O dijalankan **dalam SQL** (`SUBSTR`/`CONCAT`) tanpa menarik konten penuh — untuk file besar/OTA.
- **HostVFS**: `toHostPath()` + cek anti-escape (Security Violation) — view read-only folder host.

### 5.2 Device Model (HAL)

`IDevice`: `read/write/ioctl` + opsional `init/open/close` + metadata `uid/gid/mode`.

| `/dev/` | Class | Fungsi |
|---|---|---|
| `stdin` | KeyboardDevice | Input keyboard (cooked/raw) |
| `fb0/stdout/stderr` | TTYDevice | Output standar → TTY aktif |
| `tty1..tty32` | TTYDevice | Virtual console |
| `null` | NullDevice | Lubang hitam |
| `smqtnl0/1` | SimpleMQTNLDriver | Network interface MQTNL |
| `randomdevice` | RandomDevice | Angka acak |
| `mysql` *(eksperimental)* | MySQLDevice | Koneksi DB eksternal — POC integrasi, lihat catatan di bawah |
| `mcp23017` | MCP23017Device | GPIO I2C |
| `ttyUSB*` | SerialDevice | Auto-detect |
| *(virtual)* | PipeDevice / SocketDevice | Instance runtime (syscall PIPE/SOCKET), bukan path |

**Kunci "everything is a file"**: FD table berisi `FDEntry {device, context, flags}` → semua objek `IDevice`. File biasa dibungkus `FileSystemDevice`. Pipe refcount via ioctl (`INC_REF`/`DEC_REF`), EOF saat `writeRefs==0`.

**Plugin driver**: folder `aux-devices/` di-scan saat boot; `new DeviceClass()` + konvensi `static autoRegister(kernel)` untuk hardware (MCP23017). `applyDeviceConfigs()` = "udev" dari `sysconfig.json`.

> [!NOTE] **Soal `MySQLDevice` (`/dev/mysql`) — transport pertama, bukan satu-satunya**
> `MySQLDevice` adalah integrasi database eksternal lewat model device — ia **bukan** driver hardware sungguhan, melainkan **transport pertama** untuk akses DB (contoh perluasan HAL).
> **`DbLib` sudah terimplementasi** (sub-library UserLib, pola `lib.fs`/`lib.net`) dengan **dual transport pluggable**:
> - **Device** (`/dev/mysql`): syscall `DB_*` (67-69) → kernel → device → `mysql2`
> - **Service daemon** (`mysqld`): syscall `DB_*` → kernel → daemon Ring 4 → `mysql2`
>
> Kernel me-route secara **dinamis**: jika `mysqld` terdaftar (syscall `DB_SERVICE_REGISTER`=70) → ke daemon; jika tidak → ke device (fallback). Daemon membalas via `DB_SERVICE_REPLY`=71. Aplikasi cuma lihat `db.connect()/query()/disconnect()` — medium tak terlihat. Sandbox aman karena `mysql2` hanya disentuh kernel atau daemon privileged.

---

## 6. Worker Thread & Sandboxing

### 6.1 Bootstrap Worker

```
Kernel.spawnWorker()
  workerData = { pid, appName, args, appPath, appContent, env, vfsCache }
  execArgv:
    *.js  → JS-Direct (FAST)   : --enable-source-maps
    *.ts  → TS-Transpile       : -r esbuild-register -r tsconfig-paths/register

WorkerEntry.ts (bootloader)
  1. realExit = process.exit (sebelum sandbox)
  2. hijack Module._load → resolve @tsix/* & @common/* dari vfsCache (DME)
  3. pasang unhandledRejection/uncaughtException → kirim error ke parent
  4. new UserLibClass(pid) → global._tsixLib
  5. muat app:
       DME  : appContent di-transpile, __filename = BKFS path
       fisik: hostRequire(finalAppPath)
  6. cari export main/Main/default
  7. restrictHostAPI(appName)   ← kunci pintu
  8. new AppClass() → await execute(lib, args)
  9. return string → std.print; lalu shell.exit(0)
```

### 6.2 Direct Memory Execution

Kernel pre-compile `/lib` → `vfsCache` → dikirim via `workerData` → worker `_compile` dari memori. Trick penting: modul framework diberi nama `@tsix_Application.js` supaya import relatif `./x` bisa di-rewrite jadi `@tsix/x` — siklus alias konsisten. App punya **dua identitas filename**: fisik (biar `require` nemu node_modules) vs BKFS (biar stack trace benar).

### 6.3 Sandbox Table

| Lapisan | Batasan |
|---|---|
| Semua app | `process.exit`/`process.kill` → throw; `require` non-framework diblokir |
| App non-privileged | `http/fs/crypto` dll diblokir total |
| App privileged | allow-list: `http, ws, path, fs, url, esbuild, crypto, os, bcryptjs` |
| Kernel | `PermissionManager` + `validateArgs` + `SETUID` root-only |

---

## 7. Networking MQTNL

**MQTNL (MQTT Network Layer)** = protokol networking TSIX. Alih-alih IP/routing TCP/IP, ia memakai **MQTT pub/sub sebagai wire**, plus:
- **Alamat = nama node** (string: `"tsix"`, `"esp32S3"`) — bukan IP.
- **Port = endpoint aplikasi** (PortManager 0–65535).
- **Topic = `mqtnl@1.0/<dstAddress>`** (JSON) / `mqtnl@1.1/<dstAddress>` (Binary).
- **Packet**: header 9 field + payload; fragmentasi 32KB; reassembly TTL 30s; enkripsi RSA + ChaCha20-Poly1305.

```
App → socket() → bind(port) → driver.registerHandler(port)
  → sendto(addr, port, data) → driver.send → publish topic
  → MQTT broker → semua node subscribe 'mqtnl@1.x/#'
  → filter dstAddress → reassembly → decrypt → socket.push()
  → recvfrom() → buffer.shift()
```

**Dual protocol**: `MQTNLProtocolJSON` (v1.0, legacy, readable) vs `MQTNLProtocolBinary` (v1.1, kompak, tanpa enkripsi — untuk OTA byte-exact). Driver deteksi dari **magic byte pertama** per srcAddress. `src/common/protocols/` berisi kontrak `IMQTNLProtocol` — userland **tidak pernah menyentuh ini langsung**.

**Syscall**: `SOCKET=30, BIND=31, SENDTO=32, RECVFROM=33, NETSTAT=34`. Tidak ada `listen/accept` — UserLib emulasi: `listen()` = socket+bind, `accept()` = polling `recv()`.

---

## 8. TTY & Virtual Console

- **TTYManager** mengelola 1–32 konsol virtual; switch hanya 1–12, login di 1–6.
- **TTY** (`src/kernel/tty/TTY.ts`): buffer `char[x][y]`, kursor, parser ANSI subset, render ulang penuh.
- **TTYDevice** (`/dev/ttyN`): ioctl clear(1), raw(10), inject input(0x2001), read output(0x2002), window size(4) — memungkinkan aplikasi remote (pixelterm) mengontrol TTY.
- **Alokasi TTY ke proses**: via `ttyId` di syscall `EXEC` — kernel override FD 0/1/2 ke `tty{n}`. (Beda dengan PortManager yang khusus jaringan.)
- **Keyboard**: cooked/raw mode, Ctrl+C → SIGINT fg, Alt+F1-6 → TTY switch, resize → SIGWINCH broadcast.

---

## 9. Userland

### 9.1 Init (PID 1)
Tanpa `/etc/inittab` — logika hardcoded di `init.ts`: enforce setuid → RSA identity → exec `rc.local` → spawn login per TTY (via `monitorProcess` respawn anti-crash-loop) → loop.

### 9.2 Login → Shell
`login.ts`: verifikasi `/etc/passwd` + `/etc/shadow` (bcrypt) → `setgroups → setgid → setuid` (urutan POSIX) → exec `$SHELL` → `tsh.ts`.

### 9.3 Dua Gaya Aplikasi
1. **Class `IProgram`** (legacy mayoritas): `export class main implements IProgram { async execute({fs,shell,std}: OSContext, args) {...} }` — `ls`, `cat`, `ps`, `kill`, `tsh`.
2. **`Program()` wrapper + proxy singletons** (baru): `import { Program, std, fs, shell, net } from "@tsix/Application"` — `esp-send`, `dome`, `iot-dashboard`.

### 9.4 Error = "Window"
`std.error()` melakukan 4 hal: tulis syslog → broadcast ke parent → print TTY merah → kirim `GUI_WINDOW_ERROR` ke WM (dengan `wid`, `pid`, `fileHint` dari stack trace).

### 9.5 DbLib — Database Sub-Library
`DbLib` (`@tsix/DbLib`, `lib.db`) adalah sub-library kelima UserLib (setelah std/fs/shell/net). Ia membungkus syscall `DB_*` (67-71) menjadi API `db.connect()/query()/disconnect()`. **Transport pluggable**: kernel me-route ke `/dev/mysql` (device) atau `mysqld` (service daemon Ring 4) secara dinamis. Aplikasi tidak tahu mediumnya — persis pola `lib.fs` yang tidak peduli backend VFS-nya.

```
App → db.query(sql) → dispatch(DB_QUERY=68)
  → Kernel: mysqld terdaftar?
       YA  → sendEvent(daemon, "db_request") → mysql2 → dbServiceReply → resolve
       TIDAK → /dev/mysql device → mysql2 → resolve
  → App: rows
```

---

## 10. PixelSpace & TDE

> Detail lengkap di `PIXELSPACE_DEVELOPER_GUIDE.md`. Ringkasan arsitektural:

```
Worker (app) → GUI_REQ (61) → Kernel (GUIRegistry auth pid↔wid)
  → DOME daemon (WS broadcast) → Browser (DOM)
Browser → event → DOME → Kernel (SEND_MSG) → Worker (callback)
```

- **Kontrak**: `GUITypes.ts` (IDOMNode, IGUIPayload, GUIAction, IBrowserEvent, IGUIEventIPC) — "konstitusi", jangan diubah sembarangan.
- **GUIRegistry (kernel)** = otoritas tunggal kepemilikan window: `CREATE_WINDOW` = registrasi `wid↔pid`; akses window orang → SIGSEGV; payload rusak → SIGKILL; proses mati → window auto-destroy.
- **DOME** = display server (Ring 4 daemon, port 8080): relay WS + primitive DOM producer + **kompositor** (titlebar, drag, resize, focus, replay). Monolitik karena pertimbangan latency drag/resize.
- **Emerald** = widget toolkit (`@tsix/emerald`): `Screen`, `Window`, factory functions, connected widgets.
- **Cashew** = component framework (`@tsix/cashew`): OOP/Delphi-style `TForm`/`TButton`/`TEdit`, auto-bind lifecycle, TDialogs & TTimer — layer di atas Emerald.
- **Asteracea** = window manager (fullscreen frameless app): taskbar, launcher, login, wallpaper; listen `GUI_WINDOW_*` lifecycle events via `/etc/asteracea/wm-pid`.

---

## 11. Alur Pengembangan

**Siklus dev (host ↔ VFS):**

```
scripts/vfs-bootstrap.ts   host → system.db (transpile TS→JS, chmod, setuid)
scripts/sync-vfs.ts        sync satu file host ↔ VFS
scripts/vfs-pull.ts        system.db → src/root (pull balik)
SYNC_TO_HOST (syscall)     DB → host (app dalam VFS menulis /lib → src/.tsix_sdk)
userlib-update.ts          sinkronkan /lib → src/.tsix_sdk/lib (agar Node.js host bisa require)
```

**Konfigurasi**: `src/sysconfig.json` (database path, workerEntryPath, bootEntry, network interfaces). `tsconfig.json` memetakan `@tsix/*` → `src/.tsix_sdk/lib/*`, `src/root/lib/*`, `src/mirror/lib/*`.

---

## 12. Insight Desain & Gotchas

**Insight (kenapa didesain begini):**

1. **Syscall sebagai ABI mini** — `SyscallCode` (1–66) + `validateArgs` + `requestId` correlation. Satu mekanisme untuk semuanya: file, proses, IPC, GUI, jaringan.
2. **RPC asinkron murni** — request/response via UUID; beda dari trap sinkron Linux.
3. **Kill bertingkat** — SIGINT/SIGTERM = event + grace period, baru terminate. Replikasi default Unix (unhandled signal → exit).
4. **Zombie & reparent setia** — orphan → PID 1; zombie menunggu `waitpid`+`reap`.
5. **UUID identitas** — `SET_IDENTITY` memungkinkan `SEND_MSG` ke nama stabil walau PID berubah (well-known services).
6. **GUI auth di kernel** — `payload.pid` di-override kernel (jangan percaya userland).
7. **MQTNL = no-IP gratis** — MQTT broker jadi backbone; by design untuk IoT (ESP32) tanpa IP publik.
8. **TTY = PTY emulation lengkap** — master-side I/O via ioctl memungkinkan terminal remote.

**Gotchas (hati-hati saat kontribusi):**

⚠️ **Artefak compile basi**: `src/mirror/lib/*.js` dan `src/userland/WorkerEntry.js` bisa berbeda dari `.ts`-nya. Runtime memakai `.ts` yang di-recompile kernel, jadi `.js` yang di-commit rawan drift (contoh: daftar privileged di `WorkerEntry.js` tidak memuat `dome`).

⚠️ **Dokumentasi vs kode**: `rc.local.ts` (sumber) memuat daftar daemon lengkap, tapi `rc.local.js` (yang dieksekusi) hanya 3 daemon. Wiki `Networking-MQTNL.md` menyebut topic `tsix/net/*` tapi kode memakai `mqtnl@1.0/`. **Kode adalah kebenaran.**

⚠️ **Dead code**: `ExecutableRegistry` terdefinisi tapi tidak di-wire di Kernel — resolusi binary via `MountManager.resolve()` + `vfs.read()`.

⚠️ **`inittab` tidak ada** — init meng-hardcode TTY login.

⚠️ **Dual NetworkLib** — `UserLib.ts` (inline, `lib.net`) vs `src/mirror/lib/NetworkLib.ts` (legacy, OSContext-based) menuju syscall yang sama.

⚠️ **Privilege berbasis nama** — heuristik substring app (rapuh; idealnya capability-based).

---

## 13. Peta Membaca Kode

### Mulai dari sini (wajib)
| File | Peran |
|---|---|
| `src/main.ts` | Entry point host + keep-alive |
| `src/kernel/Kernel.ts` | Orkestrator boot semua subsistem |
| `src/common/IPCTypes.ts` | Kontrak IPC (request/response/event) |
| `src/common/SyscallCode.ts` | ABI syscall (1–66) |
| `src/common/GUITypes.ts` | Kontrak PixelSpace |

### Kernel Core
| File | Peran |
|---|---|
| `src/kernel/Scheduler.ts` | PCB, proses, sinyal, reexec |
| `src/kernel/Syscalls.ts` | Dispatcher ~65 syscall + permission |
| `src/kernel/PermissionManager.ts` | Cek rwx |
| `src/kernel/MountManager.ts` | Routing path → backend |
| `src/kernel/PortManager.ts` | Port network |
| `src/kernel/GUIRegistry.ts` | Otoritas window |

### VFS & Devices
| File | Peran |
|---|---|
| `src/vfs/IVFS.ts` | Kontrak filesystem |
| `src/vfs/BKFS.ts` | Root FS (SQLite) |
| `src/vfs/VFS.ts` / `RamFS.ts` / `HostVFS.ts` | Backend lain |
| `src/kernel/devices/IDevice.ts` | Kontrak HAL |
| `src/kernel/devices/FileSystemDevice.ts` | Jembatan file ↔ IVFS |
| `src/kernel/devices/*.ts` | Driver: TTY, Keyboard, Pipe, Socket, MQTNL |
| `src/kernel/devices/aux-devices/` | Plugin driver |

### Worker & Userland
| File | Peran |
|---|---|
| `src/userland/WorkerEntry.ts` | Bootloader worker + sandbox + DME |
| `src/mirror/lib/UserLib.ts` | "libc" sisi worker |
| `src/mirror/lib/Application.ts` | Framework Program() v2.1 |
| `src/mirror/lib/emerald.ts` | Widget toolkit |
| `src/mirror/bin/init.ts` | PID 1 |

### Networking & Protokol
| File | Peran |
|---|---|
| `src/kernel/devices/SimpleMQTNLDriver.ts` | Driver MQTNL |
| `src/common/protocols/IMQTNLProtocol.ts` | Kontrak protokol |
| `src/common/protocols/MQTNLProtocolJSON.ts` | v1.0 |
| `src/common/protocols/MQTNLProtocolBinary.ts` | v1.1 |

### GUI/TDE
| File | Peran |
|---|---|
| `src/mirror/bin/dome.ts` | DOME server |
| `src/mirror/bin/dome-client.html` | DOME browser |
| `src/mirror/bin/asteracea.ts` | WM |
| `src/mirror/lib/theme.ts` | Tema |

---

## Lampiran: Ringkasan alur data kunci

**Baca file:**
```
fs.readFile("/etc/passwd")
→ OPEN: resolve → MountManager → BKFS → FileSystemDevice → fd
→ READ: fdTable[fd].device.read() → vfs.read → SQL SELECT
→ CLOSE: ioctl DEC_REF → fdTable[fd] = null
```

**Spawn app:**
```
shell.exec("/bin/ls")
→ EXEC: resolve → vfs.read(appContent) → permission EXECUTE
→ createProcess → spawnWorker → WorkerEntry → DME app → execute()
```

**Kirim pesan antar app:**
```
shell.send(pidOrUuid, {type, ...})
→ SEND_MSG → kernel resolve pid (atau uuidMap) → sendEvent(pid, "ipc_message", data)
```

**Buka window:**
```
Screen → CREATE_WINDOW → kernel (GUIRegistry.auth) → DOME → WS → browser
```

---

*TSIX Architecture Guide v1.0 — untuk kontributor & pengembang.*
*Dokumen ini hidup — perbarui seiring perubahan kode. "Kode adalah kebenaran."*
