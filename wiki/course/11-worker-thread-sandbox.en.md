---
module: 11
title: Worker Thread & Sandbox
part: IV
partTitle: Process Isolation
status: done
lang: en
rfc: RFC-TSIX-EDU-002
audience: all
---

# Worker Thread & Sandbox

**RFC-TSIX-EDU-002** | Eleventh module of the TSIX curriculum. Understand how one worker thread becomes one TSIX process, and how the sandbox locks the doors to the host API.

> `WorkerEntry.ts` is the **bootloader** that runs first inside every worker. It initializes UserLib, loads the app, then **locks the doors** (`restrictHostAPI`) before the app runs. This sandbox is one of TSIX's two real privilege boundary layers.

---

## Learning Objectives

- [ ] Explain TSIX's two real privilege boundary layers (thread + PermissionManager, and the WorkerEntry sandbox)
- [ ] Explain WorkerEntry's order of operations (bootloader)
- [ ] Explain the `Module._load` hijack and resolution of `@tsix/*` / `@common/*` from `vfsCache`
- [ ] Explain Direct Memory Execution (`_compile` with a dummy filename)
- [ ] Explain what is sabotaged in `process` (`exit` / `kill`)
- [ ] Explain the `isPrivileged` rule and the host module allow-list
- [ ] Explain why the `@tsix/*` framework is always accessible
- [ ] Explain unhandledRejection/uncaughtException handling
- [ ] Explain the weakness of the name-substring heuristic and defense in depth

---

## Core Concepts

TSIX has **two real privilege boundary layers**. They work together, but each has different properties.

![Four layers of TSIX security](/wiki/diagram/Keamanan-dan-Sandboxing-1.png)
*Source: [`wiki/diagram/Keamanan-dan-Sandboxing-1.mmd`](/wiki/diagram/Keamanan-dan-Sandboxing-1.mmd)*

### 1. Thread + IPC + PermissionManager boundary (kernel)

The kernel runs on the **main thread**. Each app runs on its **own worker thread**. An app never touches kernel memory; the only bridge is `postMessage` (syscall request → response). On the kernel side, `PermissionManager` checks rwx (root bypass → owner → group → others), `validateArgs` validates the syscall argument contract, and the `SETUID` bit allows root-only privilege elevation (e.g. `/bin/login`).

This layer **cannot be tricked** by app code — the app has no reference to kernel objects.

![Isolation: main thread (kernel) vs worker threads (apps) — IPC only](/wiki/diagram/Keamanan-dan-Sandboxing-2.png)
*Source: [`wiki/diagram/Keamanan-dan-Sandboxing-2.mmd`](/wiki/diagram/Keamanan-dan-Sandboxing-2.mmd)*

### 2. WorkerEntry sandbox (worker-local)

`WorkerEntry.ts` is the **bootloader** that runs first inside the worker. It sabotages dangerous host APIs and restricts `require`, so the app is **forced** to use syscalls through UserLib. Core mechanisms:

| Mechanism | Purpose |
|---|---|
| Hijack `Module._load` | `@tsix/*` & `@common/*` are resolved from `vfsCache` (memory), not the filesystem |
| Direct Memory Execution (DME) | `_compile` content from memory with a **dummy filename**; no disk hit |
| `restrictHostAPI(appName)` | Locks the doors: replaces `global.require`, sabotages `process.exit`/`process.kill` |
| Privileged check | **App name substring** (fragile): `server`, `daemon`, `dome`, `tbuild`, `vfs`, `mysqld` |
| Host module allow-list | Only privileged apps may `require` certain host modules |
| Fatal handler | `unhandledRejection`/`uncaughtException` → send `GUI_WINDOW_ERROR` to parent → `realExit(1)` |

### require behavior: non-privileged vs privileged

| `require` request | Non-privileged app | Privileged app |
|---|---|---|
| Framework `@tsix/*`, `@common/*` | ✅ always allowed | ✅ always allowed |
| Path `/lib/...` or `/common/...` | ✅ always allowed | ✅ always allowed |
| Host allow-list modules (`http, ws, path, fs, url, esbuild, crypto, os, bcryptjs, mysql2, mysql2/promise`) | 🚫 throw | ✅ allowed |
| Other host modules (`net`, `child_process`, ...) | 🚫 throw | 🚫 throw (specific message) |
| `process.exit` / `process.kill` | 🚫 throw | 🚫 throw |

> [!IMPORTANT] The `@tsix/*` and `@common/*` frameworks are **always** accessible, even in a locked sandbox. Reason: the framework is the only legitimate bridge to syscalls — without it, an app cannot do anything useful.

### Known weaknesses

> [!WARNING] The privileged check is an **app name substring** heuristic — fragile. Anyone can name their app `evil-daemon` and gain the host module allow-list. This is **not** a real security boundary; it is only a convenience barrier. The real defense stays in the kernel: `PermissionManager` + `validateArgs` + `SETUID`. Long-term plan: replace this heuristic with *capability-based* (the app declares the permissions it needs).

