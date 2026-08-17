---
module: 12
title: Module Resolution & Direct Memory Execution
part: IV
partTitle: Isolasi Proses
status: done
lang: id
rfc: RFC-TSIX-EDU-002
audience: all
---

# Module Resolution & Direct Memory Execution

**RFC-TSIX-EDU-002** | Modul kedua belas kurikulum TSIX. Mengungkap salah satu bagian paling "ajaib" TSIX: kernel pre-compile `/lib` ke memori, worker mengeksekusi dari memori tanpa hit disk, dan trik alias filename agar import relatif tetap bekerja.

> DME (Direct Memory Execution) adalah cara TSIX memuat framework `@tsix/*` dan `@common/*` **tanpa menyentuh filesystem** saat runtime. Kernel pre-compile `/lib` sekali saat boot, cache disalin ke tiap worker via `workerData`, lalu `WorkerEntry` meng-compile modul dari string di memori dengan **filename palsu** (dummy filename) agar import relatif tetap jalan.

---

## Tujuan Pembelajaran

- [ ] Menjelaskan konsep DME (Direct Memory Execution)
- [ ] Menjelaskan hijack `Module._load` dan rewrite alias `@tsix/*` / `@common/*`
- [ ] Menjelaskan trik dummy-filename untuk import relatif `./x`
- [ ] Menjelaskan dual identity filename (fisik vs BKFS)
- [ ] Menjelaskan `moduleCache` dan kenapa framework terasa instan
- [ ] Menjelaskan perbedaan jalur TS-transpile vs JS-Direct

---

## Konsep Inti

### Apa itu Direct Memory Execution

DME menjawab dua masalah:

1. **Kinerja** — `require()` biasa melakukan resolusi dan pembacaan file dari disk setiap kali modul dimuat. Untuk framework yang dipakai semua app, ini mahal. DME mengganti pembacaan dari disk dengan **pencarian di object JavaScript** (`vfsCache`).
2. **Konsistensi alias** — semua app harus melihat framework yang **sama persis** (`@tsix/*` / `@common/*`) dengan perilaku yang sama, apa pun backend VFS-nya.

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

### Dua lapisan cache: `vfsCache` vs `moduleCache`

| Cache | Di mana | Kunci | Isi | Siklus hidup |
|---|---|---|---|---|
| `vfsCache` | Kernel (`Kernel.ts`) | path BKFS (`/lib/*.ts`) | kode JS hasil pre-compile | satu kali per boot |
| `moduleCache` | per worker (`WorkerEntry.ts`) | alias (`@tsix/UserLib`) | objek `exports` modul | sekali per worker |

`vfsCache` hanya berisi **string kode**. `moduleCache` berisi **objek exports siap pakai** — dibuat worker saat pertama kali memuat modul. Satu file framework di-pre-compile sekali (kernel), tapi di-`_compile` dan di-cache sekali **per worker**.

### Alias dan pemetaan path

| Alias | Direwrite menjadi | vfsPath (kunci vfsCache) |
|---|---|---|
| `@tsix/UserLib` | — | `/lib/UserLib.ts` |
| `@tsix/emerald` | — | `/lib/emerald.ts` |
| `@common/GUITypes` | — | `/lib/common/GUITypes.ts` |
| `./UserLib` (parent `@tsix_*`) | `@tsix/UserLib` | `/lib/UserLib.ts` |
| `./GUITypes` (parent `@common_*`) | `@common/GUITypes` | `/lib/common/GUITypes.ts` |

> [!IMPORTANT]
> Pemetaan `@tsix/X` → `/lib/X.ts` selalu menambahkan ekstensi `.ts`. Karena itu file framework di BKFS **harus** berupa `.ts` — konvensi yang dijamin `vfs-bootstrap`. Kernel ikut meng-cache `.js`/`.json` di `/lib`, tapi jalur DME `@tsix/*` hanya menarget `.ts`.

### Kenapa ini penting

1. **Kinerja: nol FS-hit per require.** Framework dimuat sekali saat boot, lalu dieksekusi dari memori di tiap worker. Tanpa DME, tiap app yang `import "@tsix/UserLib"` harus membaca dan meng-compile ulang file dari VFS — mahal untuk GUI/daemon yang startup-nya harus cepat.
2. **Konsistensi alias.** Rewrite relatif `./x` → `@tsix/x` / `@common/x` memastikan framework internal (mis. `Application` memakai `UserLib`) selalu memuat **instance yang sama** dari cache — tidak ada duplikasi path fisik vs VFS.
3. **Satu sumber kebenaran.** Kernel adalah satu-satunya yang membaca `/lib` dari BKFS. Worker tidak punya akses langsung ke disk framework — memperkuat batas sandbox (lihat [Modul 11](11-worker-thread-sandbox.md)).

