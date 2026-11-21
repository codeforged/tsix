var import_worker_threads = require("worker_threads");
var import_VfsModuleResolver = require("./VfsModuleResolver");
const vfsBytesToUtf8 = (raw) => raw === null || raw === void 0 ? "" : Buffer.from(raw, "latin1").toString("utf8");
const WM_PID_FILE = "/var/run/asteracea/wm-pid";
const realExit = process.exit.bind(process);
const hostRequire = typeof require !== "undefined" ? require : null;
const path = hostRequire ? hostRequire("path") : null;
const Module = hostRequire ? hostRequire("module") : null;
function resolveRelativeModuleId(parentId, request) {
  const parts = parentId.split("/");
  parts.pop();
  for (const seg of request.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 1) parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}
let programModules = {};
if (Module && path) {
  const originalLoad = Module._load;
  const vfsCache = import_worker_threads.workerData.vfsCache || {};
  const moduleCache = {};
  const moduleIdByFile = {};
  Module._load = function(request, parent, isMain) {
    let normalizedRequest = request;
    if (request.startsWith(".")) {
      if (request.includes("/common/")) {
        normalizedRequest = "@common/" + request.split("/common/")[1];
      } else if (request.includes("/lib/")) {
        normalizedRequest = "@tsix/" + request.split("/lib/")[1];
      } else if (parent && parent.filename) {
        const parentId = moduleIdByFile[parent.filename];
        if (parentId) {
          normalizedRequest = resolveRelativeModuleId(parentId, request);
        } else {
          const vfsTarget = parent.filename.startsWith("/") ? (0, import_VfsModuleResolver.resolveVfsRelative)(parent.filename, request) : null;
          if (vfsTarget && programModules[vfsTarget]) {
            normalizedRequest = vfsTarget;
          } else {
            const basename = path.basename(parent.filename);
            if (basename.startsWith("@tsix_") && request.startsWith("./")) {
              normalizedRequest = "@tsix/" + request.substring(2);
            } else if (basename.startsWith("@common_") && request.startsWith("./")) {
              normalizedRequest = "@common/" + request.substring(2);
            }
          }
        }
      }
    }
    if (moduleCache[normalizedRequest]) return moduleCache[normalizedRequest];
    let vfsPath = null;
    if (normalizedRequest.startsWith("@tsix/")) {
      vfsPath = "/lib/" + normalizedRequest.substring(6) + ".ts";
    } else if (normalizedRequest.startsWith("@common/")) {
      vfsPath = "/lib/common/" + normalizedRequest.substring(8) + ".ts";
    }
    if (!vfsPath && programModules[normalizedRequest]) {
      const content = programModules[normalizedRequest];
      const dummyFilename = path.join(process.cwd(), normalizedRequest.replace(/\//g, "_") + ".js");
      const newMod = new Module(dummyFilename, parent);
      newMod.filename = dummyFilename;
      newMod.paths = Module._nodeModulePaths(process.cwd());
      moduleIdByFile[dummyFilename] = normalizedRequest;
      newMod._compile(content, dummyFilename);
      moduleCache[normalizedRequest] = newMod.exports;
      return newMod.exports;
    }
    if (vfsPath && vfsCache[vfsPath]) {
      const content = vfsCache[vfsPath];
      const dummyFilename = path.join(process.cwd(), normalizedRequest.replace("/", "_") + ".js");
      const newMod = new Module(dummyFilename, parent);
      newMod.filename = dummyFilename;
      newMod.paths = Module._nodeModulePaths(process.cwd());
      moduleIdByFile[dummyFilename] = normalizedRequest;
      newMod._compile(content, dummyFilename);
      moduleCache[normalizedRequest] = newMod.exports;
      return newMod.exports;
    }
    return originalLoad.apply(this, arguments);
  };
  global.hijackRequire = (id) => {
    if (hostRequire) return hostRequire(id);
    throw new Error(`Require failed for ${id} (No host require)`);
  };
}
const hijackRequire = (id) => global.hijackRequire ? global.hijackRequire(id) : hostRequire ? hostRequire(id) : null;
if (typeof require !== "undefined") {
  global.require = hijackRequire;
}
if (import_worker_threads.parentPort) {
  import_worker_threads.parentPort.on("message", (msg) => {
    const requestId = msg && msg.__tsixMemStatRequest;
    if (typeof requestId !== "string") return;
    try {
      const m = process.memoryUsage();
      let heapLimit = 0;
      try {
        heapLimit = hostRequire ? hostRequire("v8").getHeapStatistics().heap_size_limit : 0;
      } catch (_) {
      }
      import_worker_threads.parentPort.postMessage({
        __tsixMemStat: requestId,
        stats: {
          heapUsed: m.heapUsed,
          heapTotal: m.heapTotal,
          external: m.external,
          arrayBuffers: m.arrayBuffers,
          heapLimit
        }
      });
    } catch (_) {
      import_worker_threads.parentPort.postMessage({ __tsixMemStat: requestId, stats: null });
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
function trySendErrorToParent(message) {
  try {
    const lib = global._tsixLib;
    if (lib && typeof lib.getParentPid === "function" && typeof lib.shell?.send === "function") {
      lib.getParentPid().then((parentPid) => {
        if (parentPid) {
          lib.shell.send(parentPid, {
            type: "GUI_WINDOW_ERROR",
            wid: "",
            pid: lib.getPid(),
            file: "",
            error: `Runtime Error: ${message}`,
            context: "runtime",
            timestamp: (/* @__PURE__ */ new Date()).toISOString().replace("T", " ").substring(0, 19)
          });
        }
      }).catch(() => {
      });
    }
  } catch (_) {
  }
}
const restrictHostAPI = (appName) => {
  const forbidden = (msg = "Security Violation: Direct Host API access is forbidden in TSIX Sandbox.") => {
    throw new Error(msg);
  };
  const isPrivileged = appName.toLowerCase().includes("server") || appName.toLowerCase().includes("daemon") || appName.toLowerCase().includes("dome") || appName.toLowerCase().includes("tbuild") || appName.toLowerCase().includes("vfs") || appName.toLowerCase().includes("mysqld") || // `apply-update` (hook pasca-instal base-system) harus transpile TS→JS
  // via esbuild untuk membangun ulang sidecar `.js`. Sama seperti `tbuild`,
  // ia butuh host module sehingga wajib privileged.
  appName.toLowerCase().includes("apply-update");
  const allowedModules = ["path", "fs", "url", "esbuild", "crypto", "os", "bcryptjs", "mysql2", "mysql2/promise"];
  const privilegedRequire = (mod) => {
    if (mod.startsWith("@tsix/") || mod.startsWith("@common/") || mod.includes("/lib/") || mod.includes("/common/")) {
      return hijackRequire(mod);
    }
    if (allowedModules.includes(mod)) {
      return hostRequire(mod);
    }
    forbidden(`Security Violation: Module '${mod}' is not in the privileged allow-list.`);
  };
  if (typeof require !== "undefined") {
    global.require = isPrivileged ? privilegedRequire : (mod) => {
      if (mod.startsWith("@tsix/") || mod.startsWith("@common/") || mod.includes("/lib/") || mod.includes("/common/")) {
        return hijackRequire(mod);
      }
      forbidden();
    };
  }
  const p = global.process;
  if (p) {
    p.exit = forbidden;
    p.kill = forbidden;
  }
};
function emitWorkerError(lib, pid, message) {
  try {
    if (lib && lib.std && typeof lib.std.print === "function") {
      void lib.std.print(`\x1B[31m[Worker ${pid}]\x1B[0m ${message}
`).catch(() => {
        console.error(`[Worker ${pid}] ${message}`);
      });
      return;
    }
  } catch (_) {
  }
  console.error(`[Worker ${pid}] ${message}`);
}
async function notifyLoadError(lib, pid, appName, message) {
  try {
    const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace("T", " ").substring(0, 19);
    const payload = {
      type: "GUI_WINDOW_ERROR",
      wid: "",
      pid,
      file: appName,
      error: message,
      context: "load",
      timestamp
    };
    const parentPid = await lib.getParentPid();
    if (parentPid) {
      await lib.shell.send(parentPid, payload);
    }
    try {
      const wmPidRaw = await lib.fs.readFile(WM_PID_FILE);
      if (wmPidRaw) {
        const wmPid = parseInt(String(wmPidRaw).trim());
        const myPid = lib.getPid();
        if (wmPid && wmPid !== myPid && wmPid !== parentPid) {
          await lib.shell.send(wmPid, payload);
        }
      }
    } catch (_) {
    }
  } catch (_) {
  }
}
async function main() {
  const data = import_worker_threads.workerData;
  const { pid, appName, args, appPath } = data;
  const UserLibMod = hijackRequire("@tsix/UserLib");
  const UserLibClass = UserLibMod.UserLib;
  if (!UserLibClass) {
    console.error(`[Worker ${pid}] CRITICAL ERROR: Failed to load UserLib from VFS Memory Cache!`);
    realExit(1);
  }
  const lib = new UserLibClass(pid);
  global._tsixLib = lib;
  const isJsDirect = !process.execArgv.some((arg) => arg.includes("-r"));
  const targetKey = appName.trim();
  let AppClass = null;
  let finalAppPath = appPath;
  let loadFailure = null;
  let loadErrorDetail = null;
  if (!finalAppPath && data.appContent && Module) {
    try {
      let content = data.appContent;
      const isTypeScript = !(appPath || appName || "").toLowerCase().endsWith(".js");
      const moduleFilename = path.join(process.cwd(), appName + ".js");
      const stackBkfsPath = data.stackBkfsPath;
      const stackFilename = stackBkfsPath ? stackBkfsPath.replace(/\.ts$/, ".js") : moduleFilename;
      const sourceFileName = (stackBkfsPath || moduleFilename).split(/[\\/]/).pop().replace(/\.js$/, ".ts");
      if (stackBkfsPath) {
        try {
          const esbuildMod = hostRequire("esbuild");
          programModules = await (0, import_VfsModuleResolver.collectRelativeModules)({
            entryId: stackBkfsPath.replace(/\.(ts|js)$/i, ""),
            source: content,
            // Isi VFS = BYTE; modul relatif dikompilasi sebagai TEKS.
            readFile: async (vfsPath) => vfsBytesToUtf8(await lib.fs.readFile(vfsPath)),
            transpile: (src, moduleId) => esbuildMod.transformSync(src, {
              loader: "ts",
              format: "cjs",
              target: "node18",
              sourcemap: "inline",
              sourcefile: moduleId.split("/").pop() + ".ts"
            }).code
          });
        } catch (e) {
          console.error(`[Worker ${pid}] Local module scan failed: ${e.message}`);
        }
      }
      if (isTypeScript) {
        try {
          const esbuild = hostRequire("esbuild");
          const result = esbuild.transformSync(content, {
            loader: "ts",
            format: "cjs",
            target: "node18",
            sourcemap: "inline",
            sourcefile: sourceFileName
          });
          content = result.code;
        } catch (transpileErr) {
          loadFailure = "transpile failed";
          loadErrorDetail = `TS Transpile Error: ${transpileErr.message}`;
          emitWorkerError(lib, pid, `TS Transpile Error: ${transpileErr.message}`);
          throw transpileErr;
        }
      }
      const appModule = new Module(moduleFilename, module.parent);
      appModule.filename = stackFilename;
      appModule.paths = Module._nodeModulePaths(path.dirname(moduleFilename));
      appModule._compile(content, stackFilename);
      AppClass = appModule.exports.main || appModule.exports.Main || appModule.exports.default || appModule.exports;
      if (typeof AppClass !== "function") {
        const entries = Object.entries(appModule.exports);
        const found = entries.find(([_, val]) => typeof val === "function");
        if (found) AppClass = found[1];
      }
      if (AppClass) {
      }
    } catch (err) {
      if (!loadFailure) loadFailure = "direct execution failed";
      if (!loadErrorDetail) loadErrorDetail = `Direct Execution Error: ${err.message}`;
      emitWorkerError(lib, pid, `Direct Execution Error: ${err.message}`);
    }
  }
  if (finalAppPath && hostRequire) {
    try {
      const module2 = hostRequire(finalAppPath);
      const entries = Object.entries(module2);
      if (module2.main) {
        AppClass = module2.main;
      } else if (module2.Main) {
        AppClass = module2.Main;
      } else if (module2.default) {
        AppClass = module2.default;
      } else {
        const found = entries.find(([_, val]) => typeof val === "function");
        if (found) AppClass = found[1];
      }
      if (AppClass) {
      } else {
        loadFailure = "no valid 'main' export found";
        loadErrorDetail = `Failed to identify AppClass for ${appName}. Module exports: ${Object.keys(module2).join(", ")}`;
        emitWorkerError(
          lib,
          pid,
          `Failed to identify AppClass for ${appName}. Module exports: ${Object.keys(module2).join(", ")}`
        );
      }
    } catch (err) {
      loadFailure = "failed to load module";
      loadErrorDetail = `Runtime Error: Failed to require ${finalAppPath || appName}: ${err.message}`;
      emitWorkerError(lib, pid, `Runtime Error: Failed to require ${finalAppPath || appName}: ${err.message}`);
    }
  }
  if (!AppClass) {
    if (import_worker_threads.parentPort) {
      const errorMsg = loadFailure ? `-bash: ${appName}: Failed to load \u2014 ${loadFailure}
` : `-bash: ${appName}: Application not found (Path: ${appPath || "VFS-Only"})
`;
      await lib.std.print(errorMsg);
      import_worker_threads.parentPort.postMessage({
        success: false,
        error: errorMsg.trim()
      });
      await notifyLoadError(lib, pid, appName, loadErrorDetail || errorMsg.trim());
    }
    realExit(1);
  }
  restrictHostAPI(appName);
  try {
    const app = new AppClass();
    const result = await app.execute(lib, args);
    if (result && typeof result === "string" && result.trim() !== "") {
      await lib.std.print(result + "\n");
    }
    await lib.shell.exit(0);
  } catch (error) {
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
          timestamp: (/* @__PURE__ */ new Date()).toISOString().replace("T", " ").substring(0, 19)
        });
      }
    } catch (_) {
    }
    try {
      await lib.std.error(error.message || String(error), appName || "app");
    } catch (_) {
    }
    try {
      await lib.std.print(`
[Worker ${pid}] Runtime Error: ${error.message}
`);
    } catch (e) {
    }
    realExit(1);
  }
}
main();
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiV29ya2VyRW50cnkudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IHdvcmtlckRhdGEsIHBhcmVudFBvcnQgfSBmcm9tIFwid29ya2VyX3RocmVhZHNcIjtcclxuaW1wb3J0IHsgV29ya2VySW5pdERhdGEsIFN5c2NhbGxSZXNwb25zZSB9IGZyb20gXCIuLi9jb21tb24vSVBDVHlwZXNcIjtcclxuaW1wb3J0IHsgY29sbGVjdFJlbGF0aXZlTW9kdWxlcywgcmVzb2x2ZVZmc1JlbGF0aXZlIH0gZnJvbSBcIi4vVmZzTW9kdWxlUmVzb2x2ZXJcIjtcclxuXHJcbi8qKlxyXG4gKiBCeXRlIFZGUyAobGF0aW4xKSBcdTIxOTIgdGVrcyB1bnR1ayBkaWtvbXBpbGFzaS5cclxuICpcclxuICogRElTQUxJTiBMT0tBTCwgc2VuZ2FqYSBUSURBSyBkaS1gaW1wb3J0YCBkYXJpIGBAY29tbW9uL1Zmc1RleHRgOiBiZXJrYXMgaW5pIGFkYWxhaFxyXG4gKiAqd29ya2VyIGVudHJ5KiB5YW5nIGRpamFsYW5rYW4gZGkgSE9TVCwgZGFuIHdvcmtlciBqYWx1ciAqKkpTLURpcmVjdCoqIChtaXMuXHJcbiAqIGAvYmluL3RzaC5qc2ApIHNlbmdhamEgZGlqYWxhbmthbiBUQU5QQSBwcmVsb2FkIHRyYW5zcGlsZXIgXHUyMDE0IGphZGkgYHJlcXVpcmUoKWAga2VcclxuICogYmVya2FzIGAudHNgIEdBR0FMOlxyXG4gKlxyXG4gKiAgICAgV29ya2VyIFsyXSBDcmFzaCBFcnJvcjogQ2Fubm90IGZpbmQgbW9kdWxlICcuLi9jb21tb24vVmZzVGV4dCdcclxuICogICAgIFx1MjE5MiB3b3JrZXIgbWF0aSBzZWJlbHVtIG1lbmdpcmltICdyZWFkeScgXHUyMTkyIGJvb3QgZGlhbSBkaSAvZXRjL3JjLmxvY2FsXHJcbiAqXHJcbiAqIChgLi4vY29tbW9uL0lQQ1R5cGVzYCBhbWFuIGthcmVuYSBzaWRlY2FyIGAuanNgLW55YSBhZGEgZGkgcmVwbzsgYFZmc1RleHQudHNgIGJhcnVcclxuICogdGlkYWsgcHVueWEuKSBJbXBsZW1lbnRhc2lueWEgc2F0dSBiYXJpcywgamFkaSBkdXBsaWthc2kgaW5pIGxlYmloIG11cmFoIGRhcmlwYWRhXHJcbiAqIG1lbWFrc2EgSlMtRGlyZWN0IG1lbXVhdCB0cmFuc3BpbGVyIGAudHNgICgrfjE1IE1CIFJTUyBwZXIgd29ya2VyKS5cclxuICovXHJcbmNvbnN0IHZmc0J5dGVzVG9VdGY4ID0gKHJhdzogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCk6IHN0cmluZyA9PlxyXG4gICAgcmF3ID09PSBudWxsIHx8IHJhdyA9PT0gdW5kZWZpbmVkID8gXCJcIiA6IEJ1ZmZlci5mcm9tKHJhdywgXCJsYXRpbjFcIikudG9TdHJpbmcoXCJ1dGY4XCIpO1xyXG5cclxuLyoqXHJcbiAqIFBhdGggUElEIGZpbGUgQXN0ZXJhY2VhIFdNLlxyXG4gKlxyXG4gKiBESVNBTElOIGRhcmkgYHNyYy9jb21tb24vQXN0ZXJhY2VhUGF0aHMudHNgIChgQVNURVJBQ0VBX1dNX1BJRF9GSUxFYCkga2FyZW5hXHJcbiAqIGFsYXNhbiB5YW5nIHNhbWEgZGVuZ2FuIGB2ZnNCeXRlc1RvVXRmOGAgZGkgYXRhczogYmVya2FzIGluaSBkaS1yZXF1aXJlKCkgZGlcclxuICogSE9TVCBvbGVoIHdvcmtlciBqYWx1ciBKUy1EaXJlY3QsIGphZGkgaGFueWEgYm9sZWggYmVyZ2FudHVuZyBwYWRhIGJlcmthcyB5YW5nXHJcbiAqIHB1bnlhIHNpZGVjYXIgYC5qc2AgZGkgcmVwby5cclxuICovXHJcbmNvbnN0IFdNX1BJRF9GSUxFID0gXCIvdmFyL3J1bi9hc3RlcmFjZWEvd20tcGlkXCI7XHJcblxyXG4vKipcclxuICogV09SS0VSIEVOVFJZIFBPSU5UXHJcblxyXG4gKiBcclxuICogSW5pIGFkYWxhaCBzY3JpcHQgXCJCb290bG9hZGVyXCIgeWFuZyBqYWxhbiBkaSBkYWxhbSBXb3JrZXIgVGhyZWFkLlxyXG4gKiBUdWdhc255YTogSW5pc2lhbGlzYXNpIFVzZXJMaWIgZGFuIGphbGFua2FuIGFwbGlrYXNpLlxyXG4gKi9cclxuXHJcbi8vIHRzY29uZmlnLXBhdGhzIGRhbiBlc2J1aWxkLXJlZ2lzdGVyIHN1ZGFoIGRpLWxvYWQgdmlhIGV4ZWNBcmd2IGRpIFNjaGVkdWxlci50c1xyXG5cclxuY29uc3QgcmVhbEV4aXQgPSBwcm9jZXNzLmV4aXQuYmluZChwcm9jZXNzKTtcclxuXHJcbi8vIC0tLSBQRVJGT1JNQU5DRSBISUpBQ0sgLS0tXHJcbi8vIFByZS1sb2FkIGNvcmUgbGlicmFyaWVzIGFuZCBoaWphY2sgcmVxdWlyZSB0byBhdm9pZCBtdWx0aXBsZSBGUyBoaXRzXHJcbi8vIGluIHRoZSBoaWdoLXBlcmZvcm1hbmNlIHBhdGguXHJcbmNvbnN0IGhvc3RSZXF1aXJlID0gdHlwZW9mIHJlcXVpcmUgIT09IFwidW5kZWZpbmVkXCIgPyByZXF1aXJlIDogbnVsbDtcclxuY29uc3QgcGF0aCA9IGhvc3RSZXF1aXJlID8gaG9zdFJlcXVpcmUoXCJwYXRoXCIpIDogbnVsbDtcclxuY29uc3QgTW9kdWxlID0gaG9zdFJlcXVpcmUgPyBob3N0UmVxdWlyZShcIm1vZHVsZVwiKSA6IG51bGw7XHJcblxyXG4vKipcclxuICogcmVzb2x2ZVJlbGF0aXZlTW9kdWxlSWQoKTogTWVuZXJqZW1haGthbiBpbXBvcnQgcmVsYXRpZiBNSUxJSyBNT0RVTFxyXG4gKiBGUkFNRVdPUksga2UgbW9kdWxlLWlkIChgQHRzaXgveGAsIGBAY29tbW9uL2EvYmApLlxyXG4gKlxyXG4gKiBLZW5hcGEgcGVybHU6IFdvcmtlckVudHJ5IG1lLV9jb21waWxlKCkgbW9kdWwgZnJhbWV3b3JrIGRhcmkgbWVtb3J5IGRlbmdhblxyXG4gKiBuYW1hIGZpbGUgYnVhdGFuIChgQGNvbW1vbl9uZXRmcy9OZXRGU1NlcnZlci5qc2ApLCBqYWRpIGAuL05ldEZTUHJvdG9jb2xgXHJcbiAqIGhhbnlhIGJpc2EgZGktcmVzb2x2ZSBrYWxhdSBraXRhIHRhaHUgaWQgbW9kdWwgaW5kdWtueWEuIENhcmEgbGFtYSBtZW1ha2FpXHJcbiAqIGBwYXRoLmJhc2VuYW1lKHBhcmVudC5maWxlbmFtZSlgOlxyXG4gKlxyXG4gKiAgIC0gYEB0c2l4X0FwcGxpY2F0aW9uLmpzYCAgICAgIFx1MjE5MiBiYXNlbmFtZSBjb2NvaywgYC4veGAgXHUyMTkyIGBAdHNpeC94YCAgIFx1MjcwNVxyXG4gKiAgIC0gYE5ldEZTU2VydmVyLmpzYCAoYmVyc2FyYW5nKSBcdTIxOTIgYmFzZW5hbWUgVElEQUsgY29jb2ssIGAuL05ldEZTUHJvdG9jb2xgXHJcbiAqICAgICBkaWJpYXJrYW4gYXBhIGFkYW55YSBcdTIxOTIgYENhbm5vdCBmaW5kIG1vZHVsZSAnLi9OZXRGU1Byb3RvY29sJ2AgIFx1Mjc0Q1xyXG4gKlxyXG4gKiBEZW5nYW4gcmVzb2x1c2kgZGkgcnVhbmcgbW9kdWxlLWlkLCBrZWRhbGFtYW4gYmVyYXBhIHB1biB0ZXRhcCBiZW5hcjpcclxuICogICBgQGNvbW1vbi9uZXRmcy9OZXRGU1NlcnZlcmAgKyBgLi9OZXRGU1Byb3RvY29sYCBcdTIxOTIgYEBjb21tb24vbmV0ZnMvTmV0RlNQcm90b2NvbGBcclxuICogICBgQGNvbW1vbi9uZXRmcy9OZXRGU1NlcnZlcmAgKyBgLi4vTG9nZ2VyYCAgICAgICBcdTIxOTIgYEBjb21tb24vTG9nZ2VyYFxyXG4gKi9cclxuZnVuY3Rpb24gcmVzb2x2ZVJlbGF0aXZlTW9kdWxlSWQocGFyZW50SWQ6IHN0cmluZywgcmVxdWVzdDogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIGNvbnN0IHBhcnRzID0gcGFyZW50SWQuc3BsaXQoXCIvXCIpO1xyXG4gICAgcGFydHMucG9wKCk7IC8vIGJ1YW5nIG5hbWEgbW9kdWwgaW5kdWtcclxuICAgIGZvciAoY29uc3Qgc2VnIG9mIHJlcXVlc3Quc3BsaXQoXCIvXCIpKSB7XHJcbiAgICAgICAgaWYgKHNlZyA9PT0gXCJcIiB8fCBzZWcgPT09IFwiLlwiKSBjb250aW51ZTtcclxuICAgICAgICBpZiAoc2VnID09PSBcIi4uXCIpIHtcclxuICAgICAgICAgICAgLy8gU2lzYWthbiBzZWdtZW4gc2NvcGUgKGBAdHNpeGAgLyBgQGNvbW1vbmApIFx1MjAxNCBqYW5nYW4gcGVybmFoIGhhYmlzLlxyXG4gICAgICAgICAgICBpZiAocGFydHMubGVuZ3RoID4gMSkgcGFydHMucG9wKCk7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBwYXJ0cy5wdXNoKHNlZyk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcGFydHMuam9pbihcIi9cIik7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBNT0RVTCBSRUxBVElGIE1JTElLIFBST0dSQU0gVkZTIChtaXMuIGAvc2Jpbi90cGtnZGAgKyBgLi9UcGtnUHJvdG9jb2xgKS5cclxuICpcclxuICogYE1vZHVsZS5fbG9hZGAgc2lua3Jvbiwgc2VkYW5na2FuIGJhY2EgVkZTIGFzaW5rcm9uIFx1MjAxNCBqYWRpIGlzaW55YSBkaWt1bXB1bGthblxyXG4gKiBsZWJpaCBkdWx1IGRpIGBtYWluKClgIChsaWhhdCBgY29sbGVjdFJlbGF0aXZlTW9kdWxlc2ApLCBsYWx1IGhvb2sgZGkgYmF3YWhcclxuICogaGFueWEgTUVMSUhBVCBwZXRhIGluaTogaWQgbW9kdWxlIChgL3NiaW4vVHBrZ1Byb3RvY29sYCkgXHUyMTkyIGtvZGUgSlMuXHJcbiAqXHJcbiAqIER1bHUgaW1wb3J0IHNlc2FtYSBkaXJla3RvcmkgdGlkYWsgZGlkdWt1bmcgc2FtYSBzZWthbGkgKHNlbGFsdSBqYXR1aCBrZSBob3N0XHJcbiAqIGZpbGVzeXN0ZW0gXHUyMTkyIFwiQ2Fubm90IGZpbmQgbW9kdWxlICcuL1Rwa2dQcm90b2NvbCdcIikuXHJcbiAqL1xyXG5sZXQgcHJvZ3JhbU1vZHVsZXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcclxuXHJcbmlmIChNb2R1bGUgJiYgcGF0aCkge1xyXG4gICAgY29uc3Qgb3JpZ2luYWxMb2FkID0gTW9kdWxlLl9sb2FkO1xyXG4gICAgY29uc3QgdmZzQ2FjaGUgPSAod29ya2VyRGF0YSBhcyBhbnkpLnZmc0NhY2hlIHx8IHt9O1xyXG4gICAgY29uc3QgbW9kdWxlQ2FjaGU6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7fTtcclxuICAgIC8vIFBldGEgZHVtbXlGaWxlbmFtZSBcdTIxOTIgbW9kdWxlLWlkIChgQHRzaXgveGAsIGBAY29tbW9uL2EvYmApLiBEaXBha2FpIHVudHVrXHJcbiAgICAvLyBtZW5lcmplbWFoa2FuIGltcG9ydCBSRUxBVElGIG1pbGlrIG1vZHVsIGZyYW1ld29yayAobGloYXRcclxuICAgIC8vIHJlc29sdmVSZWxhdGl2ZU1vZHVsZUlkKS5cclxuICAgIGNvbnN0IG1vZHVsZUlkQnlGaWxlOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XHJcblxyXG4gICAgTW9kdWxlLl9sb2FkID0gZnVuY3Rpb24gKHJlcXVlc3Q6IHN0cmluZywgcGFyZW50OiBhbnksIGlzTWFpbjogYm9vbGVhbikge1xyXG4gICAgICAgIGxldCBub3JtYWxpemVkUmVxdWVzdCA9IHJlcXVlc3Q7XHJcblxyXG4gICAgICAgIC8vIFJlc29sdmUgcmVsYXRpdmUgcGF0aHNcclxuICAgICAgICBpZiAocmVxdWVzdC5zdGFydHNXaXRoKFwiLlwiKSkge1xyXG4gICAgICAgICAgICBpZiAocmVxdWVzdC5pbmNsdWRlcyhcIi9jb21tb24vXCIpKSB7XHJcbiAgICAgICAgICAgICAgICBub3JtYWxpemVkUmVxdWVzdCA9IFwiQGNvbW1vbi9cIiArIHJlcXVlc3Quc3BsaXQoXCIvY29tbW9uL1wiKVsxXTtcclxuICAgICAgICAgICAgfSBlbHNlIGlmIChyZXF1ZXN0LmluY2x1ZGVzKFwiL2xpYi9cIikpIHtcclxuICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRSZXF1ZXN0ID0gXCJAdHNpeC9cIiArIHJlcXVlc3Quc3BsaXQoXCIvbGliL1wiKVsxXTtcclxuICAgICAgICAgICAgfSBlbHNlIGlmIChwYXJlbnQgJiYgcGFyZW50LmZpbGVuYW1lKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBwYXJlbnRJZCA9IG1vZHVsZUlkQnlGaWxlW3BhcmVudC5maWxlbmFtZV07XHJcbiAgICAgICAgICAgICAgICBpZiAocGFyZW50SWQpIHtcclxuICAgICAgICAgICAgICAgICAgICAvLyBNb2R1bCBmcmFtZXdvcmsgeWFuZyBraXRhIG11YXQgc2VuZGlyaTogcmVzb2x1c2kgcmVsYXRpZlxyXG4gICAgICAgICAgICAgICAgICAgIC8vIGRpbGFrdWthbiBkaSBydWFuZyBtb2R1bGUtaWQgKGJlbmFyIHVudHVrIHNlbXVhIGtlZGFsYW1hbikuXHJcbiAgICAgICAgICAgICAgICAgICAgbm9ybWFsaXplZFJlcXVlc3QgPSByZXNvbHZlUmVsYXRpdmVNb2R1bGVJZChwYXJlbnRJZCwgcmVxdWVzdCk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgIC8vIFByb2dyYW0gVkZTIChidWthbiBtb2R1bCBmcmFtZXdvcmspOiBmaWxlbnlhIGJlcnVwYSBwYXRoIFZGU1xyXG4gICAgICAgICAgICAgICAgICAgIC8vIChgL3NiaW4vdHBrZ2QuanNgKS4gUmVzb2x1c2lrYW4gcmVsYXRpZiB0ZXJoYWRhcCBkaXJla3RvcmlueWEsXHJcbiAgICAgICAgICAgICAgICAgICAgLy8gbGFsdSBjYXJpIGRpIHBldGEgbW9kdWwgeWFuZyBzdWRhaCBkaWJhY2EgZGFyaSBWRlMuXHJcbiAgICAgICAgICAgICAgICAgICAgLy9cclxuICAgICAgICAgICAgICAgICAgICAvLyBVcnV0YW4gcGVudGluZzogY2FiYW5nIGAvbGliL2AgJiBgL2NvbW1vbi9gIGRpIGF0YXMgZGlkYWh1bHVrYW5cclxuICAgICAgICAgICAgICAgICAgICAvLyBzdXBheWEgYC4uL2xpYi94YCB0ZXRhcCBkaWxheWFuaSBjYWNoZSBmcmFtZXdvcmsuXHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgdmZzVGFyZ2V0ID0gcGFyZW50LmZpbGVuYW1lLnN0YXJ0c1dpdGgoXCIvXCIpXHJcbiAgICAgICAgICAgICAgICAgICAgICAgID8gcmVzb2x2ZVZmc1JlbGF0aXZlKHBhcmVudC5maWxlbmFtZSwgcmVxdWVzdClcclxuICAgICAgICAgICAgICAgICAgICAgICAgOiBudWxsO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmICh2ZnNUYXJnZXQgJiYgcHJvZ3JhbU1vZHVsZXNbdmZzVGFyZ2V0XSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBub3JtYWxpemVkUmVxdWVzdCA9IHZmc1RhcmdldDtcclxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBiYXNlbmFtZSA9IHBhdGghLmJhc2VuYW1lKHBhcmVudC5maWxlbmFtZSk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChiYXNlbmFtZS5zdGFydHNXaXRoKFwiQHRzaXhfXCIpICYmIHJlcXVlc3Quc3RhcnRzV2l0aChcIi4vXCIpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBub3JtYWxpemVkUmVxdWVzdCA9IFwiQHRzaXgvXCIgKyByZXF1ZXN0LnN1YnN0cmluZygyKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChiYXNlbmFtZS5zdGFydHNXaXRoKFwiQGNvbW1vbl9cIikgJiYgcmVxdWVzdC5zdGFydHNXaXRoKFwiLi9cIikpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRSZXF1ZXN0ID0gXCJAY29tbW9uL1wiICsgcmVxdWVzdC5zdWJzdHJpbmcoMik7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8vIENhY2hlZCBNb2R1bGVcclxuICAgICAgICBpZiAobW9kdWxlQ2FjaGVbbm9ybWFsaXplZFJlcXVlc3RdKSByZXR1cm4gbW9kdWxlQ2FjaGVbbm9ybWFsaXplZFJlcXVlc3RdO1xyXG5cclxuICAgICAgICAvLyBSZXNvbHVzaSBNZW1vcnkgRnJhbWV3b3JrIChWRlMpXHJcbiAgICAgICAgbGV0IHZmc1BhdGggPSBudWxsO1xyXG4gICAgICAgIGlmIChub3JtYWxpemVkUmVxdWVzdC5zdGFydHNXaXRoKFwiQHRzaXgvXCIpKSB7XHJcbiAgICAgICAgICAgIHZmc1BhdGggPSBcIi9saWIvXCIgKyBub3JtYWxpemVkUmVxdWVzdC5zdWJzdHJpbmcoNikgKyBcIi50c1wiO1xyXG4gICAgICAgIH0gZWxzZSBpZiAobm9ybWFsaXplZFJlcXVlc3Quc3RhcnRzV2l0aChcIkBjb21tb24vXCIpKSB7XHJcbiAgICAgICAgICAgIHZmc1BhdGggPSBcIi9saWIvY29tbW9uL1wiICsgbm9ybWFsaXplZFJlcXVlc3Quc3Vic3RyaW5nKDgpICsgXCIudHNcIjtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8vIE1vZHVsIHJlbGF0aWYgbWlsaWsgcHJvZ3JhbSAocGV0YSBkYXJpIGBjb2xsZWN0UmVsYXRpdmVNb2R1bGVzYCkuXHJcbiAgICAgICAgLy8gSWQtbnlhIHN1ZGFoIHRhbnBhIGVrc3RlbnNpLCBqYWRpIGRpY2FyaSBsYW5nc3VuZy5cclxuICAgICAgICBpZiAoIXZmc1BhdGggJiYgcHJvZ3JhbU1vZHVsZXNbbm9ybWFsaXplZFJlcXVlc3RdKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGNvbnRlbnQgPSBwcm9ncmFtTW9kdWxlc1tub3JtYWxpemVkUmVxdWVzdF07XHJcbiAgICAgICAgICAgIGNvbnN0IGR1bW15RmlsZW5hbWUgPSBwYXRoIS5qb2luKHByb2Nlc3MuY3dkKCksIG5vcm1hbGl6ZWRSZXF1ZXN0LnJlcGxhY2UoL1xcLy9nLCBcIl9cIikgKyBcIi5qc1wiKTtcclxuXHJcbiAgICAgICAgICAgIGNvbnN0IG5ld01vZCA9IG5ldyBNb2R1bGUoZHVtbXlGaWxlbmFtZSwgcGFyZW50KTtcclxuICAgICAgICAgICAgbmV3TW9kLmZpbGVuYW1lID0gZHVtbXlGaWxlbmFtZTtcclxuICAgICAgICAgICAgbmV3TW9kLnBhdGhzID0gTW9kdWxlLl9ub2RlTW9kdWxlUGF0aHMocHJvY2Vzcy5jd2QoKSk7XHJcblxyXG4gICAgICAgICAgICAvLyBEYWZ0YXJrYW4gU0VCRUxVTSBfY29tcGlsZTogbW9kdWwgaW5pIGJpc2EgbWUtcmVxdWlyZSBhbmFrbnlhIHNhYXRcclxuICAgICAgICAgICAgLy8gX2NvbXBpbGUgYmVyamFsYW4uIElkLW55YSBwYXRoIFZGUyBzdXBheWEgaW1wb3J0IHJlbGF0aWYgYmVyc2FyYW5nXHJcbiAgICAgICAgICAgIC8vIGlrdXQgYmVuYXIgKHJlc29sdmVSZWxhdGl2ZU1vZHVsZUlkIG1lbmFuZ2FuaSBiZW50dWsgXCIvYS9iXCIpLlxyXG4gICAgICAgICAgICBtb2R1bGVJZEJ5RmlsZVtkdW1teUZpbGVuYW1lXSA9IG5vcm1hbGl6ZWRSZXF1ZXN0O1xyXG4gICAgICAgICAgICAobmV3TW9kIGFzIGFueSkuX2NvbXBpbGUoY29udGVudCwgZHVtbXlGaWxlbmFtZSk7XHJcblxyXG4gICAgICAgICAgICBtb2R1bGVDYWNoZVtub3JtYWxpemVkUmVxdWVzdF0gPSBuZXdNb2QuZXhwb3J0cztcclxuICAgICAgICAgICAgcmV0dXJuIG5ld01vZC5leHBvcnRzO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgaWYgKHZmc1BhdGggJiYgdmZzQ2FjaGVbdmZzUGF0aF0pIHtcclxuICAgICAgICAgICAgY29uc3QgY29udGVudCA9IHZmc0NhY2hlW3Zmc1BhdGhdO1xyXG4gICAgICAgICAgICBjb25zdCBkdW1teUZpbGVuYW1lID0gcGF0aCEuam9pbihwcm9jZXNzLmN3ZCgpLCBub3JtYWxpemVkUmVxdWVzdC5yZXBsYWNlKFwiL1wiLCBcIl9cIikgKyBcIi5qc1wiKTtcclxuXHJcbiAgICAgICAgICAgIGNvbnN0IG5ld01vZCA9IG5ldyBNb2R1bGUoZHVtbXlGaWxlbmFtZSwgcGFyZW50KTtcclxuICAgICAgICAgICAgbmV3TW9kLmZpbGVuYW1lID0gZHVtbXlGaWxlbmFtZTtcclxuICAgICAgICAgICAgbmV3TW9kLnBhdGhzID0gTW9kdWxlLl9ub2RlTW9kdWxlUGF0aHMocHJvY2Vzcy5jd2QoKSk7XHJcblxyXG4gICAgICAgICAgICAvLyBQRU5USU5HOiBkYWZ0YXJrYW4gU0VCRUxVTSBfY29tcGlsZSBcdTIwMTQgaXNpIG1vZHVsIG1lLXJlcXVpcmUgYW5ha255YVxyXG4gICAgICAgICAgICAvLyBzYWF0IF9jb21waWxlIGJlcmphbGFuLCBqYWRpIHBldGEgaW5pIGhhcnVzIHN1ZGFoIHRlcmlzaS5cclxuICAgICAgICAgICAgbW9kdWxlSWRCeUZpbGVbZHVtbXlGaWxlbmFtZV0gPSBub3JtYWxpemVkUmVxdWVzdDtcclxuXHJcbiAgICAgICAgICAgIC8vIEZyYW1ld29yayBtb2R1bGVzIGFyZSBub3cgcHJlLWNvbXBpbGVkIGluIEtlcm5lbC5cclxuICAgICAgICAgICAgLy8gRGlyZWN0IGV4ZWN1dGlvbiBmb3IgbWF4aW11bSBwZXJmb3JtYW5jZS5cclxuICAgICAgICAgICAgKG5ld01vZCBhcyBhbnkpLl9jb21waWxlKGNvbnRlbnQsIGR1bW15RmlsZW5hbWUpO1xyXG5cclxuICAgICAgICAgICAgbW9kdWxlQ2FjaGVbbm9ybWFsaXplZFJlcXVlc3RdID0gbmV3TW9kLmV4cG9ydHM7XHJcbiAgICAgICAgICAgIHJldHVybiBuZXdNb2QuZXhwb3J0cztcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIHJldHVybiBvcmlnaW5hbExvYWQuYXBwbHkodGhpcywgYXJndW1lbnRzKTtcclxuICAgIH07XHJcblxyXG4gICAgKGdsb2JhbCBhcyBhbnkpLmhpamFja1JlcXVpcmUgPSAoaWQ6IHN0cmluZykgPT4ge1xyXG4gICAgICAgIGlmIChob3N0UmVxdWlyZSkgcmV0dXJuIGhvc3RSZXF1aXJlKGlkKTtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFJlcXVpcmUgZmFpbGVkIGZvciAke2lkfSAoTm8gaG9zdCByZXF1aXJlKWApO1xyXG4gICAgfTtcclxufVxyXG5cclxuY29uc3QgaGlqYWNrUmVxdWlyZSA9IChpZDogc3RyaW5nKSA9PlxyXG4gICAgKGdsb2JhbCBhcyBhbnkpLmhpamFja1JlcXVpcmUgPyAoZ2xvYmFsIGFzIGFueSkuaGlqYWNrUmVxdWlyZShpZCkgOiBob3N0UmVxdWlyZSA/IGhvc3RSZXF1aXJlKGlkKSA6IG51bGw7XHJcblxyXG5pZiAodHlwZW9mIHJlcXVpcmUgIT09IFwidW5kZWZpbmVkXCIpIHtcclxuICAgIChnbG9iYWwgYXMgYW55KS5yZXF1aXJlID0gaGlqYWNrUmVxdWlyZTtcclxufVxyXG5cclxuLyoqXHJcbiAqIE1FTU9SWSBTVEFUIFJFU1BPTkRFUiBcdTIwMTQgamFsdXIgZmFsbGJhY2sgYHBzIC0tbWVtYCAvIGBtZW0gLS1wZXItcHJvY2BcclxuICpcclxuICogS2VybmVsIGxlYmloIHN1a2EgbWVtYmFjYSBpc29sYXRlIHdvcmtlciBzZW5kaXJpIGxld2F0XHJcbiAqIGB3b3JrZXIuZ2V0SGVhcFN0YXRpc3RpY3MoKWAsIFRBUEkgbWV0aG9kIGl0dSBiYXJ1IGFkYSBkaSBOb2RlID49IDIyLjE2LlxyXG4gKiBEaSBOb2RlIGxhbWEga2VybmVsIG1lbmdpcmltIHBlc2FuIGB7IF9fdHNpeE1lbVN0YXRSZXF1ZXN0IH1gIGRhbiBtZW51bmdndVxyXG4gKiBiYWxhc2FuOyByZXNwb25kZXIgaW5pIHlhbmcgbWVuamF3YWJueWEuXHJcbiAqXHJcbiAqIEtlbmFwYSBkaSBzaW5pIChXb3JrZXJFbnRyeSkgZGFuIGJ1a2FuIGRpIFVzZXJMaWI6IGJvb3Rsb2FkZXIgaW5pIFNFTEFMVVxyXG4gKiBqYWxhbiwgYmFoa2FuIHVudHVrIGFwcCB5YW5nIGdhZ2FsIGRpbXVhdCBcdTIwMTQgc2VkYW5na2FuIFVzZXJMaWIgYmFydSBoaWR1cFxyXG4gKiBzZXRlbGFoIGFwcCBtZW5nLWltcG9ydCBmcmFtZXdvcmsuIFRhbnBhIGl0dSwgcHJvc2VzIGJlcm1hc2FsYWgganVzdHJ1XHJcbiAqIGtlaGlsYW5nYW4gYW5na2EgbWVtb3JpbnlhLlxyXG4gKlxyXG4gKiBgcnNzYCBzZW5nYWphIFRJREFLIGRpbGFwb3JrYW46IGRpIGRhbGFtIHdvcmtlciBuaWxhaW55YSBwcm9jZXNzLXdpZGVcclxuICogKG1haW4gdGhyZWFkICsgc2VtdWEgd29ya2VyKSwgbWVueWVzYXRrYW4gdW50dWsgYXRyaWJ1c2kgcGVyLXByb3Nlcy5cclxuICovXHJcbmlmIChwYXJlbnRQb3J0KSB7XHJcbiAgICBwYXJlbnRQb3J0Lm9uKFwibWVzc2FnZVwiLCAobXNnOiBhbnkpID0+IHtcclxuICAgICAgICBjb25zdCByZXF1ZXN0SWQgPSBtc2cgJiYgbXNnLl9fdHNpeE1lbVN0YXRSZXF1ZXN0O1xyXG4gICAgICAgIGlmICh0eXBlb2YgcmVxdWVzdElkICE9PSBcInN0cmluZ1wiKSByZXR1cm47XHJcblxyXG4gICAgICAgIC8vIEphbmdhbiBiaWFya2FuIGtlZ2FnYWxhbiBwZW1iYWNhYW4gbWVtYXRpa2FuIHByb3NlcyBcdTIwMTQgYmFsYXMgYXBhIGFkYW55YS5cclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBtID0gcHJvY2Vzcy5tZW1vcnlVc2FnZSgpO1xyXG4gICAgICAgICAgICBsZXQgaGVhcExpbWl0ID0gMDtcclxuICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgIGhlYXBMaW1pdCA9IGhvc3RSZXF1aXJlID8gaG9zdFJlcXVpcmUoXCJ2OFwiKS5nZXRIZWFwU3RhdGlzdGljcygpLmhlYXBfc2l6ZV9saW1pdCA6IDA7XHJcbiAgICAgICAgICAgIH0gY2F0Y2ggKF8pIHtcclxuICAgICAgICAgICAgICAgIC8qIHY4IG9wc2lvbmFsIFx1MjAxNCAwIGJlcmFydGkgdGlkYWsgZGlrZXRhaHVpICovXHJcbiAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgIHBhcmVudFBvcnQhLnBvc3RNZXNzYWdlKHtcclxuICAgICAgICAgICAgICAgIF9fdHNpeE1lbVN0YXQ6IHJlcXVlc3RJZCxcclxuICAgICAgICAgICAgICAgIHN0YXRzOiB7XHJcbiAgICAgICAgICAgICAgICAgICAgaGVhcFVzZWQ6IG0uaGVhcFVzZWQsXHJcbiAgICAgICAgICAgICAgICAgICAgaGVhcFRvdGFsOiBtLmhlYXBUb3RhbCxcclxuICAgICAgICAgICAgICAgICAgICBleHRlcm5hbDogbS5leHRlcm5hbCxcclxuICAgICAgICAgICAgICAgICAgICBhcnJheUJ1ZmZlcnM6IG0uYXJyYXlCdWZmZXJzLFxyXG4gICAgICAgICAgICAgICAgICAgIGhlYXBMaW1pdCxcclxuICAgICAgICAgICAgICAgIH0sXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH0gY2F0Y2ggKF8pIHtcclxuICAgICAgICAgICAgLy8gQmFsYXMgbnVsbCBzdXBheWEga2VybmVsIHRpZGFrIG1lbnVuZ2d1IHNhbXBhaSB0aW1lb3V0LlxyXG4gICAgICAgICAgICBwYXJlbnRQb3J0IS5wb3N0TWVzc2FnZSh7IF9fdHNpeE1lbVN0YXQ6IHJlcXVlc3RJZCwgc3RhdHM6IG51bGwgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcbn1cclxuXHJcbnByb2Nlc3Mub24oXCJ1bmhhbmRsZWRSZWplY3Rpb25cIiwgKHJlYXNvbikgPT4ge1xyXG4gICAgY29uc3QgbXNnID0gcmVhc29uIGluc3RhbmNlb2YgRXJyb3IgPyByZWFzb24ubWVzc2FnZSA6IFN0cmluZyhyZWFzb24pO1xyXG4gICAgY29uc29sZS5lcnJvcihcIltXb3JrZXIgRmF0YWxdIFVuaGFuZGxlZCBSZWplY3Rpb246XCIsIG1zZyk7XHJcbiAgICB0cnlTZW5kRXJyb3JUb1BhcmVudChtc2cpO1xyXG4gICAgcmVhbEV4aXQoMSk7XHJcbn0pO1xyXG5cclxucHJvY2Vzcy5vbihcInVuY2F1Z2h0RXhjZXB0aW9uXCIsIChlcnIpID0+IHtcclxuICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcclxuICAgIGNvbnNvbGUuZXJyb3IoXCJbV29ya2VyIEZhdGFsXSBVbmNhdWdodCBFeGNlcHRpb246XCIsIG1zZyk7XHJcbiAgICB0cnlTZW5kRXJyb3JUb1BhcmVudChtc2cpO1xyXG4gICAgcmVhbEV4aXQoMSk7XHJcbn0pO1xyXG5cclxuLy8gSGVscGVyOiBjb2JhIGtpcmltIEdVSV9XSU5ET1dfRVJST1Iga2UgcGFyZW50IChBc3RlcmFjZWEpIHNlYmVsdW0gZXhpdFxyXG5mdW5jdGlvbiB0cnlTZW5kRXJyb3JUb1BhcmVudChtZXNzYWdlOiBzdHJpbmcpIHtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgbGliID0gKGdsb2JhbCBhcyBhbnkpLl90c2l4TGliIGFzIGFueTtcclxuICAgICAgICBpZiAobGliICYmIHR5cGVvZiBsaWIuZ2V0UGFyZW50UGlkID09PSBcImZ1bmN0aW9uXCIgJiYgdHlwZW9mIGxpYi5zaGVsbD8uc2VuZCA9PT0gXCJmdW5jdGlvblwiKSB7XHJcbiAgICAgICAgICAgIGxpYi5nZXRQYXJlbnRQaWQoKVxyXG4gICAgICAgICAgICAgICAgLnRoZW4oKHBhcmVudFBpZDogbnVtYmVyKSA9PiB7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKHBhcmVudFBpZCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBsaWIuc2hlbGwuc2VuZChwYXJlbnRQaWQsIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiR1VJX1dJTkRPV19FUlJPUlwiLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgd2lkOiBcIlwiLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcGlkOiBsaWIuZ2V0UGlkKCksXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWxlOiBcIlwiLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyb3I6IGBSdW50aW1lIEVycm9yOiAke21lc3NhZ2V9YCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRleHQ6IFwicnVudGltZVwiLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkucmVwbGFjZShcIlRcIiwgXCIgXCIpLnN1YnN0cmluZygwLCAxOSksXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH0pXHJcbiAgICAgICAgICAgICAgICAuY2F0Y2goKCkgPT4ge30pO1xyXG4gICAgICAgIH1cclxuICAgIH0gY2F0Y2ggKF8pIHtcclxuICAgICAgICAvKiBpZ25vcmUgKi9cclxuICAgIH1cclxufVxyXG5cclxuLy8gLS0tIEJBU0lDIFNBTkRCT1hJTkcgKEVkdWNhdGlvbmFsIExldmVsKSAtLS1cclxuLy8gS2l0YSBcInNlbWJ1bnlpa2FuXCIgYmViZXJhcGEgQVBJIE5vZGUuanMgeWFuZyBiZXJiYWhheWEgYWdhciB1c2VyLWxhbmRcclxuLy8gZGlwYWtzYSBtZW5nZ3VuYWthbiBTeXNjYWxsIGxld2F0IFVzZXJMaWIuXHJcbmNvbnN0IHJlc3RyaWN0SG9zdEFQSSA9IChhcHBOYW1lOiBzdHJpbmcpID0+IHtcclxuICAgIGNvbnN0IGZvcmJpZGRlbiA9IChtc2c6IHN0cmluZyA9IFwiU2VjdXJpdHkgVmlvbGF0aW9uOiBEaXJlY3QgSG9zdCBBUEkgYWNjZXNzIGlzIGZvcmJpZGRlbiBpbiBUU0lYIFNhbmRib3guXCIpID0+IHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IobXNnKTtcclxuICAgIH07XHJcblxyXG4gICAgY29uc3QgaXNQcml2aWxlZ2VkID1cclxuICAgICAgICBhcHBOYW1lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJzZXJ2ZXJcIikgfHxcclxuICAgICAgICBhcHBOYW1lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJkYWVtb25cIikgfHxcclxuICAgICAgICBhcHBOYW1lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJkb21lXCIpIHx8XHJcbiAgICAgICAgYXBwTmFtZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwidGJ1aWxkXCIpIHx8XHJcbiAgICAgICAgYXBwTmFtZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwidmZzXCIpIHx8XHJcbiAgICAgICAgYXBwTmFtZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwibXlzcWxkXCIpIHx8XHJcbiAgICAgICAgLy8gYGFwcGx5LXVwZGF0ZWAgKGhvb2sgcGFzY2EtaW5zdGFsIGJhc2Utc3lzdGVtKSBoYXJ1cyB0cmFuc3BpbGUgVFNcdTIxOTJKU1xyXG4gICAgICAgIC8vIHZpYSBlc2J1aWxkIHVudHVrIG1lbWJhbmd1biB1bGFuZyBzaWRlY2FyIGAuanNgLiBTYW1hIHNlcGVydGkgYHRidWlsZGAsXHJcbiAgICAgICAgLy8gaWEgYnV0dWggaG9zdCBtb2R1bGUgc2VoaW5nZ2Egd2FqaWIgcHJpdmlsZWdlZC5cclxuICAgICAgICBhcHBOYW1lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJhcHBseS11cGRhdGVcIik7XHJcbiAgICBjb25zdCBhbGxvd2VkTW9kdWxlcyA9IFtcInBhdGhcIiwgXCJmc1wiLCBcInVybFwiLCBcImVzYnVpbGRcIiwgXCJjcnlwdG9cIiwgXCJvc1wiLCBcImJjcnlwdGpzXCIsIFwibXlzcWwyXCIsIFwibXlzcWwyL3Byb21pc2VcIl07XHJcblxyXG4gICAgY29uc3QgcHJpdmlsZWdlZFJlcXVpcmUgPSAobW9kOiBzdHJpbmcpID0+IHtcclxuICAgICAgICAvLyBGcmFtZXdvcmsgYWxpYXNlcyBhcmUgQUxXQVlTIGFsbG93ZWQsIGV2ZW4gaW4gc2FuZGJveFxyXG4gICAgICAgIGlmIChcclxuICAgICAgICAgICAgbW9kLnN0YXJ0c1dpdGgoXCJAdHNpeC9cIikgfHxcclxuICAgICAgICAgICAgbW9kLnN0YXJ0c1dpdGgoXCJAY29tbW9uL1wiKSB8fFxyXG4gICAgICAgICAgICBtb2QuaW5jbHVkZXMoXCIvbGliL1wiKSB8fFxyXG4gICAgICAgICAgICBtb2QuaW5jbHVkZXMoXCIvY29tbW9uL1wiKVxyXG4gICAgICAgICkge1xyXG4gICAgICAgICAgICByZXR1cm4gaGlqYWNrUmVxdWlyZShtb2QpO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgaWYgKGFsbG93ZWRNb2R1bGVzLmluY2x1ZGVzKG1vZCkpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGhvc3RSZXF1aXJlIShtb2QpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmb3JiaWRkZW4oYFNlY3VyaXR5IFZpb2xhdGlvbjogTW9kdWxlICcke21vZH0nIGlzIG5vdCBpbiB0aGUgcHJpdmlsZWdlZCBhbGxvdy1saXN0LmApO1xyXG4gICAgfTtcclxuXHJcbiAgICAvLyBTZW1idW55aWthbiByZXF1aXJlIGppa2EgYWRhICh0ZXJnYW50dW5nIG1vZHVsZSBsb2FkZXIpXHJcbiAgICBpZiAodHlwZW9mIHJlcXVpcmUgIT09IFwidW5kZWZpbmVkXCIpIHtcclxuICAgICAgICAoZ2xvYmFsIGFzIGFueSkucmVxdWlyZSA9IGlzUHJpdmlsZWdlZFxyXG4gICAgICAgICAgICA/IHByaXZpbGVnZWRSZXF1aXJlXHJcbiAgICAgICAgICAgIDogKG1vZDogc3RyaW5nKSA9PiB7XHJcbiAgICAgICAgICAgICAgICAgIC8vIEV2ZW4gaW4gc2FuZGJveCwgZnJhbWV3b3JrIGNvcmVzIE1VU1QgYmUgYWNjZXNzaWJsZVxyXG4gICAgICAgICAgICAgICAgICBpZiAoXHJcbiAgICAgICAgICAgICAgICAgICAgICBtb2Quc3RhcnRzV2l0aChcIkB0c2l4L1wiKSB8fFxyXG4gICAgICAgICAgICAgICAgICAgICAgbW9kLnN0YXJ0c1dpdGgoXCJAY29tbW9uL1wiKSB8fFxyXG4gICAgICAgICAgICAgICAgICAgICAgbW9kLmluY2x1ZGVzKFwiL2xpYi9cIikgfHxcclxuICAgICAgICAgICAgICAgICAgICAgIG1vZC5pbmNsdWRlcyhcIi9jb21tb24vXCIpXHJcbiAgICAgICAgICAgICAgICAgICkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGhpamFja1JlcXVpcmUobW9kKTtcclxuICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICBmb3JiaWRkZW4oKTtcclxuICAgICAgICAgICAgICB9O1xyXG4gICAgfVxyXG5cclxuICAgIC8vIEJhdGFzaSBha3NlcyBwcm9jZXNzIHlhbmcgc2Vuc2l0aWZcclxuICAgIGNvbnN0IHAgPSAoZ2xvYmFsIGFzIGFueSkucHJvY2VzcztcclxuICAgIGlmIChwKSB7XHJcbiAgICAgICAgcC5leGl0ID0gZm9yYmlkZGVuO1xyXG4gICAgICAgIHAua2lsbCA9IGZvcmJpZGRlbjtcclxuICAgICAgICAvLyBwLmVudiA9IHt9OyAvLyBUZW1wb3JhcmlseSBrZWVwIGVudiBmb3IgZGVidWdnaW5nIGlmIG5lZWRlZCwgb3IgY2xlYXIgaXRcclxuICAgIH1cclxufTtcclxuXHJcbi8vIHJlc3RyaWN0SG9zdEFQSSgpOyAvLyBEaXBpbmRhaGthbiBrZSBkYWxhbSBtYWluKClcclxuXHJcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cclxuXHJcbi8qKlxyXG4gKiBlbWl0V29ya2VyRXJyb3IoKTogQ2V0YWsgcGVzYW4gZXJyb3IgbG9hZC1wYXRoIGFwbGlrYXNpIGtlIFRUWSAoU1RET1VUKSxcclxuICogc2VoaW5nZ2EgdGVybGloYXQganVnYSBkaSBwaXhlbHRlcm0gLyBrb25zb2wgVFRZIChidWthbiBjdW1hIGhvc3Qgc3RkZXJyKS5cclxuICogRmlyZS1hbmQtZm9yZ2V0ICh0aWRhayBkaS1hd2FpdCkgc3VwYXlhIHRpZGFrIG1lbmd1YmFoIGFsdXIgbWFpbigpOyBmYWxsYmFja1xyXG4gKiBrZSBjb25zb2xlLmVycm9yIChob3N0IHN0ZGVycikgYmlsYSBwcmludCBrZSBUVFkgZ2FnYWwuXHJcbiAqL1xyXG5mdW5jdGlvbiBlbWl0V29ya2VyRXJyb3IobGliOiBhbnksIHBpZDogbnVtYmVyLCBtZXNzYWdlOiBzdHJpbmcpIHtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgaWYgKGxpYiAmJiBsaWIuc3RkICYmIHR5cGVvZiBsaWIuc3RkLnByaW50ID09PSBcImZ1bmN0aW9uXCIpIHtcclxuICAgICAgICAgICAgdm9pZCBsaWIuc3RkLnByaW50KGBcXHgxYlszMW1bV29ya2VyICR7cGlkfV1cXHgxYlswbSAke21lc3NhZ2V9XFxuYCkuY2F0Y2goKCkgPT4ge1xyXG4gICAgICAgICAgICAgICAgY29uc29sZS5lcnJvcihgW1dvcmtlciAke3BpZH1dICR7bWVzc2FnZX1gKTtcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICB9IGNhdGNoIChfKSB7XHJcbiAgICAgICAgLy8gZmFsbGJhY2sga2UgY29uc29sZS5lcnJvciBkaSBiYXdhaFxyXG4gICAgfVxyXG4gICAgY29uc29sZS5lcnJvcihgW1dvcmtlciAke3BpZH1dICR7bWVzc2FnZX1gKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIG5vdGlmeUxvYWRFcnJvcigpOiBLaXJpbSBHVUlfV0lORE9XX0VSUk9SIGtlIHBhcmVudCAmIFdpbmRvdyBNYW5hZ2VyIChBc3RlcmFjZWEpXHJcbiAqIHN1cGF5YSBlcnJvciBnYWdhbC1sb2FkIGFwbGlrYXNpIGp1Z2EgdGFtcGlsIHNlYmFnYWkgcG9wdXAgZGkgZGVza3RvcCBcdTIwMTQgdGVybWFzdWtcclxuICogc2FhdCBhcHAgZGlqYWxhbmthbiBkYXJpIGZpbGUtY3J1aXNlci90ZXJtaW5hbCAoZm9yZWlnbiBhcHApLiBQb2xhbnlhIHNhbWEgZGVuZ2FuXHJcbiAqIG5vdGlmeVBhcmVudFdpbmRvd0V2ZW50KCkgZGkgRW1lcmFsZDoga2lyaW0ga2UgcGFyZW50IGR1bHUsIGxhbHUga2UgV00gdmlhXHJcbiAqIFBJRCBmaWxlIChgL3Zhci9ydW4vYXN0ZXJhY2VhL3dtLXBpZGApLiBGaXJlLWFuZC1mb3JnZXQ7IGtlZ2FnYWxhbiBwZW5naXJpbWFuXHJcbiAqIHRpZGFrIGZhdGFsLlxyXG4gKi9cclxuYXN5bmMgZnVuY3Rpb24gbm90aWZ5TG9hZEVycm9yKGxpYjogYW55LCBwaWQ6IG51bWJlciwgYXBwTmFtZTogc3RyaW5nLCBtZXNzYWdlOiBzdHJpbmcpIHtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgdGltZXN0YW1wID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpLnJlcGxhY2UoXCJUXCIsIFwiIFwiKS5zdWJzdHJpbmcoMCwgMTkpO1xyXG4gICAgICAgIGNvbnN0IHBheWxvYWQgPSB7XHJcbiAgICAgICAgICAgIHR5cGU6IFwiR1VJX1dJTkRPV19FUlJPUlwiLFxyXG4gICAgICAgICAgICB3aWQ6IFwiXCIsXHJcbiAgICAgICAgICAgIHBpZCxcclxuICAgICAgICAgICAgZmlsZTogYXBwTmFtZSxcclxuICAgICAgICAgICAgZXJyb3I6IG1lc3NhZ2UsXHJcbiAgICAgICAgICAgIGNvbnRleHQ6IFwibG9hZFwiLFxyXG4gICAgICAgICAgICB0aW1lc3RhbXAsXHJcbiAgICAgICAgfTtcclxuXHJcbiAgICAgICAgLy8gMS4gS2lyaW0ga2UgcGFyZW50IHByb2Nlc3MgKGJpc2EgV00gYmlsYSBhcHAgZGktbGF1bmNoIGRhcmkgbGF1bmNoZXIpXHJcbiAgICAgICAgY29uc3QgcGFyZW50UGlkID0gYXdhaXQgbGliLmdldFBhcmVudFBpZCgpO1xyXG4gICAgICAgIGlmIChwYXJlbnRQaWQpIHtcclxuICAgICAgICAgICAgYXdhaXQgbGliLnNoZWxsLnNlbmQocGFyZW50UGlkLCBwYXlsb2FkKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8vIDIuIEtpcmltIGp1Z2Ega2UgQXN0ZXJhY2VhIFdNIFx1MjAxNCB1bnR1ayBhcHAgeWFuZyBkaS1ydW4gdmlhXHJcbiAgICAgICAgLy8gICAgZmlsZS1jcnVpc2VyL3Rlcm1pbmFsIChmb3JlaWduIGFwcCkuIEJhY2EgUElEIFdNIGRhcmkgd20tcGlkIGZpbGUuXHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3Qgd21QaWRSYXcgPSBhd2FpdCBsaWIuZnMucmVhZEZpbGUoV01fUElEX0ZJTEUpO1xyXG4gICAgICAgICAgICBpZiAod21QaWRSYXcpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHdtUGlkID0gcGFyc2VJbnQoU3RyaW5nKHdtUGlkUmF3KS50cmltKCkpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgbXlQaWQgPSBsaWIuZ2V0UGlkKCk7XHJcbiAgICAgICAgICAgICAgICBpZiAod21QaWQgJiYgd21QaWQgIT09IG15UGlkICYmIHdtUGlkICE9PSBwYXJlbnRQaWQpIHtcclxuICAgICAgICAgICAgICAgICAgICBhd2FpdCBsaWIuc2hlbGwuc2VuZCh3bVBpZCwgcGF5bG9hZCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGNhdGNoIChfKSB7XHJcbiAgICAgICAgICAgIC8vIEFzdGVyYWNlYSB0aWRhayBiZXJqYWxhbiBcdTIwMTQgbm8tb3BcclxuICAgICAgICB9XHJcbiAgICB9IGNhdGNoIChfKSB7XHJcbiAgICAgICAgLy8gTm90aWZpa2FzaSBnYWdhbCBcdTIwMTQgbm9uLWZhdGFsXHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIG1haW4oKSB7XHJcbiAgICBjb25zdCBkYXRhID0gd29ya2VyRGF0YSBhcyBXb3JrZXJJbml0RGF0YTtcclxuICAgIGNvbnN0IHsgcGlkLCBhcHBOYW1lLCBhcmdzLCBhcHBQYXRoIH0gPSBkYXRhO1xyXG5cclxuICAgIC8vIExvYWQgVXNlckxpYiBkaW5hbWlzIGRhcmkgVkZTIENhY2hlIChNZW1vcnkgRXhlY3V0aW9uKVxyXG4gICAgY29uc3QgVXNlckxpYk1vZCA9IGhpamFja1JlcXVpcmUoXCJAdHNpeC9Vc2VyTGliXCIpO1xyXG4gICAgY29uc3QgVXNlckxpYkNsYXNzID0gVXNlckxpYk1vZC5Vc2VyTGliO1xyXG5cclxuICAgIGlmICghVXNlckxpYkNsYXNzKSB7XHJcbiAgICAgICAgY29uc29sZS5lcnJvcihgW1dvcmtlciAke3BpZH1dIENSSVRJQ0FMIEVSUk9SOiBGYWlsZWQgdG8gbG9hZCBVc2VyTGliIGZyb20gVkZTIE1lbW9yeSBDYWNoZSFgKTtcclxuICAgICAgICByZWFsRXhpdCgxKTtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCBsaWIgPSBuZXcgVXNlckxpYkNsYXNzKHBpZCk7XHJcbiAgICAoZ2xvYmFsIGFzIGFueSkuX3RzaXhMaWIgPSBsaWI7IC8vIFJlZ2lzdGVyIGZvciBleHBsaWNpdCBpbXBvcnRzICh2Mi4xKVxyXG5cclxuICAgIC8vIEpTLURpcmVjdCBwYXRoIHNob3VsZCBOT1QgaGF2ZSAtciBpbiBleGVjQXJndlxyXG4gICAgY29uc3QgaXNKc0RpcmVjdCA9ICFwcm9jZXNzLmV4ZWNBcmd2LnNvbWUoKGFyZykgPT4gYXJnLmluY2x1ZGVzKFwiLXJcIikpO1xyXG5cclxuICAgIC8vIDIuIENhcmkgYXBsaWthc2lueWFcclxuICAgIGNvbnN0IHRhcmdldEtleSA9IGFwcE5hbWUudHJpbSgpO1xyXG4gICAgbGV0IEFwcENsYXNzOiBhbnkgPSBudWxsO1xyXG4gICAgbGV0IGZpbmFsQXBwUGF0aCA9IGFwcFBhdGg7XHJcbiAgICAvLyBSZWFzb24gdGhlIGxvYWQgZmFpbGVkICh0cmFuc3BpbGUvZXhlY3V0aW9uKSBcdTIwMTQgdXNlZCBmb3IgYSBtb3JlIGhvbmVzdFxyXG4gICAgLy8gZmluYWwgbWVzc2FnZSBpbnN0ZWFkIG9mIHRoZSBtaXNsZWFkaW5nIFwiQXBwbGljYXRpb24gbm90IGZvdW5kXCIuXHJcbiAgICBsZXQgbG9hZEZhaWx1cmU6IHN0cmluZyB8IG51bGwgPSBudWxsO1xyXG4gICAgLy8gRGV0YWlsIGVycm9yIGFzbGlueWEgKHBlc2FuIGVzYnVpbGQvcnVudGltZSkgXHUyMDE0IGRpcGFrYWkgdW50dWsgcG9wdXAgZGVza3RvcFxyXG4gICAgLy8gYmlhciBzcGVzaWZpaywgYnVrYW4gc2VrYWRhciBrYXRlZ29yaSBcInRyYW5zcGlsZSBmYWlsZWRcIi5cclxuICAgIGxldCBsb2FkRXJyb3JEZXRhaWw6IHN0cmluZyB8IG51bGwgPSBudWxsO1xyXG5cclxuICAgIC8vIC0tLSBTVFJBVEVHSSBCQVJVOiBEaXJlY3QgTWVtb3J5IEV4ZWN1dGlvbiAoVGFucGEgLnZmc19jYWNoZSkgLS0tXHJcbiAgICBpZiAoIWZpbmFsQXBwUGF0aCAmJiAoZGF0YSBhcyBhbnkpLmFwcENvbnRlbnQgJiYgTW9kdWxlKSB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgbGV0IGNvbnRlbnQgPSAoZGF0YSBhcyBhbnkpLmFwcENvbnRlbnQ7XHJcbiAgICAgICAgICAgIGNvbnN0IGlzVHlwZVNjcmlwdCA9ICEoYXBwUGF0aCB8fCBhcHBOYW1lIHx8IFwiXCIpLnRvTG93ZXJDYXNlKCkuZW5kc1dpdGgoXCIuanNcIik7XHJcbiAgICAgICAgICAgIC8vIE1vZHVsZSBmaWxlbmFtZSBIQVJVUyBwaHlzaWNhbCBwYXRoIHVudHVrIHJlcXVpcmUoKSBuZW11IG5vZGVfbW9kdWxlc1xyXG4gICAgICAgICAgICBjb25zdCBtb2R1bGVGaWxlbmFtZSA9IHBhdGghLmpvaW4ocHJvY2Vzcy5jd2QoKSwgYXBwTmFtZSArIFwiLmpzXCIpO1xyXG4gICAgICAgICAgICAvLyBTdGFjayBmaWxlbmFtZSA9IEJLRlMgcGF0aCBiaWFyIHN0YWNrIHRyYWNlIGJlbmVyICgvb3B0L3Rlc3QvZ3VpLXRlc3QuanMpXHJcbiAgICAgICAgICAgIC8vIHN0YWNrQmtmc1BhdGggPSBCS0ZTIHBhdGggdW50dWsgc3RhY2sgdHJhY2UgKC9vcHQvdGVzdC9ndWktdGVzdC5qcylcclxuICAgICAgICAgICAgY29uc3Qgc3RhY2tCa2ZzUGF0aCA9IChkYXRhIGFzIGFueSkuc3RhY2tCa2ZzUGF0aDtcclxuICAgICAgICAgICAgY29uc3Qgc3RhY2tGaWxlbmFtZSA9IHN0YWNrQmtmc1BhdGggPyBzdGFja0JrZnNQYXRoLnJlcGxhY2UoL1xcLnRzJC8sIFwiLmpzXCIpIDogbW9kdWxlRmlsZW5hbWU7XHJcbiAgICAgICAgICAgIC8vIHNvdXJjZWZpbGUgdW50dWsgZXNidWlsZCBzb3VyY2VtYXAgXHUyMDE0IGN1a3VwIG5hbWEgZmlsZSBhamEgKHRhbnBhIHBhdGgpXHJcbiAgICAgICAgICAgIGNvbnN0IHNvdXJjZUZpbGVOYW1lID0gKHN0YWNrQmtmc1BhdGggfHwgbW9kdWxlRmlsZW5hbWUpLnNwbGl0KC9bXFxcXC9dLykucG9wKCkhLnJlcGxhY2UoL1xcLmpzJC8sIFwiLnRzXCIpO1xyXG5cclxuICAgICAgICAgICAgLy8gLS0tIE1PRFVMIFJFTEFUSUYgUFJPR1JBTSAoLi94LCAuLi95KSAtLS1cclxuICAgICAgICAgICAgLy9cclxuICAgICAgICAgICAgLy8gRGlrdW1wdWxrYW4gU0VLQVJBTkcgKG1haW4oKSBhc3luYykga2FyZW5hIGBNb2R1bGUuX2xvYWRgIHNpbmtyb25cclxuICAgICAgICAgICAgLy8gc2VkYW5na2FuIGJhY2EgVkZTIGxld2F0IHN5c2NhbGwgYXNpbmtyb246IGhvb2sgcmVxdWlyZSB0aWRhayBtdW5na2luXHJcbiAgICAgICAgICAgIC8vIG1lbWJhY2EgZmlsZSBzZW5kaXJpLiBUYW5wYSBsYW5na2FoIGluaSwgYHJlcXVpcmUoXCIuL1Rwa2dQcm90b2NvbFwiKWBcclxuICAgICAgICAgICAgLy8gbWVuY2FyaSBmaWxlIGl0dSBkaSBIT1NUIGZpbGVzeXN0ZW0gZGFuIGdhZ2FsLlxyXG4gICAgICAgICAgICBpZiAoc3RhY2tCa2ZzUGF0aCkge1xyXG4gICAgICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBlc2J1aWxkTW9kID0gaG9zdFJlcXVpcmUhKFwiZXNidWlsZFwiKTtcclxuICAgICAgICAgICAgICAgICAgICBwcm9ncmFtTW9kdWxlcyA9IGF3YWl0IGNvbGxlY3RSZWxhdGl2ZU1vZHVsZXMoe1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRyeUlkOiBzdGFja0JrZnNQYXRoLnJlcGxhY2UoL1xcLih0c3xqcykkL2ksIFwiXCIpLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBzb3VyY2U6IGNvbnRlbnQsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIElzaSBWRlMgPSBCWVRFOyBtb2R1bCByZWxhdGlmIGRpa29tcGlsYXNpIHNlYmFnYWkgVEVLUy5cclxuICAgICAgICAgICAgICAgICAgICAgICAgcmVhZEZpbGU6IGFzeW5jICh2ZnNQYXRoOiBzdHJpbmcpID0+IHZmc0J5dGVzVG9VdGY4KGF3YWl0IGxpYi5mcy5yZWFkRmlsZSh2ZnNQYXRoKSksXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRyYW5zcGlsZTogKHNyYzogc3RyaW5nLCBtb2R1bGVJZDogc3RyaW5nKSA9PlxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXNidWlsZE1vZC50cmFuc2Zvcm1TeW5jKHNyYywge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxvYWRlcjogXCJ0c1wiLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvcm1hdDogXCJjanNcIixcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YXJnZXQ6IFwibm9kZTE4XCIsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc291cmNlbWFwOiBcImlubGluZVwiLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNvdXJjZWZpbGU6IG1vZHVsZUlkLnNwbGl0KFwiL1wiKS5wb3AoKSArIFwiLnRzXCIsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KS5jb2RlLFxyXG4gICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgfSBjYXRjaCAoZTogYW55KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgLy8gTm9uLWZhdGFsOiBpbXBvcnQgcmVsYXRpZiBha2FuIGdhZ2FsIGRlbmdhbiBwZXNhbiBOb2RlIGJpYXNhLlxyXG4gICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYFtXb3JrZXIgJHtwaWR9XSBMb2NhbCBtb2R1bGUgc2NhbiBmYWlsZWQ6ICR7ZS5tZXNzYWdlfWApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICAvLyBKaWthIGNvbnRlbnQgYWRhbGFoIFR5cGVTY3JpcHQsIHRyYW5zcGlsZSBkdWx1IGtlIEphdmFTY3JpcHRcclxuICAgICAgICAgICAgaWYgKGlzVHlwZVNjcmlwdCkge1xyXG4gICAgICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBlc2J1aWxkID0gaG9zdFJlcXVpcmUhKFwiZXNidWlsZFwiKTtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCByZXN1bHQgPSBlc2J1aWxkLnRyYW5zZm9ybVN5bmMoY29udGVudCwge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBsb2FkZXI6IFwidHNcIixcclxuICAgICAgICAgICAgICAgICAgICAgICAgZm9ybWF0OiBcImNqc1wiLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0YXJnZXQ6IFwibm9kZTE4XCIsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHNvdXJjZW1hcDogXCJpbmxpbmVcIixcclxuICAgICAgICAgICAgICAgICAgICAgICAgc291cmNlZmlsZTogc291cmNlRmlsZU5hbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgICAgICAgICAgY29udGVudCA9IHJlc3VsdC5jb2RlO1xyXG4gICAgICAgICAgICAgICAgfSBjYXRjaCAodHJhbnNwaWxlRXJyOiBhbnkpIHtcclxuICAgICAgICAgICAgICAgICAgICBsb2FkRmFpbHVyZSA9IFwidHJhbnNwaWxlIGZhaWxlZFwiO1xyXG4gICAgICAgICAgICAgICAgICAgIGxvYWRFcnJvckRldGFpbCA9IGBUUyBUcmFuc3BpbGUgRXJyb3I6ICR7dHJhbnNwaWxlRXJyLm1lc3NhZ2V9YDtcclxuICAgICAgICAgICAgICAgICAgICBlbWl0V29ya2VyRXJyb3IobGliLCBwaWQsIGBUUyBUcmFuc3BpbGUgRXJyb3I6ICR7dHJhbnNwaWxlRXJyLm1lc3NhZ2V9YCk7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgdHJhbnNwaWxlRXJyO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICAvLyBDcmVhdGUgYSBuZXcgbW9kdWxlIGluc3RhbmNlIHdpdGggcGh5c2ljYWwgcGF0aCAoZm9yIG5vZGVfbW9kdWxlcyByZXNvbHV0aW9uKVxyXG4gICAgICAgICAgICBjb25zdCBhcHBNb2R1bGUgPSBuZXcgTW9kdWxlKG1vZHVsZUZpbGVuYW1lLCBtb2R1bGUucGFyZW50KTtcclxuICAgICAgICAgICAgYXBwTW9kdWxlLmZpbGVuYW1lID0gc3RhY2tGaWxlbmFtZTsgLy8gX19maWxlbmFtZSBzaG93cyBCS0ZTIHBhdGhcclxuICAgICAgICAgICAgYXBwTW9kdWxlLnBhdGhzID0gTW9kdWxlLl9ub2RlTW9kdWxlUGF0aHMocGF0aCEuZGlybmFtZShtb2R1bGVGaWxlbmFtZSkpO1xyXG5cclxuICAgICAgICAgICAgLy8gX2NvbXBpbGUgZGVuZ2FuIHN0YWNrRmlsZW5hbWUgYWdhciBzdGFjayB0cmFjZSBudW5qdWsgQktGUyBwYXRoXHJcbiAgICAgICAgICAgIChhcHBNb2R1bGUgYXMgYW55KS5fY29tcGlsZShjb250ZW50LCBzdGFja0ZpbGVuYW1lKTtcclxuXHJcbiAgICAgICAgICAgIEFwcENsYXNzID1cclxuICAgICAgICAgICAgICAgIGFwcE1vZHVsZS5leHBvcnRzLm1haW4gfHwgYXBwTW9kdWxlLmV4cG9ydHMuTWFpbiB8fCBhcHBNb2R1bGUuZXhwb3J0cy5kZWZhdWx0IHx8IGFwcE1vZHVsZS5leHBvcnRzO1xyXG5cclxuICAgICAgICAgICAgLy8gSmlrYSBtYXNpaCBiZWx1bSBrZXRlbXUgKGUuZy4gZXhwb3J0IGNsYXNzIGJ1a2FuIGRlZmF1bHQvbWFpbilcclxuICAgICAgICAgICAgaWYgKHR5cGVvZiBBcHBDbGFzcyAhPT0gXCJmdW5jdGlvblwiKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBlbnRyaWVzID0gT2JqZWN0LmVudHJpZXMoYXBwTW9kdWxlLmV4cG9ydHMpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgZm91bmQgPSBlbnRyaWVzLmZpbmQoKFtfLCB2YWxdOiBbc3RyaW5nLCBhbnldKSA9PiB0eXBlb2YgdmFsID09PSBcImZ1bmN0aW9uXCIpO1xyXG4gICAgICAgICAgICAgICAgaWYgKGZvdW5kKSBBcHBDbGFzcyA9IGZvdW5kWzFdO1xyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICBpZiAoQXBwQ2xhc3MpIHtcclxuICAgICAgICAgICAgICAgIC8vIGNvbnNvbGUubG9nKGBbV29ya2VyICR7cGlkfV0gRGlyZWN0IE1lbW9yeSBFeGVjdXRpb24gc3VjY2VzcyBmb3IgJHthcHBOYW1lfWApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyOiBhbnkpIHtcclxuICAgICAgICAgICAgaWYgKCFsb2FkRmFpbHVyZSkgbG9hZEZhaWx1cmUgPSBcImRpcmVjdCBleGVjdXRpb24gZmFpbGVkXCI7XHJcbiAgICAgICAgICAgIGlmICghbG9hZEVycm9yRGV0YWlsKSBsb2FkRXJyb3JEZXRhaWwgPSBgRGlyZWN0IEV4ZWN1dGlvbiBFcnJvcjogJHtlcnIubWVzc2FnZX1gO1xyXG4gICAgICAgICAgICBlbWl0V29ya2VyRXJyb3IobGliLCBwaWQsIGBEaXJlY3QgRXhlY3V0aW9uIEVycm9yOiAke2Vyci5tZXNzYWdlfWApO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBpZiAoZmluYWxBcHBQYXRoICYmIGhvc3RSZXF1aXJlKSB7XHJcbiAgICAgICAgLy8gU1RSQVRFR0kgQkFSVTogRHluYW1pYyBMb2FkaW5nIGRhcmkgRmlsZSBGaXNpayAoTGludXgtbGlrZSlcclxuICAgICAgICAvLyBTVFJBVEVHSTogRHluYW1pYyBMb2FkaW5nIGRhcmkgRmlsZSBGaXNpayAoSnVqdXIgUGFrZSAudHMpXHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgbW9kdWxlID0gaG9zdFJlcXVpcmUoZmluYWxBcHBQYXRoKTtcclxuICAgICAgICAgICAgY29uc3QgZW50cmllcyA9IE9iamVjdC5lbnRyaWVzKG1vZHVsZSk7XHJcblxyXG4gICAgICAgICAgICAvLyBbREVCVUddIENoZWNrIHdoYXQgd2UgZm91bmRcclxuICAgICAgICAgICAgLy8gY29uc29sZS5sb2coYFtXb3JrZXIgJHtwaWR9XSBMb2FkZWQgbW9kdWxlIGZvciAke2FwcE5hbWV9LiBLZXlzOiAke09iamVjdC5rZXlzKG1vZHVsZSkuam9pbihcIiwgXCIpfWApO1xyXG5cclxuICAgICAgICAgICAgLy8gU1RSQVRFR0kgU1RBTkRBUjogQ2FyaSBleHBvcnQgYmVybmFtYSAnbWFpbidcclxuICAgICAgICAgICAgaWYgKG1vZHVsZS5tYWluKSB7XHJcbiAgICAgICAgICAgICAgICBBcHBDbGFzcyA9IG1vZHVsZS5tYWluO1xyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKG1vZHVsZS5NYWluKSB7XHJcbiAgICAgICAgICAgICAgICBBcHBDbGFzcyA9IG1vZHVsZS5NYWluO1xyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKG1vZHVsZS5kZWZhdWx0KSB7XHJcbiAgICAgICAgICAgICAgICBBcHBDbGFzcyA9IG1vZHVsZS5kZWZhdWx0O1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgLy8gRmFsbGJhY2s6IEFtYmlsIGV4cG9ydCBwZXJ0YW1hIHlhbmcgYmVydXBhIGNsYXNzL2Z1bmN0aW9uXHJcbiAgICAgICAgICAgICAgICBjb25zdCBmb3VuZCA9IGVudHJpZXMuZmluZCgoW18sIHZhbF06IFtzdHJpbmcsIGFueV0pID0+IHR5cGVvZiB2YWwgPT09IFwiZnVuY3Rpb25cIik7XHJcbiAgICAgICAgICAgICAgICBpZiAoZm91bmQpIEFwcENsYXNzID0gZm91bmRbMV07XHJcbiAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgIGlmIChBcHBDbGFzcykge1xyXG4gICAgICAgICAgICAgICAgLy8gY29uc29sZS5sb2coYFtXb3JrZXIgJHtwaWR9XSBJZGVudGlmaWVkIEFwcENsYXNzIGZvciAke2FwcE5hbWV9YCk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBsb2FkRmFpbHVyZSA9IFwibm8gdmFsaWQgJ21haW4nIGV4cG9ydCBmb3VuZFwiO1xyXG4gICAgICAgICAgICAgICAgbG9hZEVycm9yRGV0YWlsID0gYEZhaWxlZCB0byBpZGVudGlmeSBBcHBDbGFzcyBmb3IgJHthcHBOYW1lfS4gTW9kdWxlIGV4cG9ydHM6ICR7T2JqZWN0LmtleXMobW9kdWxlKS5qb2luKFwiLCBcIil9YDtcclxuICAgICAgICAgICAgICAgIGVtaXRXb3JrZXJFcnJvcihcclxuICAgICAgICAgICAgICAgICAgICBsaWIsXHJcbiAgICAgICAgICAgICAgICAgICAgcGlkLFxyXG4gICAgICAgICAgICAgICAgICAgIGBGYWlsZWQgdG8gaWRlbnRpZnkgQXBwQ2xhc3MgZm9yICR7YXBwTmFtZX0uIE1vZHVsZSBleHBvcnRzOiAke09iamVjdC5rZXlzKG1vZHVsZSkuam9pbihcIiwgXCIpfWAsXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyOiBhbnkpIHtcclxuICAgICAgICAgICAgbG9hZEZhaWx1cmUgPSBcImZhaWxlZCB0byBsb2FkIG1vZHVsZVwiO1xyXG4gICAgICAgICAgICBsb2FkRXJyb3JEZXRhaWwgPSBgUnVudGltZSBFcnJvcjogRmFpbGVkIHRvIHJlcXVpcmUgJHtmaW5hbEFwcFBhdGggfHwgYXBwTmFtZX06ICR7ZXJyLm1lc3NhZ2V9YDtcclxuICAgICAgICAgICAgZW1pdFdvcmtlckVycm9yKGxpYiwgcGlkLCBgUnVudGltZSBFcnJvcjogRmFpbGVkIHRvIHJlcXVpcmUgJHtmaW5hbEFwcFBhdGggfHwgYXBwTmFtZX06ICR7ZXJyLm1lc3NhZ2V9YCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIGlmICghQXBwQ2xhc3MpIHtcclxuICAgICAgICBpZiAocGFyZW50UG9ydCkge1xyXG4gICAgICAgICAgICBjb25zdCBlcnJvck1zZyA9IGxvYWRGYWlsdXJlXHJcbiAgICAgICAgICAgICAgICA/IGAtYmFzaDogJHthcHBOYW1lfTogRmFpbGVkIHRvIGxvYWQgXHUyMDE0ICR7bG9hZEZhaWx1cmV9XFxuYFxyXG4gICAgICAgICAgICAgICAgOiBgLWJhc2g6ICR7YXBwTmFtZX06IEFwcGxpY2F0aW9uIG5vdCBmb3VuZCAoUGF0aDogJHthcHBQYXRoIHx8IFwiVkZTLU9ubHlcIn0pXFxuYDtcclxuICAgICAgICAgICAgYXdhaXQgbGliLnN0ZC5wcmludChlcnJvck1zZyk7XHJcbiAgICAgICAgICAgIHBhcmVudFBvcnQucG9zdE1lc3NhZ2Uoe1xyXG4gICAgICAgICAgICAgICAgc3VjY2VzczogZmFsc2UsXHJcbiAgICAgICAgICAgICAgICBlcnJvcjogZXJyb3JNc2cudHJpbSgpLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgLy8gVGFtcGlsa2FuIGp1Z2EgZGkgZGVza3RvcCAoV00vQXN0ZXJhY2VhKSB2aWEgR1VJX1dJTkRPV19FUlJPUi5cclxuICAgICAgICAgICAgLy8gV0FKSUIgZGktYXdhaXQ6IHJlYWxFeGl0KDEpIGRpIGJhd2FoIGxhbmdzdW5nIG1lbWF0aWthbiB3b3JrZXIsIGRhblxyXG4gICAgICAgICAgICAvLyBrYWxhdSBmaXJlLWFuZC1mb3JnZXQsIGtpcmltYW4gYXN5bmMtbnlhIHRhayBzZW1wYXQgc2VsZXNhaS5cclxuICAgICAgICAgICAgLy8gUG9wdXAgcGFrYWkgZGV0YWlsIGVycm9yIGFzbGkgKGxvYWRFcnJvckRldGFpbCkgYmlhciBzcGVzaWZpay5cclxuICAgICAgICAgICAgYXdhaXQgbm90aWZ5TG9hZEVycm9yKGxpYiwgcGlkLCBhcHBOYW1lLCBsb2FkRXJyb3JEZXRhaWwgfHwgZXJyb3JNc2cudHJpbSgpKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmVhbEV4aXQoMSk7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gMy4gQUtUSUZLQU4gU0FOREJPWCAoS3VuY2kgcGludHUgc2ViZWx1bSBhcGxpa2FzaSBiZXJqYWxhbilcclxuICAgIHJlc3RyaWN0SG9zdEFQSShhcHBOYW1lKTtcclxuXHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IGFwcCA9IG5ldyBBcHBDbGFzcygpO1xyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGFwcC5leGVjdXRlKGxpYiBhcyBhbnksIGFyZ3MpO1xyXG5cclxuICAgICAgICAvLyAzLiBKaWthIGFwbGlrYXNpIG1lLXJldHVybiBzdHJpbmcsIGNldGFrIGtlIGxheWFyIHZpYSBQUklOVCBzeXNjYWxsXHJcbiAgICAgICAgaWYgKHJlc3VsdCAmJiB0eXBlb2YgcmVzdWx0ID09PSBcInN0cmluZ1wiICYmIHJlc3VsdC50cmltKCkgIT09IFwiXCIpIHtcclxuICAgICAgICAgICAgYXdhaXQgbGliLnN0ZC5wcmludChyZXN1bHQgKyBcIlxcblwiKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8vIDQuIEJlcml0YWh1IEtlcm5lbCBiYWh3YSBwcm9zZXMgc2VsZXNhaVxyXG4gICAgICAgIGF3YWl0IGxpYi5zaGVsbC5leGl0KDApO1xyXG4gICAgfSBjYXRjaCAoZXJyb3I6IGFueSkge1xyXG4gICAgICAgIC8vIExhcG9ya2FuIGVycm9yIGtlIHBhcmVudCAoV00pIHZpYSBJUENcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBwYXJlbnRQaWQgPSBhd2FpdCBsaWIuZ2V0UGFyZW50UGlkKCk7XHJcbiAgICAgICAgICAgIGlmIChwYXJlbnRQaWQpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IGxpYi5zaGVsbC5zZW5kKHBhcmVudFBpZCwge1xyXG4gICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiR1VJX1dJTkRPV19FUlJPUlwiLFxyXG4gICAgICAgICAgICAgICAgICAgIHdpZDogXCJcIixcclxuICAgICAgICAgICAgICAgICAgICBwaWQ6IGxpYi5nZXRQaWQoKSxcclxuICAgICAgICAgICAgICAgICAgICBmaWxlOiBhcHBOYW1lIHx8IFwiXCIsXHJcbiAgICAgICAgICAgICAgICAgICAgZXJyb3I6IGBSdW50aW1lIEVycm9yOiAke2Vycm9yLm1lc3NhZ2V9YCxcclxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0OiBcInJ1bnRpbWVcIixcclxuICAgICAgICAgICAgICAgICAgICB0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5yZXBsYWNlKFwiVFwiLCBcIiBcIikuc3Vic3RyaW5nKDAsIDE5KSxcclxuICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBjYXRjaCAoXykge1xyXG4gICAgICAgICAgICAvKiBJUEMgc2VuZCBmYWlsdXJlIGlzIG5vbi1mYXRhbCAqL1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgLy8gSnVnYSBjb2JhIGxld2F0IHN0ZC5lcnJvciB5YW5nIHB1bnlhIG1la2FuaXNtZSBsZWJpaCBsZW5na2FwXHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgYXdhaXQgbGliLnN0ZC5lcnJvcihlcnJvci5tZXNzYWdlIHx8IFN0cmluZyhlcnJvciksIGFwcE5hbWUgfHwgXCJhcHBcIik7XHJcbiAgICAgICAgfSBjYXRjaCAoXykge31cclxuXHJcbiAgICAgICAgLy8gTGFwb3JrYW4gZXJyb3Iga2UgVFRZIGNvbnNvbGVcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBhd2FpdCBsaWIuc3RkLnByaW50KGBcXG5bV29ya2VyICR7cGlkfV0gUnVudGltZSBFcnJvcjogJHtlcnJvci5tZXNzYWdlfVxcbmApO1xyXG4gICAgICAgIH0gY2F0Y2ggKGUpIHt9XHJcbiAgICAgICAgcmVhbEV4aXQoMSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbm1haW4oKTtcclxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsNEJBQXVDO0FBRXZDLCtCQUEyRDtBQWlCM0QsTUFBTSxpQkFBaUIsQ0FBQyxRQUNwQixRQUFRLFFBQVEsUUFBUSxTQUFZLEtBQUssT0FBTyxLQUFLLEtBQUssUUFBUSxFQUFFLFNBQVMsTUFBTTtBQVV2RixNQUFNLGNBQWM7QUFZcEIsTUFBTSxXQUFXLFFBQVEsS0FBSyxLQUFLLE9BQU87QUFLMUMsTUFBTSxjQUFjLE9BQU8sWUFBWSxjQUFjLFVBQVU7QUFDL0QsTUFBTSxPQUFPLGNBQWMsWUFBWSxNQUFNLElBQUk7QUFDakQsTUFBTSxTQUFTLGNBQWMsWUFBWSxRQUFRLElBQUk7QUFtQnJELFNBQVMsd0JBQXdCLFVBQWtCLFNBQXlCO0FBQ3hFLFFBQU0sUUFBUSxTQUFTLE1BQU0sR0FBRztBQUNoQyxRQUFNLElBQUk7QUFDVixhQUFXLE9BQU8sUUFBUSxNQUFNLEdBQUcsR0FBRztBQUNsQyxRQUFJLFFBQVEsTUFBTSxRQUFRLElBQUs7QUFDL0IsUUFBSSxRQUFRLE1BQU07QUFFZCxVQUFJLE1BQU0sU0FBUyxFQUFHLE9BQU0sSUFBSTtBQUNoQztBQUFBLElBQ0o7QUFDQSxVQUFNLEtBQUssR0FBRztBQUFBLEVBQ2xCO0FBQ0EsU0FBTyxNQUFNLEtBQUssR0FBRztBQUN6QjtBQVlBLElBQUksaUJBQXlDLENBQUM7QUFFOUMsSUFBSSxVQUFVLE1BQU07QUFDaEIsUUFBTSxlQUFlLE9BQU87QUFDNUIsUUFBTSxXQUFZLGlDQUFtQixZQUFZLENBQUM7QUFDbEQsUUFBTSxjQUFtQyxDQUFDO0FBSTFDLFFBQU0saUJBQXlDLENBQUM7QUFFaEQsU0FBTyxRQUFRLFNBQVUsU0FBaUIsUUFBYSxRQUFp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
