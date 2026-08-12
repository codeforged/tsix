"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function () { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function () { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var worker_threads_1 = require("worker_threads");
/**
 * WORKER ENTRY POINT

 *
 * Ini adalah script "Bootloader" yang jalan di dalam Worker Thread.
 * Tugasnya: Inisialisasi UserLib dan jalankan aplikasi.
 */
// tsconfig-paths dan esbuild-register sudah di-load via execArgv di Scheduler.ts
var realExit = process.exit.bind(process);
// --- PERFORMANCE HIJACK ---
// Pre-load core libraries and hijack require to avoid multiple FS hits
// in the high-performance path.
var hostRequire = typeof require !== "undefined" ? require : null;
var path = hostRequire ? hostRequire("path") : null;
var Module = hostRequire ? hostRequire("module") : null;
if (Module && path) {
    var originalLoad_1 = Module._load;
    var vfsCache_1 = worker_threads_1.workerData.vfsCache || {};
    var moduleCache_1 = {};
    Module._load = function (request, parent, isMain) {
        var normalizedRequest = request;
        // Resolve relative paths
        if (request.startsWith(".")) {
            if (request.includes("/common/")) {
                normalizedRequest = "@common/" + request.split("/common/")[1];
            }
            else if (request.includes("/lib/")) {
                normalizedRequest = "@tsix/" + request.split("/lib/")[1];
            }
            else if (parent && parent.filename) {
                var basename = path.basename(parent.filename);
                if (basename.startsWith("@tsix_") && request.startsWith("./")) {
                    normalizedRequest = "@tsix/" + request.substring(2);
                }
                else if (basename.startsWith("@common_") && request.startsWith("./")) {
                    normalizedRequest = "@common/" + request.substring(2);
                }
            }
        }
        // Cached Module
        if (moduleCache_1[normalizedRequest])
            return moduleCache_1[normalizedRequest];
        // Resolusi Memory Framework (VFS)
        var vfsPath = null;
        if (normalizedRequest.startsWith("@tsix/")) {
            vfsPath = "/lib/" + normalizedRequest.substring(6) + ".ts";
        }
        else if (normalizedRequest.startsWith("@common/")) {
            vfsPath = "/lib/common/" + normalizedRequest.substring(8) + ".ts";
        }
        if (vfsPath && vfsCache_1[vfsPath]) {
            var content = vfsCache_1[vfsPath];
            var dummyFilename = path.join(process.cwd(), normalizedRequest.replace("/", "_") + ".js");
            var newMod = new Module(dummyFilename, parent);
            newMod.filename = dummyFilename;
            newMod.paths = Module._nodeModulePaths(process.cwd());
            // Framework modules are now pre-compiled in Kernel.
            // Direct execution for maximum performance.
            newMod._compile(content, dummyFilename);
            moduleCache_1[normalizedRequest] = newMod.exports;
            return newMod.exports;
        }
        return originalLoad_1.apply(this, arguments);
    };
    global.hijackRequire = function (id) {
        if (hostRequire)
            return hostRequire(id);
        throw new Error("Require failed for ".concat(id, " (No host require)"));
    };
}
var hijackRequire = function (id) { return global.hijackRequire ? global.hijackRequire(id) : (hostRequire ? hostRequire(id) : null); };
if (typeof require !== "undefined") {
    global.require = hijackRequire;
}
process.on("unhandledRejection", function (reason) {
    console.error("[Worker Fatal] Unhandled Rejection:", reason);
    realExit(1);
});
process.on("uncaughtException", function (err) {
    console.error("[Worker Fatal] Uncaught Exception:", err);
    realExit(1);
});
// --- BASIC SANDBOXING (Educational Level) ---
// Kita "sembunyikan" beberapa API Node.js yang berbahaya agar user-land 
// dipaksa menggunakan Syscall lewat UserLib.
var restrictHostAPI = function (appName) {
    var forbidden = function (msg) {
        if (msg === void 0) { msg = "Security Violation: Direct Host API access is forbidden in TSIX Sandbox."; }
        throw new Error(msg);
    };
    var isPrivileged = appName.toLowerCase().includes("server") ||
        appName.toLowerCase().includes("daemon") ||
        appName.toLowerCase().includes("tbuild") ||
        appName.toLowerCase().includes("vfs");
    var allowedModules = ["http", "ws", "path", "fs", "url", "esbuild", "crypto", "os", "bcryptjs"];
    var privilegedRequire = function (mod) {
        // Framework aliases are ALWAYS allowed, even in sandbox
        if (mod.startsWith("@tsix/") || mod.startsWith("@common/") || mod.includes("/lib/") || mod.includes("/common/")) {
            return hijackRequire(mod);
        }
        if (allowedModules.includes(mod)) {
            return hostRequire(mod);
        }
        forbidden("Security Violation: Module '".concat(mod, "' is not in the privileged allow-list."));
    };
    // Sembunyikan require jika ada (tergantung module loader)
    if (typeof require !== "undefined") {
        global.require = isPrivileged ? privilegedRequire : function (mod) {
            // Even in sandbox, framework cores MUST be accessible
            if (mod.startsWith("@tsix/") || mod.startsWith("@common/") || mod.includes("/lib/") || mod.includes("/common/")) {
                return hijackRequire(mod);
            }
            forbidden();
        };
    }
    // Batasi akses process yang sensitif
    var p = global.process;
    if (p) {
        p.exit = forbidden;
        p.kill = forbidden;
        // p.env = {}; // Temporarily keep env for debugging if needed, or clear it
    }
};
// restrictHostAPI(); // Dipindahkan ke dalam main()
// -------------------------------------------
function main() {
    return __awaiter(this, void 0, void 0, function () {
        var data, pid, appName, args, appPath, UserLibMod, UserLibClass, lib, isJsDirect, targetKey, AppClass, finalAppPath, content, isTypeScript, filename, esbuild, result, appModule, entries, found, module_1, entries, found, errorMsg, app, result, error_1, e_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    data = worker_threads_1.workerData;
                    pid = data.pid, appName = data.appName, args = data.args, appPath = data.appPath;
                    UserLibMod = hijackRequire("@tsix/UserLib");
                    UserLibClass = UserLibMod.UserLib;
                    if (!UserLibClass) {
                        console.error("[Worker ".concat(pid, "] CRITICAL ERROR: Failed to load UserLib from VFS Memory Cache!"));
                        realExit(1);
                    }
                    lib = new UserLibClass(pid);
                    global._tsixLib = lib; // Register for explicit imports (v2.1)
                    isJsDirect = !process.execArgv.some(function (arg) { return arg.includes("-r"); });
                    targetKey = appName.trim();
                    AppClass = null;
                    finalAppPath = appPath;
                    // --- STRATEGI BARU: Direct Memory Execution (Tanpa .vfs_cache) ---
                    if (!finalAppPath && data.appContent && Module) {
                        try {
                            content = data.appContent;
                            isTypeScript = !(appPath || appName || "").toLowerCase().endsWith(".js");
                            // Module filename HARUS physical path untuk require() nemu node_modules
                            var moduleFilename = path.join(process.cwd(), appName + ".js");
                            // Stack filename = BKFS path biar stack trace bener (/opt/test/gui-test.js)
                            var _bkfsPath = data.stackBkfsPath || data.bkfsPath;
                            var stackFilename = _bkfsPath
                                ? _bkfsPath.replace(/\.ts$/i, '.js')
                                : moduleFilename;
                            // sourcefile untuk esbuild — cukup nama file aja
                            var sourceFileName = (_bkfsPath || moduleFilename).split(/[\\/]/).pop().replace(/\.js$/i, '.ts');

                            // Jika content adalah TypeScript, transpile dulu ke JavaScript
                            if (isTypeScript) {
                                try {
                                    esbuild = hostRequire("esbuild");
                                    result = esbuild.transformSync(content, {
                                        loader: "ts",
                                        format: "cjs",
                                        target: "node18",
                                        sourcemap: "inline",
                                        sourcefile: sourceFileName,
                                    });
                                    content = result.code;
                                }
                                catch (transpileErr) {
                                    console.error("[Worker ".concat(pid, "] TS Transpile Error: ").concat(transpileErr.message));
                                    throw transpileErr;
                                }
                            }
                            // Create module dgn physical path (biar path node_modules bener)
                            appModule = new Module(moduleFilename, module.parent);
                            appModule.filename = stackFilename;
                            appModule.paths = Module._nodeModulePaths(path.dirname(moduleFilename));
                            // _compile dgn stackFilename biar stack trace pake BKFS path
                            appModule._compile(content, stackFilename);
                            AppClass = appModule.exports.main || appModule.exports.Main || appModule.exports.default || appModule.exports;
                            // Jika masih belum ketemu (e.g. export class bukan default/main)
                            if (typeof AppClass !== 'function') {
                                entries = Object.entries(appModule.exports);
                                found = entries.find(function (_a) {
                                    var _ = _a[0], val = _a[1];
                                    return typeof val === 'function';
                                });
                                if (found)
                                    AppClass = found[1];
                            }
                            if (AppClass) {
                                // console.log(`[Worker ${pid}] Direct Memory Execution success for ${appName}`);
                            }
                        }
                        catch (err) {
                            console.error("[Worker ".concat(pid, "] Direct Execution Error: ").concat(err.message));
                        }
                    }
                    if (finalAppPath && hostRequire) {
                        // STRATEGI BARU: Dynamic Loading dari File Fisik (Linux-like)
                        // STRATEGI: Dynamic Loading dari File Fisik (Jujur Pake .ts)
                        try {
                            module_1 = hostRequire(finalAppPath);
                            entries = Object.entries(module_1);
                            // [DEBUG] Check what we found
                            // console.log(`[Worker ${pid}] Loaded module for ${appName}. Keys: ${Object.keys(module).join(", ")}`);
                            // STRATEGI STANDAR: Cari export bernama 'main'
                            if (module_1.main) {
                                AppClass = module_1.main;
                            }
                            else if (module_1.Main) {
                                AppClass = module_1.Main;
                            }
                            else if (module_1.default) {
                                AppClass = module_1.default;
                            }
                            else {
                                found = entries.find(function (_a) {
                                    var _ = _a[0], val = _a[1];
                                    return typeof val === 'function';
                                });
                                if (found)
                                    AppClass = found[1];
                            }
                            if (AppClass) {
                                // console.log(`[Worker ${pid}] Identified AppClass for ${appName}`);
                            }
                            else {
                                console.error("[Worker ".concat(pid, "] Failed to identify AppClass for ").concat(appName, ". Module exports:"), Object.keys(module_1));
                            }
                        }
                        catch (err) {
                            console.error("[Worker ".concat(pid, "] Runtime Error: Failed to require ").concat(finalAppPath || appName, ": ").concat(err.message));
                        }
                    }
                    if (!!AppClass) return [3 /*break*/, 3];
                    if (!worker_threads_1.parentPort) return [3 /*break*/, 2];
                    errorMsg = "-bash: ".concat(appName, ": Application not found (Path: ").concat(appPath || 'VFS-Only', ")\n");
                    return [4 /*yield*/, lib.std.print(errorMsg)];
                case 1:
                    _a.sent();
                    worker_threads_1.parentPort.postMessage({
                        success: false,
                        error: errorMsg.trim()
                    });
                    _a.label = 2;
                case 2:
                    realExit(1);
                    _a.label = 3;
                case 3:
                    // 3. AKTIFKAN SANDBOX (Kunci pintu sebelum aplikasi berjalan)
                    restrictHostAPI(appName);
                    _a.label = 4;
                case 4:
                    _a.trys.push([4, 9, , 14]);
                    app = new AppClass();
                    return [4 /*yield*/, app.execute(lib, args)];
                case 5:
                    result = _a.sent();
                    if (!(result && typeof result === "string" && result.trim() !== "")) return [3 /*break*/, 7];
                    return [4 /*yield*/, lib.std.print(result + "\n")];
                case 6:
                    _a.sent();
                    _a.label = 7;
                case 7:
                    // 4. Beritahu Kernel bahwa proses selesai
                    return [4 /*yield*/, lib.shell.exit(0)];
                case 8:
                    // 4. Beritahu Kernel bahwa proses selesai
                    _a.sent();
                    return [3 /*break*/, 14];
                case 9:
                    error_1 = _a.sent();
                    _a.label = 10;
                case 10:
                    _a.trys.push([10, 12, , 13]);
                    return [4 /*yield*/, lib.std.print("\n[Worker ".concat(pid, "] Runtime Error: ").concat(error_1.message, "\n"))];
                case 11:
                    _a.sent();
                    return [3 /*break*/, 13];
                case 12:
                    e_1 = _a.sent();
                    return [3 /*break*/, 13];
                case 13:
                    realExit(1);
                    return [3 /*break*/, 14];
                case 14: return [2 /*return*/];
            }
        });
    });
}
main();
