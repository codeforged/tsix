import * as fs from "fs";
import * as path from "path";

/**
 * Ambil path database default dari src/sysconfig.json (kernel.database).
 *
 * Dipakai oleh script-script yang butuh DB path agar nilainya selalu sinkron
 * dengan konfigurasi sistem — termasuk path yang diinput user saat instalasi
 * (install.ts menulis kernel.database ke sysconfig.json).
 */
export function getDefaultDbPath(): string {
  const configPath = path.resolve(__dirname, "../../src/sysconfig.json");
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const cfg = JSON.parse(raw);
    if (cfg && typeof cfg.kernel === "object" && cfg.kernel.database) {
      return String(cfg.kernel.database);
    }
  } catch (_) {
    /* abaikan — pakai fallback */
  }
  return "system.db";
}
