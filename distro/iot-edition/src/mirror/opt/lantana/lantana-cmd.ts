/**
 * lantana-cmd.ts — Kirim command ke device (dua arah).
 *
 * Command diotorisasi di daemon berdasarkan `accountId` peminta, lalu
 * dienkripsi dengan session key device.
 *
 * Usage:
 *   lantana-cmd <accountId> <deviceId> <command> [target]
 *   lantana-cmd juragan 3f2a... "RELAY_1:ON"
 *
 * (c) 2026 TSIX Project — Lantana
 */

import { Program, std, shell } from "@tsix/Application";
import { EVT_COMMAND, EVT_COMMAND_RESULT, LANTANA_UUID, resolveDaemonTarget } from "@tsix/lantana/lantana-core";

const TAG = "lantana-cmd";
const REPLY_TIMEOUT_MS = 3000;

export const main = Program(async (args: string[]) => {
    const accountId = args[0];
    const deviceId = args[1];
    const command = args[2];
    const target = resolveDaemonTarget(args[3] || LANTANA_UUID);

    if (!accountId || !deviceId || !command) {
        await std.print("Usage: lantana-cmd <accountId> <deviceId> <command> [target]\n");
        await std.print('  lantana-cmd juragan 3f2a-... "RELAY_1:ON"\n');
        return;
    }

    const lib = (global as any)._tsixLib;
    const pid = shell.getPid();

    const result = new Promise<any>((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, error: "timeout menunggu balasan daemon" }), REPLY_TIMEOUT_MS);
        lib.onEvent("ipc_message", (msg: any) => {
            const payload = msg?.data || msg;
            if (payload?.type !== EVT_COMMAND_RESULT) return;
            if (payload.data?.deviceId !== deviceId || payload.data?.accountId !== accountId) return;
            clearTimeout(timer);
            resolve(payload.data);
        });
    });

    await shell.send(target, {
        type: EVT_COMMAND,
        accountId,
        deviceId,
        command,
        from: TAG,
        fromPid: pid,
    }).catch(() => false);

    const res = await result;
    if (res.ok) {
        await std.print(`[${TAG}] Command terkirim ke ${deviceId}.\n`);
    } else {
        await std.print(`[${TAG}] Gagal: ${res.error}\n`);
    }
});
