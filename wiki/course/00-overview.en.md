---
module: 00
title: Overview & Mental Map
part: I
partTitle: Foundations
status: done
lang: en
rfc: RFC-TSIX-000
audience: all
---

# TSIX Architecture — Overview & Mental Map

**RFC-TSIX-000** | Mental map of the TSIX architecture — for contributors (human & AI), hobbyists, educators, and professionals.

> This document is the **system's mental map**. It explains *what*, *where*, and *why* — not a per-file tutorial. Use it as an entry point before reading the code, and as a reference while exploring subsystems.
>
> This is **Module 00** of the TSIX curriculum. For the full roadmap, see [`toc.md`](toc.md).

---

## Table of Contents

1. [Philosophy & Big Picture](#1-philosophy--big-picture)
2. [Ring Model & Privilege Boundaries](#2-ring-model--privilege-boundaries)
3. [Boot Sequence (Host → Userland)](#3-boot-sequence)
4. [Kernel Core: Processes, Scheduler, Syscall, IPC](#4-kernel-core-processes-scheduler-syscall-ipc)
5. [VFS & Device Drivers (HAL)](#5-vfs--device-drivers-hal)
6. [Worker Thread & Sandboxing](#6-worker-thread--sandboxing)
7. [Networking MQTNL](#7-networking-mqtnl)
8. [TTY & Virtual Console](#8-tty--virtual-console)
9. [Userland: Init, Shell, Applications](#9-userland-init-shell-applications)
10. [PixelSpace & TDE](#10-pixelspace--tde)
11. [Development Flow (VFS Sync)](#11-development-flow-vfs-sync)
12. [Design Insights & Gotchas](#12-design-insights--gotchas)
13. [Code Reading Map](#13-code-reading-map)

---

## 1. Philosophy & Big Picture

TSIX is a **simulated operating system built on Node.js + TypeScript**. It is not a VM that emulates a CPU — it builds **OS abstractions on top of the existing Node.js runtime**.

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

**Three core principles:**

1. **"Syscall = the only door"** — Worker threads never touch resources directly. Even `print` is a syscall. This keeps the ring boundaries truly meaningful.

2. **"Everything is a File"** — files and devices are both `IDevice`; `read/write` is polymorphic. Open a regular file → `FileSystemDevice`; open `/dev/tty1` → `TTYDevice`.

3. **"Direct Memory Execution"** — the framework (`/lib`) is pre-compiled into memory at boot, sent to workers via `workerData`, and executed without hitting the filesystem. `@tsix/*` feels instant.

**Key: the kernel never runs apps.** All of userland (including PID 1 / init) runs in Worker Threads. The Ring 1/2 vs Ring 4 boundary is a *thread + IPC* boundary, reinforced by the uid/gid/mode-based `PermissionManager`.

---

## 2. Ring Model & Privilege Boundaries

Rings are a **concept** (documentation), not a hardware or V8 isolation mechanism:

| Ring | Contents | Main files |
|------|----------|------------|
| **0** | Host: Linux + Node/V8 | — (reserved) |
| **1** | Kernel core: Scheduler, Syscall, Permission | `src/kernel/*`, `src/common/*` |
| **2** | Driver & FS: HAL devices, VFS backends, MountManager | `src/kernel/devices/*`, `src/vfs/*` |
| **3** | Library framework: UserLib, Application | `src/mirror/lib/*` |
| **4** | Applications: `/bin/*`, `init`, `tsh`, daemon | `src/mirror/bin/*` |

The **real privilege boundaries** live in two layers:

- **WorkerEntry sandbox** — apps may only `require` the `@tsix/*` / `@common/*` framework; `process.exit`/`process.kill` are sabotaged. Privileged apps (names containing `server`/`daemon`/`dome`/`tbuild`/`vfs`) get access to an allow-list of host modules (`http`, `ws`, `fs`, `crypto`, `esbuild`, etc.).
- **PermissionManager (kernel)** — rwx checks: root (uid 0) bypass → owner → group → others. The SetUID bit is supported (e.g. `/bin/login` `0o4755`).

> ⚠️ **Contributor note**: privileged status is based on **name substrings** — a fragile heuristic. This is an architectural gap worth fixing (ideally capability-based).

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

**rc.local order (daemons):** `airtermd` (remote access) → `tpkgd` (package server) → `scpd` (SCP) → `otad` (ESP OTA) → `iot-listener` (MQTNL sensor) → `dome` (display server, must run after the listener) → Asteracea WM (1s delay, waits for DOME) → `crond`.

---

## 4. Kernel Core

### 4.1 Processes (PCB)

`interface PCB` in `Scheduler.ts`: `pid`, `ppid`, `name`, `state`, `pc`, `owner/uid/gid/ruid/groups`, `cwd`, `worker?`, `fdTable`, `env`, `exitCode?`, `ttyId?`, `uuid?`.

**Lifecycle:** `READY → RUNNING → BLOCKED → EXITED`

- **Spawn**: `createProcess()` → allocate pid → PCB → `spawnWorker()` (Worker Thread).
- **Exit**: `EXIT(code)` → FD cleanup → `worker.terminate()`. The `worker.on("exit")` event → reparent orphans to PID 1 → resolve waitQueue → `reap()` (zombie if there is no waiter).
- **waitpid**: if EXITED → reap and return exitCode; if not yet → register in `waitQueue`.
- **daemonize**: `DETACH` → resolve waiters, detach the foreground TTY, clear ttyId.
- **REEXEC**: terminate the old worker, spawn a new one with the **same PID/PCB** (`REEXECING` state prevents the cleanup hook).

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

**Request-response correlation** via `requestId` (UUID) + `responseMap` — pure asynchronous RPC, no ordering guaranteed. Many syscalls can be in-flight at once.

**Push events** (kernel → worker, without requestId): `{ type, data }`. Types: `signal`, `ipc_message` (SEND_MSG), `gui_request` (forwarding to gued), `resize`.

### 4.3 Signals

| Signal | Effect |
|---|---|
| **SIGKILL (9)** | Hard kill: `worker.terminate()` immediately |
| **SIGINT (2)** | Graceful: push event, 100ms grace → terminate if not handled. Default exit 130 |
| **SIGTERM (15)** | Graceful: 300ms grace. Default exit 143. Used by SHUTDOWN |
| **SIGSTOP/SIGCONT** | Soft: change `pcb.state` to BLOCKED/RUNNING + event |
| **SIGSEGV** | Sent to the PID that violates GUI window ownership |
| **SIGHUP/USR1/USR2/WINCH** | Generic push events |

**PID 1 is protected** from kill — only `SHUTDOWN`/`REBOOT` (root) are valid. `SHUTDOWN` is staged: SIGTERM broadcast → 5s → SIGKILL survivors → flush network 1s → kill PID 1.

### 4.4 MountManager & PortManager

- **MountManager**: array of `MountPoint {vfsPath, vfs, type, source, readOnly, uid, gid}`. `mount()` sorts descending by path length; `resolve()` → the longest prefix wins → `{vfs, relativePath, mountPoint}`.
- **PortManager**: virtual ports 0–65535 for MQTNL; `allocatePort`, `allocateRandomPort(10000-20000)` for bind(0), `releasePortsByPid()` on process exit (safety net for leaked sockets).

---

## 5. VFS & Device Drivers (HAL)

### 5.1 VFS Layers

```
Aplikasi → syscall OPEN/READ/WRITE
  → MountManager.resolve(path) → backend IVFS
       "/"        → BKFS    (SQLite system.db, persisten)
       "/tmp"     → RamFS   (volatile, in-memory)
       "/mnt/*"   → HostVFS (bridge folder host, anti-escape)
  → path /dev/xxx → kernel.devices[xxx]  (HAL, bypass MountManager)
```

- **IVFS** = a single contract (`ls/mkdir/read/touch/stat/chmod/chown/.../readChunk/writeChunk/getSize`) for all backends — allows "swapping backends" without changing syscalls.
- **BKFS**: a file = a row in the `vnodes` table (parent_id tree). Chunked I/O runs **inside SQL** (`SUBSTR`/`CONCAT`) without pulling the full content — for large files/OTA.
- **HostVFS**: `toHostPath()` + anti-escape checks (Security Violation) — read-only view of a host folder.

### 5.2 Device Model (HAL)

`IDevice`: `read/write/ioctl` + optional `init/open/close` + metadata `uid/gid/mode`.

| `/dev/` | Class | Function |
|---|---|---|
| `stdin` | KeyboardDevice | Keyboard input (cooked/raw) |
| `fb0/stdout/stderr` | TTYDevice | Standard output → active TTY |
| `tty1..tty32` | TTYDevice | Virtual console |
| `null` | NullDevice | Black hole |
| `smqtnl0/1` | SimpleMQTNLDriver | MQTNL network interface |
| `randomdevice` | RandomDevice | Random numbers |
| `mysql` *(experimental)* | MySQLDevice | External DB connection — integration POC, see note below |
| `mcp23017` | MCP23017Device | I2C GPIO |
| `ttyUSB*` | SerialDevice | Auto-detect |
| *(virtual)* | PipeDevice / SocketDevice | Runtime instances (PIPE/SOCKET syscalls), not paths |

**The "everything is a file" key**: the FD table holds `FDEntry {device, context, flags}` → all `IDevice` objects. Regular files are wrapped in `FileSystemDevice`. Pipe refcount via ioctl (`INC_REF`/`DEC_REF`), EOF when `writeRefs==0`.

**Plugin drivers**: the `aux-devices/` folder is scanned at boot; `new DeviceClass()` + the `static autoRegister(kernel)` convention for hardware (MCP23017). `applyDeviceConfigs()` = "udev" from `sysconfig.json`.

> [!NOTE] **About `MySQLDevice` (`/dev/mysql`) — the first transport, not the only one**
> `MySQLDevice` is an external database integration through the device model — it is **not** a real hardware driver, but the **first transport** for DB access (an example of HAL extension).
> **`DbLib` is already implemented** (a UserLib sub-library, following the `lib.fs`/`lib.net` pattern) with **pluggable dual transport**:
> - **Device** (`/dev/mysql`): `DB_*` syscalls (67-69) → kernel → device → `mysql2`
> - **Service daemon** (`mysqld`): `DB_*` syscalls → kernel → Ring 4 daemon → `mysql2`
>
> The kernel routes **dynamically**: if `mysqld` is registered (syscall `DB_SERVICE_REGISTER`=70) → to the daemon; otherwise → to the device (fallback). The daemon replies via `DB_SERVICE_REPLY`=71. Apps only see `db.connect()/query()/disconnect()` — the medium is invisible. The sandbox is safe because `mysql2` is only touched by the kernel or a privileged daemon.

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

The kernel pre-compiles `/lib` → `vfsCache` → sent via `workerData` → the worker `_compile`s from memory. Key trick: the framework module is named `@tsix_Application.js` so relative imports `./x` can be rewritten to `@tsix/x` — a consistent alias cycle. Apps have **two filename identities**: physical (so `require` finds node_modules) vs BKFS (so stack traces are correct).

### 6.3 Sandbox Table

| Layer | Restrictions |
|---|---|
| All apps | `process.exit`/`process.kill` → throw; non-framework `require` blocked |
| Non-privileged apps | `http/fs/crypto` etc. fully blocked |
| Privileged apps | allow-list: `http, ws, path, fs, url, esbuild, crypto, os, bcryptjs` |
| Kernel | `PermissionManager` + `validateArgs` + root-only `SETUID` |

---

## 7. Networking MQTNL

**MQTNL (MQTT Network Layer)** = the TSIX networking protocol. Instead of IP / TCP/IP routing, it uses **MQTT pub/sub as the wire**, plus:

- **Address = node name** (string: `"tsix"`, `"esp32S3"`) — not an IP.
- **Port = application endpoint** (PortManager 0–65535).
- **Topic = `mqtnl@1.0/<dstAddress>`** (JSON) / `mqtnl@1.1/<dstAddress>` (Binary).
- **Packet**: 9-field header + payload; 32KB fragmentation; 30s reassembly TTL; RSA + ChaCha20-Poly1305 encryption.

```
App → socket() → bind(port) → driver.registerHandler(port)
  → sendto(addr, port, data) → driver.send → publish topic
  → MQTT broker → semua node subscribe 'mqtnl@1.x/#'
  → filter dstAddress → reassembly → decrypt → socket.push()
  → recvfrom() → buffer.shift()
```

**Dual protocol**: `MQTNLProtocolJSON` (v1.0, legacy, readable) vs `MQTNLProtocolBinary` (v1.1, compact, no encryption — for byte-exact OTA). The driver detects from the **first magic byte** per srcAddress. `src/common/protocols/` holds the `IMQTNLProtocol` contract — userland **never touches this directly**.

**Syscalls**: `SOCKET=30, BIND=31, SENDTO=32, RECVFROM=33, NETSTAT=34`. There is no `listen/accept` — UserLib emulates them: `listen()` = socket+bind, `accept()` = polling `recv()`.

---

## 8. TTY & Virtual Console

- **TTYManager** manages 1–32 virtual consoles; switching only 1–12, login on 1–6.
- **TTY** (`src/kernel/tty/TTY.ts`): `char[x][y]` buffer, cursor, ANSI subset parser, full re-render.
- **TTYDevice** (`/dev/ttyN`): ioctl clear(1), raw(10), inject input(0x2001), read output(0x2002), window size(4) — lets remote apps (pixelterm) control a TTY.
- **TTY allocation to processes**: via `ttyId` in the `EXEC` syscall — the kernel overrides FD 0/1/2 to `tty{n}`. (Different from PortManager, which is network-only.)
- **Keyboard**: cooked/raw mode, Ctrl+C → SIGINT to fg, Alt+F1-6 → TTY switch, resize → SIGWINCH broadcast.

---

## 9. Userland

### 9.1 Init (PID 1)
No `/etc/inittab` — the logic is hardcoded in `init.ts`: enforce setuid → RSA identity → exec `rc.local` → spawn login per TTY (via `monitorProcess` respawn, anti-crash-loop) → loop.

### 9.2 Login → Shell
`login.ts`: verify `/etc/passwd` + `/etc/shadow` (bcrypt) → `setgroups → setgid → setuid` (POSIX order) → exec `$SHELL` → `tsh.ts`.

### 9.3 Two Application Styles
1. **Class `IProgram`** (majority legacy): `export class main implements IProgram { async execute({fs,shell,std}: OSContext, args) {...} }` — `ls`, `cat`, `ps`, `kill`, `tsh`.
2. **`Program()` wrapper + proxy singletons** (new): `import { Program, std, fs, shell, net } from "@tsix/Application"` — `esp-send`, `dome`, `iot-dashboard`.

### 9.4 Error = "Window"
`std.error()` does 4 things: write syslog → broadcast to parent → print red on TTY → send `GUI_WINDOW_ERROR` to the WM (with `wid`, `pid`, `fileHint` from the stack trace).

### 9.5 DbLib — Database Sub-Library
`DbLib` (`@tsix/DbLib`, `lib.db`) is the fifth UserLib sub-library (after std/fs/shell/net). It wraps the `DB_*` syscalls (67-71) into the `db.connect()/query()/disconnect()` API. **Pluggable transport**: the kernel routes to `/dev/mysql` (device) or `mysqld` (Ring 4 service daemon) dynamically. Apps don't know the medium — exactly like the `lib.fs` pattern, which doesn't care about its VFS backend.

```
App → db.query(sql) → dispatch(DB_QUERY=68)
  → Kernel: mysqld terdaftar?
       YA  → sendEvent(daemon, "db_request") → mysql2 → dbServiceReply → resolve
       TIDAK → /dev/mysql device → mysql2 → resolve
  → App: rows
```

---

## 10. PixelSpace & TDE

> Full details in `PIXELSPACE_DEVELOPER_GUIDE.md`. Architectural summary:

```
Worker (app) → GUI_REQ (61) → Kernel (GUIRegistry auth pid↔wid)
  → DOME daemon (WS broadcast) → Browser (DOM)
Browser → event → DOME → Kernel (SEND_MSG) → Worker (callback)
```

- **Contract**: `GUITypes.ts` (IDOMNode, IGUIPayload, GUIAction, IBrowserEvent, IGUIEventIPC) — the "constitution", don't change it carelessly.
- **GUIRegistry (kernel)** = the single authority over window ownership: `CREATE_WINDOW` = register `wid↔pid`; accessing someone else's window → SIGSEGV; corrupted payload → SIGKILL; process death → window auto-destroy.
- **DOME** = display server (Ring 4 daemon, port 8080): WS relay + DOM primitive producer + **compositor** (titlebar, drag, resize, focus, replay). Monolithic due to drag/resize latency considerations.
- **Emerald** = widget toolkit (`@tsix/emerald`): `Screen`, `Window`, factory functions, connected widgets.
- **Cashew** = component framework (`@tsix/cashew`): OOP/Delphi-style `TForm`/`TButton`/`TEdit`, auto-bind lifecycle, TDialogs & TTimer — a layer above Emerald.
- **Asteracea** = window manager (fullscreen frameless app): taskbar, launcher, login, wallpaper; listens to `GUI_WINDOW_*` lifecycle events via `/etc/asteracea/wm-pid`.

---

## 11. Development Flow

**Dev cycle (host ↔ VFS):**

```
scripts/vfs-bootstrap.ts   host → system.db (transpile TS→JS, chmod, setuid)
scripts/sync-vfs.ts        sync satu file host ↔ VFS
scripts/vfs-pull.ts        system.db → src/root (pull balik)
SYNC_TO_HOST (syscall)     DB → host (app dalam VFS menulis /lib → src/.tsix_sdk)
userlib-update.ts          sinkronkan /lib → src/.tsix_sdk/lib (agar Node.js host bisa require)
```

**Configuration**: `src/sysconfig.json` (database path, workerEntryPath, bootEntry, network interfaces). `tsconfig.json` maps `@tsix/*` → `src/.tsix_sdk/lib/*`, `src/root/lib/*`, `src/mirror/lib/*`.

---

## 12. Design Insights & Gotchas

**Insights (why it was designed this way):**

1. **Syscalls as a mini ABI** — `SyscallCode` (1–66) + `validateArgs` + `requestId` correlation. One mechanism for everything: files, processes, IPC, GUI, networking.
2. **Pure asynchronous RPC** — request/response via UUID; different from Linux synchronous traps.
3. **Staged kill** — SIGINT/SIGTERM = event + grace period, then terminate. Replicates the Unix default (unhandled signal → exit).
4. **Faithful zombies & reparenting** — orphans → PID 1; zombies wait for `waitpid`+`reap`.
5. **UUID identity** — `SET_IDENTITY` allows `SEND_MSG` to a stable name even when the PID changes (well-known services).
6. **GUI auth in the kernel** — `payload.pid` is overridden by the kernel (don't trust userland).
7. **MQTNL = free no-IP** — the MQTT broker is the backbone; by design for IoT (ESP32) without a public IP.
8. **TTY = full PTY emulation** — master-side I/O via ioctl enables remote terminals.

**Gotchas (be careful when contributing):**

⚠️ **Stale compile artifacts**: `src/mirror/lib/*.js` and `src/userland/WorkerEntry.js` can differ from their `.ts` sources. The runtime uses the `.ts` recompiled by the kernel, so committed `.js` files are prone to drift (example: the privileged list in `WorkerEntry.js` doesn't include `dome`).

⚠️ **Docs vs code**: `rc.local.ts` (source) holds the full daemon list, but `rc.local.js` (the executed one) only has 3 daemons. The wiki `Networking-MQTNL.md` mentions the topic `tsix/net/*` but the code uses `mqtnl@1.0/`. **Code is the truth.**

⚠️ **Dead code**: `ExecutableRegistry` is defined but not wired into the Kernel — binary resolution goes through `MountManager.resolve()` + `vfs.read()`.

⚠️ **No `inittab`** — init hardcodes the TTY logins.

⚠️ **Dual NetworkLib** — `UserLib.ts` (inline, `lib.net`) vs `src/mirror/lib/NetworkLib.ts` (legacy, OSContext-based) both target the same syscalls.

⚠️ **Name-based privilege** — app name substring heuristic (fragile; ideally capability-based).

---

## 13. Code Reading Map

### Start here (required)
| File | Role |
|---|---|
| `src/main.ts` | Host entry point + keep-alive |
| `src/kernel/Kernel.ts` | Boot orchestrator for all subsystems |
| `src/common/IPCTypes.ts` | IPC contract (request/response/event) |
| `src/common/SyscallCode.ts` | Syscall ABI (1–66) |
| `src/common/GUITypes.ts` | PixelSpace contract |

### Kernel Core
| File | Role |
|---|---|
| `src/kernel/Scheduler.ts` | PCB, processes, signals, reexec |
| `src/kernel/Syscalls.ts` | ~65 syscall dispatcher + permission |
| `src/kernel/PermissionManager.ts` | rwx checks |
| `src/kernel/MountManager.ts` | Path → backend routing |
| `src/kernel/PortManager.ts` | Network ports |
| `src/kernel/GUIRegistry.ts` | Window authority |

### VFS & Devices
| File | Role |
|---|---|
| `src/vfs/IVFS.ts` | Filesystem contract |
| `src/vfs/BKFS.ts` | Root FS (SQLite) |
| `src/vfs/VFS.ts` / `RamFS.ts` / `HostVFS.ts` | Other backends |
| `src/kernel/devices/IDevice.ts` | HAL contract |
| `src/kernel/devices/FileSystemDevice.ts` | File ↔ IVFS bridge |
| `src/kernel/devices/*.ts` | Drivers: TTY, Keyboard, Pipe, Socket, MQTNL |
| `src/kernel/devices/aux-devices/` | Plugin drivers |

### Worker & Userland
| File | Role |
|---|---|
| `src/userland/WorkerEntry.ts` | Worker bootloader + sandbox + DME |
| `src/mirror/lib/UserLib.ts` | Worker-side "libc" |
| `src/mirror/lib/Application.ts` | Program() v2.1 framework |
| `src/mirror/lib/emerald.ts` | Widget toolkit |
| `src/mirror/bin/init.ts` | PID 1 |

### Networking & Protocols
| File | Role |
|---|---|
| `src/kernel/devices/SimpleMQTNLDriver.ts` | MQTNL driver |
| `src/common/protocols/IMQTNLProtocol.ts` | Protocol contract |
| `src/common/protocols/MQTNLProtocolJSON.ts` | v1.0 |
| `src/common/protocols/MQTNLProtocolBinary.ts` | v1.1 |

### GUI/TDE
| File | Role |
|---|---|
| `src/mirror/bin/dome.ts` | DOME server |
| `src/mirror/bin/dome-client.html` | DOME browser |
| `src/mirror/bin/asteracea.ts` | WM |
| `src/mirror/lib/theme.ts` | Theme |

---

## Appendix: Key data flow summary

**Read a file:**
```
fs.readFile("/etc/passwd")
→ OPEN: resolve → MountManager → BKFS → FileSystemDevice → fd
→ READ: fdTable[fd].device.read() → vfs.read → SQL SELECT
→ CLOSE: ioctl DEC_REF → fdTable[fd] = null
```

**Spawn an app:**
```
shell.exec("/bin/ls")
→ EXEC: resolve → vfs.read(appContent) → permission EXECUTE
→ createProcess → spawnWorker → WorkerEntry → DME app → execute()
```

**Send a message between apps:**
```
shell.send(pidOrUuid, {type, ...})
→ SEND_MSG → kernel resolve pid (atau uuidMap) → sendEvent(pid, "ipc_message", data)
```

**Open a window:**
```
Screen → CREATE_WINDOW → kernel (GUIRegistry.auth) → DOME → WS → browser
```

---

*TSIX Architecture Guide v1.0 — for contributors & developers.*
*This document is alive — update it as the code changes. "Code is the truth."*
