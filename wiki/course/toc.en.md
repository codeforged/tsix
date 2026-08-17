# TSIX Course — Table of Contents & Roadmap

**RFC-TSIX-EDU-002** | Documentation roadmap & curriculum of TSIX (Node.js/TypeScript simulated operating system).

> **Target readers**: contributors (human & AI), hobbyists, educators, professionals.
> **Goal**: understand TSIX from the deepest layers (kernel, syscall, driver) to the desktop (TDE) — through staged documentation from concept → technical → snippet.

---

## How to Read

- This document is a **roadmap**. Do not read it all at once — follow it according to your interests/priorities.
- Each module is a separate file: `wiki/course/NN-nama.md`.
- **All modules 01–24 have been created** as course files (synchronized with `format.md`). Start from **Module 00** (Overview) — it is the global mental map.
- Status: `✅` = complete course document, `🔶` = document exists, partial (can still be broken down deeper), `⬜` = not yet created.

---

## Status Legend

| Symbol | Meaning |
|---|---|
| ✅ | Document already exists (concept/guide level) |
| 🔶 | Partially exists — needs a deeper breakdown down to snippet |
| ⬜ | Does not exist yet — planned |

---

## Master Table

| Module | Title | Short Insight | Status |
|---|---|---|---|
| **00** | [Overview & Mental Map](00-overview.en.md) | Global map: ring, boot, kernel, VFS, worker, networking, GUI | ✅ |
| **01** | [Philosophy & Big Picture](01-philosophy-big-picture.en.md) | 3 core principles: syscall=the only gateway, everything-is-a-file, direct memory execution | ✅ |
| **02** | [Ring Model & Privilege Boundaries](02-ring-model-privilege.en.md) | Ring 0-4 is a concept; the real boundary = thread + PermissionManager | ✅ |
| **03** | [Boot Sequence](03-boot-sequence.en.md) | From `main.ts` → kernel.boot → PID 1 (init) → login | ✅ |
| **04** | [Processes & Scheduler](04-processes-scheduler.en.md) | PCB lifecycle: spawn → run → block → exit, zombie, reparent, reexec | ✅ |
| **05** | [Syscall & IPC](05-syscall-ipc.en.md) | Asynchronous RPC via `requestId`+`responseMap`; push events | ✅ |
| **06** | [Permission & Security](06-permission-security.en.md) | rwx + SetUID; root bypass; name-based privilege (fragile) | ✅ |
| **07** | [Mount & Path Resolution](07-mount-path-resolution.en.md) | MountManager: longest prefix wins; PathResolver | ✅ |
| **08** | [VFS](08-vfs.en.md) | IVFS single contract; BKFS/RamFS/HostVFS; chunked I/O in SQL | ✅ |
| **09** | [FD Table & File Syscalls](09-fd-table-file-syscalls.en.md) | "Everything is a file" via IDevice + FileSystemDevice | ✅ |
| **10** | [Device Drivers (HAL)](10-device-drivers-hal.en.md) | IDevice; aux-devices plugin; udev-style config | ✅ |
| **11** | [Worker Thread & Sandbox](11-worker-thread-sandbox.en.md) | Bootloader worker, restrictHostAPI, module allow-list | ✅ |
| **12** | [Module Resolution & DME](12-module-resolution-dme.en.md) | Direct Memory Execution; hijack Module._load; dual filename | ✅ |
| **13** | [TTY & Virtual Console](13-tty-virtual-console.en.md) | PTY emulation, raw/cooked, master-side ioctl | ✅ |
| **14** | [Userland: init/login/shell/app](14-userland-init-login-shell.en.md) | PID 1, monitorProcess, 2 app styles | ✅ |
| **15** | [Networking MQTNL](15-networking-mqtnl.en.md) | Socket flow, PortManager, connectionless UDP-like | ✅ |
| **16** | [Wire Protocol MQTNL](16-wire-protocol-mqtnl.en.md) | Dual protocol JSON/Binary, magic byte, fragmentation | ✅ |
| **17** | [PixelSpace Protocol](17-pixelspace-protocol.en.md) | GUITypes contract, GUI_REQ(61), GUIRegistry auth | ✅ |
| **18** | [DOME Engine (Display Server)](18-dome-engine.en.md) | Relay + primitive producer + compositor (latency tradeoff) | ✅ |
| **19** | [Emerald Widget Toolkit](19-emerald-widget-toolkit.en.md) | Screen/Window/factory/connected widgets | ✅ |
| **20** | [Cashew Component Framework](20-cashew-component-framework.en.md) | OOP/Delphi-style: TForm/TButton/TEdit; auto-bind lifecycle | ✅ |
| **21** | [Asteracea & TDE](21-asteracea-tde.en.md) | WM as a PixelSpace app; taskbar/launcher/login | ✅ |
| **22** | [State Replay & Persistence](22-state-replay-persistence.en.md) | windowStates, pruneWindowState, orphan discard | ✅ |
| **23** | [Development Workflow](23-development-workflow.en.md) | vfs-bootstrap/sync/pull, SDK mirroring, tsconfig paths | ✅ |
| **24** | [Best Practices & Writing Apps](24-best-practices.en.md) | 2 app styles, error=window, theme, batching | ✅ |

