/**
 * Lantana portable dashboard MQTNL consumer.
 *
 * Usage: lantana-dashboard-server [port] [--fg]
 * Default MQTNL port: 1515.
 */

import * as crypto from "crypto";
import {
    Program,
    shell,
    std,
    NetSocket,
    type NetPacket,
} from "@tsix/Application";
import { SecurityAgent } from "@common/SecurityAgent";
import { loadState } from "@tsix/lantana/lantana-store";
import {
    EVT_SNAPSHOT_REPLY,
    LANTANA_UUID,
} from "@tsix/lantana/lantana-core";
import {
    dashboardClientProof,
    dashboardPsk,
    dashboardServerProof,
    deriveDashboardSessionKey,
    isDashboardKeyTag,
    isDashboardNonce,
} from "@tsix/lantana/lantana-dashboard-psk";
import { safeEqualHex } from "@tsix/lantana/lantana-psk";

const TAG = "lantana-dashboard-server";
const DEFAULT_PORT = 1515;
const MAX_SESSIONS = 128;
const SESSION_IDLE_MS = 48 * 60 * 60 * 1000;
const HANDSHAKE_IDLE_MS = 30_000;
const SNAPSHOT_TIMEOUT_MS = 15_000;
/** Key dashboard hanya 6 digit: batasi percobaan auth gagal per sumber. */
const AUTH_FAILURE_LIMIT = 5;
const AUTH_FAILURE_WINDOW_MS = 60_000;

interface DashboardSession {
    id: string;
    src: string;
    srcPort: number;
    dashboardId: string;
    agent: SecurityAgent | null;
    accountId?: string;
    accessKeyHash?: string;
    /** State handshake PSK sebelum AUTH berhasil. */
    psk?: {
        accountId: string;
        dashboardId: number;
        accessKeyHash: string;
        psk: Buffer;
        clientNonce: string;
        serverNonce: string;
        title: string;
        itemCount: number;
    };
    pendingRequestId?: string;
    lastSeen: number;
    lastSnapshotAt: number;
}

interface PendingSnapshot {
    sessionId: string;
    expiresAt: number;
}

/** Riwayat auth gagal per alamat sumber (dipakai untuk throttle). */
interface AuthFailureState {
    attempts: number[];
    blockedUntil: number;
}

export const main = Program(async (args: string[]) => {
    const portText = args.find((arg) => !arg.startsWith("--"));
    const port = portText ? Number(portText) : DEFAULT_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        await std.print(`Port tidak valid: ${portText}\n`);
        return;
    }

    if (!args.includes("--fg")) await shell.daemonize("Lantana Dashboard Server");

    const socket = new NetSocket({
        port,
        protocol: "JSON",
        // Daemon: jangan pasang handler SIGINT/SIGTERM otomatis.
        autoCleanup: false,
    });
    const sessions = new Map<string, DashboardSession>();
    const pending = new Map<string, PendingSnapshot>();
    const authFailures = new Map<string, AuthFailureState>();
    const lib = (global as any)._tsixLib;
    const selfPid = shell.getPid();

    lib.onEvent("ipc_message", async (msg: any) => {
        try {
            await handleSnapshotReply(socket, msg, sessions, pending);
        } catch (error: any) {
            await std.log(`[${TAG}] gagal menangani snapshot IPC: ${error?.message || error}`, TAG);
        }
    });

    // NetSocket sekarang meng-await onData, jadi urutan paket otomatis terjaga
    // tanpa queue manual.
    socket.onData = (packet) =>
        handlePacket(
            socket,
            packet,
            selfPid,
            sessions,
            pending,
            authFailures,
        ).catch(async (error: any) => {
            await std.log(
                `[${TAG}] paket dari ${packet.src}:${packet.port} ditolak: ${error?.message || error}`,
                TAG,
            );
        });
    socket.onError = (error) => {
        void std.log(`[${TAG}] socket error: ${error.message}`, TAG);
    };

    try {
        await socket.open();
    } catch (error: any) {
        await std.log(
            `[${TAG}] gagal bind port MQTNL ${port}: ${error?.message || error}`,
            TAG,
        );
        return;
    }

    await std.log(
        `mendengarkan MQTNL port ${socket.port ?? port} (handshake PSK)`,
        TAG,
    );

    setInterval(() => {
        cleanupExpired(socket, sessions, pending, authFailures).catch(
            async (error: any) => {
                await std.log(
                    `[${TAG}] cleanup gagal: ${error?.message || error}`,
                    TAG,
                );
            },
        );
    }, 1000);

    // Jaga proses daemon tetap hidup sampai socket ditutup.
    await socket.waitClosed();
});

