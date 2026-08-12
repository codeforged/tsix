---
module: 23
title: Development Workflow
part: VIII
partTitle: Pengembangan
status: done
lang: id
rfc: RFC-TSIX-EDU-002
audience: all
---

# Development Workflow

**RFC-TSIX-EDU-002** | Modul kedua puluh tiga kurikulum TSIX. Memahami siklus host↔VFS: install, vfs-bootstrap, sync-vfs, vfs-pull, SYNC_TO_HOST, userlib-update, dan SDK mirroring.

> TSIX punya dua dunia: **host** (folder `src/mirror` + `src/common` di repo) dan **VFS** (file database, path-nya dibaca dari `kernel.database` di `src/sysconfig.json`, default `system.db`). Developer menulis di host, lalu menyinkronkan ke VFS. Ada juga jalur sebaliknya — aplikasi di dalam VFS menulis kembali ke host (root-only).

---

## Tujuan Pembelajaran

- [ ] Menjelaskan siklus host ↔ VFS
- [ ] Membedakan `install`, `vfs-bootstrap`, `sync-vfs`, `vfs-pull`
- [ ] Menjelaskan `SYNC_TO_HOST` (syscall)
- [ ] Menjelaskan `userlib-update` (SDK mirroring)
- [ ] Menjelaskan peran tsconfig paths (`@tsix/*`)

---

## Konsep Inti

### Dua dunia: host vs VFS

- **Host** — tempat menulis kode: `src/mirror/` (rootfs: `bin`, `lib`, `etc`, `sbin`, ...) dan `src/common/` (framework: `SyscallCode`, `IPCTypes`, `GUITypes`).
- **VFS** — filesystem yang di-boot kernel: file database `system.db` (BKFS/SQLite). Kernel membaca path-nya dari `kernel.database`.
- **`src/root/`** — hasil `vfs-pull`: salinan VFS di host untuk inspeksi / perubahan permanen.

Semua script host mengambil path DB lewat `scripts/lib/db-path.ts`, agar nilainya selalu sinkron dengan path hasil instalasi.

> [!IMPORTANT]
> Sejak `install.ts` ada, fresh install **tidak perlu** menjalankan `vfs:bootstrap` terpisah — installer sudah melakukan seluruh sync rootfs sendiri.

### Tabel script & arah sinkronisasi

| Perintah | File | Arah | Kegunaan |
|---|---|---|---|
| `npm run install` | `scripts/install.ts` | host → DB | Fresh install interaktif: buat DB baru + tulis `sysconfig.json` + sync rootfs penuh |
| `npm run vfs:bootstrap` | `scripts/vfs-bootstrap.ts` | host → DB | Bulk sync `src/mirror` → `/` dan `src/common` → `/lib/common` |
| `npx ts-node scripts/sync-vfs.ts <path>` | `scripts/sync-vfs.ts` | host → DB | Sync satu file (dipasang di VS Code "run on save") |
| `npm run vfs:pull` | `scripts/vfs-pull.ts` | DB → host | Tarik seluruh VFS → `src/root` (kecuali folder runtime) |
| syscall `SYNC_TO_HOST` (53) | `src/kernel/Syscalls.ts` | DB → host | Root-only: tulis satu file VFS ke host (terbatas dalam project root) |
| `sudo userlib-update` | `src/mirror/sbin/userlib-update.ts` | DB → host | Di dalam TSIX: sync `/lib` → `src/.tsix_sdk/lib` |
| `npm run bkfs:create` | `scripts/create-bkfs.ts` | — | Buat DB kosong (opsional skeleton direktori standar) |

### Konfigurasi bersama

- `src/sysconfig.json` — `kernel.database` (path DB), `kernel.rootHostPath`, `scheduler.workerEntryPath`, `scheduler.bootEntry`, `network.interfaces`.
- `tsconfig.json` — `@tsix/*` → `src/.tsix_sdk/lib/*`, `src/root/lib/*`, `src/mirror/lib/*`; `@common/*` → `src/common/*`; `@bin/*` → `src/root/bin/*`, `src/.tsix_sdk/bin/*`.

> [!NOTE]
> Tidak ada sinkronisasi otomatis host → VFS saat boot. Host adalah "permukaan penulisan"; VFS adalah sumber kebenaran runtime. Perubahan dipindahkan lewat script/syscall di atas.

---

## Alur / Cara Kerja

### Diagram siklus host ↔ VFS

