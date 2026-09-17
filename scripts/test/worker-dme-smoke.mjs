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
 *   SMOKE_FILES="/tmp/x.sh=./fixtures/x.sh" \
 *     node scripts/test/worker-dme-smoke.mjs src/mirror/bin/tsh.ts -- /tmp/x.sh halo
 *
 * Env opsional:
 *   SMOKE_FILES=<vfsPath>=<hostPath>[;...]  — file yang “ada” di VFS palsu
 *   SMOKE_FILE_MODE=<oktal>                — mode file fixture (default 755)
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
// Selalu pakai nama `.js`: runtime mengeksekusi sidecar hasil transpile.
const APP_VFS = (appRel.startsWith("src/mirror/")
  ? "/" + appRel.slice("src/mirror/".length)
  : "/" + path.basename(appRel)
).replace(/\.ts$/, ".js");

/** File yang “ada” di VFS palsu: `SMOKE_FILES="/tmp/a.sh=/host/a.sh;..."`. */
const fixtures = new Map();
for (const pair of (process.env.SMOKE_FILES || "").split(";").filter(Boolean)) {
  const eq = pair.indexOf("=");
  if (eq <= 0) continue;
  fixtures.set(pair.slice(0, eq), fs.readFileSync(pair.slice(eq + 1), "utf8"));
}

// State sederhana ala kernel: env, cwd, tabel fd.
const env = { PATH: "/bin", HOME: "/root", LINES: "24", COLUMNS: "80" };
const setenvLog = [];
const fdTable = new Map();
// Mode file fixture — 0o644 dipakai untuk menguji penolakan skrip tanpa bit x.
const fileMode = parseInt(process.env.SMOKE_FILE_MODE || "755", 8);
let cwd = "/";
let nextFd = 3;

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
    case 5: {
      // OPEN: path string atau { path, flags }
      const p = typeof args === "string" ? args : args?.path;
      if (!fixtures.has(p)) return -1;
      const fd = nextFd++;
      fdTable.set(fd, fixtures.get(p));
      return fd;
    }
    case 6: {
      // READ: fd numerik → seluruh isi file
      const fd = typeof args === "number" ? args : args?.fd;
      return fdTable.has(fd) ? fdTable.get(fd) : null;
    }
    case 8: {
      // CLOSE
      fdTable.delete(typeof args === "number" ? args : args?.fd);
      return true;
    }
    case 9: // SCREEN_INFO
      return { rows: 24, columns: 80 };
    case 13: // CHDIR
      cwd = String(args ?? "/");
      return true;
    case 14: // GETCWD
      return cwd;
    case 17: // WHOAMI
      return {
        uid: 0,
        gid: 0,
        ruid: 0,
        groups: [0],
        username: "root",
        name: "root",
      };
    case 18: // GETENV
      return env[String(args)] ?? null;
    case 19: {
      // SETENV: { name, value }
      const name = args?.name;
      const value = args?.value;
      if (typeof name === "string") {
        env[name] = String(value ?? "");
        setenvLog.push(`${name}=${env[name]}`);
      }
      return true;
    }
    case 20: {
      // STAT — hanya file fixture yang dianggap ada
      const p = String(args);
      if (!fixtures.has(p)) return null;
      return {
        name: path.basename(p),
        type: "FILE",
        size: fixtures.get(p).length,
        mode: fileMode,
        uid: 0,
        gid: 0,
        modified_at: Date.now(),
      };
    }
    case 25: // WAITPID
      return 0;
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
  if (printed[0]) console.log(`--- output app ---\n${printed[0].split("\n").slice(0, 8).join("\n")}\n------------------`);
  if (setenvLog.length) {
    console.log(`[smoke] SETENV: ${setenvLog.join(" | ")}`);
  }
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