---

## Flow / How It Works

### Short walkthrough

```
app dipanggil (tsh / rc.local / spawnProcess)
        │  syscall EXEC
        ▼
Kernel.spawnWorker()
        │  new Worker(WorkerEntry.ts, { workerData, execArgv })
        ▼
WorkerEntry.ts (bootloader di dalam worker)
  1. simpan realExit = process.exit    (sebelum disabotase)
  2. hijack Module._load                → @tsix/* & @common/* dari vfsCache
  3. pasang unhandledRejection / uncaughtException
  4. UserLib ← hijackRequire("@tsix/UserLib") dari memory cache
     lib = new UserLibClass(pid)  →  global._tsixLib
  5. DME aplikasi: transpile appContent → _compile (dummy filename)
  6. cari export main / Main / default
  7. restrictHostAPI(appName)     ← KUNCI PINTU (sebelum app jalan)
  8. new AppClass() → await execute(lib, args)
  9. hasil string → lib.std.print(); lalu lib.shell.exit(0)
        │
        ▼
KERNEL — tiap akses resource = syscall → PermissionManager
```

### Detailed steps (matching the code)

1. **Kernel.spawnWorker** (`src/kernel/Scheduler.ts`) builds the `workerData: WorkerInitData`:

   ```ts
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

   `vfsCache` is the result of `rebuildVFSCache()`: the framework `/lib` is pre-compiled into memory at boot.

2. **execArgv** is chosen based on the target extension:

   - `*.js` → **JS-Direct (FAST)**: only `--enable-source-maps`.
   - otherwise (`.ts`) → **TS-Transpile**: adds `-r esbuild-register` and `-r tsconfig-paths/register`.

3. The **bootloader** (`WorkerEntry.ts`) immediately stores `realExit = process.exit.bind(process)` — used later to really exit even though `process.exit` has been sabotaged.

4. **Hijack `Module._load`**: all `require("@tsix/...")` / `require("@common/...")` calls (and relative aliases) are resolved from `vfsCache`. If found, the content is `_compile`d from memory (DME) with a **dummy filename**, then cached. If not found, it falls back to `originalLoad` (host require).

5. **UserLib is loaded from the memory cache**: `hijackRequire("@tsix/UserLib")` → `new UserLibClass(pid)` → `global._tsixLib`. This provides `lib.fs`, `lib.shell`, `lib.std`, `lib.net`, etc.

6. **App DME**: if there is no physical `appPath`, `appContent` (from `workerData`) is transpiled (TS → JS via `esbuild.transformSync`) then `_compile`d with **two filenames**:

   - `moduleFilename` (physical) → so `require` can find `node_modules`.
   - `stackFilename` (BKFS path, `.ts` → `.js`) → so the stack trace points to the correct BKFS path.

7. **Find AppClass**: `exports.main || exports.Main || exports.default || the first exported function`.

8. **`restrictHostAPI(appName)` is called right after AppClass is found and before `new AppClass()`** — "lock the doors before the app runs". From here on, `require` is restricted and `process.exit`/`process.kill` → throw.

9. **Run**: `new AppClass()` → `await app.execute(lib, args)`. If it returns a non-empty string, it is printed via `lib.std.print`, then `lib.shell.exit(0)`.

10. **If a runtime error occurs**: send `GUI_WINDOW_ERROR` to the parent (WM/Asteracea), print to `lib.std.error`, then `realExit(1)`.

---

## Source Code

| File | Role |
|---|---|
| `src/userland/WorkerEntry.ts` | Worker bootloader + sandbox (`restrictHostAPI`) |
| `src/kernel/Scheduler.ts` | `spawnWorker()` — builds `workerData`, `vfsCache`, `execArgv` |
| `src/common/IPCTypes.ts` | Types `WorkerInitData` & `SyscallResponse` |

---

## Snippets (code level)

> [!NOTE] All snippets below are copied from `src/userland/WorkerEntry.ts` (verify directly against the code).

### 1. Hijack `Module._load` (framework resolution from `vfsCache`)

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

Alias → VFS path mapping: `@tsix/x` → `/lib/x.ts`; `@common/y` → `/lib/common/y.ts`. Relative imports from inside the framework are also normalized (`./z` in `@tsix_...` → `@tsix/z`).

### 2. `restrictHostAPI` — locking the doors (full)

```ts
const restrictHostAPI = (appName: string) => {
    const forbidden = (msg: string = "Security Violation: Direct Host API access is forbidden in TSIX Sandbox.") => {
        throw new Error(msg);
    };

    const isPrivileged = appName.toLowerCase().includes("server") ||
        appName.toLowerCase().includes("daemon") ||
        appName.toLowerCase().includes("dome") ||
        appName.toLowerCase().includes("tbuild") ||
        appName.toLowerCase().includes("vfs") ||
        appName.toLowerCase().includes("mysqld");
    const allowedModules = ["http", "ws", "path", "fs", "url", "esbuild", "crypto", "os", "bcryptjs", "mysql2", "mysql2/promise"];

    const privilegedRequire = (mod: string) => {
        // Framework aliases are ALWAYS allowed, even in sandbox
        if (mod.startsWith("@tsix/") || mod.startsWith("@common/") || mod.includes("/lib/") || mod.includes("/common/")) {
            return hijackRequire(mod);
        }

        if (allowedModules.includes(mod)) {
            return hostRequire!(mod);
        }
        forbidden(`Security Violation: Module '${mod}' is not in the privileged allow-list.`);
    };

    // Sembunyikan require jika ada (tergantung module loader)
    if (typeof require !== "undefined") {
        (global as any).require = isPrivileged ? privilegedRequire : (mod: string) => {
            // Even in sandbox, framework cores MUST be accessible
            if (mod.startsWith("@tsix/") || mod.startsWith("@common/") || mod.includes("/lib/") || mod.includes("/common/")) {
                return hijackRequire(mod);
            }
            forbidden();
        };
    }

    // Batasi akses process yang sensitif
    const p = (global as any).process;
    if (p) {
        p.exit = forbidden;
        p.kill = forbidden;
    }
};
```

Note: `allowedModules` has **11 entries** — including both `mysql2` **and** `mysql2/promise`. The privileged check uses substring matching: `server`, `daemon`, `dome`, `tbuild`, `vfs`, `mysqld` (checked with `toLowerCase()`).

### 3. Direct Memory Execution — `_compile` the app (DME path)

```ts
// Module filename HARUS physical path untuk require() nemu node_modules
const moduleFilename = path!.join(process.cwd(), appName + ".js");
// stackBkfsPath = BKFS path untuk stack trace (/opt/test/gui-test.js)
const stackBkfsPath = (data as any).stackBkfsPath;
const stackFilename = stackBkfsPath
    ? stackBkfsPath.replace(/\.ts$/, '.js')
    : moduleFilename;
