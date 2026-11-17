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
            if (payload.data?.accountId !== accountId) return;
            await writeBatch(payload.data.readings || [], dbCfg);
        } else if (payload.type === EVT_SNAPSHOT_REPLY) {
            for (const entry of payload.data?.devices || []) {
                if (entry.device?.accountId !== accountId) continue;
                await writeBatch(entry.readings || [], dbCfg);
            }
        }
    });

    await std.println(`[${TAG}] Siap untuk akun ${accountId}.`);

    while (true) {
        await new Promise((r) => setTimeout(r, 5000));
    }
});

async function writeBatch(readings: any[], dbCfg: DbConfig | null): Promise<void> {
    for (const r of readings) {
        const ts = new Date(r.receivedAt || r.ts || Date.now())
            .toISOString()
            .slice(0, 19)
            .replace("T", " ");

        if (!dbCfg) {
            await std.print(
                `[${ts}] account=${r.accountId} device=${r.deviceId} scheme=${r.schemeId}(${r.label})=${r.value}${r.unit ? " " + r.unit : ""}\n`,
            );
            continue;
        }

        if (typeof r.readingId !== "string") continue;

        const sql =
            `INSERT INTO sensor_readings ` +
            `(reading_id, account_id, device_id, scheme_id, label, unit, value, received_at) VALUES (` +
            `${quote(r.readingId)}, ${quote(r.accountId)}, ${quote(r.deviceId)}, ${Number(r.schemeId)}, ` +
            `${quote(r.label)}, ${quote(r.unit || "")}, ${quote(String(r.value))}, ${quote(ts)}) ` +
            `ON DUPLICATE KEY UPDATE reading_id = reading_id`;

        const res = await db.query(sql);
        if (res && (res as any).error) {
            await std.println(`[${TAG}] DB error: ${(res as any).error}`);
        }
    }
}

function quote(value: string): string {
    return `'${String(value).replace(/'/g, "''")}'`;
}
