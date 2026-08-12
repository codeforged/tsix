const fs = require('fs');
const path = require('path');

// Path DB default dari src/sysconfig.json (kernel.database) — sama seperti
// scripts/lib/db-path.ts, versi plain JS agar bisa jalan tanpa esbuild-register.
function getDefaultDbPath() {
    const configPath = path.resolve(__dirname, '../src/sysconfig.json');
    try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (cfg && cfg.kernel && cfg.kernel.database) {
            return String(cfg.kernel.database);
        }
    } catch (_) {
        /* abaikan — pakai fallback */
    }
    return 'system.db';
}

const dbPath = path.resolve(__dirname, '..', getDefaultDbPath());
const db = require('better-sqlite3')(dbPath);

console.log(`Cleaning DB: ${dbPath}`);

try {
    console.log("Truncating syslog...");
    db.prepare("UPDATE vnodes SET content='' WHERE name='syslog'").run();

    console.log("Vacuuming...");
    db.exec("VACUUM");

    console.log("Done. System DB should be clean now.");
} catch (e) {
    console.error("Cleanup failed:", e);
}
