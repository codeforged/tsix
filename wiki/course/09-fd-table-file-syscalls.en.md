---
module: 09
title: FD Table & File Syscalls
part: III
partTitle: Storage & I/O
status: done
lang: en
rfc: RFC-TSIX-EDU-002
audience: all
---

# FD Table & File Syscalls

**RFC-TSIX-EDU-002** | Ninth module of the TSIX curriculum. Understand "everything is a file" at the FD table level: how `open` → `FDEntry` → device, and how a regular file is wrapped by `FileSystemDevice`.

> In TSIX, **a file descriptor is not an index into a file array** — it is an index into an `FDEntry { device, context, flags }` that points to any `IDevice` object. A regular file, TTY, pipe, socket — all of them are `IDevice`.

---

## Learning Objectives

- [ ] Explain the structure of `FDEntry { device, context, flags }` and `fdTable`
- [ ] Explain the `OPEN` flow: resolve path → check permission → pick device → `fdTable.push`
- [ ] Explain how `READ`/`WRITE` dispatch to `entry.device`
- [ ] Explain "everything is a file": regular files vs `/dev/*`
- [ ] Explain pipe refcount via ioctl (`INC_REF`/`DEC_REF`)
- [ ] Explain FD cleanup when a process exits

---

## Core Concepts

### FDEntry

```ts
export interface FDEntry {
    device: IDevice;   // objek device nyata
    context: any;      // state per-FD
    flags?: string;    // "r" | "w" | "a" | "+"
}
```

`fdTable` lives in the PCB — each process has an array of `(FDEntry | null)[]`. FD 0/1/2 (stdin/stdout/stderr) are filled at spawn from the TTY device.

### Everything is a File

| Opened item | Device in the FD table |
|---|---|
| Regular file (`/etc/passwd`) | `FileSystemDevice` (wraps IVFS) |
| `/dev/tty1` | `TTYDevice` |
| `/dev/null` | `NullDevice` |
| Pipe (PIPE syscall) | `PipeDevice` |
| Socket (SOCKET syscall) | `SocketDevice` |

There is no *type* difference between a file and a device in the FD table — both are merely objects that implement `IDevice` (`read()`, `write()`, `ioctl()`). Opening a regular file → the kernel creates a new `FileSystemDevice` that wraps the `IVFS` backend returned by `mountManager.resolve()`. Opening `/dev/*` → the kernel takes the device already registered in `kernel.devices` (TTY, null, stdin, etc.). This is the heart of "everything is a file": `read`/`write` are always polymorphic to `entry.device`.

### Standard FDs (0/1/2)

When a process is created (`Scheduler.createProcess`) or on `EXEC`, the kernel fills the first three FDs from the stdio devices. The default at `EXEC` is the global device `kernel.devices.stdin`/`stdout`/`stderr`; if the process runs on a TTY (`pcb.ttyId`), all three are pointed at the same `tty{N}`.

| FD | Name | flags | Device (common) |
|---|---|---|---|
| `0` | stdin | `"r"` | `TTYDevice` (`ttyN`) when the process has a TTY; fallback `KeyboardDevice` (`kernel.devices.stdin`) |
| `1` | stdout | `"w"` | `TTYDevice` (`kernel.devices.stdout` = `tty1`) |
| `2` | stderr | `"w"` | `TTYDevice` (`kernel.devices.stderr` = `tty1`) |

> [!NOTE]
> The `flags` of FD 0 is `"r"` (read), while FD 1 and 2 are `"w"` (write). This is what lets `WRITE` refuse to write to an FD that was not opened for writing ("Bad File Descriptor").

### Pipe refcount

A pipe has a refcount on both the read and write sides. EOF occurs when `writeRefs == 0`. The kernel manages the refcount through the device `ioctl` — command numbers:

| ioctl cmd | Meaning | Called from |
|---|---|---|
| `10` | `INC_READ_REF` | `OPEN` when flags contain `"r"` |
| `20` | `INC_WRITE_REF` | `OPEN` when flags contain `"w"`/`"a"` |
| `11` | `DEC_READ_REF` | `CLOSE` when flags contain `"r"` |
| `21` | `DEC_WRITE_REF` | `CLOSE` when flags contain `"w"`/`"a"` |

