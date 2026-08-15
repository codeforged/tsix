/**
 * configure.ts — Air-Type Server: setup pasca-instalasi (jalankan sebagai ROOT).
 *
 * Tugas:
 *   1. Pastikan direktori konfigurasi /etc/air-type-server ada.
 *   2. Jadikan world-writable (0o777) agar config.json mudah diedit.
 *   3. Periksa identitas RSA (/etc/keys/rsa) — server butuh untuk handshake E2E.
 *
 * Alasan (keputusan arsitektur, 2026-08-16):
 *   - install.ts / vfs-bootstrap.ts / sync-vfs.ts harus tetap GENERIK (sync
 *     mirror→VFS polos) tanpa pengecualian per-aplikasi.
 *   - Server dan client chat adalah PAKET APLIKASI TERPISAH, masing-masing
 *     punya configure.ts sendiri:
 *       /opt/air-type/configure.js          → data client (/etc/air-type)
 *       /opt/air-type-server/configure.js   → config server (/etc/air-type-server)
 *   - Dijalankan manual sebagai root, nanti di-integrasikan sebagai post-install
 *     hook paket tpkg.
 *
 * Cara pakai (root):
 *   /opt/air-type-server/configure.js
 *
 * (c) 2026 TSIX Project
 */

import { Program, std, fs } from "@tsix/Application";

const CONFIG_DIR = "/etc/air-type-server";
const RSA_DIR = "/etc/keys/rsa";

export const main = Program(async () => {
  await std.log("[air-type-server] configure: memeriksa direktori konfigurasi…", "air-type-server");

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
      await std.log(`[air-type-server] configure: dibuat ${CONFIG_DIR}`, "air-type-server");
    } catch (e: any) {
      await std.print(`❌ Gagal membuat ${CONFIG_DIR}: ${e?.message || e}\n`);
    }
  }

  // 2. World-writable (0o777) — biar config.json gampang diedit non-root.
  try {
    await fs.chmod(CONFIG_DIR, 0o777);
    await std.log(
      `[air-type-server] configure: ${CONFIG_DIR} → 0o777 (world-writable)`,
      "air-type-server",
    );
    await std.print(
      `✅ Air-Type Server terkonfigurasi: ${CONFIG_DIR} world-writable (0o777).\n`,
    );
  } catch (e: any) {
    await std.print(`❌ Gagal chmod ${CONFIG_DIR}: ${e?.message || e}\n`);
    await std.print(
      `   Pastikan dijalankan sebagai ROOT (contoh: sudo /opt/air-type-server/configure.js)\n`,
    );
  }

  // 3. Periksa identitas RSA — server butuh untuk handshake E2E.
  let rsaOk = false;
  try {
    const pub = await fs.readFile(`${RSA_DIR}/id_rsa.pub`);
    const prv = await fs.readFile(`${RSA_DIR}/id_rsa`);
    rsaOk = !!(pub && prv);
  } catch (_) {
    /* belum ada */
  }

  if (rsaOk) {
    await std.log("[air-type-server] configure: identitas RSA tersedia.", "air-type-server");
    await std.print(`✅ Identitas RSA ditemukan di ${RSA_DIR}.\n`);
  } else {
    await std.print(`⚠️  Identitas RSA belum ada di ${RSA_DIR}.\n`);
    await std.print(
      `   Server butuh RSA untuk handshake E2E — jalankan 'init' atau tunggu\n`,
    );
    await std.print(
      `   regenerasi otomatis saat boot, lalu start ulang air-type-server.\n`,
    );
  }
});