async function cleanupExpired(
    socket: NetSocket,
    sessions: Map<string, DashboardSession>,
    pending: Map<string, PendingSnapshot>,
    authFailures: Map<string, AuthFailureState>,
): Promise<void> {
    const now = Date.now();
    for (const [src, state] of authFailures) {
        if (state.blockedUntil > now) continue;
        state.attempts = state.attempts.filter(
            (at) => now - at < AUTH_FAILURE_WINDOW_MS,
        );
        if (state.attempts.length === 0) authFailures.delete(src);
    }
    for (const [id, session] of sessions) {
        const timeout = session.accountId ? SESSION_IDLE_MS : HANDSHAKE_IDLE_MS;
        if (now - session.lastSeen > timeout) {
            if (session.pendingRequestId) pending.delete(session.pendingRequestId);
            sessions.delete(id);
        }
    }
    for (const [requestId, request] of pending) {
        if (now <= request.expiresAt) continue;
        pending.delete(requestId);
        const session = sessions.get(request.sessionId);
        if (session?.pendingRequestId === requestId) {
            session.pendingRequestId = undefined;
            await sendEncrypted(socket, session, {
                type: "LANTANA_DASH_ERROR",
                message: "Permintaan snapshot timeout",
            });
        }
    }
}

async function handlePacket(
    socket: NetSocket,
    packet: NetPacket,
    selfPid: number,
    sessions: Map<string, DashboardSession>,
    pending: Map<string, PendingSnapshot>,
    authFailures: Map<string, AuthFailureState>,
): Promise<void> {
    const src = typeof packet.src === "string" ? packet.src : "";
    const srcPort = Number(packet.port) || 0;
    if (!src || srcPort < 1 || srcPort > 65535) {
        throw new Error("endpoint MQTNL tidak valid");
    }

    const sessionId = `${src}:${srcPort}`;
    const text = Buffer.isBuffer(packet.data)
        ? packet.data.toString("utf8")
        : String(packet.data ?? "");
    if (!text || text.length > 32_768) {
        await sendPlain(socket, src, srcPort, {
            type: "LANTANA_DASH_NACK",
            message: "Payload kosong atau terlalu besar",
        });
        return;
    }

    const control = tryJson(text);
    if (control && typeof control.type === "string") {
        await handleControl(
            socket,
            control,
            sessionId,
            src,
            srcPort,
            sessions,
            authFailures,
        );
        return;
    }

    const session = sessions.get(sessionId);
    if (!session?.agent || !session.accountId) {
        await sendPlain(socket, src, srcPort, {
            type: "LANTANA_DASH_NACK",
            message: "Sesi dashboard belum terautentikasi",
        });
        return;
    }
    session.lastSeen = Date.now();

    const decoded = tryJson(session.agent.securePacketIn(text));
    if (decoded?.type !== "LANTANA_DASH_SNAPSHOT_REQ") {
        await sendEncrypted(socket, session, {
            type: "LANTANA_DASH_ERROR",
            message: "Permintaan tidak dikenal",
        });
        return;
    }
    if (session.pendingRequestId) {
        await sendEncrypted(socket, session, {
            type: "LANTANA_DASH_ERROR",
            message: "Permintaan snapshot sebelumnya masih diproses",
        });
        return;
    }

    const state = await loadState();
    const dashboard = state.dashboards.get(session.accountId, session.dashboardId);
    if (
        !dashboard?.accessKeyHash ||
        dashboard.accessKeyHash !== session.accessKeyHash ||
        String(dashboard.dashboardId) !== session.dashboardId
    ) {
        session.accountId = undefined;
        session.accessKeyHash = undefined;
        await sendEncrypted(socket, session, {
            type: "LANTANA_DASH_AUTH_REVOKED",
            message: "Dashboard key sudah dicabut atau dirotasi",
        });
        return;
    }

    const minInterval = dashboard.dashboardItems.length
        ? Math.min(...dashboard.dashboardItems.map((item) => item.updateInterval))
        : 60;
    if (Date.now() - session.lastSnapshotAt < Math.max(1000, minInterval * 1000)) {
        await sendEncrypted(socket, session, {
            type: "LANTANA_DASH_ERROR",
            message: "Permintaan terlalu cepat",
        });
        return;
    }

    const requestId = crypto.randomBytes(16).toString("hex");
    session.pendingRequestId = requestId;
    session.lastSnapshotAt = Date.now();
    pending.set(requestId, {
        sessionId,
        expiresAt: Date.now() + SNAPSHOT_TIMEOUT_MS,
    });

    const sent = await shell.send(LANTANA_UUID, {
        type: "LANTANA_SNAPSHOT",
        accountId: session.accountId,
        requestId,
        fromPid: selfPid,
    });
    if (!sent) {
        pending.delete(requestId);
        session.pendingRequestId = undefined;
        await sendEncrypted(socket, session, {
            type: "LANTANA_DASH_ERROR",
            message: "Lantana daemon tidak merespons",
        });
    }
}

