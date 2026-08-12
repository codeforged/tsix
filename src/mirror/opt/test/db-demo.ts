/**
 * db-demo.ts — DbLib Demo (database sub-library)
 *
 * Menunjukkan akses database dari aplikasi TSIX via DbLib.
 * Ring 4 tidak peduli medium transport (syscall → /dev/mysql).
 *
 * Jalankan:  db-demo
 *
 * (c) 2026 TSIX Project
 */

import { Program, std, db } from "@tsix/Application";

export const main = Program(async (args: string[]) => {
    await std.print("═══════════════════════════════════\n");
    await std.print("  DbLib Demo — antigonon_iot\n");
    await std.print("═══════════════════════════════════\n");

    // Konfigurasi koneksi
    const cfg = {
        host: "192.168.1.204",
        user: "tsix_admin",
        password: "thequickbrownfox",
        database: "antigonon_iot",
    };

    // 1️⃣ Connect
    await std.print("▶ Connect...\n");
    const ok = await db.connect(cfg);
    if (!ok) {
        await std.print("❌ Gagal connect ke database!\n");
        return;
    }
    await std.print("  ✓ Connected\n");

    // 2️⃣ Query — ambil 5 data sensor terbaru
    await std.print("▶ Query SELECT sensor_data (limit 5)...\n");
    const rows = await db.query(
        "SELECT id, node_id, sensor_id, value, timestamp FROM sensor_data ORDER BY id DESC LIMIT 5"
    );

    if (rows && rows.error) {
        await std.print(`❌ Query error: ${rows.error}\n`);
    } else if (Array.isArray(rows)) {
        await std.print(`  ✓ ${rows.length} baris:\n`);
        for (const r of rows) {
            await std.print("  " + JSON.stringify(r) + "\n");
        }
    } else {
        await std.print("  Result: " + JSON.stringify(rows) + "\n");
    }

    // 3️⃣ Disconnect
    await std.print("▶ Disconnect...\n");
    await db.disconnect();
    await std.print("  ✓ Disconnected\n");

    await std.print("\n[db-demo] Selesai ✅\n");
});
