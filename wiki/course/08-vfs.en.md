---
module: 08
title: VFS
part: III
partTitle: Storage & I/O
status: done
lang: en
rfc: RFC-TSIX-EDU-002
audience: all
---

# VFS

**RFC-TSIX-EDU-002** | The eighth module of the TSIX curriculum. Understand the Virtual File System layer: one `IVFS` contract, three backends (BKFS/RamFS/HostVFS), and chunked I/O executed inside SQL.

> Design key: **IVFS is one contract, many backends.** A syscall does not care whether the file lives in SQLite, RAM, or a host folder — it only calls `vfs.read()`. This enables "backend swapping" without changing the kernel.

---

## Learning Objectives

- [ ] List the core methods of the `IVFS` contract
- [ ] Explain the differences between BKFS, RamFS, and HostVFS
- [ ] Explain why chunked I/O is executed inside SQL (SUBSTR/CONCAT)
- [ ] Explain the structure of the `vnodes` table in BKFS
- [ ] Explain the role of `getSize`, which does not fetch content
- [ ] Explain the flow of reading a single file: syscall `OPEN` → `VFS.read` → SQL

---

## Core Concepts

### The IVFS Contract

```ts
export interface IVFS {
    ls(path: string): any[];
    mkdir(path: string, uid?: number, gid?: number, mode?: number): boolean;
    read(path: string): string | null;
    touch(path: string, content?: string, uid?: number, gid?: number, mode?: number): boolean;
    stat(path: string): any;
    chmod(path: string, mode: number): boolean;
    chown(path: string, uid: number, gid: number): boolean;
    unlink(path: string): boolean;
    rmdir(path: string): boolean;
    exists(path: string, type?: VNodeType): boolean;
    getUsage(): Promise<{ size: number, files: number, dirs: number, diskSize?: number }>;
    append(path: string, content: string): boolean;

    // --- Chunked I/O (Progress-aware, untuk file besar) ---
    /** Membaca sebagian konten file (offset-based, return null jika di luar range) */
    readChunk(path: string, offset: number, length: number): string | null;
    /** Menulis (replace) sebagian konten file di offset tertentu */
    writeChunk(path: string, chunk: string, offset: number): boolean;
    /** Mendapatkan ukuran file dalam byte, atau -1 jika tidak ditemukan */
    getSize(path: string): number;
}
```

### Three Backends — Comparison

| Backend | Source | Persistence | Speed | Use case |
|---|---|---|---|---|
| **BKFS** | SQLite `system.db`, `vnodes` table | ✅ persistent (disk) | moderate; chunked I/O optimized inside SQL | root filesystem `/`, backup `/mnt/sbak` |
| **RamFS** | memory (`VNode` tree) | ❌ volatile (lost on restart) | ⚡ very fast | `/tmp` (temporary data) |
| **HostVFS** | real folder on the host (Node `fs`) | ✅ persistent (host files) | moderate (host syscall) | `/mnt/shared` (bridge + anti-escape) |

Which backend is used is decided by `MountManager` at boot time (see `src/mirror/etc/fstab.json`):

| Mount point | Type | Source | Description |
|---|---|---|---|
| `/` | `bkfs` | `system.db` | persistent root filesystem |
| `/tmp` | `ramfs` | RAM | volatile, mode `1023` = `0o1777` (sticky) |
| `/mnt/shared` | `host` | folder `shared` | bridge to host, uid `1000` |
| `/mnt/sbak` | `bkfs` | `systembak.db` | root backup in a separate SQLite file |

> [!NOTE] **"Swap backend" without changing the kernel**
> The kernel only holds an `IVFS` reference. Because every backend implements the same contract, swapping storage (e.g. `/tmp` from RamFS to BKFS) only requires changing an entry in `fstab.json` — the syscall does not change at all.

![VFS routing: app → syscall → MountManager → BKFS/RamFS/HostVFS](/wiki/diagram/Virtual-File-System-1.png)
*Source: [`wiki/diagram/Virtual-File-System-1.mmd`](/wiki/diagram/Virtual-File-System-1.mmd)*

