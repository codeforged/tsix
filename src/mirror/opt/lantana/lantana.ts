/**
 * lantana.ts — Lantana IoT Stack (Daemon utama)
 *
 * Satu aplikasi daemon yang menjalankan 3 layer (separation of concern,
 * beda file):
 *   1. LantanaListener  — terima data biner/plaintext dari MQTNL
 *   2. DeviceBank       — registry multi-device + sensor + kategori + heartbeat
 *   3. LantanaDistributor — normalisasi + broadcast ke consumer
 *
 * Consumer (userland, dijalankan manual):
 *   - lantana-dashboard    (GUI)
 *   - lantana-db-injector  (DB via DbLib/mysqld)
 *   - lantana-file-logger  (history ke /var/log/lantana/)
 *
 * Usage:
 *   lantana            (start daemon, foreground)
 *   lantana --fg       (foreground debug)
 *   lantana --stop     (stop via pidfile)
 *
 * (c) 2026 TSIX Project — Lantana
 */

import { Program, std, shell, fs } from "@tsix/Application";
import { LantanaListener } from "@tsix/lantana/lantana-listener";
import { DeviceBank } from "@tsix/lantana/lantana-device-bank";
import { LantanaDistributor } from "@tsix/lantana/lantana-distributor";
import { LANTANA_UUID, EVT_SNAPSHOT, loadConfig } from "@tsix/lantana/lantana-core";

const PID_FILE = "/tmp/lantana.pid";
const TAG = "lantana";

export const main = Program(async (args: string[]) => {
    const selfPid = shell.getPid();

    // ── Argument handling ──
    if (args.includes("--stop")) {
        await stopLantana();
        return;
    }

    // ── Cegah daemon ganda ──
    const existing = await readPid();
    if (existing && existing !== selfPid && (await isAlive(existing))) {
        await std.log(`Lantana sudah berjalan (PID ${existing}) — gunakan --stop dulu.`, TAG);
        return;
    }
    await writePid();

    // ── Config ──
    const config = await loadConfig();
    const portCount = Object.values(config.ports).filter((p) => p.enabled !== false).length;
    await std.log(`Lantana IoT Stack starting — ${portCount} port aktif, config /etc/lantana/config.json`, TAG);

    // ── Layer 2: DeviceBank ──
    const bank = new DeviceBank();
    await bank.init();

    // ── Layer 3: Distributor ──
    const distributor = new LantanaDistributor(bank);

    // ── Layer 1: Listener (emit raw ke distributor via in-process) ──
    const listener = new LantanaListener(async (raw) => {
        await distributor.onRawData(raw);
    });

    const ok = await listener.start();
    if (!ok) {
        await std.log("Lantana gagal start listener — periksa config/port.", TAG);
        await removePid();
        return;
    }

    // ── Daftar identitas (consumer kirim via UUID) ──
    await shell.registerIdentity(LANTANA_UUID);
    await std.log(`Lantana ready. UUID: ${LANTANA_UUID}`, TAG);

    // ── Tangani pesan dari consumer ──
    (global as any)._tsixLib.onEvent("ipc_message", async (msg: any) => {
        const payload = msg?.data || msg;
        if (payload && typeof payload === "object") {
            if (payload.type === "LANTANA_REGISTER" || payload.type === "LANTANA_UNREGISTER" || payload.type === EVT_SNAPSHOT) {
                await distributor.onIpcMessage(msg);
            }
        }
    });

    // ── Detach ke background (kecuali --fg) ──
    if (!args.includes("--fg")) {
        await shell.daemonize("lantana");
    }
    await std.log("[lantana] daemon siap. Jalankan consumer: lantana-dashboard / lantana-db-injector / lantana-file-logger", TAG);

    // Stay alive + periodic status broadcast
    while (true) {
        const now = Date.now();
        const devices = bank.listDevices(now);
        const statusPayload = { type: "LANTANA_DEVICE_STATUS", data: devices, ts: now };
        for (const pid of distributor.getConsumerPids()) {
            try { await shell.send(pid, statusPayload); } catch (_) { /* ignore */ }
        }
        await new Promise((r) => setTimeout(r, 3000));
    }
});

// ─── Helpers pidfile ───
async function readPid(): Promise<number | null> {
    try {
        const raw = await fs.readFile(PID_FILE);
        if (!raw) return null;
        const n = parseInt(String(raw).trim(), 10);
        return isNaN(n) ? null : n;
    } catch {
        return null;
    }
}
async function writePid(): Promise<void> {
    try {
        const fd = await fs.open(PID_FILE, "w");
        if (fd >= 0) {
            await fs.write(fd, String(shell.getPid()));
            await fs.close(fd);
        }
    } catch (_) { /* ignore */ }
}
async function removePid(): Promise<void> {
    try { await fs.unlink(PID_FILE); } catch (_) { /* ignore */ }
}
async function isAlive(pid: number): Promise<boolean> {
    try {
        const procs = await shell.ps();
        return Array.isArray(procs) && procs.some((p: any) => p.pid === pid && String(p.name || "").toLowerCase().includes("lantana") && p.state !== "EXITED");
    } catch {
        return false;
    }
}
async function stopLantana(): Promise<void> {
    const pid = await readPid();
    if (!pid) {
        await std.print("[lantana] Tidak ada pidfile — daemon tidak berjalan.\n");
        return;
    }
    if (!(await isAlive(pid))) {
        await std.print(`[lantana] PID ${pid} tidak aktif — bersihkan pidfile.\n`);
        await removePid();
        return;
    }
    await std.print(`[lantana] Menghentikan PID ${pid}...\n`);
    try { await shell.kill(pid, 15); } catch (_) { }
    await std.sleep(300);
    try { await shell.kill(pid, 9); } catch (_) { }
    await removePid();
    await std.print("[lantana] Berhenti.\n");
}