// sourcefile untuk esbuild sourcemap — cukup nama file aja (tanpa path)
const sourceFileName = (stackBkfsPath || moduleFilename).split(/[\\/]/).pop()!.replace(/\.js$/, '.ts');

// Jika content adalah TypeScript, transpile dulu ke JavaScript
if (isTypeScript) {
    const esbuild = hostRequire!("esbuild");
    const result = esbuild.transformSync(content, {
        loader: "ts",
        format: "cjs",
        target: "node18",
        sourcemap: "inline",
        sourcefile: sourceFileName,
    });
    content = result.code;
}

const appModule = new Module(moduleFilename, module.parent);
appModule.filename = stackFilename;                 // __filename = BKFS path
appModule.paths = Module._nodeModulePaths(path!.dirname(moduleFilename));

// _compile dengan stackFilename agar stack trace nunjuk BKFS path
(appModule as any)._compile(content, stackFilename);
```

### 4. Fatal error handling

```ts
process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error("[Worker Fatal] Unhandled Rejection:", msg);
    trySendErrorToParent(msg);
    realExit(1);
});

process.on("uncaughtException", (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Worker Fatal] Uncaught Exception:", msg);
    trySendErrorToParent(msg);
    realExit(1);
});
```

`trySendErrorToParent` uses `global._tsixLib`: `lib.getParentPid()` then `lib.shell.send(parentPid, { type: "GUI_WINDOW_ERROR", ... })` — so the error shows up in an Asteracea window.

---

## Exercises / Practice

1. Read `src/userland/WorkerEntry.ts` — find the line where `restrictHostAPI(appName)` is called. Note: it is called after AppClass is found, before `new AppClass()`.
2. Write an app that calls `process.exit(0)` — observe the "Security Violation" error. Compare with `lib.shell.exit(0)` (the correct way).
3. Write an app that does `require("fs")` — compare the error between a normal app vs an app named `my-daemon` (privileged).
4. Write an app named `evil-daemon` that does `require("mysql2")` — prove the substring heuristic can be bypassed. Then explain why this is not actually dangerous (the kernel still guards syscalls).
5. Explain why the `@tsix/*` framework must always be accessible, even in the sandbox.

---

## References

- `wiki/Keamanan-dan-Sandboxing.md` — full sandbox model
- `wiki/course/00-overview.en.md` §6 — Worker Thread & Sandboxing (summary)
- `src/userland/WorkerEntry.ts` — bootloader + sandbox (main source code)
- `src/kernel/Scheduler.ts` — `spawnWorker()` (workerData + vfsCache)
- `src/common/IPCTypes.ts` — `WorkerInitData`

---

*Module 11 — done. Continue to [Module 12 — Module Resolution & DME](12-module-resolution-dme.en.md).*