### BKFS: `vnodes` structure

Files in BKFS are stored as **rows** in the `vnodes` table — a tree structure where `parent_id` points to the parent row (`NULL` for the root `/`):

```sql
CREATE TABLE IF NOT EXISTS vnodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER,          -- FK ke id parent (NULL untuk root "/")
    name TEXT NOT NULL,
    type TEXT NOT NULL,         -- 'FILE' | 'DIRECTORY'
    content TEXT,               -- isi file (NULL untuk direktori)
    size INTEGER DEFAULT 0,
    uid INTEGER DEFAULT 0,      -- User ID (0 = root)
    gid INTEGER DEFAULT 0,      -- Group ID (0 = root)
    mode INTEGER DEFAULT 420,   -- Permission desimal (octal 644 = 420, 755 = 493)
    created_at INTEGER,
    modified_at INTEGER,
    FOREIGN KEY (parent_id) REFERENCES vnodes(id),
    UNIQUE(parent_id, name)     -- satu nama per folder induk
);
```

**Important notes:**

- **`uid`/`gid`/`mode` are stored as decimal**, not octal strings. Example: `mode 420` = `0o644`, `493` = `0o755`. Root `/` is inserted at init with mode `493`; `/tmp` in `fstab.json` uses `1023` = `0o1777` (sticky bit).
- **Path navigation** is done row by row: each segment is looked up with `SELECT id FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'DIRECTORY'`, then `parent_id` shifts to the resulting id. This happens in `getNodeId()` / `getNodeIdAndSize()`.
- **`UNIQUE(parent_id, name)`** prevents duplicate names in the same folder. This schema also migrates old DBs: the `uid/gid/mode/size/modified_at` columns are added via `ALTER TABLE` if they do not exist yet.

### Chunked I/O in SQL — and why it matters

The main trick: **never pull the full content into JS memory**. For large files, reading everything at once is expensive: memory is used up and the UI feels "hung" while waiting. Chunked I/O breaks it into small pieces (offset + length) — used for progress-aware read/write, streaming, and OTA firmware.

All slicing is done **inside SQLite**:

- `readChunk` → `SELECT SUBSTR(content, ? + 1, ?)` — only the requested bytes are read.
- `writeChunk` sequential append (`offset >= currentSize`) → simple `CONCAT` (`IFNULL(content,'') || ?`) — **very fast**, does not rewrite the content.
- `writeChunk` random write in the middle → `SUBSTR(content, 1, ?) || ? || SUBSTR(content, ? + 1)` — overwrites a specific part.
- `getSize` → reads only the `size` column (via `getNodeIdAndSize`), **without fetching content** — cheap for checking progress before `readChunk`.

> [!IMPORTANT] **Why `SUBSTR(content, ? + 1, ?)`?**
> SQLite `SUBSTR` uses a 1-based index. To read from byte `offset` (0-based in the API), the first parameter must be `offset + 1`. Example: `readChunk(path, 2, 4)` → `SUBSTR(content, 3, 4)`.

---

## Flow / How it works

All file access goes through one path: **syscall → MountManager → IVFS → backend**. Here is the full flow of reading `/etc/motd` from an application (Worker) down to SQLite:

```
Worker (Aplikasi)                      Kernel (Main Thread)
───────────────────                    ─────────────────────
lib.fs.readFile("/etc/motd")           ← = open + read + close
  │  dispatch(OPEN, {path, flags:"r"})
  ├───────────────────────────────────► OPEN:
  │                                    │  1. PathResolver.resolve(cwd, path)
  │                                    │  2. MountManager.resolve → {vfs: BKFS, relativePath}
  │                                    │  3. vfs.stat → satpam.check (permission rwx)
  │                                    │  4. new FileSystemDevice(vfs) → fdTable → fd
  │  fd = 3
  │  dispatch(READ, 3)
  ├───────────────────────────────────► READ:
  │                                    │  5. fdTable[3].device.read()
  │                                    │     └─ FileSystemDevice.read()
  │                                    │        └─ vfs.read("/etc/motd")
  │                                    │           └─ BKFS.read → SQL
  │                                    │              SELECT content FROM vnodes
  │                                    │              WHERE name='motd'
  │                                    │                AND parent_id=? AND type='FILE'
  │  "Hello, TSIX!" (balasan RPC)      │
  ◄────────────────────────────────────┤
```

