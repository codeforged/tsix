import { BKFS } from "../src/vfs/BKFS";
import * as fs from "fs";
import * as path from "path";
import * as esbuild from "esbuild";
import * as readline from "readline/promises";
import * as bcrypt from "bcryptjs";
import type { SysConfig } from "../src/common/Config";

/**
 * INSTALL AGENT (Fresh Install TSIX)
 *
 * Membuat image sistem baru dari nol:
 *   1. Tanya konfigurasi ke user secara interaktif (hostname, distro, broker MQTT, dll).
 *   2. Tulis hasil konfigurasi ke src/sysconfig.json.
 *   3. Buat file database .db yang BENAR-BENAR BARU (file lama otomatis di-backup).
 *   4. Sinkronkan seluruh src/mirror (rootfs) ke database baru (transpile TS -> JS + SetUID).
 *   5. (Opsional) set password root ke /etc/shadow.
 *
 * Cara pakai (dari root project):
 *   npm run install                     -> interaktif, db default dari sysconfig.json
 *   npm run install -- --path data/tsix.db --force
 *   npm run install -- --defaults       -> non-interaktif (pakai semua nilai default)
 *   npm run install -- --no-config      -> lewati penulisan src/sysconfig.json
 */

interface InstallOptions {
  dbPath: string;
  force: boolean;
  interactive: boolean;
  writeConfig: boolean;
}

const MIRROR_ROOT = path.resolve(__dirname, "../src/mirror");
const CONFIG_PATH = path.resolve(__dirname, "../src/sysconfig.json");
const PROJECT_ROOT = path.resolve(__dirname, "..");

/**
 * Direktori executable standar (FHS) — semua file .ts/.js di sini diberi bit
 * execute saat sync agar bisa dijalankan dari PATH.
 */
const EXEC_DIRS = ["/bin", "/sbin", "/usr/bin", "/usr/local/bin", "/opt"];

/**
 * Binary istimewa yang wajib berjalan sebagai pemilik file (SetUID root):
 * login, passwd, dan sudo — semuanya butuh akses baca/tulis /etc/shadow.
 * Dikenali baik versi .ts maupun sidecar .js yang benar-benar dieksekusi runtime.
 */
function isSetuidBinary(vfsPath: string): boolean {
  return /\/bin\/(login|passwd|sudo)\.(ts|js)$/.test(vfsPath);
}

function isExecutableBinary(vfsPath: string): boolean {
  return EXEC_DIRS.some((d) => vfsPath.startsWith(d + "/"));
}

/** Terapkan mode eksekusi (dan SetUID untuk login/passwd/sudo). */
function applyBinaryMode(bkfs: BKFS, vfsPath: string, label = "INSTALL"): void {
  if (isSetuidBinary(vfsPath)) {
    bkfs.chmod(vfsPath, 0o4755);
    bkfs.chown(vfsPath, 0, 0);
    console.log(`[${label}] SetUID+chown root -> ${vfsPath}`);
  } else if (isExecutableBinary(vfsPath)) {
    // /sbin = root-only (0o744), lainnya 0o755 (semua user)
    bkfs.chmod(vfsPath, vfsPath.startsWith("/sbin/") ? 0o744 : 0o755);
  }
}

