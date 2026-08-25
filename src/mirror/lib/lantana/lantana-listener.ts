/**
 * lantana-listener.ts — Lantana Layer 1: Listener
 *
 * Bertugas menerima data mentah dari device via MQTNL socket dan
 * meneruskannya (raw) ke layer berikutnya (DeviceBank/Distributor).
 *
 * Kemampuan:
 *  - Bind ke satu atau lebih port dari config /etc/lantana/config.json
 *  - Auto-detect format payload: BINER (MQTNL v1.1, magic 0x42 / frame 0x4C)
 *    atau PLAINTEXT (`id:val;id:val` atau `LANTANA|<nodeId>|...`)
 *  - Upgrade security ChaCha20 per port (key dari config, bukan hardcode)
 *  - Kirim raw data ke distributor via IPC (LANTANA_RAW_DATA)
 *
 * (c) 2026 TSIX Project — Lantana
 */

import { net, std } from "@tsix/Application";
import { NetworkLib } from "@tsix/NetworkLib";
import {
    loadConfig,
    getPortConfig,
    parsePayload,
    RawSensorData,
} from "@tsix/lantana/lantana-core";

const TAG = "lantana-listener";

export class LantanaListener {
    private socketFds: Map<number, number> = new Map(); // port → fd

    constructor(
        private emitRaw: (data: RawSensorData) => void,
    ) { }

    /** Bind & upgrade security untuk semua port yang di-enable di config. */
    async start(): Promise<boolean> {
        const config = await loadConfig();

        for (const [portStr, portCfg] of Object.entries(config.ports)) {
            if (portCfg.enabled === false) continue;
            const port = parseInt(portStr, 10);
            if (isNaN(port)) continue;

            const fd = await net.socket();
            if (fd < 0) {
                await std.log(`[${TAG}] Gagal buat socket untuk port ${port}`, TAG);
                continue;
            }

            const bound = await net.bind(fd, port);
            if (!bound) {
                await std.log(`[${TAG}] Gagal bind port ${port} (mungkin sudah dipakai)`, TAG);
                continue;
            }

            // Upgrade security per port — key dari config (bukan hardcode)
            try {
                await net.ioctl(fd, 0x1001, { port, sessionKey: portCfg.keyHex });
            } catch (e: any) {
                await std.log(`[${TAG}] Warning: gagal upgrade security port ${port}: ${e?.message}`, TAG);
            }

            this.socketFds.set(port, fd);
            await std.log(
                `[${TAG}] Listening MQTNL port ${port} (tenant: ${portCfg.tenant}, format: ${portCfg.mode || "auto"})`,
                TAG,
            );
        }

        if (this.socketFds.size === 0) {
            await std.log(`[${TAG}] Tidak ada port aktif dari config.`, TAG);
            return false;
        }

        // Mulai loop penerimaan untuk tiap port
        for (const [port, fd] of this.socketFds.entries()) {
            this.receiveLoop(port, fd).catch(async (e: any) => {
                await std.log(`[${TAG}] Loop port ${port} error: ${e?.message}`, TAG);
            });
        }

        return true;
    }

    /** Loop penerimaan data untuk satu port. */
    private async receiveLoop(port: number, fd: number): Promise<void> {
        const config = await loadConfig();
        const portCfg = getPortConfig(config, port);

        while (true) {
            const pkt = await net.recv(fd);
            if (pkt) {
                const defaultNodeId = pkt.src || `node-${port}`;
                // Reconstruct payload ke bentuk yang bisa diproses (Buffer jika biner)
                const rawData: any = pkt.payload ?? pkt.data;
                const buf = NetworkLib.toBuffer(rawData);
                // Jika payload aslinya string plaintext, gunakan string asli agar
                // parsePlainPayload bekerja; jika biner, gunakan Buffer.
                const payloadForParse = typeof rawData === "string" && rawData.length > 0
                    ? rawData
                    : (buf.length > 0 ? buf : rawData);

                const { nodeId, sensors, format } = parsePayload(
                    payloadForParse,
                    defaultNodeId,
                );

                if (sensors.length === 0) {
                    // Mungkin paket kontrol (relay/command) — ignore untuk ingest data
                    continue;
                }

                const raw: RawSensorData = {
                    nodeId,
                    port,
                    tenant: portCfg?.tenant || "default",
                    format,
                    receivedAt: Date.now(),
                    sensors,
                };

                // Teruskan ke distributor (in-process — daemon Lantana satu proses)
                this.emitRaw(raw);
            }

            // Multitasking gap
            await new Promise((r) => setTimeout(r, 10));
        }
    }
}
