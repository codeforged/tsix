# TSIX Course — Table of Contents & Roadmap

**RFC-TSIX-EDU-002** | Roadmap dokumentasi & kurikulum TSIX (sistem operasi simulasi Node.js/TypeScript).

> **Target pembaca**: kontributor (manusia & AI), hobbyst, penggiat edukasi, profesional.
> **Tujuan**: memahami TSIX dari lapisan terdalam (kernel, syscall, driver) sampai desktop (TDE) — melalui dokumentasi bertahap dari konsep → teknis → snippet.

---

## Cara Membaca

- Dokumen ini adalah **peta perjalanan**. Jangan baca sekaligus — ikuti sesuai minat/prioritas.
- Setiap modul dibuat sebagai file terpisah: `wiki/course/NN-nama.md`.
- **Semua modul 01–24 sudah dibuat** sebagai file course (sinkron dengan `format.md`). Mulai dari **Modul 00** (Overview) — itu peta mental global.
- Status: `✅` = dokumen course lengkap, `🔶` = dokumen ada, sebagian (masih bisa di-breakdown lebih dalam), `⬜` = belum dibuat.

---

## Legenda Status

| Simbol | Arti |
|---|---|
| ✅ | Sudah ada dokumen (tingkat konsep/guide) |
| 🔶 | Sebagian ada — perlu di-breakdown lebih dalam sampai snippet |
| ⬜ | Belum ada — rencana |

---

## Master Table

| Modul | Judul | Insight Singkat | Status |
|---|---|---|---|
| **00** | [Overview & Peta Mental](00-overview.md) | Peta global: ring, boot, kernel, VFS, worker, jaringan, GUI | ✅ |
| **01** | [Filosofi & Gambaran Besar](01-philosophy-big-picture.md) | 3 prinsip inti: syscall=satu-satunya pintu, everything-is-a-file, direct memory execution | ✅ |
| **02** | [Model Ring & Batas Privilege](02-ring-model-privilege.md) | Ring 0-4 adalah konsep; batas nyata = thread + PermissionManager | ✅ |
| **03** | [Boot Sequence](03-boot-sequence.md) | Dari `main.ts` → kernel.boot → PID 1 (init) → login | ✅ |
| **04** | [Proses & Scheduler](04-processes-scheduler.md) | PCB lifecycle: spawn → run → block → exit, zombie, reparent, reexec | ✅ |
| **05** | [Syscall & IPC](05-syscall-ipc.md) | RPC asinkron via `requestId`+`responseMap`; push event | ✅ |
| **06** | [Permission & Security](06-permission-security.md) | rwx + SetUID; root bypass; privilege berbasis nama (rapuh) | ✅ |
| **07** | [Mount & Path Resolution](07-mount-path-resolution.md) | MountManager: prefix terpanjang menang; PathResolver | ✅ |
| **08** | [VFS](08-vfs.md) | IVFS satu kontrak; BKFS/RamFS/HostVFS; chunked I/O dalam SQL | ✅ |
| **09** | [FD Table & File Syscalls](09-fd-table-file-syscalls.md) | "Everything is a file" via IDevice + FileSystemDevice | ✅ |
| **10** | [Device Drivers (HAL)](10-device-drivers-hal.md) | IDevice; plugin aux-devices; udev-style config | ✅ |
| **11** | [Worker Thread & Sandbox](11-worker-thread-sandbox.md) | Bootloader worker, restrictHostAPI, allow-list modul | ✅ |
| **12** | [Module Resolution & DME](12-module-resolution-dme.md) | Direct Memory Execution; hijack Module._load; dual filename | ✅ |
| **13** | [TTY & Virtual Console](13-tty-virtual-console.md) | PTY emulation, raw/cooked, master-side ioctl | ✅ |
| **14** | [Userland: init/login/shell/app](14-userland-init-login-shell.md) | PID 1, monitorProcess, 2 gaya aplikasi | ✅ |
| **15** | [Networking MQTNL](15-networking-mqtnl.md) | Socket flow, PortManager, connectionless UDP-like | ✅ |
| **16** | [Wire Protocol MQTNL](16-wire-protocol-mqtnl.md) | Dual protocol JSON/Binary, magic byte, fragmentasi | ✅ |
| **17** | [PixelSpace Protocol](17-pixelspace-protocol.md) | Kontrak GUITypes, GUI_REQ(61), GUIRegistry auth | ✅ |
| **18** | [DOME Engine (Display Server)](18-dome-engine.md) | Relay + primitive producer + kompositor (latency tradeoff) | ✅ |
| **19** | [Emerald Widget Toolkit](19-emerald-widget-toolkit.md) | Screen/Window/factory/connected widgets | ✅ |
| **20** | [Cashew Component Framework](20-cashew-component-framework.md) | OOP/Delphi-style: TForm/TButton/TEdit; auto-bind lifecycle | ✅ |
| **21** | [Asteracea & TDE](21-asteracea-tde.md) | WM sebagai app PixelSpace; taskbar/launcher/login | ✅ |
| **22** | [State Replay & Persistence](22-state-replay-persistence.md) | windowStates, pruneWindowState, orphan discard | ✅ |
| **23** | [Development Workflow](23-development-workflow.md) | vfs-bootstrap/sync/pull, SDK mirroring, tsconfig paths | ✅ |
| **24** | [Best Practices & Penulisan App](24-best-practices.md) | 2 gaya app, error=window, tema, batching | ✅ |