```
         HOST  (repo TSIX di VS Code)
┌─────────────────────────────────────────────────────┐
│ src/mirror     (rootfs: bin, lib, etc, sbin, ...)   │
│ src/common     (framework: SyscallCode, IPCTypes)   │
│ src/sysconfig.json  -> kernel.database              │
└───────┬──────────────────────────────▲──────────────┘
        │ host → DB                    │ DB → host
        │                              │
  install / vfs:bootstrap              vfs:pull
  sync-vfs (satu file)                 SYNC_TO_HOST (syscall, root)
        │                              │
        ▼                              │
┌───────────────  VFS  ────────────────┘
│ system.db  (BKFS / SQLite)           │
│   /bin /sbin /usr/bin  (exec+setuid) │
│   /lib/common  <- src/common         │
│   /etc: passwd shadow group          │
│         crontab fstab.json           │
│   /tmp  -> ramfs (volatile)          │
└──────────────────────────────────────┘
```

### sysconfig → db-path → scripts

```
src/sysconfig.json  (kernel.database)
        │  getDefaultDbPath()
        ▼
scripts/lib/db-path.ts
        │
        ├── install.ts        (menulis kernel.database baru)
        ├── vfs-bootstrap.ts  (bulk sync host → DB)
        ├── sync-vfs.ts       (sync satu file host → DB)
        ├── vfs-pull.ts       (pull DB → src/root)
        └── create-bkfs.ts    (buat DB kosong)
```

### 1. Fresh install (`npm run install`)

1. Tanya konfigurasi interaktif: hostname, default user login, broker MQTT, address per-interface, port MQTT default, verbose kernel, path DB baru, (opsional) password root.
2. Tulis hasil ke `src/sysconfig.json` (menyimpan `kernel.database` baru).
3. Buat file `.db` baru. Jika file sudah ada dan tanpa `--force` → berhenti; dengan `--force` → file lama di-backup ke `*.bak-<timestamp>`.
4. Sync rootfs: `src/mirror` → `/`, lalu `src/common` → `/lib/common`. Setiap `.ts` di-transpile jadi sidecar `.js`; direktori eksekusi diberi mode eksekusi (`/sbin` = `0744`, lainnya `0755`); `login`, `passwd`, `sudo` diberi SetUID (`4755` root).
5. Sync eksplisit file `/etc` tanpa ekstensi: `passwd`, `shadow` (mode `0640`), `group`, `crontab`, `profile`, `motd`, `fstab.md`, `pkg-demo.conf`.
6. Tulis `fstab.json` fresh — hanya `/tmp` sebagai ramfs (mode `1777` sticky); mount dev-spesifik tidak dibawa.
7. Kosongkan `/etc/crontab`.
8. Jika password root diisi → di-hash bcrypt dan ditulis ke `/etc/shadow`.
9. Verifikasi: total node, jumlah akun `passwd`, daftar group, entri `shadow`.

```bash
npm run install                              # interaktif, path dari sysconfig
npm run install -- --path data/tsix.db       # path database tertentu
npm run install -- --path data/tsix.db --force   # timpa (auto-backup)
npm run install -- --defaults                # non-interaktif, semua default
npm run install -- --no-config               # skip tulis sysconfig.json
```

### 2. Bulk sync (`npm run vfs:bootstrap`)

Sinkronisasi massal `src/mirror` → `/` dan `src/common` → `/lib/common`. Berguna untuk instalasi awal perangkat atau setelah banyak edit sekaligus.

```bash
npm run vfs:bootstrap                  # DB default dari sysconfig
npm run vfs:bootstrap -- data/test.db  # path lain (posisi argumen)
```

### 3. Sync satu file (`sync-vfs`)

Untuk satu file cepat (mis. saat save di editor). Pemetaan path: `src/mirror/*` → `/*`, `src/common/*` → `/common/*`. File `.ts` ikut di-transpile ke sidecar `.js`.

```bash
npx ts-node scripts/sync-vfs.ts src/mirror/bin/hello.ts
```

### 4. Pull balik (`npm run vfs:pull`)

Menarik seluruh VFS → `src/root`, dengan pemetaan: `/etc/*` → `src/root/etc/*`, `/root/*` → `src/root/home/root/*`, lainnya → `src/root/<path>`. Folder runtime dikecualikan: `dev`, `tmp`, `proc`, `logs`, `var`.

```bash
npm run vfs:pull
```

### 5. Syscall `SYNC_TO_HOST` (di dalam TSIX)

