/**
 * lantana-distributor.ts — Distribusi bacaan ke consumer + command dua arah.
 *
 * Consumer mendaftar dengan `accountId` sebagai filter tampilan. Filter ini
 * BUKAN otorisasi: semua data yang keluar dari distributor sudah lolos
 * autentikasi, otorisasi, dan validasi di IngestPipeline.
 *
 * (c) 2026 TSIX Project — Lantana
 */

import { shell, std } from "@tsix/Application";
import { DeviceBank } from "@tsix/lantana/lantana-device-bank";
import { PermissionPolicy } from "@tsix/lantana/permission-policy";
import {
    DeviceStatusInfo,
    Endpoint,
    EVT_COMMAND,
    EVT_COMMAND_RESULT,
    EVT_DEVICE_STATUS,
    EVT_READING,
    EVT_SNAPSHOT_REPLY,
    LantanaCommand,
    NormalizedReadingBatch,
    SensorReading,
} from "@tsix/lantana/lantana-core";

const TAG = "lantana-distributor";

export type CommandSender = (
    accountId: string,
    deviceId: string,
    endpoint: Endpoint,
    command: string,
) => Promise<boolean>;

interface ConsumerInfo {
    name: string;
    accountIds: Set<string>;
}

export class LantanaDistributor {
    private consumers: Map<number, ConsumerInfo> = new Map();
    private commandSender: CommandSender | null = null;

    constructor(
        private bank: DeviceBank,
        private policy: PermissionPolicy,
    ) {}

    setCommandSender(fn: CommandSender): void {
        this.commandSender = fn;
    }

    /** Ganti policy saat registry dimuat ulang (mis. setelah perubahan via CLI). */
    setPolicy(policy: PermissionPolicy): void {
        this.policy = policy;
    }

    registerConsumer(pid: number, name: string, accountId?: string): void {
        // Consumer tanpa accountId akan melihat data semua akun — tolak.
        if (!accountId) {
            std.log(
                `[${TAG}] Consumer ${name} (PID ${pid}) ditolak: accountId wajib diisi`,
                TAG,
            );
            return;
        }
        this.consumers.set(pid, { name, accountIds: new Set([accountId]) });
        std.log(
            `[${TAG}] Consumer registered: ${name} (PID ${pid}, akun: ${accountId})`,
            TAG,
        );
    }

    subscribeConsumer(pid: number, name: string, accountId?: string): void {
        if (!accountId) {
            std.log(
                `[${TAG}] Consumer ${name} (PID ${pid}) ditolak: accountId wajib diisi`,
                TAG,
            );
            return;
        }
        const consumer = this.consumers.get(pid) ?? {
            name,
            accountIds: new Set<string>(),
        };
        consumer.name = name;
        consumer.accountIds.add(accountId);
        this.consumers.set(pid, consumer);
        std.log(
            `[${TAG}] Consumer subscribed: ${name} (PID ${pid}, akun: ${accountId})`,
            TAG,
        );
    }

    unregisterConsumer(pid: number, accountId?: string): void {
        if (!accountId) {
            this.consumers.delete(pid);
            return;
        }
        const consumer = this.consumers.get(pid);
        if (!consumer) return;
        consumer.accountIds.delete(accountId);
        if (consumer.accountIds.size === 0) this.consumers.delete(pid);
    }

    getConsumerPids(): number[] {
        return Array.from(this.consumers.keys());
    }

    get consumerCount(): number {
        return this.consumers.size;
    }

    /** Siarkan satu batch bacaan tervalidasi (hanya ke consumer akun yang sama). */
    async broadcastBatch(batch: NormalizedReadingBatch): Promise<void> {
        for (const [pid, info] of this.consumers.entries()) {
            if (!info.accountIds.has(batch.accountId)) continue;
            try {
                await shell.send(pid, { type: EVT_READING, data: batch });
            } catch {
                this.consumers.delete(pid);
            }
        }
    }