async function handleControl(
    socket: NetSocket,
    message: any,
    sessionId: string,
    src: string,
    srcPort: number,
    sessions: Map<string, DashboardSession>,
    authFailures: Map<string, AuthFailureState>,
): Promise<void> {
    if (message.type === "LANTANA_DASH_HELLO") {
        if (message.mode !== undefined && message.mode !== "psk") {
            await sendPlain(socket, src, srcPort, {
                type: "LANTANA_DASH_NACK",
                message: "Mode handshake tidak didukung",
            });
            return;
        }
        // Client hanya tahu PIN 6 digit; keyTag = prefix SHA-256(PIN).
        const keyTag =
            typeof message.keyTag === "string" ? message.keyTag.trim().toLowerCase() : "";
        const clientNonce =
            typeof message.clientNonce === "string"
                ? message.clientNonce.trim().toLowerCase()
                : "";
        if (!isDashboardKeyTag(keyTag) || !isDashboardNonce(clientNonce)) {
            await sendPlain(socket, src, srcPort, {
                type: "LANTANA_DASH_NACK",
                message: "Handshake dashboard tidak valid",
            });
            return;
        }
        if (!sessions.has(sessionId) && sessions.size >= MAX_SESSIONS) {
            await sendPlain(socket, src, srcPort, {
                type: "LANTANA_DASH_NACK",
                message: "Server sedang penuh",
            });
            return;
        }

        const state = await loadState();
        const match = state.dashboards.findByKeyTag(keyTag);
        if (!match?.dashboard.accessKeyHash) {
            await sendPlain(socket, src, srcPort, {
                type: "LANTANA_DASH_NACK",
                message: "Handshake dashboard gagal",
            });
            return;
        }

        const serverNonce = crypto.randomBytes(16).toString("hex");
        const psk = dashboardPsk(match.dashboard.accessKeyHash);
        const session: DashboardSession = {
            id: sessionId,
            src,
            srcPort,
            dashboardId: "",
            agent: null,
            psk: {
                accountId: match.accountId,
                dashboardId: match.dashboard.dashboardId,
                accessKeyHash: match.dashboard.accessKeyHash,
                psk,
                clientNonce,
                serverNonce,
                title: match.dashboard.title,
                itemCount: match.dashboard.dashboardItems.length,
            },
            lastSeen: Date.now(),
            lastSnapshotAt: 0,
        };
        sessions.set(sessionId, session);
        await sendPlain(socket, src, srcPort, {
            type: "LANTANA_DASH_CHALLENGE",
            mode: "psk",
            serverNonce,
            serverProof: dashboardServerProof(psk, clientNonce, serverNonce),
        });
        return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
        await sendPlain(socket, src, srcPort, {
            type: "LANTANA_DASH_NACK",
            message: "Handshake dashboard belum dimulai",
        });
        return;
    }
    session.lastSeen = Date.now();

    if (message.type !== "LANTANA_DASH_AUTH") {
        await sendPlain(socket, src, srcPort, {
            type: "LANTANA_DASH_NACK",
            message: "Pesan handshake tidak dikenal",
        });
        return;
    }

    if (isAuthBlocked(authFailures, src)) {
        await sendPlain(socket, src, srcPort, {
            type: "LANTANA_DASH_AUTH_FAILED",
            message: "Terlalu banyak percobaan; coba lagi nanti",
        });
        return;
    }

    const pending = session.psk;
    const expected = pending
        ? dashboardClientProof(pending.psk, pending.clientNonce, pending.serverNonce)
        : "";
    const proof =
        typeof message.proof === "string" ? message.proof.trim().toLowerCase() : "";
    if (!pending || !expected || !safeEqualHex(proof, expected)) {
        recordAuthFailure(authFailures, src);
        sessions.delete(sessionId);
        await sendPlain(socket, src, srcPort, {
            type: "LANTANA_DASH_AUTH_FAILED",
            message: "Dashboard authentication gagal",
        });
        return;
    }

    clearAuthFailures(authFailures, src);
    const sessionKey = deriveDashboardSessionKey(
        pending.psk,
        pending.clientNonce,
        pending.serverNonce,
    );
    session.agent = new SecurityAgent();
    session.agent.setSessionKey(sessionKey);
    session.accountId = pending.accountId;
    session.accessKeyHash = pending.accessKeyHash;
    session.dashboardId = String(pending.dashboardId);
    session.psk = undefined;
    await sendEncrypted(socket, session, {
        type: "LANTANA_DASH_AUTH_OK",
        dashboardId: session.dashboardId,
        title: pending.title,
        itemCount: pending.itemCount,
    });
    await std.log(`[${TAG}] dashboard ${session.dashboardId} authenticated (psk)`, TAG);
}

