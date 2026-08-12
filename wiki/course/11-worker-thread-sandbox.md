---
module: 11
title: Worker Thread & Sandbox
part: IV
partTitle: Isolasi Proses
status: done
lang: id
rfc: RFC-TSIX-EDU-002
audience: all
---

# Worker Thread & Sandbox

**RFC-TSIX-EDU-002** | Modul kesebelas kurikulum TSIX. Memahami bagaimana satu worker thread menjadi satu proses TSIX, dan bagaimana sandbox mengunci pintu host API.

> `WorkerEntry.ts` adalah **bootloader** yang berjalan pertama kali di dalam setiap worker. Ia menginisialisasi UserLib, memuat aplikasi, lalu **mengunci pintu** (`restrictHostAPI`) sebelum aplikasi berjalan. Sandbox ini adalah salah satu dari dua lapisan batas privilege nyata TSIX.

---

## Tujuan Pembelajaran

- [ ] Menjelaskan dua lapisan batas privilege nyata TSIX (thread + PermissionManager, dan sandbox WorkerEntry)
- [ ] Menjelaskan urutan kerja WorkerEntry (bootloader)
- [ ] Menjelaskan hijack `Module._load` dan resolusi `@tsix/*` / `@common/*` dari `vfsCache`
- [ ] Menjelaskan Direct Memory Execution (`_compile` dengan dummy filename)
- [ ] Menjelaskan apa yang disabotase di `process` (`exit` / `kill`)
- [ ] Menjelaskan aturan `isPrivileged` dan allow-list modul host
- [ ] Menjelaskan mengapa framework `@tsix/*` selalu boleh diakses
- [ ] Menjelaskan penanganan unhandledRejection/uncaughtException
- [ ] Menjelaskan kelemahan heuristik substring nama dan pertahanan berlapis

---

## Konsep Inti

TSIX punya **dua lapisan batas privilege nyata**. Keduanya bekerja sama, tapi punya sifat berbeda.

![Empat lapis keamanan TSIX](/wiki/diagram/Keamanan-dan-Sandboxing-1.png)
*Sumber: [`wiki/diagram/Keamanan-dan-Sandboxing-1.mmd`](/wiki/diagram/Keamanan-dan-Sandboxing-1.mmd)*

### 1. Batas thread + IPC + PermissionManager (kernel)

Kernel berjalan di **main thread**. Setiap aplikasi berjalan di **worker thread sendiri**. App tidak pernah menyentuh memori kernel; satu-satunya jembatan adalah `postMessage` (request syscall → respons). Di sisi kernel, `PermissionManager` memeriksa rwx (root bypass → owner → group → others), `validateArgs` memvalidasi kontrak argumen syscall, dan bit `SETUID` memungkinkan kenaikan privilege root-only (mis. `/bin/login`).

Lapisan ini **tidak bisa diakali** oleh kode app — app tidak punya referensi ke objek kernel.

![Isolasi: main thread (kernel) vs worker thread (app) — komunikasi via IPC saja](/wiki/diagram/Keamanan-dan-Sandboxing-2.png)
*Sumber: [`wiki/diagram/Keamanan-dan-Sandboxing-2.mmd`](/wiki/diagram/Keamanan-dan-Sandboxing-2.mmd)*

### 2. Sandbox WorkerEntry (worker-local)

`WorkerEntry.ts` adalah **bootloader** pertama yang berjalan di dalam worker. Ia menyabotase API host yang berbahaya dan membatasi `require`, agar app **dipaksa** memakai syscall lewat UserLib. Mekanisme inti:

