/**
 * lantana-file-logger.ts — Consumer: tulis history bacaan ke VFS.
 *
 * Satu direktori per akun: /var/log/lantana/<accountId>/<deviceId>/YYYY-MM-DD.log
 *
 * Usage:
 *   lantana-file-logger <accountId> [target]
 *
 * (c) 2026 TSIX Project — Lantana
 */

import { Program, std, shell, fs } from "@tsix/Application";
import {
    EVT_READING,
    EVT_SNAPSHOT_REPLY,
    LANTANA_LOG_DIR,
    LANTANA_UUID,
    resolveDaemonTarget,
} from "@tsix/lantana/lantana-core";

const TAG = "lantana-file-logger";

export const main = Program(async (args: string[]) => {
    const accountId = args[0];
    if (!accountId || accountId.startsWith("--")) {
        await std.print("Usage: lantana-file-logger <accountId> [target]\n");
        return;
    }
    const target = resolveDaemonTarget(args[1] || LANTANA_UUID);

    try {
        await fs.mkdir(LANTANA_LOG_DIR);
    } catch {
        /* sudah ada */
    }

    const lib = (global as any)._tsixLib;
    const pid = shell.getPid();

    await shell.send(target, {
        type: "LANTANA_REGISTER",
        name: "file-logger",
        accountId,
        fromPid: pid,
    }).catch(() => false);
    await shell.send(target, { type: "LANTANA_SNAPSHOT", accountId, fromPid: pid }).catch(() => false);

    lib.onEvent("ipc_message", async (msg: any) => {
        const payload = msg?.data || msg;
        if (!payload || typeof payload !== "object") return;

        if (payload.type === EVT_READING) {
            const data = payload.data;
            if (data?.accountId !== accountId) return;
            await appendLog(data.accountId, data.deviceId, data.readings || []);
        } else if (payload.type === EVT_SNAPSHOT_REPLY) {
            for (const entry of payload.data?.devices || []) {
                if (entry.device?.accountId !== accountId) continue;
                await appendLog(entry.device.accountId, entry.device.deviceId, entry.readings || []);
            }
        }
    });

    await std.log(`[${TAG}] Siap. Log: ${LANTANA_LOG_DIR}/${accountId}/`, TAG);

    while (true) {
        await new Promise((r) => setTimeout(r, 5000));
    }
});

async function appendLog(accountId: string, deviceId: string, readings: any[]): Promise<void> {
    if (readings.length === 0) return;

    try {
        const date = new Date(readings[0].receivedAt || readings[0].ts || Date.now());
        const dateStr = date.toISOString().slice(0, 10);
        const timeStr = date.toISOString().slice(11, 19);
        const dir = `${LANTANA_LOG_DIR}/${accountId}/${deviceId}`;
        const file = `${dir}/${dateStr}.log`;

        try {
            await fs.mkdir(dir);
        } catch {
            /* sudah ada */
        }

        let line = `[${timeStr}] device=${deviceId}`;
        for (const r of readings) {
            line += ` | ${r.schemeId}(${r.label})=${r.value}${r.unit ? " " + r.unit : ""}`;
        }
        line += "\n";

        const fd = await fs.open(file, "a");
        if (fd >= 0) {
            await fs.write(fd, line);
            await fs.close(fd);
        }
    } catch (e: any) {
        await std.log(`[${TAG}] Gagal tulis log: ${e?.message}`, TAG);
    }
}
