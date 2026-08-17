---
module: 12
title: Module Resolution & DME
part: IV
partTitle: Process Isolation
status: done
lang: en
rfc: RFC-TSIX-EDU-002
audience: all
---

# Module Resolution & Direct Memory Execution

**RFC-TSIX-EDU-002** | The twelfth module of the TSIX curriculum. It uncovers one of the most "magical" parts of TSIX: the kernel pre-compiles `/lib` into memory, workers execute from memory with no disk hits, and the filename-alias trick keeps relative imports working.

> DME (Direct Memory Execution) is how TSIX loads the `@tsix/*` and `@common/*` frameworks **without touching the filesystem** at runtime. The kernel pre-compiles `/lib` once at boot, the cache is copied to each worker via `workerData`, then `WorkerEntry` compiles modules from an in-memory string with a **fake filename** (dummy filename) so relative imports keep working.

---

## Learning Objectives

- [ ] Explain the DME (Direct Memory Execution) concept
- [ ] Explain the `Module._load` hijack and the `@tsix/*` / `@common/*` alias rewrite
- [ ] Explain the dummy-filename trick for relative `./x` imports
- [ ] Explain the dual identity filename (physical vs BKFS)
- [ ] Explain `moduleCache` and why the framework feels instant
- [ ] Explain the difference between the TS-transpile and JS-Direct paths

---

## Core Concepts

### What is Direct Memory Execution

DME answers two problems:

1. **Performance** — a normal `require()` resolves and reads files from disk every time a module is loaded. For a framework used by every app, this is expensive. DME replaces disk reads with a **lookup in a JavaScript object** (`vfsCache`).
2. **Alias consistency** — every app must see the **exact same** framework (`@tsix/*` / `@common/*`) with the same behavior, regardless of the VFS backend.

```
┌─────────────────────────── KERNEL (boot sekali) ──────────────────────────┐
│                                                                          │
│  rebuildVFSCache()                                                       │
│    fetchDir("/lib")   ← rekursif dari BKFS                               │
│      baca /lib/UserLib.ts, /lib/emerald.ts, /lib/common/*.ts, ...        │
│      .ts → esbuild.transformSync() → JS (CJS, target node18)             │
│      simpan cache["/lib/...ts"] = kode JS  (objek di memori)             │
│                                                                          │
│  vfsCache = { "/lib/UserLib.ts": "…js…", "/lib/Application.ts": "…js…" } │
│                                                                          │
│  scheduler.setVFSCacheProvider(() => vfsCache)   ← snapshot per spawn    │
└────────────────────────────────────┬─────────────────────────────────────┘
                                     │  workerData.vfsCache (postMessage)
┌────────────────────────────────────▼─────────────────────────────────────┐
│  WORKER (WorkerEntry.ts — bootloader)                                   │
│                                                                          │
│  Module._load = hijack(request, parent, isMain)                          │
│    require("@tsix/UserLib")                                              │
│      → vfsPath = "/lib/UserLib.ts"                                       │
│      → vfsCache["/lib/UserLib.ts"] ketemu?  ──YA──▶                       │
│      → dummyFilename = "<cwd>/@tsix_UserLib.js"                          │
│      → new Module(dummyFilename, parent)                                 │
│      → _compile(kodeJS, dummyFilename)   ← compile dari MEMORI           │
│      → moduleCache["@tsix/UserLib"] = exports                            │
│      → return exports        (TANPA hit filesystem)                      │
│                                                                          │
│  require("@tsix/UserLib") berikutnya → moduleCache (cached)              │
└──────────────────────────────────────────────────────────────────────────┘
```

### Two cache layers: `vfsCache` vs `moduleCache`

| Cache | Where | Key | Content | Lifecycle |
|---|---|---|---|---|
| `vfsCache` | Kernel (`Kernel.ts`) | BKFS path (`/lib/*.ts`) | pre-compiled JS code | once per boot |
| `moduleCache` | per worker (`WorkerEntry.ts`) | alias (`@tsix/UserLib`) | module `exports` object | once per worker |