**Step by step:**

| # | Layer | What happens |
|---|---|---|
| 1 | `UserLib` (Worker) | `lib.fs.readFile('/etc/motd')` → `open` → send the `OPEN` syscall via `postMessage` (RPC). |
| 2 | Syscall `OPEN` | `PathResolver.resolve(pcb.cwd, path)` normalizes the path (`//`, `.`, `..`) → absolute. |
| 3 | `MountManager.resolve()` | Find the **longest** prefix mount point (`/` → BKFS) → `{ vfs, relativePath, mountPoint }`. |
| 4 | PermissionManager | `vfs.stat()` fetches metadata (uid/gid/mode) → `satpam.check()` verifies read permission. |
| 5 | FD Table | The file is wrapped in `FileSystemDevice`, `setPath(relativePath, flags)`, enters `pcb.fdTable` → `fd` is returned. |
| 6 | Syscall `READ` | `pcb.fdTable[fd].device.read()` calls the driver. |
| 7 | `FileSystemDevice.read()` | Polymorphic delegation: `vfs.read(this.currentPath)` — the kernel does not care about the backend. |
| 8 | `BKFS.read()` | Tree navigation per segment in SQL → `SELECT content ...` → the string is sent back via RPC. |

> [!TIP] **Relative vs absolute paths**
> The syscall receives a path relative to `pcb.cwd`; `PathResolver.resolve()` normalizes it before `MountManager`. So `/etc/../etc/motd` still opens the same file.

**Large file variant — the `READ_CHUNK` syscall:**

Instead of `READ` (which pulls the whole content into memory), the application uses `lib.fs.readChunk(path, offset, length)`:

```
lib.fs.readChunk("/firmware.bin", 65536, 4096)
  → dispatch(READ_CHUNK, {path, offset, length})
  → MountManager.resolve → vfs.stat → satpam.check(READ)
  → vfs.readChunk(relativePath, offset, length)
      └─ BKFS: SELECT SUBSTR(content, ? + 1, ?) ...   -- hanya byte yang diminta
```

The result: JS memory never holds the whole file — slicing happens inside SQLite.

## Source Code

| File | Role |
|---|---|
| `src/vfs/IVFS.ts` | Filesystem contract |
| `src/vfs/BKFS.ts` | SQLite backend + chunked I/O |
| `src/vfs/RamFS.ts` | In-memory backend |
| `src/vfs/HostVFS.ts` | Host backend (anti-escape) |

---

## Snippets (code level)

### BKFS.read — read full content

```ts
public read(path: string): string | null {
  const parts = path
    .split("/")
    .filter((p) => p.length > 0 && p !== "." && p !== "..");
  const fileName = parts.pop();
  if (!fileName) return null;

  let parentId = this.getRootId();
  for (const part of parts) {
    let node = this.db
      .prepare(
        "SELECT id FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'DIRECTORY'",
      )
      .get(part, parentId) as { id: number } | undefined;
    if (!node) return null;
    parentId = node.id;
  }

  const file = this.db
    .prepare(
      "SELECT content FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'FILE'",
    )
    .get(fileName, parentId) as { content: string } | undefined;

  return file ? file.content : null;
}
```

**Key point:** the path is split per segment, then each segment is looked up with `name + parent_id` (tree). The final query targets `type = 'FILE'` — directories are not read.

### BKFS.touch — create / overwrite file (upsert)

