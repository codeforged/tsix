/**
 * lantana-stress.ts — Provision, jalankan, dan bersihkan uji beban Lantana.
 *
 * Usage:
 *   lantana-stress setup <accountId> [--count=1000] [--groups=10] [--scheme-count=5]
 *   lantana-stress run <manifest> --host=<test-host> --fingerprint=<server-fingerprint>
 *                     [--schemes=101,102] [--port=1000] [--interval-ms=5000]
 *                     [--duration-sec=60] [--handshake-concurrency=20]
 *                     [--handshake-timeout-sec=120] [--drain-timeout-sec=30] [--plain]
 *   lantana-stress cleanup <manifest> [--report=<report-json> ...]
 *
 * Run membutuhkan LANTANA_STRESS_ACCESS_KEY di environment.
 * Host non-loopback membutuhkan --confirm-target; batasi run maksimal 5 menit.
 */

import * as crypto from "crypto";
import { fs, net, Program, shell, std } from "@tsix/Application";
import { SecurityAgent } from "@common/SecurityAgent";
import { PermissionPolicy } from "@tsix/lantana/permission-policy";
import { loadState, saveDevices, saveSchemes } from "@tsix/lantana/lantana-store";
import {
    assertStressDevices,
    assertStressSchemes,
    LANTANA_STRESS_MAX_DEVICES,
    LANTANA_STRESS_MAX_GROUPS,
    LANTANA_STRESS_MAX_SCHEMES,
    parseStressManifest,
    removeStressDevices,
    removeStressSchemes,
    stressDeviceName,
    stressGroupName,
    stressManifestPath,
    stressSchemeLabel,
    type StressManifest,
    type StressManifestDevice,
    type StressManifestScheme,
} from "@tsix/lantana/lantana-stress-manifest";
import {
    encodeBinaryPayload,
    encodePlainPayload,
    EVT_READING,
    LANTANA_UUID,
} from "@tsix/lantana/lantana-core";
import { summarizeDelivery } from "@tsix/lantana/lantana-stress-report";
import type { RawReading, SchemeDef } from "@tsix/lantana/lantana-core";

const TAG = "lantana-stress";
const DEFAULT_PORT = 1000;
const MAX_DURATION_SEC = 300;
const DEFAULT_HANDSHAKE_TIMEOUT_SEC = 120;
const MAX_HANDSHAKE_TIMEOUT_SEC = 300;
const HANDSHAKE_STAGE_TIMEOUT_MS = 10_000;
const DEFAULT_DRAIN_TIMEOUT_SEC = 30;
const MAX_DRAIN_TIMEOUT_SEC = 120;
const DRAIN_QUIET_WINDOW_MS = 3000;
const NACK_POLL_INTERVAL_MS = 50;

interface StressClient {
    fd: number;
    localPort: number;
    deviceId: string;
    index: number;
    agent: SecurityAgent;
    nextSendAt: number;
    sequence: number;
}

interface StressCounters {
    handshakeFailures: number;
    packetsSent: number;
    readingsSent: number;
    sendFailures: number;
    nacks: number;
    nackReasons: Record<string, number>;
    acceptedBatches: number;
    acceptedReadings: number;
    receiverFailures: number;
    cleanupFailures: number;
}

interface DrainResult {
    durationSec: number;
    reason: "complete" | "quiet" | "timeout" | "disabled" | "no-traffic";
}

interface ChallengeMessage {
    type: string;
    nonce?: string;
    publicKey?: string;
    fingerprint?: string;
    message?: string;
}

export const main = Program(async (args: string[]) => {
    const [command, ...rest] = args;
    if (command === "setup") {
        await setupRun(rest);
    } else if (command === "run") {
        await runStressTest(rest);
    } else if (command === "cleanup") {
        await cleanupRun(rest);
    } else {
        await std.println(usage());
    }
});