`vfsCache` only contains **code strings**. `moduleCache` contains **ready-to-use exports objects** — created by the worker the first time it loads a module. A framework file is pre-compiled once (by the kernel), but it is `_compile`d and cached once **per worker**.

### Alias and path mapping

| Alias | Rewritten to | vfsPath (vfsCache key) |
|---|---|---|
| `@tsix/UserLib` | — | `/lib/UserLib.ts` |
| `@tsix/emerald` | — | `/lib/emerald.ts` |
| `@common/GUITypes` | — | `/lib/common/GUITypes.ts` |
| `./UserLib` (parent `@tsix_*`) | `@tsix/UserLib` | `/lib/UserLib.ts` |
| `./GUITypes` (parent `@common_*`) | `@common/GUITypes` | `/lib/common/GUITypes.ts` |

> [!IMPORTANT]
> The `@tsix/X` → `/lib/X.ts` mapping always appends the `.ts` extension. That is why framework files in BKFS **must** be `.ts` — a convention enforced by `vfs-bootstrap`. The kernel also caches `.js`/`.json` files under `/lib`, but the DME `@tsix/*` path only targets `.ts`.

### Why this matters

1. **Performance: zero FS hits per require.** The framework is loaded once at boot, then executed from memory in every worker. Without DME, every app that does `import "@tsix/UserLib"` would have to read and re-compile the file from VFS — expensive for GUIs/daemons that must start fast.
2. **Alias consistency.** The relative rewrite `./x` → `@tsix/x` / `@common/x` ensures that internal framework code (e.g. `Application` using `UserLib`) always loads the **same instance** from the cache — no duplication of physical vs VFS paths.
3. **Single source of truth.** The kernel is the only one that reads `/lib` from BKFS. Workers have no direct access to the framework disk — this reinforces the sandbox boundary (see [Module 11](11-worker-thread-sandbox.en.md)).

> [!TIP]
> DME is an **architectural technique** that speeds up framework (`/lib`) execution — it complements, rather than replaces, TSIX's five core principles. For the list of core principles, see `wiki/course/00-overview.md` §1 and §6.2.

### Two app execution paths

| Path | Condition | Method |
|---|---|---|
| **DME (VFS)** | `appPath` empty, `appContent` present | `_compile` from a string; `.ts` files transpiled by esbuild in the worker |
| **Physical (host)** | `appPath` filled in | `hostRequire(finalAppPath)` — normal Node.js path, `-r esbuild-register` |

Type detection: `isTypeScript = !(appPath || appName || "").toLowerCase().endsWith(".js")`.

---

## Flow / How it works

1. **Kernel boot** (`Kernel.initializeSubsystems`) calls `rebuildVFSCache()`.
2. `rebuildVFSCache()` runs recursively (`fetchDir`) from `/lib` in BKFS; `.ts` files are transpiled by esbuild → `vfsCache`.
3. The kernel connects the scheduler: `scheduler.setVFSCacheProvider(() => vfsCache)`.
4. On `spawnWorker()`, the scheduler copies the cache: `vfsCache: this.vfsCacheProvider()` goes into `workerData`.
5. `new Worker(workerPath, { workerData, execArgv })` — a new thread with a cache snapshot.
6. `WorkerEntry.ts` (module scope) saves `originalLoad = Module._load`, then replaces `Module._load` with the hijacked version.
7. `main()` loads UserLib: `hijackRequire("@tsix/UserLib")` → through `Module._load` → vfsCache → `_compile` from memory.
8. The app is loaded via DME (if the content comes from VFS) or physically (if `appPath`).
9. The sandbox is enabled (`restrictHostAPI`) — see [Module 11](11-worker-thread-sandbox.en.md) — before the app runs.

---

## Source Code

| File | Role |
|---|---|
| `src/kernel/Kernel.ts` | `rebuildVFSCache()` — pre-compile `/lib` → `vfsCache` |
| `src/kernel/Scheduler.ts` | `setVFSCacheProvider()` + `spawnWorker()` — send the cache via `workerData` |
| `src/userland/WorkerEntry.ts` | Hijack `Module._load`, DME, dummy filename, dual identity |

