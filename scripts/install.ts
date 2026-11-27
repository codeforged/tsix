import { BKFS } from "../src/vfs/BKFS";
import { createUserAccount } from "./lib/user-account";
import { ensureFreshAccountFiles } from "./lib/fresh-accounts";
import { isRootLocked, populateRootfs } from "./lib/rootfs-image";
import { hasDefaultRootPassword, rootPasswordProblem } from "./lib/default-credentials";
import { hostnameProblem, suggestHostname } from "./lib/hostname";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline/promises";
import * as bcrypt from "bcryptjs";
import type { SysConfig } from "../src/common/Config";
import { createDefaultSysConfig, formatSysConfigIni, parseSysConfigIni } from "../src/common/SysConfigIni";

/**
 * INSTALL AGENT (Fresh Install TSIX)
 *
 * DUA MODE, dideteksi otomatis dari ada/tidaknya `src/mirror/`:
 *
 *   DEVELOPMENT (ada `src/mirror/`) — checkout repo atau distro hasil
 *   `npm run distro:twrapper`:
 *     1. Tanya konfigurasi (hostname, user, broker MQTT, nama file database, root).
 *     2. Tulis src/sysconfig.conf.
 *     3. Buat file database .db yang BENAR-BENAR BARU (file lama di-backup).
 *     4. Sinkronkan src/mirror (rootfs) + src/common ke database baru.
 *     5. (Opsional) akun user biasa + home; password root.
 *
 *   PRODUKSI (TIDAK ada `src/mirror/`) — distro hasil
 *   `npm run distro:twrapper -- --no-mirror`: rootfs SUDAH ada di `system.db`
 *   (dibuat saat build), jadi:
 *     - TIDAK ada prompt nama database dan TIDAK ada sinkronisasi rootfs;
 *     - database yang ada (`kernel.database` di sysconfig.conf) dibuka apa adanya;
 *     - konfigurasi node, akun user, dan password root tetap ditanyakan.
 *
 * Cara pakai (dari root project):
 *   npm run tsix:install                     -> interaktif dari checkout repo
 *   npm run tsix:install                -> interaktif dari paket distro
 *   npm run tsix:install -- --defaults  -> non-interaktif (root tetap terkunci jika baru)
 *   npm run tsix:install -- --no-config -> lewati penulisan src/sysconfig.conf
 */

interface InstallOptions {
  dbPath: string;
  force: boolean;
  interactive: boolean;
  writeConfig: boolean;
}

const MIRROR_ROOT = path.resolve(__dirname, "../src/mirror");
const COMMON_ROOT = path.resolve(__dirname, "../src/common");
const CONFIG_PATH = path.resolve(__dirname, "../src/sysconfig.conf");

/** Konfigurasi lama (JSON) — dimigrasi otomatis sekali, lalu tidak dipakai lagi. */
const LEGACY_CONFIG_PATH = path.resolve(__dirname, "../src/sysconfig.json");
const PROJECT_ROOT = path.resolve(__dirname, "..");

/**
 * Mode produksi = tidak ada `src/mirror/`. Di sana semua baca/tulis rootfs
 * sudah diarahkan ke VFS (`system.db`), yang dibuat oleh builder distro.
 */
const PRODUCTION_MODE = !fs.existsSync(MIRROR_ROOT);

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
      console.log(`Usage: npm run tsix:install -- [options]

  --path <db>    Database path (default: from sysconfig.conf)
  --force        Overwrite an existing database (backed up automatically; development mode only)
  --defaults     Non-interactive: use all default values
  --no-config    Skip writing src/sysconfig.conf

Mode is detected automatically:
  development  src/mirror/ exists      -> a new database is created from it
  production   src/mirror/ is absent   -> the existing database (built by
                                          'distro:twrapper --no-mirror') is used`);
      process.exit(0);
    }
  }
  return opts;
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
 * Konfigurasi default — dipakai kalau sysconfig.conf belum ada (mis. sebelum
 * instalasi pertama). install.ts TIDAK boleh bergantung pada berkas itu; ia
 * yang membuatnya.
 *
 * Nilainya diambil dari `createDefaultSysConfig()` (src/common/SysConfigIni.ts)
 * supaya default installer dan default kernel tidak pernah berbeda; installer
 * hanya menimpa VERSI kernel (dibaca langsung dari `Kernel.ts`) dan broker dari
 * pertanyaan interaktif.
 */