---

## Bagian I — Fondasi

### Modul 01 — Filosofi & Gambaran Besar
- **Insight**: TSIX bukan VM yang emulasi CPU — ia membangun abstraksi OS di atas runtime Node.js. Tiga prinsip inti: (1) syscall = satu-satunya pintu, (2) everything-is-a-file, (3) direct memory execution.
- **Status**: ✅
- **Referensi**: `00-overview.md` §1, `wiki/Arsitektur-Sistem.md`
- **Kode**: `src/main.ts`, `src/kernel/Kernel.ts`
- **Langkah berikutnya**: Breakdown prinsip inti ke snippet (1 contoh syscall per prinsip).

### Modul 02 — Model Ring & Batas Privilege
- **Insight**: Ring 0-4 adalah dokumentasi/konsep — bukan isolasi hardware. Batas nyata = thread boundary + PermissionManager (uid/gid/mode) + sandbox WorkerEntry.
- **Status**: ✅
- **Referensi**: `00-overview.md` §2, `wiki/ARCHITECTURE_RINGS.md`
- **Kode**: `src/userland/WorkerEntry.ts`, `src/kernel/PermissionManager.ts`

---

## Bagian II — Boot & Kernel Runtime

### Modul 03 — Boot Sequence
- **Insight**: Urutan deterministik: config → mount BKFS → fstab → scheduler → syscall dispatcher → TTY → devices → identity → PID 1 → rc.local → login. Keep-alive 100ms = "hidup/tidaknya sistem".
- **Status**: ✅
- **Referensi**: `00-overview.md` §3, `wiki/boot_sequence.md`
- **Kode**: `src/main.ts`, `src/kernel/Kernel.ts`, `src/mirror/bin/init.ts`, `src/mirror/etc/rc.local.*`
- **Langkah berikutnya**: Trace boot baris per baris → diagram urutan lengkap → snippet kunci.

### Modul 04 — Proses & Scheduler
- **Insight**: Satu worker thread = satu proses (PCB). Multitasking = concurrency Node.js, bukan preemption. Zombie setia menunggu waitpid+reap; orphan auto-reparent ke PID 1; REEXEC = respawn dengan PID sama.
- **Status**: ✅
- **Referensi**: `00-overview.md` §4.1, `wiki/Kernel-dan-Scheduler.md`
- **Kode**: `src/kernel/Scheduler.ts`
- **Langkah berikutnya**: PCB → lifecycle diagram → sinyal → snippet spawn/kill/waitpid.

### Modul 05 — Syscall & IPC
- **Insight**: RPC asinkron murni: requestId (UUID) + responseMap; tidak ada urutan dijamin. Push event (signal/ipc_message/gui_request) via `sendEvent`. Syscall = ABI mini (enum 1-66 + validateArgs).
- **Status**: ✅
- **Referensi**: `00-overview.md` §4.2, `wiki/identity_guid_ipc_walkthrough.md`
- **Kode**: `src/kernel/Syscalls.ts`, `src/common/IPCTypes.ts`, `src/common/SyscallCode.ts`, `src/mirror/lib/UserLib.ts`
- **Langkah berikutnya**: Alur 1 syscall lengkap (print) → snippet dispatch.

### Modul 06 — Permission & Security
- **Insight**: Cek rwx berlapis: root bypass → owner → group → others. SetUID bit (0o4000) = exec sebagai pemilik file. ⚠️ Privilege berbasis substring nama app (rapuh).
- **Status**: ✅
- **Referensi**: `00-overview.md` §4.3, `wiki/Keamanan-dan-Sandboxing.md`
- **Kode**: `src/kernel/PermissionManager.ts`, `src/kernel/Syscalls.ts`
- **Langkah berikutnya**: Tabel matrix izin → snippet check().