async function handleSnapshotReply(
    socket: NetSocket,
    msg: any,
    sessions: Map<string, DashboardSession>,
    pending: Map<string, PendingSnapshot>,
): Promise<void> {
    const event = msg?.data?.type ? msg.data : msg;
    if (event?.type !== EVT_SNAPSHOT_REPLY) return;
    const data = event.data || {};
    const requestId = data.requestId;
    if (typeof requestId !== "string") return;

    const request = pending.get(requestId);
    if (!request) return;
    pending.delete(requestId);
    const session = sessions.get(request.sessionId);
    if (!session || session.pendingRequestId !== requestId || !session.agent || !session.accountId) return;
    session.pendingRequestId = undefined;
    session.lastSeen = Date.now();

    const state = await loadState();
    const dashboard = state.dashboards.get(session.accountId, session.dashboardId);
    if (
        !dashboard?.accessKeyHash ||
        dashboard.accessKeyHash !== session.accessKeyHash ||
        String(dashboard.dashboardId) !== session.dashboardId
    ) {
        session.accountId = undefined;
        session.accessKeyHash = undefined;
        await sendEncrypted(socket, session, {
            type: "LANTANA_DASH_AUTH_REVOKED",
            message: "Dashboard key sudah dicabut atau dirotasi",
        });
        return;
    }

    const devices = Array.isArray(data.devices) ? data.devices : [];
    const items = dashboard.dashboardItems.map((item, index) => {
        const entry = devices.find(
            (candidate: any) =>
                candidate.device?.accountId === session.accountId &&
                candidate.device?.deviceId === item.deviceId,
        );
        const reading = entry?.readings?.find(
            (candidate: any) => candidate.schemeId === item.schemeId,
        );
        const scheme = reading ? state.schemes.get(item.schemeId) : undefined;
        return {
            ...item,
            id: item.id ?? `${index}:${item.deviceId}:${item.schemeId}`,
            value: reading?.value ?? null,
            label: reading?.label ?? scheme?.label ?? item.title,
            unit: reading?.unit ?? scheme?.unit ?? "",
            updatedAt: reading?.receivedAt ?? reading?.ts ?? null,
            deviceStatus: entry?.device?.status ?? "UNKNOWN",
            min: scheme?.min ?? null,
            max: scheme?.max ?? null,
        };
    });

    await sendEncrypted(socket, session, {
        type: "LANTANA_DASH_SNAPSHOT",
        dashboardId: session.dashboardId,
        title: dashboard.title,
        items,
        timestamp: data.ts ?? Date.now(),
    });
}

function isAuthBlocked(
    failures: Map<string, AuthFailureState>,
    src: string,
    now: number = Date.now(),
): boolean {
    const state = failures.get(src);
    if (!state) return false;
    if (state.blockedUntil > now) return true;
    state.blockedUntil = 0;
    state.attempts = state.attempts.filter(
        (at) => now - at < AUTH_FAILURE_WINDOW_MS,
    );
    if (state.attempts.length === 0) failures.delete(src);
    return false;
}

function recordAuthFailure(
    failures: Map<string, AuthFailureState>,
    src: string,
    now: number = Date.now(),
): void {
    const state = failures.get(src) ?? { attempts: [], blockedUntil: 0 };
    state.attempts = state.attempts.filter(
        (at) => now - at < AUTH_FAILURE_WINDOW_MS,
    );
    state.attempts.push(now);
    if (state.attempts.length >= AUTH_FAILURE_LIMIT) {
        state.attempts = [];
        state.blockedUntil = now + AUTH_FAILURE_WINDOW_MS;
    }
    failures.set(src, state);
}

function clearAuthFailures(
    failures: Map<string, AuthFailureState>,
    src: string,
): void {
    failures.delete(src);
}

async function sendPlain(
    socket: NetSocket,
    address: string,
    port: number,
    value: unknown,
): Promise<void> {
    const sent = await socket.sendTo(address, port, JSON.stringify(value));
    if (!sent) {
        await std.log(
            `[${TAG}] gagal mengirim MQTNL control ke ${address}:${port}`,
            TAG,
        );
    }
}

async function sendEncrypted(
    socket: NetSocket,
    session: DashboardSession,
    value: unknown,
): Promise<void> {
    if (!session.agent) return;
    const payload = session.agent.securePacketOut(JSON.stringify(value));
    const sent = await socket.sendTo(session.src, session.srcPort, payload);
    if (!sent) {
        await std.log(
            `[${TAG}] gagal mengirim pesan terenkripsi ke ${session.src}:${session.srcPort}`,
            TAG,
        );
    }
}

function tryJson(value: string): any | null {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}