function createDefaultConfig(): SysConfig {
  const cfg = createDefaultSysConfig();
  cfg.kernel.version = getKernelVersion();
  return cfg;
}

function loadConfig(): SysConfig {
  // Konfigurasi AKTIF: format key-value (`sysconfig.conf`).
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const { config, warnings } = parseSysConfigIni(fs.readFileSync(CONFIG_PATH, "utf8"));
      for (const message of warnings) console.log(`[INSTALL] src/sysconfig.conf: ${message}`);
      return config;
    } catch (e: any) {
      console.log(
        `[INSTALL] src/sysconfig.conf tidak valid (${e.message}) — memakai konfigurasi default.`,
      );
      return createDefaultConfig();
    }
  }

  // MIGRASI sekali-jalan dari format lama (JSON) — sama seperti kernel
  // (`Config.load()`), supaya node lama tidak kehilangan konfigurasinya.
  if (fs.existsSync(LEGACY_CONFIG_PATH)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_CONFIG_PATH, "utf8")) as SysConfig;
      console.log("[INSTALL] src/sysconfig.json lama ditemukan — dimigrasi ke sysconfig.conf.");
      return legacy;
    } catch (e: any) {
      console.log(
        `[INSTALL] src/sysconfig.json tidak valid (${e.message}) — memakai konfigurasi default.`,
      );
      return createDefaultConfig();
    }
  }

  console.log("[INSTALL] src/sysconfig.conf belum ada — memakai konfigurasi default.");
  return createDefaultConfig();
}

/**
 * saveConfig(): Tulis konfigurasi sebagai key-value (gaya `/etc/fstab.conf`).
 * Berkas `.json` lama (kalau ada) SENGAJA dibiarkan: ia berhenti dipakai, tapi
 * tetap milik admin sampai dihapus sendiri.
 */