    /** Status device berkala (heartbeat). */
    async broadcastStatus(now: number = Date.now()): Promise<void> {
        for (const [pid, info] of this.consumers.entries()) {
            for (const accountId of info.accountIds) {
                const devices = this.bank.listDevices(now, accountId);
                try {
                    await shell.send(pid, { type: EVT_DEVICE_STATUS, data: devices });
                } catch {
                    this.consumers.delete(pid);
                    break;
                }
            }
        }
    }

    /** Snapshot untuk satu consumer; hanya bacaan yang boleh dibaca akun itu. */
    async sendSnapshot(targetPid: number, accountId?: string, requestId?: string): Promise<void> {
        const now = Date.now();
        const devices = this.bank.listDevices(now, accountId);

        const payload: Array<{
            device: DeviceStatusInfo;
            readings: SensorReading[];
        }> = [];

        for (const device of devices) {
            if (!accountId) continue;
            const readings = this.bank.getQueryableReadings(
                device.accountId,
                device.deviceId,
                (schemeId) => this.policy.canQuery(accountId, schemeId).ok,
            );
            payload.push({ device, readings });
        }

        try {
            await shell.send(targetPid, {
                type: EVT_SNAPSHOT_REPLY,
                data: { accountId: accountId || null, devices: payload, ts: now, requestId },
            });
        } catch {
            /* consumer sudah tidak ada */
        }
    }

    async onIpcMessage(msg: any): Promise<void> {
        const payload = msg?.data || msg;
        if (!payload || typeof payload !== "object") return;

        const fromPid = payload.fromPid || msg?.fromPid;
        if (!fromPid) return;

        switch (payload.type) {
            case "LANTANA_REGISTER":
                this.registerConsumer(fromPid, payload.name || "unknown", payload.accountId);
                return;
            case "LANTANA_SUBSCRIBE":
                this.subscribeConsumer(fromPid, payload.name || "unknown", payload.accountId);
                return;
            case "LANTANA_UNREGISTER":
                this.unregisterConsumer(fromPid);
                return;
            case "LANTANA_UNSUBSCRIBE":
                this.unregisterConsumer(fromPid, payload.accountId);
                return;
            case "LANTANA_SNAPSHOT":
                await this.sendSnapshot(fromPid, payload.accountId, payload.requestId);
                return;
            case EVT_COMMAND:
                await this.handleCommand(fromPid, payload as LantanaCommand);
                return;
            default:
                return;
        }
    }

    /**
     * Kirim command ke device, hanya jika akun peminta berhak atas device itu.
     * Hasil selalu dilaporkan balik ke peminta (bukan fire-and-forget).
     */
    async handleCommand(
        fromPid: number,
        cmd: LantanaCommand,
    ): Promise<{ ok: boolean; error?: string }> {
        const reply = async (result: { ok: boolean; error?: string }) => {
            try {
                await shell.send(fromPid, { type: EVT_COMMAND_RESULT, data: { ...cmd, ...result } });
            } catch {
                /* peminta hilang */
            }
            return result;
        };

        if (!cmd?.deviceId || !cmd?.command || !cmd?.accountId) {
            return reply({ ok: false, error: "deviceId, command, dan accountId wajib diisi" });
        }

        const allowed = this.policy.canCommand(cmd.accountId, cmd.deviceId);
        if (!allowed.ok) {
            return reply({ ok: false, error: allowed.message || "command tidak diizinkan" });
        }

        if (!this.commandSender) {
            return reply({ ok: false, error: "commandSender belum siap" });
        }

        const endpoint = this.bank.getEndpoint(cmd.accountId, cmd.deviceId);
        if (!endpoint) {
            return reply({ ok: false, error: `device ${cmd.deviceId} belum punya endpoint` });
        }

        std.log(
            `[${TAG}] Command "${cmd.command}" → ${cmd.deviceId} (${endpoint.address}:${endpoint.port})`,
            TAG,
        );
        const ok = await this.commandSender(cmd.accountId, cmd.deviceId, endpoint, cmd.command);
        return reply(ok ? { ok: true } : { ok: false, error: "gagal kirim ke device" });
    }
}
