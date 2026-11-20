var import_worker_threads = require("worker_threads");
var import_VfsModuleResolver = require("./VfsModuleResolver");
const vfsBytesToUtf8 = (raw) => raw === null || raw === void 0 ? "" : Buffer.from(raw, "latin1").toString("utf8");
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
const WM_PID_FILE = "/var/run/asteracea/wm-pid";
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
  const isPrivileged = appName.toLowerCase().includes("server") || appName.toLowerCase().includes("daemon") || appName.toLowerCase().includes("dome") || appName.toLowerCase().includes("tbuild") || appName.toLowerCase().includes("vfs") || appName.toLowerCase().includes("mysqld");
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiV29ya2VyRW50cnkudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IHdvcmtlckRhdGEsIHBhcmVudFBvcnQgfSBmcm9tIFwid29ya2VyX3RocmVhZHNcIjtcclxuaW1wb3J0IHsgV29ya2VySW5pdERhdGEsIFN5c2NhbGxSZXNwb25zZSB9IGZyb20gXCIuLi9jb21tb24vSVBDVHlwZXNcIjtcclxuaW1wb3J0IHsgY29sbGVjdFJlbGF0aXZlTW9kdWxlcywgcmVzb2x2ZVZmc1JlbGF0aXZlIH0gZnJvbSBcIi4vVmZzTW9kdWxlUmVzb2x2ZXJcIjtcclxuXHJcbi8qKlxyXG4gKiBCeXRlIFZGUyAobGF0aW4xKSBcdTIxOTIgdGVrcyB1bnR1ayBkaWtvbXBpbGFzaS5cclxuICpcclxuICogRElTQUxJTiBMT0tBTCwgc2VuZ2FqYSBUSURBSyBkaS1gaW1wb3J0YCBkYXJpIGBAY29tbW9uL1Zmc1RleHRgOiBiZXJrYXMgaW5pIGFkYWxhaFxyXG4gKiAqd29ya2VyIGVudHJ5KiB5YW5nIGRpamFsYW5rYW4gZGkgSE9TVCwgZGFuIHdvcmtlciBqYWx1ciAqKkpTLURpcmVjdCoqIChtaXMuXHJcbiAqIGAvYmluL3RzaC5qc2ApIHNlbmdhamEgZGlqYWxhbmthbiBUQU5QQSBwcmVsb2FkIHRyYW5zcGlsZXIgXHUyMDE0IGphZGkgYHJlcXVpcmUoKWAga2VcclxuICogYmVya2FzIGAudHNgIEdBR0FMOlxyXG4gKlxyXG4gKiAgICAgV29ya2VyIFsyXSBDcmFzaCBFcnJvcjogQ2Fubm90IGZpbmQgbW9kdWxlICcuLi9jb21tb24vVmZzVGV4dCdcclxuICogICAgIFx1MjE5MiB3b3JrZXIgbWF0aSBzZWJlbHVtIG1lbmdpcmltICdyZWFkeScgXHUyMTkyIGJvb3QgZGlhbSBkaSAvZXRjL3JjLmxvY2FsXHJcbiAqXHJcbiAqIChgLi4vY29tbW9uL0lQQ1R5cGVzYCBhbWFuIGthcmVuYSBzaWRlY2FyIGAuanNgLW55YSBhZGEgZGkgcmVwbzsgYFZmc1RleHQudHNgIGJhcnVcclxuICogdGlkYWsgcHVueWEuKSBJbXBsZW1lbnRhc2lueWEgc2F0dSBiYXJpcywgamFkaSBkdXBsaWthc2kgaW5pIGxlYmloIG11cmFoIGRhcmlwYWRhXHJcbiAqIG1lbWFrc2EgSlMtRGlyZWN0IG1lbXVhdCB0cmFuc3BpbGVyIGAudHNgICgrfjE1IE1CIFJTUyBwZXIgd29ya2VyKS5cclxuICovXHJcbmNvbnN0IHZmc0J5dGVzVG9VdGY4ID0gKHJhdzogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCk6IHN0cmluZyA9PlxyXG4gICAgcmF3ID09PSBudWxsIHx8IHJhdyA9PT0gdW5kZWZpbmVkID8gXCJcIiA6IEJ1ZmZlci5mcm9tKHJhdywgXCJsYXRpbjFcIikudG9TdHJpbmcoXCJ1dGY4XCIpO1xyXG5cclxuLyoqXHJcbiAqIFdPUktFUiBFTlRSWSBQT0lOVFxyXG5cclxuICogXHJcbiAqIEluaSBhZGFsYWggc2NyaXB0IFwiQm9vdGxvYWRlclwiIHlhbmcgamFsYW4gZGkgZGFsYW0gV29ya2VyIFRocmVhZC5cclxuICogVHVnYXNueWE6IEluaXNpYWxpc2FzaSBVc2VyTGliIGRhbiBqYWxhbmthbiBhcGxpa2FzaS5cclxuICovXHJcblxyXG4vLyB0c2NvbmZpZy1wYXRocyBkYW4gZXNidWlsZC1yZWdpc3RlciBzdWRhaCBkaS1sb2FkIHZpYSBleGVjQXJndiBkaSBTY2hlZHVsZXIudHNcclxuXHJcbmNvbnN0IHJlYWxFeGl0ID0gcHJvY2Vzcy5leGl0LmJpbmQocHJvY2Vzcyk7XHJcblxyXG4vLyAtLS0gUEVSRk9STUFOQ0UgSElKQUNLIC0tLVxyXG4vLyBQcmUtbG9hZCBjb3JlIGxpYnJhcmllcyBhbmQgaGlqYWNrIHJlcXVpcmUgdG8gYXZvaWQgbXVsdGlwbGUgRlMgaGl0c1xyXG4vLyBpbiB0aGUgaGlnaC1wZXJmb3JtYW5jZSBwYXRoLlxyXG5jb25zdCBob3N0UmVxdWlyZSA9IHR5cGVvZiByZXF1aXJlICE9PSBcInVuZGVmaW5lZFwiID8gcmVxdWlyZSA6IG51bGw7XHJcbmNvbnN0IHBhdGggPSBob3N0UmVxdWlyZSA/IGhvc3RSZXF1aXJlKFwicGF0aFwiKSA6IG51bGw7XHJcbmNvbnN0IE1vZHVsZSA9IGhvc3RSZXF1aXJlID8gaG9zdFJlcXVpcmUoXCJtb2R1bGVcIikgOiBudWxsO1xyXG5cclxuLyoqXHJcbiAqIHJlc29sdmVSZWxhdGl2ZU1vZHVsZUlkKCk6IE1lbmVyamVtYWhrYW4gaW1wb3J0IHJlbGF0aWYgTUlMSUsgTU9EVUxcclxuICogRlJBTUVXT1JLIGtlIG1vZHVsZS1pZCAoYEB0c2l4L3hgLCBgQGNvbW1vbi9hL2JgKS5cclxuICpcclxuICogS2VuYXBhIHBlcmx1OiBXb3JrZXJFbnRyeSBtZS1fY29tcGlsZSgpIG1vZHVsIGZyYW1ld29yayBkYXJpIG1lbW9yeSBkZW5nYW5cclxuICogbmFtYSBmaWxlIGJ1YXRhbiAoYEBjb21tb25fbmV0ZnMvTmV0RlNTZXJ2ZXIuanNgKSwgamFkaSBgLi9OZXRGU1Byb3RvY29sYFxyXG4gKiBoYW55YSBiaXNhIGRpLXJlc29sdmUga2FsYXUga2l0YSB0YWh1IGlkIG1vZHVsIGluZHVrbnlhLiBDYXJhIGxhbWEgbWVtYWthaVxyXG4gKiBgcGF0aC5iYXNlbmFtZShwYXJlbnQuZmlsZW5hbWUpYDpcclxuICpcclxuICogICAtIGBAdHNpeF9BcHBsaWNhdGlvbi5qc2AgICAgICBcdTIxOTIgYmFzZW5hbWUgY29jb2ssIGAuL3hgIFx1MjE5MiBgQHRzaXgveGAgICBcdTI3MDVcclxuICogICAtIGBOZXRGU1NlcnZlci5qc2AgKGJlcnNhcmFuZykgXHUyMTkyIGJhc2VuYW1lIFRJREFLIGNvY29rLCBgLi9OZXRGU1Byb3RvY29sYFxyXG4gKiAgICAgZGliaWFya2FuIGFwYSBhZGFueWEgXHUyMTkyIGBDYW5ub3QgZmluZCBtb2R1bGUgJy4vTmV0RlNQcm90b2NvbCdgICBcdTI3NENcclxuICpcclxuICogRGVuZ2FuIHJlc29sdXNpIGRpIHJ1YW5nIG1vZHVsZS1pZCwga2VkYWxhbWFuIGJlcmFwYSBwdW4gdGV0YXAgYmVuYXI6XHJcbiAqICAgYEBjb21tb24vbmV0ZnMvTmV0RlNTZXJ2ZXJgICsgYC4vTmV0RlNQcm90b2NvbGAgXHUyMTkyIGBAY29tbW9uL25ldGZzL05ldEZTUHJvdG9jb2xgXHJcbiAqICAgYEBjb21tb24vbmV0ZnMvTmV0RlNTZXJ2ZXJgICsgYC4uL0xvZ2dlcmAgICAgICAgXHUyMTkyIGBAY29tbW9uL0xvZ2dlcmBcclxuICovXHJcbmZ1bmN0aW9uIHJlc29sdmVSZWxhdGl2ZU1vZHVsZUlkKHBhcmVudElkOiBzdHJpbmcsIHJlcXVlc3Q6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBwYXJ0cyA9IHBhcmVudElkLnNwbGl0KFwiL1wiKTtcclxuICAgIHBhcnRzLnBvcCgpOyAvLyBidWFuZyBuYW1hIG1vZHVsIGluZHVrXHJcbiAgICBmb3IgKGNvbnN0IHNlZyBvZiByZXF1ZXN0LnNwbGl0KFwiL1wiKSkge1xyXG4gICAgICAgIGlmIChzZWcgPT09IFwiXCIgfHwgc2VnID09PSBcIi5cIikgY29udGludWU7XHJcbiAgICAgICAgaWYgKHNlZyA9PT0gXCIuLlwiKSB7XHJcbiAgICAgICAgICAgIC8vIFNpc2FrYW4gc2VnbWVuIHNjb3BlIChgQHRzaXhgIC8gYEBjb21tb25gKSBcdTIwMTQgamFuZ2FuIHBlcm5haCBoYWJpcy5cclxuICAgICAgICAgICAgaWYgKHBhcnRzLmxlbmd0aCA+IDEpIHBhcnRzLnBvcCgpO1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcGFydHMucHVzaChzZWcpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHBhcnRzLmpvaW4oXCIvXCIpO1xyXG59XHJcblxyXG4vKipcclxuICogTU9EVUwgUkVMQVRJRiBNSUxJSyBQUk9HUkFNIFZGUyAobWlzLiBgL3NiaW4vdHBrZ2RgICsgYC4vVHBrZ1Byb3RvY29sYCkuXHJcbiAqXHJcbiAqIGBNb2R1bGUuX2xvYWRgIHNpbmtyb24sIHNlZGFuZ2thbiBiYWNhIFZGUyBhc2lua3JvbiBcdTIwMTQgamFkaSBpc2lueWEgZGlrdW1wdWxrYW5cclxuICogbGViaWggZHVsdSBkaSBgbWFpbigpYCAobGloYXQgYGNvbGxlY3RSZWxhdGl2ZU1vZHVsZXNgKSwgbGFsdSBob29rIGRpIGJhd2FoXHJcbiAqIGhhbnlhIE1FTElIQVQgcGV0YSBpbmk6IGlkIG1vZHVsZSAoYC9zYmluL1Rwa2dQcm90b2NvbGApIFx1MjE5MiBrb2RlIEpTLlxyXG4gKlxyXG4gKiBEdWx1IGltcG9ydCBzZXNhbWEgZGlyZWt0b3JpIHRpZGFrIGRpZHVrdW5nIHNhbWEgc2VrYWxpIChzZWxhbHUgamF0dWgga2UgaG9zdFxyXG4gKiBmaWxlc3lzdGVtIFx1MjE5MiBcIkNhbm5vdCBmaW5kIG1vZHVsZSAnLi9UcGtnUHJvdG9jb2wnXCIpLlxyXG4gKi9cclxubGV0IHByb2dyYW1Nb2R1bGVzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XHJcblxyXG5pZiAoTW9kdWxlICYmIHBhdGgpIHtcclxuICAgIGNvbnN0IG9yaWdpbmFsTG9hZCA9IE1vZHVsZS5fbG9hZDtcclxuICAgIGNvbnN0IHZmc0NhY2hlID0gKHdvcmtlckRhdGEgYXMgYW55KS52ZnNDYWNoZSB8fCB7fTtcclxuICAgIGNvbnN0IG1vZHVsZUNhY2hlOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0ge307XHJcbiAgICAvLyBQZXRhIGR1bW15RmlsZW5hbWUgXHUyMTkyIG1vZHVsZS1pZCAoYEB0c2l4L3hgLCBgQGNvbW1vbi9hL2JgKS4gRGlwYWthaSB1bnR1a1xyXG4gICAgLy8gbWVuZXJqZW1haGthbiBpbXBvcnQgUkVMQVRJRiBtaWxpayBtb2R1bCBmcmFtZXdvcmsgKGxpaGF0XHJcbiAgICAvLyByZXNvbHZlUmVsYXRpdmVNb2R1bGVJZCkuXHJcbiAgICBjb25zdCBtb2R1bGVJZEJ5RmlsZTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xyXG5cclxuICAgIE1vZHVsZS5fbG9hZCA9IGZ1bmN0aW9uIChyZXF1ZXN0OiBzdHJpbmcsIHBhcmVudDogYW55LCBpc01haW46IGJvb2xlYW4pIHtcclxuICAgICAgICBsZXQgbm9ybWFsaXplZFJlcXVlc3QgPSByZXF1ZXN0O1xyXG5cclxuICAgICAgICAvLyBSZXNvbHZlIHJlbGF0aXZlIHBhdGhzXHJcbiAgICAgICAgaWYgKHJlcXVlc3Quc3RhcnRzV2l0aChcIi5cIikpIHtcclxuICAgICAgICAgICAgaWYgKHJlcXVlc3QuaW5jbHVkZXMoXCIvY29tbW9uL1wiKSkge1xyXG4gICAgICAgICAgICAgICAgbm9ybWFsaXplZFJlcXVlc3QgPSBcIkBjb21tb24vXCIgKyByZXF1ZXN0LnNwbGl0KFwiL2NvbW1vbi9cIilbMV07XHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAocmVxdWVzdC5pbmNsdWRlcyhcIi9saWIvXCIpKSB7XHJcbiAgICAgICAgICAgICAgICBub3JtYWxpemVkUmVxdWVzdCA9IFwiQHRzaXgvXCIgKyByZXF1ZXN0LnNwbGl0KFwiL2xpYi9cIilbMV07XHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAocGFyZW50ICYmIHBhcmVudC5maWxlbmFtZSkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcGFyZW50SWQgPSBtb2R1bGVJZEJ5RmlsZVtwYXJlbnQuZmlsZW5hbWVdO1xyXG4gICAgICAgICAgICAgICAgaWYgKHBhcmVudElkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgLy8gTW9kdWwgZnJhbWV3b3JrIHlhbmcga2l0YSBtdWF0IHNlbmRpcmk6IHJlc29sdXNpIHJlbGF0aWZcclxuICAgICAgICAgICAgICAgICAgICAvLyBkaWxha3VrYW4gZGkgcnVhbmcgbW9kdWxlLWlkIChiZW5hciB1bnR1ayBzZW11YSBrZWRhbGFtYW4pLlxyXG4gICAgICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRSZXF1ZXN0ID0gcmVzb2x2ZVJlbGF0aXZlTW9kdWxlSWQocGFyZW50SWQsIHJlcXVlc3QpO1xyXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAvLyBQcm9ncmFtIFZGUyAoYnVrYW4gbW9kdWwgZnJhbWV3b3JrKTogZmlsZW55YSBiZXJ1cGEgcGF0aCBWRlNcclxuICAgICAgICAgICAgICAgICAgICAvLyAoYC9zYmluL3Rwa2dkLmpzYCkuIFJlc29sdXNpa2FuIHJlbGF0aWYgdGVyaGFkYXAgZGlyZWt0b3JpbnlhLFxyXG4gICAgICAgICAgICAgICAgICAgIC8vIGxhbHUgY2FyaSBkaSBwZXRhIG1vZHVsIHlhbmcgc3VkYWggZGliYWNhIGRhcmkgVkZTLlxyXG4gICAgICAgICAgICAgICAgICAgIC8vXHJcbiAgICAgICAgICAgICAgICAgICAgLy8gVXJ1dGFuIHBlbnRpbmc6IGNhYmFuZyBgL2xpYi9gICYgYC9jb21tb24vYCBkaSBhdGFzIGRpZGFodWx1a2FuXHJcbiAgICAgICAgICAgICAgICAgICAgLy8gc3VwYXlhIGAuLi9saWIveGAgdGV0YXAgZGlsYXlhbmkgY2FjaGUgZnJhbWV3b3JrLlxyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHZmc1RhcmdldCA9IHBhcmVudC5maWxlbmFtZS5zdGFydHNXaXRoKFwiL1wiKVxyXG4gICAgICAgICAgICAgICAgICAgICAgICA/IHJlc29sdmVWZnNSZWxhdGl2ZShwYXJlbnQuZmlsZW5hbWUsIHJlcXVlc3QpXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIDogbnVsbDtcclxuICAgICAgICAgICAgICAgICAgICBpZiAodmZzVGFyZ2V0ICYmIHByb2dyYW1Nb2R1bGVzW3Zmc1RhcmdldF0pIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgbm9ybWFsaXplZFJlcXVlc3QgPSB2ZnNUYXJnZXQ7XHJcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgYmFzZW5hbWUgPSBwYXRoIS5iYXNlbmFtZShwYXJlbnQuZmlsZW5hbWUpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYmFzZW5hbWUuc3RhcnRzV2l0aChcIkB0c2l4X1wiKSAmJiByZXF1ZXN0LnN0YXJ0c1dpdGgoXCIuL1wiKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbm9ybWFsaXplZFJlcXVlc3QgPSBcIkB0c2l4L1wiICsgcmVxdWVzdC5zdWJzdHJpbmcoMik7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoYmFzZW5hbWUuc3RhcnRzV2l0aChcIkBjb21tb25fXCIpICYmIHJlcXVlc3Quc3RhcnRzV2l0aChcIi4vXCIpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBub3JtYWxpemVkUmVxdWVzdCA9IFwiQGNvbW1vbi9cIiArIHJlcXVlc3Quc3Vic3RyaW5nKDIpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICAvLyBDYWNoZWQgTW9kdWxlXHJcbiAgICAgICAgaWYgKG1vZHVsZUNhY2hlW25vcm1hbGl6ZWRSZXF1ZXN0XSkgcmV0dXJuIG1vZHVsZUNhY2hlW25vcm1hbGl6ZWRSZXF1ZXN0XTtcclxuXHJcbiAgICAgICAgLy8gUmVzb2x1c2kgTWVtb3J5IEZyYW1ld29yayAoVkZTKVxyXG4gICAgICAgIGxldCB2ZnNQYXRoID0gbnVsbDtcclxuICAgICAgICBpZiAobm9ybWFsaXplZFJlcXVlc3Quc3RhcnRzV2l0aChcIkB0c2l4L1wiKSkge1xyXG4gICAgICAgICAgICB2ZnNQYXRoID0gXCIvbGliL1wiICsgbm9ybWFsaXplZFJlcXVlc3Quc3Vic3RyaW5nKDYpICsgXCIudHNcIjtcclxuICAgICAgICB9IGVsc2UgaWYgKG5vcm1hbGl6ZWRSZXF1ZXN0LnN0YXJ0c1dpdGgoXCJAY29tbW9uL1wiKSkge1xyXG4gICAgICAgICAgICB2ZnNQYXRoID0gXCIvbGliL2NvbW1vbi9cIiArIG5vcm1hbGl6ZWRSZXF1ZXN0LnN1YnN0cmluZyg4KSArIFwiLnRzXCI7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICAvLyBNb2R1bCByZWxhdGlmIG1pbGlrIHByb2dyYW0gKHBldGEgZGFyaSBgY29sbGVjdFJlbGF0aXZlTW9kdWxlc2ApLlxyXG4gICAgICAgIC8vIElkLW55YSBzdWRhaCB0YW5wYSBla3N0ZW5zaSwgamFkaSBkaWNhcmkgbGFuZ3N1bmcuXHJcbiAgICAgICAgaWYgKCF2ZnNQYXRoICYmIHByb2dyYW1Nb2R1bGVzW25vcm1hbGl6ZWRSZXF1ZXN0XSkge1xyXG4gICAgICAgICAgICBjb25zdCBjb250ZW50ID0gcHJvZ3JhbU1vZHVsZXNbbm9ybWFsaXplZFJlcXVlc3RdO1xyXG4gICAgICAgICAgICBjb25zdCBkdW1teUZpbGVuYW1lID0gcGF0aCEuam9pbihwcm9jZXNzLmN3ZCgpLCBub3JtYWxpemVkUmVxdWVzdC5yZXBsYWNlKC9cXC8vZywgXCJfXCIpICsgXCIuanNcIik7XHJcblxyXG4gICAgICAgICAgICBjb25zdCBuZXdNb2QgPSBuZXcgTW9kdWxlKGR1bW15RmlsZW5hbWUsIHBhcmVudCk7XHJcbiAgICAgICAgICAgIG5ld01vZC5maWxlbmFtZSA9IGR1bW15RmlsZW5hbWU7XHJcbiAgICAgICAgICAgIG5ld01vZC5wYXRocyA9IE1vZHVsZS5fbm9kZU1vZHVsZVBhdGhzKHByb2Nlc3MuY3dkKCkpO1xyXG5cclxuICAgICAgICAgICAgLy8gRGFmdGFya2FuIFNFQkVMVU0gX2NvbXBpbGU6IG1vZHVsIGluaSBiaXNhIG1lLXJlcXVpcmUgYW5ha255YSBzYWF0XHJcbiAgICAgICAgICAgIC8vIF9jb21waWxlIGJlcmphbGFuLiBJZC1ueWEgcGF0aCBWRlMgc3VwYXlhIGltcG9ydCByZWxhdGlmIGJlcnNhcmFuZ1xyXG4gICAgICAgICAgICAvLyBpa3V0IGJlbmFyIChyZXNvbHZlUmVsYXRpdmVNb2R1bGVJZCBtZW5hbmdhbmkgYmVudHVrIFwiL2EvYlwiKS5cclxuICAgICAgICAgICAgbW9kdWxlSWRCeUZpbGVbZHVtbXlGaWxlbmFtZV0gPSBub3JtYWxpemVkUmVxdWVzdDtcclxuICAgICAgICAgICAgKG5ld01vZCBhcyBhbnkpLl9jb21waWxlKGNvbnRlbnQsIGR1bW15RmlsZW5hbWUpO1xyXG5cclxuICAgICAgICAgICAgbW9kdWxlQ2FjaGVbbm9ybWFsaXplZFJlcXVlc3RdID0gbmV3TW9kLmV4cG9ydHM7XHJcbiAgICAgICAgICAgIHJldHVybiBuZXdNb2QuZXhwb3J0cztcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGlmICh2ZnNQYXRoICYmIHZmc0NhY2hlW3Zmc1BhdGhdKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGNvbnRlbnQgPSB2ZnNDYWNoZVt2ZnNQYXRoXTtcclxuICAgICAgICAgICAgY29uc3QgZHVtbXlGaWxlbmFtZSA9IHBhdGghLmpvaW4ocHJvY2Vzcy5jd2QoKSwgbm9ybWFsaXplZFJlcXVlc3QucmVwbGFjZShcIi9cIiwgXCJfXCIpICsgXCIuanNcIik7XHJcblxyXG4gICAgICAgICAgICBjb25zdCBuZXdNb2QgPSBuZXcgTW9kdWxlKGR1bW15RmlsZW5hbWUsIHBhcmVudCk7XHJcbiAgICAgICAgICAgIG5ld01vZC5maWxlbmFtZSA9IGR1bW15RmlsZW5hbWU7XHJcbiAgICAgICAgICAgIG5ld01vZC5wYXRocyA9IE1vZHVsZS5fbm9kZU1vZHVsZVBhdGhzKHByb2Nlc3MuY3dkKCkpO1xyXG5cclxuICAgICAgICAgICAgLy8gUEVOVElORzogZGFmdGFya2FuIFNFQkVMVU0gX2NvbXBpbGUgXHUyMDE0IGlzaSBtb2R1bCBtZS1yZXF1aXJlIGFuYWtueWFcclxuICAgICAgICAgICAgLy8gc2FhdCBfY29tcGlsZSBiZXJqYWxhbiwgamFkaSBwZXRhIGluaSBoYXJ1cyBzdWRhaCB0ZXJpc2kuXHJcbiAgICAgICAgICAgIG1vZHVsZUlkQnlGaWxlW2R1bW15RmlsZW5hbWVdID0gbm9ybWFsaXplZFJlcXVlc3Q7XHJcblxyXG4gICAgICAgICAgICAvLyBGcmFtZXdvcmsgbW9kdWxlcyBhcmUgbm93IHByZS1jb21waWxlZCBpbiBLZXJuZWwuXHJcbiAgICAgICAgICAgIC8vIERpcmVjdCBleGVjdXRpb24gZm9yIG1heGltdW0gcGVyZm9ybWFuY2UuXHJcbiAgICAgICAgICAgIChuZXdNb2QgYXMgYW55KS5fY29tcGlsZShjb250ZW50LCBkdW1teUZpbGVuYW1lKTtcclxuXHJcbiAgICAgICAgICAgIG1vZHVsZUNhY2hlW25vcm1hbGl6ZWRSZXF1ZXN0XSA9IG5ld01vZC5leHBvcnRzO1xyXG4gICAgICAgICAgICByZXR1cm4gbmV3TW9kLmV4cG9ydHM7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICByZXR1cm4gb3JpZ2luYWxMb2FkLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XHJcbiAgICB9O1xyXG5cclxuICAgIChnbG9iYWwgYXMgYW55KS5oaWphY2tSZXF1aXJlID0gKGlkOiBzdHJpbmcpID0+IHtcclxuICAgICAgICBpZiAoaG9zdFJlcXVpcmUpIHJldHVybiBob3N0UmVxdWlyZShpZCk7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBSZXF1aXJlIGZhaWxlZCBmb3IgJHtpZH0gKE5vIGhvc3QgcmVxdWlyZSlgKTtcclxuICAgIH07XHJcbn1cclxuXHJcbmNvbnN0IGhpamFja1JlcXVpcmUgPSAoaWQ6IHN0cmluZykgPT5cclxuICAgIChnbG9iYWwgYXMgYW55KS5oaWphY2tSZXF1aXJlID8gKGdsb2JhbCBhcyBhbnkpLmhpamFja1JlcXVpcmUoaWQpIDogaG9zdFJlcXVpcmUgPyBob3N0UmVxdWlyZShpZCkgOiBudWxsO1xyXG5cclxuaWYgKHR5cGVvZiByZXF1aXJlICE9PSBcInVuZGVmaW5lZFwiKSB7XHJcbiAgICAoZ2xvYmFsIGFzIGFueSkucmVxdWlyZSA9IGhpamFja1JlcXVpcmU7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBNRU1PUlkgU1RBVCBSRVNQT05ERVIgXHUyMDE0IGphbHVyIGZhbGxiYWNrIGBwcyAtLW1lbWAgLyBgbWVtIC0tcGVyLXByb2NgXHJcbiAqXHJcbiAqIEtlcm5lbCBsZWJpaCBzdWthIG1lbWJhY2EgaXNvbGF0ZSB3b3JrZXIgc2VuZGlyaSBsZXdhdFxyXG4gKiBgd29ya2VyLmdldEhlYXBTdGF0aXN0aWNzKClgLCBUQVBJIG1ldGhvZCBpdHUgYmFydSBhZGEgZGkgTm9kZSA+PSAyMi4xNi5cclxuICogRGkgTm9kZSBsYW1hIGtlcm5lbCBtZW5naXJpbSBwZXNhbiBgeyBfX3RzaXhNZW1TdGF0UmVxdWVzdCB9YCBkYW4gbWVudW5nZ3VcclxuICogYmFsYXNhbjsgcmVzcG9uZGVyIGluaSB5YW5nIG1lbmphd2FibnlhLlxyXG4gKlxyXG4gKiBLZW5hcGEgZGkgc2luaSAoV29ya2VyRW50cnkpIGRhbiBidWthbiBkaSBVc2VyTGliOiBib290bG9hZGVyIGluaSBTRUxBTFVcclxuICogamFsYW4sIGJhaGthbiB1bnR1ayBhcHAgeWFuZyBnYWdhbCBkaW11YXQgXHUyMDE0IHNlZGFuZ2thbiBVc2VyTGliIGJhcnUgaGlkdXBcclxuICogc2V0ZWxhaCBhcHAgbWVuZy1pbXBvcnQgZnJhbWV3b3JrLiBUYW5wYSBpdHUsIHByb3NlcyBiZXJtYXNhbGFoIGp1c3RydVxyXG4gKiBrZWhpbGFuZ2FuIGFuZ2thIG1lbW9yaW55YS5cclxuICpcclxuICogYHJzc2Agc2VuZ2FqYSBUSURBSyBkaWxhcG9ya2FuOiBkaSBkYWxhbSB3b3JrZXIgbmlsYWlueWEgcHJvY2Vzcy13aWRlXHJcbiAqIChtYWluIHRocmVhZCArIHNlbXVhIHdvcmtlciksIG1lbnllc2F0a2FuIHVudHVrIGF0cmlidXNpIHBlci1wcm9zZXMuXHJcbiAqL1xyXG5pZiAocGFyZW50UG9ydCkge1xyXG4gICAgcGFyZW50UG9ydC5vbihcIm1lc3NhZ2VcIiwgKG1zZzogYW55KSA9PiB7XHJcbiAgICAgICAgY29uc3QgcmVxdWVzdElkID0gbXNnICYmIG1zZy5fX3RzaXhNZW1TdGF0UmVxdWVzdDtcclxuICAgICAgICBpZiAodHlwZW9mIHJlcXVlc3RJZCAhPT0gXCJzdHJpbmdcIikgcmV0dXJuO1xyXG5cclxuICAgICAgICAvLyBKYW5nYW4gYmlhcmthbiBrZWdhZ2FsYW4gcGVtYmFjYWFuIG1lbWF0aWthbiBwcm9zZXMgXHUyMDE0IGJhbGFzIGFwYSBhZGFueWEuXHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgbSA9IHByb2Nlc3MubWVtb3J5VXNhZ2UoKTtcclxuICAgICAgICAgICAgbGV0IGhlYXBMaW1pdCA9IDA7XHJcbiAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBoZWFwTGltaXQgPSBob3N0UmVxdWlyZSA/IGhvc3RSZXF1aXJlKFwidjhcIikuZ2V0SGVhcFN0YXRpc3RpY3MoKS5oZWFwX3NpemVfbGltaXQgOiAwO1xyXG4gICAgICAgICAgICB9IGNhdGNoIChfKSB7XHJcbiAgICAgICAgICAgICAgICAvKiB2OCBvcHNpb25hbCBcdTIwMTQgMCBiZXJhcnRpIHRpZGFrIGRpa2V0YWh1aSAqL1xyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICBwYXJlbnRQb3J0IS5wb3N0TWVzc2FnZSh7XHJcbiAgICAgICAgICAgICAgICBfX3RzaXhNZW1TdGF0OiByZXF1ZXN0SWQsXHJcbiAgICAgICAgICAgICAgICBzdGF0czoge1xyXG4gICAgICAgICAgICAgICAgICAgIGhlYXBVc2VkOiBtLmhlYXBVc2VkLFxyXG4gICAgICAgICAgICAgICAgICAgIGhlYXBUb3RhbDogbS5oZWFwVG90YWwsXHJcbiAgICAgICAgICAgICAgICAgICAgZXh0ZXJuYWw6IG0uZXh0ZXJuYWwsXHJcbiAgICAgICAgICAgICAgICAgICAgYXJyYXlCdWZmZXJzOiBtLmFycmF5QnVmZmVycyxcclxuICAgICAgICAgICAgICAgICAgICBoZWFwTGltaXQsXHJcbiAgICAgICAgICAgICAgICB9LFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9IGNhdGNoIChfKSB7XHJcbiAgICAgICAgICAgIC8vIEJhbGFzIG51bGwgc3VwYXlhIGtlcm5lbCB0aWRhayBtZW51bmdndSBzYW1wYWkgdGltZW91dC5cclxuICAgICAgICAgICAgcGFyZW50UG9ydCEucG9zdE1lc3NhZ2UoeyBfX3RzaXhNZW1TdGF0OiByZXF1ZXN0SWQsIHN0YXRzOiBudWxsIH0pO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG59XHJcblxyXG5wcm9jZXNzLm9uKFwidW5oYW5kbGVkUmVqZWN0aW9uXCIsIChyZWFzb24pID0+IHtcclxuICAgIGNvbnN0IG1zZyA9IHJlYXNvbiBpbnN0YW5jZW9mIEVycm9yID8gcmVhc29uLm1lc3NhZ2UgOiBTdHJpbmcocmVhc29uKTtcclxuICAgIGNvbnNvbGUuZXJyb3IoXCJbV29ya2VyIEZhdGFsXSBVbmhhbmRsZWQgUmVqZWN0aW9uOlwiLCBtc2cpO1xyXG4gICAgdHJ5U2VuZEVycm9yVG9QYXJlbnQobXNnKTtcclxuICAgIHJlYWxFeGl0KDEpO1xyXG59KTtcclxuXHJcbnByb2Nlc3Mub24oXCJ1bmNhdWdodEV4Y2VwdGlvblwiLCAoZXJyKSA9PiB7XHJcbiAgICBjb25zdCBtc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XHJcbiAgICBjb25zb2xlLmVycm9yKFwiW1dvcmtlciBGYXRhbF0gVW5jYXVnaHQgRXhjZXB0aW9uOlwiLCBtc2cpO1xyXG4gICAgdHJ5U2VuZEVycm9yVG9QYXJlbnQobXNnKTtcclxuICAgIHJlYWxFeGl0KDEpO1xyXG59KTtcclxuXHJcbi8vIEhlbHBlcjogY29iYSBraXJpbSBHVUlfV0lORE9XX0VSUk9SIGtlIHBhcmVudCAoQXN0ZXJhY2VhKSBzZWJlbHVtIGV4aXRcclxuZnVuY3Rpb24gdHJ5U2VuZEVycm9yVG9QYXJlbnQobWVzc2FnZTogc3RyaW5nKSB7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IGxpYiA9IChnbG9iYWwgYXMgYW55KS5fdHNpeExpYiBhcyBhbnk7XHJcbiAgICAgICAgaWYgKGxpYiAmJiB0eXBlb2YgbGliLmdldFBhcmVudFBpZCA9PT0gXCJmdW5jdGlvblwiICYmIHR5cGVvZiBsaWIuc2hlbGw/LnNlbmQgPT09IFwiZnVuY3Rpb25cIikge1xyXG4gICAgICAgICAgICBsaWIuZ2V0UGFyZW50UGlkKClcclxuICAgICAgICAgICAgICAgIC50aGVuKChwYXJlbnRQaWQ6IG51bWJlcikgPT4ge1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChwYXJlbnRQaWQpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgbGliLnNoZWxsLnNlbmQocGFyZW50UGlkLCB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIkdVSV9XSU5ET1dfRVJST1JcIixcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHdpZDogXCJcIixcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBpZDogbGliLmdldFBpZCgpLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmlsZTogXCJcIixcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVycm9yOiBgUnVudGltZSBFcnJvcjogJHttZXNzYWdlfWAsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb250ZXh0OiBcInJ1bnRpbWVcIixcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLnJlcGxhY2UoXCJUXCIsIFwiIFwiKS5zdWJzdHJpbmcoMCwgMTkpLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9KVxyXG4gICAgICAgICAgICAgICAgLmNhdGNoKCgpID0+IHt9KTtcclxuICAgICAgICB9XHJcbiAgICB9IGNhdGNoIChfKSB7XHJcbiAgICAgICAgLyogaWdub3JlICovXHJcbiAgICB9XHJcbn1cclxuXHJcbi8vIC0tLSBCQVNJQyBTQU5EQk9YSU5HIChFZHVjYXRpb25hbCBMZXZlbCkgLS0tXHJcbi8vIEtpdGEgXCJzZW1idW55aWthblwiIGJlYmVyYXBhIEFQSSBOb2RlLmpzIHlhbmcgYmVyYmFoYXlhIGFnYXIgdXNlci1sYW5kXHJcbi8vIGRpcGFrc2EgbWVuZ2d1bmFrYW4gU3lzY2FsbCBsZXdhdCBVc2VyTGliLlxyXG5jb25zdCByZXN0cmljdEhvc3RBUEkgPSAoYXBwTmFtZTogc3RyaW5nKSA9PiB7XHJcbiAgICBjb25zdCBmb3JiaWRkZW4gPSAobXNnOiBzdHJpbmcgPSBcIlNlY3VyaXR5IFZpb2xhdGlvbjogRGlyZWN0IEhvc3QgQVBJIGFjY2VzcyBpcyBmb3JiaWRkZW4gaW4gVFNJWCBTYW5kYm94LlwiKSA9PiB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKG1zZyk7XHJcbiAgICB9O1xyXG5cclxuICAgIGNvbnN0IGlzUHJpdmlsZWdlZCA9XHJcbiAgICAgICAgYXBwTmFtZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwic2VydmVyXCIpIHx8XHJcbiAgICAgICAgYXBwTmFtZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwiZGFlbW9uXCIpIHx8XHJcbiAgICAgICAgYXBwTmFtZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwiZG9tZVwiKSB8fFxyXG4gICAgICAgIGFwcE5hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcInRidWlsZFwiKSB8fFxyXG4gICAgICAgIGFwcE5hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcInZmc1wiKSB8fFxyXG4gICAgICAgIGFwcE5hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcIm15c3FsZFwiKTtcclxuICAgIGNvbnN0IGFsbG93ZWRNb2R1bGVzID0gW1wicGF0aFwiLCBcImZzXCIsIFwidXJsXCIsIFwiZXNidWlsZFwiLCBcImNyeXB0b1wiLCBcIm9zXCIsIFwiYmNyeXB0anNcIiwgXCJteXNxbDJcIiwgXCJteXNxbDIvcHJvbWlzZVwiXTtcclxuXHJcbiAgICBjb25zdCBwcml2aWxlZ2VkUmVxdWlyZSA9IChtb2Q6IHN0cmluZykgPT4ge1xyXG4gICAgICAgIC8vIEZyYW1ld29yayBhbGlhc2VzIGFyZSBBTFdBWVMgYWxsb3dlZCwgZXZlbiBpbiBzYW5kYm94XHJcbiAgICAgICAgaWYgKFxyXG4gICAgICAgICAgICBtb2Quc3RhcnRzV2l0aChcIkB0c2l4L1wiKSB8fFxyXG4gICAgICAgICAgICBtb2Quc3RhcnRzV2l0aChcIkBjb21tb24vXCIpIHx8XHJcbiAgICAgICAgICAgIG1vZC5pbmNsdWRlcyhcIi9saWIvXCIpIHx8XHJcbiAgICAgICAgICAgIG1vZC5pbmNsdWRlcyhcIi9jb21tb24vXCIpXHJcbiAgICAgICAgKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBoaWphY2tSZXF1aXJlKG1vZCk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBpZiAoYWxsb3dlZE1vZHVsZXMuaW5jbHVkZXMobW9kKSkge1xyXG4gICAgICAgICAgICByZXR1cm4gaG9zdFJlcXVpcmUhKG1vZCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZvcmJpZGRlbihgU2VjdXJpdHkgVmlvbGF0aW9uOiBNb2R1bGUgJyR7bW9kfScgaXMgbm90IGluIHRoZSBwcml2aWxlZ2VkIGFsbG93LWxpc3QuYCk7XHJcbiAgICB9O1xyXG5cclxuICAgIC8vIFNlbWJ1bnlpa2FuIHJlcXVpcmUgamlrYSBhZGEgKHRlcmdhbnR1bmcgbW9kdWxlIGxvYWRlcilcclxuICAgIGlmICh0eXBlb2YgcmVxdWlyZSAhPT0gXCJ1bmRlZmluZWRcIikge1xyXG4gICAgICAgIChnbG9iYWwgYXMgYW55KS5yZXF1aXJlID0gaXNQcml2aWxlZ2VkXHJcbiAgICAgICAgICAgID8gcHJpdmlsZWdlZFJlcXVpcmVcclxuICAgICAgICAgICAgOiAobW9kOiBzdHJpbmcpID0+IHtcclxuICAgICAgICAgICAgICAgICAgLy8gRXZlbiBpbiBzYW5kYm94LCBmcmFtZXdvcmsgY29yZXMgTVVTVCBiZSBhY2Nlc3NpYmxlXHJcbiAgICAgICAgICAgICAgICAgIGlmIChcclxuICAgICAgICAgICAgICAgICAgICAgIG1vZC5zdGFydHNXaXRoKFwiQHRzaXgvXCIpIHx8XHJcbiAgICAgICAgICAgICAgICAgICAgICBtb2Quc3RhcnRzV2l0aChcIkBjb21tb24vXCIpIHx8XHJcbiAgICAgICAgICAgICAgICAgICAgICBtb2QuaW5jbHVkZXMoXCIvbGliL1wiKSB8fFxyXG4gICAgICAgICAgICAgICAgICAgICAgbW9kLmluY2x1ZGVzKFwiL2NvbW1vbi9cIilcclxuICAgICAgICAgICAgICAgICAgKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gaGlqYWNrUmVxdWlyZShtb2QpO1xyXG4gICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgIGZvcmJpZGRlbigpO1xyXG4gICAgICAgICAgICAgIH07XHJcbiAgICB9XHJcblxyXG4gICAgLy8gQmF0YXNpIGFrc2VzIHByb2Nlc3MgeWFuZyBzZW5zaXRpZlxyXG4gICAgY29uc3QgcCA9IChnbG9iYWwgYXMgYW55KS5wcm9jZXNzO1xyXG4gICAgaWYgKHApIHtcclxuICAgICAgICBwLmV4aXQgPSBmb3JiaWRkZW47XHJcbiAgICAgICAgcC5raWxsID0gZm9yYmlkZGVuO1xyXG4gICAgICAgIC8vIHAuZW52ID0ge307IC8vIFRlbXBvcmFyaWx5IGtlZXAgZW52IGZvciBkZWJ1Z2dpbmcgaWYgbmVlZGVkLCBvciBjbGVhciBpdFxyXG4gICAgfVxyXG59O1xyXG5cclxuLy8gcmVzdHJpY3RIb3N0QVBJKCk7IC8vIERpcGluZGFoa2FuIGtlIGRhbGFtIG1haW4oKVxyXG5cclxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxyXG5cclxuLyoqXHJcbiAqIGVtaXRXb3JrZXJFcnJvcigpOiBDZXRhayBwZXNhbiBlcnJvciBsb2FkLXBhdGggYXBsaWthc2kga2UgVFRZIChTVERPVVQpLFxyXG4gKiBzZWhpbmdnYSB0ZXJsaWhhdCBqdWdhIGRpIHBpeGVsdGVybSAvIGtvbnNvbCBUVFkgKGJ1a2FuIGN1bWEgaG9zdCBzdGRlcnIpLlxyXG4gKiBGaXJlLWFuZC1mb3JnZXQgKHRpZGFrIGRpLWF3YWl0KSBzdXBheWEgdGlkYWsgbWVuZ3ViYWggYWx1ciBtYWluKCk7IGZhbGxiYWNrXHJcbiAqIGtlIGNvbnNvbGUuZXJyb3IgKGhvc3Qgc3RkZXJyKSBiaWxhIHByaW50IGtlIFRUWSBnYWdhbC5cclxuICovXHJcbmZ1bmN0aW9uIGVtaXRXb3JrZXJFcnJvcihsaWI6IGFueSwgcGlkOiBudW1iZXIsIG1lc3NhZ2U6IHN0cmluZykge1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBpZiAobGliICYmIGxpYi5zdGQgJiYgdHlwZW9mIGxpYi5zdGQucHJpbnQgPT09IFwiZnVuY3Rpb25cIikge1xyXG4gICAgICAgICAgICB2b2lkIGxpYi5zdGQucHJpbnQoYFxceDFiWzMxbVtXb3JrZXIgJHtwaWR9XVxceDFiWzBtICR7bWVzc2FnZX1cXG5gKS5jYXRjaCgoKSA9PiB7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmVycm9yKGBbV29ya2VyICR7cGlkfV0gJHttZXNzYWdlfWApO1xyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgIH0gY2F0Y2ggKF8pIHtcclxuICAgICAgICAvLyBmYWxsYmFjayBrZSBjb25zb2xlLmVycm9yIGRpIGJhd2FoXHJcbiAgICB9XHJcbiAgICBjb25zb2xlLmVycm9yKGBbV29ya2VyICR7cGlkfV0gJHttZXNzYWdlfWApO1xyXG59XHJcblxyXG4vKipcclxuICogbm90aWZ5TG9hZEVycm9yKCk6IEtpcmltIEdVSV9XSU5ET1dfRVJST1Iga2UgcGFyZW50ICYgV2luZG93IE1hbmFnZXIgKEFzdGVyYWNlYSlcclxuICogc3VwYXlhIGVycm9yIGdhZ2FsLWxvYWQgYXBsaWthc2kganVnYSB0YW1waWwgc2ViYWdhaSBwb3B1cCBkaSBkZXNrdG9wIFx1MjAxNCB0ZXJtYXN1a1xyXG4gKiBzYWF0IGFwcCBkaWphbGFua2FuIGRhcmkgZmlsZS1jcnVpc2VyL3Rlcm1pbmFsIChmb3JlaWduIGFwcCkuIFBvbGFueWEgc2FtYSBkZW5nYW5cclxuICogbm90aWZ5UGFyZW50V2luZG93RXZlbnQoKSBkaSBFbWVyYWxkOiBraXJpbSBrZSBwYXJlbnQgZHVsdSwgbGFsdSBrZSBXTSB2aWFcclxuICogL29wdC9hc3RlcmFjZWEvd20tcGlkLiBGaXJlLWFuZC1mb3JnZXQ7IGtlZ2FnYWxhbiBwZW5naXJpbWFuIHRpZGFrIGZhdGFsLlxyXG4gKi9cclxuYXN5bmMgZnVuY3Rpb24gbm90aWZ5TG9hZEVycm9yKGxpYjogYW55LCBwaWQ6IG51bWJlciwgYXBwTmFtZTogc3RyaW5nLCBtZXNzYWdlOiBzdHJpbmcpIHtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgdGltZXN0YW1wID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpLnJlcGxhY2UoXCJUXCIsIFwiIFwiKS5zdWJzdHJpbmcoMCwgMTkpO1xyXG4gICAgICAgIGNvbnN0IHBheWxvYWQgPSB7XHJcbiAgICAgICAgICAgIHR5cGU6IFwiR1VJX1dJTkRPV19FUlJPUlwiLFxyXG4gICAgICAgICAgICB3aWQ6IFwiXCIsXHJcbiAgICAgICAgICAgIHBpZCxcclxuICAgICAgICAgICAgZmlsZTogYXBwTmFtZSxcclxuICAgICAgICAgICAgZXJyb3I6IG1lc3NhZ2UsXHJcbiAgICAgICAgICAgIGNvbnRleHQ6IFwibG9hZFwiLFxyXG4gICAgICAgICAgICB0aW1lc3RhbXAsXHJcbiAgICAgICAgfTtcclxuXHJcbiAgICAgICAgLy8gMS4gS2lyaW0ga2UgcGFyZW50IHByb2Nlc3MgKGJpc2EgV00gYmlsYSBhcHAgZGktbGF1bmNoIGRhcmkgbGF1bmNoZXIpXHJcbiAgICAgICAgY29uc3QgcGFyZW50UGlkID0gYXdhaXQgbGliLmdldFBhcmVudFBpZCgpO1xyXG4gICAgICAgIGlmIChwYXJlbnRQaWQpIHtcclxuICAgICAgICAgICAgYXdhaXQgbGliLnNoZWxsLnNlbmQocGFyZW50UGlkLCBwYXlsb2FkKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8vIDIuIEtpcmltIGp1Z2Ega2UgQXN0ZXJhY2VhIFdNIFx1MjAxNCB1bnR1ayBhcHAgeWFuZyBkaS1ydW4gdmlhXHJcbiAgICAgICAgLy8gICAgZmlsZS1jcnVpc2VyL3Rlcm1pbmFsIChmb3JlaWduIGFwcCkuIEJhY2EgUElEIFdNIGRhcmkgd20tcGlkIGZpbGUuXHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3Qgd21QaWRSYXcgPSBhd2FpdCBsaWIuZnMucmVhZEZpbGUoXCIvb3B0L2FzdGVyYWNlYS93bS1waWRcIik7XHJcbiAgICAgICAgICAgIGlmICh3bVBpZFJhdykge1xyXG4gICAgICAgICAgICAgICAgY29uc3Qgd21QaWQgPSBwYXJzZUludChTdHJpbmcod21QaWRSYXcpLnRyaW0oKSk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBteVBpZCA9IGxpYi5nZXRQaWQoKTtcclxuICAgICAgICAgICAgICAgIGlmICh3bVBpZCAmJiB3bVBpZCAhPT0gbXlQaWQgJiYgd21QaWQgIT09IHBhcmVudFBpZCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IGxpYi5zaGVsbC5zZW5kKHdtUGlkLCBwYXlsb2FkKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0gY2F0Y2ggKF8pIHtcclxuICAgICAgICAgICAgLy8gQXN0ZXJhY2VhIHRpZGFrIGJlcmphbGFuIFx1MjAxNCBuby1vcFxyXG4gICAgICAgIH1cclxuICAgIH0gY2F0Y2ggKF8pIHtcclxuICAgICAgICAvLyBOb3RpZmlrYXNpIGdhZ2FsIFx1MjAxNCBub24tZmF0YWxcclxuICAgIH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gbWFpbigpIHtcclxuICAgIGNvbnN0IGRhdGEgPSB3b3JrZXJEYXRhIGFzIFdvcmtlckluaXREYXRhO1xyXG4gICAgY29uc3QgeyBwaWQsIGFwcE5hbWUsIGFyZ3MsIGFwcFBhdGggfSA9IGRhdGE7XHJcblxyXG4gICAgLy8gTG9hZCBVc2VyTGliIGRpbmFtaXMgZGFyaSBWRlMgQ2FjaGUgKE1lbW9yeSBFeGVjdXRpb24pXHJcbiAgICBjb25zdCBVc2VyTGliTW9kID0gaGlqYWNrUmVxdWlyZShcIkB0c2l4L1VzZXJMaWJcIik7XHJcbiAgICBjb25zdCBVc2VyTGliQ2xhc3MgPSBVc2VyTGliTW9kLlVzZXJMaWI7XHJcblxyXG4gICAgaWYgKCFVc2VyTGliQ2xhc3MpIHtcclxuICAgICAgICBjb25zb2xlLmVycm9yKGBbV29ya2VyICR7cGlkfV0gQ1JJVElDQUwgRVJST1I6IEZhaWxlZCB0byBsb2FkIFVzZXJMaWIgZnJvbSBWRlMgTWVtb3J5IENhY2hlIWApO1xyXG4gICAgICAgIHJlYWxFeGl0KDEpO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IGxpYiA9IG5ldyBVc2VyTGliQ2xhc3MocGlkKTtcclxuICAgIChnbG9iYWwgYXMgYW55KS5fdHNpeExpYiA9IGxpYjsgLy8gUmVnaXN0ZXIgZm9yIGV4cGxpY2l0IGltcG9ydHMgKHYyLjEpXHJcblxyXG4gICAgLy8gSlMtRGlyZWN0IHBhdGggc2hvdWxkIE5PVCBoYXZlIC1yIGluIGV4ZWNBcmd2XHJcbiAgICBjb25zdCBpc0pzRGlyZWN0ID0gIXByb2Nlc3MuZXhlY0FyZ3Yuc29tZSgoYXJnKSA9PiBhcmcuaW5jbHVkZXMoXCItclwiKSk7XHJcblxyXG4gICAgLy8gMi4gQ2FyaSBhcGxpa2FzaW55YVxyXG4gICAgY29uc3QgdGFyZ2V0S2V5ID0gYXBwTmFtZS50cmltKCk7XHJcbiAgICBsZXQgQXBwQ2xhc3M6IGFueSA9IG51bGw7XHJcbiAgICBsZXQgZmluYWxBcHBQYXRoID0gYXBwUGF0aDtcclxuICAgIC8vIFJlYXNvbiB0aGUgbG9hZCBmYWlsZWQgKHRyYW5zcGlsZS9leGVjdXRpb24pIFx1MjAxNCB1c2VkIGZvciBhIG1vcmUgaG9uZXN0XHJcbiAgICAvLyBmaW5hbCBtZXNzYWdlIGluc3RlYWQgb2YgdGhlIG1pc2xlYWRpbmcgXCJBcHBsaWNhdGlvbiBub3QgZm91bmRcIi5cclxuICAgIGxldCBsb2FkRmFpbHVyZTogc3RyaW5nIHwgbnVsbCA9IG51bGw7XHJcbiAgICAvLyBEZXRhaWwgZXJyb3IgYXNsaW55YSAocGVzYW4gZXNidWlsZC9ydW50aW1lKSBcdTIwMTQgZGlwYWthaSB1bnR1ayBwb3B1cCBkZXNrdG9wXHJcbiAgICAvLyBiaWFyIHNwZXNpZmlrLCBidWthbiBzZWthZGFyIGthdGVnb3JpIFwidHJhbnNwaWxlIGZhaWxlZFwiLlxyXG4gICAgbGV0IGxvYWRFcnJvckRldGFpbDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XHJcblxyXG4gICAgLy8gLS0tIFNUUkFURUdJIEJBUlU6IERpcmVjdCBNZW1vcnkgRXhlY3V0aW9uIChUYW5wYSAudmZzX2NhY2hlKSAtLS1cclxuICAgIGlmICghZmluYWxBcHBQYXRoICYmIChkYXRhIGFzIGFueSkuYXBwQ29udGVudCAmJiBNb2R1bGUpIHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBsZXQgY29udGVudCA9IChkYXRhIGFzIGFueSkuYXBwQ29udGVudDtcclxuICAgICAgICAgICAgY29uc3QgaXNUeXBlU2NyaXB0ID0gIShhcHBQYXRoIHx8IGFwcE5hbWUgfHwgXCJcIikudG9Mb3dlckNhc2UoKS5lbmRzV2l0aChcIi5qc1wiKTtcclxuICAgICAgICAgICAgLy8gTW9kdWxlIGZpbGVuYW1lIEhBUlVTIHBoeXNpY2FsIHBhdGggdW50dWsgcmVxdWlyZSgpIG5lbXUgbm9kZV9tb2R1bGVzXHJcbiAgICAgICAgICAgIGNvbnN0IG1vZHVsZUZpbGVuYW1lID0gcGF0aCEuam9pbihwcm9jZXNzLmN3ZCgpLCBhcHBOYW1lICsgXCIuanNcIik7XHJcbiAgICAgICAgICAgIC8vIFN0YWNrIGZpbGVuYW1lID0gQktGUyBwYXRoIGJpYXIgc3RhY2sgdHJhY2UgYmVuZXIgKC9vcHQvdGVzdC9ndWktdGVzdC5qcylcclxuICAgICAgICAgICAgLy8gc3RhY2tCa2ZzUGF0aCA9IEJLRlMgcGF0aCB1bnR1ayBzdGFjayB0cmFjZSAoL29wdC90ZXN0L2d1aS10ZXN0LmpzKVxyXG4gICAgICAgICAgICBjb25zdCBzdGFja0JrZnNQYXRoID0gKGRhdGEgYXMgYW55KS5zdGFja0JrZnNQYXRoO1xyXG4gICAgICAgICAgICBjb25zdCBzdGFja0ZpbGVuYW1lID0gc3RhY2tCa2ZzUGF0aCA/IHN0YWNrQmtmc1BhdGgucmVwbGFjZSgvXFwudHMkLywgXCIuanNcIikgOiBtb2R1bGVGaWxlbmFtZTtcclxuICAgICAgICAgICAgLy8gc291cmNlZmlsZSB1bnR1ayBlc2J1aWxkIHNvdXJjZW1hcCBcdTIwMTQgY3VrdXAgbmFtYSBmaWxlIGFqYSAodGFucGEgcGF0aClcclxuICAgICAgICAgICAgY29uc3Qgc291cmNlRmlsZU5hbWUgPSAoc3RhY2tCa2ZzUGF0aCB8fCBtb2R1bGVGaWxlbmFtZSkuc3BsaXQoL1tcXFxcL10vKS5wb3AoKSEucmVwbGFjZSgvXFwuanMkLywgXCIudHNcIik7XHJcblxyXG4gICAgICAgICAgICAvLyAtLS0gTU9EVUwgUkVMQVRJRiBQUk9HUkFNICguL3gsIC4uL3kpIC0tLVxyXG4gICAgICAgICAgICAvL1xyXG4gICAgICAgICAgICAvLyBEaWt1bXB1bGthbiBTRUtBUkFORyAobWFpbigpIGFzeW5jKSBrYXJlbmEgYE1vZHVsZS5fbG9hZGAgc2lua3JvblxyXG4gICAgICAgICAgICAvLyBzZWRhbmdrYW4gYmFjYSBWRlMgbGV3YXQgc3lzY2FsbCBhc2lua3JvbjogaG9vayByZXF1aXJlIHRpZGFrIG11bmdraW5cclxuICAgICAgICAgICAgLy8gbWVtYmFjYSBmaWxlIHNlbmRpcmkuIFRhbnBhIGxhbmdrYWggaW5pLCBgcmVxdWlyZShcIi4vVHBrZ1Byb3RvY29sXCIpYFxyXG4gICAgICAgICAgICAvLyBtZW5jYXJpIGZpbGUgaXR1IGRpIEhPU1QgZmlsZXN5c3RlbSBkYW4gZ2FnYWwuXHJcbiAgICAgICAgICAgIGlmIChzdGFja0JrZnNQYXRoKSB7XHJcbiAgICAgICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGVzYnVpbGRNb2QgPSBob3N0UmVxdWlyZSEoXCJlc2J1aWxkXCIpO1xyXG4gICAgICAgICAgICAgICAgICAgIHByb2dyYW1Nb2R1bGVzID0gYXdhaXQgY29sbGVjdFJlbGF0aXZlTW9kdWxlcyh7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudHJ5SWQ6IHN0YWNrQmtmc1BhdGgucmVwbGFjZSgvXFwuKHRzfGpzKSQvaSwgXCJcIiksXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHNvdXJjZTogY29udGVudCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gSXNpIFZGUyA9IEJZVEU7IG1vZHVsIHJlbGF0aWYgZGlrb21waWxhc2kgc2ViYWdhaSBURUtTLlxyXG4gICAgICAgICAgICAgICAgICAgICAgICByZWFkRmlsZTogYXN5bmMgKHZmc1BhdGg6IHN0cmluZykgPT4gdmZzQnl0ZXNUb1V0ZjgoYXdhaXQgbGliLmZzLnJlYWRGaWxlKHZmc1BhdGgpKSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgdHJhbnNwaWxlOiAoc3JjOiBzdHJpbmcsIG1vZHVsZUlkOiBzdHJpbmcpID0+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlc2J1aWxkTW9kLnRyYW5zZm9ybVN5bmMoc3JjLCB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbG9hZGVyOiBcInRzXCIsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZm9ybWF0OiBcImNqc1wiLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhcmdldDogXCJub2RlMThcIixcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzb3VyY2VtYXA6IFwiaW5saW5lXCIsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc291cmNlZmlsZTogbW9kdWxlSWQuc3BsaXQoXCIvXCIpLnBvcCgpICsgXCIudHNcIixcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0pLmNvZGUsXHJcbiAgICAgICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgICAgICB9IGNhdGNoIChlOiBhbnkpIHtcclxuICAgICAgICAgICAgICAgICAgICAvLyBOb24tZmF0YWw6IGltcG9ydCByZWxhdGlmIGFrYW4gZ2FnYWwgZGVuZ2FuIHBlc2FuIE5vZGUgYmlhc2EuXHJcbiAgICAgICAgICAgICAgICAgICAgY29uc29sZS5lcnJvcihgW1dvcmtlciAke3BpZH1dIExvY2FsIG1vZHVsZSBzY2FuIGZhaWxlZDogJHtlLm1lc3NhZ2V9YCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgIC8vIEppa2EgY29udGVudCBhZGFsYWggVHlwZVNjcmlwdCwgdHJhbnNwaWxlIGR1bHUga2UgSmF2YVNjcmlwdFxyXG4gICAgICAgICAgICBpZiAoaXNUeXBlU2NyaXB0KSB7XHJcbiAgICAgICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGVzYnVpbGQgPSBob3N0UmVxdWlyZSEoXCJlc2J1aWxkXCIpO1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGVzYnVpbGQudHJhbnNmb3JtU3luYyhjb250ZW50LCB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGxvYWRlcjogXCJ0c1wiLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBmb3JtYXQ6IFwiY2pzXCIsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRhcmdldDogXCJub2RlMThcIixcclxuICAgICAgICAgICAgICAgICAgICAgICAgc291cmNlbWFwOiBcImlubGluZVwiLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBzb3VyY2VmaWxlOiBzb3VyY2VGaWxlTmFtZSxcclxuICAgICAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgICAgICBjb250ZW50ID0gcmVzdWx0LmNvZGU7XHJcbiAgICAgICAgICAgICAgICB9IGNhdGNoICh0cmFuc3BpbGVFcnI6IGFueSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGxvYWRGYWlsdXJlID0gXCJ0cmFuc3BpbGUgZmFpbGVkXCI7XHJcbiAgICAgICAgICAgICAgICAgICAgbG9hZEVycm9yRGV0YWlsID0gYFRTIFRyYW5zcGlsZSBFcnJvcjogJHt0cmFuc3BpbGVFcnIubWVzc2FnZX1gO1xyXG4gICAgICAgICAgICAgICAgICAgIGVtaXRXb3JrZXJFcnJvcihsaWIsIHBpZCwgYFRTIFRyYW5zcGlsZSBFcnJvcjogJHt0cmFuc3BpbGVFcnIubWVzc2FnZX1gKTtcclxuICAgICAgICAgICAgICAgICAgICB0aHJvdyB0cmFuc3BpbGVFcnI7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgIC8vIENyZWF0ZSBhIG5ldyBtb2R1bGUgaW5zdGFuY2Ugd2l0aCBwaHlzaWNhbCBwYXRoIChmb3Igbm9kZV9tb2R1bGVzIHJlc29sdXRpb24pXHJcbiAgICAgICAgICAgIGNvbnN0IGFwcE1vZHVsZSA9IG5ldyBNb2R1bGUobW9kdWxlRmlsZW5hbWUsIG1vZHVsZS5wYXJlbnQpO1xyXG4gICAgICAgICAgICBhcHBNb2R1bGUuZmlsZW5hbWUgPSBzdGFja0ZpbGVuYW1lOyAvLyBfX2ZpbGVuYW1lIHNob3dzIEJLRlMgcGF0aFxyXG4gICAgICAgICAgICBhcHBNb2R1bGUucGF0aHMgPSBNb2R1bGUuX25vZGVNb2R1bGVQYXRocyhwYXRoIS5kaXJuYW1lKG1vZHVsZUZpbGVuYW1lKSk7XHJcblxyXG4gICAgICAgICAgICAvLyBfY29tcGlsZSBkZW5nYW4gc3RhY2tGaWxlbmFtZSBhZ2FyIHN0YWNrIHRyYWNlIG51bmp1ayBCS0ZTIHBhdGhcclxuICAgICAgICAgICAgKGFwcE1vZHVsZSBhcyBhbnkpLl9jb21waWxlKGNvbnRlbnQsIHN0YWNrRmlsZW5hbWUpO1xyXG5cclxuICAgICAgICAgICAgQXBwQ2xhc3MgPVxyXG4gICAgICAgICAgICAgICAgYXBwTW9kdWxlLmV4cG9ydHMubWFpbiB8fCBhcHBNb2R1bGUuZXhwb3J0cy5NYWluIHx8IGFwcE1vZHVsZS5leHBvcnRzLmRlZmF1bHQgfHwgYXBwTW9kdWxlLmV4cG9ydHM7XHJcblxyXG4gICAgICAgICAgICAvLyBKaWthIG1hc2loIGJlbHVtIGtldGVtdSAoZS5nLiBleHBvcnQgY2xhc3MgYnVrYW4gZGVmYXVsdC9tYWluKVxyXG4gICAgICAgICAgICBpZiAodHlwZW9mIEFwcENsYXNzICE9PSBcImZ1bmN0aW9uXCIpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGVudHJpZXMgPSBPYmplY3QuZW50cmllcyhhcHBNb2R1bGUuZXhwb3J0cyk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBmb3VuZCA9IGVudHJpZXMuZmluZCgoW18sIHZhbF06IFtzdHJpbmcsIGFueV0pID0+IHR5cGVvZiB2YWwgPT09IFwiZnVuY3Rpb25cIik7XHJcbiAgICAgICAgICAgICAgICBpZiAoZm91bmQpIEFwcENsYXNzID0gZm91bmRbMV07XHJcbiAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgIGlmIChBcHBDbGFzcykge1xyXG4gICAgICAgICAgICAgICAgLy8gY29uc29sZS5sb2coYFtXb3JrZXIgJHtwaWR9XSBEaXJlY3QgTWVtb3J5IEV4ZWN1dGlvbiBzdWNjZXNzIGZvciAke2FwcE5hbWV9YCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGNhdGNoIChlcnI6IGFueSkge1xyXG4gICAgICAgICAgICBpZiAoIWxvYWRGYWlsdXJlKSBsb2FkRmFpbHVyZSA9IFwiZGlyZWN0IGV4ZWN1dGlvbiBmYWlsZWRcIjtcclxuICAgICAgICAgICAgaWYgKCFsb2FkRXJyb3JEZXRhaWwpIGxvYWRFcnJvckRldGFpbCA9IGBEaXJlY3QgRXhlY3V0aW9uIEVycm9yOiAke2Vyci5tZXNzYWdlfWA7XHJcbiAgICAgICAgICAgIGVtaXRXb3JrZXJFcnJvcihsaWIsIHBpZCwgYERpcmVjdCBFeGVjdXRpb24gRXJyb3I6ICR7ZXJyLm1lc3NhZ2V9YCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIGlmIChmaW5hbEFwcFBhdGggJiYgaG9zdFJlcXVpcmUpIHtcclxuICAgICAgICAvLyBTVFJBVEVHSSBCQVJVOiBEeW5hbWljIExvYWRpbmcgZGFyaSBGaWxlIEZpc2lrIChMaW51eC1saWtlKVxyXG4gICAgICAgIC8vIFNUUkFURUdJOiBEeW5hbWljIExvYWRpbmcgZGFyaSBGaWxlIEZpc2lrIChKdWp1ciBQYWtlIC50cylcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBtb2R1bGUgPSBob3N0UmVxdWlyZShmaW5hbEFwcFBhdGgpO1xyXG4gICAgICAgICAgICBjb25zdCBlbnRyaWVzID0gT2JqZWN0LmVudHJpZXMobW9kdWxlKTtcclxuXHJcbiAgICAgICAgICAgIC8vIFtERUJVR10gQ2hlY2sgd2hhdCB3ZSBmb3VuZFxyXG4gICAgICAgICAgICAvLyBjb25zb2xlLmxvZyhgW1dvcmtlciAke3BpZH1dIExvYWRlZCBtb2R1bGUgZm9yICR7YXBwTmFtZX0uIEtleXM6ICR7T2JqZWN0LmtleXMobW9kdWxlKS5qb2luKFwiLCBcIil9YCk7XHJcblxyXG4gICAgICAgICAgICAvLyBTVFJBVEVHSSBTVEFOREFSOiBDYXJpIGV4cG9ydCBiZXJuYW1hICdtYWluJ1xyXG4gICAgICAgICAgICBpZiAobW9kdWxlLm1haW4pIHtcclxuICAgICAgICAgICAgICAgIEFwcENsYXNzID0gbW9kdWxlLm1haW47XHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAobW9kdWxlLk1haW4pIHtcclxuICAgICAgICAgICAgICAgIEFwcENsYXNzID0gbW9kdWxlLk1haW47XHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAobW9kdWxlLmRlZmF1bHQpIHtcclxuICAgICAgICAgICAgICAgIEFwcENsYXNzID0gbW9kdWxlLmRlZmF1bHQ7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAvLyBGYWxsYmFjazogQW1iaWwgZXhwb3J0IHBlcnRhbWEgeWFuZyBiZXJ1cGEgY2xhc3MvZnVuY3Rpb25cclxuICAgICAgICAgICAgICAgIGNvbnN0IGZvdW5kID0gZW50cmllcy5maW5kKChbXywgdmFsXTogW3N0cmluZywgYW55XSkgPT4gdHlwZW9mIHZhbCA9PT0gXCJmdW5jdGlvblwiKTtcclxuICAgICAgICAgICAgICAgIGlmIChmb3VuZCkgQXBwQ2xhc3MgPSBmb3VuZFsxXTtcclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgaWYgKEFwcENsYXNzKSB7XHJcbiAgICAgICAgICAgICAgICAvLyBjb25zb2xlLmxvZyhgW1dvcmtlciAke3BpZH1dIElkZW50aWZpZWQgQXBwQ2xhc3MgZm9yICR7YXBwTmFtZX1gKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIGxvYWRGYWlsdXJlID0gXCJubyB2YWxpZCAnbWFpbicgZXhwb3J0IGZvdW5kXCI7XHJcbiAgICAgICAgICAgICAgICBsb2FkRXJyb3JEZXRhaWwgPSBgRmFpbGVkIHRvIGlkZW50aWZ5IEFwcENsYXNzIGZvciAke2FwcE5hbWV9LiBNb2R1bGUgZXhwb3J0czogJHtPYmplY3Qua2V5cyhtb2R1bGUpLmpvaW4oXCIsIFwiKX1gO1xyXG4gICAgICAgICAgICAgICAgZW1pdFdvcmtlckVycm9yKFxyXG4gICAgICAgICAgICAgICAgICAgIGxpYixcclxuICAgICAgICAgICAgICAgICAgICBwaWQsXHJcbiAgICAgICAgICAgICAgICAgICAgYEZhaWxlZCB0byBpZGVudGlmeSBBcHBDbGFzcyBmb3IgJHthcHBOYW1lfS4gTW9kdWxlIGV4cG9ydHM6ICR7T2JqZWN0LmtleXMobW9kdWxlKS5qb2luKFwiLCBcIil9YCxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGNhdGNoIChlcnI6IGFueSkge1xyXG4gICAgICAgICAgICBsb2FkRmFpbHVyZSA9IFwiZmFpbGVkIHRvIGxvYWQgbW9kdWxlXCI7XHJcbiAgICAgICAgICAgIGxvYWRFcnJvckRldGFpbCA9IGBSdW50aW1lIEVycm9yOiBGYWlsZWQgdG8gcmVxdWlyZSAke2ZpbmFsQXBwUGF0aCB8fCBhcHBOYW1lfTogJHtlcnIubWVzc2FnZX1gO1xyXG4gICAgICAgICAgICBlbWl0V29ya2VyRXJyb3IobGliLCBwaWQsIGBSdW50aW1lIEVycm9yOiBGYWlsZWQgdG8gcmVxdWlyZSAke2ZpbmFsQXBwUGF0aCB8fCBhcHBOYW1lfTogJHtlcnIubWVzc2FnZX1gKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgaWYgKCFBcHBDbGFzcykge1xyXG4gICAgICAgIGlmIChwYXJlbnRQb3J0KSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGVycm9yTXNnID0gbG9hZEZhaWx1cmVcclxuICAgICAgICAgICAgICAgID8gYC1iYXNoOiAke2FwcE5hbWV9OiBGYWlsZWQgdG8gbG9hZCBcdTIwMTQgJHtsb2FkRmFpbHVyZX1cXG5gXHJcbiAgICAgICAgICAgICAgICA6IGAtYmFzaDogJHthcHBOYW1lfTogQXBwbGljYXRpb24gbm90IGZvdW5kIChQYXRoOiAke2FwcFBhdGggfHwgXCJWRlMtT25seVwifSlcXG5gO1xyXG4gICAgICAgICAgICBhd2FpdCBsaWIuc3RkLnByaW50KGVycm9yTXNnKTtcclxuICAgICAgICAgICAgcGFyZW50UG9ydC5wb3N0TWVzc2FnZSh7XHJcbiAgICAgICAgICAgICAgICBzdWNjZXNzOiBmYWxzZSxcclxuICAgICAgICAgICAgICAgIGVycm9yOiBlcnJvck1zZy50cmltKCksXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAvLyBUYW1waWxrYW4ganVnYSBkaSBkZXNrdG9wIChXTS9Bc3RlcmFjZWEpIHZpYSBHVUlfV0lORE9XX0VSUk9SLlxyXG4gICAgICAgICAgICAvLyBXQUpJQiBkaS1hd2FpdDogcmVhbEV4aXQoMSkgZGkgYmF3YWggbGFuZ3N1bmcgbWVtYXRpa2FuIHdvcmtlciwgZGFuXHJcbiAgICAgICAgICAgIC8vIGthbGF1IGZpcmUtYW5kLWZvcmdldCwga2lyaW1hbiBhc3luYy1ueWEgdGFrIHNlbXBhdCBzZWxlc2FpLlxyXG4gICAgICAgICAgICAvLyBQb3B1cCBwYWthaSBkZXRhaWwgZXJyb3IgYXNsaSAobG9hZEVycm9yRGV0YWlsKSBiaWFyIHNwZXNpZmlrLlxyXG4gICAgICAgICAgICBhd2FpdCBub3RpZnlMb2FkRXJyb3IobGliLCBwaWQsIGFwcE5hbWUsIGxvYWRFcnJvckRldGFpbCB8fCBlcnJvck1zZy50cmltKCkpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZWFsRXhpdCgxKTtcclxuICAgIH1cclxuXHJcbiAgICAvLyAzLiBBS1RJRktBTiBTQU5EQk9YIChLdW5jaSBwaW50dSBzZWJlbHVtIGFwbGlrYXNpIGJlcmphbGFuKVxyXG4gICAgcmVzdHJpY3RIb3N0QVBJKGFwcE5hbWUpO1xyXG5cclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgYXBwID0gbmV3IEFwcENsYXNzKCk7XHJcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYXBwLmV4ZWN1dGUobGliIGFzIGFueSwgYXJncyk7XHJcblxyXG4gICAgICAgIC8vIDMuIEppa2EgYXBsaWthc2kgbWUtcmV0dXJuIHN0cmluZywgY2V0YWsga2UgbGF5YXIgdmlhIFBSSU5UIHN5c2NhbGxcclxuICAgICAgICBpZiAocmVzdWx0ICYmIHR5cGVvZiByZXN1bHQgPT09IFwic3RyaW5nXCIgJiYgcmVzdWx0LnRyaW0oKSAhPT0gXCJcIikge1xyXG4gICAgICAgICAgICBhd2FpdCBsaWIuc3RkLnByaW50KHJlc3VsdCArIFwiXFxuXCIpO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgLy8gNC4gQmVyaXRhaHUgS2VybmVsIGJhaHdhIHByb3NlcyBzZWxlc2FpXHJcbiAgICAgICAgYXdhaXQgbGliLnNoZWxsLmV4aXQoMCk7XHJcbiAgICB9IGNhdGNoIChlcnJvcjogYW55KSB7XHJcbiAgICAgICAgLy8gTGFwb3JrYW4gZXJyb3Iga2UgcGFyZW50IChXTSkgdmlhIElQQ1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHBhcmVudFBpZCA9IGF3YWl0IGxpYi5nZXRQYXJlbnRQaWQoKTtcclxuICAgICAgICAgICAgaWYgKHBhcmVudFBpZCkge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgbGliLnNoZWxsLnNlbmQocGFyZW50UGlkLCB7XHJcbiAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJHVUlfV0lORE9XX0VSUk9SXCIsXHJcbiAgICAgICAgICAgICAgICAgICAgd2lkOiBcIlwiLFxyXG4gICAgICAgICAgICAgICAgICAgIHBpZDogbGliLmdldFBpZCgpLFxyXG4gICAgICAgICAgICAgICAgICAgIGZpbGU6IGFwcE5hbWUgfHwgXCJcIixcclxuICAgICAgICAgICAgICAgICAgICBlcnJvcjogYFJ1bnRpbWUgRXJyb3I6ICR7ZXJyb3IubWVzc2FnZX1gLFxyXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQ6IFwicnVudGltZVwiLFxyXG4gICAgICAgICAgICAgICAgICAgIHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLnJlcGxhY2UoXCJUXCIsIFwiIFwiKS5zdWJzdHJpbmcoMCwgMTkpLFxyXG4gICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGNhdGNoIChfKSB7XHJcbiAgICAgICAgICAgIC8qIElQQyBzZW5kIGZhaWx1cmUgaXMgbm9uLWZhdGFsICovXHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICAvLyBKdWdhIGNvYmEgbGV3YXQgc3RkLmVycm9yIHlhbmcgcHVueWEgbWVrYW5pc21lIGxlYmloIGxlbmdrYXBcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBhd2FpdCBsaWIuc3RkLmVycm9yKGVycm9yLm1lc3NhZ2UgfHwgU3RyaW5nKGVycm9yKSwgYXBwTmFtZSB8fCBcImFwcFwiKTtcclxuICAgICAgICB9IGNhdGNoIChfKSB7fVxyXG5cclxuICAgICAgICAvLyBMYXBvcmthbiBlcnJvciBrZSBUVFkgY29uc29sZVxyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGF3YWl0IGxpYi5zdGQucHJpbnQoYFxcbltXb3JrZXIgJHtwaWR9XSBSdW50aW1lIEVycm9yOiAke2Vycm9yLm1lc3NhZ2V9XFxuYCk7XHJcbiAgICAgICAgfSBjYXRjaCAoZSkge31cclxuICAgICAgICByZWFsRXhpdCgxKTtcclxuICAgIH1cclxufVxyXG5cclxubWFpbigpO1xyXG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSw0QkFBdUM7QUFFdkMsK0JBQTJEO0FBaUIzRCxNQUFNLGlCQUFpQixDQUFDLFFBQ3BCLFFBQVEsUUFBUSxRQUFRLFNBQVksS0FBSyxPQUFPLEtBQUssS0FBSyxRQUFRLEVBQUUsU0FBUyxNQUFNO0FBWXZGLE1BQU0sV0FBVyxRQUFRLEtBQUssS0FBSyxPQUFPO0FBSzFDLE1BQU0sY0FBYyxPQUFPLFlBQVksY0FBYyxVQUFVO0FBQy9ELE1BQU0sT0FBTyxjQUFjLFlBQVksTUFBTSxJQUFJO0FBQ2pELE1BQU0sU0FBUyxjQUFjLFlBQVksUUFBUSxJQUFJO0FBbUJyRCxTQUFTLHdCQUF3QixVQUFrQixTQUF5QjtBQUN4RSxRQUFNLFFBQVEsU0FBUyxNQUFNLEdBQUc7QUFDaEMsUUFBTSxJQUFJO0FBQ1YsYUFBVyxPQUFPLFFBQVEsTUFBTSxHQUFHLEdBQUc7QUFDbEMsUUFBSSxRQUFRLE1BQU0sUUFBUSxJQUFLO0FBQy9CLFFBQUksUUFBUSxNQUFNO0FBRWQsVUFBSSxNQUFNLFNBQVMsRUFBRyxPQUFNLElBQUk7QUFDaEM7QUFBQSxJQUNKO0FBQ0EsVUFBTSxLQUFLLEdBQUc7QUFBQSxFQUNsQjtBQUNBLFNBQU8sTUFBTSxLQUFLLEdBQUc7QUFDekI7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LENBQUMsVUFBVTtBQUNYLFFBQUksa0NBQVk7QUFDWixZQUFNLFdBQVcsY0FDWCxVQUFVLE9BQU8sMkJBQXNCLFdBQVc7QUFBQSxJQUNsRCxVQUFVLE9BQU8sa0NBQWtDLFdBQVcsVUFBVTtBQUFBO0FBQzlFLFlBQU0sSUFBSSxJQUFJLE1BQU0sUUFBUTtBQUM1Qix1Q0FBVyxZQUFZO0FBQUEsUUFDbkIsU0FBUztBQUFBLFFBQ1QsT0FBTyxTQUFTLEtBQUs7QUFBQSxNQUN6QixDQUFDO0FBS0QsWUFBTSxnQkFBZ0IsS0FBSyxLQUFLLFNBQVMsbUJBQW1CLFNBQVMsS0FBSyxDQUFDO0FBQUEsSUFDL0U7QUFDQSxhQUFTLENBQUM7QUFBQSxFQUNkO0FBR0Esa0JBQWdCLE9BQU87QUFFdkIsTUFBSTtBQUNBLFVBQU0sTUFBTSxJQUFJLFNBQVM7QUFDekIsVUFBTSxTQUFTLE1BQU0sSUFBSSxRQUFRLEtBQVksSUFBSTtBQUdqRCxRQUFJLFVBQVUsT0FBTyxXQUFXLFlBQVksT0FBTyxLQUFLLE1BQU0sSUFBSTtBQUM5RCxZQUFNLElBQUksSUFBSSxNQUFNLFNBQVMsSUFBSTtBQUFBLElBQ3JDO0FBR0EsVUFBTSxJQUFJLE1BQU0sS0FBSyxDQUFDO0FBQUEsRUFDMUIsU0FBUyxPQUFZO0FBRWpCLFFBQUk7QUFDQSxZQUFNLFlBQVksTUFBTSxJQUFJLGFBQWE7QUFDekMsVUFBSSxXQUFXO0FBQ1gsY0FBTSxJQUFJLE1BQU0sS0FBSyxXQUFXO0FBQUEsVUFDNUIsTUFBTTtBQUFBLFVBQ04sS0FBSztBQUFBLFVBQ0wsS0FBSyxJQUFJLE9BQU87QUFBQSxVQUNoQixNQUFNLFdBQVc7QUFBQSxVQUNqQixPQUFPLGtCQUFrQixNQUFNLE9BQU87QUFBQSxVQUN0QyxTQUFTO0FBQUEsVUFDVCxZQUFXLG9CQUFJLEtBQUssR0FBRSxZQUFZLEVBQUUsUUFBUSxLQUFLLEdBQUcsRUFBRSxVQUFVLEdBQUcsRUFBRTtBQUFBLFFBQ3pFLENBQUM7QUFBQSxNQUNMO0FBQUEsSUFDSixTQUFTLEdBQUc7QUFBQSxJQUVaO0FBR0EsUUFBSTtBQUNBLFlBQU0sSUFBSSxJQUFJLE1BQU0sTUFBTSxXQUFXLE9BQU8sS0FBSyxHQUFHLFdBQVcsS0FBSztBQUFBLElBQ3hFLFNBQVMsR0FBRztBQUFBLElBQUM7QUFHYixRQUFJO0FBQ0EsWUFBTSxJQUFJLElBQUksTUFBTTtBQUFBLFVBQWEsR0FBRyxvQkFBb0IsTUFBTSxPQUFPO0FBQUEsQ0FBSTtBQUFBLElBQzdFLFNBQVMsR0FBRztBQUFBLElBQUM7QUFDYixhQUFTLENBQUM7QUFBQSxFQUNkO0FBQ0o7QUFFQSxLQUFLOyIsCiAgIm5hbWVzIjogWyJtb2R1bGUiXQp9Cg==