| Mekanisme | Isi |
|---|---|
| Hijack `Module._load` | `@tsix/*` & `@common/*` di-resolve dari `vfsCache` (memori), bukan filesystem |
| Direct Memory Execution (DME) | `_compile` konten dari memori dengan **dummy filename**; tanpa hit disk |
| `restrictHostAPI(appName)` | Kunci pintu: ganti `global.require`, sabotase `process.exit`/`process.kill` |
| Cek privileged | **Substring nama app** (rapuh): `server`, `daemon`, `dome`, `tbuild`, `vfs`, `mysqld` |
| Allow-list modul host | Hanya app privileged yang boleh `require` modul host tertentu |
| Fatal handler | `unhandledRejection`/`uncaughtException` → kirim `GUI_WINDOW_ERROR` ke parent → `realExit(1)` |

### Perilaku require: non-privileged vs privileged

| Kebutuhan `require` | App non-privileged | App privileged |
|---|---|---|
| Framework `@tsix/*`, `@common/*` | ✅ selalu boleh | ✅ selalu boleh |
| Path `/lib/...` atau `/common/...` | ✅ selalu boleh | ✅ selalu boleh |
| Modul host allow-list (`http, ws, path, fs, url, esbuild, crypto, os, bcryptjs, mysql2, mysql2/promise`) | 🚫 throw | ✅ boleh |
| Modul host lain (`net`, `child_process`, ...) | 🚫 throw | 🚫 throw (pesan spesifik) |
| `process.exit` / `process.kill` | 🚫 throw | 🚫 throw |

> [!IMPORTANT] Framework `@tsix/*` dan `@common/*` **selalu** bisa diakses, bahkan di sandbox terkunci. Sebab: framework adalah satu-satunya jembatan sah ke syscall — tanpa itu, app tidak bisa melakukan apa pun yang berguna.

### Kelemahan yang diketahui

> [!WARNING] Cek privileged adalah heuristik **substring nama app** — rapuh. Siapa pun bisa menamai app-nya `evil-daemon` dan mendapat allow-list modul host. Ini **bukan** batas keamanan nyata; ia hanya pembatas kenyamanan. Pertahanan sebenarnya tetap di kernel: `PermissionManager` + `validateArgs` + `SETUID`. Rencana jangka panjang: ganti heuristik ini dengan *capability-based* (app menyatakan permission yang dibutuhkan).

---

## Alur / Cara Kerja

### Walkthrough singkat

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

### Langkah detail (sesuai kode)

1. **Kernel.spawnWorker** (`src/kernel/Scheduler.ts`) membentuk `workerData: WorkerInitData`:

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

   `vfsCache` adalah hasil `rebuildVFSCache()`: framework `/lib` di-pre-compile ke memori saat boot.

2. **execArgv** dipilih berdasarkan ekstensi target:

   - `*.js` → **JS-Direct (FAST)**: hanya `--enable-source-maps`.
   - selain itu (`.ts`) → **TS-Transpile**: ditambah `-r esbuild-register` dan `-r tsconfig-paths/register`.

3. **Bootloader** (`WorkerEntry.ts`) langsung menyimpan `realExit = process.exit.bind(process)` — dipakai nanti untuk keluar sungguhan meski `process.exit` sudah disabotase.

4. **Hijack `Module._load`**: semua `require("@tsix/...")` / `require("@common/...")` (dan alias relatif) di-resolve dari `vfsCache`. Jika ada, konten di-`_compile` dari memori (DME) dengan **dummy filename**, lalu di-cache. Jika tidak ada, fallback ke `originalLoad` (host require).

5. **UserLib dimuat dari memory cache**: `hijackRequire("@tsix/UserLib")` → `new UserLibClass(pid)` → `global._tsixLib`. Ini yang menyediakan `lib.fs`, `lib.shell`, `lib.std`, `lib.net`, dll.

6. **DME aplikasi**: jika tidak ada `appPath` fisik, `appContent` (dari `workerData`) di-transpile (TS → JS via `esbuild.transformSync`) lalu `_compile` dengan **dua filename**:

   - `moduleFilename` (fisik) → biar `require` menemukan `node_modules`.
   - `stackFilename` (BKFS path, `.ts` → `.js`) → biar stack trace menunjuk path BKFS yang benar.