Every `open` increments, every `close` decrements. `FileSystemDevice` does not use refcount — its `ioctl()` returns `-1` (no-op). Refcount only matters for real devices such as pipes, TTYs, and serial.

## Flow / How It Works

### OPEN: from path to FD

Steps in the `SyscallCode.OPEN` case (`src/kernel/Syscalls.ts`):

1. **Resolve path** — `PathResolver.resolve(pcb.cwd, args)` converts the path (relative/absolute) to an absolute one.
2. **Resolve VFS** — `mountManager.resolve(absolutePath)` → `{ vfs, relativePath }`. The backend is chosen from the longest mount prefix (`/` → BKFS, `/tmp` → RamFS, `/mnt/*` → HostVFS).
3. **Check permission** — `vfs.stat(relativePath)` to get the node. `requiredPerm` = `WRITE` if flags contain `"w"`/`"+"`, otherwise `READ`.
   - Node exists → `satpam.check(pcb, node, requiredPerm)`; failure → `Permission Denied`.
   - Node does not exist → flags `"r"` → `File not found`; flags `"w"`/`"+"` → check the parent directory's permission, then `vfs.touch` creates the file (mode `0644`), and truncates when flags are `"w"` without `"a"`.
4. **Pick device**:
   - Path `/dev/*` → look up `kernel.devices[devName]` (aliases: `screen`/`console`/`stdout`/`fb0` and `keyboard`/`stdin`; `tty` → `tty{pcb.ttyId}`). The refcount is incremented via `ioctl` `INC_*_REF`, then `device.open()` is called lazily.
   - Regular path → `new FileSystemDevice(vfs)` + `setPath(relativePath, flags)`.
5. **Insert into the table** — `const fd = pcb.fdTable.length; pcb.fdTable.push({ device, context, flags }); return fd;`. `fd` is a new index in the array, not a free number. For a regular file, `context` is set to `relativePath`; for `/dev/*`, `context` is set to the absolute path.

### READ / WRITE: dispatch to `entry.device`

`READ` and `WRITE` do not care about the device type. They take `entry = pcb.fdTable[fd]`, then call the polymorphic method on `entry.device`:

- `READ(fd)` → `entry.device.read()` — a TTY reads its buffer, a file reads from the VFS.
- `WRITE(fd, content)` → check `entry.flags` (must contain `"w"`/`"a"`/`"+"`, otherwise `Bad File Descriptor`), then `entry.device.write(content)`.

There is a special IPC route: `WRITE` with `{ pid, content }` writes to the target process's `fdTable[0]` (TTY → injection via `ioctl(0x2001)`); `READ` with `{ pid }` reads from the target process's `fdTable[1]` (TTY → `ioctl(0x2002)`).

### Walkthrough: opening `/etc/passwd`

Trace a shell process that executes `cat /etc/passwd`:

```
cat /etc/passwd
     |
     | OPEN("/etc/passwd", "r")
     v
+------------------------------------------------------------+
| case OPEN (kernel)                                          |
|  1. PathResolver.resolve(cwd, path)                         |
|       -> "/etc/passwd"  (absolut)                          |
|  2. mountManager.resolve("/etc/passwd")                     |
|       -> { vfs: BKFS, relativePath: "etc/passwd" }          |
|  3. vfs.stat("etc/passwd") -> node ada                      |
|     satpam.check(pcb, node, READ) -> lolos                  |
|  4. const fsDriver = new FileSystemDevice(BKFS)             |
|     fsDriver.setPath("etc/passwd", "r")                     |
|  5. const fd = pcb.fdTable.length        // misal = 3        |
|     pcb.fdTable.push({ device: fsDriver,                    |
|                       context: "etc/passwd",                |
|                       flags: "r" })                         |
|  return fd;                          // fd = 3               |
+------------------------------------------------------------+
     |
     | fd = 3, lalu READ(3)
     v
+------------------------------------------------------------+
| case READ                                                   |
|  const entry = pcb.fdTable[3];                              |
|  return entry.device.read();                                |
|      -> FileSystemDevice.read()                             |
|         -> vfs.read("etc/passwd")   // BKFS: SQL SELECT     |
+------------------------------------------------------------+
     |
     | isi file /etc/passwd
     v
     | CLOSE(3)
     v
+------------------------------------------------------------+
| case CLOSE                                                  |
|  device.ioctl(11 / 21)  // DEC_REF; FileSystemDevice no-op  |
|  pcb.fdTable[3] = null;                                     |
+------------------------------------------------------------+
```

