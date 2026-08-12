---
module: 08
title: VFS
part: III
partTitle: Storage & I/O
status: done
lang: id
rfc: RFC-TSIX-EDU-002
audience: all
---

# VFS

**RFC-TSIX-EDU-002** | Modul kedelapan kurikulum TSIX. Memahami lapisan Virtual File System: satu kontrak `IVFS`, tiga backend (BKFS/RamFS/HostVFS), dan chunked I/O yang dieksekusi dalam SQL.

> Kunci desain: **IVFS adalah satu kontrak, banyak backend.** Syscall tidak peduli apakah file berada di SQLite, RAM, atau folder host — ia hanya memanggil `vfs.read()`. Ini memungkinkan "swap backend" tanpa mengubah kernel.

---

## Tujuan Pembelajaran

- [ ] Menyebutkan metode inti kontrak `IVFS`
- [ ] Menjelaskan perbedaan BKFS, RamFS, HostVFS
- [ ] Menjelaskan mengapa chunked I/O dieksekusi dalam SQL (SUBSTR/CONCAT)
- [ ] Menjelaskan struktur tabel `vnodes` di BKFS
- [ ] Menjelaskan peran `getSize` yang tidak fetch konten
- [ ] Menjelaskan alur baca satu file: syscall `OPEN` → `VFS.read` → SQL

---

## Konsep Inti

### Kontrak IVFS

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

### Tiga Backend — Perbandingan

| Backend | Sumber | Persistensi | Kecepatan | Kasus pakai |
|---|---|---|---|---|
| **BKFS** | SQLite `system.db`, tabel `vnodes` | ✅ persisten (disk) | sedang; chunked I/O dioptimalkan di dalam SQL | root filesystem `/`, backup `/mnt/sbak` |
| **RamFS** | memori (pohon `VNode`) | ❌ volatile (hilang saat restart) | ⚡ sangat cepat | `/tmp` (data sementara) |
| **HostVFS** | folder nyata di host (`fs` Node) | ✅ persisten (file host) | sedang (syscall host) | `/mnt/shared` (bridge + anti-escape) |

Kapan backend dipakai ditentukan oleh `MountManager` saat boot (lihat `src/mirror/etc/fstab.json`):

| Mount point | Type | Source | Keterangan |
|---|---|---|---|
| `/` | `bkfs` | `system.db` | root filesystem persisten |
| `/tmp` | `ramfs` | RAM | volatile, mode `1023` = `0o1777` (sticky) |
| `/mnt/shared` | `host` | folder `shared` | bridge ke host, uid `1000` |
| `/mnt/sbak` | `bkfs` | `systembak.db` | backup root di file SQLite terpisah |

> [!NOTE] **"Swap backend" tanpa ubah kernel**
> Kernel hanya memegang referensi `IVFS`. Karena semua backend mengimplementasi kontrak yang sama, mengganti penyimpanan (mis. `/tmp` dari RamFS ke BKFS) cukup dengan mengubah entri `fstab.json` — syscall tidak berubah sama sekali.

![Routing VFS: app → syscall → MountManager → BKFS/RamFS/HostVFS](/wiki/diagram/Virtual-File-System-1.png)
*Sumber: [`wiki/diagram/Virtual-File-System-1.mmd`](/wiki/diagram/Virtual-File-System-1.mmd)*

### BKFS: struktur `vnodes`

File di BKFS disimpan sebagai **baris** di tabel `vnodes` — struktur tree dengan `parent_id` menunjuk ke baris induknya (`NULL` untuk root `/`):

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

**Catatan penting:**

- **`uid`/`gid`/`mode` disimpan sebagai desimal**, bukan string octal. Contoh: `mode 420` = `0o644`, `493` = `0o755`. Root `/` disisipkan saat init dengan mode `493`; `/tmp` di `fstab.json` memakai `1023` = `0o1777` (sticky bit).
- **Navigasi path** dilakukan baris-per-baris: setiap segmen dicari dengan `SELECT id FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'DIRECTORY'`, lalu `parent_id` bergeser ke id hasil. Ini terjadi di `getNodeId()` / `getNodeIdAndSize()`.
- **`UNIQUE(parent_id, name)`** mencegah duplikasi nama di folder yang sama. Schema ini juga migrasi DB lama: kolom `uid/gid/mode/size/modified_at` ditambahkan via `ALTER TABLE` jika belum ada.

### Chunked I/O dalam SQL — dan kenapa penting

Trik utama: **jangan pernah menarik konten penuh ke memori JS**. Untuk file besar, membaca utuh sekali jalan mahal: memori terpakai dan UI terasa "hang" saat menunggu. Chunked I/O memecahnya menjadi potongan kecil (offset + length) — dipakai untuk progress-aware read/write, streaming, dan OTA firmware.

Semua pemotongan dilakukan **di dalam SQLite**:

- `readChunk` → `SELECT SUBSTR(content, ? + 1, ?)` — hanya byte yang diminta yang dibaca.
- `writeChunk` sequential append (`offset >= currentSize`) → simple `CONCAT` (`IFNULL(content,'') || ?`) — **sangat cepat**, tidak menulis ulang konten.
- `writeChunk` random write di tengah → `SUBSTR(content, 1, ?) || ? || SUBSTR(content, ? + 1)` — menimpa bagian tertentu.
- `getSize` → baca kolom `size` saja (via `getNodeIdAndSize`), **tanpa fetch konten** — murah untuk cek progress sebelum `readChunk`.