function saveConfig(cfg: SysConfig): void {
  // Pastikan folder src/ ada (bisa saja belum ada sebelum instalasi pertama)
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const header =
    "src/sysconfig.conf — konfigurasi node TSIX (key-value, gaya /etc/fstab.conf).\n" +
    "Aturan nilai: \"teks\" = string, a, b = array, true/false = boolean, 0o755 = oktal.\n" +
    "Pemilih backend root: kernel.rootType = bkfs | host (lihat wiki/Virtual-File-System.md).";
  fs.writeFileSync(CONFIG_PATH, formatSysConfigIni(cfg, header), "utf8");
  // Password broker tersimpan di file ini → hanya pemilik yang boleh membaca
  // (SEC-21b). Di Windows chmod tidak berpengaruh; tetap dicoba.
  if (cfg.network.interfaces.some((i) => i.password)) {
    try {
      fs.chmodSync(CONFIG_PATH, 0o600);
    } catch (_) {
      /* abaikan: FS host tidak mendukung mode Unix */
    }
  }
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

/**
 * PROMPT PASSWORD DENGAN MASKING (input tidak ditampilkan, diganti '*') —
 * ala prompt password di Ubuntu/Unix.
 *
 * readline/promises tidak punya mode silent, jadi: detach listener readline
 * sementara (agar readline tidak ikut meng-echo plaintext), baca stdin dalam
 * raw-mode (echo terminal mati), tampilkan '*' per karakter, lalu pulihkan
 * state readline semula. Handle: Enter/Ctrl+D submit, Backspace hapus,
 * Ctrl+C batal (exit 130), escape sequence (panah) diabaikan.
 * Non-TTY (pipe/redirect): fallback ke prompt biasa tanpa masking.
 */
async function promptPassword(
  rl: readline.Interface,
  question: string,
): Promise<string> {
  const stdin = process.stdin as any;
  const stdout = process.stdout;
  const isTTY = !!stdin.isTTY && typeof stdin.setRawMode === "function";

  if (!isTTY) {
    return prompt(rl, question); // tidak bisa masking di non-TTY
  }

  // Detach listener readline sementara agar tidak meng-echo plaintext.
  const dataListeners = stdin.listeners("data");
  const keyListeners = stdin.listeners("keypress");
  stdin.removeAllListeners("data");
  stdin.removeAllListeners("keypress");

  const prevRaw = stdin.isRaw;
  stdin.setEncoding("utf8");
  try {
    stdin.setRawMode(true);
  } catch (_) {
    // Gagal masuk raw-mode — pulihkan & fallback ke prompt biasa.
    for (const l of dataListeners) stdin.on("data", l);
    for (const l of keyListeners) stdin.on("keypress", l);
    return prompt(rl, question);
  }
  stdin.resume();
  stdout.write(`${question} `);

  return new Promise<string>((resolve) => {
    let pw = "";
    let skipEscape = 0; // sisa karakter escape (mis. panah) yang diabaikan

    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(prevRaw);
      stdin.pause();
      for (const l of dataListeners) stdin.on("data", l);
      for (const l of keyListeners) stdin.on("keypress", l);
      stdin.resume();
    };

    const finish = (value: string, exitCode?: number) => {
      cleanup();
      stdout.write("\n");
      if (exitCode !== undefined) process.exit(exitCode);
      resolve(value);
    };

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (skipEscape > 0) {
          skipEscape--;
          continue;
        }
        if (ch === "\u001b") {
          skipEscape = 2; // sequence ESC [ x
          continue;
        }
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          finish(pw); // Enter / Ctrl+D
          return;
        }
        if (ch === "\u0003") {
          finish("", 130); // Ctrl+C → batal
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          if (pw.length > 0) {
            pw = pw.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        pw += ch;
        stdout.write("*");
      }
    };

    stdin.on("data", onData);
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const defaultDbRel = opts.dbPath || cfg.kernel.database || "system.db";

  console.log(
    PRODUCTION_MODE
      ? "[INSTALL] Production mode: src/mirror/ is absent — using the prebuilt system database."
      : "[INSTALL] Development mode: src/mirror/ found — a new system database will be created from it.",
  );

  // Mode produksi: database WAJIB sudah ada (dibuat oleh builder distro).
  // Dibuka di depan supaya status akun root diketahui sebelum bertanya.
  let prebuilt: BKFS | null = null;
  if (PRODUCTION_MODE) {
    const existing = path.resolve(PROJECT_ROOT, defaultDbRel);
    if (!fs.existsSync(existing)) {
      console.error(`[INSTALL] Production image database not found: ${existing}`);
      console.error(
        "          Rebuild the distro with 'npm run distro:twrapper -- --no-mirror', or restore src/mirror/.",
      );
      process.exit(1);
    }
    if (opts.force) {
      console.log("[INSTALL] --force is ignored in production mode (the prebuilt database is never replaced).");
    }
    prebuilt = new BKFS(existing);
  }

  const rootPasswordRequired = PRODUCTION_MODE
    ? isRootLocked(prebuilt!)
    : !fs.existsSync(path.join(MIRROR_ROOT, "etc", "shadow"));
  // Root masih memakai password bawaan publik (`root`, checkout repo) → wajib
  // diganti di installer interaktif (SEC-20).
  const sourceShadow = PRODUCTION_MODE
    ? prebuilt!.read("/etc/shadow") || ""
    : fs.existsSync(path.join(MIRROR_ROOT, "etc", "shadow"))
      ? fs.readFileSync(path.join(MIRROR_ROOT, "etc", "shadow"), "utf8")
      : "";
  const rootIsDefault = hasDefaultRootPassword(sourceShadow);
  const mustSetRoot = rootPasswordRequired || rootIsDefault;

  let dbRel = defaultDbRel;
  let rootPassword = "";
  let newUser = ""; // akun user biasa (opsional, ala installer Ubuntu)
  let newPass = "";

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    // ============ 1. KONFIGURASI INTERAKTIF ============
    if (opts.interactive) {
      console.log("\n== TSIX Fresh Install — Konfigurasi ==");

      // Hostname = alamat MQTNL. Nama umum (`tsix`, dst.) mudah bentrok di
      // broker bersama → ditolak, dengan saran nama acak (SEC-21b).
      while (true) {
        const current = cfg.shell.defaultHostname;
        const suggestion = hostnameProblem(current) ? suggestHostname() : current;
        const answer = (await prompt(rl, "Hostname (unique on your MQTT broker)", suggestion)).trim();
        const problem = hostnameProblem(answer);
        if (problem) {
          console.log(`[INSTALL] ${problem}`);
          continue;
        }
        cfg.shell.defaultHostname = answer;
        break;
      }

      // Akun user biasa (root sudah pasti dibuat otomatis dari image).
      // Alur ala installer Ubuntu: username → password → konfirmasi password.
      // Kosongkan username untuk melewati (cukup akun root saja).
      while (true) {
        newUser = (await prompt(rl, "Username (empty to skip)", "")).trim();
        if (!newUser) break; // skip — hanya root
        if (!/^[a-z_][a-z0-9_-]*$/.test(newUser)) {
          console.log(
            "[INSTALL] Username tidak valid — pakai huruf kecil, angka, '_' atau '-'.",
          );
          continue;
        }
        newPass = await promptPassword(rl, `Password for '${newUser}'`);
        const confirm = await promptPassword(rl, "Confirm password");
        if (!newPass) {
          console.log("[INSTALL] Password tidak boleh kosong.");
          continue;
        }
        if (newPass !== confirm) {
          console.log("[INSTALL] Password tidak cocok — ulangi.");
          continue;
        }
        break;
      }

      const broker = await prompt(
        rl,
        "Broker MQTT (mqtt://host:port)",
        cfg.network.interfaces[0]?.broker,
      );
      if (broker) {
        cfg.network.interfaces.forEach((i) => (i.broker = broker));
      }

      // Kredensial broker (opsional, SEC-21b).
      console.log(
        "[INSTALL] A public broker without a login is a shared, untrusted network: anyone can read and send packets.",
      );
      const brokerUser = (
        await prompt(rl, "Broker username (empty = none)", cfg.network.interfaces[0]?.username || "")
      ).trim();
      if (brokerUser) {
        const brokerPass = await promptPassword(rl, `Broker password for '${brokerUser}'`);
        cfg.network.interfaces.forEach((i) => {
          i.username = brokerUser;
          i.password = brokerPass || undefined;
        });
      } else {
        cfg.network.interfaces.forEach((i) => {
          delete i.username;
          delete i.password;
        });
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

      // Hanya mode development: di produksi database sudah ada (hasil build).
      if (!PRODUCTION_MODE) {
        dbRel = await prompt(rl, "New database filename (e.g. system.db)", dbRel);
      }

      // Root password: KOSONG = pertahankan yang ada di image (tidak diubah).
      // Kalau diisi, WAJIB konfirmasi — sama seperti akun user biasa. Root tidak
      // bisa di-reset dari luar tanpa mengubah /etc/shadow manual, jadi salah
      // ketik di sini berarti kehilangan akses admin ke image baru.
      while (true) {
        rootPassword = await promptPassword(
          rl,
          rootPasswordRequired
            ? "Root password (required for a fresh distro image)"
            : rootIsDefault
              ? "Root password (required: the bundled default 'root' must be changed)"
              : "Root password (empty to keep the current one)",
        );
        if (!rootPassword) {
          if (mustSetRoot) {
            console.log(
              rootPasswordRequired
                ? "[INSTALL] Password root wajib diatur untuk akun awal yang terkunci."
                : "[INSTALL] Password root bawaan ('root') diketahui publik dan wajib diganti.",
            );
            continue;
          }
          break;
        }
        const problem = rootPasswordProblem(rootPassword);
        if (problem) {
          console.log(`[INSTALL] ${problem}`);
          continue;
        }

        const confirmRoot = await promptPassword(rl, "Confirm root password");
        if (rootPassword !== confirmRoot) {
          console.log("[INSTALL] Password tidak cocok — ulangi.");
          continue;
        }
        break;
      }
    }

    // Address interface otomatis mengikuti hostname (di semua mode):
    //   interface[0] = <hostname>, interface[1..n] = <hostname>_2, _3, ...
    // Terlalu teknis untuk ditanyakan ke user — cukup derive dari hostname.
    // Mode non-interaktif: jangan pakai nama umum yang mudah bentrok (SEC-21b).
    if (hostnameProblem(cfg.shell.defaultHostname)) {
      const generated = suggestHostname();
      console.log(
        `[INSTALL] Hostname '${cfg.shell.defaultHostname}' is not unique enough for a shared broker → using '${generated}'.`,
      );
      cfg.shell.defaultHostname = generated;
    }
    const host = cfg.shell.defaultHostname;
    cfg.network.interfaces.forEach((iface, i) => {
      iface.address = i === 0 ? host : `${host}_${i + 1}`;
    });

    const dbPath = path.resolve(PROJECT_ROOT, dbRel);

    // ============ 2. TULIS SYS CONFIG ============
    if (opts.writeConfig) {
      cfg.kernel.database = path.relative(PROJECT_ROOT, dbPath).replace(/\\/g, "/");
      saveConfig(cfg);
    }

    let bkfs: BKFS;
    if (PRODUCTION_MODE) {
      // ============ 3+4. IMAGE SIAP PAKAI (mode produksi) ============
      bkfs = prebuilt!;
      console.log(`[INSTALL] Using prebuilt database: ${dbPath}`);
      // Hanya melengkapi berkas akun yang hilang — tidak menimpa apa pun.
      ensureFreshAccountFiles(bkfs);
    } else {
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
      bkfs = new BKFS(dbPath);
      console.log(`[INSTALL] Database baru dibuat: ${dbPath}`);

      // ============ 4. SYNC ROOTFS ============
      // Implementasi bersama dengan builder distro (`--no-mirror`) supaya image
      // hasil build dan hasil install identik — lihat scripts/lib/rootfs-image.ts.
      const { rootPasswordSeeded } = populateRootfs(bkfs, MIRROR_ROOT, COMMON_ROOT, "INSTALL");
      if (rootPasswordSeeded !== rootPasswordRequired) {
        throw new Error("Installer root-account bootstrap did not match the source shadow file.");
      }
    }

    if (rootPasswordRequired && !opts.interactive) {
      console.warn(
        "[INSTALL] Akun root awal tetap terkunci; jalankan installer interaktif untuk menetapkan password.",
      );
    }
    if (rootIsDefault && !rootPassword) {
      console.warn(
        "[INSTALL] ⚠️  root masih memakai password bawaan 'root' (diketahui publik).\n" +
        "          Login root dari jarak jauh (tssh) DITOLAK sampai password diganti dengan `passwd` di konsol.",
      );
    }

    // ============ 4.5 AKUN USER BARU (OPSIONAL) ============
    // Root dibuat otomatis dari image. Bagian ini menambah akun user
    // biasa + home directory-nya, sama seperti useradd (UID >= 1000, gid users).
    if (newUser) {
      createUserAccount(bkfs, newUser, newPass);
    }

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
        `[INSTALL] Group tersedia: ${groups ? groups.split("\n").map((l) => l.split(":")[0]).join(", ") : "(tidak ada)"
        }`,
      );
      console.log(
        `[INSTALL] /etc/shadow: ${shadow ? shadow.split("\n").length : 0} entri (mode aman)`,
      );
    } catch (_) {
      /* abaikan error verifikasi */
    }

    // Tutup koneksi DB biar file ter-flush rapi.
    //
    // `close()` (bukan akses langsung ke `db`) sengaja dipakai: dia menjalankan
    // checkpoint WAL dulu, sehingga `system.db` kembali utuh sebagai SATU file —
    // penting karena image ini yang disalin ke node lain / di-backup.
    bkfs.close();

    console.log("\n[INSTALL] Selesai! Image sistem siap.");
    console.log(`           Mode     : ${PRODUCTION_MODE ? "production (no src/mirror)" : "development (src/mirror)"}`);
    console.log(`           DB       : ${dbPath}`);
    console.log(
      `           Hostname : ${cfg.shell.defaultHostname}  (lihat src/sysconfig.conf)`,
    );
    console.log("           Jalankan dengan: npm start");
  } finally {
    rl.close();
  }
}

main();