---

## Part I — Foundation

### Module 01 — Philosophy & Big Picture
- **Insight**: TSIX is not a VM that emulates a CPU — it builds an OS abstraction on top of the Node.js runtime. Five core principles: (1) everything-is-a-file, (2) distributed-by-design, (3) small-sharp-tools, (4) security-via-simplicity, (5) unix-fidelity.
- **Status**: ✅
- **References**: `00-overview.md` §1, `wiki/Arsitektur-Sistem.md`
- **Code**: `src/main.ts`, `src/kernel/Kernel.ts`
- **Next steps**: Break down the core principles into snippets (1 syscall example per principle).

### Module 02 — Ring Model & Privilege Boundaries
- **Insight**: Ring 0-4 is documentation/concept — not hardware isolation. The real boundary = thread boundary + PermissionManager (uid/gid/mode) + WorkerEntry sandbox.
- **Status**: ✅
- **References**: `00-overview.md` §2, `wiki/ARCHITECTURE_RINGS.md`
- **Code**: `src/userland/WorkerEntry.ts`, `src/kernel/PermissionManager.ts`

---

## Part II — Boot & Kernel Runtime

### Module 03 — Boot Sequence
- **Insight**: Deterministic sequence: config → mount BKFS → fstab → scheduler → syscall dispatcher → TTY → devices → identity → PID 1 → rc.local → login. 100ms keep-alive = "system alive/dead".
- **Status**: ✅
- **References**: `00-overview.md` §3, `wiki/boot_sequence.md`
- **Code**: `src/main.ts`, `src/kernel/Kernel.ts`, `src/mirror/bin/init.ts`, `src/mirror/etc/rc.local.*`
- **Next steps**: Trace boot line by line → complete sequence diagram → key snippets.

### Module 04 — Processes & Scheduler
- **Insight**: One worker thread = one process (PCB). Multitasking = Node.js concurrency, not preemption. Zombies faithfully wait for waitpid+reap; orphans auto-reparent to PID 1; REEXEC = respawn with the same PID.
- **Status**: ✅
- **References**: `00-overview.md` §4.1, `wiki/Kernel-dan-Scheduler.md`
- **Code**: `src/kernel/Scheduler.ts`
- **Next steps**: PCB → lifecycle diagram → signals → spawn/kill/waitpid snippets.

### Module 05 — Syscall & IPC
- **Insight**: Purely asynchronous RPC: requestId (UUID) + responseMap; no ordering is guaranteed. Push events (signal/ipc_message/gui_request) via `sendEvent`. Syscall = a mini ABI (enum 1-66 + validateArgs).
- **Status**: ✅
- **References**: `00-overview.md` §4.2, `wiki/identity_guid_ipc_walkthrough.md`
- **Code**: `src/kernel/Syscalls.ts`, `src/common/IPCTypes.ts`, `src/common/SyscallCode.ts`, `src/mirror/lib/UserLib.ts`
- **Next steps**: Full flow of 1 syscall (print) → dispatch snippet.

### Module 06 — Permission & Security
- **Insight**: Layered rwx checks: root bypass → owner → group → others. SetUID bit (0o4000) = exec as the file owner. ⚠️ Privilege based on app name substring (fragile).
- **Status**: ✅
- **References**: `00-overview.md` §4.3, `wiki/Keamanan-dan-Sandboxing.md`
- **Code**: `src/kernel/PermissionManager.ts`, `src/kernel/Syscalls.ts`
- **Next steps**: Permission matrix table → check() snippet.

