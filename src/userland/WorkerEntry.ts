import { workerData, parentPort } from "worker_threads";
import { WorkerInitData, SyscallResponse } from "../common/IPCTypes";
import { collectRelativeModules, resolveVfsRelative } from "./VfsModuleResolver";

/**
 * Byte VFS (latin1) → teks untuk dikompilasi.
 *
 * DISALIN LOKAL, sengaja TIDAK di-`import` dari `@common/VfsText`: berkas ini adalah
 * *worker entry* yang dijalankan di HOST, dan worker jalur **JS-Direct** (mis.
 * `/bin/tsh.js`) sengaja dijalankan TANPA preload transpiler — jadi `require()` ke
 * berkas `.ts` GAGAL:
 *
 *     Worker [2] Crash Error: Cannot find module '../common/VfsText'
 *     → worker mati sebelum mengirim 'ready' → boot diam di /etc/rc.local
 *
 * (`../common/IPCTypes` aman karena sidecar `.js`-nya ada di repo; `VfsText.ts` baru
 * tidak punya.) Implementasinya satu baris, jadi duplikasi ini lebih murah daripada
 * memaksa JS-Direct memuat transpiler `.ts` (+~15 MB RSS per worker).
 */
const vfsBytesToUtf8 = (raw: string | null | undefined): string =>
    raw === null || raw === undefined ? "" : Buffer.from(raw, "latin1").toString("utf8");

/**
 * WORKER ENTRY POINT

 * 
 * Ini adalah script "Bootloader" yang jalan di dalam Worker Thread.
 * Tugasnya: Inisialisasi UserLib dan jalankan aplikasi.
 */

// tsconfig-paths dan esbuild-register sudah di-load via execArgv di Scheduler.ts

const realExit = process.exit.bind(process);

// --- PERFORMANCE HIJACK ---
// Pre-load core libraries and hijack require to avoid multiple FS hits
// in the high-performance path.
const hostRequire = typeof require !== "undefined" ? require : null;
const path = hostRequire ? hostRequire("path") : null;
const Module = hostRequire ? hostRequire("module") : null;

/**
 * resolveRelativeModuleId(): Menerjemahkan import relatif MILIK MODUL
 * FRAMEWORK ke module-id (`@tsix/x`, `@common/a/b`).
 *
 * Kenapa perlu: WorkerEntry me-_compile() modul framework dari memory dengan
 * nama file buatan (`@common_netfs/NetFSServer.js`), jadi `./NetFSProtocol`
 * hanya bisa di-resolve kalau kita tahu id modul induknya. Cara lama memakai
 * `path.basename(parent.filename)`:
 *
 *   - `@tsix_Application.js`      → basename cocok, `./x` → `@tsix/x`   ✅
 *   - `NetFSServer.js` (bersarang) → basename TIDAK cocok, `./NetFSProtocol`
 *     dibiarkan apa adanya → `Cannot find module './NetFSProtocol'`  ❌
 *
 * Dengan resolusi di ruang module-id, kedalaman berapa pun tetap benar:
 *   `@common/netfs/NetFSServer` + `./NetFSProtocol` → `@common/netfs/NetFSProtocol`
 *   `@common/netfs/NetFSServer` + `../Logger`       → `@common/Logger`
 */
function resolveRelativeModuleId(parentId: string, request: string): string {
    const parts = parentId.split("/");
    parts.pop(); // buang nama modul induk
    for (const seg of request.split("/")) {
        if (seg === "" || seg === ".") continue;
        if (seg === "..") {
            // Sisakan segmen scope (`@tsix` / `@common`) — jangan pernah habis.
            if (parts.length > 1) parts.pop();
            continue;
        }
        parts.push(seg);
    }
    return parts.join("/");
}

/**
 * MODUL RELATIF MILIK PROGRAM VFS (mis. `/sbin/tpkgd` + `./TpkgProtocol`).
 *
 * `Module._load` sinkron, sedangkan baca VFS asinkron — jadi isinya dikumpulkan
 * lebih dulu di `main()` (lihat `collectRelativeModules`), lalu hook di bawah
 * hanya MELIHAT peta ini: id module (`/sbin/TpkgProtocol`) → kode JS.
 *
 * Dulu import sesama direktori tidak didukung sama sekali (selalu jatuh ke host
 * filesystem → "Cannot find module './TpkgProtocol'").
 */