### Modul 07 — Mount & Path Resolution
- **Insight**: MountManager resolve dengan prefix terpanjang menang; `fstab.json` mendefinisikan `/tmp`(ramfs), `/mnt/*`(host), `/mnt/sbak`(bkfs).
- **Status**: ✅
- **Referensi**: `00-overview.md` §4.4, `wiki/Virtual-File-System.md`
- **Kode**: `src/kernel/MountManager.ts`, `src/common/PathResolver.ts`

---

## Bagian III — Storage & I/O

### Modul 08 — VFS
- **Insight**: IVFS = satu kontrak, tiga backend (BKFS SQLite / RamFS / HostVFS). Chunked I/O dieksekusi dalam SQL (SUBSTR/CONCAT) — tanpa menarik konten penuh.
- **Status**: ✅
- **Referensi**: `00-overview.md` §5.1, `wiki/Virtual-File-System.md`
- **Kode**: `src/vfs/IVFS.ts`, `src/vfs/BKFS.ts`, `src/vfs/RamFS.ts`, `src/vfs/HostVFS.ts`
- **Langkah berikutnya**: Baca 1 file dari syscall sampai SQL → snippet.

### Modul 09 — FD Table & File Syscalls
- **Insight**: "Everything is a file": FDEntry {device, context, flags} menunjuk ke IDevice apa pun. File biasa dibungkus FileSystemDevice. Pipe refcount via ioctl.
- **Status**: ✅
- **Referensi**: `00-overview.md` §5.2, `wiki/Virtual-File-System.md`
- **Kode**: `src/kernel/devices/FileSystemDevice.ts`, `src/kernel/Syscalls.ts`

### Modul 10 — Device Drivers (HAL)
- **Insight**: IDevice (read/write/ioctl) + plugin aux-devices (autoRegister) + applyDeviceConfigs (udev-style). /dev virtual — bukan vnode.
- **Status**: ✅
- **Referensi**: `00-overview.md` §5.2, `wiki/DEVELOPER_GUIDE_DEVICES.md`, `wiki/mcp23017-registration.md`
- **Kode**: `src/kernel/devices/IDevice.ts`, `src/kernel/devices/*.ts`, `src/kernel/devices/aux-devices/*`
- **Catatan**: `MySQLDevice` (`/dev/mysql`) adalah **transport eksperimental** — bukan driver hardware. Akses DB via **`DbLib`** (sub-library UserLib) dengan **dual transport**: device `/dev/mysql` atau service daemon `mysqld` (Ring 4), di-route dinamis oleh kernel (fallback otomatis). App tidak menyentuh `mysql2` langsung.
- **Langkah berikutnya**: Tutorial menulis driver sendiri.

---

## Bagian IV — Isolasi Proses

### Modul 11 — Worker Thread & Sandbox
- **Insight**: Bootloader WorkerEntry: hijack Module._load → DME → sandbox restrictHostAPI. App non-privileged diblokir dari modul host; app privileged dapat allow-list.
- **Status**: ✅
- **Referensi**: `00-overview.md` §6, `wiki/Keamanan-dan-Sandboxing.md`
- **Kode**: `src/userland/WorkerEntry.ts`

### Modul 12 — Module Resolution & Direct Memory Execution
- **Insight**: Kernel pre-compile /lib → vfsCache → worker _compile dari memori (tanpa hit disk). Trick dummy-filename agar import relatif `./x` → `@tsix/x`. App punya dual identity filename (fisik vs BKFS).
- **Status**: ✅
- **Kode**: `src/userland/WorkerEntry.ts`, `src/kernel/Kernel.ts` (rebuildVFSCache)
- **Langkah berikutnya**: Buat dokumen khusus — ini salah satu bagian paling "ajaib" dan belum terdokumentasi.

---

## Bagian V — Interaksi Manusia

### Modul 13 — TTY & Virtual Console
- **Insight**: TTY = PTY emulation lengkap (buffer, ANSI subset, raw/cooked, master-side ioctl 0x2001/0x2002). Alokasi TTY ke proses via ttyId di EXEC.
- **Status**: ✅
- **Referensi**: `00-overview.md` §8, `wiki/Kernel-dan-Scheduler.md`
- **Kode**: `src/kernel/tty/TTY.ts`, `src/kernel/tty/TTYManager.ts`, `src/kernel/devices/TTYDevice.ts`