### Module 07 — Mount & Path Resolution
- **Insight**: MountManager resolves with longest prefix wins; `fstab.json` defines `/tmp`(ramfs), `/mnt/*`(host), `/mnt/sbak`(bkfs).
- **Status**: ✅
- **References**: `00-overview.md` §4.4, `wiki/Virtual-File-System.md`
- **Code**: `src/kernel/MountManager.ts`, `src/common/PathResolver.ts`

---

## Part III — Storage & I/O

### Module 08 — VFS
- **Insight**: IVFS = one contract, three backends (BKFS SQLite / RamFS / HostVFS). Chunked I/O is executed in SQL (SUBSTR/CONCAT) — without pulling full content.
- **Status**: ✅
- **References**: `00-overview.md` §5.1, `wiki/Virtual-File-System.md`
- **Code**: `src/vfs/IVFS.ts`, `src/vfs/BKFS.ts`, `src/vfs/RamFS.ts`, `src/vfs/HostVFS.ts`
- **Next steps**: Read 1 file from syscall down to SQL → snippet.

### Module 09 — FD Table & File Syscalls
- **Insight**: "Everything is a file": FDEntry {device, context, flags} points to any IDevice. Regular files are wrapped in FileSystemDevice. Pipe refcount via ioctl.
- **Status**: ✅
- **References**: `00-overview.md` §5.2, `wiki/Virtual-File-System.md`
- **Code**: `src/kernel/devices/FileSystemDevice.ts`, `src/kernel/Syscalls.ts`

### Module 10 — Device Drivers (HAL)
- **Insight**: IDevice (read/write/ioctl) + aux-devices plugin (autoRegister) + applyDeviceConfigs (udev-style). /dev is virtual — not a vnode.
- **Status**: ✅
- **References**: `00-overview.md` §5.2, `wiki/DEVELOPER_GUIDE_DEVICES.md`, `wiki/mcp23017-registration.md`
- **Code**: `src/kernel/devices/IDevice.ts`, `src/kernel/devices/*.ts`, `src/kernel/devices/aux-devices/*`
- **Note**: `MySQLDevice` (`/dev/mysql`) is an **experimental transport** — not a hardware driver. DB access goes through **`DbLib`** (a UserLib sub-library) with **dual transport**: the `/dev/mysql` device or the `mysqld` daemon service (Ring 4), dynamically routed by the kernel (automatic fallback). Apps never touch `mysql2` directly.
- **Next steps**: Tutorial for writing your own driver.

---

## Part IV — Process Isolation

### Module 11 — Worker Thread & Sandbox
- **Insight**: Bootloader WorkerEntry: hijack Module._load → DME → restrictHostAPI sandbox. Non-privileged apps are blocked from host modules; privileged apps get an allow-list.
- **Status**: ✅
- **References**: `00-overview.md` §6, `wiki/Keamanan-dan-Sandboxing.md`
- **Code**: `src/userland/WorkerEntry.ts`

### Module 12 — Module Resolution & Direct Memory Execution
- **Insight**: Kernel pre-compiles /lib → vfsCache → worker _compile from memory (no disk hits). Dummy-filename trick so relative imports `./x` → `@tsix/x`. Apps have a dual identity filename (physical vs BKFS).
- **Status**: ✅
- **Code**: `src/userland/WorkerEntry.ts`, `src/kernel/Kernel.ts` (rebuildVFSCache)
- **Next steps**: Create a dedicated document — this is one of the most "magical" and still undocumented parts.

---

## Part V — Human Interaction

### Module 13 — TTY & Virtual Console
- **Insight**: TTY = full PTY emulation (buffer, ANSI subset, raw/cooked, master-side ioctl 0x2001/0x2002). TTY allocation to processes via ttyId in EXEC.
- **Status**: ✅
- **References**: `00-overview.md` §8, `wiki/Kernel-dan-Scheduler.md`
- **Code**: `src/kernel/tty/TTY.ts`, `src/kernel/tty/TTYManager.ts`, `src/kernel/devices/TTYDevice.ts`

### Module 14 — Userland: init/login/shell/app
- **Insight**: PID 1 = init (no inittab, hardcoded). Login: passwd+shadow(bcrypt) → setgroups→setgid→setuid → shell. Two app styles: IProgram class (legacy) vs Program() wrapper (new).
- **Status**: ✅
- **References**: `00-overview.md` §9, `wiki/Memulai.md`, `wiki/Perintah-Sistem.md`, `wiki/Panduan-Developer.md`
- **Code**: `src/mirror/bin/init.ts`, `login.ts`, `tsh.ts`

---

## Part VI — Networking