let programModules: Record<string, string> = {};

if (Module && path) {
    const originalLoad = Module._load;
    const vfsCache = (workerData as any).vfsCache || {};
    const moduleCache: Record<string, any> = {};
    // Peta dummyFilename → module-id (`@tsix/x`, `@common/a/b`). Dipakai untuk
    // menerjemahkan import RELATIF milik modul framework (lihat
    // resolveRelativeModuleId).
    const moduleIdByFile: Record<string, string> = {};

    Module._load = function (request: string, parent: any, isMain: boolean) {
        let normalizedRequest = request;

        // Resolve relative paths
        if (request.startsWith(".")) {
            if (request.includes("/common/")) {
                normalizedRequest = "@common/" + request.split("/common/")[1];
            } else if (request.includes("/lib/")) {
                normalizedRequest = "@tsix/" + request.split("/lib/")[1];
            } else if (parent && parent.filename) {
                const parentId = moduleIdByFile[parent.filename];
                if (parentId) {
                    // Modul framework yang kita muat sendiri: resolusi relatif
                    // dilakukan di ruang module-id (benar untuk semua kedalaman).
                    normalizedRequest = resolveRelativeModuleId(parentId, request);
                } else {
                    // Program VFS (bukan modul framework): filenya berupa path VFS
                    // (`/sbin/tpkgd.js`). Resolusikan relatif terhadap direktorinya,
                    // lalu cari di peta modul yang sudah dibaca dari VFS.
                    //
                    // Urutan penting: cabang `/lib/` & `/common/` di atas didahulukan
                    // supaya `../lib/x` tetap dilayani cache framework.
                    const vfsTarget = parent.filename.startsWith("/")
                        ? resolveVfsRelative(parent.filename, request)
                        : null;
                    if (vfsTarget && programModules[vfsTarget]) {
                        normalizedRequest = vfsTarget;
                    } else {
                        const basename = path!.basename(parent.filename);
                        if (basename.startsWith("@tsix_") && request.startsWith("./")) {
                            normalizedRequest = "@tsix/" + request.substring(2);
                        } else if (basename.startsWith("@common_") && request.startsWith("./")) {
                            normalizedRequest = "@common/" + request.substring(2);
                        }
                    }
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

        // Modul relatif milik program (peta dari `collectRelativeModules`).
        // Id-nya sudah tanpa ekstensi, jadi dicari langsung.
        if (!vfsPath && programModules[normalizedRequest]) {
            const content = programModules[normalizedRequest];
            const dummyFilename = path!.join(process.cwd(), normalizedRequest.replace(/\//g, "_") + ".js");

            const newMod = new Module(dummyFilename, parent);
            newMod.filename = dummyFilename;
            newMod.paths = Module._nodeModulePaths(process.cwd());

            // Daftarkan SEBELUM _compile: modul ini bisa me-require anaknya saat
            // _compile berjalan. Id-nya path VFS supaya import relatif bersarang
            // ikut benar (resolveRelativeModuleId menangani bentuk "/a/b").
            moduleIdByFile[dummyFilename] = normalizedRequest;
            (newMod as any)._compile(content, dummyFilename);

            moduleCache[normalizedRequest] = newMod.exports;
            return newMod.exports;
        }

        if (vfsPath && vfsCache[vfsPath]) {
            const content = vfsCache[vfsPath];
            const dummyFilename = path!.join(process.cwd(), normalizedRequest.replace("/", "_") + ".js");

            const newMod = new Module(dummyFilename, parent);
            newMod.filename = dummyFilename;
            newMod.paths = Module._nodeModulePaths(process.cwd());

            // PENTING: daftarkan SEBELUM _compile — isi modul me-require anaknya
            // saat _compile berjalan, jadi peta ini harus sudah terisi.
            moduleIdByFile[dummyFilename] = normalizedRequest;

            // Framework modules are now pre-compiled in Kernel.
            // Direct execution for maximum performance.
            (newMod as any)._compile(content, dummyFilename);

            moduleCache[normalizedRequest] = newMod.exports;
            return newMod.exports;
        }

        return originalLoad.apply(this, arguments);
    };

    (global as any).hijackRequire = (id: string) => {
        if (hostRequire) return hostRequire(id);
        throw new Error(`Require failed for ${id} (No host require)`);
    };
}

const hijackRequire = (id: string) =>
    (global as any).hijackRequire ? (global as any).hijackRequire(id) : hostRequire ? hostRequire(id) : null;

if (typeof require !== "undefined") {
    (global as any).require = hijackRequire;
}

/**
 * MEMORY STAT RESPONDER — jalur fallback `ps --mem` / `mem --per-proc`
 *
 * Kernel lebih suka membaca isolate worker sendiri lewat
 * `worker.getHeapStatistics()`, TAPI method itu baru ada di Node >= 22.16.
 * Di Node lama kernel mengirim pesan `{ __tsixMemStatRequest }` dan menunggu
 * balasan; responder ini yang menjawabnya.
 *
 * Kenapa di sini (WorkerEntry) dan bukan di UserLib: bootloader ini SELALU
 * jalan, bahkan untuk app yang gagal dimuat — sedangkan UserLib baru hidup
 * setelah app meng-import framework. Tanpa itu, proses bermasalah justru
 * kehilangan angka memorinya.
 *
 * `rss` sengaja TIDAK dilaporkan: di dalam worker nilainya process-wide
 * (main thread + semua worker), menyesatkan untuk atribusi per-proses.
 */
if (parentPort) {
    parentPort.on("message", (msg: any) => {
        const requestId = msg && msg.__tsixMemStatRequest;
        if (typeof requestId !== "string") return;

        // Jangan biarkan kegagalan pembacaan mematikan proses — balas apa adanya.
        try {
            const m = process.memoryUsage();
            let heapLimit = 0;
            try {
                heapLimit = hostRequire ? hostRequire("v8").getHeapStatistics().heap_size_limit : 0;
            } catch (_) {
                /* v8 opsional — 0 berarti tidak diketahui */
            }

            parentPort!.postMessage({
                __tsixMemStat: requestId,
                stats: {
                    heapUsed: m.heapUsed,
                    heapTotal: m.heapTotal,
                    external: m.external,
                    arrayBuffers: m.arrayBuffers,
                    heapLimit,
                },
            });
        } catch (_) {
            // Balas null supaya kernel tidak menunggu sampai timeout.
            parentPort!.postMessage({ __tsixMemStat: requestId, stats: null });
        }
    });
}

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

// Helper: coba kirim GUI_WINDOW_ERROR ke parent (Asteracea) sebelum exit
function trySendErrorToParent(message: string) {
    try {
        const lib = (global as any)._tsixLib as any;
        if (lib && typeof lib.getParentPid === "function" && typeof lib.shell?.send === "function") {
            lib.getParentPid()
                .then((parentPid: number) => {
                    if (parentPid) {
                        lib.shell.send(parentPid, {
                            type: "GUI_WINDOW_ERROR",
                            wid: "",
                            pid: lib.getPid(),
                            file: "",
                            error: `Runtime Error: ${message}`,
                            context: "runtime",
                            timestamp: new Date().toISOString().replace("T", " ").substring(0, 19),
                        });
                    }
                })
                .catch(() => {});
        }
    } catch (_) {
        /* ignore */
    }
}

// --- BASIC SANDBOXING (Educational Level) ---
// Kita "sembunyikan" beberapa API Node.js yang berbahaya agar user-land
// dipaksa menggunakan Syscall lewat UserLib.
const restrictHostAPI = (appName: string) => {
    const forbidden = (msg: string = "Security Violation: Direct Host API access is forbidden in TSIX Sandbox.") => {
        throw new Error(msg);
    };

    const isPrivileged =
        appName.toLowerCase().includes("server") ||
        appName.toLowerCase().includes("daemon") ||
        appName.toLowerCase().includes("dome") ||
        appName.toLowerCase().includes("tbuild") ||
        appName.toLowerCase().includes("vfs") ||
        appName.toLowerCase().includes("mysqld");
    const allowedModules = ["path", "fs", "url", "esbuild", "crypto", "os", "bcryptjs", "mysql2", "mysql2/promise"];

    const privilegedRequire = (mod: string) => {
        // Framework aliases are ALWAYS allowed, even in sandbox
        if (
            mod.startsWith("@tsix/") ||
            mod.startsWith("@common/") ||
            mod.includes("/lib/") ||
            mod.includes("/common/")
        ) {
            return hijackRequire(mod);
        }

        if (allowedModules.includes(mod)) {
            return hostRequire!(mod);
        }
        forbidden(`Security Violation: Module '${mod}' is not in the privileged allow-list.`);
    };

    // Sembunyikan require jika ada (tergantung module loader)
    if (typeof require !== "undefined") {
        (global as any).require = isPrivileged
            ? privilegedRequire
            : (mod: string) => {
                  // Even in sandbox, framework cores MUST be accessible
                  if (
                      mod.startsWith("@tsix/") ||
                      mod.startsWith("@common/") ||
                      mod.includes("/lib/") ||
                      mod.includes("/common/")
                  ) {
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
        // p.env = {}; // Temporarily keep env for debugging if needed, or clear it
    }
};

// restrictHostAPI(); // Dipindahkan ke dalam main()

// -------------------------------------------

/**
 * emitWorkerError(): Cetak pesan error load-path aplikasi ke TTY (STDOUT),
 * sehingga terlihat juga di pixelterm / konsol TTY (bukan cuma host stderr).
 * Fire-and-forget (tidak di-await) supaya tidak mengubah alur main(); fallback
 * ke console.error (host stderr) bila print ke TTY gagal.
 */
function emitWorkerError(lib: any, pid: number, message: string) {
    try {
        if (lib && lib.std && typeof lib.std.print === "function") {
            void lib.std.print(`\x1b[31m[Worker ${pid}]\x1b[0m ${message}\n`).catch(() => {
                console.error(`[Worker ${pid}] ${message}`);
            });
            return;
        }
    } catch (_) {
        // fallback ke console.error di bawah
    }
    console.error(`[Worker ${pid}] ${message}`);
}

/**
 * notifyLoadError(): Kirim GUI_WINDOW_ERROR ke parent & Window Manager (Asteracea)
 * supaya error gagal-load aplikasi juga tampil sebagai popup di desktop — termasuk
 * saat app dijalankan dari file-cruiser/terminal (foreign app). Polanya sama dengan
 * notifyParentWindowEvent() di Emerald: kirim ke parent dulu, lalu ke WM via
 * /opt/asteracea/wm-pid. Fire-and-forget; kegagalan pengiriman tidak fatal.
 */
async function notifyLoadError(lib: any, pid: number, appName: string, message: string) {
    try {
        const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);
        const payload = {
            type: "GUI_WINDOW_ERROR",
            wid: "",
            pid,
            file: appName,
            error: message,
            context: "load",
            timestamp,
        };

        // 1. Kirim ke parent process (bisa WM bila app di-launch dari launcher)
        const parentPid = await lib.getParentPid();
        if (parentPid) {
            await lib.shell.send(parentPid, payload);
        }

        // 2. Kirim juga ke Asteracea WM — untuk app yang di-run via
        //    file-cruiser/terminal (foreign app). Baca PID WM dari wm-pid file.
        try {
            const wmPidRaw = await lib.fs.readFile("/opt/asteracea/wm-pid");
            if (wmPidRaw) {
                const wmPid = parseInt(String(wmPidRaw).trim());
                const myPid = lib.getPid();
                if (wmPid && wmPid !== myPid && wmPid !== parentPid) {
                    await lib.shell.send(wmPid, payload);
                }
            }
        } catch (_) {
            // Asteracea tidak berjalan — no-op
        }
    } catch (_) {
        // Notifikasi gagal — non-fatal
    }
}

async function main() {
    const data = workerData as WorkerInitData;
    const { pid, appName, args, appPath } = data;

    // Load UserLib dinamis dari VFS Cache (Memory Execution)
    const UserLibMod = hijackRequire("@tsix/UserLib");
    const UserLibClass = UserLibMod.UserLib;

    if (!UserLibClass) {
        console.error(`[Worker ${pid}] CRITICAL ERROR: Failed to load UserLib from VFS Memory Cache!`);
        realExit(1);
    }

    const lib = new UserLibClass(pid);
    (global as any)._tsixLib = lib; // Register for explicit imports (v2.1)

    // JS-Direct path should NOT have -r in execArgv
    const isJsDirect = !process.execArgv.some((arg) => arg.includes("-r"));

    // 2. Cari aplikasinya
    const targetKey = appName.trim();
    let AppClass: any = null;
    let finalAppPath = appPath;
    // Reason the load failed (transpile/execution) — used for a more honest
    // final message instead of the misleading "Application not found".
    let loadFailure: string | null = null;
    // Detail error aslinya (pesan esbuild/runtime) — dipakai untuk popup desktop
    // biar spesifik, bukan sekadar kategori "transpile failed".
    let loadErrorDetail: string | null = null;

    // --- STRATEGI BARU: Direct Memory Execution (Tanpa .vfs_cache) ---
    if (!finalAppPath && (data as any).appContent && Module) {
        try {
            let content = (data as any).appContent;
            const isTypeScript = !(appPath || appName || "").toLowerCase().endsWith(".js");
            // Module filename HARUS physical path untuk require() nemu node_modules
            const moduleFilename = path!.join(process.cwd(), appName + ".js");
            // Stack filename = BKFS path biar stack trace bener (/opt/test/gui-test.js)
            // stackBkfsPath = BKFS path untuk stack trace (/opt/test/gui-test.js)
            const stackBkfsPath = (data as any).stackBkfsPath;
            const stackFilename = stackBkfsPath ? stackBkfsPath.replace(/\.ts$/, ".js") : moduleFilename;
            // sourcefile untuk esbuild sourcemap — cukup nama file aja (tanpa path)
            const sourceFileName = (stackBkfsPath || moduleFilename).split(/[\\/]/).pop()!.replace(/\.js$/, ".ts");

            // --- MODUL RELATIF PROGRAM (./x, ../y) ---
            //
            // Dikumpulkan SEKARANG (main() async) karena `Module._load` sinkron
            // sedangkan baca VFS lewat syscall asinkron: hook require tidak mungkin
            // membaca file sendiri. Tanpa langkah ini, `require("./TpkgProtocol")`
            // mencari file itu di HOST filesystem dan gagal.
            if (stackBkfsPath) {
                try {
                    const esbuildMod = hostRequire!("esbuild");
                    programModules = await collectRelativeModules({
                        entryId: stackBkfsPath.replace(/\.(ts|js)$/i, ""),
                        source: content,
                        // Isi VFS = BYTE; modul relatif dikompilasi sebagai TEKS.
                        readFile: async (vfsPath: string) => vfsBytesToUtf8(await lib.fs.readFile(vfsPath)),
                        transpile: (src: string, moduleId: string) =>
                            esbuildMod.transformSync(src, {
                                loader: "ts",
                                format: "cjs",
                                target: "node18",
                                sourcemap: "inline",
                                sourcefile: moduleId.split("/").pop() + ".ts",
                            }).code,
                    });
                } catch (e: any) {
                    // Non-fatal: import relatif akan gagal dengan pesan Node biasa.
                    console.error(`[Worker ${pid}] Local module scan failed: ${e.message}`);
                }
            }

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
                    loadFailure = "transpile failed";
                    loadErrorDetail = `TS Transpile Error: ${transpileErr.message}`;
                    emitWorkerError(lib, pid, `TS Transpile Error: ${transpileErr.message}`);
                    throw transpileErr;
                }
            }

            // Create a new module instance with physical path (for node_modules resolution)
            const appModule = new Module(moduleFilename, module.parent);
            appModule.filename = stackFilename; // __filename shows BKFS path
            appModule.paths = Module._nodeModulePaths(path!.dirname(moduleFilename));

            // _compile dengan stackFilename agar stack trace nunjuk BKFS path
            (appModule as any)._compile(content, stackFilename);

            AppClass =
                appModule.exports.main || appModule.exports.Main || appModule.exports.default || appModule.exports;

            // Jika masih belum ketemu (e.g. export class bukan default/main)
            if (typeof AppClass !== "function") {
                const entries = Object.entries(appModule.exports);
                const found = entries.find(([_, val]: [string, any]) => typeof val === "function");
                if (found) AppClass = found[1];
            }

            if (AppClass) {
                // console.log(`[Worker ${pid}] Direct Memory Execution success for ${appName}`);
            }
        } catch (err: any) {
            if (!loadFailure) loadFailure = "direct execution failed";
            if (!loadErrorDetail) loadErrorDetail = `Direct Execution Error: ${err.message}`;
            emitWorkerError(lib, pid, `Direct Execution Error: ${err.message}`);
        }
    }

    if (finalAppPath && hostRequire) {
        // STRATEGI BARU: Dynamic Loading dari File Fisik (Linux-like)
        // STRATEGI: Dynamic Loading dari File Fisik (Jujur Pake .ts)
        try {
            const module = hostRequire(finalAppPath);
            const entries = Object.entries(module);

            // [DEBUG] Check what we found
            // console.log(`[Worker ${pid}] Loaded module for ${appName}. Keys: ${Object.keys(module).join(", ")}`);

            // STRATEGI STANDAR: Cari export bernama 'main'
            if (module.main) {
                AppClass = module.main;
            } else if (module.Main) {
                AppClass = module.Main;
            } else if (module.default) {
                AppClass = module.default;
            } else {
                // Fallback: Ambil export pertama yang berupa class/function
                const found = entries.find(([_, val]: [string, any]) => typeof val === "function");
                if (found) AppClass = found[1];
            }

            if (AppClass) {
                // console.log(`[Worker ${pid}] Identified AppClass for ${appName}`);
            } else {
                loadFailure = "no valid 'main' export found";
                loadErrorDetail = `Failed to identify AppClass for ${appName}. Module exports: ${Object.keys(module).join(", ")}`;
                emitWorkerError(
                    lib,
                    pid,
                    `Failed to identify AppClass for ${appName}. Module exports: ${Object.keys(module).join(", ")}`,
                );
            }
        } catch (err: any) {
            loadFailure = "failed to load module";
            loadErrorDetail = `Runtime Error: Failed to require ${finalAppPath || appName}: ${err.message}`;
            emitWorkerError(lib, pid, `Runtime Error: Failed to require ${finalAppPath || appName}: ${err.message}`);
        }
    }

    if (!AppClass) {
        if (parentPort) {
            const errorMsg = loadFailure
                ? `-bash: ${appName}: Failed to load — ${loadFailure}\n`
                : `-bash: ${appName}: Application not found (Path: ${appPath || "VFS-Only"})\n`;
            await lib.std.print(errorMsg);
            parentPort.postMessage({
                success: false,
                error: errorMsg.trim(),
            });
            // Tampilkan juga di desktop (WM/Asteracea) via GUI_WINDOW_ERROR.
            // WAJIB di-await: realExit(1) di bawah langsung mematikan worker, dan
            // kalau fire-and-forget, kiriman async-nya tak sempat selesai.
            // Popup pakai detail error asli (loadErrorDetail) biar spesifik.
            await notifyLoadError(lib, pid, appName, loadErrorDetail || errorMsg.trim());
        }
        realExit(1);
    }

    // 3. AKTIFKAN SANDBOX (Kunci pintu sebelum aplikasi berjalan)
    restrictHostAPI(appName);

    try {
        const app = new AppClass();
        const result = await app.execute(lib as any, args);

        // 3. Jika aplikasi me-return string, cetak ke layar via PRINT syscall
        if (result && typeof result === "string" && result.trim() !== "") {
            await lib.std.print(result + "\n");
        }

        // 4. Beritahu Kernel bahwa proses selesai
        await lib.shell.exit(0);
    } catch (error: any) {
        // Laporkan error ke parent (WM) via IPC
        try {
            const parentPid = await lib.getParentPid();
            if (parentPid) {
                await lib.shell.send(parentPid, {
                    type: "GUI_WINDOW_ERROR",
                    wid: "",
                    pid: lib.getPid(),
                    file: appName || "",
                    error: `Runtime Error: ${error.message}`,
                    context: "runtime",
                    timestamp: new Date().toISOString().replace("T", " ").substring(0, 19),
                });
            }
        } catch (_) {
            /* IPC send failure is non-fatal */
        }

        // Juga coba lewat std.error yang punya mekanisme lebih lengkap
        try {
            await lib.std.error(error.message || String(error), appName || "app");
        } catch (_) {}

        // Laporkan error ke TTY console
        try {
            await lib.std.print(`\n[Worker ${pid}] Runtime Error: ${error.message}\n`);
        } catch (e) {}
        realExit(1);
    }
}

main();