async function setupRun(args: string[]): Promise<void> {
    const accountId = args[0];
    if (!accountId || accountId.startsWith("--")) {
        throw new Error(
            "Usage: lantana-stress setup <accountId> [--count=1000] [--groups=10] [--scheme-count=5]",
        );
    }

    const count = integerOption(args, "count", 1000, 1, LANTANA_STRESS_MAX_DEVICES);
    const groups = integerOption(args, "groups", 10, 1, LANTANA_STRESS_MAX_GROUPS);
    const schemeCount = integerOption(args, "scheme-count", 5, 0, LANTANA_STRESS_MAX_SCHEMES);
    const state = await loadState();
    if (!state.accounts.has(accountId)) throw new Error(`Akun tidak ditemukan: ${accountId}`);

    const runId = crypto.randomUUID();
    const schemeIds = allocateStressSchemeIds((schemeId) => state.schemes.has(schemeId), schemeCount);
    const schemes: StressManifestScheme[] = schemeIds.map((schemeId, index) => {
        const label = stressSchemeLabel(runId, index);
        state.schemes.add({
            schemeId,
            ownerAccountId: accountId,
            label,
            unit: "unit",
            type: "number",
            min: 0,
            max: 100,
        });
        return { schemeId, label, type: "number", unit: "unit", min: 0, max: 100 };
    });

    const devices: StressManifestDevice[] = [];
    for (let index = 0; index < count; index++) {
        const name = stressDeviceName(runId, index);
        const group = stressGroupName(runId, index, groups);
        const record = state.devices.register(accountId, {
            name,
            category: "stress-test",
            group,
        });
        devices.push({ deviceId: record.deviceId, name, group });
    }

    const manifest: StressManifest = {
        version: 1,
        runId,
        accountId,
        createdAt: Date.now(),
        count,
        groups,
        devices,
        schemes,
    };
    const manifestPath = stressManifestPath(runId);
    if (!(await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`))) {
        throw new Error(`Gagal menulis manifest stress: ${manifestPath}`);
    }

    try {
        await saveDevices(state.devices);
        if (schemes.length > 0) await saveSchemes(state.schemes);
    } catch (error) {
        throw new Error(
            `Gagal menyimpan devices.json/schemes.json; manifest untuk pemulihan ada di ${manifestPath}: ${errorMessage(error)}`,
        );
    }

    try {
        await reloadLantana();
    } catch (error) {
        throw new Error(
            `Device tersimpan, tetapi daemon gagal reload. Manifest untuk cleanup: ${manifestPath}. ${errorMessage(error)}`,
        );
    }

    await std.println(`[${TAG}] Dibuat ${count} device dalam ${groups} group.`);
    await std.println(
        `[${TAG}] Dibuat ${schemes.length} scheme: ${schemes.map((scheme) => scheme.schemeId).join(", ") || "(tidak ada)"}.`,
    );
    await std.println(`[${TAG}] Manifest: ${manifestPath}`);
    await std.println(
        `[${TAG}] Setelah tes: lantana-stress cleanup ${manifestPath}`,
    );
}

async function cleanupRun(args: string[]): Promise<void> {
    const manifestPath = args[0];
    const cleanupOptions = args.slice(1);
    const reportPaths = cleanupOptions.map((arg) =>
        arg.startsWith("--report=") ? arg.slice("--report=".length) : "",
    );
    if (
        !manifestPath ||
        reportPaths.some((path) => !path) ||
        new Set(reportPaths).size !== reportPaths.length
    ) {
        throw new Error("Usage: lantana-stress cleanup <manifest> [--report=<report-json> ...]");
    }

    const raw = await fs.readFile(manifestPath);
    if (raw === null) throw new Error(`Manifest tidak ditemukan: ${manifestPath}`);
    const manifest = parseStressManifest(raw, manifestPath);
    for (const reportPath of reportPaths) {
        if (
            !reportPath.startsWith(`${manifestPath}.report-`) ||
            !reportPath.endsWith(".json")
        ) {
            throw new Error("Report harus berupa file report stress yang dibuat untuk manifest ini.");
        }
        const reportRaw = await fs.readFile(reportPath);
        if (reportRaw === null) throw new Error(`Report stress tidak ditemukan: ${reportPath}`);
        let report: unknown;
        try {
            report = JSON.parse(String(reportRaw));
        } catch {
            throw new Error(`Report stress bukan JSON yang valid: ${reportPath}`);
        }
        if (
            !isRecord(report) ||
            report.version !== 1 ||
            report.runId !== manifest.runId ||
            report.accountId !== manifest.accountId
        ) {
            throw new Error(`Report stress tidak cocok dengan manifest: ${reportPath}`);
        }
    }

    const state = await loadState();
    for (const scheme of manifest.schemes) {
        const dashboard = state.dashboards.list().find((record) =>
            record.portableDashboard.some((item) =>
                item.dashboardItems.some((dashboardItem) => dashboardItem.schemeId === scheme.schemeId),
            ),
        );
        if (dashboard) {
            throw new Error(
                `Scheme ${scheme.schemeId} masih dipakai dashboard akun ${dashboard.accountId}; ` +
                "hapus referensinya sebelum cleanup.",
            );
        }
    }

    const removedSchemes = removeStressSchemes(state.schemes, manifest);
    const removed = removeStressDevices(state.devices, manifest);
    if (removed > 0) await saveDevices(state.devices);
    if (removedSchemes > 0) await saveSchemes(state.schemes);

    try {
        await reloadLantana();
    } catch (error) {
        throw new Error(
            `devices.json sudah dibersihkan (${removed} device), tetapi daemon belum reload. ` +
            `Manifest dipertahankan untuk retry: ${manifestPath}. ${errorMessage(error)}`,
        );
    }

    for (const reportPath of reportPaths) {
        if (!(await fs.unlink(reportPath))) {
            throw new Error(`Resource sudah dibersihkan, tetapi report gagal dihapus: ${reportPath}`);
        }
    }

    if (!(await fs.unlink(manifestPath))) {
        throw new Error(`Device sudah dibersihkan, tetapi manifest gagal dihapus: ${manifestPath}`);
    }
    await std.println(
        `[${TAG}] Cleanup selesai: ${removed} device dan ${removedSchemes} scheme dihapus; ` +
        `akun tidak diubah${reportPaths.length ? ` dan ${reportPaths.length} report dihapus` : ""}.`,
    );
}

async function runStressTest(args: string[]): Promise<void> {
    const manifestPath = args[0];
    const host = option(args, "host");
    const fingerprint = option(args, "fingerprint");
    const schemesArg = option(args, "schemes");
    if (!manifestPath || !host || !fingerprint) {
        throw new Error(
            "Usage: lantana-stress run <manifest> --host=<test-host> " +
            "--fingerprint=<server-fingerprint> [--schemes=101,102] [--port=1000] " +
            "[--interval-ms=5000] [--duration-sec=60] [--handshake-concurrency=20] " +
            "[--handshake-timeout-sec=120] [--drain-timeout-sec=30] [--plain]",
        );
    }
    if (!isLoopbackHost(host) && !args.includes("--confirm-target")) {
        throw new Error("Host bukan loopback; tambahkan --confirm-target hanya untuk server uji milik Anda.");
    }

    const port = integerOption(args, "port", DEFAULT_PORT, 1, 65535);
    const intervalMs = integerOption(args, "interval-ms", 5000, 250, 60_000);
    const durationSec = integerOption(args, "duration-sec", 60, 1, MAX_DURATION_SEC);
    const handshakeConcurrency = integerOption(args, "handshake-concurrency", 20, 1, 50);
    const handshakeTimeoutSec = integerOption(
        args,
        "handshake-timeout-sec",
        DEFAULT_HANDSHAKE_TIMEOUT_SEC,
        10,
        MAX_HANDSHAKE_TIMEOUT_SEC,
    );
    const drainTimeoutSec = integerOption(
        args,
        "drain-timeout-sec",
        DEFAULT_DRAIN_TIMEOUT_SEC,
        0,
        MAX_DRAIN_TIMEOUT_SEC,
    );
    const expectedFingerprint = normalizeFingerprint(fingerprint);
    if (!/^[0-9a-f]{16}$/.test(expectedFingerprint)) {
        throw new Error("Fingerprint harus 16 digit hex, seperti keluaran `lantana-ctl server fingerprint`.");
    }
    const usePlain = args.includes("--plain");

    const rawManifest = await fs.readFile(manifestPath);
    if (rawManifest === null) throw new Error(`Manifest tidak ditemukan: ${manifestPath}`);
    const manifest = parseStressManifest(rawManifest, manifestPath);
    const schemeIds = schemesArg === undefined
        ? manifest.schemes.map((scheme) => scheme.schemeId)
        : parseSchemeIds(schemesArg);
    if (schemeIds.length === 0) {
        throw new Error("Manifest tidak memiliki scheme; berikan --schemes=ID,... atau buat dengan --scheme-count.");
    }
    const state = await loadState();
    assertStressDevices(state.devices, manifest);
    assertStressSchemes(state.schemes, manifest);

    const accessKey = (await shell.getenv("LANTANA_STRESS_ACCESS_KEY"))?.trim();
    if (!accessKey || !state.accounts.verifyAccessKey(manifest.accountId, accessKey)) {
        throw new Error("LANTANA_STRESS_ACCESS_KEY kosong atau tidak valid untuk akun manifest.");
    }

    const policy = new PermissionPolicy(state.accounts, state.schemes);
    const schemes: SchemeDef[] = schemeIds.map((schemeId) => {
        const scheme = state.schemes.get(schemeId);
        if (!scheme) throw new Error(`Scheme tidak ditemukan: ${schemeId}`);
        const permission = policy.canInject(manifest.accountId, schemeId);
        if (!permission.ok) throw new Error(permission.message || `Akun tidak boleh inject scheme ${schemeId}`);
        return scheme;
    });
    if (usePlain && schemes.some((scheme) => scheme.type === "string")) {
        throw new Error("Payload plain V2 tidak mendukung scheme string; gunakan format binary.");
    }

    const lib = (globalThis as any)._tsixLib;
    if (typeof lib?.onEvent !== "function" || typeof lib?.offEvent !== "function") {
        throw new Error("API event IPC TSIX tidak tersedia.");
    }

    const counters: StressCounters = {
        handshakeFailures: 0,
        packetsSent: 0,
        readingsSent: 0,
        sendFailures: 0,
        nacks: 0,
        nackReasons: {},
        acceptedBatches: 0,
        acceptedReadings: 0,
        receiverFailures: 0,
        cleanupFailures: 0,
    };
    const executionId = crypto.randomUUID();
    const reportPath = `${manifestPath}.report-${executionId}.json`;
    const deviceIds = new Set(manifest.devices.map((device) => device.deviceId));
    const onIpcMessage = (message: unknown): void => {
        const payload = isRecord(message) && "data" in message ? message.data : message;
        if (!isRecord(payload) || payload.type !== EVT_READING || !isRecord(payload.data)) return;
        const batch = payload.data;
        if (
            batch.accountId !== manifest.accountId ||
            typeof batch.deviceId !== "string" ||
            !deviceIds.has(batch.deviceId) ||
            !Array.isArray(batch.readings)
        ) return;
        counters.acceptedBatches++;
        counters.acceptedReadings += batch.readings.length;
    };

    lib.onEvent("ipc_message", onIpcMessage);
    let consumerRegistered = false;
    const clients: StressClient[] = [];
    const runtimeErrors: string[] = [];
    let stopReceivers = false;
    let receiverTasks: Promise<void>[] = [];
    let elapsedSec = 0;
    let loadStartedAt: number | null = null;
    let loadEndedAt: number | null = null;
    let preRunActivity = { acceptedBatches: 0, acceptedReadings: 0 };
    let loadEndCounters = {
        sentBatches: 0,
        sentReadings: 0,
        sendFailures: 0,
        acceptedBatches: 0,
        acceptedReadings: 0,
        nacks: 0,
    };
    let drainResult: DrainResult = { durationSec: 0, reason: "disabled" };
    try {
        const registered = await shell.send(LANTANA_UUID, {
            type: "LANTANA_REGISTER",
            name: TAG,
            accountId: manifest.accountId,
            fromPid: shell.getPid(),
        });
        if (!registered) throw new Error("Gagal mendaftar sebagai consumer metrik ke Lantana.");
        consumerRegistered = true;

        const errors: string[] = [];
        const handshakeDeadline = Date.now() + handshakeTimeoutSec * 1000;
        const results = await mapWithLimit(
            manifest.devices,
            handshakeConcurrency,
            async (device, index): Promise<StressClient | null> => {
                try {
                    return await openAuthenticatedDevice(
                        device.deviceId,
                        index,
                        host,
                        port,
                        manifest.accountId,
                        accessKey,
                        expectedFingerprint,
                        handshakeDeadline,
                    );
                } catch (error) {
                    counters.handshakeFailures++;
                    if (errors.length < 5) errors.push(errorMessage(error));
                    return null;
                }
            },
        );
        for (const client of results) {
            if (client) clients.push(client);
        }

        await std.println(
            `[${TAG}] Handshake sukses ${clients.length}/${manifest.count}; ` +
            `gagal ${counters.handshakeFailures} (batas ${handshakeTimeoutSec}s).`,
        );
        for (const detail of errors) await std.println(`[${TAG}] Handshake: ${detail}`);
        if (clients.length === 0) {
            loadStartedAt = Date.now();
            loadEndedAt = loadStartedAt;
            drainResult = { durationSec: 0, reason: "no-traffic" };
        } else {
            preRunActivity = {
                acceptedBatches: counters.acceptedBatches,
                acceptedReadings: counters.acceptedReadings,
            };
            counters.acceptedBatches = 0;
            counters.acceptedReadings = 0;
            if (preRunActivity.acceptedBatches > 0) {
                await std.println(
                    `[${TAG}] Mengabaikan ${preRunActivity.acceptedBatches} event ingest sebelum load ` +
                    `(${preRunActivity.acceptedReadings} readings).`,
                );
            }

            const start = Date.now();
            loadStartedAt = start;
            const stopAt = start + durationSec * 1000;
            for (const client of clients) {
                client.nextSendAt = start + Math.floor((client.index / clients.length) * intervalMs);
            }
            receiverTasks = clients.map((client) =>
                watchNacks(client, counters, () => stopReceivers, runtimeErrors),
            );

            await std.println(
                `[${TAG}] Run ${durationSec}s, ${clients.length} device, ` +
                `${schemeIds.length} scheme/paket, interval ${intervalMs}ms ke ${host}:${port}.`,
            );
            await runSenderLoop(
                clients,
                schemes,
                usePlain,
                host,
                port,
                intervalMs,
                start,
                stopAt,
                counters,
                runtimeErrors,
            );
            loadEndedAt = Date.now();
            elapsedSec = (loadEndedAt - start) / 1000;
            loadEndCounters = {
                sentBatches: counters.packetsSent,
                sentReadings: counters.readingsSent,
                sendFailures: counters.sendFailures,
                acceptedBatches: counters.acceptedBatches,
                acceptedReadings: counters.acceptedReadings,
                nacks: counters.nacks,
            };
            drainResult = await drainAfterSender(counters, drainTimeoutSec, elapsedSec);
        }
    } finally {
        stopReceivers = true;
        await Promise.all(receiverTasks);
        await closeClients(clients, counters, runtimeErrors);
        lib.offEvent("ipc_message", onIpcMessage);
        if (consumerRegistered) {
            try {
                const unregistered = await shell.send(LANTANA_UUID, {
                    type: "LANTANA_UNREGISTER",
                    fromPid: shell.getPid(),
                });
                if (!unregistered) {
                    counters.cleanupFailures++;
                    recordError(runtimeErrors, "Gagal unregister consumer dari Lantana.");
                }
            } catch (error) {
                counters.cleanupFailures++;
                recordError(runtimeErrors, `Unregister consumer: ${errorMessage(error)}`);
            }
        }
    }

    const delivery = summarizeDelivery(
        counters.packetsSent,
        counters.acceptedBatches,
        counters.nacks,
    );
    const loadDelivery = summarizeDelivery(
        loadEndCounters.sentBatches,
        loadEndCounters.acceptedBatches,
        loadEndCounters.nacks,
    );
    const outcome = delivery.overObservedBatches > 0
        ? "counter-mismatch"
        : delivery.estimatedUnconfirmedBatches === 0 &&
            counters.nacks === 0 &&
            counters.sendFailures === 0 &&
            counters.handshakeFailures === 0 &&
            counters.receiverFailures === 0 &&
            counters.cleanupFailures === 0 &&
            runtimeErrors.length === 0
          ? "complete"
          : "incomplete";
    const finishedAt = Date.now();
    const report = {
        version: 1,
        runId: manifest.runId,
        executionId,
        accountId: manifest.accountId,
        target: { host, port, fingerprint: expectedFingerprint },
        configuration: {
            requestedDevices: manifest.count,
            connectedDevices: clients.length,
            schemeIds,
            intervalMs,
            durationSec,
            drainTimeoutSec,
        },
        timing: {
            loadStartedAt: loadStartedAt === null ? null : new Date(loadStartedAt).toISOString(),
            loadEndedAt: loadEndedAt === null ? null : new Date(loadEndedAt).toISOString(),
            finishedAt: new Date(finishedAt).toISOString(),
            loadDurationSec: Number(elapsedSec.toFixed(2)),
            drainDurationSec: Number(drainResult.durationSec.toFixed(2)),
            drainStopReason: drainResult.reason,
        },
        outcome,
        handshake: {
            successful: clients.length,
            failed: counters.handshakeFailures,
        },
        preRunActivity,
        loadEnd: {
            ...loadDelivery,
            sentReadings: loadEndCounters.sentReadings,
            acceptedReadings: loadEndCounters.acceptedReadings,
            sendFailures: loadEndCounters.sendFailures,
        },
        final: {
            ...delivery,
            sentReadings: counters.readingsSent,
            acceptedReadings: counters.acceptedReadings,
            sendFailures: counters.sendFailures,
            receiverFailures: counters.receiverFailures,
            cleanupFailures: counters.cleanupFailures,
            nackReasons: counters.nackReasons,
        },
        dataBank: {
            persistenceTested: false,
            sink: "MemoryDataBank",
            note: "In-memory sink only; no durable database write is measured.",
        },
        measurement: {
            ingestObservedFrom: "LANTANA_READING consumer IPC events",
            unconfirmedNote: "Estimated sent batches not yet observed or NACKed at report time.",
            correlationLimit: "Events are matched by manifest device IDs, not unique packet IDs.",
        },
        runtimeErrors,
    };

    await printFinalSummary(outcome, elapsedSec, drainResult, delivery, counters);
    const reportWritten = await fs.writeFile(
        reportPath,
        `${JSON.stringify(report, null, 2)}\n`,
    );
    if (!reportWritten) throw new Error(`Gagal menulis report stress: ${reportPath}`);
    await std.println(`[${TAG}] JSON report: ${reportPath}`);
    for (const error of runtimeErrors) await std.println(`[${TAG}] Runtime: ${error}`);
    await std.println(`[${TAG}] Persistensi DataBank tidak diuji (sink saat ini hanya RAM).`);
    await std.println(`[${TAG}] Cleanup resource: lantana-stress cleanup ${manifestPath}`);
    await std.println(
        `[${TAG}] Hapus report juga: lantana-stress cleanup ${manifestPath} --report=${reportPath}`,
    );
}

async function openAuthenticatedDevice(
    deviceId: string,
    index: number,
    host: string,
    port: number,
    accountId: string,
    accessKey: string,
    expectedFingerprint: string,
    handshakeDeadline: number,
): Promise<StressClient> {
    if (Date.now() >= handshakeDeadline) {
        throw new Error("Batas waktu handshake keseluruhan tercapai.");
    }
    const fd = await net.socket();
    if (typeof fd !== "number" || fd < 0) throw new Error("Gagal membuat socket.");

    let keepSocket = false;
    try {
        const sourcePort = await net.bind(fd, 0);
        if (!Number.isInteger(sourcePort) || sourcePort < 1 || sourcePort > 65535) {
            throw new Error("Gagal mengikat socket ke source port ephemeral.");
        }

        const agent = new SecurityAgent();
        const sendControl = async (payload: unknown): Promise<void> => {
            const sent = await net.sendto(fd, host, port, JSON.stringify(payload), 0, sourcePort);
            if (!sent) throw new Error(`Gagal mengirim kontrol ke ${host}:${port}`);
        };

        await sendControl({ type: "LANTANA_HELLO", accountId, deviceId });
        const challenge = await waitForMessage<ChallengeMessage>(
            fd,
            (message) => message.type === "LANTANA_CHALLENGE" || message.type === "LANTANA_NACK",
            handshakeTimeout(handshakeDeadline),
        );
        if (!challenge || challenge.type !== "LANTANA_CHALLENGE") {
            throw new Error(`HELLO ditolak untuk ${deviceId}: ${challenge?.message || "timeout"}`);
        }
        if (!challenge.publicKey || !challenge.nonce || !challenge.fingerprint) {
            throw new Error(`Challenge tidak valid untuk ${deviceId}`);
        }

        const publicKeyFingerprint = normalizeFingerprint(
            SecurityAgent.getFingerprint(challenge.publicKey),
        );
        if (
            normalizeFingerprint(challenge.fingerprint) !== expectedFingerprint ||
            publicKeyFingerprint !== expectedFingerprint
        ) {
            throw new Error(`Fingerprint server tidak cocok untuk ${deviceId}`);
        }

        const sessionKey = SecurityAgent.generateSessionKey();
        const encryptedKey = SecurityAgent.encryptWithPublicKey(challenge.publicKey, sessionKey);
        await sendControl({ type: "LANTANA_KEYSET", encryptedKey });
        const keysetOk = await waitForMessage<{ type: string; message?: string }>(
            fd,
            (message) => message.type === "LANTANA_KEYSET_OK" || message.type === "LANTANA_NACK",
            handshakeTimeout(handshakeDeadline),
        );
        if (!keysetOk || keysetOk.type !== "LANTANA_KEYSET_OK") {
            throw new Error(`KEYSET gagal untuk ${deviceId}: ${keysetOk?.message || "timeout"}`);
        }
        agent.setSessionKey(sessionKey);

        const authPayload = agent.securePacketOut(JSON.stringify({
            accountId,
            deviceId,
            accessKey,
            nonce: challenge.nonce,
        }));
        await sendControl({ type: "LANTANA_AUTH", payload: authPayload });
        const authReply = await waitForMessage<{ type: string; message?: string }>(
            fd,
            (message) => message.type === "LANTANA_AUTH_OK" || message.type === "LANTANA_NACK",
            handshakeTimeout(handshakeDeadline),
            agent,
        );
        if (!authReply || authReply.type !== "LANTANA_AUTH_OK") {
            throw new Error(
                `AUTH gagal untuk ${deviceId}: ${authReply?.message || "timeout"}`,
            );
        }

        keepSocket = true;
        return {
            fd,
            localPort: sourcePort,
            deviceId,
            index,
            agent,
            nextSendAt: 0,
            sequence: 0,
        };
    } finally {
        if (!keepSocket) await net.close(fd);
    }
}

async function waitForMessage<T extends { type: string }>(
    fd: number,
    matches: (message: T) => boolean,
    timeoutMs: number,
    agent?: SecurityAgent,
): Promise<T | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const packet = await net.recv(fd);
        if (!packet) continue;

        const direct = parseJsonMessage(packet.data);
        if (direct && matches(direct as T)) return direct as T;
        if (!agent) continue;

        const encrypted = Buffer.isBuffer(packet.data)
            ? packet.data.toString("hex")
            : String(packet.data ?? "");
        const decrypted = agent.securePacketIn(encrypted);
        const message = parseJsonMessage(decrypted);
        if (message && matches(message as T)) return message as T;
    }
    return null;
}

function parseJsonMessage(value: unknown): Record<string, unknown> | null {
    if (isRecord(value) && typeof value.type === "string") return value;
    const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
    try {
        const parsed: unknown = JSON.parse(text);
        return isRecord(parsed) && typeof parsed.type === "string" ? parsed : null;
    } catch {
        return null;
    }
}

async function watchNacks(
    client: StressClient,
    counters: StressCounters,
    shouldStop: () => boolean,
    errors: string[],
): Promise<void> {
    while (!shouldStop()) {
        try {
            const packet = await net.recv(client.fd);
            if (!packet) {
                await std.sleep(NACK_POLL_INTERVAL_MS);
                continue;
            }
            const direct = parseJsonMessage(packet.data);
            if (direct?.type === "LANTANA_NACK") {
                recordNack(counters, direct);
                continue;
            }

            const encrypted = Buffer.isBuffer(packet.data)
                ? packet.data.toString("hex")
                : String(packet.data ?? "");
            const decrypted = parseJsonMessage(client.agent.securePacketIn(encrypted));
            if (decrypted?.type === "LANTANA_NACK") recordNack(counters, decrypted);
        } catch (error) {
            counters.receiverFailures++;
            recordError(errors, `Receiver ${client.deviceId}: ${errorMessage(error)}`);
            return;
        }
    }
}

function recordNack(counters: StressCounters, message: Record<string, unknown>): void {
    counters.nacks++;
    const reason =
        typeof message.name === "string"
            ? message.name
            : typeof message.code === "number"
              ? `0x${message.code.toString(16)}`
              : "UNKNOWN";
    counters.nackReasons[reason] = (counters.nackReasons[reason] ?? 0) + 1;
}

async function runSenderLoop(
    clients: StressClient[],
    schemes: SchemeDef[],
    usePlain: boolean,
    host: string,
    port: number,
    intervalMs: number,
    startAt: number,
    stopAt: number,
    counters: StressCounters,
    errors: string[],
): Promise<void> {
    let nextReportAt = Date.now() + 5000;
    while (Date.now() < stopAt) {
        const now = Date.now();
        const due = clients.filter((client) => client.nextSendAt <= now);
        for (const client of due) client.nextSendAt = now + intervalMs;

        await Promise.all(due.map(async (client) => {
            const readings = makeReadings(schemes, client.index, client.sequence++);
            const payload = usePlain
                ? encodePlainPayload(client.deviceId, readings)
                : encodeBinaryPayload(client.deviceId, readings);
            try {
                const sent = await net.sendto(
                    client.fd,
                    host,
                    port,
                    client.agent.securePacketOut(payload),
                    0,
                    client.localPort,
                );
                if (sent) {
                    counters.packetsSent++;
                    counters.readingsSent += readings.length;
                } else {
                    counters.sendFailures++;
                }
            } catch (error) {
                counters.sendFailures++;
                recordError(errors, `Send ${client.deviceId}: ${errorMessage(error)}`);
            }
        }));

        const reportNow = Date.now();
        if (reportNow >= nextReportAt) {
            await printProgress(counters, (reportNow - startAt) / 1000, "load");
            nextReportAt = reportNow + 5000;
        }
        await std.sleep(Math.min(25, Math.max(1, stopAt - Date.now())));
    }
}

async function drainAfterSender(
    counters: StressCounters,
    timeoutSec: number,
    loadDurationSec: number,
): Promise<DrainResult> {
    if (timeoutSec === 0) return { durationSec: 0, reason: "disabled" };

    const startedAt = Date.now();
    const deadline = startedAt + timeoutSec * 1000;
    const initial = summarizeDelivery(
        counters.packetsSent,
        counters.acceptedBatches,
        counters.nacks,
    );
    if (initial.estimatedUnconfirmedBatches === 0) {
        return { durationSec: 0, reason: "complete" };
    }

    await std.println(
        `[${TAG}] Drain: menunggu event ingest tertunda, maksimal ${timeoutSec}s.`,
    );
    let lastProgressAt = startedAt;
    let previousResolved = counters.acceptedBatches + counters.nacks;
    let nextReportAt = startedAt + 5000;

    while (Date.now() < deadline) {
        await std.sleep(Math.min(100, Math.max(1, deadline - Date.now())));
        const now = Date.now();
        const resolved = counters.acceptedBatches + counters.nacks;
        if (resolved > previousResolved) {
            previousResolved = resolved;
            lastProgressAt = now;
        }

        const pending = summarizeDelivery(
            counters.packetsSent,
            counters.acceptedBatches,
            counters.nacks,
        ).estimatedUnconfirmedBatches;
        if (pending === 0 && now - lastProgressAt >= 1000) {
            return { durationSec: (now - startedAt) / 1000, reason: "complete" };
        }
        if (now - lastProgressAt >= DRAIN_QUIET_WINDOW_MS) {
            return { durationSec: (now - startedAt) / 1000, reason: "quiet" };
        }
        if (now >= nextReportAt) {
            await printProgress(counters, loadDurationSec, "drain");
            nextReportAt = now + 5000;
        }
    }

    return { durationSec: (Date.now() - startedAt) / 1000, reason: "timeout" };
}

function makeReadings(
    schemes: SchemeDef[],
    deviceIndex: number,
    sequence: number,
): RawReading[] {
    return schemes.map((scheme, schemeIndex) => {
        let value: RawReading["value"];
        if (scheme.type === "number") {
            const min = scheme.min ?? (scheme.max === undefined ? 0 : Math.min(0, scheme.max));
            const max = scheme.max ?? (scheme.min === undefined ? 100 : Math.max(scheme.min, scheme.min + 100));
            const position = ((deviceIndex + sequence + schemeIndex) % 11) / 10;
            value = Number((min + (max - min) * position).toFixed(2));
        } else if (scheme.type === "boolean") {
            value = (deviceIndex + sequence + schemeIndex) % 2 === 0;
        } else {
            value = `stress-${deviceIndex}-${sequence}`;
        }
        return { schemeId: scheme.schemeId, value };
    });
}

async function closeClients(
    clients: StressClient[],
    counters: StressCounters,
    errors: string[],
): Promise<void> {
    const results = await Promise.all(clients.map(async (client) => {
        try {
            const closed = await net.close(client.fd);
            return { closed, error: closed ? undefined : `Close socket ${client.deviceId} gagal.` };
        } catch (error) {
            return { closed: false, error: `Close socket ${client.deviceId}: ${errorMessage(error)}` };
        }
    }));
    for (const result of results) {
        if (result.closed) continue;
        counters.cleanupFailures++;
        if (result.error) recordError(errors, result.error);
    }
}

async function printProgress(
    counters: StressCounters,
    elapsedSec: number,
    phase: "load" | "drain",
): Promise<void> {
    const elapsed = Math.max(0.001, elapsedSec);
    const delivery = summarizeDelivery(
        counters.packetsSent,
        counters.acceptedBatches,
        counters.nacks,
    );
    await std.println(
        `[${TAG}] phase=${phase} sent=${counters.packetsSent} ` +
        `(${(counters.packetsSent / elapsed).toFixed(1)} pkt/s), ` +
        `readings-sent=${counters.readingsSent}, ` +
        `ingest-observed=${counters.acceptedBatches} batches/${counters.acceptedReadings} readings ` +
        `(${delivery.ingestObservedPercent}%), ` +
        `unconfirmed~=${delivery.estimatedUnconfirmedBatches}, ` +
        `over-observed=${delivery.overObservedBatches}, ` +
        `NACK=${counters.nacks}, send-fail=${counters.sendFailures}, ` +
        `handshake-fail=${counters.handshakeFailures}, receiver-fail=${counters.receiverFailures}, ` +
        `cleanup-fail=${counters.cleanupFailures}`,
    );
}

async function printFinalSummary(
    outcome: string,
    elapsedSec: number,
    drain: DrainResult,
    delivery: ReturnType<typeof summarizeDelivery>,
    counters: StressCounters,
): Promise<void> {
    await std.println(
        `[${TAG}] FINAL outcome=${outcome}, load=${elapsedSec.toFixed(1)}s, ` +
        `drain=${drain.durationSec.toFixed(1)}s (${drain.reason}).`,
    );
    await std.println(
        `[${TAG}] sent=${delivery.sentBatches}, ` +
        `ingest-observed=${delivery.ingestObservedBatches} ` +
        `(${delivery.ingestObservedPercent}%), ` +
        `unconfirmed~=${delivery.estimatedUnconfirmedBatches}, NACK=${delivery.nacks}, ` +
        `over-observed=${delivery.overObservedBatches}, ` +
        `send-fail=${counters.sendFailures}, ` +
        `ingest-observed-readings=${counters.acceptedReadings}, ` +
        `receiver-fail=${counters.receiverFailures}, cleanup-fail=${counters.cleanupFailures}.`,
    );
}

async function reloadLantana(): Promise<void> {
    const lib = (globalThis as any)._tsixLib;
    if (typeof lib?.onEvent !== "function" || typeof lib?.offEvent !== "function") {
        throw new Error("API event IPC TSIX tidak tersedia untuk menunggu hasil reload.");
    }

    const pid = shell.getPid();
    const requestId = crypto.randomUUID();
    let resolveResponse!: (result: { ok: boolean; message?: string }) => void;
    const responsePromise = new Promise<{ ok: boolean; message?: string }>((resolve) => {
        resolveResponse = resolve;
    });
    const onIpcMessage = (message: unknown): void => {
        const payload = isRecord(message) && "data" in message ? message.data : message;
        if (
            !isRecord(payload) ||
            payload.type !== "LANTANA_RELOAD_RESULT" ||
            payload.requestId !== requestId
        ) return;
        resolveResponse({
            ok: payload.ok === true,
            message: typeof payload.message === "string" ? payload.message : undefined,
        });
    };

    lib.onEvent("ipc_message", onIpcMessage);
    const timeout = setTimeout(
        () => resolveResponse({ ok: false, message: "Timeout menunggu hasil LANTANA_RELOAD." }),
        10_000,
    );
    try {
        const sent = await shell.send(LANTANA_UUID, {
            type: "LANTANA_RELOAD",
            requestId,
            fromPid: pid,
        });
        if (!sent) throw new Error("Tidak bisa mengirim LANTANA_RELOAD ke daemon.");

        const result = await responsePromise;
        if (!result.ok) throw new Error(result.message || "Daemon gagal reload state.");
    } finally {
        clearTimeout(timeout);
        lib.offEvent("ipc_message", onIpcMessage);
    }
}

async function mapWithLimit<T, R>(
    items: T[],
    limit: number,
    task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const index = nextIndex++;
            if (index >= items.length) return;
            results[index] = await task(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

function integerOption(
    args: string[],
    name: string,
    fallback: number,
    min: number,
    max: number,
): number {
    const value = option(args, name, String(fallback))!;
    if (!/^\d+$/.test(value)) throw new Error(`--${name} harus berupa bilangan bulat.`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        throw new Error(`--${name} harus berada pada rentang ${min}..${max}.`);
    }
    return parsed;
}

function option(args: string[], name: string, fallback?: string): string | undefined {
    const prefix = `--${name}=`;
    const found = args.filter((arg) => arg.startsWith(prefix));
    if (found.length > 1) throw new Error(`Opsi --${name} hanya boleh dipakai sekali.`);
    return found.length ? found[0].slice(prefix.length) : fallback;
}

function parseSchemeIds(value: string): number[] {
    const items = value.split(",");
    if (items.length === 0 || items.length > LANTANA_STRESS_MAX_SCHEMES) {
        throw new Error(`Jumlah scheme harus 1..${LANTANA_STRESS_MAX_SCHEMES}.`);
    }
    const ids = items.map((item) => {
        if (!/^\d+$/.test(item)) throw new Error(`Scheme ID tidak valid: ${item}`);
        const id = Number(item);
        if (!Number.isSafeInteger(id) || id < 1 || id > 0xffff) {
            throw new Error(`Scheme ID di luar rentang: ${item}`);
        }
        return id;
    });
    if (new Set(ids).size !== ids.length) throw new Error("Daftar scheme mengandung duplikat.");
    return ids;
}

function allocateStressSchemeIds(
    isTaken: (schemeId: number) => boolean,
    count: number,
): number[] {
    const ids: number[] = [];
    let candidate = 60_000;
    for (let checked = 0; checked < 0xffff && ids.length < count; checked++) {
        if (!isTaken(candidate)) ids.push(candidate);
        candidate = candidate === 0xffff ? 1 : candidate + 1;
    }
    if (ids.length !== count) {
        throw new Error(`Tidak cukup ID scheme kosong untuk membuat ${count} scheme stress.`);
    }
    return ids;
}

function normalizeFingerprint(value: string): string {
    return value.replace(/[^0-9a-f]/gi, "").toLowerCase();
}

function handshakeTimeout(deadline: number): number {
    return Math.max(0, Math.min(HANDSHAKE_STAGE_TIMEOUT_MS, deadline - Date.now()));
}

function isLoopbackHost(host: string): boolean {
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function recordError(errors: string[], message: string): void {
    if (errors.length < 5) errors.push(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function usage(): string {
    return [
        "Usage:",
        "  lantana-stress setup <accountId> [--count=1000] [--groups=10] [--scheme-count=5]",
        "  lantana-stress run <manifest> --host=<test-host> --fingerprint=<hex> [--schemes=101,102]",
        "      [--port=1000] [--interval-ms=5000] [--duration-sec=60]",
        "      [--handshake-concurrency=20] [--handshake-timeout-sec=120]",
        "      [--drain-timeout-sec=30] [--plain] [--confirm-target]",
        "  lantana-stress cleanup <manifest> [--report=<report-json> ...]",
    ].join("\n");
}
