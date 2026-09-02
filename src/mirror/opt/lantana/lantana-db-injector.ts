/**
 * lantana-db-injector.ts — Lantana Consumer: Database Injector
 *
 * Berlangganan data sensor dari distributor (LANTANA_SENSOR_DATA) dan
 * menulisnya ke database eksternal (MySQL) via DbLib. Transport DB memakai
 * daemon mysqld (DB service) yang harus berjalan.
 *
 * Usage:
 *   lantana-db-injector <lantanaPid|uuid> [tenant] [--db host user pass db]
 *   lantana-db-injector <lantanaPid|uuid> --db 192.168.1.50 root pass antigonon_iot
 *
 * (c) 2026 TSIX Project — Lantana
 */

import { Program, std, shell, db } from "@tsix/Application";
import { LANTANA_UUID } from "@tsix/lantana/lantana-core";

const TAG = "lantana-db-injector";

export const main = Program(async (args: string[]) => {
    const target = args[0] || LANTANA_UUID;
    const tenantFilter = args[1] && !args[1].startsWith("--") ? args[1] : undefined;

    // Parse --db host user pass db
    let dbCfg: { host: string; user: string; password: string; database: string } | null = null;
    const idx = args.indexOf("--db");
    if (idx >= 0 && args.length >= idx + 4) {
        dbCfg = {
            host: args[idx + 1],
            user: args[idx + 2],
            password: args[idx + 3],
            database: args[idx + 4],
        };
    }

    await std.println(`[${TAG}] Menghubungkan ke DB...`, TAG);
    if (dbCfg) {
        const ok = await db.connect(dbCfg);
        if (!ok) {
            await std.println(`[${TAG}] Gagal konek DB (pastikan mysqld jalan & kredensial benar)`, TAG);
            return;
        }
        await std.println(`[${TAG}] Terhubung ke ${dbCfg.host}/${dbCfg.database}`, TAG);
    } else {
        await std.println(`[${TAG}] Mode kering (tanpa --db) — data hanya dicetak, tidak di-INSERT.`, TAG);
    }

    // Register sebagai consumer di distributor
    await shell.send(target, {
        type: "LANTANA_REGISTER",
        name: "db-injector",
        tenant: tenantFilter,
        fromPid: shell.getPid(),
    }).catch(() => { });

    // Request snapshot (data terkini)
    await shell.send(target, { type: "LANTANA_SNAPSHOT", fromPid: shell.getPid() }).catch(() => { });

    // Terima data
    (global as any)._tsixLib.onEvent("ipc_message", async (msg: any) => {
        const payload = msg?.data || msg;
        if (!payload || typeof payload !== "object") return;

        if (payload.type === "LANTANA_SENSOR_DATA") {
            const data = payload.data;
            if (tenantFilter && data.tenant !== tenantFilter) return;
            await handleSensorData(data, dbCfg);
        } else if (payload.type === "LANTANA_SNAPSHOT_REPLY") {
            const snap = payload.data;
            for (const dev of snap.devices || []) {
                for (const s of (snap.sensorData || []).find((d: any) => d.nodeId === dev.nodeId)?.sensors || []) {
                    const data = {
                        tenant: dev.tenant,
                        nodeId: dev.nodeId,
                        nodeCategory: dev.category,
                        sensors: [s],
                        receivedAt: snap.ts,
                    };
                    await handleSensorData(data, dbCfg);
                }
            }
        }
    });

    await std.println(`[${TAG}] Siap. Tenant filter: ${tenantFilter || "*"}.`, TAG);

    // Stay alive
    while (true) {
        await new Promise((r) => setTimeout(r, 5000));
    }
});

async function handleSensorData(data: any, dbCfg: any): Promise<void> {
    try {
        const nodeId = data.nodeId || "unknown";
        const tenant = data.tenant || "default";
        const ts = new Date(data.receivedAt || Date.now()).toISOString().slice(0, 19).replace("T", " ");

        for (const s of data.sensors || []) {
            const line = `[${ts}] tenant=${tenant} node=${nodeId} sensor=${s.id}(${s.category}) value=${s.value}${s.unit ? " " + s.unit : ""}`;
            if (!dbCfg) {
                await std.print(line + "\n");
                continue;
            }
            const sql = `INSERT INTO sensor_data (tenant, node_id, sensor_id, sensor_category, value, timestamp) VALUES ('${tenant}', '${nodeId}', '${s.id}', '${s.category}', ${s.value}, '${ts}')`;
            const res = await db.query(sql);
          	// std.println(sql);
            if (res && res.error) {
                await std.println(`[${TAG}] DB error: ${res.error}`, TAG);
            }
        }
    } catch (e: any) {
        await std.println(`[${TAG}] Gagal proses data: ${e?.message}`, TAG);
    }
}
