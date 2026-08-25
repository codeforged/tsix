/**
 * lantana-file-logger.ts — Lantana Consumer: File Logger
 *
 * Berlangganan data sensor dari distributor dan menulis history ke file
 * di VFS, per tenant. Format file: /var/log/lantana/<tenant>/YYYY-MM-DD.log
 *
 * Usage:
 *   lantana-file-logger <lantanaPid|uuid> [tenant]
 *   lantana-file-logger <lantanaPid|uuid> --all
 *
 * (c) 2026 TSIX Project — Lantana
 */

import { Program, std, shell, fs } from "@tsix/Application";
import { LANTANA_UUID, LANTANA_LOG_DIR } from "@tsix/lantana/lantana-core";

const TAG = "lantana-file-logger";

export const main = Program(async (args: string[]) => {
    const target = args[0] || LANTANA_UUID;
    const tenantFilter = args[1] && !args[1].startsWith("--") ? args[1] : undefined;

    // Pastikan direktori log ada
    try { await fs.mkdir(LANTANA_LOG_DIR); } catch (_) { /* sudah ada */ }

    // Register sebagai consumer
    await shell.send(target, {
        type: "LANTANA_REGISTER",
        name: "file-logger",
        tenant: tenantFilter,
        fromPid: shell.getPid(),
    }).catch(() => { });

    await shell.send(target, { type: "LANTANA_SNAPSHOT", fromPid: shell.getPid() }).catch(() => { });

    await std.log(`[${TAG}] Siap. Log dir: ${LANTANA_LOG_DIR}, tenant: ${tenantFilter || "*"}.`, TAG);

    // Terima data
    (global as any)._tsixLib.onEvent("ipc_message", async (msg: any) => {
        const payload = msg?.data || msg;
        if (!payload || typeof payload !== "object") return;

        if (payload.type === "LANTANA_SENSOR_DATA") {
            const data = payload.data;
            if (tenantFilter && data.tenant !== tenantFilter) return;
            await appendLog(data);
        } else if (payload.type === "LANTANA_SNAPSHOT_REPLY") {
            const snap = payload.data;
            for (const dev of snap.devices || []) {
                const sensors = (snap.sensorData || []).find((d: any) => d.nodeId === dev.nodeId)?.sensors || [];
                if (sensors.length > 0) {
                    await appendLog({
                        tenant: dev.tenant,
                        nodeId: dev.nodeId,
                        nodeCategory: dev.category,
                        sensors,
                        receivedAt: snap.ts,
                    });
                }
            }
        }
    });

    // Stay alive
    while (true) {
        await new Promise((r) => setTimeout(r, 5000));
    }
});

async function appendLog(data: any): Promise<void> {
    try {
        const tenant = data.tenant || "default";
        const date = new Date(data.receivedAt || Date.now());
        const dateStr = date.toISOString().slice(0, 10);
        const timeStr = date.toISOString().slice(11, 19);
        const dir = `${LANTANA_LOG_DIR}/${tenant}`;
        const file = `${dir}/${dateStr}.log`;

        try { await fs.mkdir(dir); } catch (_) { /* sudah ada */ }

        let line = `[${timeStr}] node=${data.nodeId} status=${data.deviceStatus || "?"} age=${data.dataAgeMs || 0}ms`;
        for (const s of data.sensors || []) {
            line += ` | ${s.id}(${s.category})=${s.value}${s.unit ? " " + s.unit : ""}`;
        }
        line += "\n";

        // Append (buka dengan flag "a")
        const fd = await fs.open(file, "a");
        if (fd >= 0) {
            await fs.write(fd, line);
            await fs.close(fd);
        }
    } catch (e: any) {
        await std.log(`[${TAG}] Gagal tulis log: ${e?.message}`, TAG);
    }
}
