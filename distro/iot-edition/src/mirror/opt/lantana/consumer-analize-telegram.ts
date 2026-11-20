/**
 * consumer-analize-telegram.ts — Analisa ambang sensor dan kirim alert Telegram.
 *
 * Usage:
 *   export TELEGRAM_BOT_TOKEN=<bot-token>
 *   export TELEGRAM_CHAT_ID=<chat-id>
 *   consumer-analize-telegram <accountId> <schemeId|*> <deviceId|*> <threshold> [daemon-target]
 *
 * Quote '*' saat dipakai agar wildcard tidak di-expand oleh shell.
 * Nilai di atas threshold memicu satu alert; nilai yang turun di bawahnya
 * mengaktifkan kembali alert untuk bacaan berikutnya.
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

const TAG = "consumer-analize-telegram";
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

async function sendTelegram(botToken: string, chatId: string, text: string): Promise<void> {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(10_000),
    });

    let result: { ok?: boolean; description?: string };
    try {
        result = await response.json() as { ok?: boolean; description?: string };
    } catch {
        throw new Error(`Telegram API mengirim respons non-JSON (${response.status}).`);
    }

    if (!response.ok || result?.ok !== true) {
        throw new Error(
            `Telegram API gagal (${response.status}): ${result?.description || "respons tidak valid"}`,
        );
    }
}

export const main = Program(async (args: string[]) => {
    const [accountId, schemeArg, deviceFilter, thresholdArg, targetArg] = args;
    if (!accountId || accountId.startsWith("--") || !schemeArg || !deviceFilter || !thresholdArg) {
        await std.println(
            `Usage: ${TAG} <accountId> <schemeId|*> <deviceId|*> <threshold> [daemon-target]`,
        );
        return;
    }

    const schemeFilter = parseSchemeFilter(schemeArg);
    const threshold = Number(thresholdArg);
    if (!thresholdArg.trim() || !Number.isFinite(threshold)) {
        throw new Error("threshold harus berupa angka.");
    }

    const botToken = (await shell.getenv("TELEGRAM_BOT_TOKEN"))?.trim();
    const chatId = (await shell.getenv("TELEGRAM_CHAT_ID"))?.trim();
    if (!botToken || !chatId) {
        throw new Error("Set TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_ID sebelum menjalankan consumer.");
    }

    const target = resolveDaemonTarget(targetArg || LANTANA_UUID);
    const lib = (globalThis as any)._tsixLib;
    if (typeof lib?.onEvent !== "function" || typeof lib?.offEvent !== "function") {
        throw new Error("API event IPC TSIX tidak tersedia.");
    }

    const aboveThresholdBySensor = new Map<string, boolean>();
    let eventQueue = Promise.resolve();

    const processBatch = async (batch: ReadingBatch): Promise<void> => {
        if (batch.accountId !== accountId ||
            (deviceFilter !== "*" && batch.deviceId !== deviceFilter)) {
            return;
        }

        for (const reading of batch.readings) {
            if (schemeFilter !== "*" && reading.schemeId !== schemeFilter) continue;
            if (typeof reading.value !== "number") continue;

            const key = `${batch.deviceId}/${reading.schemeId}`;
            const aboveThreshold = reading.value >= threshold;
            if (!aboveThreshold) {
                aboveThresholdBySensor.set(key, false);
                continue;
            }
            if (aboveThresholdBySensor.get(key)) continue;

            const valueWithUnit = `${reading.value}${reading.unit ? ` ${reading.unit}` : ""}`;
            const text =
                `Lantana alert: ${batch.name} (${batch.deviceId}), ` +
                `${reading.label} = ${valueWithUnit}; threshold ${threshold} terlampaui. ` +
                `Waktu: ${new Date(reading.ts).toISOString()}`;
            await sendTelegram(botToken, chatId, text);
            aboveThresholdBySensor.set(key, true);
            await std.log(
                `[${TAG}] Alert terkirim: device=${batch.deviceId}, scheme=${reading.schemeId}.`,
                TAG,
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
            await std.log(
                `[${TAG}] Gagal memproses bacaan: ${detail.split(botToken).join("[redacted]")}`,
                TAG,
            );
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
        `[${TAG}] Memantau akun ${accountId}, scheme ${schemeFilter}, device ${deviceFilter}, threshold ${threshold}.`,
        TAG,
    );
    while (true) await std.sleep(5_000);
});