---

## Snippets (code level)

### 1. Kernel: pre-compile `/lib` into memory

`rebuildVFSCache()` in `src/kernel/Kernel.ts` — copied exactly from the source:

```ts
private rebuildVFSCache() {
    this.bootLogStart(
      "VFS: Pre-compiling framework libraries (Memory Cache)... ",
    );
    try {
      const esbuild = require("esbuild");
      const cache: Record<string, string> = {};
      const fetchDir = (dir: string) => {
        if (!this.bkfs!.exists(dir)) return;
        const items = this.bkfs!.ls(dir);
        for (const item of items) {
          const p = `${dir}/${item.name}`;
          if (item.type === "DIRECTORY") {
            fetchDir(p);
          } else if (
            item.type === "FILE" &&
            (item.name.endsWith(".ts") ||
              item.name.endsWith(".js") ||
              item.name.endsWith(".json"))
          ) {
            let content = this.bkfs!.read(p);
            if (!content) continue;

            let code = content;

            // Transpile TS to JS for framework files
            if (item.name.endsWith(".ts")) {
              try {
                const result = esbuild.transformSync(code, {
                  loader: "ts",
                  format: "cjs",
                  target: "node18",
                  sourcemap: "inline",
                });
                code = result.code;
              } catch (err: any) {
                this.logger.error(`Failed to pre-compile ${p}: ${err.message}`);
              }
            }

            cache[p] = code;
          }
        }
      };
      fetchDir("/lib");
      this.vfsCache = cache;
      this.bootLogEnd(true, "OK");
    } catch (e: any) {
      this.bootLogEnd(false, `Error: ${e.message}`);
    }
  }
```

Things to note:

- `fetchDir` is **recursive** — it includes subfolders like `/lib/common/`.
- `.ts` files are transpiled via `esbuild.transformSync` (loader `ts`, format `cjs`, target `node18`). `.js`/`.json` files are copied as-is.
- The cache key = **BKFS path** (`/lib/UserLib.ts`), the value = **a JS code string**.

### 2. Kernel → Scheduler: cache channel

```ts
// Kernel.ts — saat boot
this.rebuildVFSCache();
this.scheduler.setVFSCacheProvider(() => {
  return this.vfsCache;
});

// Scheduler.ts — spawnWorker()
const workerData: WorkerInitData = {
    pid: pcb.pid,
    appName: options.appName || pcb.name,
    args: options.args || [],
    appPath: options.appPath,
    stackBkfsPath: options.stackBkfsPath,
    appContent: options.appContent,
    env: pcb.env,
    vfsCache: this.vfsCacheProvider ? this.vfsCacheProvider() : {}
};
```

`setVFSCacheProvider()` stores a *callback*, not a snapshot. Each `spawnWorker()` calls that callback to fetch the **current** cache and copy it into `workerData`.

### 3. Worker: hijack `Module._load` + dummy filename + `_compile`

In `src/userland/WorkerEntry.ts` — copied exactly from the source:

```ts
const originalLoad = Module._load;
const vfsCache = (workerData as any).vfsCache || {};
const moduleCache: Record<string, any> = {};

Module._load = function (request: string, parent: any, isMain: boolean) {
    let normalizedRequest = request;

    // Resolve relative paths
    if (request.startsWith(".")) {
        if (request.includes("/common/")) {
            normalizedRequest = "@common/" + request.split("/common/")[1];
        } else if (request.includes("/lib/")) {
            normalizedRequest = "@tsix/" + request.split("/lib/")[1];
        } else if (parent && parent.filename) {
            const basename = path!.basename(parent.filename);
            if (basename.startsWith("@tsix_") && request.startsWith("./")) {
                normalizedRequest = "@tsix/" + request.substring(2);
            } else if (basename.startsWith("@common_") && request.startsWith("./")) {
                normalizedRequest = "@common/" + request.substring(2);
            }
        }
    }

    // Cached Module
    if (moduleCache[normalizedRequest]) return moduleCache[normalizedRequest];

    // Resolusi Memory Framework (VFS)
    let vfsPath = null;
    if (normalizedRequest.startsWith("@tsix/")) {
        vfsPath = "/lib/" + normalizedRequest.substring(6) + ".ts";
    } else if (normalizedRequest.startsWith("@common/")) {
        vfsPath = "/lib/common/" + normalizedRequest.substring(8) + ".ts";
    }

    if (vfsPath && vfsCache[vfsPath]) {
        const content = vfsCache[vfsPath];
        const dummyFilename = path!.join(process.cwd(), normalizedRequest.replace("/", "_") + ".js");

        const newMod = new Module(dummyFilename, parent);
        newMod.filename = dummyFilename;
        newMod.paths = Module._nodeModulePaths(process.cwd());

        // Framework modules are now pre-compiled in Kernel.
        // Direct execution for maximum performance.
        (newMod as any)._compile(content, dummyFilename);

        moduleCache[normalizedRequest] = newMod.exports;
        return newMod.exports;
    }

    return originalLoad.apply(this, arguments);
};
```

