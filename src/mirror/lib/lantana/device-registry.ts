/**
 * device-registry.ts — Penerbitan & registry deviceId.
 *
 * deviceId diterbitkan Lantana saat user mendaftarkan device, lalu diikat ke
 * `accountId`. ID bersifat publik; bukti keaslian device tetap berasal dari
 * AccessKey akun, bukan dari deviceId.
 *
 * Endpoint routing (address/port) TIDAK disimpan di sini — itu state runtime
 * di DeviceBank.
 *
 * (c) 2026 TSIX Project — Lantana
 */

import * as crypto from "crypto";
import {
    DeviceMeta,
    DeviceRecord,
} from "@tsix/lantana/lantana-core";

export class DeviceRegistryError extends Error {}

function sanitizeMeta(meta: DeviceMeta | undefined): DeviceMeta {
    const out: DeviceMeta = {};
    for (const key of ["name", "city", "category", "group"] as const) {
        const value = meta?.[key];
        if (typeof value === "string" && value.trim()) out[key] = value.trim();
    }
    return out;
}

export class DeviceRegistry {
    private devices: Map<string, DeviceRecord> = new Map();

    private key(accountId: string, deviceId: string): string {
        return `${accountId}::${deviceId}`;
    }

    /** Terbitkan deviceId baru untuk akun. */
    register(accountId: string, meta: DeviceMeta = {}): DeviceRecord {
        if (!accountId) throw new DeviceRegistryError("accountId wajib diisi");

        let deviceId = "";
        do {
            deviceId = crypto.randomUUID();
        } while (this.devices.has(this.key(accountId, deviceId)));

        const record: DeviceRecord = {
            deviceId,
            accountId,
            meta: sanitizeMeta(meta),
            createdAt: Date.now(),
        };
        this.devices.set(this.key(accountId, deviceId), record);
        return record;
    }

    get(accountId: string, deviceId: string): DeviceRecord | undefined {
        return this.devices.get(this.key(accountId, deviceId));
    }

    /** Apakah device terdaftar pada akun ini. */
    belongsTo(accountId: string, deviceId: string): boolean {
        return !!this.get(accountId, deviceId);
    }

    updateMeta(accountId: string, deviceId: string, patch: DeviceMeta): DeviceRecord {
        const rec = this.get(accountId, deviceId);
        if (!rec) throw new DeviceRegistryError(`device tidak ditemukan: ${deviceId}`);
        rec.meta = { ...rec.meta, ...sanitizeMeta(patch) };
        return rec;
    }

    remove(accountId: string, deviceId: string): void {
        if (!this.devices.delete(this.key(accountId, deviceId))) {
            throw new DeviceRegistryError(`device tidak ditemukan: ${deviceId}`);
        }
    }

    listByAccount(accountId: string): DeviceRecord[] {
        return Array.from(this.devices.values()).filter((d) => d.accountId === accountId);
    }

    list(): DeviceRecord[] {
        return Array.from(this.devices.values());
    }

    get size(): number {
        return this.devices.size;
    }

    toJSON(): DeviceRecord[] {
        return this.list();
    }

    static fromJSON(records: DeviceRecord[] | undefined | null): DeviceRegistry {
        const reg = new DeviceRegistry();
        for (const rec of records || []) {
            if (!rec || typeof rec.deviceId !== "string" || typeof rec.accountId !== "string") {
                continue;
            }
            reg.devices.set(reg.key(rec.accountId, rec.deviceId), {
                deviceId: rec.deviceId,
                accountId: rec.accountId,
                meta: sanitizeMeta(rec.meta),
                createdAt: rec.createdAt || Date.now(),
            });
        }
        return reg;
    }
}
