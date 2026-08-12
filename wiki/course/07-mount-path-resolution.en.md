---
module: 07
title: Mount & Path Resolution
part: II
partTitle: Boot & Kernel Runtime
status: done
lang: en
rfc: RFC-TSIX-EDU-002
audience: all
---

# Mount & Path Resolution

**RFC-TSIX-EDU-002** | Seventh module of the TSIX curriculum. Understand how VFS paths are routed to the correct filesystem backend — by the "longest prefix wins" principle.

> MountManager is the "path router". When an app opens `/tmp/foo`, the kernel must know that it belongs to RamFS, not BKFS. The rule is simple: **the longest matching prefix wins.**

---

## Learning Objectives

- [ ] Explain the `MountPoint` structure
- [ ] Explain the "longest prefix wins" principle
- [ ] Explain the contents of `fstab.json` (default mounts)
- [ ] Distinguish resolution via MountManager vs device `/dev/*`
- [ ] Explain the role of `PathResolver`
- [ ] Walk through `PathResolver.resolve()` for relative, absolute, `.` and `..` paths
- [ ] Predict the result of `resolve()` by reading the mount sort order

---

## Core Concepts

### Two layers of resolution

Path resolution in TSIX runs in two layers:

1. **`PathResolver.resolve()`** — normalizes a path string. It only processes text (`//`, `.`, `..`), without knowing about filesystems.
2. **`MountManager.resolve()`** — routes the normalized path to the correct `IVFS` backend, using the "longest prefix wins" rule.

> [!IMPORTANT]
> `PathResolver` works at the **string** level. `MountManager` works at the **filesystem backend** level. They are two different functions.

### MountPoint

```ts
export interface MountPoint {
  vfsPath: string;     // titik kait di VFS, misal "/tmp"
  vfs: IVFS;           // backend filesystem
  type: string;        // "bkfs" | "ramfs" | "host"
  source: string;      // "system.db" | "shared" | "systembak.db" | ...
  readOnly: boolean;
  uid?: number;
  gid?: number;
}
```

> `type` uses the real values from `fstab.json`: `"bkfs"`, `"ramfs"`, and `"host"` (HostVFS).

### PathResolver.resolve() — walkthrough

`PathResolver.resolve(cwd, targetPath)` takes two arguments: the working directory (`cwd`) and the target path. The result is always a normalized absolute path (without `//`, `.`, or `..`).

| # | `cwd` | `targetPath` | Result | Explanation |
|---|---|---|---|---|
| 1 | `/` | `/etc/passwd` | `/etc/passwd` | Absolute path — `cwd` is ignored |
| 2 | `/` | `etc/passwd` | `/etc/passwd` | Relative path resolved at root |
| 3 | `/bin` | `../etc/passwd` | `/etc/passwd` | `..` goes up one level out of `/bin` |
| 4 | `/home/user` | `docs/../a.txt` | `/home/user/a.txt` | `..` cancels the `docs` segment |
| 5 | `/` | `/tmp/./foo//bar` | `/tmp/foo/bar` | `//` and `.` are cleaned up |
| 6 | `/` | `/../x` | `/x` | `..` above root cannot go higher |

> [!NOTE]
> Examples 4 and 5 show that normalization happens **before** mount lookup. So `resolve("/tmp/./foo")` and `resolve("/tmp/foo")` are considered the same by `MountManager`.

### Default mounts

Root `/` is **not** in `fstab.json`. It is mounted directly in `initializeSubsystems()`:

```ts
this.mountManager.mount("/", this.bkfs, "bkfs", cfg.kernel.database, false);
```

`cfg.kernel.database` is `"system.db"` (see `src/sysconfig.json`). The rest are loaded from `src/mirror/etc/fstab.json` by `processFstab()`:

| Path | type | Backend | Source | readOnly | uid/gid | mode | Nature |
|---|---|---|---|---|---|---|---|
| `/` | `bkfs` | BKFS (SQLite) | `system.db` | false | — | — | persistent, root fs |
| `/tmp` | `ramfs` | RamFS | in-memory (hostPath `"RAM"` is ignored) | false | 0/100 | `0o1777` | volatile, sticky |
| `/mnt/shared` | `host` | HostVFS | host folder `shared` | false | 1000/100 | `0o775` | host bridge, anti-escape |
| `/mnt/sbak` | `bkfs` | BKFS | `systembak.db` | false | 1000/100 | `0o775` | backup DB |

> [!NOTE]
> `fstab.json` only contains `/tmp`, `/mnt/shared`, and `/mnt/sbak`. The `/tmp` entry uses `active: true`; the rest are active by default. Mode `1023` = `0o1777` (sticky, everyone can write — typical for `/tmp`), `509` = `0o775`.

### Resolution: longest prefix wins

After all mounts are in place, the list is sorted **descending by path length**. The resulting sort order for the default mounts:

```
/mnt/shared  (11)   ← diperiksa dulu
/mnt/sbak    ( 9)
/tmp         ( 4)
/            ( 1)   ← fallback terakhir
```

