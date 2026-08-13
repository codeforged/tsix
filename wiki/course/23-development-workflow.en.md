---
module: 23
title: Development Workflow
part: VIII
partTitle: Development
status: done
lang: en
rfc: RFC-TSIX-EDU-002
audience: all
---

# Development Workflow

**RFC-TSIX-EDU-002** | Twenty-third module of the TSIX curriculum. Understand the host↔VFS cycle: install, vfs-bootstrap, sync-vfs, vfs-pull, SYNC_TO_HOST, userlib-update, and SDK mirroring.

> TSIX has two worlds: the **host** (`src/mirror` + `src/common` folders in the repo) and the **VFS** (file database, its path is read from `kernel.database` in `src/sysconfig.json`, default `system.db`). Developers write on the host, then sync to the VFS. There is also the reverse path — applications inside the VFS write back to the host (root-only).

---

## Learning Objectives

- [ ] Explain the host ↔ VFS cycle
- [ ] Distinguish `install`, `vfs-bootstrap`, `sync-vfs`, `vfs-pull`
- [ ] Explain `SYNC_TO_HOST` (syscall)
- [ ] Explain `userlib-update` (SDK mirroring)
- [ ] Explain the role of tsconfig paths (`@tsix/*`)

---

## Core Concepts

### Two worlds: host vs VFS

- **Host** — the place to write code: `src/mirror/` (rootfs: `bin`, `lib`, `etc`, `sbin`, ...) and `src/common/` (framework: `SyscallCode`, `IPCTypes`, `GUITypes`).
- **VFS** — the filesystem booted by the kernel: the file database `system.db` (BKFS/SQLite). The kernel reads its path from `kernel.database`.
- **`src/root/`** — the result of `vfs-pull`: a copy of the VFS on the host for inspection / permanent changes.

All host scripts get the DB path via `scripts/lib/db-path.ts`, so its value is always in sync with the installed path.

> [!IMPORTANT]
> Since `install.ts` exists, a fresh install **does not need** a separate `vfs:bootstrap` run — the installer already performs the whole rootfs sync itself.

### Script table & sync direction

| Command | File | Direction | Purpose |
|---|---|---|---|
| `npm run install` | `scripts/install.ts` | host → DB | Interactive fresh install: create new DB + write `sysconfig.json` + full rootfs sync |
| `npm run vfs:bootstrap` | `scripts/vfs-bootstrap.ts` | host → DB | Bulk sync `src/mirror` → `/` and `src/common` → `/lib/common` |
| `npx ts-node scripts/sync-vfs.ts <path>` | `scripts/sync-vfs.ts` | host → DB | Sync one file (wired to VS Code "run on save") |
| `npm run vfs:pull` | `scripts/vfs-pull.ts` | DB → host | Pull the whole VFS → `src/root` (except runtime folders) |
| syscall `SYNC_TO_HOST` (53) | `src/kernel/Syscalls.ts` | DB → host | Root-only: write one VFS file to the host (limited to project root) |
| `sudo userlib-update` | `src/mirror/sbin/userlib-update.ts` | DB → host | Inside TSIX: sync `/lib` → `src/.tsix_sdk/lib` |
| `npm run bkfs:create` | `scripts/create-bkfs.ts` | — | Create an empty DB (optional standard directory skeleton) |

### Shared configuration

- `src/sysconfig.json` — `kernel.database` (DB path), `kernel.rootHostPath`, `scheduler.workerEntryPath`, `scheduler.bootEntry`, `network.interfaces`.
- `tsconfig.json` — `@tsix/*` → `src/.tsix_sdk/lib/*`, `src/root/lib/*`, `src/mirror/lib/*`; `@common/*` → `src/common/*`; `@bin/*` → `src/root/bin/*`, `src/.tsix_sdk/bin/*`.

> [!NOTE]
> There is no automatic host → VFS sync at boot. The host is the "writing surface"; the VFS is the runtime source of truth. Changes are moved via the scripts/syscalls above.

---

## Flow / How It Works

### Host ↔ VFS cycle diagram

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

1. Ask interactive configuration: hostname, user account (optional: username, password, confirm), MQTT broker, per-interface address, default MQTT port, kernel verbose, new DB path, (optional) root password.
2. Write the result to `src/sysconfig.json` (stores the new `kernel.database`).
3. Create a new `.db` file. If the file already exists and without `--force` → stop; with `--force` → the old file is backed up to `*.bak-<timestamp>`.
4. Sync rootfs: `src/mirror` → `/`, then `src/common` → `/lib/common`. Each `.ts` is transpiled to a sidecar `.js`; executable directories get execute mode (`/sbin` = `0744`, others `0755`); `login`, `passwd`, `sudo` get SetUID (`4755` root).
5. Sync explicit `/etc` files without extension: `passwd`, `shadow` (mode `0640`), `group`, `crontab`, `profile`, `motd`, `fstab.md`, `pkg-demo.conf`.
6. Write a fresh `fstab.json` — only `/tmp` as ramfs (mode `1777` sticky); device-specific mounts are not carried over.
7. Clear `/etc/crontab`.
8. If a user account was provided → add an entry to `/etc/passwd` + `/etc/shadow` (bcrypt) + `users` group, then create `/home/<username>` (mode `0700`, owned by the user).
9. If a root password is provided → it is bcrypt-hashed and written to `/etc/shadow`.
10. Verify: total nodes, number of `passwd` accounts, group list, `shadow` entries.