7. **Cari AppClass**: `exports.main || exports.Main || exports.default || export fungsi pertama`.

8. **`restrictHostAPI(appName)` dipanggil tepat setelah AppClass ditemukan dan sebelum `new AppClass()`** — "kunci pintu sebelum aplikasi berjalan". Dari sini, `require` dibatasi dan `process.exit`/`process.kill` → throw.

9. **Jalankan**: `new AppClass()` → `await app.execute(lib, args)`. Jika mengembalikan string non-kosong, dicetak via `lib.std.print`, lalu `lib.shell.exit(0)`.

10. **Jika error runtime**: kirim `GUI_WINDOW_ERROR` ke parent (WM/Asteracea), cetak ke `lib.std.error`, lalu `realExit(1)`.

---

## Kode Sumber

| File | Peran |
|---|---|
| `src/userland/WorkerEntry.ts` | Bootloader worker + sandbox (`restrictHostAPI`) |
| `src/kernel/Scheduler.ts` | `spawnWorker()` — bikin `workerData`, `vfsCache`, `execArgv` |
| `src/common/IPCTypes.ts` | Tipe `WorkerInitData` & `SyscallResponse` |

---

## Snippet (level kode)

> [!NOTE] Semua potongan di bawah disalin dari `src/userland/WorkerEntry.ts` (verifikasi langsung ke kode).

### 1. Hijack `Module._load` (resolusi framework dari `vfsCache`)

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

Pemetaan alias → path VFS: `@tsix/x` → `/lib/x.ts`; `@common/y` → `/lib/common/y.ts`. Import relatif dari dalam framework juga dinormalisasi (`./z` di `@tsix_...` → `@tsix/z`).

### 2. `restrictHostAPI` — kunci pintu (full)

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

Perhatikan: `allowedModules` berisi **11 entri** — termasuk `mysql2` **dan** `mysql2/promise`. Cek privileged memakai substring: `server`, `daemon`, `dome`, `tbuild`, `vfs`, `mysqld` (dicek dengan `toLowerCase()`).

### 3. Direct Memory Execution — `_compile` aplikasi (DME path)

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

### 4. Penanganan fatal error

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

`trySendErrorToParent` memakai `global._tsixLib`: `lib.getParentPid()` lalu `lib.shell.send(parentPid, { type: "GUI_WINDOW_ERROR", ... })` — jadi error tampil di window Asteracea.

---

## Latihan / Praktik

1. Baca `src/userland/WorkerEntry.ts` — temukan baris `restrictHostAPI(appName)` dipanggil. Catat: dipanggil setelah AppClass ditemukan, sebelum `new AppClass()`.
2. Tulis app yang memanggil `process.exit(0)` — amati error "Security Violation". Bandingkan dengan `lib.shell.exit(0)` (cara yang benar).
3. Tulis app yang `require("fs")` — bandingkan error antara app biasa vs app bernama `my-daemon` (privileged).
4. Tulis app bernama `evil-daemon` yang `require("mysql2")` — buktikan heuristik substring bisa ditembus. Lalu jelaskan mengapa ini tidak berbahaya secara nyata (kernel tetap mengawal syscall).
5. Jelaskan mengapa framework `@tsix/*` harus selalu bisa diakses bahkan di sandbox.

---

## Referensi

- `wiki/Keamanan-dan-Sandboxing.md` — model sandbox lengkap
- `wiki/course/00-overview.md` §6 — Worker Thread & Sandboxing (ringkasan)
- `src/userland/WorkerEntry.ts` — bootloader + sandbox (kode sumber utama)
- `src/kernel/Scheduler.ts` — `spawnWorker()` (workerData + vfsCache)
- `src/common/IPCTypes.ts` — `WorkerInitData`

---

*Modul 11 — selesai. Lanjut ke [Modul 12 — Module Resolution & DME](12-module-resolution-dme.md).*
