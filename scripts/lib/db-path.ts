import { Config } from "../../src/common/Config";

/**
 * Ambil path database default dari konfigurasi node (`kernel.database`).
 *
 * Membaca lewat `Config` (→ `src/sysconfig.conf`, format key-value) supaya:
 *   - alat CLI memakai aturan parsing yang SAMA dengan kernel, dan
 *   - migrasi otomatis dari `sysconfig.json` lama ikut berlaku di sini.
 *
 * Konfigurasi belum ada → fallback `system.db`: skrip diagnostik tidak boleh
 * gagal hanya karena node belum di-install.
 */
export function getDefaultDbPath(): string {
  const database = Config.tryGet()?.kernel?.database;
  return typeof database === "string" && database.length > 0 ? database : "system.db";
}
