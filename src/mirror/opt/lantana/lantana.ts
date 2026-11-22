/**
 * lantana.ts — Lantana V2 daemon
 *
 * Wiring: state registry → policy → ingest pipeline → listener (sesi MQTNL)
 * → DeviceBank → DataBank queue → distributor → consumer.
 *
 * Usage:
 *   lantana            (start daemon)
 *   lantana --fg       (foreground debug)
 *   lantana --stop     (stop via pidfile)
 *
 * (c) 2026 TSIX Project — Lantana
 */

import { Program, std, shell, fs } from "@tsix/Application";
import { PermissionPolicy } from "@tsix/lantana/permission-policy";
import { SessionManager } from "@tsix/lantana/session-manager";
import { IngestPipeline } from "@tsix/lantana/lantana-ingest";
import { DeviceBank } from "@tsix/lantana/lantana-device-bank";
import { LantanaDistributor } from "@tsix/lantana/lantana-distributor";
import { LantanaListener } from "@tsix/lantana/lantana-listener";
import { MemoryDataBank, DataBankQueue, DrainReporter } from "@tsix/lantana/lantana-databank";
import { loadState } from "@tsix/lantana/lantana-store";
import { loadOrCreateServerKey } from "@tsix/lantana/lantana-keys";
import { LANTANA_UUID } from "@tsix/lantana/lantana-core";

const PID_FILE = "/tmp/lantana.pid";
const TAG = "lantana";
const RELOAD_INTERVAL_MS = 5000;

export const main = Program(async (args: string[]) => {
    const selfPid = shell.getPid();

    if (args.includes("--stop")) {
        await stopLantana();
        return;
    }

    const existing = await readPid();
    if (existing && existing !== selfPid && (await isAlive(existing))) {
        await std.log(`Lantana sudah berjalan (PID ${existing}) — gunakan --stop dulu.`, TAG);
        return;
    }
    await writePid();

    // ── State persisten ──
    let state = await loadState();
    const sessions = new SessionManager();
    const serverKey = await loadOrCreateServerKey();

    let policy = new PermissionPolicy(state.accounts, state.schemes);
    const bank = new DeviceBank();
    const distributor = new LantanaDistributor(bank, policy);

    // Sink pengembangan; DataBank produksi cukup mengimplementasikan DataBankSink.
    const dataBank = new DataBankQueue(new MemoryDataBank(), { capacity: 4096 });

    const listenerDeps = {
        accounts: state.accounts,
        devices: state.devices,
        sessions,
        ingest: new IngestPipeline({
            accounts: state.accounts,
            devices: state.devices,
            schemes: state.schemes,
            policy,
            sessions,
        }),
        bank,
        dataBank,
        distributor,
        serverKey,
    };

    const listener = new LantanaListener(listenerDeps);
    distributor.setCommandSender((accountId, deviceId, endpoint, command) =>
        listener.sendCommand(accountId, deviceId, endpoint, command),
    );

    if (!(await listener.start())) {
        await std.log("Lantana gagal start listener — periksa /etc/lantana/config.json.", TAG);
        await removePid();
        return;
    }

    await shell.registerIdentity(LANTANA_UUID);
    await std.log(
        `Lantana V2 siap — ${state.accounts.list().length} akun, ${state.devices.size} device, ${state.schemes.list().length} scheme`,
        TAG,
    );

    // ── IPC dari consumer / CLI ──
    (global as any)._tsixLib.onEvent("ipc_message", async (msg: any) => {
        const payload = msg?.data || msg;
        if (!payload || typeof payload !== "object") return;

        if (payload.type === "LANTANA_RELOAD") {
            const fromPid = payload.fromPid || msg?.fromPid;
            const requestId = payload.requestId;
            let reloadError: string | undefined;
            try {
                state = await loadState();
                policy = new PermissionPolicy(state.accounts, state.schemes);

                listenerDeps.accounts = state.accounts;
                listenerDeps.devices = state.devices;
                listenerDeps.ingest = new IngestPipeline({
                    accounts: state.accounts,
                    devices: state.devices,
                    schemes: state.schemes,
                    policy,
                    sessions,
                });
                distributor.setPolicy(policy);

                await std.log("State akun/device/scheme dimuat ulang.", TAG);
            } catch (error) {
                reloadError = error instanceof Error ? error.message : String(error);
                await std.log(`Gagal reload state: ${reloadError}`, TAG);
            }
            if (typeof fromPid === "number" && typeof requestId === "string") {
                const replied = await shell.send(fromPid, {
                    type: "LANTANA_RELOAD_RESULT",
                    requestId,
                    ok: !reloadError,
                    message: reloadError,
                });
                if (!replied) await std.log(`Gagal mengirim hasil reload ke PID ${fromPid}.`, TAG);
            }
            return;
        }

        await distributor.onIpcMessage(msg);
    });

    if (!args.includes("--fg")) {
        await shell.daemonize("lantana");
    }

    // ── Loop: drain DataBank + siarkan status ──
    let lastStatusAt = 0;
    const drainReporter = new DrainReporter();
    while (true) {
        const drained = await dataBank.drain();
        const drainLog = drainReporter.report(drained, dataBank.pending);
        if (drainLog) await std.log(drainLog, TAG);

        listener.forgetSessions(sessions.cleanup());

        const now = Date.now();
        if (now - lastStatusAt >= RELOAD_INTERVAL_MS) {
            lastStatusAt = now;
            await distributor.broadcastStatus(now);
        }

        await new Promise((r) => setTimeout(r, 1000));
    }
});

// ─── pidfile ───
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
    } catch {
        /* abaikan */
    }
}

async function removePid(): Promise<void> {
    try {
        await fs.unlink(PID_FILE);
    } catch {
        /* abaikan */
    }
}

async function isAlive(pid: number): Promise<boolean> {
    try {
        const procs = await shell.ps();
        return (
            Array.isArray(procs) &&
            procs.some(
                (p: any) =>
                    p.pid === pid &&
                    String(p.name || "").toLowerCase().includes("lantana") &&
                    p.state !== "EXITED",
            )
        );
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
    try {
        await shell.kill(pid, 15);
    } catch {
        /* abaikan */
    }
    await std.sleep(300);
    try {
        await shell.kill(pid, 9);
    } catch {
        /* abaikan */
    }
    await removePid();
    await std.print("[lantana] Berhenti.\n");
}