Example output of `MountManager.resolve()`:

| Requested path | Selected MountPoint | `relativePath` | vfs |
|---|---|---|---|
| `/tmp/a.txt` | `/tmp` | `/a.txt` | RamFS |
| `/tmp` | `/tmp` (exact) | `/` | RamFS |
| `/etc/passwd` | `/` | `/etc/passwd` | BKFS |
| `/mnt/shared/readme.md` | `/mnt/shared` | `/readme.md` | HostVFS |
| `/mnt/shared` | `/mnt/shared` (exact) | `/` | HostVFS |
| `/mnt/sbak/backup.tar` | `/mnt/sbak` | `/backup.tar` | BKFS |
| `/mnt/sharedx/foo` | `/` | `/mnt/sharedx/foo` | BKFS |

> [!WARNING]
> The last row is an important gotcha. `/mnt/sharedx/foo` does **not** match the prefix `/mnt/shared/` (because after `shared` there is `x`, not `/`). So it falls back to `/` → BKFS. This is why the prefix uses an extra slash (`m.vfsPath + "/"`), not a plain `startsWith(m.vfsPath)`.

![Path resolution: syscall → MountManager → VFS backend](/wiki/diagram/Home-2.png)
*Source: [`wiki/diagram/Home-2.mmd`](/wiki/diagram/Home-2.mmd)*

### The `/dev/*` path does not pass through MountManager

`dev/xxx` paths are handled by **HAL** (`kernel.devices[xxx]`), bypassing MountManager. This is consistent with the "everything is a file" principle — devices are not vnode filesystems.

---

## Flow / How It Works

### Mount flow at boot

```
initializeSubsystems()
  └─ new BKFS("system.db")                        → root filesystem
  └─ mount("/", bkfs, "bkfs", "system.db", false)
  └─ processFstab()                               → baca /etc/fstab.json
       └─ untuk tiap entry:
            active === false → skip
            pastikan dir mount point ada (mode ?? 0o755)
            pilih driver: bkfs → BKFS, ramfs → RamFS, else → HostVFS
            mountManager.mount(vfsPath, driver, type, hostPath, ...)
  └─ mount() normalisasi path + sort descending by panjang
```

### Resolution flow on a file syscall

```
Aplikasi → syscall file (mis. OPEN, path mentah)
  → MountManager.resolve(path)
      1. normalized = PathResolver.resolve("/", path)
      2. loop mounts (terpanjang dulu):
           exact match  → relativePath = "/"
           prefix match → relativePath = sisa path
      3. hasil: { vfs, relativePath, mountPoint }
  → vfs.<op>(relativePath)            // backend mengeksekusi
Path /dev/* → kernel.devices[xxx]     // HAL, bukan MountManager
```

---

## Source Code

| File | Role |
|---|---|
| `src/kernel/MountManager.ts` | mount/unmount/resolve/listMounts |
| `src/common/PathResolver.ts` | Path normalization (`//`, `.`, `..`) |
| `src/kernel/Kernel.ts` | `initializeSubsystems()` + `processFstab()` at boot |
| `src/mirror/etc/fstab.json` | Default mount list |
| `src/vfs/HostVFS.ts`, `RamFS.ts`, `BKFS.ts` | Backends |

---

## Snippets (code level)

### PathResolver.resolve()

```ts
public static resolve(cwd: string, targetPath: string): string {
    // 1. Jika path diawali '/', berarti absolute
    let absolutePath = targetPath.startsWith("/")
        ? targetPath
        : (cwd === "/" ? "/" + targetPath : cwd + "/" + targetPath);

    // 2. Normalisasi (Bersihkan //, ./ dan ..)
    const parts = absolutePath.split("/").filter(p => p.length > 0 && p !== ".");
    const stack: string[] = [];

    for (const part of parts) {
        if (part === "..") {
            stack.pop();
        } else {
            stack.push(part);
        }
    }

    return "/" + stack.join("/");
}
```

### MountManager.resolve()

```ts
public resolve(path: string): {
    vfs: IVFS;
    relativePath: string;
    mountPoint: string;
} {
    // Normalize: robustly handle //, ./ and .. using PathResolver
    const normalized = PathResolver.resolve("/", path);

    for (const m of this.mounts) {
      // Case 1: Exact match
      if (normalized === m.vfsPath) {
        return { vfs: m.vfs, relativePath: "/", mountPoint: m.vfsPath };
      }

      // Case 2: Sub-path match
      // Special handling for root mount point "/"
      const prefix = m.vfsPath === "/" ? "/" : m.vfsPath + "/";
      if (normalized.startsWith(prefix)) {
        let relative = normalized.substring(
          m.vfsPath === "/" ? 0 : m.vfsPath.length,
        );
        if (!relative.startsWith("/")) relative = "/" + relative;
        return { vfs: m.vfs, relativePath: relative, mountPoint: m.vfsPath };
      }
    }

    throw new Error(`Path not found in any mounted filesystem: ${path}`);
}
```

