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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiV29ya2VyRW50cnkudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IHdvcmtlckRhdGEsIHBhcmVudFBvcnQgfSBmcm9tIFwid29ya2VyX3RocmVhZHNcIjtcclxuaW1wb3J0IHsgV29ya2VySW5pdERhdGEsIFN5c2NhbGxSZXNwb25zZSB9IGZyb20gXCIuLi9jb21tb24vSVBDVHlwZXNcIjtcclxuaW1wb3J0IHsgY29sbGVjdFJlbGF0aXZlTW9kdWxlcywgcmVzb2x2ZVZmc1JlbGF0aXZlIH0gZnJvbSBcIi4vVmZzTW9kdWxlUmVzb2x2ZXJcIjtcclxuXHJcbi8qKlxyXG4gKiBCeXRlIFZGUyAobGF0aW4xKSBcdTIxOTIgdGVrcyB1bnR1ayBkaWtvbXBpbGFzaS5cclxuICpcclxuICogRElTQUxJTiBMT0tBTCwgc2VuZ2FqYSBUSURBSyBkaS1gaW1wb3J0YCBkYXJpIGBAY29tbW9uL1Zmc1RleHRgOiBiZXJrYXMgaW5pIGFkYWxhaFxyXG4gKiAqd29ya2VyIGVudHJ5KiB5YW5nIGRpamFsYW5rYW4gZGkgSE9TVCwgZGFuIHdvcmtlciBqYWx1ciAqKkpTLURpcmVjdCoqIChtaXMuXHJcbiAqIGAvYmluL3RzaC5qc2ApIHNlbmdhamEgZGlqYWxhbmthbiBUQU5QQSBwcmVsb2FkIHRyYW5zcGlsZXIgXHUyMDE0IGphZGkgYHJlcXVpcmUoKWAga2VcclxuICogYmVya2FzIGAudHNgIEdBR0FMOlxyXG4gKlxyXG4gKiAgICAgV29ya2VyIFsyXSBDcmFzaCBFcnJvcjogQ2Fubm90IGZpbmQgbW9kdWxlICcuLi9jb21tb24vVmZzVGV4dCdcclxuICogICAgIFx1MjE5MiB3b3JrZXIgbWF0aSBzZWJlbHVtIG1lbmdpcmltICdyZWFkeScgXHUyMTkyIGJvb3QgZGlhbSBkaSAvZXRjL3JjLmxvY2FsXHJcbiAqXHJcbiAqIChgLi4vY29tbW9uL0lQQ1R5cGVzYCBhbWFuIGthcmVuYSBzaWRlY2FyIGAuanNgLW55YSBhZGEgZGkgcmVwbzsgYFZmc1RleHQudHNgIGJhcnVcclxuICogdGlkYWsgcHVueWEuKSBJbXBsZW1lbnRhc2lueWEgc2F0dSBiYXJpcywgamFkaSBkdXBsaWthc2kgaW5pIGxlYmloIG11cmFoIGRhcmlwYWRhXHJcbiAqIG1lbWFrc2EgSlMtRGlyZWN0IG1lbXVhdCB0cmFuc3BpbGVyIGAudHNgICgrfjE1IE1CIFJTUyBwZXIgd29ya2VyKS5cclxuICovXHJcbmNvbnN0IHZmc0J5dGVzVG9VdGY4ID0gKHJhdzogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCk6IHN0cmluZyA9PlxyXG4gICAgcmF3ID09PSBudWxsIHx8IHJhdyA9PT0gdW5kZWZpbmVkID8gXCJcIiA6IEJ1ZmZlci5mcm9tKHJhdywgXCJsYXRpbjFcIikudG9TdHJpbmcoXCJ1dGY4XCIpO1xyXG5cclxuLyoqXHJcbiAqIFBhdGggUElEIGZpbGUgQXN0ZXJhY2VhIFdNLlxyXG4gKlxyXG4gKiBESVNBTElOIGRhcmkgYHNyYy9jb21tb24vQXN0ZXJhY2VhUGF0aHMudHNgIChgQVNURVJBQ0VBX1dNX1BJRF9GSUxFYCkga2FyZW5hXHJcbiAqIGFsYXNhbiB5YW5nIHNhbWEgZGVuZ2FuIGB2ZnNCeXRlc1RvVXRmOGAgZGkgYXRhczogYmVya2FzIGluaSBkaS1yZXF1aXJlKCkgZGlcclxuICogSE9TVCBvbGVoIHdvcmtlciBqYWx1ciBKUy1EaXJlY3QsIGphZGkgaGFueWEgYm9sZWggYmVyZ2FudHVuZyBwYWRhIGJlcmthcyB5YW5nXHJcbiAqIHB1bnlhIHNpZGVjYXIgYC5qc2AgZGkgcmVwby5cclxuICovXHJcbmNvbnN0IFdNX1BJRF9GSUxFID0gXCIvdmFyL3J1bi9hc3RlcmFjZWEvd20tcGlkXCI7XHJcblxyXG4vKipcclxuICogV09SS0VSIEVOVFJZIFBPSU5UXHJcblxyXG4gKiBcclxuICogSW5pIGFkYWxhaCBzY3JpcHQgXCJCb290bG9hZGVyXCIgeWFuZyBqYWxhbiBkaSBkYWxhbSBXb3JrZXIgVGhyZWFkLlxyXG4gKiBUdWdhc255YTogSW5pc2lhbGlzYXNpIFVzZXJMaWIgZGFuIGphbGFua2FuIGFwbGlrYXNpLlxyXG4gKi9cclxuXHJcbi8vIHRzY29uZmlnLXBhdGhzIGRhbiBlc2J1aWxkLXJlZ2lzdGVyIHN1ZGFoIGRpLWxvYWQgdmlhIGV4ZWNBcmd2IGRpIFNjaGVkdWxlci50c1xyXG5cclxuY29uc3QgcmVhbEV4aXQgPSBwcm9jZXNzLmV4aXQuYmluZChwcm9jZXNzKTtcclxuXHJcbi8vIC0tLSBQRVJGT1JNQU5DRSBISUpBQ0sgLS0tXHJcbi8vIFByZS1sb2FkIGNvcmUgbGlicmFyaWVzIGFuZCBoaWphY2sgcmVxdWlyZSB0byBhdm9pZCBtdWx0aXBsZSBGUyBoaXRzXHJcbi8vIGluIHRoZSBoaWdoLXBlcmZvcm1hbmNlIHBhdGguXHJcbmNvbnN0IGhvc3RSZXF1aXJlID0gdHlwZW9mIHJlcXVpcmUgIT09IFwidW5kZWZpbmVkXCIgPyByZXF1aXJlIDogbnVsbDtcclxuY29uc3QgcGF0aCA9IGhvc3RSZXF1aXJlID8gaG9zdFJlcXVpcmUoXCJwYXRoXCIpIDogbnVsbDtcclxuY29uc3QgTW9kdWxlID0gaG9zdFJlcXVpcmUgPyBob3N0UmVxdWlyZShcIm1vZHVsZVwiKSA6IG51bGw7XHJcblxyXG4vKipcclxuICogcmVzb2x2ZVJlbGF0aXZlTW9kdWxlSWQoKTogTWVuZXJqZW1haGthbiBpbXBvcnQgcmVsYXRpZiBNSUxJSyBNT0RVTFxyXG4gKiBGUkFNRVdPUksga2UgbW9kdWxlLWlkIChgQHRzaXgveGAsIGBAY29tbW9uL2EvYmApLlxyXG4gKlxyXG4gKiBLZW5hcGEgcGVybHU6IFdvcmtlckVudHJ5IG1lLV9jb21waWxlKCkgbW9kdWwgZnJhbWV3b3JrIGRhcmkgbWVtb3J5IGRlbmdhblxyXG4gKiBuYW1hIGZpbGUgYnVhdGFuIChgQGNvbW1vbl9uZXRmcy9OZXRGU1NlcnZlci5qc2ApLCBqYWRpIGAuL05ldEZTUHJvdG9jb2xgXHJcbiAqIGhhbnlhIGJpc2EgZGktcmVzb2x2ZSBrYWxhdSBraXRhIHRhaHUgaWQgbW9kdWwgaW5kdWtueWEuIENhcmEgbGFtYSBtZW1ha2FpXHJcbiAqIGBwYXRoLmJhc2VuYW1lKHBhcmVudC5maWxlbmFtZSlgOlxyXG4gKlxyXG4gKiAgIC0gYEB0c2l4X0FwcGxpY2F0aW9uLmpzYCAgICAgIFx1MjE5MiBiYXNlbmFtZSBjb2NvaywgYC4veGAgXHUyMTkyIGBAdHNpeC94YCAgIFx1MjcwNVxyXG4gKiAgIC0gYE5ldEZTU2VydmVyLmpzYCAoYmVyc2FyYW5nKSBcdTIxOTIgYmFzZW5hbWUgVElEQUsgY29jb2ssIGAuL05ldEZTUHJvdG9jb2xgXHJcbiAqICAgICBkaWJpYXJrYW4gYXBhIGFkYW55YSBcdTIxOTIgYENhbm5vdCBmaW5kIG1vZHVsZSAnLi9OZXRGU1Byb3RvY29sJ2AgIFx1Mjc0Q1xyXG4gKlxyXG4gKiBEZW5nYW4gcmVzb2x1c2kgZGkgcnVhbmcgbW9kdWxlLWlkLCBrZWRhbGFtYW4gYmVyYXBhIHB1biB0ZXRhcCBiZW5hcjpcclxuICogICBgQGNvbW1vbi9uZXRmcy9OZXRGU1NlcnZlcmAgKyBgLi9OZXRGU1Byb3RvY29sYCBcdTIxOTIgYEBjb21tb24vbmV0ZnMvTmV0RlNQcm90b2NvbGBcclxuICogICBgQGNvbW1vbi9uZXRmcy9OZXRGU1NlcnZlcmAgKyBgLi4vTG9nZ2VyYCAgICAgICBcdTIxOTIgYEBjb21tb24vTG9nZ2VyYFxyXG4gKi9cclxuZnVuY3Rpb24gcmVzb2x2ZVJlbGF0aXZlTW9kdWxlSWQocGFyZW50SWQ6IHN0cmluZywgcmVxdWVzdDogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIGNvbnN0IHBhcnRzID0gcGFyZW50SWQuc3BsaXQoXCIvXCIpO1xyXG4gICAgcGFydHMucG9wKCk7IC8vIGJ1YW5nIG5hbWEgbW9kdWwgaW5kdWtcclxuICAgIGZvciAoY29uc3Qgc2VnIG9mIHJlcXVlc3Quc3BsaXQoXCIvXCIpKSB7XHJcbiAgICAgICAgaWYgKHNlZyA9PT0gXCJcIiB8fCBzZWcgPT09IFwiLlwiKSBjb250aW51ZTtcclxuICAgICAgICBpZiAoc2VnID09PSBcIi4uXCIpIHtcclxuICAgICAgICAgICAgLy8gU2lzYWthbiBzZWdtZW4gc2NvcGUgKGBAdHNpeGAgLyBgQGNvbW1vbmApIFx1MjAxNCBqYW5nYW4gcGVybmFoIGhhYmlzLlxyXG4gICAgICAgICAgICBpZiAocGFydHMubGVuZ3RoID4gMSkgcGFydHMucG9wKCk7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBwYXJ0cy5wdXNoKHNlZyk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcGFydHMuam9pbihcIi9cIik7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBNT0RVTCBSRUxBVElGIE1JTElLIFBST0dSQU0gVkZTIChtaXMuIGAvc2Jpbi90cGtnZGAgKyBgLi9UcGtnUHJvdG9jb2xgKS5cclxuICpcclxuICogYE1vZHVsZS5fbG9hZGAgc2lua3Jvbiwgc2VkYW5na2FuIGJhY2EgVkZTIGFzaW5rcm9uIFx1MjAxNCBqYWRpIGlzaW55YSBkaWt1bXB1bGthblxyXG4gKiBsZWJpaCBkdWx1IGRpIGBtYWluKClgIChsaWhhdCBgY29sbGVjdFJlbGF0aXZlTW9kdWxlc2ApLCBsYWx1IGhvb2sgZGkgYmF3YWhcclxuICogaGFueWEgTUVMSUhBVCBwZXRhIGluaTogaWQgbW9kdWxlIChgL3NiaW4vVHBrZ1Byb3RvY29sYCkgXHUyMTkyIGtvZGUgSlMuXHJcbiAqXHJcbiAqIER1bHUgaW1wb3J0IHNlc2FtYSBkaXJla3RvcmkgdGlkYWsgZGlkdWt1bmcgc2FtYSBzZWthbGkgKHNlbGFsdSBqYXR1aCBrZSBob3N0XHJcbiAqIGZpbGVzeXN0ZW0gXHUyMTkyIFwiQ2Fubm90IGZpbmQgbW9kdWxlICcuL1Rwa2dQcm90b2NvbCdcIikuXHJcbiAqL1xyXG5sZXQgcHJvZ3JhbU1vZHVsZXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcclxuXHJcbmlmIChNb2R1bGUgJiYgcGF0aCkge1xyXG4gICAgY29uc3Qgb3JpZ2luYWxMb2FkID0gTW9kdWxlLl9sb2FkO1xyXG4gICAgY29uc3QgdmZzQ2FjaGUgPSAod29ya2VyRGF0YSBhcyBhbnkpLnZmc0NhY2hlIHx8IHt9O1xyXG4gICAgY29uc3QgbW9kdWxlQ2FjaGU6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7fTtcclxuICAgIC8vIFBldGEgZHVtbXlGaWxlbmFtZSBcdTIxOTIgbW9kdWxlLWlkIChgQHRzaXgveGAsIGBAY29tbW9uL2EvYmApLiBEaXBha2FpIHVudHVrXHJcbiAgICAvLyBtZW5lcmplbWFoa2FuIGltcG9ydCBSRUxBVElGIG1pbGlrIG1vZHVsIGZyYW1ld29yayAobGloYXRcclxuICAgIC8vIHJlc29sdmVSZWxhdGl2ZU1vZHVsZUlkKS5cclxuICAgIGNvbnN0IG1vZHVsZUlkQnlGaWxlOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XHJcblxyXG4gICAgTW9kdWxlLl9sb2FkID0gZnVuY3Rpb24gKHJlcXVlc3Q6IHN0cmluZywgcGFyZW50OiBhbnksIGlzTWFpbjogYm9vbGVhbikge1xyXG4gICAgICAgIGxldCBub3JtYWxpemVkUmVxdWVzdCA9IHJlcXVlc3Q7XHJcblxyXG4gICAgICAgIC8vIFJlc29sdmUgcmVsYXRpdmUgcGF0aHNcclxuICAgICAgICBpZiAocmVxdWVzdC5zdGFydHNXaXRoKFwiLlwiKSkge1xyXG4gICAgICAgICAgICBpZiAocmVxdWVzdC5pbmNsdWRlcyhcIi9jb21tb24vXCIpKSB7XHJcbiAgICAgICAgICAgICAgICBub3JtYWxpemVkUmVxdWVzdCA9IFwiQGNvbW1vbi9cIiArIHJlcXVlc3Quc3BsaXQoXCIvY29tbW9uL1wiKVsxXTtcclxuICAgICAgICAgICAgfSBlbHNlIGlmIChyZXF1ZXN0LmluY2x1ZGVzKFwiL2xpYi9cIikpIHtcclxuICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRSZXF1ZXN0ID0gXCJAdHNpeC9cIiArIHJlcXVlc3Quc3BsaXQoXCIvbGliL1wiKVsxXTtcclxuICAgICAgICAgICAgfSBlbHNlIGlmIChwYXJlbnQgJiYgcGFyZW50LmZpbGVuYW1lKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBwYXJlbnRJZCA9IG1vZHVsZUlkQnlGaWxlW3BhcmVudC5maWxlbmFtZV07XHJcbiAgICAgICAgICAgICAgICBpZiAocGFyZW50SWQpIHtcclxuICAgICAgICAgICAgICAgICAgICAvLyBNb2R1bCBmcmFtZXdvcmsgeWFuZyBraXRhIG11YXQgc2VuZGlyaTogcmVzb2x1c2kgcmVsYXRpZlxyXG4gICAgICAgICAgICAgICAgICAgIC8vIGRpbGFrdWthbiBkaSBydWFuZyBtb2R1bGUtaWQgKGJlbmFyIHVudHVrIHNlbXVhIGtlZGFsYW1hbikuXHJcbiAgICAgICAgICAgICAgICAgICAgbm9ybWFsaXplZFJlcXVlc3QgPSByZXNvbHZlUmVsYXRpdmVNb2R1bGVJZChwYXJlbnRJZCwgcmVxdWVzdCk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgIC8vIFByb2dyYW0gVkZTIChidWthbiBtb2R1bCBmcmFtZXdvcmspOiBmaWxlbnlhIGJlcnVwYSBwYXRoIFZGU1xyXG4gICAgICAgICAgICAgICAgICAgIC8vIChgL3NiaW4vdHBrZ2QuanNgKS4gUmVzb2x1c2lrYW4gcmVsYXRpZiB0ZXJoYWRhcCBkaXJla3RvcmlueWEsXHJcbiAgICAgICAgICAgICAgICAgICAgLy8gbGFsdSBjYXJpIGRpIHBldGEgbW9kdWwgeWFuZyBzdWRhaCBkaWJhY2EgZGFyaSBWRlMuXHJcbiAgICAgICAgICAgICAgICAgICAgLy9cclxuICAgICAgICAgICAgICAgICAgICAvLyBVcnV0YW4gcGVudGluZzogY2FiYW5nIGAvbGliL2AgJiBgL2NvbW1vbi9gIGRpIGF0YXMgZGlkYWh1bHVrYW5cclxuICAgICAgICAgICAgICAgICAgICAvLyBzdXBheWEgYC4uL2xpYi94YCB0ZXRhcCBkaWxheWFuaSBjYWNoZSBmcmFtZXdvcmsuXHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgdmZzVGFyZ2V0ID0gcGFyZW50LmZpbGVuYW1lLnN0YXJ0c1dpdGgoXCIvXCIpXHJcbiAgICAgICAgICAgICAgICAgICAgICAgID8gcmVzb2x2ZVZmc1JlbGF0aXZlKHBhcmVudC5maWxlbmFtZSwgcmVxdWVzdClcclxuICAgICAgICAgICAgICAgICAgICAgICAgOiBudWxsO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmICh2ZnNUYXJnZXQgJiYgcHJvZ3JhbU1vZHVsZXNbdmZzVGFyZ2V0XSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBub3JtYWxpemVkUmVxdWVzdCA9IHZmc1RhcmdldDtcclxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBiYXNlbmFtZSA9IHBhdGghLmJhc2VuYW1lKHBhcmVudC5maWxlbmFtZSk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChiYXNlbmFtZS5zdGFydHNXaXRoKFwiQHRzaXhfXCIpICYmIHJlcXVlc3Quc3RhcnRzV2l0aChcIi4vXCIpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBub3JtYWxpemVkUmVxdWVzdCA9IFwiQHRzaXgvXCIgKyByZXF1ZXN0LnN1YnN0cmluZygyKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChiYXNlbmFtZS5zdGFydHNXaXRoKFwiQGNvbW1vbl9cIikgJiYgcmVxdWVzdC5zdGFydHNXaXRoKFwiLi9cIikpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRSZXF1ZXN0ID0gXCJAY29tbW9uL1wiICsgcmVxdWVzdC5zdWJzdHJpbmcoMik7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8vIENhY2hlZCBNb2R1bGVcclxuICAgICAgICBpZiAobW9kdWxlQ2FjaGVbbm9ybWFsaXplZFJlcXVlc3RdKSByZXR1cm4gbW9kdWxlQ2FjaGVbbm9ybWFsaXplZFJlcXVlc3RdO1xyXG5cclxuICAgICAgICAvLyBSZXNvbHVzaSBNZW1vcnkgRnJhbWV3b3JrIChWRlMpXHJcbiAgICAgICAgbGV0IHZmc1BhdGggPSBudWxsO1xyXG4gICAgICAgIGlmIChub3JtYWxpemVkUmVxdWVzdC5zdGFydHNXaXRoKFwiQHRzaXgvXCIpKSB7XHJcbiAgICAgICAgICAgIHZmc1BhdGggPSBcIi9saWIvXCIgKyBub3JtYWxpemVkUmVxdWVzdC5zdWJzdHJpbmcoNikgKyBcIi50c1wiO1xyXG4gICAgICAgIH0gZWxzZSBpZiAobm9ybWFsaXplZFJlcXVlc3Quc3RhcnRzV2l0aChcIkBjb21tb24vXCIpKSB7XHJcbiAgICAgICAgICAgIHZmc1BhdGggPSBcIi9saWIvY29tbW9uL1wiICsgbm9ybWFsaXplZFJlcXVlc3Quc3Vic3RyaW5nKDgpICsgXCIudHNcIjtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8vIE1vZHVsIHJlbGF0aWYgbWlsaWsgcHJvZ3JhbSAocGV0YSBkYXJpIGBjb2xsZWN0UmVsYXRpdmVNb2R1bGVzYCkuXHJcbiAgICAgICAgLy8gSWQtbnlhIHN1ZGFoIHRhbnBhIGVrc3RlbnNpLCBqYWRpIGRpY2FyaSBsYW5nc3VuZy5cclxuICAgICAgICBpZiAoIXZmc1BhdGggJiYgcHJvZ3JhbU1vZHVsZXNbbm9ybWFsaXplZFJlcXVlc3RdKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGNvbnRlbnQgPSBwcm9ncmFtTW9kdWxlc1tub3JtYWxpemVkUmVxdWVzdF07XHJcbiAgICAgICAgICAgIGNvbnN0IGR1bW15RmlsZW5hbWUgPSBwYXRoIS5qb2luKHByb2Nlc3MuY3dkKCksIG5vcm1hbGl6ZWRSZXF1ZXN0LnJlcGxhY2UoL1xcLy9nLCBcIl9cIikgKyBcIi5qc1wiKTtcclxuXHJcbiAgICAgICAgICAgIGNvbnN0IG5ld01vZCA9IG5ldyBNb2R1bGUoZHVtbXlGaWxlbmFtZSwgcGFyZW50KTtcclxuICAgICAgICAgICAgbmV3TW9kLmZpbGVuYW1lID0gZHVtbXlGaWxlbmFtZTtcclxuICAgICAgICAgICAgbmV3TW9kLnBhdGhzID0gTW9kdWxlLl9ub2RlTW9kdWxlUGF0aHMocHJvY2Vzcy5jd2QoKSk7XHJcblxyXG4gICAgICAgICAgICAvLyBEYWZ0YXJrYW4gU0VCRUxVTSBfY29tcGlsZTogbW9kdWwgaW5pIGJpc2EgbWUtcmVxdWlyZSBhbmFrbnlhIHNhYXRcclxuICAgICAgICAgICAgLy8gX2NvbXBpbGUgYmVyamFsYW4uIElkLW55YSBwYXRoIFZGUyBzdXBheWEgaW1wb3J0IHJlbGF0aWYgYmVyc2FyYW5nXHJcbiAgICAgICAgICAgIC8vIGlrdXQgYmVuYXIgKHJlc29sdmVSZWxhdGl2ZU1vZHVsZUlkIG1lbmFuZ2FuaSBiZW50dWsgXCIvYS9iXCIpLlxyXG4gICAgICAgICAgICBtb2R1bGVJZEJ5RmlsZVtkdW1teUZpbGVuYW1lXSA9IG5vcm1hbGl6ZWRSZXF1ZXN0O1xyXG4gICAgICAgICAgICAobmV3TW9kIGFzIGFueSkuX2NvbXBpbGUoY29udGVudCwgZHVtbXlGaWxlbmFtZSk7XHJcblxyXG4gICAgICAgICAgICBtb2R1bGVDYWNoZVtub3JtYWxpemVkUmVxdWVzdF0gPSBuZXdNb2QuZXhwb3J0cztcclxuICAgICAgICAgICAgcmV0dXJuIG5ld01vZC5leHBvcnRzO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgaWYgKHZmc1BhdGggJiYgdmZzQ2FjaGVbdmZzUGF0aF0pIHtcclxuICAgICAgICAgICAgY29uc3QgY29udGVudCA9IHZmc0NhY2hlW3Zmc1BhdGhdO1xyXG4gICAgICAgICAgICBjb25zdCBkdW1teUZpbGVuYW1lID0gcGF0aCEuam9pbihwcm9jZXNzLmN3ZCgpLCBub3JtYWxpemVkUmVxdWVzdC5yZXBsYWNlKFwiL1wiLCBcIl9cIikgKyBcIi5qc1wiKTtcclxuXHJcbiAgICAgICAgICAgIGNvbnN0IG5ld01vZCA9IG5ldyBNb2R1bGUoZHVtbXlGaWxlbmFtZSwgcGFyZW50KTtcclxuICAgICAgICAgICAgbmV3TW9kLmZpbGVuYW1lID0gZHVtbXlGaWxlbmFtZTtcclxuICAgICAgICAgICAgbmV3TW9kLnBhdGhzID0gTW9kdWxlLl9ub2RlTW9kdWxlUGF0aHMocHJvY2Vzcy5jd2QoKSk7XHJcblxyXG4gICAgICAgICAgICAvLyBQRU5USU5HOiBkYWZ0YXJrYW4gU0VCRUxVTSBfY29tcGlsZSBcdTIwMTQgaXNpIG1vZHVsIG1lLXJlcXVpcmUgYW5ha255YVxyXG4gICAgICAgICAgICAvLyBzYWF0IF9jb21waWxlIGJlcmphbGFuLCBqYWRpIHBldGEgaW5pIGhhcnVzIHN1ZGFoIHRlcmlzaS5cclxuICAgICAgICAgICAgbW9kdWxlSWRCeUZpbGVbZHVtbXlGaWxlbmFtZV0gPSBub3JtYWxpemVkUmVxdWVzdDtcclxuXHJcbiAgICAgICAgICAgIC8vIEZyYW1ld29yayBtb2R1bGVzIGFyZSBub3cgcHJlLWNvbXBpbGVkIGluIEtlcm5lbC5cclxuICAgICAgICAgICAgLy8gRGlyZWN0IGV4ZWN1dGlvbiBmb3IgbWF4aW11bSBwZXJmb3JtYW5jZS5cclxuICAgICAgICAgICAgKG5ld01vZCBhcyBhbnkpLl9jb21waWxlKGNvbnRlbnQsIGR1bW15RmlsZW5hbWUpO1xyXG5cclxuICAgICAgICAgICAgbW9kdWxlQ2FjaGVbbm9ybWFsaXplZFJlcXVlc3RdID0gbmV3TW9kLmV4cG9ydHM7XHJcbiAgICAgICAgICAgIHJldHVybiBuZXdNb2QuZXhwb3J0cztcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIHJldHVybiBvcmlnaW5hbExvYWQuYXBwbHkodGhpcywgYXJndW1lbnRzKTtcclxuICAgIH07XHJcblxyXG4gICAgKGdsb2JhbCBhcyBhbnkpLmhpamFja1JlcXVpcmUgPSAoaWQ6IHN0cmluZykgPT4ge1xyXG4gICAgICAgIGlmIChob3N0UmVxdWlyZSkgcmV0dXJuIGhvc3RSZXF1aXJlKGlkKTtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFJlcXVpcmUgZmFpbGVkIGZvciAke2lkfSAoTm8gaG9zdCByZXF1aXJlKWApO1xyXG4gICAgfTtcclxufVxyXG5cclxuY29uc3QgaGlqYWNrUmVxdWlyZSA9IChpZDogc3RyaW5nKSA9PlxyXG4gICAgKGdsb2JhbCBhcyBhbnkpLmhpamFja1JlcXVpcmUgPyAoZ2xvYmFsIGFzIGFueSkuaGlqYWNrUmVxdWlyZShpZCkgOiBob3N0UmVxdWlyZSA/IGhvc3RSZXF1aXJlKGlkKSA6IG51bGw7XHJcblxyXG5pZiAodHlwZW9mIHJlcXVpcmUgIT09IFwidW5kZWZpbmVkXCIpIHtcclxuICAgIChnbG9iYWwgYXMgYW55KS5yZXF1aXJlID0gaGlqYWNrUmVxdWlyZTtcclxufVxyXG5cclxuLyoqXHJcbiAqIE1FTU9SWSBTVEFUIFJFU1BPTkRFUiBcdTIwMTQgamFsdXIgZmFsbGJhY2sgYHBzIC0tbWVtYCAvIGBtZW0gLS1wZXItcHJvY2BcclxuICpcclxuICogS2VybmVsIGxlYmloIHN1a2EgbWVtYmFjYSBpc29sYXRlIHdvcmtlciBzZW5kaXJpIGxld2F0XHJcbiAqIGB3b3JrZXIuZ2V0SGVhcFN0YXRpc3RpY3MoKWAsIFRBUEkgbWV0aG9kIGl0dSBiYXJ1IGFkYSBkaSBOb2RlID49IDIyLjE2LlxyXG4gKiBEaSBOb2RlIGxhbWEga2VybmVsIG1lbmdpcmltIHBlc2FuIGB7IF9fdHNpeE1lbVN0YXRSZXF1ZXN0IH1gIGRhbiBtZW51bmdndVxyXG4gKiBiYWxhc2FuOyByZXNwb25kZXIgaW5pIHlhbmcgbWVuamF3YWJueWEuXHJcbiAqXHJcbiAqIEtlbmFwYSBkaSBzaW5pIChXb3JrZXJFbnRyeSkgZGFuIGJ1a2FuIGRpIFVzZXJMaWI6IGJvb3Rsb2FkZXIgaW5pIFNFTEFMVVxyXG4gKiBqYWxhbiwgYmFoa2FuIHVudHVrIGFwcCB5YW5nIGdhZ2FsIGRpbXVhdCBcdTIwMTQgc2VkYW5na2FuIFVzZXJMaWIgYmFydSBoaWR1cFxyXG4gKiBzZXRlbGFoIGFwcCBtZW5nLWltcG9ydCBmcmFtZXdvcmsuIFRhbnBhIGl0dSwgcHJvc2VzIGJlcm1hc2FsYWgganVzdHJ1XHJcbiAqIGtlaGlsYW5nYW4gYW5na2EgbWVtb3JpbnlhLlxyXG4gKlxyXG4gKiBgcnNzYCBzZW5nYWphIFRJREFLIGRpbGFwb3JrYW46IGRpIGRhbGFtIHdvcmtlciBuaWxhaW55YSBwcm9jZXNzLXdpZGVcclxuICogKG1haW4gdGhyZWFkICsgc2VtdWEgd29ya2VyKSwgbWVueWVzYXRrYW4gdW50dWsgYXRyaWJ1c2kgcGVyLXByb3Nlcy5cclxuICovXHJcbmlmIChwYXJlbnRQb3J0KSB7XHJcbiAgICBwYXJlbnRQb3J0Lm9uKFwibWVzc2FnZVwiLCAobXNnOiBhbnkpID0+IHtcclxuICAgICAgICBjb25zdCByZXF1ZXN0SWQgPSBtc2cgJiYgbXNnLl9fdHNpeE1lbVN0YXRSZXF1ZXN0O1xyXG4gICAgICAgIGlmICh0eXBlb2YgcmVxdWVzdElkICE9PSBcInN0cmluZ1wiKSByZXR1cm47XHJcblxyXG4gICAgICAgIC8vIEphbmdhbiBiaWFya2FuIGtlZ2FnYWxhbiBwZW1iYWNhYW4gbWVtYXRpa2FuIHByb3NlcyBcdTIwMTQgYmFsYXMgYXBhIGFkYW55YS5cclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBtID0gcHJvY2Vzcy5tZW1vcnlVc2FnZSgpO1xyXG4gICAgICAgICAgICBsZXQgaGVhcExpbWl0ID0gMDtcclxuICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgIGhlYXBMaW1pdCA9IGhvc3RSZXF1aXJlID8gaG9zdFJlcXVpcmUoXCJ2OFwiKS5nZXRIZWFwU3RhdGlzdGljcygpLmhlYXBfc2l6ZV9saW1pdCA6IDA7XHJcbiAgICAgICAgICAgIH0gY2F0Y2ggKF8pIHtcclxuICAgICAgICAgICAgICAgIC8qIHY4IG9wc2lvbmFsIFx1MjAxNCAwIGJlcmFydGkgdGlkYWsgZGlrZXRhaHVpICovXHJcbiAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgIHBhcmVudFBvcnQhLnBvc3RNZXNzYWdlKHtcclxuICAgICAgICAgICAgICAgIF9fdHNpeE1lbVN0YXQ6IHJlcXVlc3RJZCxcclxuICAgICAgICAgICAgICAgIHN0YXRzOiB7XHJcbiAgICAgICAgICAgICAgICAgICAgaGVhcFVzZWQ6IG0uaGVhcFVzZWQsXHJcbiAgICAgICAgICAgICAgICAgICAgaGVhcFRvdGFsOiBtLmhlYXBUb3RhbCxcclxuICAgICAgICAgICAgICAgICAgICBleHRlcm5hbDogbS5leHRlcm5hbCxcclxuICAgICAgICAgICAgICAgICAgICBhcnJheUJ1ZmZlcnM6IG0uYXJyYXlCdWZmZXJzLFxyXG4gICAgICAgICAgICAgICAgICAgIGhlYXBMaW1pdCxcclxuICAgICAgICAgICAgICAgIH0sXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH0gY2F0Y2ggKF8pIHtcclxuICAgICAgICAgICAgLy8gQmFsYXMgbnVsbCBzdXBheWEga2VybmVsIHRpZGFrIG1lbnVuZ2d1IHNhbXBhaSB0aW1lb3V0LlxyXG4gICAgICAgICAgICBwYXJlbnRQb3J0IS5wb3N0TWVzc2FnZSh7IF9fdHNpeE1lbVN0YXQ6IHJlcXVlc3RJZCwgc3RhdHM6IG51bGwgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcbn1cclxuXHJcbnByb2Nlc3Mub24oXCJ1bmhhbmRsZWRSZWplY3Rpb25cIiwgKHJlYXNvbikgPT4ge1xyXG4gICAgY29uc3QgbXNnID0gcmVhc29uIGluc3RhbmNlb2YgRXJyb3IgPyByZWFzb24ubWVzc2FnZSA6IFN0cmluZyhyZWFzb24pO1xyXG4gICAgY29uc29sZS5lcnJvcihcIltXb3JrZXIgRmF0YWxdIFVuaGFuZGxlZCBSZWplY3Rpb246XCIsIG1zZyk7XHJcbiAgICB0cnlTZW5kRXJyb3JUb1BhcmVudChtc2cpO1xyXG4gICAgcmVhbEV4aXQoMSk7XHJcbn0pO1xyXG5cclxucHJvY2Vzcy5vbihcInVuY2F1Z2h0RXhjZXB0aW9uXCIsIChlcnIpID0+IHtcclxuICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcclxuICAgIGNvbnNvbGUuZXJyb3IoXCJbV29ya2VyIEZhdGFsXSBVbmNhdWdodCBFeGNlcHRpb246XCIsIG1zZyk7XHJcbiAgICB0cnlTZW5kRXJyb3JUb1BhcmVudChtc2cpO1xyXG4gICAgcmVhbEV4aXQoMSk7XHJcbn0pO1xyXG5cclxuLy8gSGVscGVyOiBjb2JhIGtpcmltIEdVSV9XSU5ET1dfRVJST1Iga2UgcGFyZW50IChBc3RlcmFjZWEpIHNlYmVsdW0gZXhpdFxyXG5mdW5jdGlvbiB0cnlTZW5kRXJyb3JUb1BhcmVudChtZXNzYWdlOiBzdHJpbmcpIHtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgbGliID0gKGdsb2JhbCBhcyBhbnkpLl90c2l4TGliIGFzIGFueTtcclxuICAgICAgICBpZiAobGliICYmIHR5cGVvZiBsaWIuZ2V0UGFyZW50UGlkID09PSBcImZ1bmN0aW9uXCIgJiYgdHlwZW9mIGxpYi5zaGVsbD8uc2VuZCA9PT0gXCJmdW5jdGlvblwiKSB7XHJcbiAgICAgICAgICAgIGxpYi5nZXRQYXJlbnRQaWQoKVxyXG4gICAgICAgICAgICAgICAgLnRoZW4oKHBhcmVudFBpZDogbnVtYmVyKSA9PiB7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKHBhcmVudFBpZCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBsaWIuc2hlbGwuc2VuZChwYXJlbnRQaWQsIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiR1VJX1dJTkRPV19FUlJPUlwiLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgd2lkOiBcIlwiLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcGlkOiBsaWIuZ2V0UGlkKCksXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWxlOiBcIlwiLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyb3I6IGBSdW50aW1lIEVycm9yOiAke21lc3NhZ2V9YCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRleHQ6IFwicnVudGltZVwiLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkucmVwbGFjZShcIlRcIiwgXCIgXCIpLnN1YnN0cmluZygwLCAxOSksXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH0pXHJcbiAgICAgICAgICAgICAgICAuY2F0Y2goKCkgPT4ge30pO1xyXG4gICAgICAgIH1cclxuICAgIH0gY2F0Y2ggKF8pIHtcclxuICAgICAgICAvKiBpZ25vcmUgKi9cclxuICAgIH1cclxufVxyXG5cclxuLy8gLS0tIEJBU0lDIFNBTkRCT1hJTkcgKEVkdWNhdGlvbmFsIExldmVsKSAtLS1cclxuLy8gS2l0YSBcInNlbWJ1bnlpa2FuXCIgYmViZXJhcGEgQVBJIE5vZGUuanMgeWFuZyBiZXJiYWhheWEgYWdhciB1c2VyLWxhbmRcclxuLy8gZGlwYWtzYSBtZW5nZ3VuYWthbiBTeXNjYWxsIGxld2F0IFVzZXJMaWIuXHJcbmNvbnN0IHJlc3RyaWN0SG9zdEFQSSA9IChhcHBOYW1lOiBzdHJpbmcpID0+IHtcclxuICAgIGNvbnN0IGZvcmJpZGRlbiA9IChtc2c6IHN0cmluZyA9IFwiU2VjdXJpdHkgVmlvbGF0aW9uOiBEaXJlY3QgSG9zdCBBUEkgYWNjZXNzIGlzIGZvcmJpZGRlbiBpbiBUU0lYIFNhbmRib3guXCIpID0+IHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IobXNnKTtcclxuICAgIH07XHJcblxyXG4gICAgY29uc3QgaXNQcml2aWxlZ2VkID1cclxuICAgICAgICBhcHBOYW1lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJzZXJ2ZXJcIikgfHxcclxuICAgICAgICBhcHBOYW1lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJkYWVtb25cIikgfHxcclxuICAgICAgICBhcHBOYW1lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJkb21lXCIpIHx8XHJcbiAgICAgICAgYXBwTmFtZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwidGJ1aWxkXCIpIHx8XHJcbiAgICAgICAgYXBwTmFtZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwidmZzXCIpIHx8XHJcbiAgICAgICAgYXBwTmFtZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwibXlzcWxkXCIpO1xyXG4gICAgY29uc3QgYWxsb3dlZE1vZHVsZXMgPSBbXCJwYXRoXCIsIFwiZnNcIiwgXCJ1cmxcIiwgXCJlc2J1aWxkXCIsIFwiY3J5cHRvXCIsIFwib3NcIiwgXCJiY3J5cHRqc1wiLCBcIm15c3FsMlwiLCBcIm15c3FsMi9wcm9taXNlXCJdO1xyXG5cclxuICAgIGNvbnN0IHByaXZpbGVnZWRSZXF1aXJlID0gKG1vZDogc3RyaW5nKSA9PiB7XHJcbiAgICAgICAgLy8gRnJhbWV3b3JrIGFsaWFzZXMgYXJlIEFMV0FZUyBhbGxvd2VkLCBldmVuIGluIHNhbmRib3hcclxuICAgICAgICBpZiAoXHJcbiAgICAgICAgICAgIG1vZC5zdGFydHNXaXRoKFwiQHRzaXgvXCIpIHx8XHJcbiAgICAgICAgICAgIG1vZC5zdGFydHNXaXRoKFwiQGNvbW1vbi9cIikgfHxcclxuICAgICAgICAgICAgbW9kLmluY2x1ZGVzKFwiL2xpYi9cIikgfHxcclxuICAgICAgICAgICAgbW9kLmluY2x1ZGVzKFwiL2NvbW1vbi9cIilcclxuICAgICAgICApIHtcclxuICAgICAgICAgICAgcmV0dXJuIGhpamFja1JlcXVpcmUobW9kKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGlmIChhbGxvd2VkTW9kdWxlcy5pbmNsdWRlcyhtb2QpKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBob3N0UmVxdWlyZSEobW9kKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgZm9yYmlkZGVuKGBTZWN1cml0eSBWaW9sYXRpb246IE1vZHVsZSAnJHttb2R9JyBpcyBub3QgaW4gdGhlIHByaXZpbGVnZWQgYWxsb3ctbGlzdC5gKTtcclxuICAgIH07XHJcblxyXG4gICAgLy8gU2VtYnVueWlrYW4gcmVxdWlyZSBqaWthIGFkYSAodGVyZ2FudHVuZyBtb2R1bGUgbG9hZGVyKVxyXG4gICAgaWYgKHR5cGVvZiByZXF1aXJlICE9PSBcInVuZGVmaW5lZFwiKSB7XHJcbiAgICAgICAgKGdsb2JhbCBhcyBhbnkpLnJlcXVpcmUgPSBpc1ByaXZpbGVnZWRcclxuICAgICAgICAgICAgPyBwcml2aWxlZ2VkUmVxdWlyZVxyXG4gICAgICAgICAgICA6IChtb2Q6IHN0cmluZykgPT4ge1xyXG4gICAgICAgICAgICAgICAgICAvLyBFdmVuIGluIHNhbmRib3gsIGZyYW1ld29yayBjb3JlcyBNVVNUIGJlIGFjY2Vzc2libGVcclxuICAgICAgICAgICAgICAgICAgaWYgKFxyXG4gICAgICAgICAgICAgICAgICAgICAgbW9kLnN0YXJ0c1dpdGgoXCJAdHNpeC9cIikgfHxcclxuICAgICAgICAgICAgICAgICAgICAgIG1vZC5zdGFydHNXaXRoKFwiQGNvbW1vbi9cIikgfHxcclxuICAgICAgICAgICAgICAgICAgICAgIG1vZC5pbmNsdWRlcyhcIi9saWIvXCIpIHx8XHJcbiAgICAgICAgICAgICAgICAgICAgICBtb2QuaW5jbHVkZXMoXCIvY29tbW9uL1wiKVxyXG4gICAgICAgICAgICAgICAgICApIHtcclxuICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBoaWphY2tSZXF1aXJlKG1vZCk7XHJcbiAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgZm9yYmlkZGVuKCk7XHJcbiAgICAgICAgICAgICAgfTtcclxuICAgIH1cclxuXHJcbiAgICAvLyBCYXRhc2kgYWtzZXMgcHJvY2VzcyB5YW5nIHNlbnNpdGlmXHJcbiAgICBjb25zdCBwID0gKGdsb2JhbCBhcyBhbnkpLnByb2Nlc3M7XHJcbiAgICBpZiAocCkge1xyXG4gICAgICAgIHAuZXhpdCA9IGZvcmJpZGRlbjtcclxuICAgICAgICBwLmtpbGwgPSBmb3JiaWRkZW47XHJcbiAgICAgICAgLy8gcC5lbnYgPSB7fTsgLy8gVGVtcG9yYXJpbHkga2VlcCBlbnYgZm9yIGRlYnVnZ2luZyBpZiBuZWVkZWQsIG9yIGNsZWFyIGl0XHJcbiAgICB9XHJcbn07XHJcblxyXG4vLyByZXN0cmljdEhvc3RBUEkoKTsgLy8gRGlwaW5kYWhrYW4ga2UgZGFsYW0gbWFpbigpXHJcblxyXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXHJcblxyXG4vKipcclxuICogZW1pdFdvcmtlckVycm9yKCk6IENldGFrIHBlc2FuIGVycm9yIGxvYWQtcGF0aCBhcGxpa2FzaSBrZSBUVFkgKFNURE9VVCksXHJcbiAqIHNlaGluZ2dhIHRlcmxpaGF0IGp1Z2EgZGkgcGl4ZWx0ZXJtIC8ga29uc29sIFRUWSAoYnVrYW4gY3VtYSBob3N0IHN0ZGVycikuXHJcbiAqIEZpcmUtYW5kLWZvcmdldCAodGlkYWsgZGktYXdhaXQpIHN1cGF5YSB0aWRhayBtZW5ndWJhaCBhbHVyIG1haW4oKTsgZmFsbGJhY2tcclxuICoga2UgY29uc29sZS5lcnJvciAoaG9zdCBzdGRlcnIpIGJpbGEgcHJpbnQga2UgVFRZIGdhZ2FsLlxyXG4gKi9cclxuZnVuY3Rpb24gZW1pdFdvcmtlckVycm9yKGxpYjogYW55LCBwaWQ6IG51bWJlciwgbWVzc2FnZTogc3RyaW5nKSB7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGlmIChsaWIgJiYgbGliLnN0ZCAmJiB0eXBlb2YgbGliLnN0ZC5wcmludCA9PT0gXCJmdW5jdGlvblwiKSB7XHJcbiAgICAgICAgICAgIHZvaWQgbGliLnN0ZC5wcmludChgXFx4MWJbMzFtW1dvcmtlciAke3BpZH1dXFx4MWJbMG0gJHttZXNzYWdlfVxcbmApLmNhdGNoKCgpID0+IHtcclxuICAgICAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYFtXb3JrZXIgJHtwaWR9XSAke21lc3NhZ2V9YCk7XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgfSBjYXRjaCAoXykge1xyXG4gICAgICAgIC8vIGZhbGxiYWNrIGtlIGNvbnNvbGUuZXJyb3IgZGkgYmF3YWhcclxuICAgIH1cclxuICAgIGNvbnNvbGUuZXJyb3IoYFtXb3JrZXIgJHtwaWR9XSAke21lc3NhZ2V9YCk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBub3RpZnlMb2FkRXJyb3IoKTogS2lyaW0gR1VJX1dJTkRPV19FUlJPUiBrZSBwYXJlbnQgJiBXaW5kb3cgTWFuYWdlciAoQXN0ZXJhY2VhKVxyXG4gKiBzdXBheWEgZXJyb3IgZ2FnYWwtbG9hZCBhcGxpa2FzaSBqdWdhIHRhbXBpbCBzZWJhZ2FpIHBvcHVwIGRpIGRlc2t0b3AgXHUyMDE0IHRlcm1hc3VrXHJcbiAqIHNhYXQgYXBwIGRpamFsYW5rYW4gZGFyaSBmaWxlLWNydWlzZXIvdGVybWluYWwgKGZvcmVpZ24gYXBwKS4gUG9sYW55YSBzYW1hIGRlbmdhblxyXG4gKiBub3RpZnlQYXJlbnRXaW5kb3dFdmVudCgpIGRpIEVtZXJhbGQ6IGtpcmltIGtlIHBhcmVudCBkdWx1LCBsYWx1IGtlIFdNIHZpYVxyXG4gKiBQSUQgZmlsZSAoYC92YXIvcnVuL2FzdGVyYWNlYS93bS1waWRgKS4gRmlyZS1hbmQtZm9yZ2V0OyBrZWdhZ2FsYW4gcGVuZ2lyaW1hblxyXG4gKiB0aWRhayBmYXRhbC5cclxuICovXHJcbmFzeW5jIGZ1bmN0aW9uIG5vdGlmeUxvYWRFcnJvcihsaWI6IGFueSwgcGlkOiBudW1iZXIsIGFwcE5hbWU6IHN0cmluZywgbWVzc2FnZTogc3RyaW5nKSB7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHRpbWVzdGFtcCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5yZXBsYWNlKFwiVFwiLCBcIiBcIikuc3Vic3RyaW5nKDAsIDE5KTtcclxuICAgICAgICBjb25zdCBwYXlsb2FkID0ge1xyXG4gICAgICAgICAgICB0eXBlOiBcIkdVSV9XSU5ET1dfRVJST1JcIixcclxuICAgICAgICAgICAgd2lkOiBcIlwiLFxyXG4gICAgICAgICAgICBwaWQsXHJcbiAgICAgICAgICAgIGZpbGU6IGFwcE5hbWUsXHJcbiAgICAgICAgICAgIGVycm9yOiBtZXNzYWdlLFxyXG4gICAgICAgICAgICBjb250ZXh0OiBcImxvYWRcIixcclxuICAgICAgICAgICAgdGltZXN0YW1wLFxyXG4gICAgICAgIH07XHJcblxyXG4gICAgICAgIC8vIDEuIEtpcmltIGtlIHBhcmVudCBwcm9jZXNzIChiaXNhIFdNIGJpbGEgYXBwIGRpLWxhdW5jaCBkYXJpIGxhdW5jaGVyKVxyXG4gICAgICAgIGNvbnN0IHBhcmVudFBpZCA9IGF3YWl0IGxpYi5nZXRQYXJlbnRQaWQoKTtcclxuICAgICAgICBpZiAocGFyZW50UGlkKSB7XHJcbiAgICAgICAgICAgIGF3YWl0IGxpYi5zaGVsbC5zZW5kKHBhcmVudFBpZCwgcGF5bG9hZCk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICAvLyAyLiBLaXJpbSBqdWdhIGtlIEFzdGVyYWNlYSBXTSBcdTIwMTQgdW50dWsgYXBwIHlhbmcgZGktcnVuIHZpYVxyXG4gICAgICAgIC8vICAgIGZpbGUtY3J1aXNlci90ZXJtaW5hbCAoZm9yZWlnbiBhcHApLiBCYWNhIFBJRCBXTSBkYXJpIHdtLXBpZCBmaWxlLlxyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHdtUGlkUmF3ID0gYXdhaXQgbGliLmZzLnJlYWRGaWxlKFdNX1BJRF9GSUxFKTtcclxuICAgICAgICAgICAgaWYgKHdtUGlkUmF3KSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCB3bVBpZCA9IHBhcnNlSW50KFN0cmluZyh3bVBpZFJhdykudHJpbSgpKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IG15UGlkID0gbGliLmdldFBpZCgpO1xyXG4gICAgICAgICAgICAgICAgaWYgKHdtUGlkICYmIHdtUGlkICE9PSBteVBpZCAmJiB3bVBpZCAhPT0gcGFyZW50UGlkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgbGliLnNoZWxsLnNlbmQod21QaWQsIHBheWxvYWQpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBjYXRjaCAoXykge1xyXG4gICAgICAgICAgICAvLyBBc3RlcmFjZWEgdGlkYWsgYmVyamFsYW4gXHUyMDE0IG5vLW9wXHJcbiAgICAgICAgfVxyXG4gICAgfSBjYXRjaCAoXykge1xyXG4gICAgICAgIC8vIE5vdGlmaWthc2kgZ2FnYWwgXHUyMDE0IG5vbi1mYXRhbFxyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBtYWluKCkge1xyXG4gICAgY29uc3QgZGF0YSA9IHdvcmtlckRhdGEgYXMgV29ya2VySW5pdERhdGE7XHJcbiAgICBjb25zdCB7IHBpZCwgYXBwTmFtZSwgYXJncywgYXBwUGF0aCB9ID0gZGF0YTtcclxuXHJcbiAgICAvLyBMb2FkIFVzZXJMaWIgZGluYW1pcyBkYXJpIFZGUyBDYWNoZSAoTWVtb3J5IEV4ZWN1dGlvbilcclxuICAgIGNvbnN0IFVzZXJMaWJNb2QgPSBoaWphY2tSZXF1aXJlKFwiQHRzaXgvVXNlckxpYlwiKTtcclxuICAgIGNvbnN0IFVzZXJMaWJDbGFzcyA9IFVzZXJMaWJNb2QuVXNlckxpYjtcclxuXHJcbiAgICBpZiAoIVVzZXJMaWJDbGFzcykge1xyXG4gICAgICAgIGNvbnNvbGUuZXJyb3IoYFtXb3JrZXIgJHtwaWR9XSBDUklUSUNBTCBFUlJPUjogRmFpbGVkIHRvIGxvYWQgVXNlckxpYiBmcm9tIFZGUyBNZW1vcnkgQ2FjaGUhYCk7XHJcbiAgICAgICAgcmVhbEV4aXQoMSk7XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QgbGliID0gbmV3IFVzZXJMaWJDbGFzcyhwaWQpO1xyXG4gICAgKGdsb2JhbCBhcyBhbnkpLl90c2l4TGliID0gbGliOyAvLyBSZWdpc3RlciBmb3IgZXhwbGljaXQgaW1wb3J0cyAodjIuMSlcclxuXHJcbiAgICAvLyBKUy1EaXJlY3QgcGF0aCBzaG91bGQgTk9UIGhhdmUgLXIgaW4gZXhlY0FyZ3ZcclxuICAgIGNvbnN0IGlzSnNEaXJlY3QgPSAhcHJvY2Vzcy5leGVjQXJndi5zb21lKChhcmcpID0+IGFyZy5pbmNsdWRlcyhcIi1yXCIpKTtcclxuXHJcbiAgICAvLyAyLiBDYXJpIGFwbGlrYXNpbnlhXHJcbiAgICBjb25zdCB0YXJnZXRLZXkgPSBhcHBOYW1lLnRyaW0oKTtcclxuICAgIGxldCBBcHBDbGFzczogYW55ID0gbnVsbDtcclxuICAgIGxldCBmaW5hbEFwcFBhdGggPSBhcHBQYXRoO1xyXG4gICAgLy8gUmVhc29uIHRoZSBsb2FkIGZhaWxlZCAodHJhbnNwaWxlL2V4ZWN1dGlvbikgXHUyMDE0IHVzZWQgZm9yIGEgbW9yZSBob25lc3RcclxuICAgIC8vIGZpbmFsIG1lc3NhZ2UgaW5zdGVhZCBvZiB0aGUgbWlzbGVhZGluZyBcIkFwcGxpY2F0aW9uIG5vdCBmb3VuZFwiLlxyXG4gICAgbGV0IGxvYWRGYWlsdXJlOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcclxuICAgIC8vIERldGFpbCBlcnJvciBhc2xpbnlhIChwZXNhbiBlc2J1aWxkL3J1bnRpbWUpIFx1MjAxNCBkaXBha2FpIHVudHVrIHBvcHVwIGRlc2t0b3BcclxuICAgIC8vIGJpYXIgc3Blc2lmaWssIGJ1a2FuIHNla2FkYXIga2F0ZWdvcmkgXCJ0cmFuc3BpbGUgZmFpbGVkXCIuXHJcbiAgICBsZXQgbG9hZEVycm9yRGV0YWlsOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcclxuXHJcbiAgICAvLyAtLS0gU1RSQVRFR0kgQkFSVTogRGlyZWN0IE1lbW9yeSBFeGVjdXRpb24gKFRhbnBhIC52ZnNfY2FjaGUpIC0tLVxyXG4gICAgaWYgKCFmaW5hbEFwcFBhdGggJiYgKGRhdGEgYXMgYW55KS5hcHBDb250ZW50ICYmIE1vZHVsZSkge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGxldCBjb250ZW50ID0gKGRhdGEgYXMgYW55KS5hcHBDb250ZW50O1xyXG4gICAgICAgICAgICBjb25zdCBpc1R5cGVTY3JpcHQgPSAhKGFwcFBhdGggfHwgYXBwTmFtZSB8fCBcIlwiKS50b0xvd2VyQ2FzZSgpLmVuZHNXaXRoKFwiLmpzXCIpO1xyXG4gICAgICAgICAgICAvLyBNb2R1bGUgZmlsZW5hbWUgSEFSVVMgcGh5c2ljYWwgcGF0aCB1bnR1ayByZXF1aXJlKCkgbmVtdSBub2RlX21vZHVsZXNcclxuICAgICAgICAgICAgY29uc3QgbW9kdWxlRmlsZW5hbWUgPSBwYXRoIS5qb2luKHByb2Nlc3MuY3dkKCksIGFwcE5hbWUgKyBcIi5qc1wiKTtcclxuICAgICAgICAgICAgLy8gU3RhY2sgZmlsZW5hbWUgPSBCS0ZTIHBhdGggYmlhciBzdGFjayB0cmFjZSBiZW5lciAoL29wdC90ZXN0L2d1aS10ZXN0LmpzKVxyXG4gICAgICAgICAgICAvLyBzdGFja0JrZnNQYXRoID0gQktGUyBwYXRoIHVudHVrIHN0YWNrIHRyYWNlICgvb3B0L3Rlc3QvZ3VpLXRlc3QuanMpXHJcbiAgICAgICAgICAgIGNvbnN0IHN0YWNrQmtmc1BhdGggPSAoZGF0YSBhcyBhbnkpLnN0YWNrQmtmc1BhdGg7XHJcbiAgICAgICAgICAgIGNvbnN0IHN0YWNrRmlsZW5hbWUgPSBzdGFja0JrZnNQYXRoID8gc3RhY2tCa2ZzUGF0aC5yZXBsYWNlKC9cXC50cyQvLCBcIi5qc1wiKSA6IG1vZHVsZUZpbGVuYW1lO1xyXG4gICAgICAgICAgICAvLyBzb3VyY2VmaWxlIHVudHVrIGVzYnVpbGQgc291cmNlbWFwIFx1MjAxNCBjdWt1cCBuYW1hIGZpbGUgYWphICh0YW5wYSBwYXRoKVxyXG4gICAgICAgICAgICBjb25zdCBzb3VyY2VGaWxlTmFtZSA9IChzdGFja0JrZnNQYXRoIHx8IG1vZHVsZUZpbGVuYW1lKS5zcGxpdCgvW1xcXFwvXS8pLnBvcCgpIS5yZXBsYWNlKC9cXC5qcyQvLCBcIi50c1wiKTtcclxuXHJcbiAgICAgICAgICAgIC8vIC0tLSBNT0RVTCBSRUxBVElGIFBST0dSQU0gKC4veCwgLi4veSkgLS0tXHJcbiAgICAgICAgICAgIC8vXHJcbiAgICAgICAgICAgIC8vIERpa3VtcHVsa2FuIFNFS0FSQU5HIChtYWluKCkgYXN5bmMpIGthcmVuYSBgTW9kdWxlLl9sb2FkYCBzaW5rcm9uXHJcbiAgICAgICAgICAgIC8vIHNlZGFuZ2thbiBiYWNhIFZGUyBsZXdhdCBzeXNjYWxsIGFzaW5rcm9uOiBob29rIHJlcXVpcmUgdGlkYWsgbXVuZ2tpblxyXG4gICAgICAgICAgICAvLyBtZW1iYWNhIGZpbGUgc2VuZGlyaS4gVGFucGEgbGFuZ2thaCBpbmksIGByZXF1aXJlKFwiLi9UcGtnUHJvdG9jb2xcIilgXHJcbiAgICAgICAgICAgIC8vIG1lbmNhcmkgZmlsZSBpdHUgZGkgSE9TVCBmaWxlc3lzdGVtIGRhbiBnYWdhbC5cclxuICAgICAgICAgICAgaWYgKHN0YWNrQmtmc1BhdGgpIHtcclxuICAgICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgZXNidWlsZE1vZCA9IGhvc3RSZXF1aXJlIShcImVzYnVpbGRcIik7XHJcbiAgICAgICAgICAgICAgICAgICAgcHJvZ3JhbU1vZHVsZXMgPSBhd2FpdCBjb2xsZWN0UmVsYXRpdmVNb2R1bGVzKHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgZW50cnlJZDogc3RhY2tCa2ZzUGF0aC5yZXBsYWNlKC9cXC4odHN8anMpJC9pLCBcIlwiKSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgc291cmNlOiBjb250ZW50LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBJc2kgVkZTID0gQllURTsgbW9kdWwgcmVsYXRpZiBkaWtvbXBpbGFzaSBzZWJhZ2FpIFRFS1MuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlYWRGaWxlOiBhc3luYyAodmZzUGF0aDogc3RyaW5nKSA9PiB2ZnNCeXRlc1RvVXRmOChhd2FpdCBsaWIuZnMucmVhZEZpbGUodmZzUGF0aCkpLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0cmFuc3BpbGU6IChzcmM6IHN0cmluZywgbW9kdWxlSWQ6IHN0cmluZykgPT5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVzYnVpbGRNb2QudHJhbnNmb3JtU3luYyhzcmMsIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsb2FkZXI6IFwidHNcIixcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmb3JtYXQ6IFwiY2pzXCIsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFyZ2V0OiBcIm5vZGUxOFwiLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNvdXJjZW1hcDogXCJpbmxpbmVcIixcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzb3VyY2VmaWxlOiBtb2R1bGVJZC5zcGxpdChcIi9cIikucG9wKCkgKyBcIi50c1wiLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSkuY29kZSxcclxuICAgICAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGU6IGFueSkge1xyXG4gICAgICAgICAgICAgICAgICAgIC8vIE5vbi1mYXRhbDogaW1wb3J0IHJlbGF0aWYgYWthbiBnYWdhbCBkZW5nYW4gcGVzYW4gTm9kZSBiaWFzYS5cclxuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmVycm9yKGBbV29ya2VyICR7cGlkfV0gTG9jYWwgbW9kdWxlIHNjYW4gZmFpbGVkOiAke2UubWVzc2FnZX1gKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgLy8gSmlrYSBjb250ZW50IGFkYWxhaCBUeXBlU2NyaXB0LCB0cmFuc3BpbGUgZHVsdSBrZSBKYXZhU2NyaXB0XHJcbiAgICAgICAgICAgIGlmIChpc1R5cGVTY3JpcHQpIHtcclxuICAgICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgZXNidWlsZCA9IGhvc3RSZXF1aXJlIShcImVzYnVpbGRcIik7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gZXNidWlsZC50cmFuc2Zvcm1TeW5jKGNvbnRlbnQsIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgbG9hZGVyOiBcInRzXCIsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGZvcm1hdDogXCJjanNcIixcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGFyZ2V0OiBcIm5vZGUxOFwiLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBzb3VyY2VtYXA6IFwiaW5saW5lXCIsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHNvdXJjZWZpbGU6IHNvdXJjZUZpbGVOYW1lLFxyXG4gICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnRlbnQgPSByZXN1bHQuY29kZTtcclxuICAgICAgICAgICAgICAgIH0gY2F0Y2ggKHRyYW5zcGlsZUVycjogYW55KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgbG9hZEZhaWx1cmUgPSBcInRyYW5zcGlsZSBmYWlsZWRcIjtcclxuICAgICAgICAgICAgICAgICAgICBsb2FkRXJyb3JEZXRhaWwgPSBgVFMgVHJhbnNwaWxlIEVycm9yOiAke3RyYW5zcGlsZUVyci5tZXNzYWdlfWA7XHJcbiAgICAgICAgICAgICAgICAgICAgZW1pdFdvcmtlckVycm9yKGxpYiwgcGlkLCBgVFMgVHJhbnNwaWxlIEVycm9yOiAke3RyYW5zcGlsZUVyci5tZXNzYWdlfWApO1xyXG4gICAgICAgICAgICAgICAgICAgIHRocm93IHRyYW5zcGlsZUVycjtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgLy8gQ3JlYXRlIGEgbmV3IG1vZHVsZSBpbnN0YW5jZSB3aXRoIHBoeXNpY2FsIHBhdGggKGZvciBub2RlX21vZHVsZXMgcmVzb2x1dGlvbilcclxuICAgICAgICAgICAgY29uc3QgYXBwTW9kdWxlID0gbmV3IE1vZHVsZShtb2R1bGVGaWxlbmFtZSwgbW9kdWxlLnBhcmVudCk7XHJcbiAgICAgICAgICAgIGFwcE1vZHVsZS5maWxlbmFtZSA9IHN0YWNrRmlsZW5hbWU7IC8vIF9fZmlsZW5hbWUgc2hvd3MgQktGUyBwYXRoXHJcbiAgICAgICAgICAgIGFwcE1vZHVsZS5wYXRocyA9IE1vZHVsZS5fbm9kZU1vZHVsZVBhdGhzKHBhdGghLmRpcm5hbWUobW9kdWxlRmlsZW5hbWUpKTtcclxuXHJcbiAgICAgICAgICAgIC8vIF9jb21waWxlIGRlbmdhbiBzdGFja0ZpbGVuYW1lIGFnYXIgc3RhY2sgdHJhY2UgbnVuanVrIEJLRlMgcGF0aFxyXG4gICAgICAgICAgICAoYXBwTW9kdWxlIGFzIGFueSkuX2NvbXBpbGUoY29udGVudCwgc3RhY2tGaWxlbmFtZSk7XHJcblxyXG4gICAgICAgICAgICBBcHBDbGFzcyA9XHJcbiAgICAgICAgICAgICAgICBhcHBNb2R1bGUuZXhwb3J0cy5tYWluIHx8IGFwcE1vZHVsZS5leHBvcnRzLk1haW4gfHwgYXBwTW9kdWxlLmV4cG9ydHMuZGVmYXVsdCB8fCBhcHBNb2R1bGUuZXhwb3J0cztcclxuXHJcbiAgICAgICAgICAgIC8vIEppa2EgbWFzaWggYmVsdW0ga2V0ZW11IChlLmcuIGV4cG9ydCBjbGFzcyBidWthbiBkZWZhdWx0L21haW4pXHJcbiAgICAgICAgICAgIGlmICh0eXBlb2YgQXBwQ2xhc3MgIT09IFwiZnVuY3Rpb25cIikge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgZW50cmllcyA9IE9iamVjdC5lbnRyaWVzKGFwcE1vZHVsZS5leHBvcnRzKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGZvdW5kID0gZW50cmllcy5maW5kKChbXywgdmFsXTogW3N0cmluZywgYW55XSkgPT4gdHlwZW9mIHZhbCA9PT0gXCJmdW5jdGlvblwiKTtcclxuICAgICAgICAgICAgICAgIGlmIChmb3VuZCkgQXBwQ2xhc3MgPSBmb3VuZFsxXTtcclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgaWYgKEFwcENsYXNzKSB7XHJcbiAgICAgICAgICAgICAgICAvLyBjb25zb2xlLmxvZyhgW1dvcmtlciAke3BpZH1dIERpcmVjdCBNZW1vcnkgRXhlY3V0aW9uIHN1Y2Nlc3MgZm9yICR7YXBwTmFtZX1gKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0gY2F0Y2ggKGVycjogYW55KSB7XHJcbiAgICAgICAgICAgIGlmICghbG9hZEZhaWx1cmUpIGxvYWRGYWlsdXJlID0gXCJkaXJlY3QgZXhlY3V0aW9uIGZhaWxlZFwiO1xyXG4gICAgICAgICAgICBpZiAoIWxvYWRFcnJvckRldGFpbCkgbG9hZEVycm9yRGV0YWlsID0gYERpcmVjdCBFeGVjdXRpb24gRXJyb3I6ICR7ZXJyLm1lc3NhZ2V9YDtcclxuICAgICAgICAgICAgZW1pdFdvcmtlckVycm9yKGxpYiwgcGlkLCBgRGlyZWN0IEV4ZWN1dGlvbiBFcnJvcjogJHtlcnIubWVzc2FnZX1gKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgaWYgKGZpbmFsQXBwUGF0aCAmJiBob3N0UmVxdWlyZSkge1xyXG4gICAgICAgIC8vIFNUUkFURUdJIEJBUlU6IER5bmFtaWMgTG9hZGluZyBkYXJpIEZpbGUgRmlzaWsgKExpbnV4LWxpa2UpXHJcbiAgICAgICAgLy8gU1RSQVRFR0k6IER5bmFtaWMgTG9hZGluZyBkYXJpIEZpbGUgRmlzaWsgKEp1anVyIFBha2UgLnRzKVxyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG1vZHVsZSA9IGhvc3RSZXF1aXJlKGZpbmFsQXBwUGF0aCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGVudHJpZXMgPSBPYmplY3QuZW50cmllcyhtb2R1bGUpO1xyXG5cclxuICAgICAgICAgICAgLy8gW0RFQlVHXSBDaGVjayB3aGF0IHdlIGZvdW5kXHJcbiAgICAgICAgICAgIC8vIGNvbnNvbGUubG9nKGBbV29ya2VyICR7cGlkfV0gTG9hZGVkIG1vZHVsZSBmb3IgJHthcHBOYW1lfS4gS2V5czogJHtPYmplY3Qua2V5cyhtb2R1bGUpLmpvaW4oXCIsIFwiKX1gKTtcclxuXHJcbiAgICAgICAgICAgIC8vIFNUUkFURUdJIFNUQU5EQVI6IENhcmkgZXhwb3J0IGJlcm5hbWEgJ21haW4nXHJcbiAgICAgICAgICAgIGlmIChtb2R1bGUubWFpbikge1xyXG4gICAgICAgICAgICAgICAgQXBwQ2xhc3MgPSBtb2R1bGUubWFpbjtcclxuICAgICAgICAgICAgfSBlbHNlIGlmIChtb2R1bGUuTWFpbikge1xyXG4gICAgICAgICAgICAgICAgQXBwQ2xhc3MgPSBtb2R1bGUuTWFpbjtcclxuICAgICAgICAgICAgfSBlbHNlIGlmIChtb2R1bGUuZGVmYXVsdCkge1xyXG4gICAgICAgICAgICAgICAgQXBwQ2xhc3MgPSBtb2R1bGUuZGVmYXVsdDtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIC8vIEZhbGxiYWNrOiBBbWJpbCBleHBvcnQgcGVydGFtYSB5YW5nIGJlcnVwYSBjbGFzcy9mdW5jdGlvblxyXG4gICAgICAgICAgICAgICAgY29uc3QgZm91bmQgPSBlbnRyaWVzLmZpbmQoKFtfLCB2YWxdOiBbc3RyaW5nLCBhbnldKSA9PiB0eXBlb2YgdmFsID09PSBcImZ1bmN0aW9uXCIpO1xyXG4gICAgICAgICAgICAgICAgaWYgKGZvdW5kKSBBcHBDbGFzcyA9IGZvdW5kWzFdO1xyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICBpZiAoQXBwQ2xhc3MpIHtcclxuICAgICAgICAgICAgICAgIC8vIGNvbnNvbGUubG9nKGBbV29ya2VyICR7cGlkfV0gSWRlbnRpZmllZCBBcHBDbGFzcyBmb3IgJHthcHBOYW1lfWApO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgbG9hZEZhaWx1cmUgPSBcIm5vIHZhbGlkICdtYWluJyBleHBvcnQgZm91bmRcIjtcclxuICAgICAgICAgICAgICAgIGxvYWRFcnJvckRldGFpbCA9IGBGYWlsZWQgdG8gaWRlbnRpZnkgQXBwQ2xhc3MgZm9yICR7YXBwTmFtZX0uIE1vZHVsZSBleHBvcnRzOiAke09iamVjdC5rZXlzKG1vZHVsZSkuam9pbihcIiwgXCIpfWA7XHJcbiAgICAgICAgICAgICAgICBlbWl0V29ya2VyRXJyb3IoXHJcbiAgICAgICAgICAgICAgICAgICAgbGliLFxyXG4gICAgICAgICAgICAgICAgICAgIHBpZCxcclxuICAgICAgICAgICAgICAgICAgICBgRmFpbGVkIHRvIGlkZW50aWZ5IEFwcENsYXNzIGZvciAke2FwcE5hbWV9LiBNb2R1bGUgZXhwb3J0czogJHtPYmplY3Qua2V5cyhtb2R1bGUpLmpvaW4oXCIsIFwiKX1gLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0gY2F0Y2ggKGVycjogYW55KSB7XHJcbiAgICAgICAgICAgIGxvYWRGYWlsdXJlID0gXCJmYWlsZWQgdG8gbG9hZCBtb2R1bGVcIjtcclxuICAgICAgICAgICAgbG9hZEVycm9yRGV0YWlsID0gYFJ1bnRpbWUgRXJyb3I6IEZhaWxlZCB0byByZXF1aXJlICR7ZmluYWxBcHBQYXRoIHx8IGFwcE5hbWV9OiAke2Vyci5tZXNzYWdlfWA7XHJcbiAgICAgICAgICAgIGVtaXRXb3JrZXJFcnJvcihsaWIsIHBpZCwgYFJ1bnRpbWUgRXJyb3I6IEZhaWxlZCB0byByZXF1aXJlICR7ZmluYWxBcHBQYXRoIHx8IGFwcE5hbWV9OiAke2Vyci5tZXNzYWdlfWApO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBpZiAoIUFwcENsYXNzKSB7XHJcbiAgICAgICAgaWYgKHBhcmVudFBvcnQpIHtcclxuICAgICAgICAgICAgY29uc3QgZXJyb3JNc2cgPSBsb2FkRmFpbHVyZVxyXG4gICAgICAgICAgICAgICAgPyBgLWJhc2g6ICR7YXBwTmFtZX06IEZhaWxlZCB0byBsb2FkIFx1MjAxNCAke2xvYWRGYWlsdXJlfVxcbmBcclxuICAgICAgICAgICAgICAgIDogYC1iYXNoOiAke2FwcE5hbWV9OiBBcHBsaWNhdGlvbiBub3QgZm91bmQgKFBhdGg6ICR7YXBwUGF0aCB8fCBcIlZGUy1Pbmx5XCJ9KVxcbmA7XHJcbiAgICAgICAgICAgIGF3YWl0IGxpYi5zdGQucHJpbnQoZXJyb3JNc2cpO1xyXG4gICAgICAgICAgICBwYXJlbnRQb3J0LnBvc3RNZXNzYWdlKHtcclxuICAgICAgICAgICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxyXG4gICAgICAgICAgICAgICAgZXJyb3I6IGVycm9yTXNnLnRyaW0oKSxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIC8vIFRhbXBpbGthbiBqdWdhIGRpIGRlc2t0b3AgKFdNL0FzdGVyYWNlYSkgdmlhIEdVSV9XSU5ET1dfRVJST1IuXHJcbiAgICAgICAgICAgIC8vIFdBSklCIGRpLWF3YWl0OiByZWFsRXhpdCgxKSBkaSBiYXdhaCBsYW5nc3VuZyBtZW1hdGlrYW4gd29ya2VyLCBkYW5cclxuICAgICAgICAgICAgLy8ga2FsYXUgZmlyZS1hbmQtZm9yZ2V0LCBraXJpbWFuIGFzeW5jLW55YSB0YWsgc2VtcGF0IHNlbGVzYWkuXHJcbiAgICAgICAgICAgIC8vIFBvcHVwIHBha2FpIGRldGFpbCBlcnJvciBhc2xpIChsb2FkRXJyb3JEZXRhaWwpIGJpYXIgc3Blc2lmaWsuXHJcbiAgICAgICAgICAgIGF3YWl0IG5vdGlmeUxvYWRFcnJvcihsaWIsIHBpZCwgYXBwTmFtZSwgbG9hZEVycm9yRGV0YWlsIHx8IGVycm9yTXNnLnRyaW0oKSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJlYWxFeGl0KDEpO1xyXG4gICAgfVxyXG5cclxuICAgIC8vIDMuIEFLVElGS0FOIFNBTkRCT1ggKEt1bmNpIHBpbnR1IHNlYmVsdW0gYXBsaWthc2kgYmVyamFsYW4pXHJcbiAgICByZXN0cmljdEhvc3RBUEkoYXBwTmFtZSk7XHJcblxyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBhcHAgPSBuZXcgQXBwQ2xhc3MoKTtcclxuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBhcHAuZXhlY3V0ZShsaWIgYXMgYW55LCBhcmdzKTtcclxuXHJcbiAgICAgICAgLy8gMy4gSmlrYSBhcGxpa2FzaSBtZS1yZXR1cm4gc3RyaW5nLCBjZXRhayBrZSBsYXlhciB2aWEgUFJJTlQgc3lzY2FsbFxyXG4gICAgICAgIGlmIChyZXN1bHQgJiYgdHlwZW9mIHJlc3VsdCA9PT0gXCJzdHJpbmdcIiAmJiByZXN1bHQudHJpbSgpICE9PSBcIlwiKSB7XHJcbiAgICAgICAgICAgIGF3YWl0IGxpYi5zdGQucHJpbnQocmVzdWx0ICsgXCJcXG5cIik7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICAvLyA0LiBCZXJpdGFodSBLZXJuZWwgYmFod2EgcHJvc2VzIHNlbGVzYWlcclxuICAgICAgICBhd2FpdCBsaWIuc2hlbGwuZXhpdCgwKTtcclxuICAgIH0gY2F0Y2ggKGVycm9yOiBhbnkpIHtcclxuICAgICAgICAvLyBMYXBvcmthbiBlcnJvciBrZSBwYXJlbnQgKFdNKSB2aWEgSVBDXHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgcGFyZW50UGlkID0gYXdhaXQgbGliLmdldFBhcmVudFBpZCgpO1xyXG4gICAgICAgICAgICBpZiAocGFyZW50UGlkKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBsaWIuc2hlbGwuc2VuZChwYXJlbnRQaWQsIHtcclxuICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIkdVSV9XSU5ET1dfRVJST1JcIixcclxuICAgICAgICAgICAgICAgICAgICB3aWQ6IFwiXCIsXHJcbiAgICAgICAgICAgICAgICAgICAgcGlkOiBsaWIuZ2V0UGlkKCksXHJcbiAgICAgICAgICAgICAgICAgICAgZmlsZTogYXBwTmFtZSB8fCBcIlwiLFxyXG4gICAgICAgICAgICAgICAgICAgIGVycm9yOiBgUnVudGltZSBFcnJvcjogJHtlcnJvci5tZXNzYWdlfWAsXHJcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dDogXCJydW50aW1lXCIsXHJcbiAgICAgICAgICAgICAgICAgICAgdGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkucmVwbGFjZShcIlRcIiwgXCIgXCIpLnN1YnN0cmluZygwLCAxOSksXHJcbiAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0gY2F0Y2ggKF8pIHtcclxuICAgICAgICAgICAgLyogSVBDIHNlbmQgZmFpbHVyZSBpcyBub24tZmF0YWwgKi9cclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8vIEp1Z2EgY29iYSBsZXdhdCBzdGQuZXJyb3IgeWFuZyBwdW55YSBtZWthbmlzbWUgbGViaWggbGVuZ2thcFxyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGF3YWl0IGxpYi5zdGQuZXJyb3IoZXJyb3IubWVzc2FnZSB8fCBTdHJpbmcoZXJyb3IpLCBhcHBOYW1lIHx8IFwiYXBwXCIpO1xyXG4gICAgICAgIH0gY2F0Y2ggKF8pIHt9XHJcblxyXG4gICAgICAgIC8vIExhcG9ya2FuIGVycm9yIGtlIFRUWSBjb25zb2xlXHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgYXdhaXQgbGliLnN0ZC5wcmludChgXFxuW1dvcmtlciAke3BpZH1dIFJ1bnRpbWUgRXJyb3I6ICR7ZXJyb3IubWVzc2FnZX1cXG5gKTtcclxuICAgICAgICB9IGNhdGNoIChlKSB7fVxyXG4gICAgICAgIHJlYWxFeGl0KDEpO1xyXG4gICAgfVxyXG59XHJcblxyXG5tYWluKCk7XHJcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLDRCQUF1QztBQUV2QywrQkFBMkQ7QUFpQjNELE1BQU0saUJBQWlCLENBQUMsUUFDcEIsUUFBUSxRQUFRLFFBQVEsU0FBWSxLQUFLLE9BQU8sS0FBSyxLQUFLLFFBQVEsRUFBRSxTQUFTLE1BQU07QUFVdkYsTUFBTSxjQUFj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
