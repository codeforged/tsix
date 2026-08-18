import { BKFS } from "../src/vfs/BKFS";
import * as fs from "fs";
import * as path from "path";
import * as esbuild from "esbuild";
import { getDefaultDbPath } from "./lib/db-path";

/**
 * Direktori executable standar (FHS) — semua file .ts/.js di sini diberi bit
 * execute saat sync agar bisa dijalankan dari PATH.
 */
const EXEC_DIRS = ["/bin", "/sbin", "/usr/bin", "/usr/local/bin", "/opt"];

/**
 * Binary istimewa yang wajib berjalan sebagai pemilik file (SetUID root):
 * login, passwd, dan sudo — semuanya butuh akses baca/tulis /etc/shadow (0640 root).
 * Dikenali baik versi .ts maupun sidecar .js yang benar-benar dieksekusi runtime.
 */
function isSetuidBinary(vfsPath: string): boolean {
  return /\/bin\/(login|passwd|sudo)\.(ts|js)$/.test(vfsPath);
}

function isExecutableBinary(vfsPath: string): boolean {
  return EXEC_DIRS.some((d) => vfsPath.startsWith(d + "/"));
}

/** Terapkan mode eksekusi (dan SetUID untuk login/passwd/sudo). */
function applyBinaryMode(
  bkfs: BKFS,
  vfsPath: string,
  label = "BOOTSTRAP",
): void {
  if (isSetuidBinary(vfsPath)) {
    bkfs.chmod(vfsPath, 0o4755);
    bkfs.chown(vfsPath, 0, 0);
    console.log(`[${label}] SetUID+chown root -> ${vfsPath}`);
  } else if (isExecutableBinary(vfsPath)) {
    // /sbin = root-only (0o744), lainnya 0o755 (semua user)
    bkfs.chmod(vfsPath, vfsPath.startsWith("/sbin/") ? 0o744 : 0o755);
  }
}

/**
 * HOST-SIDE WORKER ENTRY — sinkronkan sidecar WorkerEntry.js dengan .ts-nya.
 *
 * WorkerEntry.ts (bootloader + sandbox) adalah SATU-SATUNYA file yang WAJIB
 * dikompilasi di HOST, bukan di VFS: Scheduler memuatnya via
 * `new Worker(workerEntryPath)` dengan path ke `src/userland/WorkerEntry.js`.
 * Semua file lain (.ts di src/mirror) ditranspilasi on-the-fly ke VFS oleh
 * syncDir() di atas, sehingga sidecar .js yang di-commit rawan menjadi basi.
 *
 * Helper ini memastikan .js selalu sinkron dengan .ts-nya saat bootstrap:
 *   - .js belum ada  -> transpile
 *   - .js lebih TUA dari .ts -> transpile (stale)
 *   - .js lebih baru/sama -> skip (hindari diff git yang tidak perlu)
 *
 * Pengaturan esbuild identik dengan transpile kernel (DME) & syncDir():
 * format CJS + inline sourcemap (--enable-source-maps di worker).
 */
function syncWorkerEntry(): void {
  const tsPath = path.resolve(process.cwd(), "src/userland/WorkerEntry.ts");
  if (!fs.existsSync(tsPath)) return; // tidak ada source — skip

  const jsPath = tsPath.replace(/\.ts$/, ".js");

  // Skip kalau .js masih segar (>= mtime .ts) — hindari regenerasi tak perlu
  if (fs.existsSync(jsPath)) {
    const tsMtime = fs.statSync(tsPath).mtimeMs;
    const jsMtime = fs.statSync(jsPath).mtimeMs;
    if (jsMtime >= tsMtime) {
      console.log("[VFS-Bootstrap] WorkerEntry.js up-to-date (skip transpile)");
      return;
    }
  }

  const content = fs.readFileSync(tsPath, "utf8");
  try {
    const result = esbuild.transformSync(content, {
      loader: "ts",
      format: "cjs",
      target: "node18",
      sourcemap: "inline",
      sourcefile: "WorkerEntry.ts",
    });
    fs.writeFileSync(jsPath, result.code);
    console.log(`[VFS-Bootstrap] Compiled (host): ${jsPath}`);
  } catch (e: any) {
    // Non-fatal — boot tetap jalan; .js lama (jika ada) yang terpakai
    console.error(
      `[VFS-Bootstrap]   -> \x1b[1;33mWarning: Compilation failed for ${tsPath}: ${e.message}\x1b[0m`,
    );
  }
}