### Modul 14 — Userland: init/login/shell/app
- **Insight**: PID 1 = init (tanpa inittab, hardcoded). Login: passwd+shadow(bcrypt) → setgroups→setgid→setuid → shell. Dua gaya app: class IProgram (legacy) vs Program() wrapper (baru).
- **Status**: ✅
- **Referensi**: `00-overview.md` §9, `wiki/Memulai.md`, `wiki/Perintah-Sistem.md`, `wiki/Panduan-Developer.md`
- **Kode**: `src/mirror/bin/init.ts`, `login.ts`, `tsh.ts`

---

## Bagian VI — Jaringan

### Modul 15 — Networking MQTNL
- **Insight**: Alih-alih IP/routing, MQTT pub/sub sebagai wire + nama node sebagai alamat + port virtual. Socket = SocketDevice + PortManager + handler per port (connectionless/UDP-like). listen/accept = emulasi polling.
- **Status**: ✅
- **Referensi**: `00-overview.md` §7, `wiki/Networking-MQTNL.md`
- **Kode**: `src/kernel/devices/SimpleMQTNLDriver.ts`, `src/kernel/devices/SocketDevice.ts`, `src/kernel/PortManager.ts`

### Modul 16 — Wire Protocol MQTNL
- **Insight**: Dual protocol: JSON v1.0 (readable) vs Binary v1.1 (kompak, tanpa enkripsi — untuk OTA byte-exact). Deteksi magic byte per srcAddress. Fragmentasi 32KB + reassembly TTL 30s.
- **Status**: ✅
- **Referensi**: `00-overview.md` §7, `wiki/mqtnl-ota.md`, `wiki/mqtnl_binary_ota.md`
- **Kode**: `src/common/protocols/IMQTNLProtocol.ts`, `MQTNLProtocolJSON.ts`, `MQTNLProtocolBinary.ts`

---

## Bagian VII — GUI & Desktop (koreksi dari "PixelSpace & TDE" tunggal)

> Bagian ini dipecah dari satu modul menjadi lima, karena GUI di TSIX bukan satu lapisan — ia tumpukan: protokol → display server → toolkit → WM → persistence. Masing-masing punya kontrak & tanggung jawab berbeda.

### Modul 17 — PixelSpace Protocol
- **Insight**: Kontrak data (GUITypes = konstitusi), alur data (Worker→Kernel→DOME→Browser), GUI_REQ(61), GUIRegistry sebagai otoritas kepemilikan `wid↔pid`. Sanksi: payload rusak → SIGKILL, akses window orang → SIGSEGV.
- **Status**: ✅
- **Referensi**: `00-overview.md` §10, `wiki/PIXELSPACE_DEVELOPER_GUIDE.md` §1-2, 10
- **Kode**: `src/common/GUITypes.ts`, `src/kernel/GUIRegistry.ts`, `src/kernel/Syscalls.ts`
- **Praktik**: `src/mirror/root/ps-sample1.ts` (raw protocol)

### Modul 18 — DOME Engine (Display Server)
- **Insight**: DOME = relay WebSocket + primitive DOM producer + kompositor (titlebar/drag/resize/focus/replay). Monolitik karena pertimbangan latency drag/resize (kompositor terpisah = ~2-4ms overhead). Ada catatan desain & rencana refactor.
- **Status**: ✅
- **Referensi**: `00-overview.md` §10, `wiki/PIXELSPACE_DEVELOPER_GUIDE.md` §2, 11
- **Kode**: `src/mirror/bin/dome.ts`, `src/mirror/bin/dome-client.html`

### Modul 19 — Emerald Widget Toolkit
- **Insight**: Layer toolkit di atas protokol stabil. Screen wrapper, factory functions, connected widgets self-rendering. ⚠️ Pelajaran penting: mount-time listeners vs app.on() (masalah cloneNode).
- **Status**: ✅
- **Referensi**: `wiki/emerald-in-a-nutshell.md`, `wiki/cashew-in-a-nutshell.md`, `wiki/PIXELSPACE_DEVELOPER_GUIDE.md` §5-7
- **Kode**: `src/mirror/lib/emerald.ts`, `src/mirror/lib/cashew.ts`, `src/mirror/lib/theme.ts`
- **Praktik**: `src/mirror/root/ps-sample2.ts`, `ps-sample3.ts`

