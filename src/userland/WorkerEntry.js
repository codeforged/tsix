var import_worker_threads = require("worker_threads");
var import_VfsModuleResolver = require("./VfsModuleResolver");
var import_VfsText = require("../common/VfsText");
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
      const wmPidRaw = await lib.fs.readFile("/opt/asteracea/wm-pid");
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
            readFile: async (vfsPath) => (0, import_VfsText.vfsBytesToUtf8)(await lib.fs.readFile(vfsPath)),
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiV29ya2VyRW50cnkudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IHdvcmtlckRhdGEsIHBhcmVudFBvcnQgfSBmcm9tIFwid29ya2VyX3RocmVhZHNcIjtcclxuaW1wb3J0IHsgV29ya2VySW5pdERhdGEsIFN5c2NhbGxSZXNwb25zZSB9IGZyb20gXCIuLi9jb21tb24vSVBDVHlwZXNcIjtcclxuaW1wb3J0IHsgY29sbGVjdFJlbGF0aXZlTW9kdWxlcywgcmVzb2x2ZVZmc1JlbGF0aXZlIH0gZnJvbSBcIi4vVmZzTW9kdWxlUmVzb2x2ZXJcIjtcclxuaW1wb3J0IHsgdmZzQnl0ZXNUb1V0ZjggfSBmcm9tIFwiLi4vY29tbW9uL1Zmc1RleHRcIjtcclxuXHJcbi8qKlxyXG4gKiBXT1JLRVIgRU5UUlkgUE9JTlRcclxuXHJcbiAqIFxyXG4gKiBJbmkgYWRhbGFoIHNjcmlwdCBcIkJvb3Rsb2FkZXJcIiB5YW5nIGphbGFuIGRpIGRhbGFtIFdvcmtlciBUaHJlYWQuXHJcbiAqIFR1Z2FzbnlhOiBJbmlzaWFsaXNhc2kgVXNlckxpYiBkYW4gamFsYW5rYW4gYXBsaWthc2kuXHJcbiAqL1xyXG5cclxuLy8gdHNjb25maWctcGF0aHMgZGFuIGVzYnVpbGQtcmVnaXN0ZXIgc3VkYWggZGktbG9hZCB2aWEgZXhlY0FyZ3YgZGkgU2NoZWR1bGVyLnRzXHJcblxyXG5jb25zdCByZWFsRXhpdCA9IHByb2Nlc3MuZXhpdC5iaW5kKHByb2Nlc3MpO1xyXG5cclxuLy8gLS0tIFBFUkZPUk1BTkNFIEhJSkFDSyAtLS1cclxuLy8gUHJlLWxvYWQgY29yZSBsaWJyYXJpZXMgYW5kIGhpamFjayByZXF1aXJlIHRvIGF2b2lkIG11bHRpcGxlIEZTIGhpdHNcclxuLy8gaW4gdGhlIGhpZ2gtcGVyZm9ybWFuY2UgcGF0aC5cclxuY29uc3QgaG9zdFJlcXVpcmUgPSB0eXBlb2YgcmVxdWlyZSAhPT0gXCJ1bmRlZmluZWRcIiA/IHJlcXVpcmUgOiBudWxsO1xyXG5jb25zdCBwYXRoID0gaG9zdFJlcXVpcmUgPyBob3N0UmVxdWlyZShcInBhdGhcIikgOiBudWxsO1xyXG5jb25zdCBNb2R1bGUgPSBob3N0UmVxdWlyZSA/IGhvc3RSZXF1aXJlKFwibW9kdWxlXCIpIDogbnVsbDtcclxuXHJcbi8qKlxyXG4gKiByZXNvbHZlUmVsYXRpdmVNb2R1bGVJZCgpOiBNZW5lcmplbWFoa2FuIGltcG9ydCByZWxhdGlmIE1JTElLIE1PRFVMXHJcbiAqIEZSQU1FV09SSyBrZSBtb2R1bGUtaWQgKGBAdHNpeC94YCwgYEBjb21tb24vYS9iYCkuXHJcbiAqXHJcbiAqIEtlbmFwYSBwZXJsdTogV29ya2VyRW50cnkgbWUtX2NvbXBpbGUoKSBtb2R1bCBmcmFtZXdvcmsgZGFyaSBtZW1vcnkgZGVuZ2FuXHJcbiAqIG5hbWEgZmlsZSBidWF0YW4gKGBAY29tbW9uX25ldGZzL05ldEZTU2VydmVyLmpzYCksIGphZGkgYC4vTmV0RlNQcm90b2NvbGBcclxuICogaGFueWEgYmlzYSBkaS1yZXNvbHZlIGthbGF1IGtpdGEgdGFodSBpZCBtb2R1bCBpbmR1a255YS4gQ2FyYSBsYW1hIG1lbWFrYWlcclxuICogYHBhdGguYmFzZW5hbWUocGFyZW50LmZpbGVuYW1lKWA6XHJcbiAqXHJcbiAqICAgLSBgQHRzaXhfQXBwbGljYXRpb24uanNgICAgICAgXHUyMTkyIGJhc2VuYW1lIGNvY29rLCBgLi94YCBcdTIxOTIgYEB0c2l4L3hgICAgXHUyNzA1XHJcbiAqICAgLSBgTmV0RlNTZXJ2ZXIuanNgIChiZXJzYXJhbmcpIFx1MjE5MiBiYXNlbmFtZSBUSURBSyBjb2NvaywgYC4vTmV0RlNQcm90b2NvbGBcclxuICogICAgIGRpYmlhcmthbiBhcGEgYWRhbnlhIFx1MjE5MiBgQ2Fubm90IGZpbmQgbW9kdWxlICcuL05ldEZTUHJvdG9jb2wnYCAgXHUyNzRDXHJcbiAqXHJcbiAqIERlbmdhbiByZXNvbHVzaSBkaSBydWFuZyBtb2R1bGUtaWQsIGtlZGFsYW1hbiBiZXJhcGEgcHVuIHRldGFwIGJlbmFyOlxyXG4gKiAgIGBAY29tbW9uL25ldGZzL05ldEZTU2VydmVyYCArIGAuL05ldEZTUHJvdG9jb2xgIFx1MjE5MiBgQGNvbW1vbi9uZXRmcy9OZXRGU1Byb3RvY29sYFxyXG4gKiAgIGBAY29tbW9uL25ldGZzL05ldEZTU2VydmVyYCArIGAuLi9Mb2dnZXJgICAgICAgIFx1MjE5MiBgQGNvbW1vbi9Mb2dnZXJgXHJcbiAqL1xyXG5mdW5jdGlvbiByZXNvbHZlUmVsYXRpdmVNb2R1bGVJZChwYXJlbnRJZDogc3RyaW5nLCByZXF1ZXN0OiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgY29uc3QgcGFydHMgPSBwYXJlbnRJZC5zcGxpdChcIi9cIik7XHJcbiAgICBwYXJ0cy5wb3AoKTsgLy8gYnVhbmcgbmFtYSBtb2R1bCBpbmR1a1xyXG4gICAgZm9yIChjb25zdCBzZWcgb2YgcmVxdWVzdC5zcGxpdChcIi9cIikpIHtcclxuICAgICAgICBpZiAoc2VnID09PSBcIlwiIHx8IHNlZyA9PT0gXCIuXCIpIGNvbnRpbnVlO1xyXG4gICAgICAgIGlmIChzZWcgPT09IFwiLi5cIikge1xyXG4gICAgICAgICAgICAvLyBTaXNha2FuIHNlZ21lbiBzY29wZSAoYEB0c2l4YCAvIGBAY29tbW9uYCkgXHUyMDE0IGphbmdhbiBwZXJuYWggaGFiaXMuXHJcbiAgICAgICAgICAgIGlmIChwYXJ0cy5sZW5ndGggPiAxKSBwYXJ0cy5wb3AoKTtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHBhcnRzLnB1c2goc2VnKTtcclxuICAgIH1cclxuICAgIHJldHVybiBwYXJ0cy5qb2luKFwiL1wiKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIE1PRFVMIFJFTEFUSUYgTUlMSUsgUFJPR1JBTSBWRlMgKG1pcy4gYC9zYmluL3Rwa2dkYCArIGAuL1Rwa2dQcm90b2NvbGApLlxyXG4gKlxyXG4gKiBgTW9kdWxlLl9sb2FkYCBzaW5rcm9uLCBzZWRhbmdrYW4gYmFjYSBWRlMgYXNpbmtyb24gXHUyMDE0IGphZGkgaXNpbnlhIGRpa3VtcHVsa2FuXHJcbiAqIGxlYmloIGR1bHUgZGkgYG1haW4oKWAgKGxpaGF0IGBjb2xsZWN0UmVsYXRpdmVNb2R1bGVzYCksIGxhbHUgaG9vayBkaSBiYXdhaFxyXG4gKiBoYW55YSBNRUxJSEFUIHBldGEgaW5pOiBpZCBtb2R1bGUgKGAvc2Jpbi9UcGtnUHJvdG9jb2xgKSBcdTIxOTIga29kZSBKUy5cclxuICpcclxuICogRHVsdSBpbXBvcnQgc2VzYW1hIGRpcmVrdG9yaSB0aWRhayBkaWR1a3VuZyBzYW1hIHNla2FsaSAoc2VsYWx1IGphdHVoIGtlIGhvc3RcclxuICogZmlsZXN5c3RlbSBcdTIxOTIgXCJDYW5ub3QgZmluZCBtb2R1bGUgJy4vVHBrZ1Byb3RvY29sJ1wiKS5cclxuICovXHJcbmxldCBwcm9ncmFtTW9kdWxlczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xyXG5cclxuaWYgKE1vZHVsZSAmJiBwYXRoKSB7XHJcbiAgICBjb25zdCBvcmlnaW5hbExvYWQgPSBNb2R1bGUuX2xvYWQ7XHJcbiAgICBjb25zdCB2ZnNDYWNoZSA9ICh3b3JrZXJEYXRhIGFzIGFueSkudmZzQ2FjaGUgfHwge307XHJcbiAgICBjb25zdCBtb2R1bGVDYWNoZTogUmVjb3JkPHN0cmluZywgYW55PiA9IHt9O1xyXG4gICAgLy8gUGV0YSBkdW1teUZpbGVuYW1lIFx1MjE5MiBtb2R1bGUtaWQgKGBAdHNpeC94YCwgYEBjb21tb24vYS9iYCkuIERpcGFrYWkgdW50dWtcclxuICAgIC8vIG1lbmVyamVtYWhrYW4gaW1wb3J0IFJFTEFUSUYgbWlsaWsgbW9kdWwgZnJhbWV3b3JrIChsaWhhdFxyXG4gICAgLy8gcmVzb2x2ZVJlbGF0aXZlTW9kdWxlSWQpLlxyXG4gICAgY29uc3QgbW9kdWxlSWRCeUZpbGU6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcclxuXHJcbiAgICBNb2R1bGUuX2xvYWQgPSBmdW5jdGlvbiAocmVxdWVzdDogc3RyaW5nLCBwYXJlbnQ6IGFueSwgaXNNYWluOiBib29sZWFuKSB7XHJcbiAgICAgICAgbGV0IG5vcm1hbGl6ZWRSZXF1ZXN0ID0gcmVxdWVzdDtcclxuXHJcbiAgICAgICAgLy8gUmVzb2x2ZSByZWxhdGl2ZSBwYXRoc1xyXG4gICAgICAgIGlmIChyZXF1ZXN0LnN0YXJ0c1dpdGgoXCIuXCIpKSB7XHJcbiAgICAgICAgICAgIGlmIChyZXF1ZXN0LmluY2x1ZGVzKFwiL2NvbW1vbi9cIikpIHtcclxuICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRSZXF1ZXN0ID0gXCJAY29tbW9uL1wiICsgcmVxdWVzdC5zcGxpdChcIi9jb21tb24vXCIpWzFdO1xyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKHJlcXVlc3QuaW5jbHVkZXMoXCIvbGliL1wiKSkge1xyXG4gICAgICAgICAgICAgICAgbm9ybWFsaXplZFJlcXVlc3QgPSBcIkB0c2l4L1wiICsgcmVxdWVzdC5zcGxpdChcIi9saWIvXCIpWzFdO1xyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKHBhcmVudCAmJiBwYXJlbnQuZmlsZW5hbWUpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHBhcmVudElkID0gbW9kdWxlSWRCeUZpbGVbcGFyZW50LmZpbGVuYW1lXTtcclxuICAgICAgICAgICAgICAgIGlmIChwYXJlbnRJZCkge1xyXG4gICAgICAgICAgICAgICAgICAgIC8vIE1vZHVsIGZyYW1ld29yayB5YW5nIGtpdGEgbXVhdCBzZW5kaXJpOiByZXNvbHVzaSByZWxhdGlmXHJcbiAgICAgICAgICAgICAgICAgICAgLy8gZGlsYWt1a2FuIGRpIHJ1YW5nIG1vZHVsZS1pZCAoYmVuYXIgdW50dWsgc2VtdWEga2VkYWxhbWFuKS5cclxuICAgICAgICAgICAgICAgICAgICBub3JtYWxpemVkUmVxdWVzdCA9IHJlc29sdmVSZWxhdGl2ZU1vZHVsZUlkKHBhcmVudElkLCByZXF1ZXN0KTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgLy8gUHJvZ3JhbSBWRlMgKGJ1a2FuIG1vZHVsIGZyYW1ld29yayk6IGZpbGVueWEgYmVydXBhIHBhdGggVkZTXHJcbiAgICAgICAgICAgICAgICAgICAgLy8gKGAvc2Jpbi90cGtnZC5qc2ApLiBSZXNvbHVzaWthbiByZWxhdGlmIHRlcmhhZGFwIGRpcmVrdG9yaW55YSxcclxuICAgICAgICAgICAgICAgICAgICAvLyBsYWx1IGNhcmkgZGkgcGV0YSBtb2R1bCB5YW5nIHN1ZGFoIGRpYmFjYSBkYXJpIFZGUy5cclxuICAgICAgICAgICAgICAgICAgICAvL1xyXG4gICAgICAgICAgICAgICAgICAgIC8vIFVydXRhbiBwZW50aW5nOiBjYWJhbmcgYC9saWIvYCAmIGAvY29tbW9uL2AgZGkgYXRhcyBkaWRhaHVsdWthblxyXG4gICAgICAgICAgICAgICAgICAgIC8vIHN1cGF5YSBgLi4vbGliL3hgIHRldGFwIGRpbGF5YW5pIGNhY2hlIGZyYW1ld29yay5cclxuICAgICAgICAgICAgICAgICAgICBjb25zdCB2ZnNUYXJnZXQgPSBwYXJlbnQuZmlsZW5hbWUuc3RhcnRzV2l0aChcIi9cIilcclxuICAgICAgICAgICAgICAgICAgICAgICAgPyByZXNvbHZlVmZzUmVsYXRpdmUocGFyZW50LmZpbGVuYW1lLCByZXF1ZXN0KVxyXG4gICAgICAgICAgICAgICAgICAgICAgICA6IG51bGw7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKHZmc1RhcmdldCAmJiBwcm9ncmFtTW9kdWxlc1t2ZnNUYXJnZXRdKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRSZXF1ZXN0ID0gdmZzVGFyZ2V0O1xyXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGJhc2VuYW1lID0gcGF0aCEuYmFzZW5hbWUocGFyZW50LmZpbGVuYW1lKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGJhc2VuYW1lLnN0YXJ0c1dpdGgoXCJAdHNpeF9cIikgJiYgcmVxdWVzdC5zdGFydHNXaXRoKFwiLi9cIikpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRSZXF1ZXN0ID0gXCJAdHNpeC9cIiArIHJlcXVlc3Quc3Vic3RyaW5nKDIpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGJhc2VuYW1lLnN0YXJ0c1dpdGgoXCJAY29tbW9uX1wiKSAmJiByZXF1ZXN0LnN0YXJ0c1dpdGgoXCIuL1wiKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbm9ybWFsaXplZFJlcXVlc3QgPSBcIkBjb21tb24vXCIgKyByZXF1ZXN0LnN1YnN0cmluZygyKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgLy8gQ2FjaGVkIE1vZHVsZVxyXG4gICAgICAgIGlmIChtb2R1bGVDYWNoZVtub3JtYWxpemVkUmVxdWVzdF0pIHJldHVybiBtb2R1bGVDYWNoZVtub3JtYWxpemVkUmVxdWVzdF07XHJcblxyXG4gICAgICAgIC8vIFJlc29sdXNpIE1lbW9yeSBGcmFtZXdvcmsgKFZGUylcclxuICAgICAgICBsZXQgdmZzUGF0aCA9IG51bGw7XHJcbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRSZXF1ZXN0LnN0YXJ0c1dpdGgoXCJAdHNpeC9cIikpIHtcclxuICAgICAgICAgICAgdmZzUGF0aCA9IFwiL2xpYi9cIiArIG5vcm1hbGl6ZWRSZXF1ZXN0LnN1YnN0cmluZyg2KSArIFwiLnRzXCI7XHJcbiAgICAgICAgfSBlbHNlIGlmIChub3JtYWxpemVkUmVxdWVzdC5zdGFydHNXaXRoKFwiQGNvbW1vbi9cIikpIHtcclxuICAgICAgICAgICAgdmZzUGF0aCA9IFwiL2xpYi9jb21tb24vXCIgKyBub3JtYWxpemVkUmVxdWVzdC5zdWJzdHJpbmcoOCkgKyBcIi50c1wiO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgLy8gTW9kdWwgcmVsYXRpZiBtaWxpayBwcm9ncmFtIChwZXRhIGRhcmkgYGNvbGxlY3RSZWxhdGl2ZU1vZHVsZXNgKS5cclxuICAgICAgICAvLyBJZC1ueWEgc3VkYWggdGFucGEgZWtzdGVuc2ksIGphZGkgZGljYXJpIGxhbmdzdW5nLlxyXG4gICAgICAgIGlmICghdmZzUGF0aCAmJiBwcm9ncmFtTW9kdWxlc1tub3JtYWxpemVkUmVxdWVzdF0pIHtcclxuICAgICAgICAgICAgY29uc3QgY29udGVudCA9IHByb2dyYW1Nb2R1bGVzW25vcm1hbGl6ZWRSZXF1ZXN0XTtcclxuICAgICAgICAgICAgY29uc3QgZHVtbXlGaWxlbmFtZSA9IHBhdGghLmpvaW4ocHJvY2Vzcy5jd2QoKSwgbm9ybWFsaXplZFJlcXVlc3QucmVwbGFjZSgvXFwvL2csIFwiX1wiKSArIFwiLmpzXCIpO1xyXG5cclxuICAgICAgICAgICAgY29uc3QgbmV3TW9kID0gbmV3IE1vZHVsZShkdW1teUZpbGVuYW1lLCBwYXJlbnQpO1xyXG4gICAgICAgICAgICBuZXdNb2QuZmlsZW5hbWUgPSBkdW1teUZpbGVuYW1lO1xyXG4gICAgICAgICAgICBuZXdNb2QucGF0aHMgPSBNb2R1bGUuX25vZGVNb2R1bGVQYXRocyhwcm9jZXNzLmN3ZCgpKTtcclxuXHJcbiAgICAgICAgICAgIC8vIERhZnRhcmthbiBTRUJFTFVNIF9jb21waWxlOiBtb2R1bCBpbmkgYmlzYSBtZS1yZXF1aXJlIGFuYWtueWEgc2FhdFxyXG4gICAgICAgICAgICAvLyBfY29tcGlsZSBiZXJqYWxhbi4gSWQtbnlhIHBhdGggVkZTIHN1cGF5YSBpbXBvcnQgcmVsYXRpZiBiZXJzYXJhbmdcclxuICAgICAgICAgICAgLy8gaWt1dCBiZW5hciAocmVzb2x2ZVJlbGF0aXZlTW9kdWxlSWQgbWVuYW5nYW5pIGJlbnR1ayBcIi9hL2JcIikuXHJcbiAgICAgICAgICAgIG1vZHVsZUlkQnlGaWxlW2R1bW15RmlsZW5hbWVdID0gbm9ybWFsaXplZFJlcXVlc3Q7XHJcbiAgICAgICAgICAgIChuZXdNb2QgYXMgYW55KS5fY29tcGlsZShjb250ZW50LCBkdW1teUZpbGVuYW1lKTtcclxuXHJcbiAgICAgICAgICAgIG1vZHVsZUNhY2hlW25vcm1hbGl6ZWRSZXF1ZXN0XSA9IG5ld01vZC5leHBvcnRzO1xyXG4gICAgICAgICAgICByZXR1cm4gbmV3TW9kLmV4cG9ydHM7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBpZiAodmZzUGF0aCAmJiB2ZnNDYWNoZVt2ZnNQYXRoXSkge1xyXG4gICAgICAgICAgICBjb25zdCBjb250ZW50ID0gdmZzQ2FjaGVbdmZzUGF0aF07XHJcbiAgICAgICAgICAgIGNvbnN0IGR1bW15RmlsZW5hbWUgPSBwYXRoIS5qb2luKHByb2Nlc3MuY3dkKCksIG5vcm1hbGl6ZWRSZXF1ZXN0LnJlcGxhY2UoXCIvXCIsIFwiX1wiKSArIFwiLmpzXCIpO1xyXG5cclxuICAgICAgICAgICAgY29uc3QgbmV3TW9kID0gbmV3IE1vZHVsZShkdW1teUZpbGVuYW1lLCBwYXJlbnQpO1xyXG4gICAgICAgICAgICBuZXdNb2QuZmlsZW5hbWUgPSBkdW1teUZpbGVuYW1lO1xyXG4gICAgICAgICAgICBuZXdNb2QucGF0aHMgPSBNb2R1bGUuX25vZGVNb2R1bGVQYXRocyhwcm9jZXNzLmN3ZCgpKTtcclxuXHJcbiAgICAgICAgICAgIC8vIFBFTlRJTkc6IGRhZnRhcmthbiBTRUJFTFVNIF9jb21waWxlIFx1MjAxNCBpc2kgbW9kdWwgbWUtcmVxdWlyZSBhbmFrbnlhXHJcbiAgICAgICAgICAgIC8vIHNhYXQgX2NvbXBpbGUgYmVyamFsYW4sIGphZGkgcGV0YSBpbmkgaGFydXMgc3VkYWggdGVyaXNpLlxyXG4gICAgICAgICAgICBtb2R1bGVJZEJ5RmlsZVtkdW1teUZpbGVuYW1lXSA9IG5vcm1hbGl6ZWRSZXF1ZXN0O1xyXG5cclxuICAgICAgICAgICAgLy8gRnJhbWV3b3JrIG1vZHVsZXMgYXJlIG5vdyBwcmUtY29tcGlsZWQgaW4gS2VybmVsLlxyXG4gICAgICAgICAgICAvLyBEaXJlY3QgZXhlY3V0aW9uIGZvciBtYXhpbXVtIHBlcmZvcm1hbmNlLlxyXG4gICAgICAgICAgICAobmV3TW9kIGFzIGFueSkuX2NvbXBpbGUoY29udGVudCwgZHVtbXlGaWxlbmFtZSk7XHJcblxyXG4gICAgICAgICAgICBtb2R1bGVDYWNoZVtub3JtYWxpemVkUmVxdWVzdF0gPSBuZXdNb2QuZXhwb3J0cztcclxuICAgICAgICAgICAgcmV0dXJuIG5ld01vZC5leHBvcnRzO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgcmV0dXJuIG9yaWdpbmFsTG9hZC5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xyXG4gICAgfTtcclxuXHJcbiAgICAoZ2xvYmFsIGFzIGFueSkuaGlqYWNrUmVxdWlyZSA9IChpZDogc3RyaW5nKSA9PiB7XHJcbiAgICAgICAgaWYgKGhvc3RSZXF1aXJlKSByZXR1cm4gaG9zdFJlcXVpcmUoaWQpO1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVxdWlyZSBmYWlsZWQgZm9yICR7aWR9IChObyBob3N0IHJlcXVpcmUpYCk7XHJcbiAgICB9O1xyXG59XHJcblxyXG5jb25zdCBoaWphY2tSZXF1aXJlID0gKGlkOiBzdHJpbmcpID0+XHJcbiAgICAoZ2xvYmFsIGFzIGFueSkuaGlqYWNrUmVxdWlyZSA/IChnbG9iYWwgYXMgYW55KS5oaWphY2tSZXF1aXJlKGlkKSA6IGhvc3RSZXF1aXJlID8gaG9zdFJlcXVpcmUoaWQpIDogbnVsbDtcclxuXHJcbmlmICh0eXBlb2YgcmVxdWlyZSAhPT0gXCJ1bmRlZmluZWRcIikge1xyXG4gICAgKGdsb2JhbCBhcyBhbnkpLnJlcXVpcmUgPSBoaWphY2tSZXF1aXJlO1xyXG59XHJcblxyXG4vKipcclxuICogTUVNT1JZIFNUQVQgUkVTUE9OREVSIFx1MjAxNCBqYWx1ciBmYWxsYmFjayBgcHMgLS1tZW1gIC8gYG1lbSAtLXBlci1wcm9jYFxyXG4gKlxyXG4gKiBLZXJuZWwgbGViaWggc3VrYSBtZW1iYWNhIGlzb2xhdGUgd29ya2VyIHNlbmRpcmkgbGV3YXRcclxuICogYHdvcmtlci5nZXRIZWFwU3RhdGlzdGljcygpYCwgVEFQSSBtZXRob2QgaXR1IGJhcnUgYWRhIGRpIE5vZGUgPj0gMjIuMTYuXHJcbiAqIERpIE5vZGUgbGFtYSBrZXJuZWwgbWVuZ2lyaW0gcGVzYW4gYHsgX190c2l4TWVtU3RhdFJlcXVlc3QgfWAgZGFuIG1lbnVuZ2d1XHJcbiAqIGJhbGFzYW47IHJlc3BvbmRlciBpbmkgeWFuZyBtZW5qYXdhYm55YS5cclxuICpcclxuICogS2VuYXBhIGRpIHNpbmkgKFdvcmtlckVudHJ5KSBkYW4gYnVrYW4gZGkgVXNlckxpYjogYm9vdGxvYWRlciBpbmkgU0VMQUxVXHJcbiAqIGphbGFuLCBiYWhrYW4gdW50dWsgYXBwIHlhbmcgZ2FnYWwgZGltdWF0IFx1MjAxNCBzZWRhbmdrYW4gVXNlckxpYiBiYXJ1IGhpZHVwXHJcbiAqIHNldGVsYWggYXBwIG1lbmctaW1wb3J0IGZyYW1ld29yay4gVGFucGEgaXR1LCBwcm9zZXMgYmVybWFzYWxhaCBqdXN0cnVcclxuICoga2VoaWxhbmdhbiBhbmdrYSBtZW1vcmlueWEuXHJcbiAqXHJcbiAqIGByc3NgIHNlbmdhamEgVElEQUsgZGlsYXBvcmthbjogZGkgZGFsYW0gd29ya2VyIG5pbGFpbnlhIHByb2Nlc3Mtd2lkZVxyXG4gKiAobWFpbiB0aHJlYWQgKyBzZW11YSB3b3JrZXIpLCBtZW55ZXNhdGthbiB1bnR1ayBhdHJpYnVzaSBwZXItcHJvc2VzLlxyXG4gKi9cclxuaWYgKHBhcmVudFBvcnQpIHtcclxuICAgIHBhcmVudFBvcnQub24oXCJtZXNzYWdlXCIsIChtc2c6IGFueSkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHJlcXVlc3RJZCA9IG1zZyAmJiBtc2cuX190c2l4TWVtU3RhdFJlcXVlc3Q7XHJcbiAgICAgICAgaWYgKHR5cGVvZiByZXF1ZXN0SWQgIT09IFwic3RyaW5nXCIpIHJldHVybjtcclxuXHJcbiAgICAgICAgLy8gSmFuZ2FuIGJpYXJrYW4ga2VnYWdhbGFuIHBlbWJhY2FhbiBtZW1hdGlrYW4gcHJvc2VzIFx1MjAxNCBiYWxhcyBhcGEgYWRhbnlhLlxyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG0gPSBwcm9jZXNzLm1lbW9yeVVzYWdlKCk7XHJcbiAgICAgICAgICAgIGxldCBoZWFwTGltaXQgPSAwO1xyXG4gICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgaGVhcExpbWl0ID0gaG9zdFJlcXVpcmUgPyBob3N0UmVxdWlyZShcInY4XCIpLmdldEhlYXBTdGF0aXN0aWNzKCkuaGVhcF9zaXplX2xpbWl0IDogMDtcclxuICAgICAgICAgICAgfSBjYXRjaCAoXykge1xyXG4gICAgICAgICAgICAgICAgLyogdjggb3BzaW9uYWwgXHUyMDE0IDAgYmVyYXJ0aSB0aWRhayBkaWtldGFodWkgKi9cclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgcGFyZW50UG9ydCEucG9zdE1lc3NhZ2Uoe1xyXG4gICAgICAgICAgICAgICAgX190c2l4TWVtU3RhdDogcmVxdWVzdElkLFxyXG4gICAgICAgICAgICAgICAgc3RhdHM6IHtcclxuICAgICAgICAgICAgICAgICAgICBoZWFwVXNlZDogbS5oZWFwVXNlZCxcclxuICAgICAgICAgICAgICAgICAgICBoZWFwVG90YWw6IG0uaGVhcFRvdGFsLFxyXG4gICAgICAgICAgICAgICAgICAgIGV4dGVybmFsOiBtLmV4dGVybmFsLFxyXG4gICAgICAgICAgICAgICAgICAgIGFycmF5QnVmZmVyczogbS5hcnJheUJ1ZmZlcnMsXHJcbiAgICAgICAgICAgICAgICAgICAgaGVhcExpbWl0LFxyXG4gICAgICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfSBjYXRjaCAoXykge1xyXG4gICAgICAgICAgICAvLyBCYWxhcyBudWxsIHN1cGF5YSBrZXJuZWwgdGlkYWsgbWVudW5nZ3Ugc2FtcGFpIHRpbWVvdXQuXHJcbiAgICAgICAgICAgIHBhcmVudFBvcnQhLnBvc3RNZXNzYWdlKHsgX190c2l4TWVtU3RhdDogcmVxdWVzdElkLCBzdGF0czogbnVsbCB9KTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxufVxyXG5cclxucHJvY2Vzcy5vbihcInVuaGFuZGxlZFJlamVjdGlvblwiLCAocmVhc29uKSA9PiB7XHJcbiAgICBjb25zdCBtc2cgPSByZWFzb24gaW5zdGFuY2VvZiBFcnJvciA/IHJlYXNvbi5tZXNzYWdlIDogU3RyaW5nKHJlYXNvbik7XHJcbiAgICBjb25zb2xlLmVycm9yKFwiW1dvcmtlciBGYXRhbF0gVW5oYW5kbGVkIFJlamVjdGlvbjpcIiwgbXNnKTtcclxuICAgIHRyeVNlbmRFcnJvclRvUGFyZW50KG1zZyk7XHJcbiAgICByZWFsRXhpdCgxKTtcclxufSk7XHJcblxyXG5wcm9jZXNzLm9uKFwidW5jYXVnaHRFeGNlcHRpb25cIiwgKGVycikgPT4ge1xyXG4gICAgY29uc3QgbXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xyXG4gICAgY29uc29sZS5lcnJvcihcIltXb3JrZXIgRmF0YWxdIFVuY2F1Z2h0IEV4Y2VwdGlvbjpcIiwgbXNnKTtcclxuICAgIHRyeVNlbmRFcnJvclRvUGFyZW50KG1zZyk7XHJcbiAgICByZWFsRXhpdCgxKTtcclxufSk7XHJcblxyXG4vLyBIZWxwZXI6IGNvYmEga2lyaW0gR1VJX1dJTkRPV19FUlJPUiBrZSBwYXJlbnQgKEFzdGVyYWNlYSkgc2ViZWx1bSBleGl0XHJcbmZ1bmN0aW9uIHRyeVNlbmRFcnJvclRvUGFyZW50KG1lc3NhZ2U6IHN0cmluZykge1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBsaWIgPSAoZ2xvYmFsIGFzIGFueSkuX3RzaXhMaWIgYXMgYW55O1xyXG4gICAgICAgIGlmIChsaWIgJiYgdHlwZW9mIGxpYi5nZXRQYXJlbnRQaWQgPT09IFwiZnVuY3Rpb25cIiAmJiB0eXBlb2YgbGliLnNoZWxsPy5zZW5kID09PSBcImZ1bmN0aW9uXCIpIHtcclxuICAgICAgICAgICAgbGliLmdldFBhcmVudFBpZCgpXHJcbiAgICAgICAgICAgICAgICAudGhlbigocGFyZW50UGlkOiBudW1iZXIpID0+IHtcclxuICAgICAgICAgICAgICAgICAgICBpZiAocGFyZW50UGlkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGxpYi5zaGVsbC5zZW5kKHBhcmVudFBpZCwge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJHVUlfV0lORE9XX0VSUk9SXCIsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aWQ6IFwiXCIsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwaWQ6IGxpYi5nZXRQaWQoKSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpbGU6IFwiXCIsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJvcjogYFJ1bnRpbWUgRXJyb3I6ICR7bWVzc2FnZX1gLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29udGV4dDogXCJydW50aW1lXCIsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5yZXBsYWNlKFwiVFwiLCBcIiBcIikuc3Vic3RyaW5nKDAsIDE5KSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfSlcclxuICAgICAgICAgICAgICAgIC5jYXRjaCgoKSA9PiB7fSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSBjYXRjaCAoXykge1xyXG4gICAgICAgIC8qIGlnbm9yZSAqL1xyXG4gICAgfVxyXG59XHJcblxyXG4vLyAtLS0gQkFTSUMgU0FOREJPWElORyAoRWR1Y2F0aW9uYWwgTGV2ZWwpIC0tLVxyXG4vLyBLaXRhIFwic2VtYnVueWlrYW5cIiBiZWJlcmFwYSBBUEkgTm9kZS5qcyB5YW5nIGJlcmJhaGF5YSBhZ2FyIHVzZXItbGFuZFxyXG4vLyBkaXBha3NhIG1lbmdndW5ha2FuIFN5c2NhbGwgbGV3YXQgVXNlckxpYi5cclxuY29uc3QgcmVzdHJpY3RIb3N0QVBJID0gKGFwcE5hbWU6IHN0cmluZykgPT4ge1xyXG4gICAgY29uc3QgZm9yYmlkZGVuID0gKG1zZzogc3RyaW5nID0gXCJTZWN1cml0eSBWaW9sYXRpb246IERpcmVjdCBIb3N0IEFQSSBhY2Nlc3MgaXMgZm9yYmlkZGVuIGluIFRTSVggU2FuZGJveC5cIikgPT4ge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihtc2cpO1xyXG4gICAgfTtcclxuXHJcbiAgICBjb25zdCBpc1ByaXZpbGVnZWQgPVxyXG4gICAgICAgIGFwcE5hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcInNlcnZlclwiKSB8fFxyXG4gICAgICAgIGFwcE5hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcImRhZW1vblwiKSB8fFxyXG4gICAgICAgIGFwcE5hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcImRvbWVcIikgfHxcclxuICAgICAgICBhcHBOYW1lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJ0YnVpbGRcIikgfHxcclxuICAgICAgICBhcHBOYW1lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJ2ZnNcIikgfHxcclxuICAgICAgICBhcHBOYW1lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJteXNxbGRcIik7XHJcbiAgICBjb25zdCBhbGxvd2VkTW9kdWxlcyA9IFtcInBhdGhcIiwgXCJmc1wiLCBcInVybFwiLCBcImVzYnVpbGRcIiwgXCJjcnlwdG9cIiwgXCJvc1wiLCBcImJjcnlwdGpzXCIsIFwibXlzcWwyXCIsIFwibXlzcWwyL3Byb21pc2VcIl07XHJcblxyXG4gICAgY29uc3QgcHJpdmlsZWdlZFJlcXVpcmUgPSAobW9kOiBzdHJpbmcpID0+IHtcclxuICAgICAgICAvLyBGcmFtZXdvcmsgYWxpYXNlcyBhcmUgQUxXQVlTIGFsbG93ZWQsIGV2ZW4gaW4gc2FuZGJveFxyXG4gICAgICAgIGlmIChcclxuICAgICAgICAgICAgbW9kLnN0YXJ0c1dpdGgoXCJAdHNpeC9cIikgfHxcclxuICAgICAgICAgICAgbW9kLnN0YXJ0c1dpdGgoXCJAY29tbW9uL1wiKSB8fFxyXG4gICAgICAgICAgICBtb2QuaW5jbHVkZXMoXCIvbGliL1wiKSB8fFxyXG4gICAgICAgICAgICBtb2QuaW5jbHVkZXMoXCIvY29tbW9uL1wiKVxyXG4gICAgICAgICkge1xyXG4gICAgICAgICAgICByZXR1cm4gaGlqYWNrUmVxdWlyZShtb2QpO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgaWYgKGFsbG93ZWRNb2R1bGVzLmluY2x1ZGVzKG1vZCkpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGhvc3RSZXF1aXJlIShtb2QpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmb3JiaWRkZW4oYFNlY3VyaXR5IFZpb2xhdGlvbjogTW9kdWxlICcke21vZH0nIGlzIG5vdCBpbiB0aGUgcHJpdmlsZWdlZCBhbGxvdy1saXN0LmApO1xyXG4gICAgfTtcclxuXHJcbiAgICAvLyBTZW1idW55aWthbiByZXF1aXJlIGppa2EgYWRhICh0ZXJnYW50dW5nIG1vZHVsZSBsb2FkZXIpXHJcbiAgICBpZiAodHlwZW9mIHJlcXVpcmUgIT09IFwidW5kZWZpbmVkXCIpIHtcclxuICAgICAgICAoZ2xvYmFsIGFzIGFueSkucmVxdWlyZSA9IGlzUHJpdmlsZWdlZFxyXG4gICAgICAgICAgICA/IHByaXZpbGVnZWRSZXF1aXJlXHJcbiAgICAgICAgICAgIDogKG1vZDogc3RyaW5nKSA9PiB7XHJcbiAgICAgICAgICAgICAgICAgIC8vIEV2ZW4gaW4gc2FuZGJveCwgZnJhbWV3b3JrIGNvcmVzIE1VU1QgYmUgYWNjZXNzaWJsZVxyXG4gICAgICAgICAgICAgICAgICBpZiAoXHJcbiAgICAgICAgICAgICAgICAgICAgICBtb2Quc3RhcnRzV2l0aChcIkB0c2l4L1wiKSB8fFxyXG4gICAgICAgICAgICAgICAgICAgICAgbW9kLnN0YXJ0c1dpdGgoXCJAY29tbW9uL1wiKSB8fFxyXG4gICAgICAgICAgICAgICAgICAgICAgbW9kLmluY2x1ZGVzKFwiL2xpYi9cIikgfHxcclxuICAgICAgICAgICAgICAgICAgICAgIG1vZC5pbmNsdWRlcyhcIi9jb21tb24vXCIpXHJcbiAgICAgICAgICAgICAgICAgICkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGhpamFja1JlcXVpcmUobW9kKTtcclxuICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICBmb3JiaWRkZW4oKTtcclxuICAgICAgICAgICAgICB9O1xyXG4gICAgfVxyXG5cclxuICAgIC8vIEJhdGFzaSBha3NlcyBwcm9jZXNzIHlhbmcgc2Vuc2l0aWZcclxuICAgIGNvbnN0IHAgPSAoZ2xvYmFsIGFzIGFueSkucHJvY2VzcztcclxuICAgIGlmIChwKSB7XHJcbiAgICAgICAgcC5leGl0ID0gZm9yYmlkZGVuO1xyXG4gICAgICAgIHAua2lsbCA9IGZvcmJpZGRlbjtcclxuICAgICAgICAvLyBwLmVudiA9IHt9OyAvLyBUZW1wb3JhcmlseSBrZWVwIGVudiBmb3IgZGVidWdnaW5nIGlmIG5lZWRlZCwgb3IgY2xlYXIgaXRcclxuICAgIH1cclxufTtcclxuXHJcbi8vIHJlc3RyaWN0SG9zdEFQSSgpOyAvLyBEaXBpbmRhaGthbiBrZSBkYWxhbSBtYWluKClcclxuXHJcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cclxuXHJcbi8qKlxyXG4gKiBlbWl0V29ya2VyRXJyb3IoKTogQ2V0YWsgcGVzYW4gZXJyb3IgbG9hZC1wYXRoIGFwbGlrYXNpIGtlIFRUWSAoU1RET1VUKSxcclxuICogc2VoaW5nZ2EgdGVybGloYXQganVnYSBkaSBwaXhlbHRlcm0gLyBrb25zb2wgVFRZIChidWthbiBjdW1hIGhvc3Qgc3RkZXJyKS5cclxuICogRmlyZS1hbmQtZm9yZ2V0ICh0aWRhayBkaS1hd2FpdCkgc3VwYXlhIHRpZGFrIG1lbmd1YmFoIGFsdXIgbWFpbigpOyBmYWxsYmFja1xyXG4gKiBrZSBjb25zb2xlLmVycm9yIChob3N0IHN0ZGVycikgYmlsYSBwcmludCBrZSBUVFkgZ2FnYWwuXHJcbiAqL1xyXG5mdW5jdGlvbiBlbWl0V29ya2VyRXJyb3IobGliOiBhbnksIHBpZDogbnVtYmVyLCBtZXNzYWdlOiBzdHJpbmcpIHtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgaWYgKGxpYiAmJiBsaWIuc3RkICYmIHR5cGVvZiBsaWIuc3RkLnByaW50ID09PSBcImZ1bmN0aW9uXCIpIHtcclxuICAgICAgICAgICAgdm9pZCBsaWIuc3RkLnByaW50KGBcXHgxYlszMW1bV29ya2VyICR7cGlkfV1cXHgxYlswbSAke21lc3NhZ2V9XFxuYCkuY2F0Y2goKCkgPT4ge1xyXG4gICAgICAgICAgICAgICAgY29uc29sZS5lcnJvcihgW1dvcmtlciAke3BpZH1dICR7bWVzc2FnZX1gKTtcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICB9IGNhdGNoIChfKSB7XHJcbiAgICAgICAgLy8gZmFsbGJhY2sga2UgY29uc29sZS5lcnJvciBkaSBiYXdhaFxyXG4gICAgfVxyXG4gICAgY29uc29sZS5lcnJvcihgW1dvcmtlciAke3BpZH1dICR7bWVzc2FnZX1gKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIG5vdGlmeUxvYWRFcnJvcigpOiBLaXJpbSBHVUlfV0lORE9XX0VSUk9SIGtlIHBhcmVudCAmIFdpbmRvdyBNYW5hZ2VyIChBc3RlcmFjZWEpXHJcbiAqIHN1cGF5YSBlcnJvciBnYWdhbC1sb2FkIGFwbGlrYXNpIGp1Z2EgdGFtcGlsIHNlYmFnYWkgcG9wdXAgZGkgZGVza3RvcCBcdTIwMTQgdGVybWFzdWtcclxuICogc2FhdCBhcHAgZGlqYWxhbmthbiBkYXJpIGZpbGUtY3J1aXNlci90ZXJtaW5hbCAoZm9yZWlnbiBhcHApLiBQb2xhbnlhIHNhbWEgZGVuZ2FuXHJcbiAqIG5vdGlmeVBhcmVudFdpbmRvd0V2ZW50KCkgZGkgRW1lcmFsZDoga2lyaW0ga2UgcGFyZW50IGR1bHUsIGxhbHUga2UgV00gdmlhXHJcbiAqIC9vcHQvYXN0ZXJhY2VhL3dtLXBpZC4gRmlyZS1hbmQtZm9yZ2V0OyBrZWdhZ2FsYW4gcGVuZ2lyaW1hbiB0aWRhayBmYXRhbC5cclxuICovXHJcbmFzeW5jIGZ1bmN0aW9uIG5vdGlmeUxvYWRFcnJvcihsaWI6IGFueSwgcGlkOiBudW1iZXIsIGFwcE5hbWU6IHN0cmluZywgbWVzc2FnZTogc3RyaW5nKSB7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHRpbWVzdGFtcCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5yZXBsYWNlKFwiVFwiLCBcIiBcIikuc3Vic3RyaW5nKDAsIDE5KTtcclxuICAgICAgICBjb25zdCBwYXlsb2FkID0ge1xyXG4gICAgICAgICAgICB0eXBlOiBcIkdVSV9XSU5ET1dfRVJST1JcIixcclxuICAgICAgICAgICAgd2lkOiBcIlwiLFxyXG4gICAgICAgICAgICBwaWQsXHJcbiAgICAgICAgICAgIGZpbGU6IGFwcE5hbWUsXHJcbiAgICAgICAgICAgIGVycm9yOiBtZXNzYWdlLFxyXG4gICAgICAgICAgICBjb250ZXh0OiBcImxvYWRcIixcclxuICAgICAgICAgICAgdGltZXN0YW1wLFxyXG4gICAgICAgIH07XHJcblxyXG4gICAgICAgIC8vIDEuIEtpcmltIGtlIHBhcmVudCBwcm9jZXNzIChiaXNhIFdNIGJpbGEgYXBwIGRpLWxhdW5jaCBkYXJpIGxhdW5jaGVyKVxyXG4gICAgICAgIGNvbnN0IHBhcmVudFBpZCA9IGF3YWl0IGxpYi5nZXRQYXJlbnRQaWQoKTtcclxuICAgICAgICBpZiAocGFyZW50UGlkKSB7XHJcbiAgICAgICAgICAgIGF3YWl0IGxpYi5zaGVsbC5zZW5kKHBhcmVudFBpZCwgcGF5bG9hZCk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICAvLyAyLiBLaXJpbSBqdWdhIGtlIEFzdGVyYWNlYSBXTSBcdTIwMTQgdW50dWsgYXBwIHlhbmcgZGktcnVuIHZpYVxyXG4gICAgICAgIC8vICAgIGZpbGUtY3J1aXNlci90ZXJtaW5hbCAoZm9yZWlnbiBhcHApLiBCYWNhIFBJRCBXTSBkYXJpIHdtLXBpZCBmaWxlLlxyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHdtUGlkUmF3ID0gYXdhaXQgbGliLmZzLnJlYWRGaWxlKFwiL29wdC9hc3RlcmFjZWEvd20tcGlkXCIpO1xyXG4gICAgICAgICAgICBpZiAod21QaWRSYXcpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHdtUGlkID0gcGFyc2VJbnQoU3RyaW5nKHdtUGlkUmF3KS50cmltKCkpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgbXlQaWQgPSBsaWIuZ2V0UGlkKCk7XHJcbiAgICAgICAgICAgICAgICBpZiAod21QaWQgJiYgd21QaWQgIT09IG15UGlkICYmIHdtUGlkICE9PSBwYXJlbnRQaWQpIHtcclxuICAgICAgICAgICAgICAgICAgICBhd2FpdCBsaWIuc2hlbGwuc2VuZCh3bVBpZCwgcGF5bG9hZCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGNhdGNoIChfKSB7XHJcbiAgICAgICAgICAgIC8vIEFzdGVyYWNlYSB0aWRhayBiZXJqYWxhbiBcdTIwMTQgbm8tb3BcclxuICAgICAgICB9XHJcbiAgICB9IGNhdGNoIChfKSB7XHJcbiAgICAgICAgLy8gTm90aWZpa2FzaSBnYWdhbCBcdTIwMTQgbm9uLWZhdGFsXHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIG1haW4oKSB7XHJcbiAgICBjb25zdCBkYXRhID0gd29ya2VyRGF0YSBhcyBXb3JrZXJJbml0RGF0YTtcclxuICAgIGNvbnN0IHsgcGlkLCBhcHBOYW1lLCBhcmdzLCBhcHBQYXRoIH0gPSBkYXRhO1xyXG5cclxuICAgIC8vIExvYWQgVXNlckxpYiBkaW5hbWlzIGRhcmkgVkZTIENhY2hlIChNZW1vcnkgRXhlY3V0aW9uKVxyXG4gICAgY29uc3QgVXNlckxpYk1vZCA9IGhpamFja1JlcXVpcmUoXCJAdHNpeC9Vc2VyTGliXCIpO1xyXG4gICAgY29uc3QgVXNlckxpYkNsYXNzID0gVXNlckxpYk1vZC5Vc2VyTGliO1xyXG5cclxuICAgIGlmICghVXNlckxpYkNsYXNzKSB7XHJcbiAgICAgICAgY29uc29sZS5lcnJvcihgW1dvcmtlciAke3BpZH1dIENSSVRJQ0FMIEVSUk9SOiBGYWlsZWQgdG8gbG9hZCBVc2VyTGliIGZyb20gVkZTIE1lbW9yeSBDYWNoZSFgKTtcclxuICAgICAgICByZWFsRXhpdCgxKTtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCBsaWIgPSBuZXcgVXNlckxpYkNsYXNzKHBpZCk7XHJcbiAgICAoZ2xvYmFsIGFzIGFueSkuX3RzaXhMaWIgPSBsaWI7IC8vIFJlZ2lzdGVyIGZvciBleHBsaWNpdCBpbXBvcnRzICh2Mi4xKVxyXG5cclxuICAgIC8vIEpTLURpcmVjdCBwYXRoIHNob3VsZCBOT1QgaGF2ZSAtciBpbiBleGVjQXJndlxyXG4gICAgY29uc3QgaXNKc0RpcmVjdCA9ICFwcm9jZXNzLmV4ZWNBcmd2LnNvbWUoKGFyZykgPT4gYXJnLmluY2x1ZGVzKFwiLXJcIikpO1xyXG5cclxuICAgIC8vIDIuIENhcmkgYXBsaWthc2lueWFcclxuICAgIGNvbnN0IHRhcmdldEtleSA9IGFwcE5hbWUudHJpbSgpO1xyXG4gICAgbGV0IEFwcENsYXNzOiBhbnkgPSBudWxsO1xyXG4gICAgbGV0IGZpbmFsQXBwUGF0aCA9IGFwcFBhdGg7XHJcbiAgICAvLyBSZWFzb24gdGhlIGxvYWQgZmFpbGVkICh0cmFuc3BpbGUvZXhlY3V0aW9uKSBcdTIwMTQgdXNlZCBmb3IgYSBtb3JlIGhvbmVzdFxyXG4gICAgLy8gZmluYWwgbWVzc2FnZSBpbnN0ZWFkIG9mIHRoZSBtaXNsZWFkaW5nIFwiQXBwbGljYXRpb24gbm90IGZvdW5kXCIuXHJcbiAgICBsZXQgbG9hZEZhaWx1cmU6IHN0cmluZyB8IG51bGwgPSBudWxsO1xyXG4gICAgLy8gRGV0YWlsIGVycm9yIGFzbGlueWEgKHBlc2FuIGVzYnVpbGQvcnVudGltZSkgXHUyMDE0IGRpcGFrYWkgdW50dWsgcG9wdXAgZGVza3RvcFxyXG4gICAgLy8gYmlhciBzcGVzaWZpaywgYnVrYW4gc2VrYWRhciBrYXRlZ29yaSBcInRyYW5zcGlsZSBmYWlsZWRcIi5cclxuICAgIGxldCBsb2FkRXJyb3JEZXRhaWw6IHN0cmluZyB8IG51bGwgPSBudWxsO1xyXG5cclxuICAgIC8vIC0tLSBTVFJBVEVHSSBCQVJVOiBEaXJlY3QgTWVtb3J5IEV4ZWN1dGlvbiAoVGFucGEgLnZmc19jYWNoZSkgLS0tXHJcbiAgICBpZiAoIWZpbmFsQXBwUGF0aCAmJiAoZGF0YSBhcyBhbnkpLmFwcENvbnRlbnQgJiYgTW9kdWxlKSB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgbGV0IGNvbnRlbnQgPSAoZGF0YSBhcyBhbnkpLmFwcENvbnRlbnQ7XHJcbiAgICAgICAgICAgIGNvbnN0IGlzVHlwZVNjcmlwdCA9ICEoYXBwUGF0aCB8fCBhcHBOYW1lIHx8IFwiXCIpLnRvTG93ZXJDYXNlKCkuZW5kc1dpdGgoXCIuanNcIik7XHJcbiAgICAgICAgICAgIC8vIE1vZHVsZSBmaWxlbmFtZSBIQVJVUyBwaHlzaWNhbCBwYXRoIHVudHVrIHJlcXVpcmUoKSBuZW11IG5vZGVfbW9kdWxlc1xyXG4gICAgICAgICAgICBjb25zdCBtb2R1bGVGaWxlbmFtZSA9IHBhdGghLmpvaW4ocHJvY2Vzcy5jd2QoKSwgYXBwTmFtZSArIFwiLmpzXCIpO1xyXG4gICAgICAgICAgICAvLyBTdGFjayBmaWxlbmFtZSA9IEJLRlMgcGF0aCBiaWFyIHN0YWNrIHRyYWNlIGJlbmVyICgvb3B0L3Rlc3QvZ3VpLXRlc3QuanMpXHJcbiAgICAgICAgICAgIC8vIHN0YWNrQmtmc1BhdGggPSBCS0ZTIHBhdGggdW50dWsgc3RhY2sgdHJhY2UgKC9vcHQvdGVzdC9ndWktdGVzdC5qcylcclxuICAgICAgICAgICAgY29uc3Qgc3RhY2tCa2ZzUGF0aCA9IChkYXRhIGFzIGFueSkuc3RhY2tCa2ZzUGF0aDtcclxuICAgICAgICAgICAgY29uc3Qgc3RhY2tGaWxlbmFtZSA9IHN0YWNrQmtmc1BhdGggPyBzdGFja0JrZnNQYXRoLnJlcGxhY2UoL1xcLnRzJC8sIFwiLmpzXCIpIDogbW9kdWxlRmlsZW5hbWU7XHJcbiAgICAgICAgICAgIC8vIHNvdXJjZWZpbGUgdW50dWsgZXNidWlsZCBzb3VyY2VtYXAgXHUyMDE0IGN1a3VwIG5hbWEgZmlsZSBhamEgKHRhbnBhIHBhdGgpXHJcbiAgICAgICAgICAgIGNvbnN0IHNvdXJjZUZpbGVOYW1lID0gKHN0YWNrQmtmc1BhdGggfHwgbW9kdWxlRmlsZW5hbWUpLnNwbGl0KC9bXFxcXC9dLykucG9wKCkhLnJlcGxhY2UoL1xcLmpzJC8sIFwiLnRzXCIpO1xyXG5cclxuICAgICAgICAgICAgLy8gLS0tIE1PRFVMIFJFTEFUSUYgUFJPR1JBTSAoLi94LCAuLi95KSAtLS1cclxuICAgICAgICAgICAgLy9cclxuICAgICAgICAgICAgLy8gRGlrdW1wdWxrYW4gU0VLQVJBTkcgKG1haW4oKSBhc3luYykga2FyZW5hIGBNb2R1bGUuX2xvYWRgIHNpbmtyb25cclxuICAgICAgICAgICAgLy8gc2VkYW5na2FuIGJhY2EgVkZTIGxld2F0IHN5c2NhbGwgYXNpbmtyb246IGhvb2sgcmVxdWlyZSB0aWRhayBtdW5na2luXHJcbiAgICAgICAgICAgIC8vIG1lbWJhY2EgZmlsZSBzZW5kaXJpLiBUYW5wYSBsYW5na2FoIGluaSwgYHJlcXVpcmUoXCIuL1Rwa2dQcm90b2NvbFwiKWBcclxuICAgICAgICAgICAgLy8gbWVuY2FyaSBmaWxlIGl0dSBkaSBIT1NUIGZpbGVzeXN0ZW0gZGFuIGdhZ2FsLlxyXG4gICAgICAgICAgICBpZiAoc3RhY2tCa2ZzUGF0aCkge1xyXG4gICAgICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBlc2J1aWxkTW9kID0gaG9zdFJlcXVpcmUhKFwiZXNidWlsZFwiKTtcclxuICAgICAgICAgICAgICAgICAgICBwcm9ncmFtTW9kdWxlcyA9IGF3YWl0IGNvbGxlY3RSZWxhdGl2ZU1vZHVsZXMoe1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRyeUlkOiBzdGFja0JrZnNQYXRoLnJlcGxhY2UoL1xcLih0c3xqcykkL2ksIFwiXCIpLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBzb3VyY2U6IGNvbnRlbnQsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIElzaSBWRlMgPSBCWVRFOyBtb2R1bCByZWxhdGlmIGRpa29tcGlsYXNpIHNlYmFnYWkgVEVLUy5cclxuICAgICAgICAgICAgICAgICAgICAgICAgcmVhZEZpbGU6IGFzeW5jICh2ZnNQYXRoOiBzdHJpbmcpID0+IHZmc0J5dGVzVG9VdGY4KGF3YWl0IGxpYi5mcy5yZWFkRmlsZSh2ZnNQYXRoKSksXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRyYW5zcGlsZTogKHNyYzogc3RyaW5nLCBtb2R1bGVJZDogc3RyaW5nKSA9PlxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXNidWlsZE1vZC50cmFuc2Zvcm1TeW5jKHNyYywge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxvYWRlcjogXCJ0c1wiLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvcm1hdDogXCJjanNcIixcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YXJnZXQ6IFwibm9kZTE4XCIsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc291cmNlbWFwOiBcImlubGluZVwiLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNvdXJjZWZpbGU6IG1vZHVsZUlkLnNwbGl0KFwiL1wiKS5wb3AoKSArIFwiLnRzXCIsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KS5jb2RlLFxyXG4gICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgfSBjYXRjaCAoZTogYW55KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgLy8gTm9uLWZhdGFsOiBpbXBvcnQgcmVsYXRpZiBha2FuIGdhZ2FsIGRlbmdhbiBwZXNhbiBOb2RlIGJpYXNhLlxyXG4gICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYFtXb3JrZXIgJHtwaWR9XSBMb2NhbCBtb2R1bGUgc2NhbiBmYWlsZWQ6ICR7ZS5tZXNzYWdlfWApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICAvLyBKaWthIGNvbnRlbnQgYWRhbGFoIFR5cGVTY3JpcHQsIHRyYW5zcGlsZSBkdWx1IGtlIEphdmFTY3JpcHRcclxuICAgICAgICAgICAgaWYgKGlzVHlwZVNjcmlwdCkge1xyXG4gICAgICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBlc2J1aWxkID0gaG9zdFJlcXVpcmUhKFwiZXNidWlsZFwiKTtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCByZXN1bHQgPSBlc2J1aWxkLnRyYW5zZm9ybVN5bmMoY29udGVudCwge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBsb2FkZXI6IFwidHNcIixcclxuICAgICAgICAgICAgICAgICAgICAgICAgZm9ybWF0OiBcImNqc1wiLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0YXJnZXQ6IFwibm9kZTE4XCIsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHNvdXJjZW1hcDogXCJpbmxpbmVcIixcclxuICAgICAgICAgICAgICAgICAgICAgICAgc291cmNlZmlsZTogc291cmNlRmlsZU5hbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgICAgICAgICAgY29udGVudCA9IHJlc3VsdC5jb2RlO1xyXG4gICAgICAgICAgICAgICAgfSBjYXRjaCAodHJhbnNwaWxlRXJyOiBhbnkpIHtcclxuICAgICAgICAgICAgICAgICAgICBsb2FkRmFpbHVyZSA9IFwidHJhbnNwaWxlIGZhaWxlZFwiO1xyXG4gICAgICAgICAgICAgICAgICAgIGxvYWRFcnJvckRldGFpbCA9IGBUUyBUcmFuc3BpbGUgRXJyb3I6ICR7dHJhbnNwaWxlRXJyLm1lc3NhZ2V9YDtcclxuICAgICAgICAgICAgICAgICAgICBlbWl0V29ya2VyRXJyb3IobGliLCBwaWQsIGBUUyBUcmFuc3BpbGUgRXJyb3I6ICR7dHJhbnNwaWxlRXJyLm1lc3NhZ2V9YCk7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgdHJhbnNwaWxlRXJyO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICAvLyBDcmVhdGUgYSBuZXcgbW9kdWxlIGluc3RhbmNlIHdpdGggcGh5c2ljYWwgcGF0aCAoZm9yIG5vZGVfbW9kdWxlcyByZXNvbHV0aW9uKVxyXG4gICAgICAgICAgICBjb25zdCBhcHBNb2R1bGUgPSBuZXcgTW9kdWxlKG1vZHVsZUZpbGVuYW1lLCBtb2R1bGUucGFyZW50KTtcclxuICAgICAgICAgICAgYXBwTW9kdWxlLmZpbGVuYW1lID0gc3RhY2tGaWxlbmFtZTsgLy8gX19maWxlbmFtZSBzaG93cyBCS0ZTIHBhdGhcclxuICAgICAgICAgICAgYXBwTW9kdWxlLnBhdGhzID0gTW9kdWxlLl9ub2RlTW9kdWxlUGF0aHMocGF0aCEuZGlybmFtZShtb2R1bGVGaWxlbmFtZSkpO1xyXG5cclxuICAgICAgICAgICAgLy8gX2NvbXBpbGUgZGVuZ2FuIHN0YWNrRmlsZW5hbWUgYWdhciBzdGFjayB0cmFjZSBudW5qdWsgQktGUyBwYXRoXHJcbiAgICAgICAgICAgIChhcHBNb2R1bGUgYXMgYW55KS5fY29tcGlsZShjb250ZW50LCBzdGFja0ZpbGVuYW1lKTtcclxuXHJcbiAgICAgICAgICAgIEFwcENsYXNzID1cclxuICAgICAgICAgICAgICAgIGFwcE1vZHVsZS5leHBvcnRzLm1haW4gfHwgYXBwTW9kdWxlLmV4cG9ydHMuTWFpbiB8fCBhcHBNb2R1bGUuZXhwb3J0cy5kZWZhdWx0IHx8IGFwcE1vZHVsZS5leHBvcnRzO1xyXG5cclxuICAgICAgICAgICAgLy8gSmlrYSBtYXNpaCBiZWx1bSBrZXRlbXUgKGUuZy4gZXhwb3J0IGNsYXNzIGJ1a2FuIGRlZmF1bHQvbWFpbilcclxuICAgICAgICAgICAgaWYgKHR5cGVvZiBBcHBDbGFzcyAhPT0gXCJmdW5jdGlvblwiKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBlbnRyaWVzID0gT2JqZWN0LmVudHJpZXMoYXBwTW9kdWxlLmV4cG9ydHMpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgZm91bmQgPSBlbnRyaWVzLmZpbmQoKFtfLCB2YWxdOiBbc3RyaW5nLCBhbnldKSA9PiB0eXBlb2YgdmFsID09PSBcImZ1bmN0aW9uXCIpO1xyXG4gICAgICAgICAgICAgICAgaWYgKGZvdW5kKSBBcHBDbGFzcyA9IGZvdW5kWzFdO1xyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICBpZiAoQXBwQ2xhc3MpIHtcclxuICAgICAgICAgICAgICAgIC8vIGNvbnNvbGUubG9nKGBbV29ya2VyICR7cGlkfV0gRGlyZWN0IE1lbW9yeSBFeGVjdXRpb24gc3VjY2VzcyBmb3IgJHthcHBOYW1lfWApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyOiBhbnkpIHtcclxuICAgICAgICAgICAgaWYgKCFsb2FkRmFpbHVyZSkgbG9hZEZhaWx1cmUgPSBcImRpcmVjdCBleGVjdXRpb24gZmFpbGVkXCI7XHJcbiAgICAgICAgICAgIGlmICghbG9hZEVycm9yRGV0YWlsKSBsb2FkRXJyb3JEZXRhaWwgPSBgRGlyZWN0IEV4ZWN1dGlvbiBFcnJvcjogJHtlcnIubWVzc2FnZX1gO1xyXG4gICAgICAgICAgICBlbWl0V29ya2VyRXJyb3IobGliLCBwaWQsIGBEaXJlY3QgRXhlY3V0aW9uIEVycm9yOiAke2Vyci5tZXNzYWdlfWApO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBpZiAoZmluYWxBcHBQYXRoICYmIGhvc3RSZXF1aXJlKSB7XHJcbiAgICAgICAgLy8gU1RSQVRFR0kgQkFSVTogRHluYW1pYyBMb2FkaW5nIGRhcmkgRmlsZSBGaXNpayAoTGludXgtbGlrZSlcclxuICAgICAgICAvLyBTVFJBVEVHSTogRHluYW1pYyBMb2FkaW5nIGRhcmkgRmlsZSBGaXNpayAoSnVqdXIgUGFrZSAudHMpXHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgbW9kdWxlID0gaG9zdFJlcXVpcmUoZmluYWxBcHBQYXRoKTtcclxuICAgICAgICAgICAgY29uc3QgZW50cmllcyA9IE9iamVjdC5lbnRyaWVzKG1vZHVsZSk7XHJcblxyXG4gICAgICAgICAgICAvLyBbREVCVUddIENoZWNrIHdoYXQgd2UgZm91bmRcclxuICAgICAgICAgICAgLy8gY29uc29sZS5sb2coYFtXb3JrZXIgJHtwaWR9XSBMb2FkZWQgbW9kdWxlIGZvciAke2FwcE5hbWV9LiBLZXlzOiAke09iamVjdC5rZXlzKG1vZHVsZSkuam9pbihcIiwgXCIpfWApO1xyXG5cclxuICAgICAgICAgICAgLy8gU1RSQVRFR0kgU1RBTkRBUjogQ2FyaSBleHBvcnQgYmVybmFtYSAnbWFpbidcclxuICAgICAgICAgICAgaWYgKG1vZHVsZS5tYWluKSB7XHJcbiAgICAgICAgICAgICAgICBBcHBDbGFzcyA9IG1vZHVsZS5tYWluO1xyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKG1vZHVsZS5NYWluKSB7XHJcbiAgICAgICAgICAgICAgICBBcHBDbGFzcyA9IG1vZHVsZS5NYWluO1xyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKG1vZHVsZS5kZWZhdWx0KSB7XHJcbiAgICAgICAgICAgICAgICBBcHBDbGFzcyA9IG1vZHVsZS5kZWZhdWx0O1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgLy8gRmFsbGJhY2s6IEFtYmlsIGV4cG9ydCBwZXJ0YW1hIHlhbmcgYmVydXBhIGNsYXNzL2Z1bmN0aW9uXHJcbiAgICAgICAgICAgICAgICBjb25zdCBmb3VuZCA9IGVudHJpZXMuZmluZCgoW18sIHZhbF06IFtzdHJpbmcsIGFueV0pID0+IHR5cGVvZiB2YWwgPT09IFwiZnVuY3Rpb25cIik7XHJcbiAgICAgICAgICAgICAgICBpZiAoZm91bmQpIEFwcENsYXNzID0gZm91bmRbMV07XHJcbiAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgIGlmIChBcHBDbGFzcykge1xyXG4gICAgICAgICAgICAgICAgLy8gY29uc29sZS5sb2coYFtXb3JrZXIgJHtwaWR9XSBJZGVudGlmaWVkIEFwcENsYXNzIGZvciAke2FwcE5hbWV9YCk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBsb2FkRmFpbHVyZSA9IFwibm8gdmFsaWQgJ21haW4nIGV4cG9ydCBmb3VuZFwiO1xyXG4gICAgICAgICAgICAgICAgbG9hZEVycm9yRGV0YWlsID0gYEZhaWxlZCB0byBpZGVudGlmeSBBcHBDbGFzcyBmb3IgJHthcHBOYW1lfS4gTW9kdWxlIGV4cG9ydHM6ICR7T2JqZWN0LmtleXMobW9kdWxlKS5qb2luKFwiLCBcIil9YDtcclxuICAgICAgICAgICAgICAgIGVtaXRXb3JrZXJFcnJvcihcclxuICAgICAgICAgICAgICAgICAgICBsaWIsXHJcbiAgICAgICAgICAgICAgICAgICAgcGlkLFxyXG4gICAgICAgICAgICAgICAgICAgIGBGYWlsZWQgdG8gaWRlbnRpZnkgQXBwQ2xhc3MgZm9yICR7YXBwTmFtZX0uIE1vZHVsZSBleHBvcnRzOiAke09iamVjdC5rZXlzKG1vZHVsZSkuam9pbihcIiwgXCIpfWAsXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyOiBhbnkpIHtcclxuICAgICAgICAgICAgbG9hZEZhaWx1cmUgPSBcImZhaWxlZCB0byBsb2FkIG1vZHVsZVwiO1xyXG4gICAgICAgICAgICBsb2FkRXJyb3JEZXRhaWwgPSBgUnVudGltZSBFcnJvcjogRmFpbGVkIHRvIHJlcXVpcmUgJHtmaW5hbEFwcFBhdGggfHwgYXBwTmFtZX06ICR7ZXJyLm1lc3NhZ2V9YDtcclxuICAgICAgICAgICAgZW1pdFdvcmtlckVycm9yKGxpYiwgcGlkLCBgUnVudGltZSBFcnJvcjogRmFpbGVkIHRvIHJlcXVpcmUgJHtmaW5hbEFwcFBhdGggfHwgYXBwTmFtZX06ICR7ZXJyLm1lc3NhZ2V9YCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIGlmICghQXBwQ2xhc3MpIHtcclxuICAgICAgICBpZiAocGFyZW50UG9ydCkge1xyXG4gICAgICAgICAgICBjb25zdCBlcnJvck1zZyA9IGxvYWRGYWlsdXJlXHJcbiAgICAgICAgICAgICAgICA/IGAtYmFzaDogJHthcHBOYW1lfTogRmFpbGVkIHRvIGxvYWQgXHUyMDE0ICR7bG9hZEZhaWx1cmV9XFxuYFxyXG4gICAgICAgICAgICAgICAgOiBgLWJhc2g6ICR7YXBwTmFtZX06IEFwcGxpY2F0aW9uIG5vdCBmb3VuZCAoUGF0aDogJHthcHBQYXRoIHx8IFwiVkZTLU9ubHlcIn0pXFxuYDtcclxuICAgICAgICAgICAgYXdhaXQgbGliLnN0ZC5wcmludChlcnJvck1zZyk7XHJcbiAgICAgICAgICAgIHBhcmVudFBvcnQucG9zdE1lc3NhZ2Uoe1xyXG4gICAgICAgICAgICAgICAgc3VjY2VzczogZmFsc2UsXHJcbiAgICAgICAgICAgICAgICBlcnJvcjogZXJyb3JNc2cudHJpbSgpLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgLy8gVGFtcGlsa2FuIGp1Z2EgZGkgZGVza3RvcCAoV00vQXN0ZXJhY2VhKSB2aWEgR1VJX1dJTkRPV19FUlJPUi5cclxuICAgICAgICAgICAgLy8gV0FKSUIgZGktYXdhaXQ6IHJlYWxFeGl0KDEpIGRpIGJhd2FoIGxhbmdzdW5nIG1lbWF0aWthbiB3b3JrZXIsIGRhblxyXG4gICAgICAgICAgICAvLyBrYWxhdSBmaXJlLWFuZC1mb3JnZXQsIGtpcmltYW4gYXN5bmMtbnlhIHRhayBzZW1wYXQgc2VsZXNhaS5cclxuICAgICAgICAgICAgLy8gUG9wdXAgcGFrYWkgZGV0YWlsIGVycm9yIGFzbGkgKGxvYWRFcnJvckRldGFpbCkgYmlhciBzcGVzaWZpay5cclxuICAgICAgICAgICAgYXdhaXQgbm90aWZ5TG9hZEVycm9yKGxpYiwgcGlkLCBhcHBOYW1lLCBsb2FkRXJyb3JEZXRhaWwgfHwgZXJyb3JNc2cudHJpbSgpKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmVhbEV4aXQoMSk7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gMy4gQUtUSUZLQU4gU0FOREJPWCAoS3VuY2kgcGludHUgc2ViZWx1bSBhcGxpa2FzaSBiZXJqYWxhbilcclxuICAgIHJlc3RyaWN0SG9zdEFQSShhcHBOYW1lKTtcclxuXHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IGFwcCA9IG5ldyBBcHBDbGFzcygpO1xyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGFwcC5leGVjdXRlKGxpYiBhcyBhbnksIGFyZ3MpO1xyXG5cclxuICAgICAgICAvLyAzLiBKaWthIGFwbGlrYXNpIG1lLXJldHVybiBzdHJpbmcsIGNldGFrIGtlIGxheWFyIHZpYSBQUklOVCBzeXNjYWxsXHJcbiAgICAgICAgaWYgKHJlc3VsdCAmJiB0eXBlb2YgcmVzdWx0ID09PSBcInN0cmluZ1wiICYmIHJlc3VsdC50cmltKCkgIT09IFwiXCIpIHtcclxuICAgICAgICAgICAgYXdhaXQgbGliLnN0ZC5wcmludChyZXN1bHQgKyBcIlxcblwiKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8vIDQuIEJlcml0YWh1IEtlcm5lbCBiYWh3YSBwcm9zZXMgc2VsZXNhaVxyXG4gICAgICAgIGF3YWl0IGxpYi5zaGVsbC5leGl0KDApO1xyXG4gICAgfSBjYXRjaCAoZXJyb3I6IGFueSkge1xyXG4gICAgICAgIC8vIExhcG9ya2FuIGVycm9yIGtlIHBhcmVudCAoV00pIHZpYSBJUENcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBwYXJlbnRQaWQgPSBhd2FpdCBsaWIuZ2V0UGFyZW50UGlkKCk7XHJcbiAgICAgICAgICAgIGlmIChwYXJlbnRQaWQpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IGxpYi5zaGVsbC5zZW5kKHBhcmVudFBpZCwge1xyXG4gICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiR1VJX1dJTkRPV19FUlJPUlwiLFxyXG4gICAgICAgICAgICAgICAgICAgIHdpZDogXCJcIixcclxuICAgICAgICAgICAgICAgICAgICBwaWQ6IGxpYi5nZXRQaWQoKSxcclxuICAgICAgICAgICAgICAgICAgICBmaWxlOiBhcHBOYW1lIHx8IFwiXCIsXHJcbiAgICAgICAgICAgICAgICAgICAgZXJyb3I6IGBSdW50aW1lIEVycm9yOiAke2Vycm9yLm1lc3NhZ2V9YCxcclxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0OiBcInJ1bnRpbWVcIixcclxuICAgICAgICAgICAgICAgICAgICB0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5yZXBsYWNlKFwiVFwiLCBcIiBcIikuc3Vic3RyaW5nKDAsIDE5KSxcclxuICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBjYXRjaCAoXykge1xyXG4gICAgICAgICAgICAvKiBJUEMgc2VuZCBmYWlsdXJlIGlzIG5vbi1mYXRhbCAqL1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgLy8gSnVnYSBjb2JhIGxld2F0IHN0ZC5lcnJvciB5YW5nIHB1bnlhIG1la2FuaXNtZSBsZWJpaCBsZW5na2FwXHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgYXdhaXQgbGliLnN0ZC5lcnJvcihlcnJvci5tZXNzYWdlIHx8IFN0cmluZyhlcnJvciksIGFwcE5hbWUgfHwgXCJhcHBcIik7XHJcbiAgICAgICAgfSBjYXRjaCAoXykge31cclxuXHJcbiAgICAgICAgLy8gTGFwb3JrYW4gZXJyb3Iga2UgVFRZIGNvbnNvbGVcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBhd2FpdCBsaWIuc3RkLnByaW50KGBcXG5bV29ya2VyICR7cGlkfV0gUnVudGltZSBFcnJvcjogJHtlcnJvci5tZXNzYWdlfVxcbmApO1xyXG4gICAgICAgIH0gY2F0Y2ggKGUpIHt9XHJcbiAgICAgICAgcmVhbEV4aXQoMSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbm1haW4oKTtcclxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsNEJBQXVDO0FBRXZDLCtCQUEyRDtBQUMzRCxxQkFBK0I7QUFZL0IsTUFBTSxXQUFXLFFBQVEsS0FBSyxLQUFLLE9BQU87QUFLMUMsTUFBTSxjQUFjLE9BQU8sWUFBWSxjQUFjLFVBQVU7QUFDL0QsTUFBTSxPQUFPLGNBQWMsWUFBWSxNQUFNLElBQUk7QUFDakQsTUFBTSxTQUFTLGNBQWMsWUFBWSxRQUFRLElBQUk7QUFtQnJELFNBQVMsd0JBQXdCLFVBQWtCLFNBQXlCO0FBQ3hFLFFBQU0sUUFBUSxTQUFTLE1BQU0sR0FBRztBQUNoQyxRQUFNLElBQUk7QUFDVixhQUFXLE9BQU8sUUFBUSxNQUFNLEdBQUcsR0FBRztBQUNsQyxRQUFJLFFBQVEsTUFBTSxRQUFRLElBQUs7QUFDL0IsUUFBSSxRQUFRLE1BQU07QUFFZCxVQUFJLE1BQU0sU0FBUyxFQUFHLE9BQU0sSUFBSTtBQUNoQztBQUFBLElBQ0o7QUFDQSxVQUFNLEtBQUssR0FBRztBQUFBLEVBQ2xCO0FBQ0EsU0FBTyxNQUFNLEtBQUssR0FBRztBQUN6QjtBQVlBLElBQUksaUJBQXlDLENBQUM7QUFFOUMsSUFBSSxVQUFVLE1BQU07QUFDaEIsUUFBTSxlQUFlLE9BQU87QUFDNUIsUUFBTSxXQUFZLGlD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VUFBVSxPQUFPLGtDQUFrQyxXQUFXLFVBQVU7QUFBQTtBQUM5RSxZQUFNLElBQUksSUFBSSxNQUFNLFFBQVE7QUFDNUIsdUNBQVcsWUFBWTtBQUFBLFFBQ25CLFNBQVM7QUFBQSxRQUNULE9BQU8sU0FBUyxLQUFLO0FBQUEsTUFDekIsQ0FBQztBQUtELFlBQU0sZ0JBQWdCLEtBQUssS0FBSyxTQUFTLG1CQUFtQixTQUFTLEtBQUssQ0FBQztBQUFBLElBQy9FO0FBQ0EsYUFBUyxDQUFDO0FBQUEsRUFDZDtBQUdBLGtCQUFnQixPQUFPO0FBRXZCLE1BQUk7QUFDQSxVQUFNLE1BQU0sSUFBSSxTQUFTO0FBQ3pCLFVBQU0sU0FBUyxNQUFNLElBQUksUUFBUSxLQUFZLElBQUk7QUFHakQsUUFBSSxVQUFVLE9BQU8sV0FBVyxZQUFZLE9BQU8sS0FBSyxNQUFNLElBQUk7QUFDOUQsWUFBTSxJQUFJLElBQUksTUFBTSxTQUFTLElBQUk7QUFBQSxJQUNyQztBQUdBLFVBQU0sSUFBSSxNQUFNLEtBQUssQ0FBQztBQUFBLEVBQzFCLFNBQVMsT0FBWTtBQUVqQixRQUFJO0FBQ0EsWUFBTSxZQUFZLE1BQU0sSUFBSSxhQUFhO0FBQ3pDLFVBQUksV0FBVztBQUNYLGNBQU0sSUFBSSxNQUFNLEtBQUssV0FBVztBQUFBLFVBQzVCLE1BQU07QUFBQSxVQUNOLEtBQUs7QUFBQSxVQUNMLEtBQUssSUFBSSxPQUFPO0FBQUEsVUFDaEIsTUFBTSxXQUFXO0FBQUEsVUFDakIsT0FBTyxrQkFBa0IsTUFBTSxPQUFPO0FBQUEsVUFDdEMsU0FBUztBQUFBLFVBQ1QsWUFBVyxvQkFBSSxLQUFLLEdBQUUsWUFBWSxFQUFFLFFBQVEsS0FBSyxHQUFHLEVBQUUsVUFBVSxHQUFHLEVBQUU7QUFBQSxRQUN6RSxDQUFDO0FBQUEsTUFDTDtBQUFBLElBQ0osU0FBUyxHQUFHO0FBQUEsSUFFWjtBQUdBLFFBQUk7QUFDQSxZQUFNLElBQUksSUFBSSxNQUFNLE1BQU0sV0FBVyxPQUFPLEtBQUssR0FBRyxXQUFXLEtBQUs7QUFBQSxJQUN4RSxTQUFTLEdBQUc7QUFBQSxJQUFDO0FBR2IsUUFBSTtBQUNBLFlBQU0sSUFBSSxJQUFJLE1BQU07QUFBQSxVQUFhLEdBQUcsb0JBQW9CLE1BQU0sT0FBTztBQUFBLENBQUk7QUFBQSxJQUM3RSxTQUFTLEdBQUc7QUFBQSxJQUFDO0FBQ2IsYUFBUyxDQUFDO0FBQUEsRUFDZDtBQUNKO0FBRUEsS0FBSzsiLAogICJuYW1lcyI6IFsibW9kdWxlIl0KfQo=
