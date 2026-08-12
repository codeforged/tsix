import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { getDefaultDbPath } from "./lib/db-path";

const DB_PATH = path.resolve(__dirname, "..", getDefaultDbPath());

function main() {
    const db = new Database(DB_PATH);

    const upsert = (name: string, parentId: number, type: string, content: string) => {
        const existing = db.prepare('SELECT id FROM vnodes WHERE name = ? AND parent_id = ?').get(name, parentId) as { id: number } | undefined;
        if (existing) {
            db.prepare('UPDATE vnodes SET content = ? WHERE id = ?').run(content, existing.id);
            console.log(`✅ Updated ${name} (ID: ${existing.id})`);
        } else {
            const info = db.prepare('INSERT INTO vnodes (name, parent_id, type, content) VALUES (?, ?, ?, ?)').run(name, parentId, type, content);
            console.log(`+ Inserted ${name} (New ID: ${info.lastInsertRowid})`);
        }
    };

    // Find /bin and /etc
    const root = db.prepare("SELECT id FROM vnodes WHERE name = '/' AND parent_id IS NULL").get() as { id: number };
    const bin = db.prepare("SELECT id FROM vnodes WHERE name = 'bin' AND parent_id = ?").get(root.id) as { id: number };
    const etc = db.prepare("SELECT id FROM vnodes WHERE name = 'etc' AND parent_id = ?").get(root.id) as { id: number };

    const binFiles = [
        { name: 'tde-server.ts', path: '../src/__root/bin/tde-server.ts' },
        { name: 'hello-gui.ts', path: '../src/__root/bin/hello-gui.ts' }
    ];

    const etcFiles = [
        { name: 'rc.local.ts', path: '../src/__root/etc/rc.local.ts' }
    ];

    for (const f of binFiles) {
        const fullPath = path.resolve(__dirname, f.path);
        const content = fs.readFileSync(fullPath, "utf8");
        upsert(f.name, bin.id, 'FILE', content);
    }

    for (const f of etcFiles) {
        const fullPath = path.resolve(__dirname, f.path);
        const content = fs.readFileSync(fullPath, "utf8");
        upsert(f.name, etc.id, 'FILE', content);
    }

    db.close();
}

main();