> [!TIP]
> DME adalah **teknik arsitektur** yang mempercepat eksekusi framework (`/lib`) — ia melengkapi, bukan menggantikan, lima prinsip inti TSIX. Untuk daftar prinsip inti, lihat `wiki/course/00-overview.md` §1 dan §6.2.

### Dua jalur eksekusi app

| Jalur | Kondisi | Metode |
|---|---|---|
| **DME (VFS)** | `appPath` kosong, `appContent` ada | `_compile` dari string; file `.ts` di-transpile esbuild di worker |
| **Fisik (host)** | `appPath` terisi | `hostRequire(finalAppPath)` — jalur Node.js normal, `-r esbuild-register` |

Deteksi tipe: `isTypeScript = !(appPath || appName || "").toLowerCase().endsWith(".js")`.

---

## Alur / Cara Kerja

1. **Boot kernel** (`Kernel.initializeSubsystems`) memanggil `rebuildVFSCache()`.
2. `rebuildVFSCache()` berjalan rekursif (`fetchDir`) dari `/lib` di BKFS; file `.ts` di-transpile esbuild → `vfsCache`.
3. Kernel menghubungkan scheduler: `scheduler.setVFSCacheProvider(() => vfsCache)`.
4. Saat `spawnWorker()`, scheduler menyalin cache: `vfsCache: this.vfsCacheProvider()` masuk ke `workerData`.
5. `new Worker(workerPath, { workerData, execArgv })` — thread baru dengan snapshot cache.
6. `WorkerEntry.ts` (modul scope) menyimpan `originalLoad = Module._load`, lalu mengganti `Module._load` dengan versi hijack.
7. `main()` memuat UserLib: `hijackRequire("@tsix/UserLib")` → lewat `Module._load` → vfsCache → `_compile` dari memori.
8. App dimuat via DME (jika konten dari VFS) atau fisik (jika `appPath`).
9. Sandbox diaktifkan (`restrictHostAPI`) — lihat [Modul 11](11-worker-thread-sandbox.md) — sebelum app berjalan.

---

## Kode Sumber

| File | Peran |
|---|---|
| `src/kernel/Kernel.ts` | `rebuildVFSCache()` — pre-compile `/lib` → `vfsCache` |
| `src/kernel/Scheduler.ts` | `setVFSCacheProvider()` + `spawnWorker()` — kirim cache via `workerData` |
| `src/userland/WorkerEntry.ts` | Hijack `Module._load`, DME, dummy filename, dual identity |

---

## Snippet (level kode)

### 1. Kernel: pre-compile `/lib` ke memori

`rebuildVFSCache()` di `src/kernel/Kernel.ts` — disalin persis dari sumber:

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

Yang perlu diperhatikan:

- `fetchDir` **rekursif** — memasukkan subfolder seperti `/lib/common/`.
- `.ts` di-transpile via `esbuild.transformSync` (loader `ts`, format `cjs`, target `node18`). `.js`/`.json` disalin apa adanya.
- Kunci cache = **path BKFS** (`/lib/UserLib.ts`), nilai = **string kode JS**.

### 2. Kernel → Scheduler: saluran cache

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

`setVFSCacheProvider()` menyimpan sebuah *callback*, bukan snapshot. Setiap `spawnWorker()` memanggil callback itu untuk mengambil cache **saat ini** dan menyalinnya ke `workerData`.

### 3. Worker: hijack `Module._load` + dummy filename + `_compile`

Di `src/userland/WorkerEntry.ts` — disalin persis dari sumber:

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

Langkah hijack, satu per satu:

1. **Normalisasi request** — relatif `./x` / `.../lib/x` di-rewrite ke alias.
2. **Cek `moduleCache`** — kalau sudah pernah dimuat, langsung return exports (tanpa compile ulang).
3. **Petakan alias → `vfsPath`** (`@tsix/X` → `/lib/X.ts`, `@common/X` → `/lib/common/X.ts`).
4. **Cek `vfsCache`** — jika ketemu, ambil kode JS dari memori.
5. **Dummy filename** — `<cwd>/@tsix_X.js` (lihat di bawah).
6. **`_compile(content, dummyFilename)`** — Node.js meng-compile modul dari string, **tanpa membaca file**.
7. **Simpan ke `moduleCache`** dan return `exports`.
8. Jika tidak ada di cache → **fallback** ke `originalLoad.apply(...)` (jalur normal Node.js).

### 4. Trik dummy filename — identitas modul framework

Kernel hanya menyimpan kode di `vfsCache` dengan kunci path BKFS (`/lib/UserLib.ts`). Nama `@tsix_*.js` **dibuat saat load di worker**, bukan saat pre-compile:

```ts
const dummyFilename = path!.join(process.cwd(), normalizedRequest.replace("/", "_") + ".js");
```

| Alias | `replace("/", "_")` | dummyFilename (basename) |
|---|---|---|
| `@tsix/UserLib` | `@tsix_UserLib` | `<cwd>/@tsix_UserLib.js` |
| `@tsix/Application` | `@tsix_Application` | `<cwd>/@tsix_Application.js` |
| `@common/GUITypes` | `@common_GUITypes` | `<cwd>/@common_GUITypes.js` |

Kenapa awalan `@tsix_` / `@common_` penting? Karena rewrite relatif di dalam framework terjadi **berdasarkan `basename` parent**:

```ts
const basename = path!.basename(parent.filename);
if (basename.startsWith("@tsix_") && request.startsWith("./")) {
    normalizedRequest = "@tsix/" + request.substring(2);
}
```

Artinya, jika `Application.ts` (dimuat dengan filename `<cwd>/@tsix_Application.js`) melakukan `import x from "./UserLib"`, maka `./UserLib` → `@tsix/UserLib` → `/lib/UserLib.ts`. Siklus alias tetap konsisten di seluruh framework. Inilah yang membuat `@tsix/*` terlihat seperti paket instan.

> [!NOTE]
> Jadi "dual identity" modul framework adalah: **identitas konten** = path BKFS (`/lib/UserLib.ts`, kunci `vfsCache`), sedangkan **identitas filename** yang dilihat Node = dummy path (`<cwd>/@tsix_UserLib.js`).

### 5. Dual identity filename untuk aplikasi

Saat worker memuat **app** via DME (blok di `main()`), ada dua path yang dibuat:

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

Jadi:

- **`moduleFilename`** (fisik: `<cwd>/<appName>.js`) dipakai untuk `new Module(...)` dan `Module._nodeModulePaths(...)` — sehingga `require("node_modules/...")` internal app bisa resolve.
- **`stackFilename`** (BKFS: `/opt/test/gui-test.js`) ditetapkan sebagai `appModule.filename` dan diteruskan ke `_compile` — sehingga `__filename` dan **stack trace** menunjuk lokasi yang benar di VFS.

Inilah jawaban latihan #4: satu modul punya **dua identitas** karena dua kebutuhan berbeda (resolve modul vs error reporting).

---

## Latihan / Praktik

1. Baca `rebuildVFSCache()` di `src/kernel/Kernel.ts`. Telusuri bagaimana `/lib` dibaca rekursif, file `.ts` di-transpile, dan hasilnya disimpan di `vfsCache`. Apa kunci dan nilai cache-nya?
2. Tambahkan log di `Module._load` (WorkerEntry.ts) saat `vfsPath` ketemu. Jalankan app yang `import ... from "@tsix/UserLib"`. Amati bahwa tidak ada hit filesystem — dan log kedua kalinya datang dari `moduleCache` (bukan `_compile` ulang).
3. Buat app yang melempar error. Periksa stack trace-nya — apakah menunjuk path BKFS (`/opt/...`) atau path fisik (`<cwd>/...`)? Cocokkan dengan `stackBkfsPath`.
4. Tambahkan log `basename(parent.filename)` di cabang rewrite relatif. Lihat nilai `@tsix_*` saat framework internal memakai `./x`. Jelaskan hubungannya dengan dummy filename.
5. Jelaskan mengapa dua identitas filename diperlukan (require vs stack trace), dan mengapa awalan `@tsix_` / `@common_` menentukan rewrite relatif.
6. Bandingkan jalur TS-transpile vs JS-Direct: kapan `-r esbuild-register` dipakai di `execArgv`, dan kapan esbuild dipanggil manual di worker? (Lihat [Modul 11](11-worker-thread-sandbox.md).)

---

## Referensi

- `wiki/course/00-overview.md` §1, §6.2 — DME sebagai prinsip inti & ringkasan bootstrap
- `wiki/course/11-worker-thread-sandbox.md` — WorkerEntry sebagai bootloader + `restrictHostAPI` (Modul 11)
- `wiki/course/05-syscall-ipc.md` — syscall & IPC: mengapa worker berkomunikasi lewat syscall, bukan `require` langsung (Modul 05)
- `src/kernel/Kernel.ts` — `rebuildVFSCache()`, `setVFSCacheProvider()`
- `src/kernel/Scheduler.ts` — `spawnWorker()`, `workerData.vfsCache`
- `src/userland/WorkerEntry.ts` — hijack `Module._load`, DME, dummy filename
- `src/common/IPCTypes.ts` — tipe `WorkerInitData` (kontrak `workerData`)

---

*Modul 12 — selesai. Bagian IV tuntas. Lanjut ke [Modul 13 — TTY & Virtual Console](13-tty-virtual-console.md).*