/**
 * VFS BOOTSTRAP AGENT
 *
 * Digunakan untuk melakukan sinkronisasi massal (Bulk Sync) dari host (src/mirror)
 * ke database VFS. Sangat berguna untuk instalasi awal pada perangkat baru.
 *
 * Path default diambil dari src/sysconfig.json (kernel.database).
 * Cara pakai:
 *   npm run vfs:bootstrap                  -> sync ke DB default (dari sysconfig)
 *   npm run vfs:bootstrap -- data/test.db  -> sync ke path lain (argumen dbPath)
 */

async function main() {
  console.log(
    "\x1b[1;34m[VFS-Bootstrap] Starting bulk synchronization...\x1b[0m",
  );
  // dbPath bisa dilewati via argumen CLI (positional). Kosong → ambil dari
  // sysconfig.json (kernel.database), sinkron dengan path hasil instalasi.
  const dbPath = process.argv[2]?.trim() || getDefaultDbPath();
  const srcRoot = path.resolve(process.cwd(), "src/mirror");

  if (!fs.existsSync(srcRoot)) {
    console.error(
      `\x1b[1;31m[Error] Source directory not found: ${srcRoot}\x1b[0m`,
    );
    process.exit(1);
  }

  try {
    const bkfs = new BKFS(dbPath);

    // Recursive sync function
    const syncDir = (hostDir: string, vfsDir: string) => {
      if (!bkfs.exists(vfsDir)) {
        // Sync generik: semua direktori 0o755. Setup permission khusus
        // aplikasi (mis. /etc/air-type → 0o777) oleh configure.ts app tsb.
        bkfs.mkdir(vfsDir, 0, 0, 0o755);
        console.log(`[VFS-Bootstrap] Created directory: ${vfsDir}`);
      }

      const items = fs.readdirSync(hostDir);
      for (const item of items) {
        const fullHostPath = path.join(hostDir, item);
        const fullVfsPath = path.join(vfsDir, item).replace(/\\/g, "/");
        const stats = fs.statSync(fullHostPath);

        if (stats.isDirectory()) {
          syncDir(fullHostPath, fullVfsPath);
        } else {
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

          // Binary assets (audio/gambar raster) disimpan sebagai
          // latin1 string (1 byte = 1 char) — cocok dengan
          // Buffer.from(raw,"latin1") di sisi app. Teks pakai utf8.
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
          console.log(`[VFS-Bootstrap] Synced: ${fullVfsPath}`);

          // Auto-transpilation for .ts files (Framework optimization)
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

                // Auto-executable untuk file di direktori eksekusi
                if (isSetuidBinary(jsPath) || isExecutableBinary(jsPath)) {
                  applyBinaryMode(bkfs, jsPath, "VFS-Bootstrap");
                }
                console.log(`[VFS-Bootstrap]   -> Compiled: ${jsPath}`);
              }
            } catch (e: any) {
              console.error(
                `[VFS-Bootstrap]   -> \x1b[1;33mWarning: Compilation failed for ${fullVfsPath}: ${e.message}\x1b[0m`,
              );
            }
          }

          // Auto-executable untuk file di direktori eksekusi
          if (
            (isSetuidBinary(fullVfsPath) || isExecutableBinary(fullVfsPath)) &&
            (fullVfsPath.endsWith(".ts") || fullVfsPath.endsWith(".js"))
          ) {
            applyBinaryMode(bkfs, fullVfsPath, "VFS-Bootstrap");
          }
        }
      }
    };

    syncDir(srcRoot, "/");

    const commonHostRoot = path.resolve(process.cwd(), "src/common");
    if (fs.existsSync(commonHostRoot)) {
      syncDir(commonHostRoot, "/lib/common");
    }

    // Host-side: pastikan WorkerEntry.js sinkron dengan WorkerEntry.ts
    // (Scheduler memuatnya dari HOST, bukan VFS — lihat helper di atas).
    syncWorkerEntry();

    console.log(
      "\x1b[1;32m[VFS-Bootstrap] Bulk synchronization completed successfully!\x1b[0m",
    );
  } catch (err: any) {
    console.error(
      `\x1b[1;31m[VFS-Bootstrap] Critical Error: ${err.message}\x1b[0m`,
    );
    process.exit(1);
  }
}

main();
