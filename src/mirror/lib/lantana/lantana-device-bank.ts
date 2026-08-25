/**
 * lantana-device-bank.ts — Lantana Layer 2: Device Bank
 *
 * Registry terpusat untuk semua device & sensor. Menyimpan state terkini
 * per node, kategori (statis dari config), dan menghitung heartbeat/health
 * berdasarkan umur data terakhir (lastDataAt → dataAgeMs → status).
 *
 * Kategori device & sensor DIDEFINISIKAN STATIS di /etc/lantana/config.json
 * (keputusan: dinamis dari device = fase 2).
 *
 * (c) 2026 TSIX Project — Lantana
 */

import {
    LantanaConfig,
    DeviceStatus,
    DeviceStatusInfo,
    SensorReading,
    DEVICE_STALE_MS,
    DEVICE_OFFLINE_MS,
    loadConfig,
} from "@tsix/lantana/lantana-core";

/** Satu device di registry */
export interface DeviceEntry {
    nodeId: string;
    tenant: string;
    category: string;   // kategori device (statis dari config)
    label: string;
    lastDataAt: number;
    lastFormat: "binary" | "plain";
    lastPort: number;
    sensors: Map<string, SensorEntry>;
}

/** Satu sensor dalam device */
export interface SensorEntry {
    id: string;
    category: string;   // kategori sensor (statis dari config)
    label: string;
    unit: string;
    value: number;
    ts: number;
}

export class DeviceBank {
    private devices: Map<string, DeviceEntry> = new Map();
    private config: LantanaConfig | null = null;

    async init(): Promise<void> {
        this.config = await loadConfig();
    }

    /** Upsert device + sensor dari satu raw data. */
    upsert(
        nodeId: string,
        tenant: string,
        port: number,
        format: "binary" | "plain",
        sensors: { id: string; value: number }[],
        ts: number,
    ): DeviceEntry {
        if (!this.config) this.config = { ports: {}, deviceCategories: {}, sensorCategories: {} };

        let dev = this.devices.get(nodeId);
        if (!dev) {
            // Deteksi kategori device statis dari config (fallback: generic)
            const cat = this.inferDeviceCategory(nodeId);
            const catCfg = this.config.deviceCategories[cat];
            dev = {
                nodeId,
                tenant,
                category: cat,
                label: catCfg?.label || nodeId,
                lastDataAt: 0,
                lastFormat: format,
                lastPort: port,
                sensors: new Map(),
            };
            this.devices.set(nodeId, dev);
        }

        // Update info device
        dev.tenant = tenant;
        dev.lastDataAt = ts;
        dev.lastFormat = format;
        dev.lastPort = port;

        // Update sensors
        for (const s of sensors) {
            const cat = this.inferSensorCategory(s.id);
            const catCfg = this.config.sensorCategories[cat];
            dev.sensors.set(s.id, {
                id: s.id,
                category: cat,
                label: catCfg?.label || s.id,
                unit: catCfg?.unit || "",
                value: s.value,
                ts,
            });
        }

        return dev;
    }

    /** Infer kategori device dari nodeId (statis — fase 2: dinamis dari device). */
    private inferDeviceCategory(nodeId: string): string {
        const id = nodeId.toLowerCase();
        if (id.includes("esp32") || id.includes("esp")) return "esp32";
        if (id.includes("sim") || id.includes("demo")) return "simulator";
        return "generic";
    }

    /** Infer kategori sensor dari id sensor (via config sensorIdMap atau heuristic). */
    private inferSensorCategory(sensorId: string): string {
        // 1. Cek mapping eksplisit dari config
        const map = (this.config as any)?.sensorIdMap as Record<string, string> | undefined;
        if (map && map[sensorId]) return map[sensorId];

        // 2. Heuristic dari id
        const s = sensorId.toLowerCase();
        if (s.includes("temp") || s === "01") return "temp";
        if (s.includes("hum") || s === "02") return "hum";
        if (s.includes("pres") || s.includes("bar") || s === "03") return "pres";
        if (s.includes("light") || s.includes("lux") || s === "04") return "light";
        return "generic";
    }

    /** Ambil semua device (dengan status dihitung saat ini). */
    listDevices(now: number = Date.now()): DeviceStatusInfo[] {
        const out: DeviceStatusInfo[] = [];
        for (const dev of this.devices.values()) {
            out.push({
                nodeId: dev.nodeId,
                tenant: dev.tenant,
                category: dev.category,
                label: dev.label,
                lastDataAt: dev.lastDataAt,
                dataAgeMs: now - dev.lastDataAt,
                status: this.computeStatus(dev.lastDataAt, now),
                sensorIds: Array.from(dev.sensors.keys()),
            });
        }
        // Urutkan: terbaru dulu
        out.sort((a, b) => b.lastDataAt - a.lastDataAt);
        return out;
    }

    /** Ambil snapshot sensor untuk satu device. */
    getDevice(nodeId: string): DeviceEntry | undefined {
        return this.devices.get(nodeId);
    }

    /** Ambil snapshot sensor ternormalisasi untuk satu device. */
    getSensors(nodeId: string): SensorReading[] {
        const dev = this.devices.get(nodeId);
        if (!dev) return [];
        const out: SensorReading[] = [];
        for (const s of dev.sensors.values()) {
            out.push({
                id: s.id,
                value: s.value,
                category: s.category,
                label: s.label,
                unit: s.unit,
                ts: s.ts,
            });
        }
        return out;
    }

    /** Hitung status heartbeat dari lastDataAt. */
    computeStatus(lastDataAt: number, now: number = Date.now()): DeviceStatus {
        const age = now - lastDataAt;
        if (age <= DEVICE_STALE_MS) return "ONLINE";
        if (age <= DEVICE_OFFLINE_MS) return "STALE";
        return "OFFLINE";
    }

    get size(): number {
        return this.devices.size;
    }
}