```ts
public touch(
  path: string,
  content: string = "",
  uid: number = 0,
  gid: number = 0,
  mode: number = 420,
): boolean {
  if (this.readOnly) throw new Error("Read-only filesystem");
  const parts = path
    .split("/")
    .filter((p) => p.length > 0 && p !== "." && p !== "..");
  const fileName = parts.pop();
  if (!fileName) return false;

  let parentId = this.getRootId();
  // Navigasi ke folder tujuan
  for (const part of parts) {
    let node = this.db
      .prepare(
        "SELECT id FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'DIRECTORY'",
      )
      .get(part, parentId) as { id: number } | undefined;
    if (!node) return false;
    parentId = node.id;
  }

  // Cek apakah file sudah ada
  const existing = this.db
    .prepare(
      "SELECT id FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'FILE'",
    )
    .get(fileName, parentId);

  if (existing) {
    this.db
      .prepare(
        "UPDATE vnodes SET content = ?, size = ?, modified_at = ? WHERE id = ?",
      )
      .run(content, content.length, Date.now(), (existing as any).id);
    return true;
  }

  const now = Date.now();
  this.db
    .prepare(
      "INSERT INTO vnodes (parent_id, name, type, content, size, uid, gid, mode, created_at, modified_at) VALUES (?, ?, 'FILE', ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      parentId,
      fileName,
      content,
      content.length,
      uid,
      gid,
      mode,
      now,
      now,
    );

  this.logger.debug(
    `File created/updated in BKFS: ${fileName} (Mode: ${mode.toString(8)})`,
  );
  return true;
}
```

**Key point:** `touch` is an **upsert** — an existing file is `UPDATE`d (content + `size`), a missing one is `INSERT`ed. The default mode `420` = `0o644`. The `OPEN` syscall with the `w` flag uses this to create/truncate a file.

### readChunk (BKFS) — content chunk

```ts
public readChunk(path: string, offset: number, length: number): string | null {
    const nodeId = this.getNodeId(path);
    if (nodeId < 0) return null;

    const row = this.db
      .prepare(
        "SELECT SUBSTR(content, ? + 1, ?) as chunk FROM vnodes WHERE id = ? AND type = 'FILE'",
      )
      .get(offset, length, nodeId) as { chunk: string | null } | undefined;

    return row?.chunk ?? null;
}
```

### writeChunk (BKFS) — two paths

```ts
if (offset >= currentSize) {
    // Sequential append — simple CONCAT (paling cepat)
    UPDATE vnodes SET content = IFNULL(content,'') || ?, size = ?, modified_at = ? WHERE id = ?;
} else {
    // Random write di tengah — SUBSTR + CONCAT
    UPDATE vnodes SET
      content = SUBSTR(content, 1, ?) || ? || SUBSTR(content, ? + 1),
      size = ?, modified_at = ? WHERE id = ?;
}
```

---

## Exercises / Practice

1. Open `system.db` with the SQLite CLI: `.schema vnodes` — observe the table structure.
2. Read `src/vfs/HostVFS.ts` — find `toHostPath()` and check the anti-escape.
3. Write a large file (e.g. 1MB) then call `readChunk` with random offsets — compare the speed vs a full `read`.
4. Read `src/vfs/IVFS.ts` — recognize the whole contract a new backend must satisfy.
5. Place a breakpoint in the `OPEN` and `READ` cases of `src/kernel/Syscalls.ts`, then read `/etc/motd` from the shell — trace down to `BKFS.read` and observe its SQL query.

---

## References

- `wiki/Virtual-File-System.md` — the full VFS layer
- `wiki/course/00-overview.en.md` §5.1
- `src/vfs/IVFS.ts`, `src/vfs/BKFS.ts`, `src/vfs/RamFS.ts`, `src/vfs/HostVFS.ts`
- `src/kernel/MountManager.ts` — backend selection from path (longest prefix)
- `src/kernel/Syscalls.ts` — syscall `OPEN`, `READ`, `READ_CHUNK`, `WRITE_CHUNK`, `GET_SIZE`
- `src/kernel/devices/FileSystemDevice.ts` — FD → IVFS bridge
- `src/mirror/etc/fstab.json` — mount configuration at boot

---

*Module 08 — complete. Continue to [Module 09 — FD Table & File Syscalls](09-fd-table-file-syscalls.en.md).*
