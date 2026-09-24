import { BKFS } from "../src/vfs/BKFS";
import * as fs from "fs";
import * as path from "path";
import * as esbuild from "esbuild";
import { getDefaultDbPath } from "./lib/db-path";
import { applyBinaryMode, needsBinaryMode } from "./lib/binary-mode";
import { readTextFile, utf8ToVfsBytes, vfsBytesToUtf8 } from "./lib/text-file";
import { skipIfHostRoot } from "./lib/root-mode";

/**
 * Mode executable (bit `x`, `/sbin` 0o744, SetUID login/passwd/sudo) diatur oleh
 * helper BERSAMA `scripts/lib/binary-mode.ts` — lihat berkas itu untuk alasannya.
 */


/**
 * VFS SYNC AGENT (External)
 *
 * Menyuntikkan SATU berkas dari host (`src/mirror/…`, `src/common/…`) langsung ke
 * database VFS (path dari sysconfig.conf) + sidecar `.js` hasil transpile
 * dan bit eksekusinya. Cocok dipasang di VS Code 'run on save' extension.
 * Untuk borongan pakai `npm run vfs:bootstrap`.
 *
 * Cara pakai: npx ts-node scripts/sync-vfs.ts src/mirror/bin/hello.ts
 *
 * ⚠️ NO-OP saat `kernel.rootType = "host"` — lihat `activeHostRoot()` di bawah.
 */

/**
 * activeHostRoot() + pesan no-op kini dipusatkan di `scripts/lib/root-mode.ts`
 * (dipakai bersama `vfs-bootstrap` dan `vfs-pull`) supaya ketiganya tidak bisa
 * berbeda pendapat soal mode root yang sedang aktif.
 */

async function main() {
  // Mode root-host: tidak ada yang perlu disinkronkan (lihat scripts/lib/root-mode.ts).
  skipIfHostRoot(
    "VFS-Sync",
    "Files in that folder ARE the root, so edits are visible to the kernel immediately.",
  );

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
    // `src/common/**` hidup di VFS sebagai **`/lib/common/**`** — itu yang dicari
    // WorkerEntry (`@common/X` → `/lib/common/X.ts`) dan yang di-seed
    // `vfs-bootstrap.ts`. Dulu di sini memetakan ke `/common/...`, path yang tidak
    // pernah dibaca siapa pun (`VfsModuleResolver`: "/common/** tidak ada di VFS"),
    // jadi suntingan `src/common` lewat sync-vfs hilang tanpa jejak.
    vfsPath = ("/lib/common/" + path.relative(commonPath, fullHostPath)).replace(
      /\\/g,
      "/",
    );
  }

  if (!vfsPath) {
    console.error("Error: File must be inside src/mirror/ or src/common/");
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
      // `readTextFile()` membuang BOM UTF-8: `U+FEFF` menjadi byte `0xFF` di VFS
      // (latin1) dan berkas skrip yang diawali 0xFF ditolak browser.
      const content = readTextFile(fullHostPath);

      // Pastikan parent directory ada
      const parts = vfsPath.split("/").filter((p) => p.length > 0);
      parts.pop(); // buang nama file
      let currentPath = "";
      for (const part of parts) {
        currentPath += "/" + part;
        if (!bkfs.exists(currentPath)) {
          // Sync generik: semua direktori 0o755. Setup permission khusus aplikasi
          // (mis. /etc/air-type → 0o777) dilakukan oleh configure.ts aplikasi tsb.
          bkfs.mkdir(currentPath, 0, 0, 0o755);
        }
      }

      bkfs.touch(vfsPath, content);

      // --- AUTO-TRANSPILATION (v2.2) ---
      // Only transpile .ts files, ignore .json, .md, .txt, etc.
      if (vfsPath.endsWith(".ts")) {
        try {
          console.log(`[VFS-Sync] Auto-compiling ${vfsPath} -> .js ...`);
          // `content` = BYTE berkas; esbuild butuh TEKS (lihat `VfsText.ts`).
          const result = esbuild.transformSync(vfsBytesToUtf8(content), {
            loader: "ts",
            format: "cjs",
            target: "esnext",
          });

          if (result.code) {
            const jsPath = vfsPath.substring(0, vfsPath.length - 3) + ".js";
            // Hasil esbuild = TEKS → ubah ke byte sebelum masuk VFS, kalau tidak
            // karakter non-ASCII terpotong (bug tombol jendela kacau).
            bkfs.touch(jsPath, utf8ToVfsBytes(result.code));

            // Auto-executable untuk file di direktori eksekusi
            if (needsBinaryMode(jsPath)) {
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
        needsBinaryMode(vfsPath) &&
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