```bash
npm run install                              # interaktif, path dari sysconfig
npm run install -- --path data/tsix.db       # path database tertentu
npm run install -- --path data/tsix.db --force   # timpa (auto-backup)
npm run install -- --defaults                # non-interaktif, semua default
npm run install -- --no-config               # skip tulis sysconfig.json
```

### 2. Bulk sync (`npm run vfs:bootstrap`)

Mass sync of `src/mirror` → `/` and `src/common` → `/lib/common`. Useful for the initial device installation or after many edits at once.

```bash
npm run vfs:bootstrap                  # DB default dari sysconfig
npm run vfs:bootstrap -- data/test.db  # path lain (posisi argumen)
```

### 3. Sync one file (`sync-vfs`)

For one quick file (e.g. on save in the editor). Path mapping: `src/mirror/*` → `/*`, `src/common/*` → `/common/*`. `.ts` files are also transpiled to a `.js` sidecar.

```bash
npx ts-node scripts/sync-vfs.ts src/mirror/bin/hello.ts
```

### 4. Pull back (`npm run vfs:pull`)

Pulls the entire VFS → `src/root`, with mapping: `/etc/*` → `src/root/etc/*`, `/root/*` → `src/root/home/root/*`, others → `src/root/<path>`. Runtime folders are excluded: `dev`, `tmp`, `proc`, `logs`, `var`.

```bash
npm run vfs:pull
```

### 5. Syscall `SYNC_TO_HOST` (inside TSIX)

Applications inside the VFS (root) can write files to the host via the `SYNC_TO_HOST` syscall. `userlib-update` and `vfs-pull` (the `sbin` version) use it.

```bash
# dari shell TSIX, sebagai root
sudo userlib-update   # sync /lib → src/.tsix_sdk/lib
vfs-pull              # tarik seluruh VFS → host root
```

---

## Source Code

- `scripts/install.ts` — fresh install agent (host → DB).
- `scripts/vfs-bootstrap.ts` — bulk sync host → DB.
- `scripts/sync-vfs.ts` — sync one file host → DB.
- `scripts/vfs-pull.ts` — pull DB → `src/root`.
- `scripts/create-bkfs.ts` — create an empty DB.
- `scripts/lib/db-path.ts` — shared DB path from `sysconfig`.
- `src/kernel/Syscalls.ts` — `SYNC_TO_HOST` / `SYNC_FROM_HOST` implementation.
- `src/mirror/lib/UserLib.ts` — `syncToHost()` / `syncFromHost()`.
- `src/mirror/sbin/userlib-update.ts`, `src/mirror/sbin/vfs-pull.ts` — commands inside TSIX.

---

## Snippet (code level)

### Shared DB path (`scripts/lib/db-path.ts`)

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

### Execute mode & SetUID (`isSetuidBinary` / `applyBinaryMode`)

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

### Recursive `syncDir` (`vfs-bootstrap.ts`, identical in `install.ts`)

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

### `install.ts` flow (summarized from source)

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

## Exercises / Practice

1. Run `npm run install -- --defaults` — check `src/sysconfig.json` is written and a new DB is created, then `npm start`.
2. Run `npm run install` (interactive) — fill in hostname & user login, set the root password, observe the per-file sync.
3. Write a new app in `src/mirror/bin/`, then `npm run vfs:bootstrap` — run the app in the TSIX shell.
4. Change one file then `npx ts-node scripts/sync-vfs.ts src/mirror/bin/<file>.ts` — compare its speed vs the full bootstrap.
5. Change a file in the VFS (from the TSIX shell), then `npm run vfs:pull` — check the change appears in `src/root`.
6. Read `wiki/Memulai.md` — follow the flow starting from scratch.

---

## References

- `wiki/Memulai.md`, `wiki/Panduan-Developer.md`
- `wiki/course/00-overview.en.md` §11 (Development Flow / VFS Sync)
- `wiki/Virtual-File-System.md` — VFS ↔ Host Synchronization
- `scripts/install.ts`, `scripts/vfs-bootstrap.ts`, `scripts/sync-vfs.ts`, `scripts/vfs-pull.ts`, `scripts/create-bkfs.ts`, `scripts/lib/db-path.ts`
- `src/kernel/Syscalls.ts`, `src/mirror/lib/UserLib.ts`, `src/mirror/sbin/userlib-update.ts`, `src/mirror/sbin/vfs-pull.ts`

---

*Module 23 — done. Continue to [Module 24 — Best Practices & App Writing](24-best-practices.en.md).*