### Modul 20 — Cashew Component Framework
- **Insight**: Layer OOP/Delphi-style di atas Emerald (analog VCL di atas GTK). Komponen = class ber-state (TForm/TButton/TEdit) dengan properti & event, bukan fungsi bersarang. `TForm.run()` punya auto-bind lifecycle (bindEventHandler + refresh per komponen). Set `onClickId`/`onInputId` saat build (mount-time — menghindari bug cloneNode). Punya TDialogs, TTimer, dan widget kompleks (TChart, TSevenSegment, TSensorCard, dll).
- **Status**: ✅
- **Referensi**: `wiki/cashew-in-a-nutshell.md`, `wiki/emerald-in-a-nutshell.md`
- **Kode**: `src/mirror/lib/cashew.ts`
- **Praktik**: Buat app pakai TForm + TPanel + TEdit + TListBox

### Modul 21 — Asteracea & TDE (Window Manager)
- **Insight**: WM adalah aplikasi PixelSpace biasa (fullscreen frameless), bukan bagian kernel/DOME. Taskbar (pinned/running/foreign), launcher, login, wallpaper. Listen lifecycle events via `/etc/asteracea/wm-pid`.
- **Status**: ✅
- **Referensi**: `wiki/ASTERACEA_WM.md`, `wiki/PIXELSPACE_DEVELOPER_GUIDE.md` §3, 9
- **Kode**: `src/mirror/bin/asteracea.ts`, `src/mirror/etc/asteracea/*`

### Modul 22 — State Replay & Persistence
- **Insight**: windowStates disimpan DOME → direplay saat browser reconnect (F5). pruneWindowState cegah orphan leak. Browser discard node tanpa parent. findElementById cari di 3 layer.
- **Status**: ✅
- **Referensi**: `wiki/PIXELSPACE_DEVELOPER_GUIDE.md` §11
- **Kode**: `src/mirror/bin/dome.ts` (windowStates), `src/mirror/bin/dome-client.html` (orphan discard)

---

## Bagian VIII — Pengembangan

### Modul 23 — Development Workflow
- **Insight**: Siklus host↔VFS: vfs-bootstrap (host→DB), sync-vfs (satu file), vfs-pull (DB→host), SYNC_TO_HOST (syscall), userlib-update (SDK mirroring). tsconfig paths memetakan @tsix/*.
- **Status**: ✅
- **Referensi**: `00-overview.md` §11, `wiki/Memulai.md`, `wiki/Panduan-Developer.md`
- **Kode**: `scripts/vfs-bootstrap.ts`, `scripts/sync-vfs.ts`, `scripts/vfs-pull.ts`

### Modul 24 — Best Practices & Penulisan App
- **Insight**: Dua gaya app (IProgram vs Program()); error = window (std.error 4 langkah); tema; batching UPDATE_PROPS; Piagam Antigonon (4 aturan GUI).
- **Status**: ✅
- **Referensi**: `00-overview.md` §9, `wiki/DEVELOPER_GUIDE_SCRIPTING-V2.md`, `wiki/Panduan-Developer.md`
- **Praktik**: `src/mirror/root/ps-sample1-3.ts`, `src/mirror/bin/gui-demo.ts`, `file-cruiser.ts`

---

## Lampiran: Peta File → Modul

| File | Modul |
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

## Rencana Kerja Bertahap (Saran Urutan)

> Ini bukan harus ikut urutan — pilih sesuai minat. Tapi urutan ini alur belajar paling natural dari bawah ke atas.

1. ✅ **Modul 00-02** — fondasi
2. 🔶 **Modul 03-06** — boot & kernel (dokumen + snippet ada; bisa di-breakdown lebih dalam)
3. 🔶 **Modul 07-10** — storage & I/O (dokumen + snippet ada)
4. 🔶 **Modul 11-12** — isolasi proses (M12 kini terdokumentasi!)
5. 🔶 **Modul 13-14** — interaksi manusia (dokumen + snippet ada)
6. 🔶 **Modul 15-16** — jaringan (dokumen + snippet ada)
7. ✅ **Modul 17-22** — GUI & desktop (dokumen course lengkap)
8. 🔶 **Modul 23-24** — pengembangan & best practices (dokumen + snippet ada)

---

*Roadmap ini hidup — setiap modul di-breakdown bertahap: konsep → teknis → snippet.*
*TSIX — "Satu-satunya cara memahami sedalam-dalamnya adalah dengan mendokumentasikannya."*