Aplikasi di dalam VFS (root) bisa menulis file ke host lewat syscall `SYNC_TO_HOST`. `userlib-update` dan `vfs-pull` (versi `sbin`) memakainya.

```bash
# dari shell TSIX, sebagai root
sudo userlib-update   # sync /lib → src/.tsix_sdk/lib
vfs-pull              # tarik seluruh VFS → host root
```

---

## Kode Sumber

- `scripts/install.ts` — fresh install agent (host → DB).
- `scripts/vfs-bootstrap.ts` — bulk sync host → DB.
- `scripts/sync-vfs.ts` — sync satu file host → DB.
- `scripts/vfs-pull.ts` — tarik DB → `src/root`.
- `scripts/create-bkfs.ts` — buat DB kosong.
- `scripts/lib/db-path.ts` — path DB bersama dari `sysconfig`.
- `src/kernel/Syscalls.ts` — implementasi `SYNC_TO_HOST` / `SYNC_FROM_HOST`.
- `src/mirror/lib/UserLib.ts` — `syncToHost()` / `syncFromHost()`.
- `src/mirror/sbin/userlib-update.ts`, `src/mirror/sbin/vfs-pull.ts` — perintah di dalam TSIX.

---

## Snippet (level kode)

### Path DB bersama (`scripts/lib/db-path.ts`)

```ts
export function getDefaultDbPath(): string {
  const configPath = path.resolve(__dirname, "../../src/sysconfig.json");
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const cfg = JSON.parse(raw);
    if (cfg && typeof cfg.kernel === "object" && cfg.kernel.database) {
      return String(cfg.kernel.database);
    }
  } catch (_) {
    /* abaikan — pakai fallback */
  }
  return "system.db";
}
```

### Mode eksekusi & SetUID (`isSetuidBinary` / `applyBinaryMode`)

```ts
const EXEC_DIRS = ["/bin", "/sbin", "/usr/bin", "/usr/local/bin"];

function isSetuidBinary(vfsPath: string): boolean {
  return /\/bin\/(login|passwd|sudo)\.(ts|js)$/.test(vfsPath);
}

function isExecutableBinary(vfsPath: string): boolean {
  return EXEC_DIRS.some((d) => vfsPath.startsWith(d + "/"));
}

function applyBinaryMode(bkfs: BKFS, vfsPath: string, label = "INSTALL"): void {
  if (isSetuidBinary(vfsPath)) {
    bkfs.chmod(vfsPath, 0o4755);   // setuid root
    bkfs.chown(vfsPath, 0, 0);
  } else if (isExecutableBinary(vfsPath)) {
    // /sbin = root-only (0o744), lainnya 0o755
    bkfs.chmod(vfsPath, vfsPath.startsWith("/sbin/") ? 0o744 : 0o755);
  }
}
```

### `syncDir` rekursif (`vfs-bootstrap.ts`, identik di `install.ts`)

```ts
const syncDir = (hostDir: string, vfsDir: string) => {
  if (!bkfs.exists(vfsDir)) bkfs.mkdir(vfsDir, 0, 0, 0o755);
  const items = fs.readdirSync(hostDir);
  for (const item of items) {
    const fullHostPath = path.join(hostDir, item);
    const fullVfsPath = path.join(vfsDir, item).replace(/\\/g, "/");
    const stats = fs.statSync(fullHostPath);

    if (stats.isDirectory()) {
      syncDir(fullHostPath, fullVfsPath);
      continue;
    }

    const isTarget =
      item.endsWith(".ts") || item.endsWith(".js") ||
      item.endsWith(".json") || item.endsWith(".html") ||
      item.endsWith(".css") || item.endsWith(".menu") ||
      item.endsWith(".mp3") || item.endsWith(".wav");
    if (!isTarget) continue;

    // Binary (mp3/wav) disimpan sebagai latin1
    const isBinary = item.endsWith(".mp3") || item.endsWith(".wav");
    const content = isBinary
      ? fs.readFileSync(fullHostPath).toString("latin1")
      : fs.readFileSync(fullHostPath, "utf8");
    bkfs.touch(fullVfsPath, content);

    // Transpile TS → JS sidecar (yang dieksekusi runtime)
    if (fullVfsPath.endsWith(".ts")) {
      const result = esbuild.transformSync(content, {
        loader: "ts", format: "cjs", target: "node18", sourcemap: "inline",
      });
      if (result.code) {
        const jsPath = fullVfsPath.substring(0, fullVfsPath.length - 3) + ".js";
        bkfs.touch(jsPath, result.code);
        if (isSetuidBinary(jsPath) || isExecutableBinary(jsPath)) {
          applyBinaryMode(bkfs, jsPath);
        }
      }
    }

    if ((isSetuidBinary(fullVfsPath) || isExecutableBinary(fullVfsPath)) &&
        (fullVfsPath.endsWith(".ts") || fullVfsPath.endsWith(".js"))) {
      applyBinaryMode(bkfs, fullVfsPath);
    }
  }
};
```