### MountManager.mount()

```ts
public mount(
    vfsPath: string,
    vfs: IVFS,
    type: string = "bkfs",
    source: string = "system.db",
    readOnly: boolean = false,
    uid?: number,
    gid?: number,
) {
    // Normalisasi path menggunakan PathResolver agar konsisten
    const cleanPath = PathResolver.resolve("/", vfsPath);

    // Cek apakah sudah ada
    const existing = this.mounts.find((m) => m.vfsPath === cleanPath);
    if (existing) {
      this.logger.warn(`Mount point ${cleanPath} already exists. Replacing...`);
      existing.vfs = vfs;
      existing.type = type;
      existing.source = source;
      existing.readOnly = readOnly;
      existing.uid = uid;
      existing.gid = gid;
    } else {
      this.mounts.push({
        vfsPath: cleanPath,
        vfs,
        type,
        source,
        readOnly,
        uid,
        gid,
      });
      // Sort by path length descending so longest match wins
      this.mounts.sort((a, b) => b.vfsPath.length - a.vfsPath.length);
    }

    this.logger.info(
      `Mounted ${type} filesystem at ${cleanPath} from ${source} (${readOnly ? "ro" : "rw"})`,
    );
}
```

> [!NOTE]
> `mount()` only sorts when a **new** entry is added. If the path already exists, `mount()` replaces its backend without touching the sort order.

### Root mount in initializeSubsystems()

```ts
this.bkfs = new BKFS(cfg.kernel.database);
this.mountManager.mount("/", this.bkfs, "bkfs", cfg.kernel.database, false);
```

### processFstab() — fstab processing loop

```ts
private async processFstab() {
    if (!this.bkfs) return;

    const fstabPath = "/etc/fstab.json";
    if (!this.bkfs.exists(fstabPath)) return;

    try {
      const content = this.bkfs.read(fstabPath);
      if (!content) return;

      const entries = JSON.parse(content) as any[];
      for (const entry of entries) {
        const { vfsPath, hostPath, type, readOnly, uid, gid, active, mode } =
          entry;

        // Skip if explicitly marked inactive (default: active = true)
        if (active === false) {
          this.bootLogStart(`FSTAB: Skipping ${vfsPath} (inactive)`);
          this.bootLogEnd(true);
          continue;
        }

        // Ensure mount point exists with correct ownership & permissions
        const dirMode = mode ?? 0o755;
        if (!this.bkfs.exists(vfsPath)) {
          this.bkfs.mkdir(vfsPath, uid ?? 0, gid ?? 0, dirMode);
        } else {
          if (uid !== undefined || gid !== undefined) {
            // Re-apply ownership if dir already existed (e.g. created by ensureDefaultAuth)
            this.bkfs.chown(vfsPath, uid ?? 0, gid ?? 0);
          }
          if (mode !== undefined) {
            this.bkfs.chmod(vfsPath, dirMode);
          }
        }

        let driver: IVFS;
        if (type === "bkfs") {
          driver = new BKFS(
            path.resolve(process.cwd(), hostPath),
            readOnly || false,
            uid,
            gid,
            dirMode,
          );
        } else if (type === "ramfs") {
          // RamFS tidak butuh hostPath — murni di RAM
          const label = vfsPath.replace(/\//g, "_").replace(/^_/, "");
          driver = new RamFS(label, uid, gid, dirMode);
        } else {
          driver = new HostVFS(hostPath, readOnly || false, uid, gid, dirMode);
        }

        this.bootLogStart(`FSTAB: Mounting ${vfsPath} (${type})`);
        this.mountManager.mount(
          vfsPath,
          driver,
          type,
          hostPath,
          readOnly || false,
          uid,
          gid,
        );
        this.bootLogEnd(true);
      }
    } catch (e: any) {
      this.bootLog(`FSTAB: Error processing fstab: ${e.message}`, false);
    }
}
```

---

## Exercises / Practice

1. Run `mount` (or `cat /proc/mounts` if available) — observe the list of mount points and their order.
2. Write a file in `/tmp/x` then reboot — does the file still exist? (RamFS = volatile)
3. Read `src/kernel/Kernel.ts` — find `initializeSubsystems()` (root mount) and `processFstab()` (fstab).
4. Compute the result of `MountManager.resolve()` for `/mnt/shared/../sbak/x` before running it. Compare with real behavior.
5. Modify `resolve()` to log the resolved path, then open a file from the shell.

---

## References

- `wiki/Virtual-File-System.md` — VFS layer
- `wiki/course/00-overview.en.md` §4.4
- `src/kernel/MountManager.ts`, `src/common/PathResolver.ts`
- `src/kernel/Kernel.ts` — `initializeSubsystems()` & `processFstab()`
- `src/mirror/etc/fstab.json` — default mount list

---

*Module 07 — done. Part II complete. Continue to [Module 08 — VFS](08-vfs.en.md).*
