---
module: 09
title: FD Table & File Syscalls
part: III
partTitle: Storage & I/O
status: done
lang: id
rfc: RFC-TSIX-EDU-002
audience: all
---

# FD Table & File Syscalls

**RFC-TSIX-EDU-002** | Modul kesembilan kurikulum TSIX. Memahami "everything is a file" di level FD table: bagaimana `open` → `FDEntry` → device, dan bagaimana file biasa dibungkus `FileSystemDevice`.

> Di TSIX, **file descriptor bukan index ke array file** — ia index ke `FDEntry { device, context, flags }` yang menunjuk ke objek `IDevice` apa pun. File biasa, TTY, pipe, socket — semuanya `IDevice`.

---

## Tujuan Pembelajaran

- [ ] Menjelaskan struktur `FDEntry { device, context, flags }` dan `fdTable`
- [ ] Menjelaskan alur `OPEN`: resolve path → cek permission → pilih device → `fdTable.push`
- [ ] Menjelaskan bagaimana `READ`/`WRITE` me-dispatch ke `entry.device`
- [ ] Menjelaskan "everything is a file": file biasa vs `/dev/*`
- [ ] Menjelaskan pipe refcount via ioctl (`INC_REF`/`DEC_REF`)
- [ ] Menjelaskan cleanup FD saat proses exit

---

## Konsep Inti

### FDEntry

```ts
export interface FDEntry {
    device: IDevice;   // objek device nyata
    context: any;      // state per-FD
    flags?: string;    // "r" | "w" | "a" | "+"
}
```

`fdTable` ada di PCB — setiap proses punya array `(FDEntry | null)[]`. FD 0/1/2 (stdin/stdout/stderr) diisi saat spawn dari device TTY.

### Everything is a File

| Yang dibuka | Device di FD table |
|---|---|
| File biasa (`/etc/passwd`) | `FileSystemDevice` (bungkus IVFS) |
| `/dev/tty1` | `TTYDevice` |
| `/dev/null` | `NullDevice` |
| Pipe (syscall PIPE) | `PipeDevice` |
| Socket (syscall SOCKET) | `SocketDevice` |

Tidak ada perbedaan *tipe* antara file dan perangkat di FD table — keduanya hanyalah objek yang mengimplementasikan `IDevice` (`read()`, `write()`, `ioctl()`). Buka file biasa → kernel membuat `FileSystemDevice` baru yang membungkus backend `IVFS` hasil `mountManager.resolve()`. Buka `/dev/*` → kernel mengambil device yang sudah terdaftar di `kernel.devices` (TTY, null, stdin, dll). Inilah inti "everything is a file": `read`/`write` selalu polimorfik ke `entry.device`.

### FD Standar (0/1/2)

Saat proses dibuat (`Scheduler.createProcess`) atau di-`EXEC`, kernel mengisi tiga FD pertama dari device stdio. Default di `EXEC` adalah device global `kernel.devices.stdin`/`stdout`/`stderr`; jika proses berjalan di sebuah TTY (`pcb.ttyId`), ketiganya diarahkan ke `tty{N}` yang sama.

| FD | Nama | flags | Device (umum) |
|---|---|---|---|
| `0` | stdin | `"r"` | `TTYDevice` (`ttyN`) saat proses punya TTY; fallback `KeyboardDevice` (`kernel.devices.stdin`) |
| `1` | stdout | `"w"` | `TTYDevice` (`kernel.devices.stdout` = `tty1`) |
| `2` | stderr | `"w"` | `TTYDevice` (`kernel.devices.stderr` = `tty1`) |

> [!NOTE]
> `flags` FD 0 adalah `"r"` (baca), sedangkan FD 1 dan 2 adalah `"w"` (tulis). Inilah yang membuat `WRITE` bisa menolak menulis ke FD yang tidak dibuka untuk menulis ("Bad File Descriptor").

### Pipe refcount

Pipe punya refcount pada sisi read dan write. EOF terjadi saat `writeRefs == 0`. Kernel mengelola refcount lewat `ioctl` device — nomor perintah:

| ioctl cmd | Makna | Dipanggil dari |
|---|---|---|
| `10` | `INC_READ_REF` | `OPEN` saat flags mengandung `"r"` |
| `20` | `INC_WRITE_REF` | `OPEN` saat flags mengandung `"w"`/`"a"` |
| `11` | `DEC_READ_REF` | `CLOSE` saat flags mengandung `"r"` |
| `21` | `DEC_WRITE_REF` | `CLOSE` saat flags mengandung `"w"`/`"a"` |

Setiap `open` menambah, setiap `close` mengurangi. `FileSystemDevice` tidak memakai refcount — `ioctl()`-nya mengembalikan `-1` (no-op). Refcount hanya bermakna untuk device nyata seperti pipe, TTY, dan serial.

## Alur / Cara Kerja

### OPEN: dari path menuju FD

Langkah pada case `SyscallCode.OPEN` (`src/kernel/Syscalls.ts`):

1. **Resolve path** — `PathResolver.resolve(pcb.cwd, args)` mengubah path (relatif/absolut) menjadi absolut.
2. **Resolve VFS** — `mountManager.resolve(absolutePath)` → `{ vfs, relativePath }`. Backend dipilih dari prefix mount terpanjang (`/` → BKFS, `/tmp` → RamFS, `/mnt/*` → HostVFS).
3. **Cek permission** — `vfs.stat(relativePath)` untuk mendapat node. `requiredPerm` = `WRITE` jika flags mengandung `"w"`/`"+"`, selain itu `READ`.
   - Node ada → `satpam.check(pcb, node, requiredPerm)`; gagal → `Permission Denied`.
   - Node tidak ada → flags `"r"` → `File not found`; flags `"w"`/`"+"` → cek permission direktori induk, lalu `vfs.touch` membuat file (mode `0644`), dan truncate bila flags `"w"` tanpa `"a"`.
