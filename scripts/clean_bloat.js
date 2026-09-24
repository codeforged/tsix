const fs = require('fs');
const path = require('path');

// Path DB default dari src/sysconfig.conf (kernel.database) — sama seperti
// scripts/lib/db-path.ts, versi plain JS agar bisa jalan tanpa esbuild-register.
// Berkasnya kini key-value (gaya /etc/fstab.conf), jadi cukup cari key `database`
// di dalam `[kernel]` tanpa memuat parser TS.
function getDefaultDbPath() {
    const confPath = path.resolve(__dirname, '../src/sysconfig.conf');
    try {
        const lines = fs.readFileSync(confPath, 'utf8').split(/\r?\n/);
        let inKernel = false;
        for (const raw of lines) {
            const line = raw.trim();
            if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
            const section = /^\[(.+?)\]$/.exec(line);
            if (section) {
                inKernel = section[1].trim() === 'kernel';
                continue;
            }
            if (!inKernel) continue;
            const eq = line.indexOf('=');
            if (eq === -1 || line.slice(0, eq).trim() !== 'database') continue;
            let value = line.slice(eq + 1).trim();
            const hash = value.search(/\s[#;]/); // komentar ekor (di luar kutip)
            if (hash !== -1) value = value.slice(0, hash).trim();
            if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
            if (value) return value;
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