The hijack steps, one by one:

1. **Normalize the request** — relative `./x` / `.../lib/x` paths are rewritten to aliases.
2. **Check `moduleCache`** — if already loaded, return exports directly (no re-compilation).
3. **Map alias → `vfsPath`** (`@tsix/X` → `/lib/X.ts`, `@common/X` → `/lib/common/X.ts`).
4. **Check `vfsCache`** — if found, take the JS code from memory.
5. **Dummy filename** — `<cwd>/@tsix_X.js` (see below).
6. **`_compile(content, dummyFilename)`** — Node.js compiles the module from a string, **without reading a file**.
7. **Save to `moduleCache`** and return `exports`.
8. If not in cache → **fallback** to `originalLoad.apply(...)` (normal Node.js path).

### 4. Dummy filename trick — framework module identity

The kernel only stores code in `vfsCache` keyed by the BKFS path (`/lib/UserLib.ts`). The `@tsix_*.js` names are **created when loaded in the worker**, not during pre-compilation:

```ts
const dummyFilename = path!.join(process.cwd(), normalizedRequest.replace("/", "_") + ".js");
```

| Alias | `replace("/", "_")` | dummyFilename (basename) |
|---|---|---|
| `@tsix/UserLib` | `@tsix_UserLib` | `<cwd>/@tsix_UserLib.js` |
| `@tsix/Application` | `@tsix_Application` | `<cwd>/@tsix_Application.js` |
| `@common/GUITypes` | `@common_GUITypes` | `<cwd>/@common_GUITypes.js` |

Why are the `@tsix_` / `@common_` prefixes important? Because relative rewrites inside the framework happen **based on the parent's `basename`**:

```ts
const basename = path!.basename(parent.filename);
if (basename.startsWith("@tsix_") && request.startsWith("./")) {
    normalizedRequest = "@tsix/" + request.substring(2);
}
```

This means that if `Application.ts` (loaded with filename `<cwd>/@tsix_Application.js`) does `import x from "./UserLib"`, then `./UserLib` → `@tsix/UserLib` → `/lib/UserLib.ts`. The alias cycle stays consistent across the whole framework. This is what makes `@tsix/*` look like an instant package.

> [!NOTE]
> So the "dual identity" of a framework module is: **content identity** = the BKFS path (`/lib/UserLib.ts`, the `vfsCache` key), while the **filename identity** seen by Node = the dummy path (`<cwd>/@tsix_UserLib.js`).

### 5. Dual identity filename for applications

When the worker loads an **app** via DME (the block in `main()`), two paths are created:

