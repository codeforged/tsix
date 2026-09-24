import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { getDefaultDbPath } from "./lib/db-path";
import { applyHostBinaryMode } from "./lib/binary-mode";
import { skipIfHostRoot } from "./lib/root-mode";
import { Config } from "../src/common/Config";
import { resolveHostRootDir } from "../src/kernel/RootFilesystem";
import { readVnodeContent } from "../src/vfs/BKFS";

/**
 * VFS-PULL.TS
 *
 * Script ini digunakan untuk menarik data dari BKFS (SQLite) balik ke host (src/mirror).
 * Berguna untuk menyimpan perubahan permanen yang dilakukan di dalam simulator.
 *
 * Mode `kernel.rootType = "host"` → TIDAK RELEVAN (no-op, lihat
 * `scripts/lib/root-mode.ts`): folder host sudah jadi root-nya sendiri.
 */

const DB_PATH = path.resolve(__dirname, "..", getDefaultDbPath());

/**
 * HOST_ROOT: Root host yang dipakai kernel.
 *
 * Resolusinya DIPINJAM dari kernel (`resolveHostRootDir`, lihat
 * `src/kernel/RootFilesystem.ts`) supaya patokannya sama dengan `GET_SYSPATH`:
 * env `TSIX_ROOTFS_PATH` menang, lalu `kernel.rootHostPath` relatif `src/kernel`.
 *
 * Dulu berkas ini punya resolver sendiri (dan hardcode `../src/root` sebelum itu)
 * — nilai yang berbeda dari kernel berarti tarikan mendarat di folder yang tidak
 * dibaca siapa pun.
 */
const HOST_ROOT = resolveHostRootDir(readConfigOrNull());

/** Config `src/sysconfig.conf`, atau `null` kalau belum ada (mode bkfs default). */
function readConfigOrNull(): any | null {
    return Config.tryGet();
}

// Daftar folder yang tidak perlu ditarik (Runtime/Temporary)
const EXCLUDE_DIRS = ["dev", "tmp", "proc", "logs", "var"];

async function main() {
    // Mode root-host: folder host sudah jadi root, tidak ada yang perlu ditarik.
    skipIfHostRoot(
        "VFS-Pull",
        "Nothing to pull: that host folder IS the root already (changes made inside TSIX are written there directly).",
    );

    console.log("🚀 Starting VFS to Host Synchronization...");
    console.log(`📂 Database: ${DB_PATH}`);
    console.log(`🏠 Host Root: ${HOST_ROOT}`);

    if (!fs.existsSync(DB_PATH)) {
        console.error(`❌ Database not found: ${DB_PATH}`);
        process.exit(1);
    }

    const db = new Database(DB_PATH);

    const pull = (vfsPath: string) => {
        const rows = db.prepare("SELECT v1.id, v1.name, v1.type, v1.content, v2.name as parent_name FROM vnodes v1 LEFT JOIN vnodes v2 ON v1.parent_id = v2.id WHERE v2.name = ? OR (v2.name IS NULL AND v1.name = '/')").all(vfsPath === "/" ? null : vfsPath.split("/").pop());
        // Wait, the parent search by name is risky because names are not unique.
        // Let's use ID based recursion.
    };

    // Helper rekursif berdasarkan ID
    const syncNode = (parentId: number | null, currentVfsPath: string) => {
        // Kolom `content` SENGAJA tidak diambil: untuk file besar isinya ada di tabel
        // `blocks`, dan mengambil `content` saja akan menulis file KOSONG ke host.
        // `readVnodeContent()` yang menggabungkan keduanya.
        const query = parentId === null
            ? "SELECT id, name, type FROM vnodes WHERE parent_id IS NULL"
            : "SELECT id, name, type FROM vnodes WHERE parent_id = ?";

        const nodes = db.prepare(query).all(parentId === null ? [] : [parentId]) as any[];

        for (const node of nodes) {
            const vfsName = node.name;
            if (vfsName === "/" && parentId === null) {
                syncNode(node.id, "/");
                continue;
            }

            const cleanPath = path.join(currentVfsPath, vfsName).replace(/\\/g, "/");

            // Cek exclusion
            const topDir = cleanPath.split("/")[1];
            if (EXCLUDE_DIRS.includes(topDir)) continue;

            if (node.type === "DIRECTORY") {
                syncNode(node.id, cleanPath);
            } else {
                saveToHost(cleanPath, readVnodeContent(db, node.id));
            }
        }
    };

    const saveToHost = (vfsPath: string, content: string | null) => {
        let hostPath = "";

        if (vfsPath.startsWith("/etc/")) {
            hostPath = path.join(HOST_ROOT, "etc", vfsPath.replace("/etc/", ""));
        } else if (vfsPath.startsWith("/root/")) {
            hostPath = path.join(HOST_ROOT, "home/root", vfsPath.replace("/root/", ""));
        } else {
            hostPath = path.join(HOST_ROOT, vfsPath);
        }

        const dir = path.dirname(hostPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Tulis sebagai byte latin1 (1 char = 1 byte), BUKAN utf8.
        //
        // `writeFileSync(path, string)` memakai utf8: setiap karakter ≥ 0x80 jadi
        // DUA byte, sehingga aset biner (gambar/audio .b64) rusak saat ditarik ke
        // host. `install.ts`/`vfs-bootstrap.ts` membacanya dengan latin1, jadi ini
        // juga yang membuat tarikan dan bootstrap konsisten (round-trip byte-per-byte).
        fs.writeFileSync(hostPath, Buffer.from(content ?? "", "latin1"));

        // BIT EKSEKUSI WAJIB DIPASANG ULANG.
        //
        // `writeFileSync` selalu menghasilkan 0644 (tanpa bit `x`), sedangkan
        // bootstrap/install memasang 0o755/0o744/0o4755 di VFS. Shell menegakkan
        // bit `x` seperti Linux (`tsh.ts`: `(mode & 0o111) === 0` → `Permission
        // denied`, `$?` = 126), jadi folder host hasil pull TIDAK BISA menjalankan
        // perintah apa pun — termasuk sebagai root. Dulu ini membuat mode
        // `rootType = "host"` mati total (`-tsh: /bin/ls.js: Permission denied`).
        applyHostBinaryMode(hostPath, vfsPath);

        console.log(`✅ Synced: ${vfsPath} -> ${path.relative(process.cwd(), hostPath)}`);
    };

    try {
        syncNode(null, "");
        console.log("\n✨ Synchronization Complete! All files are now on the host.");
    } catch (e: any) {
        console.error(`\n❌ Error during sync: ${e.message}`);
    } finally {
        db.close();
    }
}

main();
