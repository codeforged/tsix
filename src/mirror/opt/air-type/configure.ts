/**
 * configure.ts — Air-Type (client): setup pasca-instalasi (jalankan sebagai ROOT).
 *
 * Tugas:
 *   1. Pastikan direktori data /etc/air-type ada.
 *   2. Jadikan world-writable (0o777) agar aplikasi air-type yang dijalankan
 *      NON-ROOT bisa menulis history.json & known_hosts.
 *
 * Alasan (keputusan arsitektur, 2026-08-16):
 *   - install.ts / vfs-bootstrap.ts / sync-vfs.ts harus tetap GENERIK (sync
 *     mirror→VFS polos) tanpa pengecualian per-aplikasi.
 *   - Setup spesifik aplikasi dipindah ke sini: dijalankan manual sebagai root,
 *     dan nanti di-integrasikan sebagai post-install hook paket tpkg.
 *   - Client dan server adalah PAKET TERPISAH, masing-masing punya configure.ts:
 *       /opt/air-type/configure.js          → /etc/air-type (data client)
 *       /opt/air-type-server/configure.js   → /etc/air-type-server (config server)
 *
 * Cara pakai (root):
 *   /opt/air-type/configure.js
 *
 * (c) 2026 TSIX Project
 */

import { Program, std, fs } from "@tsix/Application";

const DATA_DIR = "/etc/air-type";

export const main = Program(async () => {
  await std.log("[air-type] configure: memeriksa direktori data…", "air-type");

  // 1. Pastikan direktori data ada
  let exists = false;
  try {
    exists = !!(await fs.stat(DATA_DIR));
  } catch (_) {
    /* belum ada */
  }

  if (!exists) {
    try {
      await fs.mkdir(DATA_DIR);
      await std.log(`[air-type] configure: dibuat ${DATA_DIR}`, "air-type");
    } catch (e: any) {
      await std.print(`❌ Gagal membuat ${DATA_DIR}: ${e?.message || e}\n`);
      return;
    }
  }

  // 2. World-writable (0o777) — biar air-type non-root bisa tulis
  //    history.json & known_hosts.
  try {
    await fs.chmod(DATA_DIR, 0o777);
    await std.log(
      `[air-type] configure: ${DATA_DIR} → 0o777 (world-writable)`,
      "air-type",
    );
    await std.print(
      `✅ Air-Type terkonfigurasi: ${DATA_DIR} world-writable (0o777).\n`,
    );
  } catch (e: any) {
    await std.print(`❌ Gagal chmod ${DATA_DIR}: ${e?.message || e}\n`);
    await std.print(
      `   Pastikan dijalankan sebagai ROOT (contoh: sudo /opt/air-type/configure.js)\n`,
    );
  }
});