> [!IMPORTANT] **Kenapa `SUBSTR(content, ? + 1, ?)`?**
> SQLite `SUBSTR` memakai indeks 1-based. Untuk membaca dari byte `offset` (0-based di API), parameter pertama harus `offset + 1`. Contoh: `readChunk(path, 2, 4)` → `SUBSTR(content, 3, 4)`.

---

## Alur / Cara Kerja

Semua akses file melewati satu jalan: **syscall → MountManager → IVFS → backend**. Berikut alur lengkap membaca `/etc/motd` dari aplikasi (Worker) sampai SQLite:

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

**Langkah demi langkah:**

| # | Lapisan | Yang terjadi |
|---|---|---|
| 1 | `UserLib` (Worker) | `lib.fs.readFile('/etc/motd')` → `open` → kirim syscall `OPEN` via `postMessage` (RPC). |
| 2 | Syscall `OPEN` | `PathResolver.resolve(pcb.cwd, path)` menormalkan path (`//`, `.`, `..`) → absolut. |
| 3 | `MountManager.resolve()` | Cari mount point prefix **terpanjang** (`/` → BKFS) → `{ vfs, relativePath, mountPoint }`. |
| 4 | PermissionManager | `vfs.stat()` ambil metadata (uid/gid/mode) → `satpam.check()` verifikasi izin baca. |
| 5 | FD Table | File dibungkus `FileSystemDevice`, `setPath(relativePath, flags)`, masuk `pcb.fdTable` → `fd` dikembalikan. |
| 6 | Syscall `READ` | `pcb.fdTable[fd].device.read()` memanggil driver. |
| 7 | `FileSystemDevice.read()` | Delegasi polimorfik: `vfs.read(this.currentPath)` — kernel tak peduli backendnya. |
| 8 | `BKFS.read()` | Navigasi tree per segmen di SQL → `SELECT content ...` → string dikirim balik via RPC. |

> [!TIP] **Path relatif vs absolut**
> Syscall menerima path relatif terhadap `pcb.cwd`; `PathResolver.resolve()` menormalkannya dulu sebelum `MountManager`. Jadi `/etc/../etc/motd` tetap membuka file yang sama.

**Varian file besar — syscall `READ_CHUNK`:**

Alih-alih `READ` (yang menarik seluruh konten ke memori), aplikasi memakai `lib.fs.readChunk(path, offset, length)`:

```
lib.fs.readChunk("/firmware.bin", 65536, 4096)
  → dispatch(READ_CHUNK, {path, offset, length})
  → MountManager.resolve → vfs.stat → satpam.check(READ)
  → vfs.readChunk(relativePath, offset, length)
      └─ BKFS: SELECT SUBSTR(content, ? + 1, ?) ...   -- hanya byte yang diminta
```

Hasilnya: memori JS tidak pernah menampung file utuh — pemotongan terjadi di dalam SQLite.

## Kode Sumber

| File | Peran |
|---|---|
| `src/vfs/IVFS.ts` | Kontrak filesystem |
| `src/vfs/BKFS.ts` | Backend SQLite + chunked I/O |
| `src/vfs/RamFS.ts` | Backend in-memory |
| `src/vfs/HostVFS.ts` | Backend host (anti-escape) |

---

## Snippet (level kode)

### BKFS.read — baca konten penuh

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

**Poin kunci:** path dipecah per segmen, lalu tiap segmen dicari dengan `name + parent_id` (tree). Query terakhir menargetkan `type = 'FILE'` — direktori tidak ikut terbaca.

### BKFS.touch — buat / timpa file (upsert)

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

**Poin kunci:** `touch` adalah **upsert** — file yang sudah ada di-`UPDATE` (konten + `size`), yang belum ada di-`INSERT`. Mode default `420` = `0o644`. Syscall `OPEN` dengan flag `w` memakai ini untuk membuat/truncate file.

### readChunk (BKFS) — potongan konten

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

### writeChunk (BKFS) — dua jalur

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

## Latihan / Praktik

1. Buka `system.db` dengan SQLite CLI: `.schema vnodes` — amati struktur tabel.
2. Baca `src/vfs/HostVFS.ts` — cari `toHostPath()` dan cek anti-escape.
3. Tulis file besar (misal 1MB) lalu panggil `readChunk` dengan offset acak — bandingkan kecepatan vs `read` penuh.
4. Baca `src/vfs/IVFS.ts` — kenali seluruh kontrak yang harus dipenuhi backend baru.
5. Letakkan breakpoint di `src/kernel/Syscalls.ts` case `OPEN` dan `READ`, lalu baca `/etc/motd` dari shell — telusuri sampai `BKFS.read` dan amati query SQL-nya.

---

## Referensi

- `wiki/Virtual-File-System.md` — lapisan VFS lengkap
- `wiki/course/00-overview.md` §5.1
- `src/vfs/IVFS.ts`, `src/vfs/BKFS.ts`, `src/vfs/RamFS.ts`, `src/vfs/HostVFS.ts`
- `src/kernel/MountManager.ts` — pemilihan backend dari path (prefix terpanjang)
- `src/kernel/Syscalls.ts` — syscall `OPEN`, `READ`, `READ_CHUNK`, `WRITE_CHUNK`, `GET_SIZE`
- `src/kernel/devices/FileSystemDevice.ts` — jembatan FD → IVFS
- `src/mirror/etc/fstab.json` — konfigurasi mount saat boot

---

*Modul 08 — selesai. Lanjut ke [Modul 09 — FD Table & File Syscalls](09-fd-table-file-syscalls.md).*
