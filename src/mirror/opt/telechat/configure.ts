/**
 * configure.ts — TeleChat (client): setup pasca-instalasi (jalankan sebagai ROOT).
 *
 * Tugas:
 *   1. Pastikan direktori data /etc/telechat ada.
 *   2. Tulis config.json default (bila belum ada).
 *   3. Jadikan world-writable (0o777) agar aplikasi telechat yang dijalankan
 *      NON-ROOT bisa menulis history.json & known_hosts.
 *
 * Alasan (keputusan arsitektur, 2026-08-16):
 *   - install.ts / vfs-bootstrap.ts / sync-vfs.ts harus tetap GENERIK (sync
 *     mirror→VFS polos) tanpa pengecualian per-aplikasi.
 *   - Setup spesifik aplikasi dipindah ke sini: dijalankan manual sebagai root,
 *     nanti di-integrasikan sebagai post-install hook paket tpkg.
 *   - Client dan server adalah PAKET TERPISAH, masing-masing punya configure.ts:
 *       /opt/telechat/configure.js          → /etc/telechat (data client)
 *       /opt/telechatd/configure.js         → /etc/telechatd (config server)
 *
 * Cara pakai (root):
 *   /opt/telechat/configure.js
 *
 * (c) 2026 TSIX Project
 */

import { Program, std, fs } from "@tsix/Application";

const DATA_DIR = "/etc/telechat";
const CONFIG_PATH = "/etc/telechat/config.json";

const DEFAULT_CONFIG = {
  server: "",
  port: 2510,
  nickname: "",
  clientId: "",
  heartbeatInterval: 15,
  active_status: 1,
  phone_number: "",
  email: "",
};

export const main = Program(async () => {
  await std.log("[telechat] configure: memeriksa direktori data…", "telechat");

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
      await std.log(`[telechat] configure: dibuat ${DATA_DIR}`, "telechat");
    } catch (e: any) {
      await std.print(`❌ Gagal membuat ${DATA_DIR}: ${e?.message || e}\n`);
    }
  }

  // 2. Tulis config.json default (bila belum ada)
  try {
    const raw = await fs.readFile(CONFIG_PATH);
    if (!raw) {
      await fs.writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
      await std.print(`✅ Config default ditulis ke ${CONFIG_PATH}.\n`);
    } else {
      await std.print(`ℹ️  ${CONFIG_PATH} sudah ada — dibiarkan.\n`);
    }
  } catch (_) {
    /* non-fatal */
  }

  // 3. World-writable (0o777) — biar telechat non-root bisa tulis
  //    history.json & known_hosts.
  try {
    await fs.chmod(DATA_DIR, 0o777);
    await std.print(`✅ ${DATA_DIR} → 0o777 (world-writable).\n`);
  } catch (e: any) {
    await std.print(`❌ Gagal chmod ${DATA_DIR}: ${e?.message || e}\n`);
    await std.print(
      `   Pastikan dijalankan sebagai ROOT (contoh: sudo /opt/telechat/configure.js)\n`,
    );
  }

  await std.print(`✅ TeleChat terkonfigurasi.\n`);
  await std.log("[telechat] configure selesai.", "telechat");
});
