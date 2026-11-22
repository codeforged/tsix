/**
 * lantana-db-injector.ts — Consumer: tulis bacaan ke database eksternal.
 *
 * Berlangganan event `LANTANA_READING` untuk satu akun, lalu menulis setiap
 * bacaan tervalidasi ke tabel `sensor_readings`. INSERT idempoten memakai
 * PRIMARY KEY `reading_id` supaya pengiriman ulang tidak menggandakan data.
 *
 * Usage:
 *   lantana-db-injector <accountId> [target] --db <host> <user> <pass> <database>
 *   lantana-db-injector <accountId> [target]          (mode kering: cetak saja)
 *
 * (c) 2026 TSIX Project — Lantana
 */

import { Program, std, shell, db } from "@tsix/Application";
import { LANTANA_UUID, EVT_READING, EVT_SNAPSHOT_REPLY, resolveDaemonTarget } from "@tsix/lantana/lantana-core";
import type { SensorReading } from "@tsix/lantana/lantana-core";
import { INSERT_SENSOR_READING_SQL, sensorReadingRows } from "@tsix/lantana/db-injector-rows";

const TAG = "lantana-db-injector";

interface DbConfig {
    host: string;
    user: string;
    password: string;
    database: string;
}

export const main = Program(async (args: string[]) => {
    const accountId = args[0];
    if (!accountId || accountId.startsWith("--")) {
        await std.print("Usage: lantana-db-injector <accountId> [target] --db <host> <user> <pass> <db>\n");
        return;
    }

    const flagsStart = args.findIndex((a) => a.startsWith("--"));
    const positional = flagsStart >= 0 ? args.slice(0, flagsStart) : args;
    const target = resolveDaemonTarget(positional[1] || LANTANA_UUID);

    let dbCfg: DbConfig | null = null;
    const idx = args.indexOf("--db");
    if (idx >= 0 && args.length >= idx + 5) {
        dbCfg = {
            host: args[idx + 1],
            user: args[idx + 2],
            password: args[idx + 3],
            database: args[idx + 4],
        };
    }

    if (dbCfg) {
        const ok = await db.connect(dbCfg);
        if (!ok) {
            await std.println(`[${TAG}] Gagal konek DB ${dbCfg.host}/${dbCfg.database}`);
            return;
        }
        await std.println(`[${TAG}] Terhubung ke ${dbCfg.host}/${dbCfg.database}`);
    } else {
        await std.println(`[${TAG}] Mode kering — bacaan hanya dicetak.`);
    }

    const lib = (global as any)._tsixLib;
    const pid = shell.getPid();

    await shell.send(target, {
        type: "LANTANA_REGISTER",
        name: "db-injector",
        accountId,
        fromPid: pid,
    }).catch(() => false);
    await shell.send(target, { type: "LANTANA_SNAPSHOT", accountId, fromPid: pid }).catch(() => false);

    lib.onEvent("ipc_message", async (msg: any) => {
        const payload = msg?.data || msg;
        if (!payload || typeof payload !== "object") return;

        if (payload.type === EVT_READING) {
            const batch = payload.data;
            if (batch?.accountId !== accountId) return;
            await writeBatch(accountId, batch.deviceId, batch.readings || [], dbCfg);
        } else if (payload.type === EVT_SNAPSHOT_REPLY) {
            // Snapshot berisi bacaan terakhir dengan readingId aslinya, jadi
            // menulisnya lagi setelah restart tidak menggandakan baris.
            for (const entry of payload.data?.devices || []) {
                if (entry.device?.accountId !== accountId) continue;
                await writeBatch(accountId, entry.device.deviceId, entry.readings || [], dbCfg);
            }
        }
    });

    await std.println(`[${TAG}] Siap untuk akun ${accountId}.`);

    while (true) {
        await new Promise((r) => setTimeout(r, 5000));
    }
});

let warnedMissingId = false;

async function writeBatch(
    accountId: string,
    deviceId: unknown,
    readings: SensorReading[],
    dbCfg: DbConfig | null,
): Promise<void> {
    if (typeof deviceId !== "string" || !deviceId) return;
    const { rows, skipped } = sensorReadingRows(accountId, deviceId, readings);

    if (skipped > 0 && !warnedMissingId) {
        warnedMissingId = true;
        await std.println(
            `[${TAG}] ${skipped} bacaan tanpa readingId dilewati — perbarui daemon Lantana.`,
        );
    }

    for (const row of rows) {
        const [, , , schemeId, label, unit, value, receivedAt] = row;
        if (!dbCfg) {
            await std.print(
                `[${receivedAt}] account=${accountId} device=${deviceId} scheme=${schemeId}(${label})=${value}${unit ? " " + unit : ""}\n`,
            );
            continue;
        }

        const res = await db.query(INSERT_SENSOR_READING_SQL, row);
        if (res && (res as any).error) {
            await std.println(`[${TAG}] DB error: ${(res as any).error}`);
        }
    }
}