4. **Pilih device**:
   - Path `/dev/*` → cari `kernel.devices[devName]` (alias: `screen`/`console`/`stdout`/`fb0` dan `keyboard`/`stdin`; `tty` → `tty{pcb.ttyId}`). Refcount dinaikkan via `ioctl` `INC_*_REF`, lalu `device.open()` dipanggil secara lazy.
   - Path biasa → `new FileSystemDevice(vfs)` + `setPath(relativePath, flags)`.
5. **Masukkan ke tabel** — `const fd = pcb.fdTable.length; pcb.fdTable.push({ device, context, flags }); return fd;`. `fd` adalah index baru di array, bukan angka bebas. Untuk file biasa, `context` diisi `relativePath`; untuk `/dev/*`, `context` diisi path absolut.

### READ / WRITE: dispatch ke `entry.device`

`READ` dan `WRITE` tidak peduli jenis device. Mereka mengambil `entry = pcb.fdTable[fd]`, lalu memanggil metode polimorfik pada `entry.device`:

- `READ(fd)` → `entry.device.read()` — TTY membaca buffer, file membaca VFS.
- `WRITE(fd, content)` → cek `entry.flags` (harus mengandung `"w"`/`"a"`/`"+"`, selain itu `Bad File Descriptor`), lalu `entry.device.write(content)`.

Ada rute khusus IPC: `WRITE` dengan `{ pid, content }` menulis ke `fdTable[0]` proses target (TTY → injeksi via `ioctl(0x2001)`); `READ` dengan `{ pid }` membaca dari `fdTable[1]` proses target (TTY → `ioctl(0x2002)`).

### Walkthrough: membuka `/etc/passwd`

Trace satu proses shell yang mengeksekusi `cat /etc/passwd`:

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
> `FileSystemDevice` mengembalikan `null` saat `currentPath` kosong dan `false` saat menulis tanpa path — ini "fail safe" sebelum menyentuh VFS.

### Cleanup saat exit

Kernel memasang global exit hook di konstruktor `SyscallHandler` (`setOnProcessExit`). Saat proses EXITED:

1. **Tutup semua FD** — iterasi `pcb.fdTable`; tiap entry yang tidak `null` di-`dispatch` `CLOSE` (memicu `DEC_*_REF` pada device yang mendukung). Error saat cleanup massal diabaikan.
2. **Jaring pengaman port** — `portManager.releasePortsByPid(pid)` membebaskan semua port MQTNL milik proses (antisipasi socket yang lolos dari `CLOSE`).
3. **GUI cleanup** — `guiRegistry.destroyAllForPid(pid)` menghancurkan semua window milik proses dan mengirim `GUI_REQ DESTROY_WINDOW` ke daemon GUI (`gued`).

---

## Kode Sumber

| File | Peran |
|---|---|
| `src/kernel/Scheduler.ts` | Definisikan `FDEntry` + `fdTable` di PCB |
| `src/kernel/devices/FileSystemDevice.ts` | Jembatan file ↔ IVFS |
| `src/kernel/devices/PipeDevice.ts` | Pipe + refcount |
| `src/kernel/Syscalls.ts` | OPEN/READ/WRITE/CLOSE/PIPE + cleanup |

---

## Snippet (level kode)

### OPEN — resolve, permission, pilih device, fdTable.push

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
> Perhatikan dua detail: (1) `fd` adalah `pcb.fdTable.length` — index baru di akhir array, bukan angka bebas; (2) untuk file biasa `context` diisi `relativePath`, sedangkan untuk `/dev/*` diisi path absolut. `context` bebas diinterpretasi device.

### READ / WRITE — dispatch ke `entry.device`

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

### FileSystemDevice — jembatan file ↔ VFS

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

### Cleanup FD saat proses exit

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

## Latihan / Praktik

1. Baca `src/kernel/devices/PipeDevice.ts` — jelaskan kapan pipe mengembalikan EOF (hubungkan ke `writeRefs` dan ioctl `DEC_WRITE_REF`).
2. Dari shell, `echo hello > /tmp/x` lalu `cat /tmp/x` — trace syscall OPEN/WRITE/READ/CLOSE di log. Perhatikan fd yang dikembalikan `OPEN` dan device di belakangnya.
3. Baca `src/kernel/Syscalls.ts` — temukan implementasi `OPEN` dan bagaimana ia memilih device (`FileSystemDevice` vs `/dev/*`).
4. Baca `src/kernel/Scheduler.ts` `createProcess` — jelaskan bagaimana fd 0/1/2 (stdin/stdout/stderr) diisi dari `options.fds`.

---

## Referensi

- `wiki/Virtual-File-System.md` — §device model
- `wiki/course/00-overview.md` — §5 VFS & Device Drivers
- `src/kernel/devices/FileSystemDevice.ts` — jembatan file ↔ IVFS
- `src/kernel/Syscalls.ts` — OPEN/READ/WRITE/CLOSE/EXIT cleanup
- `src/kernel/Scheduler.ts` — `FDEntry` + `fdTable` di PCB

---

*Modul 09 — selesai. Lanjut ke [Modul 10 — Device Drivers (HAL)](10-device-drivers-hal.md).*
