/**
 * lantana-distributor.ts — Lantana Layer 3: Data Distributor
 *
 * Hub normalisasi & broadcast. Menerima raw data (dari listener/device-bank),
 * melengkapi dengan metadata (kategori device/sensor, tenant, dataAgeMs,
 * status heartbeat), lalu menyiarkan ke semua consumer yang terdaftar
 * (dashboard, db-injector, file-logger) via IPC (LANTANA_SENSOR_DATA).
 *
 * (c) 2026 TSIX Project — Lantana
 */

import { shell, std } from "@tsix/Application";
import { DeviceBank } from "@tsix/lantana/lantana-device-bank";
import {
    LANTANA_UUID,
    EVT_RAW_DATA,
    EVT_SENSOR_DATA,
    EVT_DEVICE_STATUS,
    EVT_SNAPSHOT,
    EVT_COMMAND,
    RawSensorData,
    NormalizedSensorData,
    DeviceStatusInfo,
    LantanaCommand,
} from "@tsix/lantana/lantana-core";
const TAG = "lantana-distributor";

export class LantanaDistributor {
    /** consumer terdaftar: pid → { name, tenant filter (optional) } */
    private consumers: Map<number, { name: string; tenant?: string }> = new Map();
    private bank: DeviceBank;
    /** callback kirim command ke device (di-set daemon, memanggil listener.sendCommand) */
    private commandSender: ((nodeId: string, srcAddress: string, srcPort: number, command: string) => Promise<boolean>) | null = null;

    constructor(bank: DeviceBank) {
        this.bank = bank;
    }

    /** Set callback untuk mengirim command ke device (dua arah). */
    setCommandSender(
        fn: (nodeId: string, srcAddress: string, srcPort: number, command: string) => Promise<boolean>,
    ): void {
        this.commandSender = fn;
    }

    /** Terima raw data (dipanggil listener via in-process emit). */
    async onRawData(raw: RawSensorData): Promise<void> {
        const ts = raw.receivedAt || Date.now();

        // 1. Upsert ke device bank (simpan juga alamat sumber utk dua arah)
        const dev = this.bank.upsert(
            raw.nodeId,
            raw.tenant,
            raw.port,
            raw.format,
            raw.sensors,
            ts,
            raw.srcAddress,
            raw.srcPort,
        );

        // 2. Bangun payload normalisasi
        const sensors = this.bank.getSensors(raw.nodeId);
        const status = this.bank.computeStatus(ts);
        const payload: NormalizedSensorData = {
            type: EVT_SENSOR_DATA,
            tenant: raw.tenant,
            nodeId: raw.nodeId,
            nodeCategory: dev.category,
            nodeLabel: dev.label,
            format: raw.format,
            receivedAt: ts,
            dataAgeMs: Date.now() - ts,
            deviceStatus: status,
            sensors,
            meta: {
                port: raw.port,
                count: raw.sensors.length,
                source: "mqtnl",
            },
        };

        // 3. Broadcast ke semua consumer
        await this.broadcast(payload);
    }

    /** Siarkan payload ke consumer terdaftar (filter per tenant). */
    private async broadcast(payload: NormalizedSensorData | DeviceStatusInfo[]): Promise<void> {
        for (const [pid, info] of this.consumers.entries()) {
            // Filter tenant: jika consumer punya filter tenant & tidak cocok → skip
            if (info.tenant && Array.isArray(payload) === false) {
                const p = payload as NormalizedSensorData;
                if (p.tenant !== info.tenant) continue;
            }
            try {
                await shell.send(pid, { type: EVT_SENSOR_DATA, data: payload });
            } catch (_) {
                // Consumer mati → hapus dari daftar
                this.consumers.delete(pid);
            }
        }
    }

    /** Kirim snapshot penuh ke satu consumer (respon EVT_SNAPSHOT). */
    async sendSnapshot(targetPid: number): Promise<void> {
        const now = Date.now();
        const devices = this.bank.listDevices(now);
        try {
            await shell.send(targetPid, {
                type: "LANTANA_SNAPSHOT_REPLY",
                data: {
                    devices,
                    sensorData: devices.map((d) => ({
                        nodeId: d.nodeId,
                        tenant: d.tenant,
                        sensors: this.bank.getSensors(d.nodeId),
                    })),
                    ts: now,
                },
            });
        } catch (_) {
            /* consumer tidak ada */
        }
    }

    /** Daftarkan consumer baru (dipanggil saat ada ipc_message REGISTER). */
    registerConsumer(pid: number, name: string, tenant?: string): void {
        this.consumers.set(pid, { name, tenant });
        std.log(`[${TAG}] Consumer registered: ${name} (PID ${pid}, tenant: ${tenant || "*"})`, TAG);
    }

    /** Unregister consumer. */
    unregisterConsumer(pid: number): void {
        this.consumers.delete(pid);
    }

    /** Daftar PID consumer terdaftar. */
    getConsumerPids(): number[] {
        return Array.from(this.consumers.keys());
    }

    /** Tangani event dari consumer/daemon via IPC. */
    async onIpcMessage(msg: any): Promise<void> {
        const payload = msg?.data || msg;
        if (!payload || typeof payload !== "object") return;

        switch (payload.type) {
            case "LANTANA_REGISTER": {
                this.registerConsumer(payload.fromPid || msg?.fromPid, payload.name || "unknown", payload.tenant);
                break;
            }
            case "LANTANA_UNREGISTER": {
                this.unregisterConsumer(payload.fromPid || msg?.fromPid);
                break;
            }
            case EVT_SNAPSHOT: {
                const fromPid = payload.fromPid || msg?.fromPid;
                if (fromPid) await this.sendSnapshot(fromPid);
                break;
            }
            case EVT_COMMAND: {
                await this.handleCommand(payload as LantanaCommand);
                break;
            }
            default:
                break;
        }
    }

    /**
     * Proses perintah dua arah dari consumer → device.
     * Resolusi alamat device via Device Bank, lalu kirim via commandSender.
     */
    async handleCommand(cmd: LantanaCommand): Promise<{ ok: boolean; error?: string }> {
        const nodeId = cmd?.nodeId;
        const command = cmd?.command;
        if (!nodeId || !command) {
            return { ok: false, error: "LANTANA_COMMAND butuh nodeId & command" };
        }

        const addr = this.bank.getDeviceAddress(nodeId);
        if (!addr) {
            std.log(`[${TAG}] Command ke ${nodeId} gagal: device tidak dikenal`, TAG);
            return { ok: false, error: `device ${nodeId} tidak dikenal` };
        }

        if (!this.commandSender) {
            return { ok: false, error: "commandSender belum di-set (daemon tidak siap)" };
        }

        std.log(`[${TAG}] Command "${command}" → ${nodeId} (${addr.srcAddress}:${addr.srcPort})`, TAG);
        const ok = await this.commandSender(nodeId, addr.srcAddress, addr.srcPort, command);
        return ok ? { ok: true } : { ok: false, error: "gagal kirim ke device" };
    }

    get consumerCount(): number {
        return this.consumers.size;
    }
}