### Module 15 — Networking MQTNL
- **Insight**: Instead of IP/routing, MQTT pub/sub as the wire + node name as the address + virtual ports. Socket = SocketDevice + PortManager + handler per port (connectionless/UDP-like). listen/accept = polling emulation.
- **Status**: ✅
- **References**: `00-overview.md` §7, `wiki/Networking-MQTNL.md`
- **Code**: `src/kernel/devices/SimpleMQTNLDriver.ts`, `src/kernel/devices/SocketDevice.ts`, `src/kernel/PortManager.ts`

### Module 16 — Wire Protocol MQTNL
- **Insight**: Dual protocol: JSON v1.0 (readable) vs Binary v1.1 (compact, no encryption — for byte-exact OTA). Magic byte detection per srcAddress. 32KB fragmentation + 30s reassembly TTL.
- **Status**: ✅
- **References**: `00-overview.md` §7, `wiki/mqtnl-ota.md`, `wiki/mqtnl_binary_ota.md`
- **Code**: `src/common/protocols/IMQTNLProtocol.ts`, `MQTNLProtocolJSON.ts`, `MQTNLProtocolBinary.ts`

---

## Part VII — GUI & Desktop (correction from a single "PixelSpace & TDE")

> This part was split from one module into five, because the GUI in TSIX is not a single layer — it is a stack: protocol → display server → toolkit → WM → persistence. Each has its own contract & responsibilities.

### Module 17 — PixelSpace Protocol
- **Insight**: Data contract (GUITypes = the constitution), data flow (Worker→Kernel→DOME→Browser), GUI_REQ(61), GUIRegistry as the `wid↔pid` ownership authority. Penalties: corrupt payload → SIGKILL, accessing another's window → SIGSEGV.
- **Status**: ✅
- **References**: `00-overview.md` §10, `wiki/PIXELSPACE_DEVELOPER_GUIDE.md` §1-2, 10
- **Code**: `src/common/GUITypes.ts`, `src/kernel/GUIRegistry.ts`, `src/kernel/Syscalls.ts`
- **Practice**: `src/mirror/root/ps-sample1.ts` (raw protocol)

### Module 18 — DOME Engine (Display Server)
- **Insight**: DOME = WebSocket relay + primitive DOM producer + compositor (titlebar/drag/resize/focus/replay). Monolithic due to drag/resize latency considerations (separate compositor = ~2-4ms overhead). There are design notes & a refactor plan.
- **Status**: ✅
- **References**: `00-overview.md` §10, `wiki/PIXELSPACE_DEVELOPER_GUIDE.md` §2, 11
- **Code**: `src/mirror/bin/dome.ts`, `src/mirror/bin/dome-client.html`

### Module 19 — Emerald Widget Toolkit
- **Insight**: Toolkit layer on top of a stable protocol. Screen wrapper, factory functions, connected widgets self-rendering. ⚠️ Important lesson: mount-time listeners vs app.on() (cloneNode issue).
- **Status**: ✅
- **References**: `wiki/emerald-in-a-nutshell.md`, `wiki/cashew-in-a-nutshell.md`, `wiki/PIXELSPACE_DEVELOPER_GUIDE.md` §5-7
- **Code**: `src/mirror/lib/emerald.ts`, `src/mirror/lib/cashew.ts`, `src/mirror/lib/theme.ts`
- **Practice**: `src/mirror/root/ps-sample2.ts`, `ps-sample3.ts`

### Module 20 — Cashew Component Framework
- **Insight**: OOP/Delphi-style layer on top of Emerald (analogous to VCL over GTK). Components = stateful classes (TForm/TButton/TEdit) with properties & events, not nested functions. `TForm.run()` has an auto-bind lifecycle (bindEventHandler + refresh per component). Set `onClickId`/`onInputId` at build time (mount-time — avoids the cloneNode bug). Has TDialogs, TTimer, and complex widgets (TChart, TSevenSegment, TSensorCard, etc.).
- **Status**: ✅
- **References**: `wiki/cashew-in-a-nutshell.md`, `wiki/emerald-in-a-nutshell.md`
- **Code**: `src/mirror/lib/cashew.ts`
- **Practice**: Build an app using TForm + TPanel + TEdit + TListBox

