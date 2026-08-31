/**
 * lantana-cmd.ts — Lantana Utility: Kirim Command ke Device (dua arah)
 *
 * Mengirim perintah ke device tertentu melalui daemon Lantana. Daemon
 * me-resolve alamat device (dari Device Bank) lalu meneruskan ke device
 * via MQTNL (mis. "RELAY_1:ON" / "RELAY_2:OFF").
 *
 * Usage:
 *   lantana-cmd <nodeId> <command> [target] [tenant]
 *   lantana-cmd esp32-dev-01 "RELAY_1:ON"
 *   lantana-cmd gudang-a "LAMP:OFF" <lantanaPid|uuid>
 *   lantana-cmd dev-01 "RELAY_1:ON" <lantanaPid|uuid> "Juragan Sensor"
 *
 * (c) 2026 TSIX Project — Lantana
 */

import { Program, std, shell } from "@tsix/Application";
import { LANTANA_UUID, EVT_COMMAND } from "@tsix/lantana/lantana-core";

const TAG = "lantana-cmd";

export const main = Program(async (args: string[]) => {
    const nodeId = args[0];
    const command = args[1];
    const target = args[2] || LANTANA_UUID;
    const tenant = args[3];

    if (!nodeId || !command) {
        await std.print("Usage: lantana-cmd <nodeId> <command> [target] [tenant]\n");
        await std.print("  lantana-cmd esp32-dev-01 \"RELAY_1:ON\"\n");
        return;
    }

    await std.print(`[${TAG}] Mengirim "${command}" → ${nodeId} via ${target}...\n`);

    // Kirim command ke daemon Lantana; daemon yang me-resolve alamat device
    const res = await shell.send(target, {
        type: EVT_COMMAND,
        nodeId,
        command,
        tenant, // opsional — target tenant saat nodeId sama di beberapa tenant
        from: "lantana-cmd",
    }).catch((e: any) => ({ error: e?.message || String(e) }));

    // shell.send tidak memberi balasan langsung (fire-and-forget);
    // hasil bisa dicek di log daemon / di device.
    await std.print(`[${TAG}] Command terkirim ke daemon. Cek log Lantana & device.\n`);
    return "";
});
