/**
 * configure.ts — TeleChat Server: setup pasca-instalasi (jalankan sebagai ROOT).
 *
 * Tugas:
 *   1. Pastikan direktori konfigurasi /etc/telechatd ada.
 *   2. Tulis config.json default (bila belum ada).
 *   3. Pastikan direktori log /etc/telechatd/logs ada.
 *   4. Jadikan world-writable (0o777) agar data mudah diakses.
 *   5. Periksa identitas RSA (/etc/keys/rsa) — server butuh untuk handshake E2E.
 *
 * Alasan (keputusan arsitektur, 2026-08-16):
 *   - install.ts / vfs-bootstrap.ts / sync-vfs.ts harus tetap GENERIK (sync
 *     mirror→VFS polos) tanpa pengecualian per-aplikasi.
 *   - Setup spesifik aplikasi dipindah ke sini: dijalankan manual sebagai root,
 *     nanti di-integrasikan sebagai post-install hook paket tpkg.
 *   - Client dan server adalah PAKET TERPISAH, masing-masing punya configure.ts:
 *       /opt/telechat/configure.js          → /etc/telechat (data client)
 *       /opt/telechatd/configure.js         → /etc/telechatd (data server)
 *
 * Cara pakai (root):
 *   /opt/telechatd/configure.js
 *
 * (c) 2026 TSIX Project
 */

import { Program, std, fs } from "@tsix/Application";

const CONFIG_DIR = "/etc/telechatd";
const LOG_DIR = "/etc/telechatd/logs";
const CONFIG_PATH = "/etc/telechatd/config.json";
const RSA_DIR = "/etc/keys/rsa";

const DEFAULT_CONFIG = {
  port: 2510,
  defaultRole: "guest",
  adminClientIds: [],
  onlineMaxAge: 60,
  staleMs: 300000,
  presenceInterval: 5000,
  cleanupInterval: 30000,
  logMessageContent: true,
};

export const main = Program(async () => {
  await std.log(
    "[telechatd] configure: memeriksa direktori konfigurasi…",
    "telechatd",
  );

  // 1. Pastikan direktori konfigurasi ada
  let exists = false;
  try {
    exists = !!(await fs.stat(CONFIG_DIR));
  } catch (_) {
    /* belum ada */
  }
  if (!exists) {
    try {
      await fs.mkdir(CONFIG_DIR);
      await std.log(`[telechatd] configure: dibuat ${CONFIG_DIR}`, "telechatd");
    } catch (e: any) {
      await std.print(`❌ Gagal membuat ${CONFIG_DIR}: ${e?.message || e}\n`);
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

  // 3. Pastikan direktori log ada
  try {
    await fs.mkdir(LOG_DIR);
    await std.print(`✅ Direktori log ${LOG_DIR} siap.\n`);
  } catch (_) {
    /* sudah ada */
  }

  // 4. World-writable (0o777) — biar mudah diakses non-root.
  try {
    await fs.chmod(CONFIG_DIR, 0o777);
    await fs.chmod(LOG_DIR, 0o777);
    await std.print(`✅ ${CONFIG_DIR} → 0o777 (world-writable).\n`);
  } catch (e: any) {
    await std.print(`❌ Gagal chmod: ${e?.message || e}\n`);
    await std.print(
      `   Pastikan dijalankan sebagai ROOT (contoh: sudo /opt/telechatd/configure.js)\n`,
    );
  }

  // 5. Periksa identitas RSA — server butuh untuk handshake E2E.
  let rsaOk = false;
  try {
    const pub = await fs.readFile(`${RSA_DIR}/id_rsa.pub`);
    const prv = await fs.readFile(`${RSA_DIR}/id_rsa`);
    rsaOk = !!(pub && prv);
  } catch (_) {
    /* belum ada */
  }
  if (rsaOk) {
    await std.print(`✅ Identitas RSA ditemukan di ${RSA_DIR}.\n`);
  } else {
    await std.print(
      `⚠️  Identitas RSA TIDAK ditemukan di ${RSA_DIR}.\n` +
        `   Jalankan 'init' dulu — server telechatd tidak bisa start tanpa ini.\n`,
    );
  }

  await std.print(`✅ TeleChat Server terkonfigurasi.\n`);
  await std.log("[telechatd] configure selesai.", "telechatd");
});
