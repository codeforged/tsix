---
module: 07
title: Mount & Path Resolution
part: II
partTitle: Boot & Kernel Runtime
status: done
lang: id
rfc: RFC-TSIX-EDU-002
audience: all
---

# Mount & Path Resolution

**RFC-TSIX-EDU-002** | Modul ketujuh kurikulum TSIX. Memahami bagaimana path VFS dirutekan ke backend filesystem yang tepat — dengan prinsip **prefix terpanjang menang**.

> MountManager adalah "router path". Saat aplikasi membuka `/tmp/foo`, kernel harus tahu bahwa itu milik RamFS, bukan BKFS. Aturannya sederhana: **prefix terpanjang yang cocok adalah pemenangnya.**

---

## Tujuan Pembelajaran

- [ ] Menjelaskan struktur `MountPoint`
- [ ] Menjelaskan prinsip "prefix terpanjang menang"
- [ ] Menjelaskan isi `fstab.json` (mount default)
- [ ] Membedakan resolve via MountManager vs device `/dev/*`
- [ ] Menjelaskan peran `PathResolver`
- [ ] Melakukan walkthrough `PathResolver.resolve()` untuk path relatif, absolut, `.` dan `..`
- [ ] Memprediksi hasil `resolve()` dengan membaca urutan sortir mount

---

## Konsep Inti

### Dua lapis resolusi

Resolusi path di TSIX berjalan dua lapis:

1. **`PathResolver.resolve()`** — menormalisasi path string. Ia hanya memproses teks (`//`, `.`, `..`), tanpa tahu soal filesystem.
2. **`MountManager.resolve()`** — merutekan path ternormalisasi ke backend `IVFS` yang tepat, dengan aturan "prefix terpanjang menang".

> [!IMPORTANT]
> `PathResolver` bekerja di level **string**. `MountManager` bekerja di level **backend filesystem**. Keduanya adalah fungsi yang berbeda.

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

> `type` memakai nilai nyata dari `fstab.json`: `"bkfs"`, `"ramfs"`, dan `"host"` (HostVFS).

### PathResolver.resolve() — walkthrough

`PathResolver.resolve(cwd, targetPath)` menerima dua argumen: direktori kerja (`cwd`) dan path target. Hasilnya selalu path absolut ternormalisasi (tanpa `//`, `.`, atau `..`).

| # | `cwd` | `targetPath` | Hasil | Penjelasan |
|---|---|---|---|---|
| 1 | `/` | `/etc/passwd` | `/etc/passwd` | Path absolut — `cwd` diabaikan |
| 2 | `/` | `etc/passwd` | `/etc/passwd` | Path relatif di-root |
| 3 | `/bin` | `../etc/passwd` | `/etc/passwd` | `..` naik satu level keluar dari `/bin` |
| 4 | `/home/user` | `docs/../a.txt` | `/home/user/a.txt` | `..` membatalkan segmen `docs` |
| 5 | `/` | `/tmp/./foo//bar` | `/tmp/foo/bar` | `//` dan `.` dibersihkan |
| 6 | `/` | `/../x` | `/x` | `..` di atas root tidak bisa naik lagi |

> [!NOTE]
> Contoh 4 dan 5 menunjukkan bahwa normalisasi terjadi **sebelum** pencarian mount. Jadi `resolve("/tmp/./foo")` dan `resolve("/tmp/foo")` dianggap sama oleh `MountManager`.

### Mount default

Root `/` **tidak** ada di `fstab.json`. Ia di-mount langsung di `initializeSubsystems()`:

```ts
this.mountManager.mount("/", this.bkfs, "bkfs", cfg.kernel.database, false);
```

`cfg.kernel.database` bernilai `"system.db"` (lihat `src/sysconfig.json`). Sisanya dimuat dari `src/mirror/etc/fstab.json` oleh `processFstab()`:

| Path | type | Backend | Sumber | readOnly | uid/gid | mode | Sifat |
|---|---|---|---|---|---|---|---|
| `/` | `bkfs` | BKFS (SQLite) | `system.db` | false | — | — | persisten, root fs |
| `/tmp` | `ramfs` | RamFS | in-memory (hostPath `"RAM"` diabaikan) | false | 0/100 | `0o1777` | volatile, sticky |
| `/mnt/shared` | `host` | HostVFS | folder host `shared` | false | 1000/100 | `0o775` | bridge host, anti-escape |
| `/mnt/sbak` | `bkfs` | BKFS | `systembak.db` | false | 1000/100 | `0o775` | backup DB |