```ts
let content = (data as any).appContent;
const isTypeScript = !(appPath || appName || "").toLowerCase().endsWith(".js");
// Module filename HARUS physical path untuk require() nemu node_modules
const moduleFilename = path!.join(process.cwd(), appName + ".js");
// Stack filename = BKFS path biar stack trace bener (/opt/test/gui-test.js)
// stackBkfsPath = BKFS path untuk stack trace (/opt/test/gui-test.js)
const stackBkfsPath = (data as any).stackBkfsPath;
const stackFilename = stackBkfsPath
    ? stackBkfsPath.replace(/\.ts$/, '.js')
    : moduleFilename;
// sourcefile untuk esbuild sourcemap — cukup nama file aja (tanpa path)
const sourceFileName = (stackBkfsPath || moduleFilename).split(/[\\/]/).pop()!.replace(/\.js$/, '.ts');

// Jika content adalah TypeScript, transpile dulu ke JavaScript
if (isTypeScript) {
    try {
        const esbuild = hostRequire!("esbuild");
        const result = esbuild.transformSync(content, {
            loader: "ts",
            format: "cjs",
            target: "node18",
            sourcemap: "inline",
            sourcefile: sourceFileName,
        });
        content = result.code;
    } catch (transpileErr: any) {
        console.error(`[Worker ${pid}] TS Transpile Error: ${transpileErr.message}`);
        throw transpileErr;
    }
}

// Create a new module instance with physical path (for node_modules resolution)
const appModule = new Module(moduleFilename, module.parent);
appModule.filename = stackFilename;  // __filename shows BKFS path
appModule.paths = Module._nodeModulePaths(path!.dirname(moduleFilename));

// _compile dengan stackFilename agar stack trace nunjuk BKFS path
(appModule as any)._compile(content, stackFilename);

AppClass = appModule.exports.main || appModule.exports.Main || appModule.exports.default || appModule.exports;
```

So:

- **`moduleFilename`** (physical: `<cwd>/<appName>.js`) is used for `new Module(...)` and `Module._nodeModulePaths(...)` — so internal `require("node_modules/...")` calls in the app can resolve.
- **`stackFilename`** (BKFS: `/opt/test/gui-test.js`) is set as `appModule.filename` and passed to `_compile` — so `__filename` and the **stack trace** point to the correct location in VFS.

This is the answer to exercise #4: a single module has **two identities** because of two different needs (module resolution vs error reporting).

---

## Exercises / Practice

1. Read `rebuildVFSCache()` in `src/kernel/Kernel.ts`. Trace how `/lib` is read recursively, how `.ts` files are transpiled, and how the results are stored in `vfsCache`. What are the cache's keys and values?
2. Add a log in `Module._load` (WorkerEntry.ts) when `vfsPath` is found. Run an app that does `import ... from "@tsix/UserLib"`. Observe that there is no filesystem hit — and that the second log comes from `moduleCache` (not a re-`_compile`).
3. Create an app that throws an error. Inspect its stack trace — does it point to the BKFS path (`/opt/...`) or the physical path (`<cwd>/...`)? Match it against `stackBkfsPath`.
4. Add a log for `basename(parent.filename)` in the relative-rewrite branch. Look at the `@tsix_*` value when internal framework code uses `./x`. Explain its relationship to the dummy filename.
5. Explain why the two filename identities are needed (require vs stack trace), and why the `@tsix_` / `@common_` prefixes determine the relative rewrite.
6. Compare the TS-transpile vs JS-Direct paths: when is `-r esbuild-register` used in `execArgv`, and when is esbuild called manually in the worker? (See [Module 11](11-worker-thread-sandbox.en.md).)

---

## References

- `wiki/course/00-overview.md` §1, §6.2 — DME as a core principle & bootstrap summary
- `wiki/course/11-worker-thread-sandbox.md` — WorkerEntry as bootloader + `restrictHostAPI` (Module 11)
- `wiki/course/05-syscall-ipc.md` — syscall & IPC: why workers communicate through syscall, not direct `require` (Module 05)
- `src/kernel/Kernel.ts` — `rebuildVFSCache()`, `setVFSCacheProvider()`
- `src/kernel/Scheduler.ts` — `spawnWorker()`, `workerData.vfsCache`
- `src/userland/WorkerEntry.ts` — hijack `Module._load`, DME, dummy filename
- `src/common/IPCTypes.ts` — the `WorkerInitData` type (the `workerData` contract)

---

*Module 12 — done. Part IV is complete. Continue to [Module 13 — TTY & Virtual Console](13-tty-virtual-console.en.md).*