### Alur `install.ts` (diringkas dari sumber)

```ts
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const dbRel = opts.dbPath || cfg.kernel.database || "system.db";
  let rootPassword = "";

  // 1. Konfigurasi interaktif → cfg (hostname, user, broker, port, verbose, db path, root password)
  // 2. Tulis src/sysconfig.json
  if (opts.writeConfig) {
    cfg.kernel.database = path.relative(PROJECT_ROOT, dbPath).replace(/\\/g, "/");
    saveConfig(cfg);
  }
  // 3. Buat DB baru (file lama di-backup bila --force)
  const bkfs = new BKFS(dbPath);
  // 4. Sync rootfs
  syncDir(bkfs, MIRROR_ROOT, "/");            // src/mirror → /
  syncDir(bkfs, COMMON_ROOT, "/lib/common");  // src/common → /lib/common
  // 5. fstab fresh (hanya /tmp ramfs), crontab kosong, password root opsional
  // 6. Verifikasi & tutup DB
}
```

### Syscall `SYNC_TO_HOST` (`src/kernel/Syscalls.ts`)

```ts
case SyscallCode.SYNC_TO_HOST: {
  if (!this.isRoot(pcb))
    throw new Error("Permission Denied: Only root or root group members can perform physical sync.");
  const { vfsPath, hostPath } = args;

  // Keamanan: hostPath tidak boleh keluar dari project root
  const projectRoot = process.cwd();
  const absoluteHostPath = path.resolve(projectRoot, hostPath);
  if (!absoluteHostPath.startsWith(projectRoot)) {
    throw new Error("Security Violation: Target path is outside project root.");
  }

  const { vfs, relativePath } = this.mountManager.resolve(vfsPath);
  const content = vfs.read(relativePath);
  if (content === null) throw new Error(`Source file not found in VFS: ${vfsPath}`);

  const parentDir = path.dirname(absoluteHostPath);
  if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(absoluteHostPath, content);
  this.logger.info(`[SYNC] Applied VFS:${vfsPath} -> HOST:${hostPath}`);
  return true;
}
```

### `UserLib.syncToHost` (`src/mirror/lib/UserLib.ts`)

```ts
public async syncToHost(vfsPath: string, hostPath: string): Promise<boolean> {
  return await this.dispatch(SyscallCode.SYNC_TO_HOST, { vfsPath, hostPath });
}
```

---

## Latihan / Praktik

1. Jalankan `npm run install -- --defaults` — periksa `src/sysconfig.json` ter-tulis dan DB baru ter-buat, lalu `npm start`.
2. Jalankan `npm run install` (interaktif) — isi hostname & user login, set password root, amati sync per file.
3. Tulis app baru di `src/mirror/bin/`, lalu `npm run vfs:bootstrap` — jalankan app di shell TSIX.
4. Ubah satu file lalu `npx ts-node scripts/sync-vfs.ts src/mirror/bin/<file>.ts` — bandingkan kecepatannya vs bootstrap penuh.
5. Ubah file di VFS (dari shell TSIX), lalu `npm run vfs:pull` — cek perubahan muncul di `src/root`.
6. Baca `wiki/Memulai.md` — ikuti alur mulai dari nol.

---

## Referensi

- `wiki/Memulai.md`, `wiki/Panduan-Developer.md`
- `wiki/course/00-overview.md` §11 (Alur Pengembangan / Sync VFS)
- `wiki/Virtual-File-System.md` — Sinkronisasi VFS ↔ Host
- `scripts/install.ts`, `scripts/vfs-bootstrap.ts`, `scripts/sync-vfs.ts`, `scripts/vfs-pull.ts`, `scripts/create-bkfs.ts`, `scripts/lib/db-path.ts`
- `src/kernel/Syscalls.ts`, `src/mirror/lib/UserLib.ts`, `src/mirror/sbin/userlib-update.ts`, `src/mirror/sbin/vfs-pull.ts`

---

*Modul 23 — selesai. Lanjut ke [Modul 24 — Best Practices & Penulisan App](24-best-practices.md).*