### Module 21 — Asteracea & TDE (Window Manager)
- **Insight**: The WM is an ordinary PixelSpace app (fullscreen frameless), not part of the kernel/DOME. Taskbar (pinned/running/foreign), launcher, login, wallpaper. Listen for lifecycle events via `/etc/asteracea/wm-pid`.
- **Status**: ✅
- **References**: `wiki/ASTERACEA_WM.md`, `wiki/PIXELSPACE_DEVELOPER_GUIDE.md` §3, 9
- **Code**: `src/mirror/bin/asteracea.ts`, `src/mirror/etc/asteracea/*`

### Module 22 — State Replay & Persistence
- **Insight**: windowStates saved by DOME → replayed on browser reconnect (F5). pruneWindowState prevents orphan leaks. Browser discards nodes without a parent. findElementById searches 3 layers.
- **Status**: ✅
- **References**: `wiki/PIXELSPACE_DEVELOPER_GUIDE.md` §11
- **Code**: `src/mirror/bin/dome.ts` (windowStates), `src/mirror/bin/dome-client.html` (orphan discard)

---

## Part VIII — Development

### Module 23 — Development Workflow
- **Insight**: Host↔VFS cycle: vfs-bootstrap (host→DB), sync-vfs (single file), vfs-pull (DB→host), SYNC_TO_HOST (syscall), userlib-update (SDK mirroring). tsconfig paths map @tsix/*.
- **Status**: ✅
- **References**: `00-overview.md` §11, `wiki/Memulai.md`, `wiki/Panduan-Developer.md`
- **Code**: `scripts/vfs-bootstrap.ts`, `scripts/sync-vfs.ts`, `scripts/vfs-pull.ts`

### Module 24 — Best Practices & Writing Apps
- **Insight**: Two app styles (IProgram vs Program()); error = window (std.error 4 steps); theme; UPDATE_PROPS batching; Antigonon Charter (4 GUI rules).
- **Status**: ✅
- **References**: `00-overview.md` §9, `wiki/DEVELOPER_GUIDE_SCRIPTING-V2.md`, `wiki/Panduan-Developer.md`
- **Practice**: `src/mirror/root/ps-sample1-3.ts`, `src/mirror/bin/gui-demo.ts`, `file-cruiser.ts`

---

## Appendix: File → Module Map

| File | Module |
|---|---|
| `src/main.ts` | 01, 03 |
| `src/kernel/Kernel.ts` | 01, 03, 12 |
| `src/kernel/Scheduler.ts` | 04 |
| `src/kernel/Syscalls.ts` | 05, 06, 09, 17 |
| `src/kernel/PermissionManager.ts` | 06 |
| `src/kernel/MountManager.ts` / `PathResolver.ts` | 07 |
| `src/kernel/PortManager.ts` | 15 |
| `src/kernel/GUIRegistry.ts` | 17 |
| `src/vfs/*` | 08, 09 |
| `src/kernel/devices/*` | 10, 13, 15, 16 |
| `src/mirror/lib/DbLib.ts` / `src/mirror/etc/mysqld/mysqld.ts` / `db-demo.ts` | 10 (dual transport DB) |
| `src/userland/WorkerEntry.ts` | 11, 12 |
| `src/mirror/lib/UserLib.ts` / `Application.ts` | 05, 23 |
| `src/mirror/lib/emerald.ts` / `theme.ts` | 19 |
| `src/mirror/lib/cashew.ts` | 20 |
| `src/mirror/bin/dome.ts` / `dome-client.html` | 18, 21 |
| `src/mirror/bin/asteracea.ts` | 20 |
| `src/common/GUITypes.ts` | 17 |
| `src/common/protocols/*` | 16 |
| `scripts/vfs-*.ts` | 22 |

---

## Staged Work Plan (Suggested Order)

> You do not have to follow this order — choose according to your interests. But this order is the most natural bottom-up learning path.

1. ✅ **Modules 00-02** — foundation
2. 🔶 **Modules 03-06** — boot & kernel (documents + snippets exist; can be broken down deeper)
3. 🔶 **Modules 07-10** — storage & I/O (documents + snippets exist)
4. 🔶 **Modules 11-12** — process isolation (M12 is now documented!)
5. 🔶 **Modules 13-14** — human interaction (documents + snippets exist)
6. 🔶 **Modules 15-16** — networking (documents + snippets exist)
7. ✅ **Modules 17-22** — GUI & desktop (complete course documents)
8. 🔶 **Modules 23-24** — development & best practices (documents + snippets exist)

---

*This roadmap is alive — each module is broken down in stages: concept → technical → snippet.*
*TSIX — "The only way to understand it deeply is to document it."*
