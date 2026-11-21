/**
 * consumer-test.ts — Cetak bacaan sensor Lantana ke console.
 *
 * Usage:
 *   consumer-test <accountId> [schemeId|*] [deviceId|*] [daemon-target]
 *
 * Quote '*' saat dipakai agar wildcard tidak di-expand oleh shell.
 */

import { Program, shell, std } from "@tsix/Application";
import {
    EVT_READING,
    EVT_SNAPSHOT,
    EVT_SNAPSHOT_REPLY,
    LANTANA_UUID,
    resolveDaemonTarget,
} from "@tsix/lantana/lantana-core";
import type { SensorReading } from "@tsix/lantana/lantana-core";

const TAG = "consumer-test";
type SchemeFilter = number | "*";

interface ReadingBatch {
    accountId: string;
    deviceId: string;
    name: string;
    readings: SensorReading[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isSensorReading(value: unknown): value is SensorReading {
    if (!isRecord(value)) return false;
    const readingValue = value.value;
    return Number.isSafeInteger(value.schemeId) &&
        (typeof readingValue === "number" || typeof readingValue === "boolean" || typeof readingValue === "string") &&
        (typeof readingValue !== "number" || Number.isFinite(readingValue)) &&
        typeof value.label === "string" &&
        typeof value.unit === "string" &&
        typeof value.ts === "number" &&
        Number.isFinite(value.ts);
}

function toReadingBatch(value: unknown): ReadingBatch | undefined {
    if (!isRecord(value) || typeof value.accountId !== "string" ||
        typeof value.deviceId !== "string" || typeof value.name !== "string" ||
        !Array.isArray(value.readings) || !value.readings.every(isSensorReading)) {
        return undefined;
    }

    return {
        accountId: value.accountId,
        deviceId: value.deviceId,
        name: value.name,
        readings: value.readings,
    };
}

function parseSchemeFilter(value: string): SchemeFilter {
    if (value === "*") return "*";
    const schemeId = Number(value);
    if (!value.trim() || !Number.isSafeInteger(schemeId) || schemeId < 0) {
        throw new Error("schemeId harus bilangan bulat non-negatif atau '*'.");
    }
    return schemeId;
}

export const main = Program(async (args: string[]) => {
    const [accountId, schemeArg = "*", deviceFilter = "*", targetArg] = args;
    if (!accountId || accountId.startsWith("--") || !deviceFilter) {
        await std.println(`Usage: ${TAG} <accountId> [schemeId|*] [deviceId|*] [daemon-target]`);
        return;
    }

    const schemeFilter = parseSchemeFilter(schemeArg);
    const target = resolveDaemonTarget(targetArg || LANTANA_UUID);
    const lib = (globalThis as any)._tsixLib;
    if (typeof lib?.onEvent !== "function" || typeof lib?.offEvent !== "function") {
        throw new Error("API event IPC TSIX tidak tersedia.");
    }

    let eventQueue = Promise.resolve();

    const processBatch = async (batch: ReadingBatch): Promise<void> => {
        if (batch.accountId !== accountId ||
            (deviceFilter !== "*" && batch.deviceId !== deviceFilter)) {
            return;
        }

        for (const reading of batch.readings) {
            if (schemeFilter !== "*" && reading.schemeId !== schemeFilter) continue;

            const value = typeof reading.value === "string"
                ? JSON.stringify(reading.value)
                : String(reading.value);
            const unit = reading.unit ? ` ${reading.unit}` : "";
            await std.println(
                `[${TAG}] account=${batch.accountId} device=${batch.deviceId} ` +
                `scheme=${reading.schemeId} (${reading.label}) = ${value}${unit} ` +
                `at ${new Date(reading.ts).toISOString()}`,
            );
        }
    };

    const handleMessage = async (message: unknown): Promise<void> => {
        const payload = isRecord(message) && "data" in message ? message.data : message;
        if (!isRecord(payload)) return;

        if (payload.type === EVT_READING) {
            const batch = toReadingBatch(payload.data);
            if (batch) await processBatch(batch);
            return;
        }

        if (payload.type !== EVT_SNAPSHOT_REPLY || !isRecord(payload.data) ||
            !Array.isArray(payload.data.devices)) {
            return;
        }

        for (const entry of payload.data.devices) {
            if (!isRecord(entry) || !isRecord(entry.device)) continue;
            const device = entry.device;
            if (typeof device.accountId !== "string" || typeof device.deviceId !== "string") continue;

            const batch = toReadingBatch({
                accountId: device.accountId,
                deviceId: device.deviceId,
                name: typeof device.name === "string" ? device.name : device.deviceId,
                readings: entry.readings,
            });
            if (batch) await processBatch(batch);
        }
    };

    const onIpcMessage = (message: unknown): void => {
        eventQueue = eventQueue.then(() => handleMessage(message)).catch(async (error: unknown) => {
            const detail = error instanceof Error ? error.message : String(error);
            await std.log(`[${TAG}] Gagal memproses bacaan: ${detail}`, TAG);
        });
    };

    lib.onEvent("ipc_message", onIpcMessage);
    try {
        const registered = await shell.send(target, {
            type: "LANTANA_REGISTER",
            name: TAG,
            accountId,
            fromPid: shell.getPid(),
        });
        if (!registered) throw new Error(`Gagal mendaftar ke daemon Lantana (${target}).`);

        const snapshotRequested = await shell.send(target, {
            type: EVT_SNAPSHOT,
            accountId,
            fromPid: shell.getPid(),
        });
        if (!snapshotRequested) {
            await std.log(`[${TAG}] Request snapshot gagal; menunggu bacaan baru.`, TAG);
        }
    } catch (error) {
        lib.offEvent("ipc_message", onIpcMessage);
        throw error;
    }

    await std.log(
        `[${TAG}] Memantau akun ${accountId}, scheme ${schemeFilter}, device ${deviceFilter}.`,
        TAG,
    );
    while (true) await std.sleep(5_000);
});
