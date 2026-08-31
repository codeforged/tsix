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
    /** Grup tenant (dari deviceGroupMap config) — opsional */
    group?: string;
    lastDataAt: number;
    lastFormat: "binary" | "plain";
    lastPort: number;
    /** Alamat sumber device (untuk kirim command balik / dua arah) */
    srcAddress: string;
    /** Port sumber device (untuk kirim command balik / dua arah) */
    srcPort: number;
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

    /**
     * Key internal registry = tenant::nodeId.
     * nodeId boleh sama antar tenant (apiKey berbeda) — tenant memisahkan entri.
     */
    private key(nodeId: string, tenant: string): string {
        return `${tenant}::${nodeId}`;
    }

    /** Resolve grup tenant dari deviceGroupMap (nested { tenant: { nodeId: group } }
     *  ATAU flat legacy { nodeId: group }). Backward compatible. */
    private resolveGroup(nodeId: string, tenant: string): string | undefined {
        const map = this.config?.deviceGroupMap as any;
        if (!map) return undefined;
        // Bentuk nested: { "Juragan Sensor": { "dev-01": "client-a" } }
        const perTenant = map[tenant];
        if (perTenant && typeof perTenant === "object") {
            return perTenant[nodeId];
        }
        // Bentuk flat legacy: { "dev-01": "client-a" }
        return map[nodeId];
    }

    /** Upsert device + sensor dari satu raw data. */
    upsert(
        nodeId: string,
        tenant: string,
        port: number,
        format: "binary" | "plain",
        sensors: { id: string; value: number }[],
        ts: number,
        srcAddress?: string,
        srcPort?: number,
    ): DeviceEntry {
        if (!this.config) this.config = { ports: {}, deviceCategories: {}, sensorCategories: {}, deviceGroupMap: {} };

        const key = this.key(nodeId, tenant);
        let dev = this.devices.get(key);
        if (!dev) {
            // Deteksi kategori device statis dari config (fallback: generic)
            const cat = this.inferDeviceCategory(nodeId);
            const catCfg = this.config.deviceCategories[cat];
            dev = {
                nodeId,
                tenant,
                category: cat,
                label: catCfg?.label || nodeId,
                group: this.resolveGroup(nodeId, tenant),
                lastDataAt: 0,
                lastFormat: format,
                lastPort: port,
                srcAddress: srcAddress || nodeId,
                srcPort: srcPort || 0,
                sensors: new Map(),
            };
            this.devices.set(key, dev);
        }

        // Update info device
        dev.tenant = tenant;
        // Grup selalu di-resolve ulang agar registrasi device baru via
        // deviceGroupMap langsung berlaku tanpa restart daemon.
        dev.group = this.resolveGroup(nodeId, tenant);
        dev.lastDataAt = ts;
        dev.lastFormat = format;
        dev.lastPort = port;
        if (srcAddress) dev.srcAddress = srcAddress;
        if (srcPort !== undefined) dev.srcPort = srcPort;

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
                group: dev.group,
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

    /** Ambil device berdasarkan tenant+nodeId. */
    getDevice(nodeId: string, tenant: string): DeviceEntry | undefined {
        return this.devices.get(this.key(nodeId, tenant));
    }

    /** Cari device hanya dari nodeId (untuk command dua arah saat tenant tidak
     *  diketahui). Ambil yang terbaru jika ada beberapa tenant dgn nodeId sama. */
    getDeviceByNode(nodeId: string): DeviceEntry | undefined {
        let best: DeviceEntry | undefined;
        for (const dev of this.devices.values()) {
            if (dev.nodeId === nodeId && (!best || dev.lastDataAt > best.lastDataAt)) {
                best = dev;
            }
        }
        return best;
    }

    /** Ambil alamat sumber device (untuk kirim command balik / dua arah). */
    getDeviceAddress(nodeId: string, tenant: string): { srcAddress: string; srcPort: number } | null {
        const dev = this.devices.get(this.key(nodeId, tenant));
        if (!dev) return null;
        return { srcAddress: dev.srcAddress, srcPort: dev.srcPort };
    }

    /** Ambil snapshot sensor ternormalisasi untuk satu device. */
    getSensors(nodeId: string, tenant: string): SensorReading[] {
        const dev = this.devices.get(this.key(nodeId, tenant));
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