> [!NOTE]
> `FileSystemDevice` returns `null` when `currentPath` is empty and `false` when writing without a path — a "fail safe" before touching the VFS.

### Cleanup on exit

The kernel installs a global exit hook in the `SyscallHandler` constructor (`setOnProcessExit`). When a process EXITED:

1. **Close all FDs** — iterate `pcb.fdTable`; every entry that is not `null` is `CLOSE`-dispatched (triggering `DEC_*_REF` on devices that support it). Errors during mass cleanup are ignored.
2. **Port safety net** — `portManager.releasePortsByPid(pid)` releases all MQTNL ports owned by the process (in anticipation of sockets that escaped `CLOSE`).
3. **GUI cleanup** — `guiRegistry.destroyAllForPid(pid)` destroys all windows owned by the process and sends `GUI_REQ DESTROY_WINDOW` to the GUI daemon (`gued`).

---

## Source Code

| File | Role |
|---|---|
| `src/kernel/Scheduler.ts` | Defines `FDEntry` + `fdTable` in the PCB |
| `src/kernel/devices/FileSystemDevice.ts` | File ↔ IVFS bridge |
| `src/kernel/devices/PipeDevice.ts` | Pipe + refcount |
| `src/kernel/Syscalls.ts` | OPEN/READ/WRITE/CLOSE/PIPE + cleanup |

---

## Snippets (code level)

### OPEN — resolve, permission, pick device, fdTable.push

```ts
case SyscallCode.OPEN: {
  // ... PathResolver.resolve + mountManager.resolve (lihat "Alur / Cara Kerja") ...

  // 1. Permission Check
  const requiredPerm =
    flags.includes("w") || flags.includes("+")
      ? Permission.WRITE
      : Permission.READ;

  // Existence Check
  const node = vfs.stat(relativePath);

  if (node) {
    // Check File Permission
    if (!this.satpam.check(pcb, node, requiredPerm)) {
      throw new Error(
        `Permission Denied: Cannot open ${absoluteOpenPath} for ${Permission[requiredPerm]}`,
      );
    }
  } else {
    // ... "File not found", cek parent-dir, touch buat file, truncate ...
  }

  // ... branch /dev/* -> kernel.devices[devName] + INC_REF + lazy open ...

  // File biasa -> bungkus FileSystemDevice
  const fsDriver = new FileSystemDevice(vfs);
  fsDriver.setPath(relativePath, flags);

  // TRUNCATE: If opened with 'w' (and not 'a'), we must clear content first
  if (
    flags &&
    flags.includes("w") &&
    !flags.includes("a") &&
    !flags.includes("+")
  ) {
    vfs.touch(relativePath, "", pcb.uid, pcb.gid, 420);
  }

  const fd = pcb.fdTable.length;
  pcb.fdTable.push({ device: fsDriver, context: relativePath, flags });
  return fd;
}
```

> [!IMPORTANT]
> Note two details: (1) `fd` is `pcb.fdTable.length` — a new index at the end of the array, not a free number; (2) for a regular file `context` is set to `relativePath`, while for `/dev/*` it is set to the absolute path. `context` is freely interpreted by the device.

### READ / WRITE — dispatch to `entry.device`

