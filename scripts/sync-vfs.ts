import { BKFS } from "../src/vfs/BKFS";
import * as fs from "fs";
import * as path from "path";
import * as esbuild from "esbuild";
import { getDefaultDbPath } from "./lib/db-path";

/**
 * Direktori executable standar (FHS) — semua file .ts/.js di sini diberi bit
 * execute saat sync agar bisa dijalankan dari PATH.
 */
const EXEC_DIRS = ["/bin", "/sbin", "/usr/bin", "/usr/local/bin"];

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
function applyBinaryMode(bkfs: BKFS, vfsPath: string, label = "SYNC"): void {
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
 * VFS SYNC AGENT (External)
 *
 * Digunakan untuk menyuntikkan file dari host (src/mirror) langsung ke database
 * VFS (path dari src/sysconfig.json).
 * Cocok dipasang di VS Code 'run on save' extension.
 *
 * Cara pakai: npx ts-node scripts/sync-vfs.ts src/mirror/bin/hello.ts
 */

async function main() {
  const rawPath = process.argv[2];
  if (!rawPath) {
    console.error(
      "Usage: npx ts-node scripts/sync-vfs.ts <relative_host_path>",
    );
    process.exit(1);
  }

  const fullHostPath = path.resolve(process.cwd(), rawPath);
  if (!fs.existsSync(fullHostPath)) {
    console.error(`Error: File not found -> ${fullHostPath}`);
    process.exit(1);
  }

  // Unified Path Resolution (v2.3)
  let vfsPath = "";
  const rootPath = path.resolve(process.cwd(), "src/mirror");
  const commonPath = path.resolve(process.cwd(), "src/common");

  if (fullHostPath.startsWith(rootPath)) {
    vfsPath = ("/" + path.relative(rootPath, fullHostPath)).replace(/\\/g, "/");
  } else if (fullHostPath.startsWith(commonPath)) {
    vfsPath = ("/common/" + path.relative(commonPath, fullHostPath)).replace(
      /\\/g,
      "/",
    );
  }

  if (!vfsPath) {
    console.error("Error: File must be inside src/root/ or src/common/");
    process.exit(1);
  }

  console.log(`[VFS-Sync] Host: ${rawPath} --> VFS: ${vfsPath}`);

  try {
    const bkfs = new BKFS(getDefaultDbPath());

    const stats = fs.statSync(fullHostPath);
    if (stats.isDirectory()) {
      bkfs.mkdir(vfsPath);
      console.log(`[VFS-Sync] Directory created/verified: ${vfsPath}`);
    } else {
      const content = fs.readFileSync(fullHostPath, "utf8");

      // Pastikan parent directory ada
      const parts = vfsPath.split("/").filter((p) => p.length > 0);
      parts.pop(); // buang nama file
      let currentPath = "";
      for (const part of parts) {
        currentPath += "/" + part;
        if (!bkfs.exists(currentPath)) {
          bkfs.mkdir(currentPath);
        }
      }

      bkfs.touch(vfsPath, content);

      // --- AUTO-TRANSPILATION (v2.2) ---
      // Only transpile .ts files, ignore .json, .md, .txt, etc.
      if (vfsPath.endsWith(".ts")) {
        try {
          console.log(`[VFS-Sync] Auto-compiling ${vfsPath} -> .js ...`);
          const result = esbuild.transformSync(content, {
            loader: "ts",
            format: "cjs",
            target: "esnext",
          });

          if (result.code) {
            const jsPath = vfsPath.substring(0, vfsPath.length - 3) + ".js";
            bkfs.touch(jsPath, result.code);

            // Auto-executable untuk file di direktori eksekusi
            if (isSetuidBinary(jsPath) || isExecutableBinary(jsPath)) {
              applyBinaryMode(bkfs, jsPath, "VFS-Sync");
            }
            console.log(`[VFS-Sync] Compiled sidecar created: ${jsPath}`);
          }
        } catch (compileErr: any) {
          console.error(
            `[VFS-Sync] Warning: Compilation failed for ${vfsPath}: ${compileErr.message}`,
          );
        }
      }

      // Auto-executable untuk file di direktori eksekusi
      if (
        (isSetuidBinary(vfsPath) || isExecutableBinary(vfsPath)) &&
        (vfsPath.endsWith(".ts") || vfsPath.endsWith(".js"))
      ) {
        applyBinaryMode(bkfs, vfsPath, "VFS-Sync");
      }

      console.log(
        `[VFS-Sync] File updated in BKFS: ${vfsPath} (${content.length} bytes)`,
      );
    }
  } catch (err: any) {
    console.error(`[VFS-Sync] Sync failed: ${err.message}`);
    process.exit(1);
  }
}

main();
