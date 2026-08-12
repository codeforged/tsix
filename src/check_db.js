const db = require('better-sqlite3')('d:/mycode/tsix/src/system.db');

try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    console.log("Tables:", tables);

    const row = db.prepare("SELECT name, length(content) as size FROM vnodes ORDER BY size DESC LIMIT 5").all();
    console.log("Top 5 largest files:", row);

    const usage = db.prepare(`
            SELECT 
                SUM(CASE WHEN type = 'FILE' THEN length(content) ELSE 0 END) as total_size,
                SUM(CASE WHEN type = 'FILE' THEN 1 ELSE 0 END) as file_count
            FROM vnodes
            WHERE name != '/'
        `).get();
    console.log("Usage Stats:", usage);

} catch (e) {
    console.error(e);
}
