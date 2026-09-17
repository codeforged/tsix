#!/usr/bin/env node
/**
 * worker-dme-smoke.mjs — smoke test loader DME (Direct Memory Execution)
 *
 * Menjalankan `WorkerEntry.js` di worker thread dengan `vfsCache` yang dibangun
 * dari source repo (persis cara kernel melakukannya):
 *
 *   src/mirror/lib/**  → /lib/**
 *   src/common/**      → /lib/common/**
 *   app .ts            → appContent (JS hasil transpile, seperti sidecar .js)
 *
 * Lalu aplikasi dijalankan sampai balasan syscall pertama. Tujuannya bukan
 * menguji fitur aplikasi, tapi membuktikan **graf modul framework + app benar
 * bisa dimuat** — jalur yang dipakai runtime TSIX (dan tempat bug seperti
 * "Cannot find module './X'" muncul).
 *
 * Pakai:
 *   node scripts/test/worker-dme-smoke.mjs [path-app-relatif] [-- args...]
 * Contoh:
 *   node scripts/test/worker-dme-smoke.mjs src/mirror/sbin/netfsd.ts -- --help
 *
 * Exit code 0 = modul termuat & app mulai jalan; 1 = gagal (detail dicetak).
 */
import { Worker } from "node:worker_threads";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY = path.join(ROOT, "src/userland/WorkerEntry.js");

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const appRel = (sep === -1 ? argv[0] : argv[0]) || "src/mirror/sbin/netfsd.ts";
const appArgs = sep === -1 ? ["--help"] : argv.slice(sep + 1);
const APP_HOST = path.join(ROOT, appRel);
// Path "BKFS" untuk app (dipakai WorkerEntry untuk __filename + stack trace).
const APP_VFS = appRel.startsWith("src/mirror/")
  ? "/" + appRel.slice("src/mirror/".length)
  : "/" + path.basename(appRel);

/** Transpile seperti kernel (`esbuild.transformSync`, tanpa bundling). */
function transpile(file) {
  return esbuild.transformSync(fs.readFileSync(file, "utf8"), {
    loader: "ts",
    format: "cjs",
    target: "node18",
  }).code;
}

/** Bangun vfsCache dari source (mirror `install.ts` + `Kernel.rebuildVFSCache`). */
function buildVfsCache() {
  const cache = {};
  const walk = (hostDir, vfsDir) => {
    for (const item of fs.readdirSync(hostDir, { withFileTypes: true })) {
      if (item.name.endsWith(".test.ts") || item.name.endsWith(".spec.ts")) continue;
      const host = path.join(hostDir, item.name);
      const vfs = `${vfsDir}/${item.name}`;
      if (item.isDirectory()) walk(host, vfs);
      else if (item.name.endsWith(".ts")) cache[vfs] = transpile(host);
    }
  };
  walk(path.join(ROOT, "src/mirror/lib"), "/lib");
  walk(path.join(ROOT, "src/common"), "/lib/common");
  return cache;
}

/** Balasan syscall minimal supaya app bisa maju (tidak perlu kernel asli). */
function answerSyscall(code, args, printed) {
  switch (code) {
    case 1: // PRINT
      printed.push(typeof args === "string" ? args : JSON.stringify(args));
      return 0;
    case 9: // SCREEN_INFO
      return { rows: 24, columns: 80 };
    case 14: // GETCWD
      return "/";
    case 17: // WHOAMI
      return { uid: 0, gid: 0, username: "root", name: "root", groups: [0] };
    case 18: // GETENV
      return "";
    default:
      return 0;
  }
}

const errors = [];
const printed = [];

const vfsCache = buildVfsCache();
console.log(
  `[smoke] vfsCache: ${Object.keys(vfsCache).length} modul · app: ${APP_VFS} · args: [${appArgs.join(" ")}]`,
);

const worker = new Worker(ENTRY, {
  workerData: {
    pid: 99,
    appName: APP_VFS,
    args: appArgs,
    stackBkfsPath: APP_VFS,
    appContent: transpile(APP_HOST), // sidecar .js: sudah JS, tidak ditranspile lagi
    env: {},
    vfsCache,
  },
  stdout: true,
  stderr: true,
});

let finished = false;
const done = (code) => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  try {
    worker.terminate();
  } catch (_) {}

  const stderr = stderrChunks.join("");
  // Error loader bisa muncul lewat stderr ATAU lewat syscall PRINT/`std.error`.
  // Jangan cuma percaya stderr — kalau tidak, kegagalan lolos sebagai "sukses".
  const combined = [stderr, errors.join("\n"), printed.join("\n")].join("\n");
  const loadError = /Direct Execution Error|Cannot find module|Failed to load/.test(combined);
  const ok = !loadError;

  console.log(`[smoke] syscall PRINT diterima: ${printed.length}`);
  if (printed[0]) console.log(`--- output app ---\n${printed[0].split("\n").slice(0, 4).join("\n")}\n------------------`);
  if (stderr.trim()) console.log(`[smoke] stderr:\n${stderr.trim()}`);

  if (ok) {
    console.log("[smoke] ✅ graf modul termuat & app berjalan");
  } else {
    console.log("[smoke] ❌ GAGAL memuat modul (lihat stderr di atas)");
  }
  process.exit(ok ? 0 : 1);
};

const stderrChunks = [];
worker.stderr.on("data", (d) => stderrChunks.push(String(d)));
worker.stdout.on("data", () => {});
worker.on("error", (err) => {
  errors.push(`worker error: ${err.message}`);
  done(1);
});
worker.on("exit", () => done(0));
worker.on("message", (msg) => {
  if (msg && typeof msg.requestId === "string") {
    let data = null;
    try {
      data = answerSyscall(msg.code, msg.args, printed);
    } catch (e) {
      errors.push(String(e));
    }
    worker.postMessage({ requestId: msg.requestId, success: true, data });
    return;
  }
  // Event push (GUI/signal) — tidak relevan untuk smoke test.
});

const timer = setTimeout(() => {
  errors.push("timeout: worker tidak selesai dalam 20s");
  done(1);
}, 20000);