```ts
// WRITE
case SyscallCode.WRITE: {
  // ... route khusus pid -> targetPcb.fdTable[0] (TTY: ioctl(0x2001)) ...

  const { fd, content } = args;
  const entry = pcb.fdTable[fd];
  if (!entry) return false;

  // Check if FD was opened with Write permission
  const flags = entry.flags || "r";
  if (
    !flags.includes("w") &&
    !flags.includes("a") &&
    !flags.includes("+")
  ) {
    throw new Error("Bad File Descriptor: Not open for writing");
  }

  return entry.device.write(content);
}

// READ
case SyscallCode.READ: {
  // ... route khusus pid -> targetPcb.fdTable[1] (TTY: ioctl(0x2002)) ...

  const fd = args as number;
  const entry = pcb.fdTable[fd];
  if (!entry) throw new Error(`FD NOT FOUND: ${fd}`);
  return entry.device.read();
}
```

### FileSystemDevice — file ↔ VFS bridge

```ts
export class FileSystemDevice implements IDevice {
    name = "FileSystem";
    private vfs: IVFS;
    private currentPath: string = "";
    private flags: string = "r";

    constructor(vfs: IVFS) {
        this.vfs = vfs;
    }

    public setPath(path: string, flags: string = "r") {
        this.currentPath = path;
        this.flags = flags;
    }

    read() {
        if (!this.currentPath) return null;
        return this.vfs.read(this.currentPath);
    }

    write(data: any) {
        if (!this.currentPath) return false;

        const isAppend = this.flags.includes("a");
        const isWrite = this.flags.includes("w");
        const isUpdate = this.flags.includes("+");

        if (isAppend || isWrite || isUpdate) {
            return this.vfs.append(this.currentPath, data);
        }

        // Fallback: Default Overwrite (Backward Compatibility)
        return this.vfs.touch(this.currentPath, data);
    }

    ioctl(cmd: number, arg: any) { return -1; }
}
```

### FD cleanup on process exit

```ts
this.scheduler.setOnProcessExit(async (pid) => {
  const pcb = this.scheduler.getProcess(pid);
  if (pcb) {
    // Tutup semua FD — trigger DEC_REF via dispatch CLOSE
    for (let fd = 0; fd < pcb.fdTable.length; fd++) {
      if (pcb.fdTable[fd]) {
        try {
          await this.dispatch(pid, SyscallCode.CLOSE, fd);
        } catch (e) {
          // Ignore errors during mass cleanup
        }
      }
    }

    // === Force release semua port milik PID ini ===
    try {
      this.kernel.getPortManager().releasePortsByPid(pid);
    } catch (_) {}

    // --- GUI Cleanup ---
    const guiRegistry = this.kernel.guiRegistry;
    if (guiRegistry) {
      const ownedWindows = guiRegistry.destroyAllForPid(pid);
      if (ownedWindows.length > 0) {
        const guedPid = guiRegistry.getDaemonPid();
        if (guedPid !== null) {
          for (const wid of ownedWindows) {
            this.scheduler.sendEvent(guedPid, "gui_request", {
              syscall: "GUI_REQ",
              pid,
              wid,
              action: GUIAction.DESTROY_WINDOW,
            } as IGUIPayload);
          }
        }
      }
    }
  }
});
```

---

## Exercises / Practice

1. Read `src/kernel/devices/PipeDevice.ts` — explain when a pipe returns EOF (connect it to `writeRefs` and the `DEC_WRITE_REF` ioctl).
2. From the shell, `echo hello > /tmp/x` then `cat /tmp/x` — trace the OPEN/WRITE/READ/CLOSE syscalls in the log. Note the fd returned by `OPEN` and the device behind it.
3. Read `src/kernel/Syscalls.ts` — find the `OPEN` implementation and how it picks the device (`FileSystemDevice` vs `/dev/*`).
4. Read `createProcess` in `src/kernel/Scheduler.ts` — explain how fds 0/1/2 (stdin/stdout/stderr) are filled from `options.fds`.

---

## References

- `wiki/Virtual-File-System.md` — §device model
- `wiki/course/00-overview.en.md` — §5 VFS & Device Drivers
- `src/kernel/devices/FileSystemDevice.ts` — file ↔ IVFS bridge
- `src/kernel/Syscalls.ts` — OPEN/READ/WRITE/CLOSE/EXIT cleanup
- `src/kernel/Scheduler.ts` — `FDEntry` + `fdTable` in the PCB

---

*Module 09 — done. Continue to [Module 10 — Device Drivers (HAL)](10-device-drivers-hal.en.md).*
