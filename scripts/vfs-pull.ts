import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { getDefaultDbPath } from "./lib/db-path";

/**
 * VFS-PULL.TS
 * 
 * Script ini digunakan untuk menarik data dari BKFS (SQLite) balik ke host (src/root).
 * Berguna untuk menyimpan perubahan permanen yang dilakukan di dalam simulator.
 */

const DB_PATH = path.resolve(__dirname, "..", getDefaultDbPath());
const HOST_ROOT = path.resolve(__dirname, "../src/root");

// Daftar folder yang tidak perlu ditarik (Runtime/Temporary)
const EXCLUDE_DIRS = ["dev", "tmp", "proc", "logs", "var"];

async function main() {
    console.log("🚀 Starting VFS to Host Synchronization...");
    console.log(`📂 Database: ${DB_PATH}`);
    console.log(`🏠 Host Root: ${HOST_ROOT}`);

    if (!fs.existsSync(DB_PATH)) {
        console.error(`❌ Database tidak ditemukan: ${DB_PATH}`);
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
        const query = parentId === null
            ? "SELECT * FROM vnodes WHERE parent_id IS NULL"
            : "SELECT * FROM vnodes WHERE parent_id = ?";

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
                saveToHost(cleanPath, node.content);
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

        fs.writeFileSync(hostPath, content || "");
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
