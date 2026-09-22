var import_worker_threads = require("worker_threads");
var import_VfsModuleResolver = require("./VfsModuleResolver");
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
            readFile: (vfsPath) => lib.fs.readFile(vfsPath),
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
        emitWorkerError(lib, pid, `Failed to identify AppClass for ${appName}. Module exports: ${Object.keys(module2).join(", ")}`);
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiV29ya2VyRW50cnkudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IHdvcmtlckRhdGEsIHBhcmVudFBvcnQgfSBmcm9tIFwid29ya2VyX3RocmVhZHNcIjtcclxuaW1wb3J0IHsgV29ya2VySW5pdERhdGEsIFN5c2NhbGxSZXNwb25zZSB9IGZyb20gXCIuLi9jb21tb24vSVBDVHlwZXNcIjtcclxuaW1wb3J0IHsgY29sbGVjdFJlbGF0aXZlTW9kdWxlcywgcmVzb2x2ZVZmc1JlbGF0aXZlIH0gZnJvbSBcIi4vVmZzTW9kdWxlUmVzb2x2ZXJcIjtcclxuXHJcblxyXG5cclxuLyoqXHJcbiAqIFdPUktFUiBFTlRSWSBQT0lOVFxyXG5cclxuICogXHJcbiAqIEluaSBhZGFsYWggc2NyaXB0IFwiQm9vdGxvYWRlclwiIHlhbmcgamFsYW4gZGkgZGFsYW0gV29ya2VyIFRocmVhZC5cclxuICogVHVnYXNueWE6IEluaXNpYWxpc2FzaSBVc2VyTGliIGRhbiBqYWxhbmthbiBhcGxpa2FzaS5cclxuICovXHJcblxyXG5cclxuXHJcblxyXG4vLyB0c2NvbmZpZy1wYXRocyBkYW4gZXNidWlsZC1yZWdpc3RlciBzdWRhaCBkaS1sb2FkIHZpYSBleGVjQXJndiBkaSBTY2hlZHVsZXIudHNcclxuXHJcblxyXG5cclxuXHJcblxyXG5jb25zdCByZWFsRXhpdCA9IHByb2Nlc3MuZXhpdC5iaW5kKHByb2Nlc3MpO1xyXG5cclxuLy8gLS0tIFBFUkZPUk1BTkNFIEhJSkFDSyAtLS1cclxuLy8gUHJlLWxvYWQgY29yZSBsaWJyYXJpZXMgYW5kIGhpamFjayByZXF1aXJlIHRvIGF2b2lkIG11bHRpcGxlIEZTIGhpdHNcclxuLy8gaW4gdGhlIGhpZ2gtcGVyZm9ybWFuY2UgcGF0aC5cclxuY29uc3QgaG9zdFJlcXVpcmUgPSB0eXBlb2YgcmVxdWlyZSAhPT0gXCJ1bmRlZmluZWRcIiA/IHJlcXVpcmUgOiBudWxsO1xyXG5jb25zdCBwYXRoID0gaG9zdFJlcXVpcmUgPyBob3N0UmVxdWlyZShcInBhdGhcIikgOiBudWxsO1xyXG5jb25zdCBNb2R1bGUgPSBob3N0UmVxdWlyZSA/IGhvc3RSZXF1aXJlKFwibW9kdWxlXCIpIDogbnVsbDtcclxuXHJcbi8qKlxyXG4gKiByZXNvbHZlUmVsYXRpdmVNb2R1bGVJZCgpOiBNZW5lcmplbWFoa2FuIGltcG9ydCByZWxhdGlmIE1JTElLIE1PRFVMXHJcbiAqIEZSQU1FV09SSyBrZSBtb2R1bGUtaWQgKGBAdHNpeC94YCwgYEBjb21tb24vYS9iYCkuXHJcbiAqXHJcbiAqIEtlbmFwYSBwZXJsdTogV29ya2VyRW50cnkgbWUtX2NvbXBpbGUoKSBtb2R1bCBmcmFtZXdvcmsgZGFyaSBtZW1vcnkgZGVuZ2FuXHJcbiAqIG5hbWEgZmlsZSBidWF0YW4gKGBAY29tbW9uX25ldGZzL05ldEZTU2VydmVyLmpzYCksIGphZGkgYC4vTmV0RlNQcm90b2NvbGBcclxuICogaGFueWEgYmlzYSBkaS1yZXNvbHZlIGthbGF1IGtpdGEgdGFodSBpZCBtb2R1bCBpbmR1a255YS4gQ2FyYSBsYW1hIG1lbWFrYWlcclxuICogYHBhdGguYmFzZW5hbWUocGFyZW50LmZpbGVuYW1lKWA6XHJcbiAqXHJcbiAqICAgLSBgQHRzaXhfQXBwbGljYXRpb24uanNgICAgICAgXHUyMTkyIGJhc2VuYW1lIGNvY29rLCBgLi94YCBcdTIxOTIgYEB0c2l4L3hgICAgXHUyNzA1XHJcbiAqICAgLSBgTmV0RlNTZXJ2ZXIuanNgIChiZXJzYXJhbmcpIFx1MjE5MiBiYXNlbmFtZSBUSURBSyBjb2NvaywgYC4vTmV0RlNQcm90b2NvbGBcclxuICogICAgIGRpYmlhcmthbiBhcGEgYWRhbnlhIFx1MjE5MiBgQ2Fubm90IGZpbmQgbW9kdWxlICcuL05ldEZTUHJvdG9jb2wnYCAgXHUyNzRDXHJcbiAqXHJcbiAqIERlbmdhbiByZXNvbHVzaSBkaSBydWFuZyBtb2R1bGUtaWQsIGtlZGFsYW1hbiBiZXJhcGEgcHVuIHRldGFwIGJlbmFyOlxyXG4gKiAgIGBAY29tbW9uL25ldGZzL05ldEZTU2VydmVyYCArIGAuL05ldEZTUHJvdG9jb2xgIFx1MjE5MiBgQGNvbW1vbi9uZXRmcy9OZXRGU1Byb3RvY29sYFxyXG4gKiAgIGBAY29tbW9uL25ldGZzL05ldEZTU2VydmVyYCArIGAuLi9Mb2dnZXJgICAgICAgIFx1MjE5MiBgQGNvbW1vbi9Mb2dnZXJgXHJcbiAqL1xyXG5mdW5jdGlvbiByZXNvbHZlUmVsYXRpdmVNb2R1bGVJZChwYXJlbnRJZDogc3RyaW5nLCByZXF1ZXN0OiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgY29uc3QgcGFydHMgPSBwYXJlbnRJZC5zcGxpdChcIi9cIik7XHJcbiAgICBwYXJ0cy5wb3AoKTsgLy8gYnVhbmcgbmFtYSBtb2R1bCBpbmR1a1xyXG4gICAgZm9yIChjb25zdCBzZWcgb2YgcmVxdWVzdC5zcGxpdChcIi9cIikpIHtcclxuICAgICAgICBpZiAoc2VnID09PSBcIlwiIHx8IHNlZyA9PT0gXCIuXCIpIGNvbnRpbnVlO1xyXG4gICAgICAgIGlmIChzZWcgPT09IFwiLi5cIikge1xyXG4gICAgICAgICAgICAvLyBTaXNha2FuIHNlZ21lbiBzY29wZSAoYEB0c2l4YCAvIGBAY29tbW9uYCkgXHUyMDE0IGphbmdhbiBwZXJuYWggaGFiaXMuXHJcbiAgICAgICAgICAgIGlmIChwYXJ0cy5sZW5ndGggPiAxKSBwYXJ0cy5wb3AoKTtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHBhcnRzLnB1c2goc2VnKTtcclxuICAgIH1cclxuICAgIHJldHVybiBwYXJ0cy5qb2luKFwiL1wiKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIE1PRFVMIFJFTEFUSUYgTUlMSUsgUFJPR1JBTSBWRlMgKG1pcy4gYC9zYmluL3Rwa2dkYCArIGAuL1Rwa2dQcm90b2NvbGApLlxyXG4gKlxyXG4gKiBgTW9kdWxlLl9sb2FkYCBzaW5rcm9uLCBzZWRhbmdrYW4gYmFjYSBWRlMgYXNpbmtyb24gXHUyMDE0IGphZGkgaXNpbnlhIGRpa3VtcHVsa2FuXHJcbiAqIGxlYmloIGR1bHUgZGkgYG1haW4oKWAgKGxpaGF0IGBjb2xsZWN0UmVsYXRpdmVNb2R1bGVzYCksIGxhbHUgaG9vayBkaSBiYXdhaFxyXG4gKiBoYW55YSBNRUxJSEFUIHBldGEgaW5pOiBpZCBtb2R1bGUgKGAvc2Jpbi9UcGtnUHJvdG9jb2xgKSBcdTIxOTIga29kZSBKUy5cclxuICpcclxuICogRHVsdSBpbXBvcnQgc2VzYW1hIGRpcmVrdG9yaSB0aWRhayBkaWR1a3VuZyBzYW1hIHNla2FsaSAoc2VsYWx1IGphdHVoIGtlIGhvc3RcclxuICogZmlsZXN5c3RlbSBcdTIxOTIgXCJDYW5ub3QgZmluZCBtb2R1bGUgJy4vVHBrZ1Byb3RvY29sJ1wiKS5cclxuICovXHJcbmxldCBwcm9ncmFtTW9kdWxlczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xyXG5cclxuaWYgKE1vZHVsZSAmJiBwYXRoKSB7XHJcbiAgICBjb25zdCBvcmlnaW5hbExvYWQgPSBNb2R1bGUuX2xvYWQ7XHJcbiAgICBjb25zdCB2ZnNDYWNoZSA9ICh3b3JrZXJEYXRhIGFzIGFueSkudmZzQ2FjaGUgfHwge307XHJcbiAgICBjb25zdCBtb2R1bGVDYWNoZTogUmVjb3JkPHN0cmluZywgYW55PiA9IHt9O1xyXG4gICAgLy8gUGV0YSBkdW1teUZpbGVuYW1lIFx1MjE5MiBtb2R1bGUtaWQgKGBAdHNpeC94YCwgYEBjb21tb24vYS9iYCkuIERpcGFrYWkgdW50dWtcclxuICAgIC8vIG1lbmVyamVtYWhrYW4gaW1wb3J0IFJFTEFUSUYgbWlsaWsgbW9kdWwgZnJhbWV3b3JrIChsaWhhdFxyXG4gICAgLy8gcmVzb2x2ZVJlbGF0aXZlTW9kdWxlSWQpLlxyXG4gICAgY29uc3QgbW9kdWxlSWRCeUZpbGU6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcclxuXHJcbiAgICBNb2R1bGUuX2xvYWQgPSBmdW5jdGlvbiAocmVxdWVzdDogc3RyaW5nLCBwYXJlbnQ6IGFueSwgaXNNYWluOiBib29sZWFuKSB7XHJcbiAgICAgICAgbGV0IG5vcm1hbGl6ZWRSZXF1ZXN0ID0gcmVxdWVzdDtcclxuXHJcbiAgICAgICAgLy8gUmVzb2x2ZSByZWxhdGl2ZSBwYXRoc1xyXG4gICAgICAgIGlmIChyZXF1ZXN0LnN0YXJ0c1dpdGgoXCIuXCIpKSB7XHJcbiAgICAgICAgICAgIGlmIChyZXF1ZXN0LmluY2x1ZGVzKFwiL2NvbW1vbi9cIikpIHtcclxuICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRSZXF1ZXN0ID0gXCJAY29tbW9uL1wiICsgcmVxdWVzdC5zcGxpdChcIi9jb21tb24vXCIpWzFdO1xyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKHJlcXVlc3QuaW5jbHVkZXMoXCIvbGliL1wiKSkge1xyXG4gICAgICAgICAgICAgICAgbm9ybWFsaXplZFJlcXVlc3QgPSBcIkB0c2l4L1wiICsgcmVxdWVzdC5zcGxpdChcIi9saWIvXCIpWzFdO1xyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKHBhcmVudCAmJiBwYXJlbnQuZmlsZW5hbWUpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHBhcmVudElkID0gbW9kdWxlSWRCeUZpbGVbcGFyZW50LmZpbGVuYW1lXTtcclxuICAgICAgICAgICAgICAgIGlmIChwYXJlbnRJZCkge1xyXG4gICAgICAgICAgICAgICAgICAgIC8vIE1vZHVsIGZyYW1ld29yayB5YW5nIGtpdGEgbXVhdCBzZW5kaXJpOiByZXNvbHVzaSByZWxhdGlmXHJcbiAgICAgICAgICAgICAgICAgICAgLy8gZGlsYWt1a2FuIGRpIHJ1YW5nIG1vZHVsZS1pZCAoYmVuYXIgdW50dWsgc2VtdWEga2VkYWxhbWFuKS5cclxuICAgICAgICAgICAgICAgICAgICBub3JtYWxpemVkUmVxdWVzdCA9IHJlc29sdmVSZWxhdGl2ZU1vZHVsZUlkKHBhcmVudElkLCByZXF1ZXN0KTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgLy8gUHJvZ3JhbSBWRlMgKGJ1a2FuIG1vZHVsIGZyYW1ld29yayk6IGZpbGVueWEgYmVydXBhIHBhdGggVkZTXHJcbiAgICAgICAgICAgICAgICAgICAgLy8gKGAvc2Jpbi90cGtnZC5qc2ApLiBSZXNvbHVzaWthbiByZWxhdGlmIHRlcmhhZGFwIGRpcmVrdG9yaW55YSxcclxuICAgICAgICAgICAgICAgICAgICAvLyBsYWx1IGNhcmkgZGkgcGV0YSBtb2R1bCB5YW5nIHN1ZGFoIGRpYmFjYSBkYXJpIFZGUy5cclxuICAgICAgICAgICAgICAgICAgICAvL1xyXG4gICAgICAgICAgICAgICAgICAgIC8vIFVydXRhbiBwZW50aW5nOiBjYWJhbmcgYC9saWIvYCAmIGAvY29tbW9uL2AgZGkgYXRhcyBkaWRhaHVsdWthblxyXG4gICAgICAgICAgICAgICAgICAgIC8vIHN1cGF5YSBgLi4vbGliL3hgIHRldGFwIGRpbGF5YW5pIGNhY2hlIGZyYW1ld29yay5cclxuICAgICAgICAgICAgICAgICAgICBjb25zdCB2ZnNUYXJnZXQgPSBwYXJlbnQuZmlsZW5hbWUuc3RhcnRzV2l0aChcIi9cIilcclxuICAgICAgICAgICAgICAgICAgICAgICAgPyByZXNvbHZlVmZzUmVsYXRpdmUocGFyZW50LmZpbGVuYW1lLCByZXF1ZXN0KVxyXG4gICAgICAgICAgICAgICAgICAgICAgICA6IG51bGw7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKHZmc1RhcmdldCAmJiBwcm9ncmFtTW9kdWxlc1t2ZnNUYXJnZXRdKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRSZXF1ZXN0ID0gdmZzVGFyZ2V0O1xyXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGJhc2VuYW1lID0gcGF0aCEuYmFzZW5hbWUocGFyZW50LmZpbGVuYW1lKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGJhc2VuYW1lLnN0YXJ0c1dpdGgoXCJAdHNpeF9cIikgJiYgcmVxdWVzdC5zdGFydHNXaXRoKFwiLi9cIikpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRSZXF1ZXN0ID0gXCJAdHNpeC9cIiArIHJlcXVlc3Quc3Vic3RyaW5nKDIpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGJhc2VuYW1lLnN0YXJ0c1dpdGgoXCJAY29tbW9uX1wiKSAmJiByZXF1ZXN0LnN0YXJ0c1dpdGgoXCIuL1wiKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbm9ybWFsaXplZFJlcXVlc3QgPSBcIkBjb21tb24vXCIgKyByZXF1ZXN0LnN1YnN0cmluZygyKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgLy8gQ2FjaGVkIE1vZHVsZVxyXG4gICAgICAgIGlmIChtb2R1bGVDYWNoZVtub3JtYWxpemVkUmVxdWVzdF0pIHJldHVybiBtb2R1bGVDYWNoZVtub3JtYWxpemVkUmVxdWVzdF07XHJcblxyXG4gICAgICAgIC8vIFJlc29sdXNpIE1lbW9yeSBGcmFtZXdvcmsgKFZGUylcclxuICAgICAgICBsZXQgdmZzUGF0aCA9IG51bGw7XHJcbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRSZXF1ZXN0LnN0YXJ0c1dpdGgoXCJAdHNpeC9cIikpIHtcclxuICAgICAgICAgICAgdmZzUGF0aCA9IFwiL2xpYi9cIiArIG5vcm1hbGl6ZWRSZXF1ZXN0LnN1YnN0cmluZyg2KSArIFwiLnRzXCI7XHJcbiAgICAgICAgfSBlbHNlIGlmIChub3JtYWxpemVkUmVxdWVzdC5zdGFydHNXaXRoKFwiQGNvbW1vbi9cIikpIHtcclxuICAgICAgICAgICAgdmZzUGF0aCA9IFwiL2xpYi9jb21tb24vXCIgKyBub3JtYWxpemVkUmVxdWVzdC5zdWJzdHJpbmcoOCkgKyBcIi50c1wiO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgLy8gTW9kdWwgcmVsYXRpZiBtaWxpayBwcm9ncmFtIChwZXRhIGRhcmkgYGNvbGxlY3RSZWxhdGl2ZU1vZHVsZXNgKS5cclxuICAgICAgICAvLyBJZC1ueWEgc3VkYWggdGFucGEgZWtzdGVuc2ksIGphZGkgZGljYXJpIGxhbmdzdW5nLlxyXG4gICAgICAgIGlmICghdmZzUGF0aCAmJiBwcm9ncmFtTW9kdWxlc1tub3JtYWxpemVkUmVxdWVzdF0pIHtcclxuICAgICAgICAgICAgY29uc3QgY29udGVudCA9IHByb2dyYW1Nb2R1bGVzW25vcm1hbGl6ZWRSZXF1ZXN0XTtcclxuICAgICAgICAgICAgY29uc3QgZHVtbXlGaWxlbmFtZSA9IHBhdGghLmpvaW4ocHJvY2Vzcy5jd2QoKSwgbm9ybWFsaXplZFJlcXVlc3QucmVwbGFjZSgvXFwvL2csIFwiX1wiKSArIFwiLmpzXCIpO1xyXG5cclxuICAgICAgICAgICAgY29uc3QgbmV3TW9kID0gbmV3IE1vZHVsZShkdW1teUZpbGVuYW1lLCBwYXJlbnQpO1xyXG4gICAgICAgICAgICBuZXdNb2QuZmlsZW5hbWUgPSBkdW1teUZpbGVuYW1lO1xyXG4gICAgICAgICAgICBuZXdNb2QucGF0aHMgPSBNb2R1bGUuX25vZGVNb2R1bGVQYXRocyhwcm9jZXNzLmN3ZCgpKTtcclxuXHJcbiAgICAgICAgICAgIC8vIERhZnRhcmthbiBTRUJFTFVNIF9jb21waWxlOiBtb2R1bCBpbmkgYmlzYSBtZS1yZXF1aXJlIGFuYWtueWEgc2FhdFxyXG4gICAgICAgICAgICAvLyBfY29tcGlsZSBiZXJqYWxhbi4gSWQtbnlhIHBhdGggVkZTIHN1cGF5YSBpbXBvcnQgcmVsYXRpZiBiZXJzYXJhbmdcclxuICAgICAgICAgICAgLy8gaWt1dCBiZW5hciAocmVzb2x2ZVJlbGF0aXZlTW9kdWxlSWQgbWVuYW5nYW5pIGJlbnR1ayBcIi9hL2JcIikuXHJcbiAgICAgICAgICAgIG1vZHVsZUlkQnlGaWxlW2R1bW15RmlsZW5hbWVdID0gbm9ybWFsaXplZFJlcXVlc3Q7XHJcbiAgICAgICAgICAgIChuZXdNb2QgYXMgYW55KS5fY29tcGlsZShjb250ZW50LCBkdW1teUZpbGVuYW1lKTtcclxuXHJcbiAgICAgICAgICAgIG1vZHVsZUNhY2hlW25vcm1hbGl6ZWRSZXF1ZXN0XSA9IG5ld01vZC5leHBvcnRzO1xyXG4gICAgICAgICAgICByZXR1cm4gbmV3TW9kLmV4cG9ydHM7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBpZiAodmZzUGF0aCAmJiB2ZnNDYWNoZVt2ZnNQYXRoXSkge1xyXG4gICAgICAgICAgICBjb25zdCBjb250ZW50ID0gdmZzQ2FjaGVbdmZzUGF0aF07XHJcbiAgICAgICAgICAgIGNvbnN0IGR1bW15RmlsZW5hbWUgPSBwYXRoIS5qb2luKHByb2Nlc3MuY3dkKCksIG5vcm1hbGl6ZWRSZXF1ZXN0LnJlcGxhY2UoXCIvXCIsIFwiX1wiKSArIFwiLmpzXCIpO1xyXG5cclxuICAgICAgICAgICAgY29uc3QgbmV3TW9kID0gbmV3IE1vZHVsZShkdW1teUZpbGVuYW1lLCBwYXJlbnQpO1xyXG4gICAgICAgICAgICBuZXdNb2QuZmlsZW5hbWUgPSBkdW1teUZpbGVuYW1lO1xyXG4gICAgICAgICAgICBuZXdNb2QucGF0aHMgPSBNb2R1bGUuX25vZGVNb2R1bGVQYXRocyhwcm9jZXNzLmN3ZCgpKTtcclxuXHJcbiAgICAgICAgICAgIC8vIFBFTlRJTkc6IGRhZnRhcmthbiBTRUJFTFVNIF9jb21waWxlIFx1MjAxNCBpc2kgbW9kdWwgbWUtcmVxdWlyZSBhbmFrbnlhXHJcbiAgICAgICAgICAgIC8vIHNhYXQgX2NvbXBpbGUgYmVyamFsYW4sIGphZGkgcGV0YSBpbmkgaGFydXMgc3VkYWggdGVyaXNpLlxyXG4gICAgICAgICAgICBtb2R1bGVJZEJ5RmlsZVtkdW1teUZpbGVuYW1lXSA9IG5vcm1hbGl6ZWRSZXF1ZXN0O1xyXG5cclxuICAgICAgICAgICAgLy8gRnJhbWV3b3JrIG1vZHVsZXMgYXJlIG5vdyBwcmUtY29tcGlsZWQgaW4gS2VybmVsLlxyXG4gICAgICAgICAgICAvLyBEaXJlY3QgZXhlY3V0aW9uIGZvciBtYXhpbXVtIHBlcmZvcm1hbmNlLlxyXG4gICAgICAgICAgICAobmV3TW9kIGFzIGFueSkuX2NvbXBpbGUoY29udGVudCwgZHVtbXlGaWxlbmFtZSk7XHJcblxyXG4gICAgICAgICAgICBtb2R1bGVDYWNoZVtub3JtYWxpemVkUmVxdWVzdF0gPSBuZXdNb2QuZXhwb3J0cztcclxuICAgICAgICAgICAgcmV0dXJuIG5ld01vZC5leHBvcnRzO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgcmV0dXJuIG9yaWdpbmFsTG9hZC5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xyXG4gICAgfTtcclxuXHJcbiAgICAoZ2xvYmFsIGFzIGFueSkuaGlqYWNrUmVxdWlyZSA9IChpZDogc3RyaW5nKSA9PiB7XHJcbiAgICAgICAgaWYgKGhvc3RSZXF1aXJlKSByZXR1cm4gaG9zdFJlcXVpcmUoaWQpO1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVxdWlyZSBmYWlsZWQgZm9yICR7aWR9IChObyBob3N0IHJlcXVpcmUpYCk7XHJcbiAgICB9O1xyXG59XHJcblxyXG5jb25zdCBoaWphY2tSZXF1aXJlID0gKGlkOiBzdHJpbmcpID0+IChnbG9iYWwgYXMgYW55KS5oaWphY2tSZXF1aXJlID8gKGdsb2JhbCBhcyBhbnkpLmhpamFja1JlcXVpcmUoaWQpIDogKGhvc3RSZXF1aXJlID8gaG9zdFJlcXVpcmUoaWQpIDogbnVsbCk7XHJcblxyXG5pZiAodHlwZW9mIHJlcXVpcmUgIT09IFwidW5kZWZpbmVkXCIpIHtcclxuICAgIChnbG9iYWwgYXMgYW55KS5yZXF1aXJlID0gaGlqYWNrUmVxdWlyZTtcclxufVxyXG5cclxuLyoqXHJcbiAqIE1FTU9SWSBTVEFUIFJFU1BPTkRFUiBcdTIwMTQgamFsdXIgZmFsbGJhY2sgYHBzIC0tbWVtYCAvIGBtZW0gLS1wZXItcHJvY2BcclxuICpcclxuICogS2VybmVsIGxlYmloIHN1a2EgbWVtYmFjYSBpc29sYXRlIHdvcmtlciBzZW5kaXJpIGxld2F0XHJcbiAqIGB3b3JrZXIuZ2V0SGVhcFN0YXRpc3RpY3MoKWAsIFRBUEkgbWV0aG9kIGl0dSBiYXJ1IGFkYSBkaSBOb2RlID49IDIyLjE2LlxyXG4gKiBEaSBOb2RlIGxhbWEga2VybmVsIG1lbmdpcmltIHBlc2FuIGB7IF9fdHNpeE1lbVN0YXRSZXF1ZXN0IH1gIGRhbiBtZW51bmdndVxyXG4gKiBiYWxhc2FuOyByZXNwb25kZXIgaW5pIHlhbmcgbWVuamF3YWJueWEuXHJcbiAqXHJcbiAqIEtlbmFwYSBkaSBzaW5pIChXb3JrZXJFbnRyeSkgZGFuIGJ1a2FuIGRpIFVzZXJMaWI6IGJvb3Rsb2FkZXIgaW5pIFNFTEFMVVxyXG4gKiBqYWxhbiwgYmFoa2FuIHVudHVrIGFwcCB5YW5nIGdhZ2FsIGRpbXVhdCBcdTIwMTQgc2VkYW5na2FuIFVzZXJMaWIgYmFydSBoaWR1cFxyXG4gKiBzZXRlbGFoIGFwcCBtZW5nLWltcG9ydCBmcmFtZXdvcmsuIFRhbnBhIGl0dSwgcHJvc2VzIGJlcm1hc2FsYWgganVzdHJ1XHJcbiAqIGtlaGlsYW5nYW4gYW5na2EgbWVtb3JpbnlhLlxyXG4gKlxyXG4gKiBgcnNzYCBzZW5nYWphIFRJREFLIGRpbGFwb3JrYW46IGRpIGRhbGFtIHdvcmtlciBuaWxhaW55YSBwcm9jZXNzLXdpZGVcclxuICogKG1haW4gdGhyZWFkICsgc2VtdWEgd29ya2VyKSwgbWVueWVzYXRrYW4gdW50dWsgYXRyaWJ1c2kgcGVyLXByb3Nlcy5cclxuICovXHJcbmlmIChwYXJlbnRQb3J0KSB7XHJcbiAgICBwYXJlbnRQb3J0Lm9uKFwibWVzc2FnZVwiLCAobXNnOiBhbnkpID0+IHtcclxuICAgICAgICBjb25zdCByZXF1ZXN0SWQgPSBtc2cgJiYgbXNnLl9fdHNpeE1lbVN0YXRSZXF1ZXN0O1xyXG4gICAgICAgIGlmICh0eXBlb2YgcmVxdWVzdElkICE9PSBcInN0cmluZ1wiKSByZXR1cm47XHJcblxyXG4gICAgICAgIC8vIEphbmdhbiBiaWFya2FuIGtlZ2FnYWxhbiBwZW1iYWNhYW4gbWVtYXRpa2FuIHByb3NlcyBcdTIwMTQgYmFsYXMgYXBhIGFkYW55YS5cclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBtID0gcHJvY2Vzcy5tZW1vcnlVc2FnZSgpO1xyXG4gICAgICAgICAgICBsZXQgaGVhcExpbWl0ID0gMDtcclxuICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgIGhlYXBMaW1pdCA9IGhvc3RSZXF1aXJlID8gaG9zdFJlcXVpcmUoXCJ2OFwiKS5nZXRIZWFwU3RhdGlzdGljcygpLmhlYXBfc2l6ZV9saW1pdCA6IDA7XHJcbiAgICAgICAgICAgIH0gY2F0Y2ggKF8pIHsgLyogdjggb3BzaW9uYWwgXHUyMDE0IDAgYmVyYXJ0aSB0aWRhayBkaWtldGFodWkgKi8gfVxyXG5cclxuICAgICAgICAgICAgcGFyZW50UG9ydCEucG9zdE1lc3NhZ2Uoe1xyXG4gICAgICAgICAgICAgICAgX190c2l4TWVtU3RhdDogcmVxdWVzdElkLFxyXG4gICAgICAgICAgICAgICAgc3RhdHM6IHtcclxuICAgICAgICAgICAgICAgICAgICBoZWFwVXNlZDogbS5oZWFwVXNlZCxcclxuICAgICAgICAgICAgICAgICAgICBoZWFwVG90YWw6IG0uaGVhcFRvdGFsLFxyXG4gICAgICAgICAgICAgICAgICAgIGV4dGVybmFsOiBtLmV4dGVybmFsLFxyXG4gICAgICAgICAgICAgICAgICAgIGFycmF5QnVmZmVyczogbS5hcnJheUJ1ZmZlcnMsXHJcbiAgICAgICAgICAgICAgICAgICAgaGVhcExpbWl0LFxyXG4gICAgICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfSBjYXRjaCAoXykge1xyXG4gICAgICAgICAgICAvLyBCYWxhcyBudWxsIHN1cGF5YSBrZXJuZWwgdGlkYWsgbWVudW5nZ3Ugc2FtcGFpIHRpbWVvdXQuXHJcbiAgICAgICAgICAgIHBhcmVudFBvcnQhLnBvc3RNZXNzYWdlKHsgX190c2l4TWVtU3RhdDogcmVxdWVzdElkLCBzdGF0czogbnVsbCB9KTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxufVxyXG5cclxucHJvY2Vzcy5vbihcInVuaGFuZGxlZFJlamVjdGlvblwiLCAocmVhc29uKSA9PiB7XHJcbiAgICBjb25zdCBtc2cgPSByZWFzb24gaW5zdGFuY2VvZiBFcnJvciA/IHJlYXNvbi5tZXNzYWdlIDogU3RyaW5nKHJlYXNvbik7XHJcbiAgICBjb25zb2xlLmVycm9yKFwiW1dvcmtlciBGYXRhbF0gVW5oYW5kbGVkIFJlamVjdGlvbjpcIiwgbXNnKTtcclxuICAgIHRyeVNlbmRFcnJvclRvUGFyZW50KG1zZyk7XHJcbiAgICByZWFsRXhpdCgxKTtcclxufSk7XHJcblxyXG5wcm9jZXNzLm9uKFwidW5jYXVnaHRFeGNlcHRpb25cIiwgKGVycikgPT4ge1xyXG4gICAgY29uc3QgbXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xyXG4gICAgY29uc29sZS5lcnJvcihcIltXb3JrZXIgRmF0YWxdIFVuY2F1Z2h0IEV4Y2VwdGlvbjpcIiwgbXNnKTtcclxuICAgIHRyeVNlbmRFcnJvclRvUGFyZW50KG1zZyk7XHJcbiAgICByZWFsRXhpdCgxKTtcclxufSk7XHJcblxyXG4vLyBIZWxwZXI6IGNvYmEga2lyaW0gR1VJX1dJTkRPV19FUlJPUiBrZSBwYXJlbnQgKEFzdGVyYWNlYSkgc2ViZWx1bSBleGl0XHJcbmZ1bmN0aW9uIHRyeVNlbmRFcnJvclRvUGFyZW50KG1lc3NhZ2U6IHN0cmluZykge1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBsaWIgPSAoZ2xvYmFsIGFzIGFueSkuX3RzaXhMaWIgYXMgYW55O1xyXG4gICAgICAgIGlmIChsaWIgJiYgdHlwZW9mIGxpYi5nZXRQYXJlbnRQaWQgPT09ICdmdW5jdGlvbicgJiYgdHlwZW9mIGxpYi5zaGVsbD8uc2VuZCA9PT0gJ2Z1bmN0aW9uJykge1xyXG4gICAgICAgICAgICBsaWIuZ2V0UGFyZW50UGlkKCkudGhlbigocGFyZW50UGlkOiBudW1iZXIpID0+IHtcclxuICAgICAgICAgICAgICAgIGlmIChwYXJlbnRQaWQpIHtcclxuICAgICAgICAgICAgICAgICAgICBsaWIuc2hlbGwuc2VuZChwYXJlbnRQaWQsIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJHVUlfV0lORE9XX0VSUk9SXCIsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHdpZDogXCJcIixcclxuICAgICAgICAgICAgICAgICAgICAgICAgcGlkOiBsaWIuZ2V0UGlkKCksXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGZpbGU6IFwiXCIsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGVycm9yOiBgUnVudGltZSBFcnJvcjogJHttZXNzYWdlfWAsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRleHQ6IFwicnVudGltZVwiLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5yZXBsYWNlKCdUJywgJyAnKS5zdWJzdHJpbmcoMCwgMTkpLFxyXG4gICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9KS5jYXRjaCgoKSA9PiB7IH0pO1xyXG4gICAgICAgIH1cclxuICAgIH0gY2F0Y2ggKF8pIHsgLyogaWdub3JlICovIH1cclxufVxyXG5cclxuLy8gLS0tIEJBU0lDIFNBTkRCT1hJTkcgKEVkdWNhdGlvbmFsIExldmVsKSAtLS1cclxuLy8gS2l0YSBcInNlbWJ1bnlpa2FuXCIgYmViZXJhcGEgQVBJIE5vZGUuanMgeWFuZyBiZXJiYWhheWEgYWdhciB1c2VyLWxhbmQgXHJcbi8vIGRpcGFrc2EgbWVuZ2d1bmFrYW4gU3lzY2FsbCBsZXdhdCBVc2VyTGliLlxyXG5jb25zdCByZXN0cmljdEhvc3RBUEkgPSAoYXBwTmFtZTogc3RyaW5nKSA9PiB7XHJcbiAgICBjb25zdCBmb3JiaWRkZW4gPSAobXNnOiBzdHJpbmcgPSBcIlNlY3VyaXR5IFZpb2xhdGlvbjogRGlyZWN0IEhvc3QgQVBJIGFjY2VzcyBpcyBmb3JiaWRkZW4gaW4gVFNJWCBTYW5kYm94LlwiKSA9PiB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKG1zZyk7XHJcbiAgICB9O1xyXG5cclxuICAgIGNvbnN0IGlzUHJpdmlsZWdlZCA9IGFwcE5hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcInNlcnZlclwiKSB8fFxyXG4gICAgICAgIGFwcE5hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcImRhZW1vblwiKSB8fFxyXG4gICAgICAgIGFwcE5hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcImRvbWVcIikgfHxcclxuICAgICAgICBhcHBOYW1lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJ0YnVpbGRcIikgfHxcclxuICAgICAgICBhcHBOYW1lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJ2ZnNcIikgfHxcclxuICAgICAgICBhcHBOYW1lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJteXNxbGRcIik7XHJcbiAgICBjb25zdCBhbGxvd2VkTW9kdWxlcyA9IFtcInBhdGhcIiwgXCJmc1wiLCBcInVybFwiLCBcImVzYnVpbGRcIiwgXCJjcnlwdG9cIiwgXCJvc1wiLCBcImJjcnlwdGpzXCIsIFwibXlzcWwyXCIsIFwibXlzcWwyL3Byb21pc2VcIl07XHJcblxyXG4gICAgY29uc3QgcHJpdmlsZWdlZFJlcXVpcmUgPSAobW9kOiBzdHJpbmcpID0+IHtcclxuICAgICAgICAvLyBGcmFtZXdvcmsgYWxpYXNlcyBhcmUgQUxXQVlTIGFsbG93ZWQsIGV2ZW4gaW4gc2FuZGJveFxyXG4gICAgICAgIGlmIChtb2Quc3RhcnRzV2l0aChcIkB0c2l4L1wiKSB8fCBtb2Quc3RhcnRzV2l0aChcIkBjb21tb24vXCIpIHx8IG1vZC5pbmNsdWRlcyhcIi9saWIvXCIpIHx8IG1vZC5pbmNsdWRlcyhcIi9jb21tb24vXCIpKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBoaWphY2tSZXF1aXJlKG1vZCk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBpZiAoYWxsb3dlZE1vZHVsZXMuaW5jbHVkZXMobW9kKSkge1xyXG4gICAgICAgICAgICByZXR1cm4gaG9zdFJlcXVpcmUhKG1vZCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZvcmJpZGRlbihgU2VjdXJpdHkgVmlvbGF0aW9uOiBNb2R1bGUgJyR7bW9kfScgaXMgbm90IGluIHRoZSBwcml2aWxlZ2VkIGFsbG93LWxpc3QuYCk7XHJcbiAgICB9O1xyXG5cclxuICAgIC8vIFNlbWJ1bnlpa2FuIHJlcXVpcmUgamlrYSBhZGEgKHRlcmdhbnR1bmcgbW9kdWxlIGxvYWRlcilcclxuICAgIGlmICh0eXBlb2YgcmVxdWlyZSAhPT0gXCJ1bmRlZmluZWRcIikge1xyXG4gICAgICAgIChnbG9iYWwgYXMgYW55KS5yZXF1aXJlID0gaXNQcml2aWxlZ2VkID8gcHJpdmlsZWdlZFJlcXVpcmUgOiAobW9kOiBzdHJpbmcpID0+IHtcclxuICAgICAgICAgICAgLy8gRXZlbiBpbiBzYW5kYm94LCBmcmFtZXdvcmsgY29yZXMgTVVTVCBiZSBhY2Nlc3NpYmxlXHJcbiAgICAgICAgICAgIGlmIChtb2Quc3RhcnRzV2l0aChcIkB0c2l4L1wiKSB8fCBtb2Quc3RhcnRzV2l0aChcIkBjb21tb24vXCIpIHx8IG1vZC5pbmNsdWRlcyhcIi9saWIvXCIpIHx8IG1vZC5pbmNsdWRlcyhcIi9jb21tb24vXCIpKSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gaGlqYWNrUmVxdWlyZShtb2QpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGZvcmJpZGRlbigpO1xyXG4gICAgICAgIH07XHJcbiAgICB9XHJcblxyXG4gICAgLy8gQmF0YXNpIGFrc2VzIHByb2Nlc3MgeWFuZyBzZW5zaXRpZlxyXG4gICAgY29uc3QgcCA9IChnbG9iYWwgYXMgYW55KS5wcm9jZXNzO1xyXG4gICAgaWYgKHApIHtcclxuICAgICAgICBwLmV4aXQgPSBmb3JiaWRkZW47XHJcbiAgICAgICAgcC5raWxsID0gZm9yYmlkZGVuO1xyXG4gICAgICAgIC8vIHAuZW52ID0ge307IC8vIFRlbXBvcmFyaWx5IGtlZXAgZW52IGZvciBkZWJ1Z2dpbmcgaWYgbmVlZGVkLCBvciBjbGVhciBpdFxyXG4gICAgfVxyXG59O1xyXG5cclxuLy8gcmVzdHJpY3RIb3N0QVBJKCk7IC8vIERpcGluZGFoa2FuIGtlIGRhbGFtIG1haW4oKSBcclxuXHJcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cclxuXHJcbi8qKlxyXG4gKiBlbWl0V29ya2VyRXJyb3IoKTogQ2V0YWsgcGVzYW4gZXJyb3IgbG9hZC1wYXRoIGFwbGlrYXNpIGtlIFRUWSAoU1RET1VUKSxcclxuICogc2VoaW5nZ2EgdGVybGloYXQganVnYSBkaSBwaXhlbHRlcm0gLyBrb25zb2wgVFRZIChidWthbiBjdW1hIGhvc3Qgc3RkZXJyKS5cclxuICogRmlyZS1hbmQtZm9yZ2V0ICh0aWRhayBkaS1hd2FpdCkgc3VwYXlhIHRpZGFrIG1lbmd1YmFoIGFsdXIgbWFpbigpOyBmYWxsYmFja1xyXG4gKiBrZSBjb25zb2xlLmVycm9yIChob3N0IHN0ZGVycikgYmlsYSBwcmludCBrZSBUVFkgZ2FnYWwuXHJcbiAqLyBcclxuZnVuY3Rpb24gZW1pdFdvcmtlckVycm9yKGxpYjogYW55LCBwaWQ6IG51bWJlciwgbWVzc2FnZTogc3RyaW5nKSB7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGlmIChsaWIgJiYgbGliLnN0ZCAmJiB0eXBlb2YgbGliLnN0ZC5wcmludCA9PT0gXCJmdW5jdGlvblwiKSB7XHJcbiAgICAgICAgICAgIHZvaWQgbGliLnN0ZC5wcmludChgXFx4MWJbMzFtW1dvcmtlciAke3BpZH1dXFx4MWJbMG0gJHttZXNzYWdlfVxcbmApLmNhdGNoKCgpID0+IHtcclxuICAgICAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYFtXb3JrZXIgJHtwaWR9XSAke21lc3NhZ2V9YCk7XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgfSBjYXRjaCAoXykge1xyXG4gICAgICAgIC8vIGZhbGxiYWNrIGtlIGNvbnNvbGUuZXJyb3IgZGkgYmF3YWhcclxuICAgIH1cclxuICAgIGNvbnNvbGUuZXJyb3IoYFtXb3JrZXIgJHtwaWR9XSAke21lc3NhZ2V9YCk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBub3RpZnlMb2FkRXJyb3IoKTogS2lyaW0gR1VJX1dJTkRPV19FUlJPUiBrZSBwYXJlbnQgJiBXaW5kb3cgTWFuYWdlciAoQXN0ZXJhY2VhKVxyXG4gKiBzdXBheWEgZXJyb3IgZ2FnYWwtbG9hZCBhcGxpa2FzaSBqdWdhIHRhbXBpbCBzZWJhZ2FpIHBvcHVwIGRpIGRlc2t0b3AgXHUyMDE0IHRlcm1hc3VrXHJcbiAqIHNhYXQgYXBwIGRpamFsYW5rYW4gZGFyaSBmaWxlLWNydWlzZXIvdGVybWluYWwgKGZvcmVpZ24gYXBwKS4gUG9sYW55YSBzYW1hIGRlbmdhblxyXG4gKiBub3RpZnlQYXJlbnRXaW5kb3dFdmVudCgpIGRpIEVtZXJhbGQ6IGtpcmltIGtlIHBhcmVudCBkdWx1LCBsYWx1IGtlIFdNIHZpYVxyXG4gKiAvb3B0L2FzdGVyYWNlYS93bS1waWQuIEZpcmUtYW5kLWZvcmdldDsga2VnYWdhbGFuIHBlbmdpcmltYW4gdGlkYWsgZmF0YWwuXHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBub3RpZnlMb2FkRXJyb3IobGliOiBhbnksIHBpZDogbnVtYmVyLCBhcHBOYW1lOiBzdHJpbmcsIG1lc3NhZ2U6IHN0cmluZykge1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCB0aW1lc3RhbXAgPSBuZXcgRGF0ZSgpXHJcbiAgICAgICAgICAgIC50b0lTT1N0cmluZygpXHJcbiAgICAgICAgICAgIC5yZXBsYWNlKFwiVFwiLCBcIiBcIilcclxuICAgICAgICAgICAgLnN1YnN0cmluZygwLCAxOSk7XHJcbiAgICAgICAgY29uc3QgcGF5bG9hZCA9IHtcclxuICAgICAgICAgICAgdHlwZTogXCJHVUlfV0lORE9XX0VSUk9SXCIsXHJcbiAgICAgICAgICAgIHdpZDogXCJcIixcclxuICAgICAgICAgICAgcGlkLFxyXG4gICAgICAgICAgICBmaWxlOiBhcHBOYW1lLFxyXG4gICAgICAgICAgICBlcnJvcjogbWVzc2FnZSxcclxuICAgICAgICAgICAgY29udGV4dDogXCJsb2FkXCIsXHJcbiAgICAgICAgICAgIHRpbWVzdGFtcCxcclxuICAgICAgICB9O1xyXG5cclxuICAgICAgICAvLyAxLiBLaXJpbSBrZSBwYXJlbnQgcHJvY2VzcyAoYmlzYSBXTSBiaWxhIGFwcCBkaS1sYXVuY2ggZGFyaSBsYXVuY2hlcilcclxuICAgICAgICBjb25zdCBwYXJlbnRQaWQgPSBhd2FpdCBsaWIuZ2V0UGFyZW50UGlkKCk7XHJcbiAgICAgICAgaWYgKHBhcmVudFBpZCkge1xyXG4gICAgICAgICAgICBhd2FpdCBsaWIuc2hlbGwuc2VuZChwYXJlbnRQaWQsIHBheWxvYWQpO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgLy8gMi4gS2lyaW0ganVnYSBrZSBBc3RlcmFjZWEgV00gXHUyMDE0IHVudHVrIGFwcCB5YW5nIGRpLXJ1biB2aWFcclxuICAgICAgICAvLyAgICBmaWxlLWNydWlzZXIvdGVybWluYWwgKGZvcmVpZ24gYXBwKS4gQmFjYSBQSUQgV00gZGFyaSB3bS1waWQgZmlsZS5cclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCB3bVBpZFJhdyA9IGF3YWl0IGxpYi5mcy5yZWFkRmlsZShcIi9vcHQvYXN0ZXJhY2VhL3dtLXBpZFwiKTtcclxuICAgICAgICAgICAgaWYgKHdtUGlkUmF3KSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCB3bVBpZCA9IHBhcnNlSW50KFN0cmluZyh3bVBpZFJhdykudHJpbSgpKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IG15UGlkID0gbGliLmdldFBpZCgpO1xyXG4gICAgICAgICAgICAgICAgaWYgKHdtUGlkICYmIHdtUGlkICE9PSBteVBpZCAmJiB3bVBpZCAhPT0gcGFyZW50UGlkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgbGliLnNoZWxsLnNlbmQod21QaWQsIHBheWxvYWQpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBjYXRjaCAoXykge1xyXG4gICAgICAgICAgICAvLyBBc3RlcmFjZWEgdGlkYWsgYmVyamFsYW4gXHUyMDE0IG5vLW9wXHJcbiAgICAgICAgfVxyXG4gICAgfSBjYXRjaCAoXykge1xyXG4gICAgICAgIC8vIE5vdGlmaWthc2kgZ2FnYWwgXHUyMDE0IG5vbi1mYXRhbFxyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBtYWluKCkge1xyXG4gICAgY29uc3QgZGF0YSA9IHdvcmtlckRhdGEgYXMgV29ya2VySW5pdERhdGE7XHJcbiAgICBjb25zdCB7IHBpZCwgYXBwTmFtZSwgYXJncywgYXBwUGF0aCB9ID0gZGF0YTtcclxuXHJcbiAgICAvLyBMb2FkIFVzZXJMaWIgZGluYW1pcyBkYXJpIFZGUyBDYWNoZSAoTWVtb3J5IEV4ZWN1dGlvbilcclxuICAgIGNvbnN0IFVzZXJMaWJNb2QgPSBoaWphY2tSZXF1aXJlKFwiQHRzaXgvVXNlckxpYlwiKTtcclxuICAgIGNvbnN0IFVzZXJMaWJDbGFzcyA9IFVzZXJMaWJNb2QuVXNlckxpYjtcclxuXHJcbiAgICBpZiAoIVVzZXJMaWJDbGFzcykge1xyXG4gICAgICAgIGNvbnNvbGUuZXJyb3IoYFtXb3JrZXIgJHtwaWR9XSBDUklUSUNBTCBFUlJPUjogRmFpbGVkIHRvIGxvYWQgVXNlckxpYiBmcm9tIFZGUyBNZW1vcnkgQ2FjaGUhYCk7XHJcbiAgICAgICAgcmVhbEV4aXQoMSk7XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QgbGliID0gbmV3IFVzZXJMaWJDbGFzcyhwaWQpO1xyXG4gICAgKGdsb2JhbCBhcyBhbnkpLl90c2l4TGliID0gbGliOyAvLyBSZWdpc3RlciBmb3IgZXhwbGljaXQgaW1wb3J0cyAodjIuMSlcclxuXHJcbiAgICAvLyBKUy1EaXJlY3QgcGF0aCBzaG91bGQgTk9UIGhhdmUgLXIgaW4gZXhlY0FyZ3ZcclxuICAgIGNvbnN0IGlzSnNEaXJlY3QgPSAhcHJvY2Vzcy5leGVjQXJndi5zb21lKGFyZyA9PiBhcmcuaW5jbHVkZXMoXCItclwiKSk7XHJcblxyXG4gICAgLy8gMi4gQ2FyaSBhcGxpa2FzaW55YVxyXG4gICAgY29uc3QgdGFyZ2V0S2V5ID0gYXBwTmFtZS50cmltKCk7XHJcbiAgICBsZXQgQXBwQ2xhc3M6IGFueSA9IG51bGw7XHJcbiAgICBsZXQgZmluYWxBcHBQYXRoID0gYXBwUGF0aDtcclxuICAgIC8vIFJlYXNvbiB0aGUgbG9hZCBmYWlsZWQgKHRyYW5zcGlsZS9leGVjdXRpb24pIFx1MjAxNCB1c2VkIGZvciBhIG1vcmUgaG9uZXN0XHJcbiAgICAvLyBmaW5hbCBtZXNzYWdlIGluc3RlYWQgb2YgdGhlIG1pc2xlYWRpbmcgXCJBcHBsaWNhdGlvbiBub3QgZm91bmRcIi5cclxuICAgIGxldCBsb2FkRmFpbHVyZTogc3RyaW5nIHwgbnVsbCA9IG51bGw7XHJcbiAgICAvLyBEZXRhaWwgZXJyb3IgYXNsaW55YSAocGVzYW4gZXNidWlsZC9ydW50aW1lKSBcdTIwMTQgZGlwYWthaSB1bnR1ayBwb3B1cCBkZXNrdG9wXHJcbiAgICAvLyBiaWFyIHNwZXNpZmlrLCBidWthbiBzZWthZGFyIGthdGVnb3JpIFwidHJhbnNwaWxlIGZhaWxlZFwiLlxyXG4gICAgbGV0IGxvYWRFcnJvckRldGFpbDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XHJcblxyXG4gICAgLy8gLS0tIFNUUkFURUdJIEJBUlU6IERpcmVjdCBNZW1vcnkgRXhlY3V0aW9uIChUYW5wYSAudmZzX2NhY2hlKSAtLS1cclxuICAgIGlmICghZmluYWxBcHBQYXRoICYmIChkYXRhIGFzIGFueSkuYXBwQ29udGVudCAmJiBNb2R1bGUpIHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBsZXQgY29udGVudCA9IChkYXRhIGFzIGFueSkuYXBwQ29udGVudDtcclxuICAgICAgICAgICAgY29uc3QgaXNUeXBlU2NyaXB0ID0gIShhcHBQYXRoIHx8IGFwcE5hbWUgfHwgXCJcIikudG9Mb3dlckNhc2UoKS5lbmRzV2l0aChcIi5qc1wiKTtcclxuICAgICAgICAgICAgLy8gTW9kdWxlIGZpbGVuYW1lIEhBUlVTIHBoeXNpY2FsIHBhdGggdW50dWsgcmVxdWlyZSgpIG5lbXUgbm9kZV9tb2R1bGVzXHJcbiAgICAgICAgICAgIGNvbnN0IG1vZHVsZUZpbGVuYW1lID0gcGF0aCEuam9pbihwcm9jZXNzLmN3ZCgpLCBhcHBOYW1lICsgXCIuanNcIik7XHJcbiAgICAgICAgICAgIC8vIFN0YWNrIGZpbGVuYW1lID0gQktGUyBwYXRoIGJpYXIgc3RhY2sgdHJhY2UgYmVuZXIgKC9vcHQvdGVzdC9ndWktdGVzdC5qcylcclxuICAgICAgICAgICAgLy8gc3RhY2tCa2ZzUGF0aCA9IEJLRlMgcGF0aCB1bnR1ayBzdGFjayB0cmFjZSAoL29wdC90ZXN0L2d1aS10ZXN0LmpzKVxyXG4gICAgICAgICAgICBjb25zdCBzdGFja0JrZnNQYXRoID0gKGRhdGEgYXMgYW55KS5zdGFja0JrZnNQYXRoO1xyXG4gICAgICAgICAgICBjb25zdCBzdGFja0ZpbGVuYW1lID0gc3RhY2tCa2ZzUGF0aFxyXG4gICAgICAgICAgICAgICAgPyBzdGFja0JrZnNQYXRoLnJlcGxhY2UoL1xcLnRzJC8sICcuanMnKVxyXG4gICAgICAgICAgICAgICAgOiBtb2R1bGVGaWxlbmFtZTtcclxuICAgICAgICAgICAgLy8gc291cmNlZmlsZSB1bnR1ayBlc2J1aWxkIHNvdXJjZW1hcCBcdTIwMTQgY3VrdXAgbmFtYSBmaWxlIGFqYSAodGFucGEgcGF0aClcclxuICAgICAgICAgICAgY29uc3Qgc291cmNlRmlsZU5hbWUgPSAoc3RhY2tCa2ZzUGF0aCB8fCBtb2R1bGVGaWxlbmFtZSkuc3BsaXQoL1tcXFxcL10vKS5wb3AoKSEucmVwbGFjZSgvXFwuanMkLywgJy50cycpO1xyXG5cclxuICAgICAgICAgICAgLy8gLS0tIE1PRFVMIFJFTEFUSUYgUFJPR1JBTSAoLi94LCAuLi95KSAtLS1cclxuICAgICAgICAgICAgLy9cclxuICAgICAgICAgICAgLy8gRGlrdW1wdWxrYW4gU0VLQVJBTkcgKG1haW4oKSBhc3luYykga2FyZW5hIGBNb2R1bGUuX2xvYWRgIHNpbmtyb25cclxuICAgICAgICAgICAgLy8gc2VkYW5na2FuIGJhY2EgVkZTIGxld2F0IHN5c2NhbGwgYXNpbmtyb246IGhvb2sgcmVxdWlyZSB0aWRhayBtdW5na2luXHJcbiAgICAgICAgICAgIC8vIG1lbWJhY2EgZmlsZSBzZW5kaXJpLiBUYW5wYSBsYW5na2FoIGluaSwgYHJlcXVpcmUoXCIuL1Rwa2dQcm90b2NvbFwiKWBcclxuICAgICAgICAgICAgLy8gbWVuY2FyaSBmaWxlIGl0dSBkaSBIT1NUIGZpbGVzeXN0ZW0gZGFuIGdhZ2FsLlxyXG4gICAgICAgICAgICBpZiAoc3RhY2tCa2ZzUGF0aCkge1xyXG4gICAgICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBlc2J1aWxkTW9kID0gaG9zdFJlcXVpcmUhKFwiZXNidWlsZFwiKTtcclxuICAgICAgICAgICAgICAgICAgICBwcm9ncmFtTW9kdWxlcyA9IGF3YWl0IGNvbGxlY3RSZWxhdGl2ZU1vZHVsZXMoe1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRyeUlkOiBzdGFja0JrZnNQYXRoLnJlcGxhY2UoL1xcLih0c3xqcykkL2ksIFwiXCIpLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBzb3VyY2U6IGNvbnRlbnQsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlYWRGaWxlOiAodmZzUGF0aDogc3RyaW5nKSA9PiBsaWIuZnMucmVhZEZpbGUodmZzUGF0aCksXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRyYW5zcGlsZTogKHNyYzogc3RyaW5nLCBtb2R1bGVJZDogc3RyaW5nKSA9PlxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXNidWlsZE1vZC50cmFuc2Zvcm1TeW5jKHNyYywge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxvYWRlcjogXCJ0c1wiLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvcm1hdDogXCJjanNcIixcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YXJnZXQ6IFwibm9kZTE4XCIsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc291cmNlbWFwOiBcImlubGluZVwiLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNvdXJjZWZpbGU6IG1vZHVsZUlkLnNwbGl0KFwiL1wiKS5wb3AoKSArIFwiLnRzXCIsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KS5jb2RlLFxyXG4gICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgfSBjYXRjaCAoZTogYW55KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgLy8gTm9uLWZhdGFsOiBpbXBvcnQgcmVsYXRpZiBha2FuIGdhZ2FsIGRlbmdhbiBwZXNhbiBOb2RlIGJpYXNhLlxyXG4gICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYFtXb3JrZXIgJHtwaWR9XSBMb2NhbCBtb2R1bGUgc2NhbiBmYWlsZWQ6ICR7ZS5tZXNzYWdlfWApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICAvLyBKaWthIGNvbnRlbnQgYWRhbGFoIFR5cGVTY3JpcHQsIHRyYW5zcGlsZSBkdWx1IGtlIEphdmFTY3JpcHRcclxuICAgICAgICAgICAgaWYgKGlzVHlwZVNjcmlwdCkge1xyXG4gICAgICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBlc2J1aWxkID0gaG9zdFJlcXVpcmUhKFwiZXNidWlsZFwiKTtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCByZXN1bHQgPSBlc2J1aWxkLnRyYW5zZm9ybVN5bmMoY29udGVudCwge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBsb2FkZXI6IFwidHNcIixcclxuICAgICAgICAgICAgICAgICAgICAgICAgZm9ybWF0OiBcImNqc1wiLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0YXJnZXQ6IFwibm9kZTE4XCIsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHNvdXJjZW1hcDogXCJpbmxpbmVcIixcclxuICAgICAgICAgICAgICAgICAgICAgICAgc291cmNlZmlsZTogc291cmNlRmlsZU5hbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgICAgICAgICAgY29udGVudCA9IHJlc3VsdC5jb2RlO1xyXG4gICAgICAgICAgICAgICAgfSBjYXRjaCAodHJhbnNwaWxlRXJyOiBhbnkpIHtcclxuICAgICAgICAgICAgICAgICAgICBsb2FkRmFpbHVyZSA9IFwidHJhbnNwaWxlIGZhaWxlZFwiO1xyXG4gICAgICAgICAgICAgICAgICAgIGxvYWRFcnJvckRldGFpbCA9IGBUUyBUcmFuc3BpbGUgRXJyb3I6ICR7dHJhbnNwaWxlRXJyLm1lc3NhZ2V9YDtcclxuICAgICAgICAgICAgICAgICAgICBlbWl0V29ya2VyRXJyb3IobGliLCBwaWQsIGBUUyBUcmFuc3BpbGUgRXJyb3I6ICR7dHJhbnNwaWxlRXJyLm1lc3NhZ2V9YCk7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgdHJhbnNwaWxlRXJyO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICAvLyBDcmVhdGUgYSBuZXcgbW9kdWxlIGluc3RhbmNlIHdpdGggcGh5c2ljYWwgcGF0aCAoZm9yIG5vZGVfbW9kdWxlcyByZXNvbHV0aW9uKVxyXG4gICAgICAgICAgICBjb25zdCBhcHBNb2R1bGUgPSBuZXcgTW9kdWxlKG1vZHVsZUZpbGVuYW1lLCBtb2R1bGUucGFyZW50KTtcclxuICAgICAgICAgICAgYXBwTW9kdWxlLmZpbGVuYW1lID0gc3RhY2tGaWxlbmFtZTsgIC8vIF9fZmlsZW5hbWUgc2hvd3MgQktGUyBwYXRoXHJcbiAgICAgICAgICAgIGFwcE1vZHVsZS5wYXRocyA9IE1vZHVsZS5fbm9kZU1vZHVsZVBhdGhzKHBhdGghLmRpcm5hbWUobW9kdWxlRmlsZW5hbWUpKTtcclxuXHJcbiAgICAgICAgICAgIC8vIF9jb21waWxlIGRlbmdhbiBzdGFja0ZpbGVuYW1lIGFnYXIgc3RhY2sgdHJhY2UgbnVuanVrIEJLRlMgcGF0aFxyXG4gICAgICAgICAgICAoYXBwTW9kdWxlIGFzIGFueSkuX2NvbXBpbGUoY29udGVudCwgc3RhY2tGaWxlbmFtZSk7XHJcblxyXG4gICAgICAgICAgICBBcHBDbGFzcyA9IGFwcE1vZHVsZS5leHBvcnRzLm1haW4gfHwgYXBwTW9kdWxlLmV4cG9ydHMuTWFpbiB8fCBhcHBNb2R1bGUuZXhwb3J0cy5kZWZhdWx0IHx8IGFwcE1vZHVsZS5leHBvcnRzO1xyXG5cclxuICAgICAgICAgICAgLy8gSmlrYSBtYXNpaCBiZWx1bSBrZXRlbXUgKGUuZy4gZXhwb3J0IGNsYXNzIGJ1a2FuIGRlZmF1bHQvbWFpbilcclxuICAgICAgICAgICAgaWYgKHR5cGVvZiBBcHBDbGFzcyAhPT0gJ2Z1bmN0aW9uJykge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgZW50cmllcyA9IE9iamVjdC5lbnRyaWVzKGFwcE1vZHVsZS5leHBvcnRzKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGZvdW5kID0gZW50cmllcy5maW5kKChbXywgdmFsXTogW3N0cmluZywgYW55XSkgPT4gdHlwZW9mIHZhbCA9PT0gJ2Z1bmN0aW9uJyk7XHJcbiAgICAgICAgICAgICAgICBpZiAoZm91bmQpIEFwcENsYXNzID0gZm91bmRbMV07XHJcbiAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgIGlmIChBcHBDbGFzcykge1xyXG4gICAgICAgICAgICAgICAgLy8gY29uc29sZS5sb2coYFtXb3JrZXIgJHtwaWR9XSBEaXJlY3QgTWVtb3J5IEV4ZWN1dGlvbiBzdWNjZXNzIGZvciAke2FwcE5hbWV9YCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGNhdGNoIChlcnI6IGFueSkge1xyXG4gICAgICAgICAgICBpZiAoIWxvYWRGYWlsdXJlKSBsb2FkRmFpbHVyZSA9IFwiZGlyZWN0IGV4ZWN1dGlvbiBmYWlsZWRcIjtcclxuICAgICAgICAgICAgaWYgKCFsb2FkRXJyb3JEZXRhaWwpIGxvYWRFcnJvckRldGFpbCA9IGBEaXJlY3QgRXhlY3V0aW9uIEVycm9yOiAke2Vyci5tZXNzYWdlfWA7XHJcbiAgICAgICAgICAgIGVtaXRXb3JrZXJFcnJvcihsaWIsIHBpZCwgYERpcmVjdCBFeGVjdXRpb24gRXJyb3I6ICR7ZXJyLm1lc3NhZ2V9YCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuXHJcbiAgICBpZiAoZmluYWxBcHBQYXRoICYmIGhvc3RSZXF1aXJlKSB7XHJcbiAgICAgICAgLy8gU1RSQVRFR0kgQkFSVTogRHluYW1pYyBMb2FkaW5nIGRhcmkgRmlsZSBGaXNpayAoTGludXgtbGlrZSlcclxuICAgICAgICAvLyBTVFJBVEVHSTogRHluYW1pYyBMb2FkaW5nIGRhcmkgRmlsZSBGaXNpayAoSnVqdXIgUGFrZSAudHMpXHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgbW9kdWxlID0gaG9zdFJlcXVpcmUoZmluYWxBcHBQYXRoKTtcclxuICAgICAgICAgICAgY29uc3QgZW50cmllcyA9IE9iamVjdC5lbnRyaWVzKG1vZHVsZSk7XHJcblxyXG4gICAgICAgICAgICAvLyBbREVCVUddIENoZWNrIHdoYXQgd2UgZm91bmRcclxuICAgICAgICAgICAgLy8gY29uc29sZS5sb2coYFtXb3JrZXIgJHtwaWR9XSBMb2FkZWQgbW9kdWxlIGZvciAke2FwcE5hbWV9LiBLZXlzOiAke09iamVjdC5rZXlzKG1vZHVsZSkuam9pbihcIiwgXCIpfWApO1xyXG5cclxuICAgICAgICAgICAgLy8gU1RSQVRFR0kgU1RBTkRBUjogQ2FyaSBleHBvcnQgYmVybmFtYSAnbWFpbidcclxuICAgICAgICAgICAgaWYgKG1vZHVsZS5tYWluKSB7XHJcbiAgICAgICAgICAgICAgICBBcHBDbGFzcyA9IG1vZHVsZS5tYWluO1xyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKG1vZHVsZS5NYWluKSB7XHJcbiAgICAgICAgICAgICAgICBBcHBDbGFzcyA9IG1vZHVsZS5NYWluO1xyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKG1vZHVsZS5kZWZhdWx0KSB7XHJcbiAgICAgICAgICAgICAgICBBcHBDbGFzcyA9IG1vZHVsZS5kZWZhdWx0O1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgLy8gRmFsbGJhY2s6IEFtYmlsIGV4cG9ydCBwZXJ0YW1hIHlhbmcgYmVydXBhIGNsYXNzL2Z1bmN0aW9uXHJcbiAgICAgICAgICAgICAgICBjb25zdCBmb3VuZCA9IGVudHJpZXMuZmluZCgoW18sIHZhbF06IFtzdHJpbmcsIGFueV0pID0+IHR5cGVvZiB2YWwgPT09ICdmdW5jdGlvbicpO1xyXG4gICAgICAgICAgICAgICAgaWYgKGZvdW5kKSBBcHBDbGFzcyA9IGZvdW5kWzFdO1xyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICBpZiAoQXBwQ2xhc3MpIHtcclxuICAgICAgICAgICAgICAgIC8vIGNvbnNvbGUubG9nKGBbV29ya2VyICR7cGlkfV0gSWRlbnRpZmllZCBBcHBDbGFzcyBmb3IgJHthcHBOYW1lfWApO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgbG9hZEZhaWx1cmUgPSBcIm5vIHZhbGlkICdtYWluJyBleHBvcnQgZm91bmRcIjtcclxuICAgICAgICAgICAgICAgIGxvYWRFcnJvckRldGFpbCA9IGBGYWlsZWQgdG8gaWRlbnRpZnkgQXBwQ2xhc3MgZm9yICR7YXBwTmFtZX0uIE1vZHVsZSBleHBvcnRzOiAke09iamVjdC5rZXlzKG1vZHVsZSkuam9pbihcIiwgXCIpfWA7XHJcbiAgICAgICAgICAgICAgICBlbWl0V29ya2VyRXJyb3IobGliLCBwaWQsIGBGYWlsZWQgdG8gaWRlbnRpZnkgQXBwQ2xhc3MgZm9yICR7YXBwTmFtZX0uIE1vZHVsZSBleHBvcnRzOiAke09iamVjdC5rZXlzKG1vZHVsZSkuam9pbihcIiwgXCIpfWApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyOiBhbnkpIHtcclxuICAgICAgICAgICAgbG9hZEZhaWx1cmUgPSBcImZhaWxlZCB0byBsb2FkIG1vZHVsZVwiO1xyXG4gICAgICAgICAgICBsb2FkRXJyb3JEZXRhaWwgPSBgUnVudGltZSBFcnJvcjogRmFpbGVkIHRvIHJlcXVpcmUgJHtmaW5hbEFwcFBhdGggfHwgYXBwTmFtZX06ICR7ZXJyLm1lc3NhZ2V9YDtcclxuICAgICAgICAgICAgZW1pdFdvcmtlckVycm9yKGxpYiwgcGlkLCBgUnVudGltZSBFcnJvcjogRmFpbGVkIHRvIHJlcXVpcmUgJHtmaW5hbEFwcFBhdGggfHwgYXBwTmFtZX06ICR7ZXJyLm1lc3NhZ2V9YCk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgIH1cclxuXHJcblxyXG4gICAgaWYgKCFBcHBDbGFzcykge1xyXG4gICAgICAgIGlmIChwYXJlbnRQb3J0KSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGVycm9yTXNnID0gbG9hZEZhaWx1cmVcclxuICAgICAgICAgICAgICAgID8gYC1iYXNoOiAke2FwcE5hbWV9OiBGYWlsZWQgdG8gbG9hZCBcdTIwMTQgJHtsb2FkRmFpbHVyZX1cXG5gXHJcbiAgICAgICAgICAgICAgICA6IGAtYmFzaDogJHthcHBOYW1lfTogQXBwbGljYXRpb24gbm90IGZvdW5kIChQYXRoOiAke2FwcFBhdGggfHwgJ1ZGUy1Pbmx5J30pXFxuYDtcclxuICAgICAgICAgICAgYXdhaXQgbGliLnN0ZC5wcmludChlcnJvck1zZyk7XHJcbiAgICAgICAgICAgIHBhcmVudFBvcnQucG9zdE1lc3NhZ2Uoe1xyXG4gICAgICAgICAgICAgICAgc3VjY2VzczogZmFsc2UsXHJcbiAgICAgICAgICAgICAgICBlcnJvcjogZXJyb3JNc2cudHJpbSgpXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAvLyBUYW1waWxrYW4ganVnYSBkaSBkZXNrdG9wIChXTS9Bc3RlcmFjZWEpIHZpYSBHVUlfV0lORE9XX0VSUk9SLlxyXG4gICAgICAgICAgICAvLyBXQUpJQiBkaS1hd2FpdDogcmVhbEV4aXQoMSkgZGkgYmF3YWggbGFuZ3N1bmcgbWVtYXRpa2FuIHdvcmtlciwgZGFuXHJcbiAgICAgICAgICAgIC8vIGthbGF1IGZpcmUtYW5kLWZvcmdldCwga2lyaW1hbiBhc3luYy1ueWEgdGFrIHNlbXBhdCBzZWxlc2FpLlxyXG4gICAgICAgICAgICAvLyBQb3B1cCBwYWthaSBkZXRhaWwgZXJyb3IgYXNsaSAobG9hZEVycm9yRGV0YWlsKSBiaWFyIHNwZXNpZmlrLlxyXG4gICAgICAgICAgICBhd2FpdCBub3RpZnlMb2FkRXJyb3IobGliLCBwaWQsIGFwcE5hbWUsIGxvYWRFcnJvckRldGFpbCB8fCBlcnJvck1zZy50cmltKCkpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZWFsRXhpdCgxKTtcclxuICAgIH1cclxuXHJcblxyXG5cclxuICAgIC8vIDMuIEFLVElGS0FOIFNBTkRCT1ggKEt1bmNpIHBpbnR1IHNlYmVsdW0gYXBsaWthc2kgYmVyamFsYW4pXHJcbiAgICByZXN0cmljdEhvc3RBUEkoYXBwTmFtZSk7XHJcblxyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBhcHAgPSBuZXcgQXBwQ2xhc3MoKTtcclxuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBhcHAuZXhlY3V0ZShsaWIgYXMgYW55LCBhcmdzKTtcclxuXHJcblxyXG5cclxuXHJcbiAgICAgICAgLy8gMy4gSmlrYSBhcGxpa2FzaSBtZS1yZXR1cm4gc3RyaW5nLCBjZXRhayBrZSBsYXlhciB2aWEgUFJJTlQgc3lzY2FsbFxyXG4gICAgICAgIGlmIChyZXN1bHQgJiYgdHlwZW9mIHJlc3VsdCA9PT0gXCJzdHJpbmdcIiAmJiByZXN1bHQudHJpbSgpICE9PSBcIlwiKSB7XHJcbiAgICAgICAgICAgIGF3YWl0IGxpYi5zdGQucHJpbnQocmVzdWx0ICsgXCJcXG5cIik7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICAvLyA0LiBCZXJpdGFodSBLZXJuZWwgYmFod2EgcHJvc2VzIHNlbGVzYWlcclxuICAgICAgICBhd2FpdCBsaWIuc2hlbGwuZXhpdCgwKTtcclxuICAgIH0gY2F0Y2ggKGVycm9yOiBhbnkpIHtcclxuICAgICAgICAvLyBMYXBvcmthbiBlcnJvciBrZSBwYXJlbnQgKFdNKSB2aWEgSVBDXHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgcGFyZW50UGlkID0gYXdhaXQgbGliLmdldFBhcmVudFBpZCgpO1xyXG4gICAgICAgICAgICBpZiAocGFyZW50UGlkKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBsaWIuc2hlbGwuc2VuZChwYXJlbnRQaWQsIHtcclxuICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIkdVSV9XSU5ET1dfRVJST1JcIixcclxuICAgICAgICAgICAgICAgICAgICB3aWQ6IFwiXCIsXHJcbiAgICAgICAgICAgICAgICAgICAgcGlkOiBsaWIuZ2V0UGlkKCksXHJcbiAgICAgICAgICAgICAgICAgICAgZmlsZTogYXBwTmFtZSB8fCBcIlwiLFxyXG4gICAgICAgICAgICAgICAgICAgIGVycm9yOiBgUnVudGltZSBFcnJvcjogJHtlcnJvci5tZXNzYWdlfWAsXHJcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dDogXCJydW50aW1lXCIsXHJcbiAgICAgICAgICAgICAgICAgICAgdGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkucmVwbGFjZSgnVCcsICcgJykuc3Vic3RyaW5nKDAsIDE5KSxcclxuICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBjYXRjaCAoXykgeyAvKiBJUEMgc2VuZCBmYWlsdXJlIGlzIG5vbi1mYXRhbCAqLyB9XHJcblxyXG4gICAgICAgIC8vIEp1Z2EgY29iYSBsZXdhdCBzdGQuZXJyb3IgeWFuZyBwdW55YSBtZWthbmlzbWUgbGViaWggbGVuZ2thcFxyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGF3YWl0IGxpYi5zdGQuZXJyb3IoZXJyb3IubWVzc2FnZSB8fCBTdHJpbmcoZXJyb3IpLCBhcHBOYW1lIHx8IFwiYXBwXCIpO1xyXG4gICAgICAgIH0gY2F0Y2ggKF8pIHsgfVxyXG5cclxuICAgICAgICAvLyBMYXBvcmthbiBlcnJvciBrZSBUVFkgY29uc29sZVxyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGF3YWl0IGxpYi5zdGQucHJpbnQoYFxcbltXb3JrZXIgJHtwaWR9XSBSdW50aW1lIEVycm9yOiAke2Vycm9yLm1lc3NhZ2V9XFxuYCk7XHJcbiAgICAgICAgfSBjYXRjaCAoZSkgeyB9XHJcbiAgICAgICAgcmVhbEV4aXQoMSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbm1haW4oKTtcclxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsNEJBQXVDO0FBRXZDLCtCQUEyRDtBQXFCM0QsTUFBTSxXQUFXLFFBQVEsS0FBSyxLQUFLLE9BQU87QUFLMUMsTUFBTSxjQUFjLE9BQU8sWUFBWSxjQUFjLFVBQVU7QUFDL0QsTUFBTSxPQUFPLGNBQWMsWUFBWSxNQUFNLElBQUk7QUFDakQsTUFBTSxTQUFTLGNBQWMsWUFBWSxRQUFRLElBQUk7QUFtQnJELFNBQVMsd0JBQXdCLFVBQWtCLFNBQXlCO0FBQ3hFLFFBQU0sUUFBUSxTQUFTLE1BQU0sR0FBRztB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