function parseArgs(argv: string[]): InstallOptions {
  const opts: InstallOptions = {
    dbPath: "",
    force: false,
    interactive: true,
    writeConfig: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--path") opts.dbPath = argv[++i] || "";
    else if (a === "--force") opts.force = true;
    else if (a === "--defaults") opts.interactive = false;
    else if (a === "--no-config") opts.writeConfig = false;
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: npm run install -- [options]

  --path <db>    Path database baru (default: dari sysconfig.json)
  --force        Timpa database lama (otomatis di-backup)
  --defaults     Non-interaktif: pakai semua nilai default
  --no-config    Lewati penulisan src/sysconfig.json`);
      process.exit(0);
    }
  }
  return opts;
}

/** Sync rekursif src/mirror -> VFS (sama seperti vfs-bootstrap). */
function syncDir(bkfs: BKFS, hostDir: string, vfsDir: string): void {
  if (!bkfs.exists(vfsDir)) {
    bkfs.mkdir(vfsDir, 0, 0, 0o755);
    console.log(`[INSTALL] mkdir ${vfsDir}`);
  }

  const items = fs.readdirSync(hostDir);
  for (const item of items) {
    const fullHostPath = path.join(hostDir, item);
    const fullVfsPath = path.join(vfsDir, item).replace(/\\/g, "/");
    const stats = fs.statSync(fullHostPath);

    if (stats.isDirectory()) {
      syncDir(bkfs, fullHostPath, fullVfsPath);
      continue;
    }

    const isTarget =
      item.endsWith(".ts") ||
      item.endsWith(".js") ||
      item.endsWith(".json") ||
      item.endsWith(".html") ||
      item.endsWith(".css") ||
      item.endsWith(".menu") ||
      item.endsWith(".mp3") ||
      item.endsWith(".wav") ||
      item.endsWith(".jpg") ||
      item.endsWith(".jpeg") ||
      item.endsWith(".png") ||
      item.endsWith(".gif") ||
      item.endsWith(".bmp") ||
      item.endsWith(".svg") ||
      item.endsWith(".webp") ||
      item.endsWith(".ico");
    if (!isTarget) continue;

    // Binary assets (audio/gambar raster) disimpan sebagai latin1 string
    // (1 byte = 1 char) — cocok dengan Buffer.from(raw,"latin1") di sisi app.
    const isBinary =
      item.endsWith(".mp3") ||
      item.endsWith(".wav") ||
      item.endsWith(".jpg") ||
      item.endsWith(".jpeg") ||
      item.endsWith(".png") ||
      item.endsWith(".gif") ||
      item.endsWith(".bmp") ||
      item.endsWith(".webp") ||
      item.endsWith(".ico");
    const content = isBinary
      ? fs.readFileSync(fullHostPath).toString("latin1")
      : fs.readFileSync(fullHostPath, "utf8");

    bkfs.touch(fullVfsPath, content);

    // Transpile TS -> JS sidecar (yang dieksekusi runtime)
    if (fullVfsPath.endsWith(".ts")) {
      try {
        const result = esbuild.transformSync(content, {
          loader: "ts",
          format: "cjs",
          target: "node18",
          sourcemap: "inline",
        });
        if (result.code) {
          const jsPath =
            fullVfsPath.substring(0, fullVfsPath.length - 3) + ".js";
          bkfs.touch(jsPath, result.code);

          if (isSetuidBinary(jsPath) || isExecutableBinary(jsPath)) {
            applyBinaryMode(bkfs, jsPath);
          }
        }
      } catch (e: any) {
        console.error(
          `[INSTALL] Warning: compile gagal ${fullVfsPath}: ${e.message}`,
        );
      }
    }

    // Auto-executable untuk file di direktori eksekusi (/bin, /sbin, dll)
    if (
      (isSetuidBinary(fullVfsPath) || isExecutableBinary(fullVfsPath)) &&
      (fullVfsPath.endsWith(".ts") || fullVfsPath.endsWith(".js"))
    ) {
      applyBinaryMode(bkfs, fullVfsPath);
    }
  }
}

/**
 * Ambil versi kernel langsung dari src/kernel/Kernel.ts (field `version`),
 * agar default sysconfig selalu sinkron dengan versi kernel sebenarnya.
 * Fallback dipakai hanya kalau file tidak terbaca / pola tidak ketemu.
 */
function getKernelVersion(): string {
  const kernelPath = path.resolve(__dirname, "../src/kernel/Kernel.ts");
  try {
    const src = fs.readFileSync(kernelPath, "utf8");
    const m = src.match(/private\s+version:\s*string\s*=\s*"([^"]+)"/);
    if (m && m[1]) return m[1];
  } catch (_) {
    /* abaikan */
  }
  return "0.0.1-alpha";
}

/**
 * Konfigurasi default — dipakai kalau src/sysconfig.json belum ada
 * (mis. sebelum instalasi pertama). install.ts TIDAK boleh bergantung pada
 * file itu; ia yang membuatnya.
 */
function createDefaultConfig(): SysConfig {
  return {
    kernel: {
      version: getKernelVersion(),
      database: "system.db",
      rootHostPath: "../mirror",
      bootLogPath: "/logs/boot.log",
      verbose: true,
      distroName: "Antigonon leptopus",
      engineName: "TSIX-Dinawari",
    },
    logger: {
      defaultLevel: "INFO",
      logFile: "jsix.log",
      enableConsole: false,
    },
    scheduler: {
      workerEntryPath: "../userland/WorkerEntry.js",
      defaultPath: "/bin",
      defaultCwd: "/",
      bootEntry: "init.js",
      defaultShell: "tsh.ts",
    },
    shell: {
      defaultUser: "root",
      defaultHostname: "tsix",
      promptFormat: "&username@&hostname:&cwd&usertype ",
      defaultRows: 24,
      defaultColumns: 80,
      historyPath: "/.sh_history",
    },
    network: {
      interfaces: [
        {
          broker: "mqtt://localhost",
          deviceName: "smqtnl0",
          address: "tsix",
          defaultPort: 1883,
        },
        {
          broker: "mqtt://localhost",
          deviceName: "smqtnl1",
          address: "tsix-node-2",
          defaultPort: 1883,
        },
      ],
      defaultDevice: "smqtnl0",
    },
    devices: {},
  };
}

function loadConfig(): SysConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log("[INSTALL] src/sysconfig.json belum ada — memakai konfigurasi default.");
    return createDefaultConfig();
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e: any) {
    console.log(
      `[INSTALL] src/sysconfig.json tidak valid (${e.message}) — memakai konfigurasi default.`,
    );
    return createDefaultConfig();
  }
}

function saveConfig(cfg: SysConfig): void {
  // Pastikan folder src/ ada (bisa saja belum ada sebelum instalasi pertama)
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  console.log(`[INSTALL] Konfigurasi ditulis ke: ${CONFIG_PATH}`);
}

async function prompt(
  rl: readline.Interface,
  question: string,
  def?: string,
): Promise<string> {
  const suffix = def !== undefined && def !== "" ? ` [${def}]` : "";
  const answer = (await rl.question(`${question}${suffix} `)).trim();
  return answer === "" ? (def ?? "") : answer;
}

async function promptYesNo(
  rl: readline.Interface,
  question: string,
  def: boolean,
): Promise<boolean> {
  const ans = (await prompt(rl, question, def ? "y" : "n")).toLowerCase();
  return ans === "y" || ans === "yes" || ans === "true" || ans === "1";
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const defaultDbRel = opts.dbPath || cfg.kernel.database || "system.db";

  let dbRel = defaultDbRel;
  let rootPassword = "";

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    // ============ 1. KONFIGURASI INTERAKTIF ============
    if (opts.interactive) {
      console.log("\n== TSIX Fresh Install — Konfigurasi ==");

      cfg.shell.defaultHostname = await prompt(
        rl,
        "Hostname",
        cfg.shell.defaultHostname,
      );
      cfg.shell.defaultUser = await prompt(
        rl,
        "Default user login",
        cfg.shell.defaultUser,
      );

      const broker = await prompt(
        rl,
        "Broker MQTT (mqtt://host:port)",
        cfg.network.interfaces[0]?.broker,
      );
      if (broker) {
        cfg.network.interfaces.forEach((i) => (i.broker = broker));
      }
      if (broker.includes("localhost") || broker.includes("127.0.0.1")) {
        console.log("[INSTALL] Note: this requires a local MQTT broker (e.g. Mosquitto) to be running.");
        console.log("          Install guide: https://mosquitto.org/download/");
      }

      const portStr = await prompt(
        rl,
        "Port MQTT default",
        String(cfg.network.interfaces[0]?.defaultPort ?? 1883),
      );
      const port = parseInt(portStr, 10);
      if (!isNaN(port)) {
        cfg.network.interfaces.forEach((i) => (i.defaultPort = port));
      }

      cfg.kernel.verbose = await promptYesNo(
        rl,
        "Verbose kernel",
        cfg.kernel.verbose ?? true,
      );

      dbRel = await prompt(rl, "New database filename (e.g. system.db)", dbRel);
      rootPassword = await prompt(
        rl,
        "Root password (leave empty to keep default)",
        "",
      );
    }

    // Address interface otomatis mengikuti hostname (di semua mode):
    //   interface[0] = <hostname>, interface[1..n] = <hostname>_2, _3, ...
    // Terlalu teknis untuk ditanyakan ke user — cukup derive dari hostname.
    const host = cfg.shell.defaultHostname || "tsix";
    cfg.network.interfaces.forEach((iface, i) => {
      iface.address = i === 0 ? host : `${host}_${i + 1}`;
    });

    const dbPath = path.resolve(PROJECT_ROOT, dbRel);

    // ============ 2. TULIS SYS CONFIG ============
    if (opts.writeConfig) {
      cfg.kernel.database = path.relative(PROJECT_ROOT, dbPath).replace(/\\/g, "/");
      saveConfig(cfg);
    }

    // ============ 3. BUAT DB BARU ============
    if (fs.existsSync(dbPath)) {
      if (!opts.force) {
        console.error(`[INSTALL] Database sudah ada: ${dbPath}`);
        console.error(
          `          Pakai --force untuk menimpa (lama di-backup otomatis).`,
        );
        process.exit(1);
      }
      const bak = `${dbPath}.bak-${Date.now()}`;
      fs.renameSync(dbPath, bak);
      console.log(`[INSTALL] Database lama di-backup ke: ${bak}`);
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const bkfs = new BKFS(dbPath);
    console.log(`[INSTALL] Database baru dibuat: ${dbPath}`);

    // ============ 4. SYNC ROOTFS ============
    console.log(`[INSTALL] Menyalin rootfs dari ${MIRROR_ROOT} ...`);
    syncDir(bkfs, MIRROR_ROOT, "/");
    console.log("[INSTALL] Rootfs berhasil disinkronkan.");

    // Framework @common/* (SyscallCode, IPCTypes, dll) dipakai WorkerEntry via
    // /lib/common. Sync src/common -> /lib/common (sama seperti vfs-bootstrap).
    const COMMON_ROOT = path.resolve(__dirname, "../src/common");
    if (fs.existsSync(COMMON_ROOT)) {
      console.log(`[INSTALL] Menyalin framework common dari ${COMMON_ROOT} ...`);
      syncDir(bkfs, COMMON_ROOT, "/lib/common");
      console.log("[INSTALL] Framework common berhasil disinkronkan.");
    }

    // File /etc tanpa ekstensi tidak ikut filter ekstensi syncDir.
    // Sync eksplisit agar image fresh lengkap & konsisten (passwd/group/shadow, dll).
    const CRITICAL_ETC = [
      "crontab",
      "fstab.md",
      "group",
      "motd",
      "passwd",
      "pkg-demo.conf",
      "profile",
      "shadow",
    ];
    for (const name of CRITICAL_ETC) {
      const hostFile = path.join(MIRROR_ROOT, "etc", name);
      if (!fs.existsSync(hostFile)) continue;
      const content = fs.readFileSync(hostFile, "utf8");
      const mode = name === "shadow" ? 0o640 : 0o644;
      bkfs.touch(`/etc/${name}`, content, 0, 0, mode);
      console.log(`[INSTALL] sync /etc/${name}`);
    }

    // Image fresh: fstab hanya berisi /tmp sebagai RAMFS (esensial),
    // mount dev-specific (/mnt/shared, /mnt/sbak) TIDAK dibawa.
    // Crontab dikosongkan (tidak membawa jadwal bawaan developer).
    const FSTAB_FRESH = JSON.stringify(
      [
        {
          vfsPath: "/tmp",
          hostPath: "RAM",
          type: "ramfs",
          readOnly: false,
          uid: 0,
          gid: 100,
          mode: 0o1777, // 1023 = drwxrwxrwt (sticky)
          active: true,
        },
      ],
      null,
      2,
    );
    bkfs.touch("/etc/fstab.json", FSTAB_FRESH + "\n", 0, 0, 0o644);
    console.log("[INSTALL] /etc/fstab.json: hanya /tmp (ramfs), mount dev dihapus");
    bkfs.touch(
      "/etc/crontab",
      "# /etc/crontab — kosong untuk instalasi baru.\n" +
        "# Isi jadwal dengan: crontab -e\n",
      0,
      0,
      0o644,
    );
    console.log("[INSTALL] /etc/crontab dikosongkan");

    // ============ 5. PASSWORD ROOT (OPSIONAL) ============
    if (rootPassword) {
      const hash = bcrypt.hashSync(rootPassword, bcrypt.genSaltSync(10));
      const shadow = bkfs.read("/etc/shadow") || "";
      const lines = shadow.split("\n").filter((l) => l.trim().length > 0);
      const idx = lines.findIndex((l) => l.startsWith("root:"));
      if (idx >= 0) {
        const parts = lines[idx].split(":");
        parts[1] = hash;
        lines[idx] = parts.join(":");
        bkfs.touch("/etc/shadow", lines.join("\n") + "\n", 0, 0, 0o640);
        console.log("[INSTALL] Password root diperbarui di /etc/shadow.");
      }
    }

    // ============ VERIFIKASI ============
    try {
      const db = (bkfs as any).db;
      const count = db?.prepare("SELECT COUNT(*) AS c FROM vnodes").get();
      const passwd = (bkfs.read("/etc/passwd") || "").trim();
      const groups = (bkfs.read("/etc/group") || "").trim();
      const shadow = bkfs.read("/etc/shadow");
      console.log(`[INSTALL] Verifikasi: total node=${count?.c ?? "?"}`);
      console.log(
        `[INSTALL] /etc/passwd: ${passwd ? passwd.split("\n").length : 0} akun`,
      );
      console.log(
        `[INSTALL] Group tersedia: ${
          groups ? groups.split("\n").map((l) => l.split(":")[0]).join(", ") : "(tidak ada)"
        }`,
      );
      console.log(
        `[INSTALL] /etc/shadow: ${shadow ? shadow.split("\n").length : 0} entri (mode aman)`,
      );
    } catch (_) {
      /* abaikan error verifikasi */
    }

    // Tutup koneksi DB biar file ter-flush rapi
    try {
      (bkfs as any).db?.close?.();
    } catch (_) {
      /* proses akan exit */
    }

    console.log("\n[INSTALL] Selesai! Image sistem siap.");
    console.log(`           DB       : ${dbPath}`);
    console.log(
      `           Hostname : ${cfg.shell.defaultHostname}  (lihat src/sysconfig.json)`,
    );
    console.log("           Jalankan dengan: npm start");
  } finally {
    rl.close();
  }
}

main();
