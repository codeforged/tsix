/**
 * lantana-device-bank.ts — Registry runtime device & bacaan terkini.
 *
 * Key = `accountId::deviceId`. Port/address hanya disimpan sebagai endpoint
 * terakhir untuk mengirim command balik; bukan identitas.
 *
 * DeviceBank TIDAK menyimpan histori dan TIDAK menyimpan AccessKey.
 * Data historis menjadi tanggung jawab consumer/DataBank.
 *
 * (c) 2026 TSIX Project — Lantana
 */

import {
    AcceptedReading,
    DEVICE_OFFLINE_MS,
    DEVICE_STALE_MS,
    DeviceMeta,
    DeviceStatus,
    DeviceStatusInfo,
    Endpoint,
    SensorReading,
} from "@tsix/lantana/lantana-core";

export interface DeviceEntry {
    accountId: string;
    deviceId: string;
    meta: DeviceMeta;
    lastDataAt: number;
    endpoint: Endpoint | null;
    readings: Map<number, SensorReading>;
}

export class DeviceBank {
    private devices: Map<string, DeviceEntry> = new Map();

    private key(accountId: string, deviceId: string): string {
        return `${accountId}::${deviceId}`;
    }

    /**
     * Simpan bacaan tervalidasi. `meta` berasal dari DeviceRegistry sehingga
     * perubahan nama/kota/grup langsung berlaku tanpa restart.
     */
    upsert(
        accountId: string,
        deviceId: string,
        meta: DeviceMeta,
        readings: AcceptedReading[],
        endpoint: Endpoint,
        now: number = Date.now(),
    ): DeviceEntry {
        const key = this.key(accountId, deviceId);
        let dev = this.devices.get(key);
        if (!dev) {
            dev = {
                accountId,
                deviceId,
                meta: { ...meta },
                lastDataAt: 0,
                endpoint: null,
                readings: new Map(),
            };
            this.devices.set(key, dev);
        }

        dev.meta = { ...meta };
        dev.lastDataAt = now;
        dev.endpoint = { ...endpoint };

        for (const reading of readings) {
            dev.readings.set(reading.schemeId, {
                schemeId: reading.schemeId,
                value: reading.value,
                label: reading.label,
                unit: reading.unit,
                ts: reading.receivedAt,
            });
        }

        return dev;
    }

    get(accountId: string, deviceId: string): DeviceEntry | undefined {
        return this.devices.get(this.key(accountId, deviceId));
    }

    /** Endpoint terakhir device (untuk command balik). */
    getEndpoint(accountId: string, deviceId: string): Endpoint | null {
        return this.get(accountId, deviceId)?.endpoint || null;
    }

    getReadings(accountId: string, deviceId: string): SensorReading[] {
        const dev = this.get(accountId, deviceId);
        if (!dev) return [];
        return Array.from(dev.readings.values()).sort((a, b) => a.schemeId - b.schemeId);
    }

    /**
     * Ambil bacaan yang boleh dibaca akun. `canQuery` dipasok PermissionPolicy
     * agar DeviceBank tidak perlu tahu aturan izin.
     */
    getQueryableReadings(
        accountId: string,
        deviceId: string,
        canQuery: (schemeId: number) => boolean,
    ): SensorReading[] {
        return this.getReadings(accountId, deviceId).filter((r) => canQuery(r.schemeId));
    }

    listDevices(now: number = Date.now(), accountId?: string): DeviceStatusInfo[] {
        const out: DeviceStatusInfo[] = [];
        for (const dev of this.devices.values()) {
            if (accountId && dev.accountId !== accountId) continue;
            out.push({
                accountId: dev.accountId,
                deviceId: dev.deviceId,
                name: dev.meta.name || dev.deviceId,
                category: dev.meta.category || "generic",
                group: dev.meta.group,
                city: dev.meta.city,
                lastDataAt: dev.lastDataAt,
                dataAgeMs: now - dev.lastDataAt,
                status: this.computeStatus(dev.lastDataAt, now),
                schemeIds: Array.from(dev.readings.keys()).sort((a, b) => a - b),
            });
        }
        out.sort((a, b) => b.lastDataAt - a.lastDataAt);
        return out;
    }

    computeStatus(lastDataAt: number, now: number = Date.now()): DeviceStatus {
        const age = now - lastDataAt;
        if (age <= DEVICE_STALE_MS) return "ONLINE";
        if (age <= DEVICE_OFFLINE_MS) return "STALE";
        return "OFFLINE";
    }

    remove(accountId: string, deviceId: string): void {
        this.devices.delete(this.key(accountId, deviceId));
    }

    get size(): number {
        return this.devices.size;
    }
}
