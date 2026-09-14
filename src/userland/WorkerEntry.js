var import_worker_threads = require("worker_threads");
const realExit = process.exit.bind(process);
const hostRequire = typeof require !== "undefined" ? require : null;
const path = hostRequire ? hostRequire("path") : null;
const Module = hostRequire ? hostRequire("module") : null;
if (Module && path) {
  const originalLoad = Module._load;
  const vfsCache = import_worker_threads.workerData.vfsCache || {};
  const moduleCache = {};
  Module._load = function(request, parent, isMain) {
    let normalizedRequest = request;
    if (request.startsWith(".")) {
      if (request.includes("/common/")) {
        normalizedRequest = "@common/" + request.split("/common/")[1];
      } else if (request.includes("/lib/")) {
        normalizedRequest = "@tsix/" + request.split("/lib/")[1];
      } else if (parent && parent.filename) {
        const basename = path.basename(parent.filename);
        if (basename.startsWith("@tsix_") && request.startsWith("./")) {
          normalizedRequest = "@tsix/" + request.substring(2);
        } else if (basename.startsWith("@common_") && request.startsWith("./")) {
          normalizedRequest = "@common/" + request.substring(2);
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
    if (vfsPath && vfsCache[vfsPath]) {
      const content = vfsCache[vfsPath];
      const dummyFilename = path.join(process.cwd(), normalizedRequest.replace("/", "_") + ".js");
      const newMod = new Module(dummyFilename, parent);
      newMod.filename = dummyFilename;
      newMod.paths = Module._nodeModulePaths(process.cwd());
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiV29ya2VyRW50cnkudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IHdvcmtlckRhdGEsIHBhcmVudFBvcnQgfSBmcm9tIFwid29ya2VyX3RocmVhZHNcIjtcclxuaW1wb3J0IHsgV29ya2VySW5pdERhdGEsIFN5c2NhbGxSZXNwb25zZSB9IGZyb20gXCIuLi9jb21tb24vSVBDVHlwZXNcIjtcclxuXHJcblxyXG5cclxuLyoqXHJcbiAqIFdPUktFUiBFTlRSWSBQT0lOVFxyXG5cclxuICogXHJcbiAqIEluaSBhZGFsYWggc2NyaXB0IFwiQm9vdGxvYWRlclwiIHlhbmcgamFsYW4gZGkgZGFsYW0gV29ya2VyIFRocmVhZC5cclxuICogVHVnYXNueWE6IEluaXNpYWxpc2FzaSBVc2VyTGliIGRhbiBqYWxhbmthbiBhcGxpa2FzaS5cclxuICovXHJcblxyXG5cclxuXHJcblxyXG4vLyB0c2NvbmZpZy1wYXRocyBkYW4gZXNidWlsZC1yZWdpc3RlciBzdWRhaCBkaS1sb2FkIHZpYSBleGVjQXJndiBkaSBTY2hlZHVsZXIudHNcclxuXHJcblxyXG5cclxuXHJcblxyXG5jb25zdCByZWFsRXhpdCA9IHByb2Nlc3MuZXhpdC5iaW5kKHByb2Nlc3MpO1xyXG5cclxuLy8gLS0tIFBFUkZPUk1BTkNFIEhJSkFDSyAtLS1cclxuLy8gUHJlLWxvYWQgY29yZSBsaWJyYXJpZXMgYW5kIGhpamFjayByZXF1aXJlIHRvIGF2b2lkIG11bHRpcGxlIEZTIGhpdHNcclxuLy8gaW4gdGhlIGhpZ2gtcGVyZm9ybWFuY2UgcGF0aC5cclxuY29uc3QgaG9zdFJlcXVpcmUgPSB0eXBlb2YgcmVxdWlyZSAhPT0gXCJ1bmRlZmluZWRcIiA/IHJlcXVpcmUgOiBudWxsO1xyXG5jb25zdCBwYXRoID0gaG9zdFJlcXVpcmUgPyBob3N0UmVxdWlyZShcInBhdGhcIikgOiBudWxsO1xyXG5jb25zdCBNb2R1bGUgPSBob3N0UmVxdWlyZSA/IGhvc3RSZXF1aXJlKFwibW9kdWxlXCIpIDogbnVsbDtcclxuXHJcbmlmIChNb2R1bGUgJiYgcGF0aCkge1xyXG4gICAgY29uc3Qgb3JpZ2luYWxMb2FkID0gTW9kdWxlLl9sb2FkO1xyXG4gICAgY29uc3QgdmZzQ2FjaGUgPSAod29ya2VyRGF0YSBhcyBhbnkpLnZmc0NhY2hlIHx8IHt9O1xyXG4gICAgY29uc3QgbW9kdWxlQ2FjaGU6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7fTtcclxuXHJcbiAgICBNb2R1bGUuX2xvYWQgPSBmdW5jdGlvbiAocmVxdWVzdDogc3RyaW5nLCBwYXJlbnQ6IGFueSwgaXNNYWluOiBib29sZWFuKSB7XHJcbiAgICAgICAgbGV0IG5vcm1hbGl6ZWRSZXF1ZXN0ID0gcmVxdWVzdDtcclxuXHJcbiAgICAgICAgLy8gUmVzb2x2ZSByZWxhdGl2ZSBwYXRoc1xyXG4gICAgICAgIGlmIChyZXF1ZXN0LnN0YXJ0c1dpdGgoXCIuXCIpKSB7XHJcbiAgICAgICAgICAgIGlmIChyZXF1ZXN0LmluY2x1ZGVzKFwiL2NvbW1vbi9cIikpIHtcclxuICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRSZXF1ZXN0ID0gXCJAY29tbW9uL1wiICsgcmVxdWVzdC5zcGxpdChcIi9jb21tb24vXCIpWzFdO1xyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKHJlcXVlc3QuaW5jbHVkZXMoXCIvbGliL1wiKSkge1xyXG4gICAgICAgICAgICAgICAgbm9ybWFsaXplZFJlcXVlc3QgPSBcIkB0c2l4L1wiICsgcmVxdWVzdC5zcGxpdChcIi9saWIvXCIpWzFdO1xyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKHBhcmVudCAmJiBwYXJlbnQuZmlsZW5hbWUpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGJhc2VuYW1lID0gcGF0aCEuYmFzZW5hbWUocGFyZW50LmZpbGVuYW1lKTtcclxuICAgICAgICAgICAgICAgIGlmIChiYXNlbmFtZS5zdGFydHNXaXRoKFwiQHRzaXhfXCIpICYmIHJlcXVlc3Quc3RhcnRzV2l0aChcIi4vXCIpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgbm9ybWFsaXplZFJlcXVlc3QgPSBcIkB0c2l4L1wiICsgcmVxdWVzdC5zdWJzdHJpbmcoMik7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGJhc2VuYW1lLnN0YXJ0c1dpdGgoXCJAY29tbW9uX1wiKSAmJiByZXF1ZXN0LnN0YXJ0c1dpdGgoXCIuL1wiKSkge1xyXG4gICAgICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRSZXF1ZXN0ID0gXCJAY29tbW9uL1wiICsgcmVxdWVzdC5zdWJzdHJpbmcoMik7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8vIENhY2hlZCBNb2R1bGVcclxuICAgICAgICBpZiAobW9kdWxlQ2FjaGVbbm9ybWFsaXplZFJlcXVlc3RdKSByZXR1cm4gbW9kdWxlQ2FjaGVbbm9ybWFsaXplZFJlcXVlc3RdO1xyXG5cclxuICAgICAgICAvLyBSZXNvbHVzaSBNZW1vcnkgRnJhbWV3b3JrIChWRlMpXHJcbiAgICAgICAgbGV0IHZmc1BhdGggPSBudWxsO1xyXG4gICAgICAgIGlmIChub3JtYWxpemVkUmVxdWVzdC5zdGFydHNXaXRoKFwiQHRzaXgvXCIpKSB7XHJcbiAgICAgICAgICAgIHZmc1BhdGggPSBcIi9saWIvXCIgKyBub3JtYWxpemVkUmVxdWVzdC5zdWJzdHJpbmcoNikgKyBcIi50c1wiO1xyXG4gICAgICAgIH0gZWxzZSBpZiAobm9ybWFsaXplZFJlcXVlc3Quc3RhcnRzV2l0aChcIkBjb21tb24vXCIpKSB7XHJcbiAgICAgICAgICAgIHZmc1BhdGggPSBcIi9saWIvY29tbW9uL1wiICsgbm9ybWFsaXplZFJlcXVlc3Quc3Vic3RyaW5nKDgpICsgXCIudHNcIjtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGlmICh2ZnNQYXRoICYmIHZmc0NhY2hlW3Zmc1BhdGhdKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGNvbnRlbnQgPSB2ZnNDYWNoZVt2ZnNQYXRoXTtcclxuICAgICAgICAgICAgY29uc3QgZHVtbXlGaWxlbmFtZSA9IHBhdGghLmpvaW4ocHJvY2Vzcy5jd2QoKSwgbm9ybWFsaXplZFJlcXVlc3QucmVwbGFjZShcIi9cIiwgXCJfXCIpICsgXCIuanNcIik7XHJcblxyXG4gICAgICAgICAgICBjb25zdCBuZXdNb2QgPSBuZXcgTW9kdWxlKGR1bW15RmlsZW5hbWUsIHBhcmVudCk7XHJcbiAgICAgICAgICAgIG5ld01vZC5maWxlbmFtZSA9IGR1bW15RmlsZW5hbWU7XHJcbiAgICAgICAgICAgIG5ld01vZC5wYXRocyA9IE1vZHVsZS5fbm9kZU1vZHVsZVBhdGhzKHByb2Nlc3MuY3dkKCkpO1xyXG5cclxuICAgICAgICAgICAgLy8gRnJhbWV3b3JrIG1vZHVsZXMgYXJlIG5vdyBwcmUtY29tcGlsZWQgaW4gS2VybmVsLlxyXG4gICAgICAgICAgICAvLyBEaXJlY3QgZXhlY3V0aW9uIGZvciBtYXhpbXVtIHBlcmZvcm1hbmNlLlxyXG4gICAgICAgICAgICAobmV3TW9kIGFzIGFueSkuX2NvbXBpbGUoY29udGVudCwgZHVtbXlGaWxlbmFtZSk7XHJcblxyXG4gICAgICAgICAgICBtb2R1bGVDYWNoZVtub3JtYWxpemVkUmVxdWVzdF0gPSBuZXdNb2QuZXhwb3J0cztcclxuICAgICAgICAgICAgcmV0dXJuIG5ld01vZC5leHBvcnRzO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgcmV0dXJuIG9yaWdpbmFsTG9hZC5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xyXG4gICAgfTtcclxuXHJcbiAgICAoZ2xvYmFsIGFzIGFueSkuaGlqYWNrUmVxdWlyZSA9IChpZDogc3RyaW5nKSA9PiB7XHJcbiAgICAgICAgaWYgKGhvc3RSZXF1aXJlKSByZXR1cm4gaG9zdFJlcXVpcmUoaWQpO1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVxdWlyZSBmYWlsZWQgZm9yICR7aWR9IChObyBob3N0IHJlcXVpcmUpYCk7XHJcbiAgICB9O1xyXG59XHJcblxyXG5jb25zdCBoaWphY2tSZXF1aXJlID0gKGlkOiBzdHJpbmcpID0+IChnbG9iYWwgYXMgYW55KS5oaWphY2tSZXF1aXJlID8gKGdsb2JhbCBhcyBhbnkpLmhpamFja1JlcXVpcmUoaWQpIDogKGhvc3RSZXF1aXJlID8gaG9zdFJlcXVpcmUoaWQpIDogbnVsbCk7XHJcblxyXG5pZiAodHlwZW9mIHJlcXVpcmUgIT09IFwidW5kZWZpbmVkXCIpIHtcclxuICAgIChnbG9iYWwgYXMgYW55KS5yZXF1aXJlID0gaGlqYWNrUmVxdWlyZTtcclxufVxyXG5cclxuLyoqXHJcbiAqIE1FTU9SWSBTVEFUIFJFU1BPTkRFUiBcdTIwMTQgamFsdXIgZmFsbGJhY2sgYHBzIC0tbWVtYCAvIGBtZW0gLS1wZXItcHJvY2BcclxuICpcclxuICogS2VybmVsIGxlYmloIHN1a2EgbWVtYmFjYSBpc29sYXRlIHdvcmtlciBzZW5kaXJpIGxld2F0XHJcbiAqIGB3b3JrZXIuZ2V0SGVhcFN0YXRpc3RpY3MoKWAsIFRBUEkgbWV0aG9kIGl0dSBiYXJ1IGFkYSBkaSBOb2RlID49IDIyLjE2LlxyXG4gKiBEaSBOb2RlIGxhbWEga2VybmVsIG1lbmdpcmltIHBlc2FuIGB7IF9fdHNpeE1lbVN0YXRSZXF1ZXN0IH1gIGRhbiBtZW51bmdndVxyXG4gKiBiYWxhc2FuOyByZXNwb25kZXIgaW5pIHlhbmcgbWVuamF3YWJueWEuXHJcbiAqXHJcbiAqIEtlbmFwYSBkaSBzaW5pIChXb3JrZXJFbnRyeSkgZGFuIGJ1a2FuIGRpIFVzZXJMaWI6IGJvb3Rsb2FkZXIgaW5pIFNFTEFMVVxyXG4gKiBqYWxhbiwgYmFoa2FuIHVudHVrIGFwcCB5YW5nIGdhZ2FsIGRpbXVhdCBcdTIwMTQgc2VkYW5na2FuIFVzZXJMaWIgYmFydSBoaWR1cFxyXG4gKiBzZXRlbGFoIGFwcCBtZW5nLWltcG9ydCBmcmFtZXdvcmsuIFRhbnBhIGl0dSwgcHJvc2VzIGJlcm1hc2FsYWgganVzdHJ1XHJcbiAqIGtlaGlsYW5nYW4gYW5na2EgbWVtb3JpbnlhLlxyXG4gKlxyXG4gKiBgcnNzYCBzZW5nYWphIFRJREFLIGRpbGFwb3JrYW46IGRpIGRhbGFtIHdvcmtlciBuaWxhaW55YSBwcm9jZXNzLXdpZGVcclxuICogKG1haW4gdGhyZWFkICsgc2VtdWEgd29ya2VyKSwgbWVueWVzYXRrYW4gdW50dWsgYXRyaWJ1c2kgcGVyLXByb3Nlcy5cclxuICovXHJcbmlmIChwYXJlbnRQb3J0KSB7XHJcbiAgICBwYXJlbnRQb3J0Lm9uKFwibWVzc2FnZVwiLCAobXNnOiBhbnkpID0+IHtcclxuICAgICAgICBjb25zdCByZXF1ZXN0SWQgPSBtc2cgJiYgbXNnLl9fdHNpeE1lbVN0YXRSZXF1ZXN0O1xyXG4gICAgICAgIGlmICh0eXBlb2YgcmVxdWVzdElkICE9PSBcInN0cmluZ1wiKSByZXR1cm47XHJcblxyXG4gICAgICAgIC8vIEphbmdhbiBiaWFya2FuIGtlZ2FnYWxhbiBwZW1iYWNhYW4gbWVtYXRpa2FuIHByb3NlcyBcdTIwMTQgYmFsYXMgYXBhIGFkYW55YS5cclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBtID0gcHJvY2Vzcy5tZW1vcnlVc2FnZSgpO1xyXG4gICAgICAgICAgICBsZXQgaGVhcExpbWl0ID0gMDtcclxuICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgIGhlYXBMaW1pdCA9IGhvc3RSZXF1aXJlID8gaG9zdFJlcXVpcmUoXCJ2OFwiKS5nZXRIZWFwU3RhdGlzdGljcygpLmhlYXBfc2l6ZV9saW1pdCA6IDA7XHJcbiAgICAgICAgICAgIH0gY2F0Y2ggKF8pIHsgLyogdjggb3BzaW9uYWwgXHUyMDE0IDAgYmVyYXJ0aSB0aWRhayBkaWtldGFodWkgKi8gfVxyXG5cclxuICAgICAgICAgICAgcGFyZW50UG9ydCEucG9zdE1lc3NhZ2Uoe1xyXG4gICAgICAgICAgICAgICAgX190c2l4TWVtU3RhdDogcmVxdWVzdElkLFxyXG4gICAgICAgICAgICAgICAgc3RhdHM6IHtcclxuICAgICAgICAgICAgICAgICAgICBoZWFwVXNlZDogbS5oZWFwVXNlZCxcclxuICAgICAgICAgICAgICAgICAgICBoZWFwVG90YWw6IG0uaGVhcFRvdGFsLFxyXG4gICAgICAgICAgICAgICAgICAgIGV4dGVybmFsOiBtLmV4dGVybmFsLFxyXG4gICAgICAgICAgICAgICAgICAgIGFycmF5QnVmZmVyczogbS5hcnJheUJ1ZmZlcnMsXHJcbiAgICAgICAgICAgICAgICAgICAgaGVhcExpbWl0LFxyXG4gICAgICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfSBjYXRjaCAoXykge1xyXG4gICAgICAgICAgICAvLyBCYWxhcyBudWxsIHN1cGF5YSBrZXJuZWwgdGlkYWsgbWVudW5nZ3Ugc2FtcGFpIHRpbWVvdXQuXHJcbiAgICAgICAgICAgIHBhcmVudFBvcnQhLnBvc3RNZXNzYWdlKHsgX190c2l4TWVtU3RhdDogcmVxdWVzdElkLCBzdGF0czogbnVsbCB9KTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxufVxyXG5cclxucHJvY2Vzcy5vbihcInVuaGFuZGxlZFJlamVjdGlvblwiLCAocmVhc29uKSA9PiB7XHJcbiAgICBjb25zdCBtc2cgPSByZWFzb24gaW5zdGFuY2VvZiBFcnJvciA/IHJlYXNvbi5tZXNzYWdlIDogU3RyaW5nKHJlYXNvbik7XHJcbiAgICBjb25zb2xlLmVycm9yKFwiW1dvcmtlciBGYXRhbF0gVW5oYW5kbGVkIFJlamVjdGlvbjpcIiwgbXNnKTtcclxuICAgIHRyeVNlbmRFcnJvclRvUGFyZW50KG1zZyk7XHJcbiAgICByZWFsRXhpdCgxKTtcclxufSk7XHJcblxyXG5wcm9jZXNzLm9uKFwidW5jYXVnaHRFeGNlcHRpb25cIiwgKGVycikgPT4ge1xyXG4gICAgY29uc3QgbXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xyXG4gICAgY29uc29sZS5lcnJvcihcIltXb3JrZXIgRmF0YWxdIFVuY2F1Z2h0IEV4Y2VwdGlvbjpcIiwgbXNnKTtcclxuICAgIHRyeVNlbmRFcnJvclRvUGFyZW50KG1zZyk7XHJcbiAgICByZWFsRXhpdCgxKTtcclxufSk7XHJcblxyXG4vLyBIZWxwZXI6IGNvYmEga2lyaW0gR1VJX1dJTkRPV19FUlJPUiBrZSBwYXJlbnQgKEFzdGVyYWNlYSkgc2ViZWx1bSBleGl0XHJcbmZ1bmN0aW9uIHRyeVNlbmRFcnJvclRvUGFyZW50KG1lc3NhZ2U6IHN0cmluZykge1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBsaWIgPSAoZ2xvYmFsIGFzIGFueSkuX3RzaXhMaWIgYXMgYW55O1xyXG4gICAgICAgIGlmIChsaWIgJiYgdHlwZW9mIGxpYi5nZXRQYXJlbnRQaWQgPT09ICdmdW5jdGlvbicgJiYgdHlwZW9mIGxpYi5zaGVsbD8uc2VuZCA9PT0gJ2Z1bmN0aW9uJykge1xyXG4gICAgICAgICAgICBsaWIuZ2V0UGFyZW50UGlkKCkudGhlbigocGFyZW50UGlkOiBudW1iZXIpID0+IHtcclxuICAgICAgICAgICAgICAgIGlmIChwYXJlbnRQaWQpIHtcclxuICAgICAgICAgICAgICAgICAgICBsaWIuc2hlbGwuc2VuZChwYXJlbnRQaWQsIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJHVUlfV0lORE9XX0VSUk9SXCIsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHdpZDogXCJcIixcclxuICAgICAgICAgICAgICAgICAgICAgICAgcGlkOiBsaWIuZ2V0UGlkKCksXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGZpbGU6IFwiXCIsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGVycm9yOiBgUnVudGltZSBFcnJvcjogJHttZXNzYWdlfWAsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRleHQ6IFwicnVudGltZVwiLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5yZXBsYWNlKCdUJywgJyAnKS5zdWJzdHJpbmcoMCwgMTkpLFxyXG4gICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9KS5jYXRjaCgoKSA9PiB7IH0pO1xyXG4gICAgICAgIH1cclxuICAgIH0gY2F0Y2ggKF8pIHsgLyogaWdub3JlICovIH1cclxufVxyXG5cclxuLy8gLS0tIEJBU0lDIFNBTkRCT1hJTkcgKEVkdWNhdGlvbmFsIExldmVsKSAtLS1cclxuLy8gS2l0YSBcInNlbWJ1bnlpa2FuXCIgYmViZXJhcGEgQVBJIE5vZGUuanMgeWFuZyBiZXJiYWhheWEgYWdhciB1c2VyLWxhbmQgXHJcbi8vIGRpcGFrc2EgbWVuZ2d1bmFrYW4gU3lzY2FsbCBsZXdhdCBVc2VyTGliLlxyXG5jb25zdCByZXN0cmljdEhvc3RBUEkgPSAoYXBwTmFtZTogc3RyaW5nKSA9PiB7XHJcbiAgICBjb25zdCBmb3JiaWRkZW4gPSAobXNnOiBzdHJpbmcgPSBcIlNlY3VyaXR5IFZpb2xhdGlvbjogRGlyZWN0IEhvc3QgQVBJIGFjY2VzcyBpcyBmb3JiaWRkZW4gaW4gVFNJWCBTYW5kYm94LlwiKSA9PiB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKG1zZyk7XHJcbiAgICB9O1xyXG5cclxuICAgIGNvbnN0IGlzUHJpdmlsZWdlZCA9IGFwcE5hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcInNlcnZlclwiKSB8fFxyXG4gICAgICAgIGFwcE5hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcImRhZW1vblwiKSB8fFxyXG4gICAgICAgIGFwcE5hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcImRvbWVcIikgfHxcclxuICAgICAgICBhcHBOYW1lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJ0YnVpbGRcIikgfHxcclxuICAgICAgICBhcHBOYW1lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJ2ZnNcIikgfHxcclxuICAgICAgICBhcHBOYW1lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJteXNxbGRcIik7XHJcbiAgICBjb25zdCBhbGxvd2VkTW9kdWxlcyA9IFtcInBhdGhcIiwgXCJmc1wiLCBcInVybFwiLCBcImVzYnVpbGRcIiwgXCJjcnlwdG9cIiwgXCJvc1wiLCBcImJjcnlwdGpzXCIsIFwibXlzcWwyXCIsIFwibXlzcWwyL3Byb21pc2VcIl07XHJcblxyXG4gICAgY29uc3QgcHJpdmlsZWdlZFJlcXVpcmUgPSAobW9kOiBzdHJpbmcpID0+IHtcclxuICAgICAgICAvLyBGcmFtZXdvcmsgYWxpYXNlcyBhcmUgQUxXQVlTIGFsbG93ZWQsIGV2ZW4gaW4gc2FuZGJveFxyXG4gICAgICAgIGlmIChtb2Quc3RhcnRzV2l0aChcIkB0c2l4L1wiKSB8fCBtb2Quc3RhcnRzV2l0aChcIkBjb21tb24vXCIpIHx8IG1vZC5pbmNsdWRlcyhcIi9saWIvXCIpIHx8IG1vZC5pbmNsdWRlcyhcIi9jb21tb24vXCIpKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBoaWphY2tSZXF1aXJlKG1vZCk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBpZiAoYWxsb3dlZE1vZHVsZXMuaW5jbHVkZXMobW9kKSkge1xyXG4gICAgICAgICAgICByZXR1cm4gaG9zdFJlcXVpcmUhKG1vZCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZvcmJpZGRlbihgU2VjdXJpdHkgVmlvbGF0aW9uOiBNb2R1bGUgJyR7bW9kfScgaXMgbm90IGluIHRoZSBwcml2aWxlZ2VkIGFsbG93LWxpc3QuYCk7XHJcbiAgICB9O1xyXG5cclxuICAgIC8vIFNlbWJ1bnlpa2FuIHJlcXVpcmUgamlrYSBhZGEgKHRlcmdhbnR1bmcgbW9kdWxlIGxvYWRlcilcclxuICAgIGlmICh0eXBlb2YgcmVxdWlyZSAhPT0gXCJ1bmRlZmluZWRcIikge1xyXG4gICAgICAgIChnbG9iYWwgYXMgYW55KS5yZXF1aXJlID0gaXNQcml2aWxlZ2VkID8gcHJpdmlsZWdlZFJlcXVpcmUgOiAobW9kOiBzdHJpbmcpID0+IHtcclxuICAgICAgICAgICAgLy8gRXZlbiBpbiBzYW5kYm94LCBmcmFtZXdvcmsgY29yZXMgTVVTVCBiZSBhY2Nlc3NpYmxlXHJcbiAgICAgICAgICAgIGlmIChtb2Quc3RhcnRzV2l0aChcIkB0c2l4L1wiKSB8fCBtb2Quc3RhcnRzV2l0aChcIkBjb21tb24vXCIpIHx8IG1vZC5pbmNsdWRlcyhcIi9saWIvXCIpIHx8IG1vZC5pbmNsdWRlcyhcIi9jb21tb24vXCIpKSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gaGlqYWNrUmVxdWlyZShtb2QpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGZvcmJpZGRlbigpO1xyXG4gICAgICAgIH07XHJcbiAgICB9XHJcblxyXG4gICAgLy8gQmF0YXNpIGFrc2VzIHByb2Nlc3MgeWFuZyBzZW5zaXRpZlxyXG4gICAgY29uc3QgcCA9IChnbG9iYWwgYXMgYW55KS5wcm9jZXNzO1xyXG4gICAgaWYgKHApIHtcclxuICAgICAgICBwLmV4aXQgPSBmb3JiaWRkZW47XHJcbiAgICAgICAgcC5raWxsID0gZm9yYmlkZGVuO1xyXG4gICAgICAgIC8vIHAuZW52ID0ge307IC8vIFRlbXBvcmFyaWx5IGtlZXAgZW52IGZvciBkZWJ1Z2dpbmcgaWYgbmVlZGVkLCBvciBjbGVhciBpdFxyXG4gICAgfVxyXG59O1xyXG5cclxuLy8gcmVzdHJpY3RIb3N0QVBJKCk7IC8vIERpcGluZGFoa2FuIGtlIGRhbGFtIG1haW4oKSBcclxuXHJcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cclxuXHJcbi8qKlxyXG4gKiBlbWl0V29ya2VyRXJyb3IoKTogQ2V0YWsgcGVzYW4gZXJyb3IgbG9hZC1wYXRoIGFwbGlrYXNpIGtlIFRUWSAoU1RET1VUKSxcclxuICogc2VoaW5nZ2EgdGVybGloYXQganVnYSBkaSBwaXhlbHRlcm0gLyBrb25zb2wgVFRZIChidWthbiBjdW1hIGhvc3Qgc3RkZXJyKS5cclxuICogRmlyZS1hbmQtZm9yZ2V0ICh0aWRhayBkaS1hd2FpdCkgc3VwYXlhIHRpZGFrIG1lbmd1YmFoIGFsdXIgbWFpbigpOyBmYWxsYmFja1xyXG4gKiBrZSBjb25zb2xlLmVycm9yIChob3N0IHN0ZGVycikgYmlsYSBwcmludCBrZSBUVFkgZ2FnYWwuXHJcbiAqLyBcclxuZnVuY3Rpb24gZW1pdFdvcmtlckVycm9yKGxpYjogYW55LCBwaWQ6IG51bWJlciwgbWVzc2FnZTogc3RyaW5nKSB7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGlmIChsaWIgJiYgbGliLnN0ZCAmJiB0eXBlb2YgbGliLnN0ZC5wcmludCA9PT0gXCJmdW5jdGlvblwiKSB7XHJcbiAgICAgICAgICAgIHZvaWQgbGliLnN0ZC5wcmludChgXFx4MWJbMzFtW1dvcmtlciAke3BpZH1dXFx4MWJbMG0gJHttZXNzYWdlfVxcbmApLmNhdGNoKCgpID0+IHtcclxuICAgICAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYFtXb3JrZXIgJHtwaWR9XSAke21lc3NhZ2V9YCk7XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgfSBjYXRjaCAoXykge1xyXG4gICAgICAgIC8vIGZhbGxiYWNrIGtlIGNvbnNvbGUuZXJyb3IgZGkgYmF3YWhcclxuICAgIH1cclxuICAgIGNvbnNvbGUuZXJyb3IoYFtXb3JrZXIgJHtwaWR9XSAke21lc3NhZ2V9YCk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBub3RpZnlMb2FkRXJyb3IoKTogS2lyaW0gR1VJX1dJTkRPV19FUlJPUiBrZSBwYXJlbnQgJiBXaW5kb3cgTWFuYWdlciAoQXN0ZXJhY2VhKVxyXG4gKiBzdXBheWEgZXJyb3IgZ2FnYWwtbG9hZCBhcGxpa2FzaSBqdWdhIHRhbXBpbCBzZWJhZ2FpIHBvcHVwIGRpIGRlc2t0b3AgXHUyMDE0IHRlcm1hc3VrXHJcbiAqIHNhYXQgYXBwIGRpamFsYW5rYW4gZGFyaSBmaWxlLWNydWlzZXIvdGVybWluYWwgKGZvcmVpZ24gYXBwKS4gUG9sYW55YSBzYW1hIGRlbmdhblxyXG4gKiBub3RpZnlQYXJlbnRXaW5kb3dFdmVudCgpIGRpIEVtZXJhbGQ6IGtpcmltIGtlIHBhcmVudCBkdWx1LCBsYWx1IGtlIFdNIHZpYVxyXG4gKiAvb3B0L2FzdGVyYWNlYS93bS1waWQuIEZpcmUtYW5kLWZvcmdldDsga2VnYWdhbGFuIHBlbmdpcmltYW4gdGlkYWsgZmF0YWwuXHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBub3RpZnlMb2FkRXJyb3IobGliOiBhbnksIHBpZDogbnVtYmVyLCBhcHBOYW1lOiBzdHJpbmcsIG1lc3NhZ2U6IHN0cmluZykge1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCB0aW1lc3RhbXAgPSBuZXcgRGF0ZSgpXHJcbiAgICAgICAgICAgIC50b0lTT1N0cmluZygpXHJcbiAgICAgICAgICAgIC5yZXBsYWNlKFwiVFwiLCBcIiBcIilcclxuICAgICAgICAgICAgLnN1YnN0cmluZygwLCAxOSk7XHJcbiAgICAgICAgY29uc3QgcGF5bG9hZCA9IHtcclxuICAgICAgICAgICAgdHlwZTogXCJHVUlfV0lORE9XX0VSUk9SXCIsXHJcbiAgICAgICAgICAgIHdpZDogXCJcIixcclxuICAgICAgICAgICAgcGlkLFxyXG4gICAgICAgICAgICBmaWxlOiBhcHBOYW1lLFxyXG4gICAgICAgICAgICBlcnJvcjogbWVzc2FnZSxcclxuICAgICAgICAgICAgY29udGV4dDogXCJsb2FkXCIsXHJcbiAgICAgICAgICAgIHRpbWVzdGFtcCxcclxuICAgICAgICB9O1xyXG5cclxuICAgICAgICAvLyAxLiBLaXJpbSBrZSBwYXJlbnQgcHJvY2VzcyAoYmlzYSBXTSBiaWxhIGFwcCBkaS1sYXVuY2ggZGFyaSBsYXVuY2hlcilcclxuICAgICAgICBjb25zdCBwYXJlbnRQaWQgPSBhd2FpdCBsaWIuZ2V0UGFyZW50UGlkKCk7XHJcbiAgICAgICAgaWYgKHBhcmVudFBpZCkge1xyXG4gICAgICAgICAgICBhd2FpdCBsaWIuc2hlbGwuc2VuZChwYXJlbnRQaWQsIHBheWxvYWQpO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgLy8gMi4gS2lyaW0ganVnYSBrZSBBc3RlcmFjZWEgV00gXHUyMDE0IHVudHVrIGFwcCB5YW5nIGRpLXJ1biB2aWFcclxuICAgICAgICAvLyAgICBmaWxlLWNydWlzZXIvdGVybWluYWwgKGZvcmVpZ24gYXBwKS4gQmFjYSBQSUQgV00gZGFyaSB3bS1waWQgZmlsZS5cclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCB3bVBpZFJhdyA9IGF3YWl0IGxpYi5mcy5yZWFkRmlsZShcIi9vcHQvYXN0ZXJhY2VhL3dtLXBpZFwiKTtcclxuICAgICAgICAgICAgaWYgKHdtUGlkUmF3KSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCB3bVBpZCA9IHBhcnNlSW50KFN0cmluZyh3bVBpZFJhdykudHJpbSgpKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IG15UGlkID0gbGliLmdldFBpZCgpO1xyXG4gICAgICAgICAgICAgICAgaWYgKHdtUGlkICYmIHdtUGlkICE9PSBteVBpZCAmJiB3bVBpZCAhPT0gcGFyZW50UGlkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgbGliLnNoZWxsLnNlbmQod21QaWQsIHBheWxvYWQpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBjYXRjaCAoXykge1xyXG4gICAgICAgICAgICAvLyBBc3RlcmFjZWEgdGlkYWsgYmVyamFsYW4gXHUyMDE0IG5vLW9wXHJcbiAgICAgICAgfVxyXG4gICAgfSBjYXRjaCAoXykge1xyXG4gICAgICAgIC8vIE5vdGlmaWthc2kgZ2FnYWwgXHUyMDE0IG5vbi1mYXRhbFxyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBtYWluKCkge1xyXG4gICAgY29uc3QgZGF0YSA9IHdvcmtlckRhdGEgYXMgV29ya2VySW5pdERhdGE7XHJcbiAgICBjb25zdCB7IHBpZCwgYXBwTmFtZSwgYXJncywgYXBwUGF0aCB9ID0gZGF0YTtcclxuXHJcbiAgICAvLyBMb2FkIFVzZXJMaWIgZGluYW1pcyBkYXJpIFZGUyBDYWNoZSAoTWVtb3J5IEV4ZWN1dGlvbilcclxuICAgIGNvbnN0IFVzZXJMaWJNb2QgPSBoaWphY2tSZXF1aXJlKFwiQHRzaXgvVXNlckxpYlwiKTtcclxuICAgIGNvbnN0IFVzZXJMaWJDbGFzcyA9IFVzZXJMaWJNb2QuVXNlckxpYjtcclxuXHJcbiAgICBpZiAoIVVzZXJMaWJDbGFzcykge1xyXG4gICAgICAgIGNvbnNvbGUuZXJyb3IoYFtXb3JrZXIgJHtwaWR9XSBDUklUSUNBTCBFUlJPUjogRmFpbGVkIHRvIGxvYWQgVXNlckxpYiBmcm9tIFZGUyBNZW1vcnkgQ2FjaGUhYCk7XHJcbiAgICAgICAgcmVhbEV4aXQoMSk7XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QgbGliID0gbmV3IFVzZXJMaWJDbGFzcyhwaWQpO1xyXG4gICAgKGdsb2JhbCBhcyBhbnkpLl90c2l4TGliID0gbGliOyAvLyBSZWdpc3RlciBmb3IgZXhwbGljaXQgaW1wb3J0cyAodjIuMSlcclxuXHJcbiAgICAvLyBKUy1EaXJlY3QgcGF0aCBzaG91bGQgTk9UIGhhdmUgLXIgaW4gZXhlY0FyZ3ZcclxuICAgIGNvbnN0IGlzSnNEaXJlY3QgPSAhcHJvY2Vzcy5leGVjQXJndi5zb21lKGFyZyA9PiBhcmcuaW5jbHVkZXMoXCItclwiKSk7XHJcblxyXG4gICAgLy8gMi4gQ2FyaSBhcGxpa2FzaW55YVxyXG4gICAgY29uc3QgdGFyZ2V0S2V5ID0gYXBwTmFtZS50cmltKCk7XHJcbiAgICBsZXQgQXBwQ2xhc3M6IGFueSA9IG51bGw7XHJcbiAgICBsZXQgZmluYWxBcHBQYXRoID0gYXBwUGF0aDtcclxuICAgIC8vIFJlYXNvbiB0aGUgbG9hZCBmYWlsZWQgKHRyYW5zcGlsZS9leGVjdXRpb24pIFx1MjAxNCB1c2VkIGZvciBhIG1vcmUgaG9uZXN0XHJcbiAgICAvLyBmaW5hbCBtZXNzYWdlIGluc3RlYWQgb2YgdGhlIG1pc2xlYWRpbmcgXCJBcHBsaWNhdGlvbiBub3QgZm91bmRcIi5cclxuICAgIGxldCBsb2FkRmFpbHVyZTogc3RyaW5nIHwgbnVsbCA9IG51bGw7XHJcbiAgICAvLyBEZXRhaWwgZXJyb3IgYXNsaW55YSAocGVzYW4gZXNidWlsZC9ydW50aW1lKSBcdTIwMTQgZGlwYWthaSB1bnR1ayBwb3B1cCBkZXNrdG9wXHJcbiAgICAvLyBiaWFyIHNwZXNpZmlrLCBidWthbiBzZWthZGFyIGthdGVnb3JpIFwidHJhbnNwaWxlIGZhaWxlZFwiLlxyXG4gICAgbGV0IGxvYWRFcnJvckRldGFpbDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XHJcblxyXG4gICAgLy8gLS0tIFNUUkFURUdJIEJBUlU6IERpcmVjdCBNZW1vcnkgRXhlY3V0aW9uIChUYW5wYSAudmZzX2NhY2hlKSAtLS1cclxuICAgIGlmICghZmluYWxBcHBQYXRoICYmIChkYXRhIGFzIGFueSkuYXBwQ29udGVudCAmJiBNb2R1bGUpIHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBsZXQgY29udGVudCA9IChkYXRhIGFzIGFueSkuYXBwQ29udGVudDtcclxuICAgICAgICAgICAgY29uc3QgaXNUeXBlU2NyaXB0ID0gIShhcHBQYXRoIHx8IGFwcE5hbWUgfHwgXCJcIikudG9Mb3dlckNhc2UoKS5lbmRzV2l0aChcIi5qc1wiKTtcclxuICAgICAgICAgICAgLy8gTW9kdWxlIGZpbGVuYW1lIEhBUlVTIHBoeXNpY2FsIHBhdGggdW50dWsgcmVxdWlyZSgpIG5lbXUgbm9kZV9tb2R1bGVzXHJcbiAgICAgICAgICAgIGNvbnN0IG1vZHVsZUZpbGVuYW1lID0gcGF0aCEuam9pbihwcm9jZXNzLmN3ZCgpLCBhcHBOYW1lICsgXCIuanNcIik7XHJcbiAgICAgICAgICAgIC8vIFN0YWNrIGZpbGVuYW1lID0gQktGUyBwYXRoIGJpYXIgc3RhY2sgdHJhY2UgYmVuZXIgKC9vcHQvdGVzdC9ndWktdGVzdC5qcylcclxuICAgICAgICAgICAgLy8gc3RhY2tCa2ZzUGF0aCA9IEJLRlMgcGF0aCB1bnR1ayBzdGFjayB0cmFjZSAoL29wdC90ZXN0L2d1aS10ZXN0LmpzKVxyXG4gICAgICAgICAgICBjb25zdCBzdGFja0JrZnNQYXRoID0gKGRhdGEgYXMgYW55KS5zdGFja0JrZnNQYXRoO1xyXG4gICAgICAgICAgICBjb25zdCBzdGFja0ZpbGVuYW1lID0gc3RhY2tCa2ZzUGF0aFxyXG4gICAgICAgICAgICAgICAgPyBzdGFja0JrZnNQYXRoLnJlcGxhY2UoL1xcLnRzJC8sICcuanMnKVxyXG4gICAgICAgICAgICAgICAgOiBtb2R1bGVGaWxlbmFtZTtcclxuICAgICAgICAgICAgLy8gc291cmNlZmlsZSB1bnR1ayBlc2J1aWxkIHNvdXJjZW1hcCBcdTIwMTQgY3VrdXAgbmFtYSBmaWxlIGFqYSAodGFucGEgcGF0aClcclxuICAgICAgICAgICAgY29uc3Qgc291cmNlRmlsZU5hbWUgPSAoc3RhY2tCa2ZzUGF0aCB8fCBtb2R1bGVGaWxlbmFtZSkuc3BsaXQoL1tcXFxcL10vKS5wb3AoKSEucmVwbGFjZSgvXFwuanMkLywgJy50cycpO1xyXG5cclxuICAgICAgICAgICAgLy8gSmlrYSBjb250ZW50IGFkYWxhaCBUeXBlU2NyaXB0LCB0cmFuc3BpbGUgZHVsdSBrZSBKYXZhU2NyaXB0XHJcbiAgICAgICAgICAgIGlmIChpc1R5cGVTY3JpcHQpIHtcclxuICAgICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgZXNidWlsZCA9IGhvc3RSZXF1aXJlIShcImVzYnVpbGRcIik7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gZXNidWlsZC50cmFuc2Zvcm1TeW5jKGNvbnRlbnQsIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgbG9hZGVyOiBcInRzXCIsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGZvcm1hdDogXCJjanNcIixcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGFyZ2V0OiBcIm5vZGUxOFwiLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBzb3VyY2VtYXA6IFwiaW5saW5lXCIsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHNvdXJjZWZpbGU6IHNvdXJjZUZpbGVOYW1lLFxyXG4gICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnRlbnQgPSByZXN1bHQuY29kZTtcclxuICAgICAgICAgICAgICAgIH0gY2F0Y2ggKHRyYW5zcGlsZUVycjogYW55KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgbG9hZEZhaWx1cmUgPSBcInRyYW5zcGlsZSBmYWlsZWRcIjtcclxuICAgICAgICAgICAgICAgICAgICBsb2FkRXJyb3JEZXRhaWwgPSBgVFMgVHJhbnNwaWxlIEVycm9yOiAke3RyYW5zcGlsZUVyci5tZXNzYWdlfWA7XHJcbiAgICAgICAgICAgICAgICAgICAgZW1pdFdvcmtlckVycm9yKGxpYiwgcGlkLCBgVFMgVHJhbnNwaWxlIEVycm9yOiAke3RyYW5zcGlsZUVyci5tZXNzYWdlfWApO1xyXG4gICAgICAgICAgICAgICAgICAgIHRocm93IHRyYW5zcGlsZUVycjtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgLy8gQ3JlYXRlIGEgbmV3IG1vZHVsZSBpbnN0YW5jZSB3aXRoIHBoeXNpY2FsIHBhdGggKGZvciBub2RlX21vZHVsZXMgcmVzb2x1dGlvbilcclxuICAgICAgICAgICAgY29uc3QgYXBwTW9kdWxlID0gbmV3IE1vZHVsZShtb2R1bGVGaWxlbmFtZSwgbW9kdWxlLnBhcmVudCk7XHJcbiAgICAgICAgICAgIGFwcE1vZHVsZS5maWxlbmFtZSA9IHN0YWNrRmlsZW5hbWU7ICAvLyBfX2ZpbGVuYW1lIHNob3dzIEJLRlMgcGF0aFxyXG4gICAgICAgICAgICBhcHBNb2R1bGUucGF0aHMgPSBNb2R1bGUuX25vZGVNb2R1bGVQYXRocyhwYXRoIS5kaXJuYW1lKG1vZHVsZUZpbGVuYW1lKSk7XHJcblxyXG4gICAgICAgICAgICAvLyBfY29tcGlsZSBkZW5nYW4gc3RhY2tGaWxlbmFtZSBhZ2FyIHN0YWNrIHRyYWNlIG51bmp1ayBCS0ZTIHBhdGhcclxuICAgICAgICAgICAgKGFwcE1vZHVsZSBhcyBhbnkpLl9jb21waWxlKGNvbnRlbnQsIHN0YWNrRmlsZW5hbWUpO1xyXG5cclxuICAgICAgICAgICAgQXBwQ2xhc3MgPSBhcHBNb2R1bGUuZXhwb3J0cy5tYWluIHx8IGFwcE1vZHVsZS5leHBvcnRzLk1haW4gfHwgYXBwTW9kdWxlLmV4cG9ydHMuZGVmYXVsdCB8fCBhcHBNb2R1bGUuZXhwb3J0cztcclxuXHJcbiAgICAgICAgICAgIC8vIEppa2EgbWFzaWggYmVsdW0ga2V0ZW11IChlLmcuIGV4cG9ydCBjbGFzcyBidWthbiBkZWZhdWx0L21haW4pXHJcbiAgICAgICAgICAgIGlmICh0eXBlb2YgQXBwQ2xhc3MgIT09ICdmdW5jdGlvbicpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGVudHJpZXMgPSBPYmplY3QuZW50cmllcyhhcHBNb2R1bGUuZXhwb3J0cyk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBmb3VuZCA9IGVudHJpZXMuZmluZCgoW18sIHZhbF06IFtzdHJpbmcsIGFueV0pID0+IHR5cGVvZiB2YWwgPT09ICdmdW5jdGlvbicpO1xyXG4gICAgICAgICAgICAgICAgaWYgKGZvdW5kKSBBcHBDbGFzcyA9IGZvdW5kWzFdO1xyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICBpZiAoQXBwQ2xhc3MpIHtcclxuICAgICAgICAgICAgICAgIC8vIGNvbnNvbGUubG9nKGBbV29ya2VyICR7cGlkfV0gRGlyZWN0IE1lbW9yeSBFeGVjdXRpb24gc3VjY2VzcyBmb3IgJHthcHBOYW1lfWApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyOiBhbnkpIHtcclxuICAgICAgICAgICAgaWYgKCFsb2FkRmFpbHVyZSkgbG9hZEZhaWx1cmUgPSBcImRpcmVjdCBleGVjdXRpb24gZmFpbGVkXCI7XHJcbiAgICAgICAgICAgIGlmICghbG9hZEVycm9yRGV0YWlsKSBsb2FkRXJyb3JEZXRhaWwgPSBgRGlyZWN0IEV4ZWN1dGlvbiBFcnJvcjogJHtlcnIubWVzc2FnZX1gO1xyXG4gICAgICAgICAgICBlbWl0V29ya2VyRXJyb3IobGliLCBwaWQsIGBEaXJlY3QgRXhlY3V0aW9uIEVycm9yOiAke2Vyci5tZXNzYWdlfWApO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcblxyXG4gICAgaWYgKGZpbmFsQXBwUGF0aCAmJiBob3N0UmVxdWlyZSkge1xyXG4gICAgICAgIC8vIFNUUkFURUdJIEJBUlU6IER5bmFtaWMgTG9hZGluZyBkYXJpIEZpbGUgRmlzaWsgKExpbnV4LWxpa2UpXHJcbiAgICAgICAgLy8gU1RSQVRFR0k6IER5bmFtaWMgTG9hZGluZyBkYXJpIEZpbGUgRmlzaWsgKEp1anVyIFBha2UgLnRzKVxyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG1vZHVsZSA9IGhvc3RSZXF1aXJlKGZpbmFsQXBwUGF0aCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGVudHJpZXMgPSBPYmplY3QuZW50cmllcyhtb2R1bGUpO1xyXG5cclxuICAgICAgICAgICAgLy8gW0RFQlVHXSBDaGVjayB3aGF0IHdlIGZvdW5kXHJcbiAgICAgICAgICAgIC8vIGNvbnNvbGUubG9nKGBbV29ya2VyICR7cGlkfV0gTG9hZGVkIG1vZHVsZSBmb3IgJHthcHBOYW1lfS4gS2V5czogJHtPYmplY3Qua2V5cyhtb2R1bGUpLmpvaW4oXCIsIFwiKX1gKTtcclxuXHJcbiAgICAgICAgICAgIC8vIFNUUkFURUdJIFNUQU5EQVI6IENhcmkgZXhwb3J0IGJlcm5hbWEgJ21haW4nXHJcbiAgICAgICAgICAgIGlmIChtb2R1bGUubWFpbikge1xyXG4gICAgICAgICAgICAgICAgQXBwQ2xhc3MgPSBtb2R1bGUubWFpbjtcclxuICAgICAgICAgICAgfSBlbHNlIGlmIChtb2R1bGUuTWFpbikge1xyXG4gICAgICAgICAgICAgICAgQXBwQ2xhc3MgPSBtb2R1bGUuTWFpbjtcclxuICAgICAgICAgICAgfSBlbHNlIGlmIChtb2R1bGUuZGVmYXVsdCkge1xyXG4gICAgICAgICAgICAgICAgQXBwQ2xhc3MgPSBtb2R1bGUuZGVmYXVsdDtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIC8vIEZhbGxiYWNrOiBBbWJpbCBleHBvcnQgcGVydGFtYSB5YW5nIGJlcnVwYSBjbGFzcy9mdW5jdGlvblxyXG4gICAgICAgICAgICAgICAgY29uc3QgZm91bmQgPSBlbnRyaWVzLmZpbmQoKFtfLCB2YWxdOiBbc3RyaW5nLCBhbnldKSA9PiB0eXBlb2YgdmFsID09PSAnZnVuY3Rpb24nKTtcclxuICAgICAgICAgICAgICAgIGlmIChmb3VuZCkgQXBwQ2xhc3MgPSBmb3VuZFsxXTtcclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgaWYgKEFwcENsYXNzKSB7XHJcbiAgICAgICAgICAgICAgICAvLyBjb25zb2xlLmxvZyhgW1dvcmtlciAke3BpZH1dIElkZW50aWZpZWQgQXBwQ2xhc3MgZm9yICR7YXBwTmFtZX1gKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIGxvYWRGYWlsdXJlID0gXCJubyB2YWxpZCAnbWFpbicgZXhwb3J0IGZvdW5kXCI7XHJcbiAgICAgICAgICAgICAgICBsb2FkRXJyb3JEZXRhaWwgPSBgRmFpbGVkIHRvIGlkZW50aWZ5IEFwcENsYXNzIGZvciAke2FwcE5hbWV9LiBNb2R1bGUgZXhwb3J0czogJHtPYmplY3Qua2V5cyhtb2R1bGUpLmpvaW4oXCIsIFwiKX1gO1xyXG4gICAgICAgICAgICAgICAgZW1pdFdvcmtlckVycm9yKGxpYiwgcGlkLCBgRmFpbGVkIHRvIGlkZW50aWZ5IEFwcENsYXNzIGZvciAke2FwcE5hbWV9LiBNb2R1bGUgZXhwb3J0czogJHtPYmplY3Qua2V5cyhtb2R1bGUpLmpvaW4oXCIsIFwiKX1gKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0gY2F0Y2ggKGVycjogYW55KSB7XHJcbiAgICAgICAgICAgIGxvYWRGYWlsdXJlID0gXCJmYWlsZWQgdG8gbG9hZCBtb2R1bGVcIjtcclxuICAgICAgICAgICAgbG9hZEVycm9yRGV0YWlsID0gYFJ1bnRpbWUgRXJyb3I6IEZhaWxlZCB0byByZXF1aXJlICR7ZmluYWxBcHBQYXRoIHx8IGFwcE5hbWV9OiAke2Vyci5tZXNzYWdlfWA7XHJcbiAgICAgICAgICAgIGVtaXRXb3JrZXJFcnJvcihsaWIsIHBpZCwgYFJ1bnRpbWUgRXJyb3I6IEZhaWxlZCB0byByZXF1aXJlICR7ZmluYWxBcHBQYXRoIHx8IGFwcE5hbWV9OiAke2Vyci5tZXNzYWdlfWApO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICB9XHJcblxyXG5cclxuICAgIGlmICghQXBwQ2xhc3MpIHtcclxuICAgICAgICBpZiAocGFyZW50UG9ydCkge1xyXG4gICAgICAgICAgICBjb25zdCBlcnJvck1zZyA9IGxvYWRGYWlsdXJlXHJcbiAgICAgICAgICAgICAgICA/IGAtYmFzaDogJHthcHBOYW1lfTogRmFpbGVkIHRvIGxvYWQgXHUyMDE0ICR7bG9hZEZhaWx1cmV9XFxuYFxyXG4gICAgICAgICAgICAgICAgOiBgLWJhc2g6ICR7YXBwTmFtZX06IEFwcGxpY2F0aW9uIG5vdCBmb3VuZCAoUGF0aDogJHthcHBQYXRoIHx8ICdWRlMtT25seSd9KVxcbmA7XHJcbiAgICAgICAgICAgIGF3YWl0IGxpYi5zdGQucHJpbnQoZXJyb3JNc2cpO1xyXG4gICAgICAgICAgICBwYXJlbnRQb3J0LnBvc3RNZXNzYWdlKHtcclxuICAgICAgICAgICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxyXG4gICAgICAgICAgICAgICAgZXJyb3I6IGVycm9yTXNnLnRyaW0oKVxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgLy8gVGFtcGlsa2FuIGp1Z2EgZGkgZGVza3RvcCAoV00vQXN0ZXJhY2VhKSB2aWEgR1VJX1dJTkRPV19FUlJPUi5cclxuICAgICAgICAgICAgLy8gV0FKSUIgZGktYXdhaXQ6IHJlYWxFeGl0KDEpIGRpIGJhd2FoIGxhbmdzdW5nIG1lbWF0aWthbiB3b3JrZXIsIGRhblxyXG4gICAgICAgICAgICAvLyBrYWxhdSBmaXJlLWFuZC1mb3JnZXQsIGtpcmltYW4gYXN5bmMtbnlhIHRhayBzZW1wYXQgc2VsZXNhaS5cclxuICAgICAgICAgICAgLy8gUG9wdXAgcGFrYWkgZGV0YWlsIGVycm9yIGFzbGkgKGxvYWRFcnJvckRldGFpbCkgYmlhciBzcGVzaWZpay5cclxuICAgICAgICAgICAgYXdhaXQgbm90aWZ5TG9hZEVycm9yKGxpYiwgcGlkLCBhcHBOYW1lLCBsb2FkRXJyb3JEZXRhaWwgfHwgZXJyb3JNc2cudHJpbSgpKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmVhbEV4aXQoMSk7XHJcbiAgICB9XHJcblxyXG5cclxuXHJcbiAgICAvLyAzLiBBS1RJRktBTiBTQU5EQk9YIChLdW5jaSBwaW50dSBzZWJlbHVtIGFwbGlrYXNpIGJlcmphbGFuKVxyXG4gICAgcmVzdHJpY3RIb3N0QVBJKGFwcE5hbWUpO1xyXG5cclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgYXBwID0gbmV3IEFwcENsYXNzKCk7XHJcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYXBwLmV4ZWN1dGUobGliIGFzIGFueSwgYXJncyk7XHJcblxyXG5cclxuXHJcblxyXG4gICAgICAgIC8vIDMuIEppa2EgYXBsaWthc2kgbWUtcmV0dXJuIHN0cmluZywgY2V0YWsga2UgbGF5YXIgdmlhIFBSSU5UIHN5c2NhbGxcclxuICAgICAgICBpZiAocmVzdWx0ICYmIHR5cGVvZiByZXN1bHQgPT09IFwic3RyaW5nXCIgJiYgcmVzdWx0LnRyaW0oKSAhPT0gXCJcIikge1xyXG4gICAgICAgICAgICBhd2FpdCBsaWIuc3RkLnByaW50KHJlc3VsdCArIFwiXFxuXCIpO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgLy8gNC4gQmVyaXRhaHUgS2VybmVsIGJhaHdhIHByb3NlcyBzZWxlc2FpXHJcbiAgICAgICAgYXdhaXQgbGliLnNoZWxsLmV4aXQoMCk7XHJcbiAgICB9IGNhdGNoIChlcnJvcjogYW55KSB7XHJcbiAgICAgICAgLy8gTGFwb3JrYW4gZXJyb3Iga2UgcGFyZW50IChXTSkgdmlhIElQQ1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHBhcmVudFBpZCA9IGF3YWl0IGxpYi5nZXRQYXJlbnRQaWQoKTtcclxuICAgICAgICAgICAgaWYgKHBhcmVudFBpZCkge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgbGliLnNoZWxsLnNlbmQocGFyZW50UGlkLCB7XHJcbiAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJHVUlfV0lORE9XX0VSUk9SXCIsXHJcbiAgICAgICAgICAgICAgICAgICAgd2lkOiBcIlwiLFxyXG4gICAgICAgICAgICAgICAgICAgIHBpZDogbGliLmdldFBpZCgpLFxyXG4gICAgICAgICAgICAgICAgICAgIGZpbGU6IGFwcE5hbWUgfHwgXCJcIixcclxuICAgICAgICAgICAgICAgICAgICBlcnJvcjogYFJ1bnRpbWUgRXJyb3I6ICR7ZXJyb3IubWVzc2FnZX1gLFxyXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQ6IFwicnVudGltZVwiLFxyXG4gICAgICAgICAgICAgICAgICAgIHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLnJlcGxhY2UoJ1QnLCAnICcpLnN1YnN0cmluZygwLCAxOSksXHJcbiAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0gY2F0Y2ggKF8pIHsgLyogSVBDIHNlbmQgZmFpbHVyZSBpcyBub24tZmF0YWwgKi8gfVxyXG5cclxuICAgICAgICAvLyBKdWdhIGNvYmEgbGV3YXQgc3RkLmVycm9yIHlhbmcgcHVueWEgbWVrYW5pc21lIGxlYmloIGxlbmdrYXBcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBhd2FpdCBsaWIuc3RkLmVycm9yKGVycm9yLm1lc3NhZ2UgfHwgU3RyaW5nKGVycm9yKSwgYXBwTmFtZSB8fCBcImFwcFwiKTtcclxuICAgICAgICB9IGNhdGNoIChfKSB7IH1cclxuXHJcbiAgICAgICAgLy8gTGFwb3JrYW4gZXJyb3Iga2UgVFRZIGNvbnNvbGVcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBhd2FpdCBsaWIuc3RkLnByaW50KGBcXG5bV29ya2VyICR7cGlkfV0gUnVudGltZSBFcnJvcjogJHtlcnJvci5tZXNzYWdlfVxcbmApO1xyXG4gICAgICAgIH0gY2F0Y2ggKGUpIHsgfVxyXG4gICAgICAgIHJlYWxFeGl0KDEpO1xyXG4gICAgfVxyXG59XHJcblxyXG5tYWluKCk7XHJcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLDRCQUF1QztBQXNCdkMsTUFBTSxXQUFXLFFBQVEsS0FBSyxLQUFLLE9BQU87QUFLMUMsTUFBTSxjQUFjLE9BQU8sWUFBWSxjQUFjLFVBQVU7QUFDL0QsTUFBTSxPQUFPLGNBQWMsWUFBWSxNQUFNLElBQUk7QUFDakQsTUFBTSxTQUFTLGNBQWMsWUFBWSxRQUFRLElBQUk7QUFFckQsSUFBSSxVQUFVLE1BQU07QUFDaEIsUUFBTSxlQUFlLE9BQU87QUFDNUIsUUFBTSxXQUFZLGlDQUFtQixZQUFZLENBQUM7QUFDbEQsUUFBTSxjQUFtQyxDQUFDO0FBRTFDLFNBQU8sUUFBUSxTQUFVLFNBQWlCLFFBQWEsUUFBaUI7QUFDcEUsUUFBSSxvQkFBb0I7QUFHeEIsUUFBSSxRQUFRLFdBQVcsR0FBRyxHQUFHO0FBQ3pCLFVBQUksUUFBUSxTQUFTLFVBQVUsR0FBRztBQUM5Qiw0QkFBb0IsYUFBYSxRQUFRLE1BQU0sVUFBVSxFQUFFLENBQUM7QUFBQSxNQUNoRSxXQUFXLFFBQVEsU0FBUyxPQUFPLEdBQUc7QUFDbEMsNEJBQW9CLFdBQVcsUUFBUSxNQUFNLE9BQU8sRUFBRSxDQUFDO0FBQUEsTUFDM0QsV0FBVyxVQUFVLE9BQU8sVUFBVTtBQUNsQyxj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