> [!NOTE]
> `fstab.json` hanya memuat `/tmp`, `/mnt/shared`, dan `/mnt/sbak`. Entry `/tmp` memakai `active: true`; sisanya default aktif. Mode `1023` = `0o1777` (sticky, semua bisa tulis — khas `/tmp`), `509` = `0o775`.

### Resolve: prefix terpanjang menang

Setelah semua mount terpasang, daftar di-sort **descending by panjang path**. Urutan hasil sortir untuk mount default:

```
/mnt/shared  (11)   ← diperiksa dulu
/mnt/sbak    ( 9)
/tmp         ( 4)
/            ( 1)   ← fallback terakhir
```

Contoh kerja `MountManager.resolve()`:

| Path diminta | MountPoint terpilih | `relativePath` | vfs |
|---|---|---|---|
| `/tmp/a.txt` | `/tmp` | `/a.txt` | RamFS |
| `/tmp` | `/tmp` (exact) | `/` | RamFS |
| `/etc/passwd` | `/` | `/etc/passwd` | BKFS |
| `/mnt/shared/readme.md` | `/mnt/shared` | `/readme.md` | HostVFS |
| `/mnt/shared` | `/mnt/shared` (exact) | `/` | HostVFS |
| `/mnt/sbak/backup.tar` | `/mnt/sbak` | `/backup.tar` | BKFS |
| `/mnt/sharedx/foo` | `/` | `/mnt/sharedx/foo` | BKFS |

> [!WARNING]
> Baris terakhir adalah gotcha penting. `/mnt/sharedx/foo` **tidak** cocok dengan prefix `/mnt/shared/` (karena setelah `shared` ada `x`, bukan `/`). Karena itu ia jatuh ke `/` → BKFS. Inilah kenapa prefix memakai slash tambahan (`m.vfsPath + "/"`), bukan sekadar `startsWith(m.vfsPath)`.

![Resolusi path: syscall → MountManager → backend VFS](/wiki/diagram/Home-2.png)
*Sumber: [`wiki/diagram/Home-2.mmd`](/wiki/diagram/Home-2.mmd)*

### Path `/dev/*` tidak lewat MountManager

Path `dev/xxx` di-handle oleh **HAL** (`kernel.devices[xxx]`), bypass MountManager. Ini konsisten dengan prinsip "everything is a file" — device bukan vnode filesystem.

## Alur / Cara Kerja

### Alur mount saat boot

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

### Alur resolve saat syscall file

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

## Kode Sumber

| File | Peran |
|---|---|
| `src/kernel/MountManager.ts` | mount/unmount/resolve/listMounts |
| `src/common/PathResolver.ts` | Normalisasi path (`//`, `.`, `..`) |
| `src/kernel/Kernel.ts` | `initializeSubsystems()` + `processFstab()` saat boot |
| `src/mirror/etc/fstab.json` | Daftar mount default |
| `src/vfs/HostVFS.ts`, `RamFS.ts`, `BKFS.ts` | Backend |

---

## Snippet (level kode)

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
> `mount()` men-sort hanya saat entry **baru** ditambahkan. Jika path sudah ada, `mount()` mengganti backend-nya tanpa menyentuh urutan sortir.

### Root mount di initializeSubsystems()

```ts
this.bkfs = new BKFS(cfg.kernel.database);
this.mountManager.mount("/", this.bkfs, "bkfs", cfg.kernel.database, false);
```

### processFstab() — loop pemrosesan fstab

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

## Latihan / Praktik

1. Jalankan `mount` (atau `cat /proc/mounts` jika ada) — amati daftar mount point dan urutannya.
2. Tulis file di `/tmp/x` lalu reboot — apakah file masih ada? (RamFS = volatile)
3. Baca `src/kernel/Kernel.ts` — cari `initializeSubsystems()` (root mount) dan `processFstab()` (fstab).
4. Hitung hasil `MountManager.resolve()` untuk `/mnt/shared/../sbak/x` sebelum menjalankannya. Cocokkan dengan perilaku nyata.
5. Ubah `resolve()` agar log path yang di-resolve, lalu buka file dari shell.

---

## Referensi

- `wiki/Virtual-File-System.md` — lapisan VFS
- `wiki/course/00-overview.md` §4.4
- `src/kernel/MountManager.ts`, `src/common/PathResolver.ts`
- `src/kernel/Kernel.ts` — `initializeSubsystems()` & `processFstab()`
- `src/mirror/etc/fstab.json` — daftar mount default

---

*Modul 07 — selesai. Bagian II tuntas. Lanjut ke [Modul 08 — VFS](08-vfs.md).*
