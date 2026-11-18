/**
 * Lantana portable dashboard MQTNL consumer.
 *
 * Usage: lantana-dashboard-server [port] [--fg]
 * Default MQTNL port: 1001.
 */

import * as crypto from "crypto";
import { Program, net, shell, std } from "@tsix/Application";
import { SecurityAgent } from "@common/SecurityAgent";
import { loadOrCreateServerKey } from "@tsix/lantana/lantana-keys";
import { loadState } from "@tsix/lantana/lantana-store";
import {
    EVT_SNAPSHOT_REPLY,
    LANTANA_UUID,
} from "@tsix/lantana/lantana-core";

const TAG = "lantana-dashboard-server";
const DEFAULT_PORT = 1001;
const MAX_SESSIONS = 128;
const SESSION_IDLE_MS = 48 * 60 * 60 * 1000;
const HANDSHAKE_IDLE_MS = 30_000;
const SNAPSHOT_TIMEOUT_MS = 15_000;

interface DashboardSession {
    id: string;
    fd: number;
    src: string;
    srcPort: number;
    localPort: number;
    dashboardId: string;
    nonce: string;
    agent: SecurityAgent | null;
    accountId?: string;
    accessKeyHash?: string;
    pendingRequestId?: string;
    lastSeen: number;
    lastSnapshotAt: number;
}

interface PendingSnapshot {
    sessionId: string;
    expiresAt: number;
}

export const main = Program(async (args: string[]) => {
    const portText = args.find((arg) => !arg.startsWith("--"));
    const port = portText ? Number(portText) : DEFAULT_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        await std.print(`Port tidak valid: ${portText}\n`);
        return;
    }

    if (!args.includes("--fg")) await shell.daemonize("Lantana Dashboard Server");

    const fd = await net.socket();
    if (fd < 0 || !(await net.bind(fd, port))) {
        await std.log(`[${TAG}] gagal bind port MQTNL ${port}`, TAG);
        return;
    }

    const serverKey = await loadOrCreateServerKey();
    const sessions = new Map<string, DashboardSession>();
    const pending = new Map<string, PendingSnapshot>();
    const lib = (global as any)._tsixLib;
    const selfPid = shell.getPid();

    lib.onEvent("ipc_message", async (msg: any) => {
        try {
            await handleSnapshotReply(msg, sessions, pending);
        } catch (error: any) {
            await std.log(`[${TAG}] gagal menangani snapshot IPC: ${error?.message || error}`, TAG);
        }
    });

    await std.log(
        `mendengarkan MQTNL port ${port}; fingerprint ${serverKey.fingerprint}`,
        TAG,
    );

    setInterval(() => {
        cleanupExpired(sessions, pending).catch(async (error: any) => {
            await std.log(`[${TAG}] cleanup gagal: ${error?.message || error}`, TAG);
        });
    }, 1000);

    while (true) {
        const packet = await net.recv(fd);
        if (packet) {
            try {
                await handlePacket(packet, fd, port, selfPid, serverKey, sessions, pending);
            } catch (error: any) {
                await std.log(
                    `[${TAG}] paket dari ${packet.src}:${packet.port} ditolak: ${error?.message || error}`,
                    TAG,
                );
            }
        }
    }
});

async function cleanupExpired(
    sessions: Map<string, DashboardSession>,
    pending: Map<string, PendingSnapshot>,
): Promise<void> {
    const now = Date.now();
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
            await sendEncrypted(session, {
                type: "LANTANA_DASH_ERROR",
                message: "Permintaan snapshot timeout",
            });
        }
    }
}

async function handlePacket(
    packet: any,
    fd: number,
    port: number,
    selfPid: number,
    serverKey: Awaited<ReturnType<typeof loadOrCreateServerKey>>,
    sessions: Map<string, DashboardSession>,
    pending: Map<string, PendingSnapshot>,
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
        await sendPlain(fd, src, srcPort, Number(packet.localPort) || port, {
            type: "LANTANA_DASH_NACK",
            message: "Payload kosong atau terlalu besar",
        });
        return;
    }

    const control = tryJson(text);
    if (control && typeof control.type === "string") {
        await handleControl(
            control,
            sessionId,
            src,
            srcPort,
            Number(packet.localPort) || port,
            fd,
            serverKey,
            sessions,
        );
        return;
    }

    const session = sessions.get(sessionId);
    if (!session?.agent || !session.accountId) {
        await sendPlain(fd, src, srcPort, Number(packet.localPort) || port, {
            type: "LANTANA_DASH_NACK",
            message: "Sesi dashboard belum terautentikasi",
        });
        return;
    }
    session.lastSeen = Date.now();

    const decoded = tryJson(session.agent.securePacketIn(text));
    if (decoded?.type !== "LANTANA_DASH_SNAPSHOT_REQ") {
        await sendEncrypted(session, {
            type: "LANTANA_DASH_ERROR",
            message: "Permintaan tidak dikenal",
        });
        return;
    }
    if (session.pendingRequestId) {
        await sendEncrypted(session, {
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
        await sendEncrypted(session, {
            type: "LANTANA_DASH_AUTH_REVOKED",
            message: "Dashboard key sudah dicabut atau dirotasi",
        });
        return;
    }

    const minInterval = dashboard.dashboardItems.length
        ? Math.min(...dashboard.dashboardItems.map((item) => item.updateInterval))
        : 60;
    if (Date.now() - session.lastSnapshotAt < Math.max(1000, minInterval * 1000)) {
        await sendEncrypted(session, {
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
        await sendEncrypted(session, {
            type: "LANTANA_DASH_ERROR",
            message: "Lantana daemon tidak merespons",
        });
    }
}

async function handleControl(
    message: any,
    sessionId: string,
    src: string,
    srcPort: number,
    localPort: number,
    fd: number,
    serverKey: Awaited<ReturnType<typeof loadOrCreateServerKey>>,
    sessions: Map<string, DashboardSession>,
): Promise<void> {
    if (message.type === "LANTANA_DASH_HELLO") {
        const dashboardId =
            typeof message.dashboardId === "string" || typeof message.dashboardId === "number"
                ? String(message.dashboardId)
                : "";
        if (!dashboardId || dashboardId.length > 64) {
            await sendPlain(fd, src, srcPort, localPort, {
                type: "LANTANA_DASH_NACK",
                message: "dashboardId tidak valid",
            });
            return;
        }
        if (!sessions.has(sessionId) && sessions.size >= MAX_SESSIONS) {
            await sendPlain(fd, src, srcPort, localPort, {
                type: "LANTANA_DASH_NACK",
                message: "Server sedang penuh",
            });
            return;
        }

        const session: DashboardSession = {
            id: sessionId,
            fd,
            src,
            srcPort,
            localPort,
            dashboardId,
            nonce: crypto.randomBytes(16).toString("hex"),
            agent: null,
            lastSeen: Date.now(),
            lastSnapshotAt: 0,
        };
        sessions.set(sessionId, session);
        await sendPlain(fd, src, srcPort, localPort, {
            type: "LANTANA_DASH_CHALLENGE",
            dashboardId,
            nonce: session.nonce,
            publicKey: serverKey.publicKey,
            fingerprint: serverKey.fingerprint,
        });
        return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
        await sendPlain(fd, src, srcPort, localPort, {
            type: "LANTANA_DASH_NACK",
            message: "Handshake dashboard belum dimulai",
        });
        return;
    }
    session.lastSeen = Date.now();

    if (message.type === "LANTANA_DASH_KEYSET") {
        if (session.agent || typeof message.encryptedKey !== "string") {
            await sendPlain(fd, src, srcPort, localPort, {
                type: "LANTANA_DASH_NACK",
                message: "Key exchange tidak valid",
            });
            return;
        }
        try {
            const key = SecurityAgent.decryptWithPrivateKey(
                serverKey.privateKey,
                message.encryptedKey,
            );
            if (key.length !== 32) throw new Error("session key length must be 32 bytes");
            session.agent = new SecurityAgent();
            session.agent.setSessionKey(key);
            await sendPlain(fd, src, srcPort, localPort, { type: "LANTANA_DASH_KEYSET_OK" });
        } catch {
            await sendPlain(fd, src, srcPort, localPort, {
                type: "LANTANA_DASH_NACK",
                message: "Key exchange gagal",
            });
        }
        return;
    }

    if (message.type !== "LANTANA_DASH_AUTH" || !session.agent) {
        await sendPlain(fd, src, srcPort, localPort, {
            type: "LANTANA_DASH_NACK",
            message: "Pesan handshake tidak dikenal",
        });
        return;
    }
    if (typeof message.payload !== "string" || message.payload.length > 4096) {
        await sendEncrypted(session, {
            type: "LANTANA_DASH_AUTH_FAILED",
            message: "Dashboard authentication gagal",
        });
        return;
    }

    const auth = tryJson(session.agent.securePacketIn(message.payload));
    if (
        !auth ||
        String(auth.dashboardId) !== session.dashboardId ||
        auth.nonce !== session.nonce ||
        typeof auth.proof !== "string"
    ) {
        await sendEncrypted(session, {
            type: "LANTANA_DASH_AUTH_FAILED",
            message: "Dashboard authentication gagal",
        });
        return;
    }

    const state = await loadState();
    const match = state.dashboards.verifyProof(session.dashboardId, session.nonce, auth.proof);
    if (!match?.dashboard.accessKeyHash) {
        await sendEncrypted(session, {
            type: "LANTANA_DASH_AUTH_FAILED",
            message: "Dashboard authentication gagal",
        });
        return;
    }

    session.accountId = match.accountId;
    session.accessKeyHash = match.dashboard.accessKeyHash;
    session.nonce = "";
    await sendEncrypted(session, {
        type: "LANTANA_DASH_AUTH_OK",
        dashboardId: session.dashboardId,
        title: match.dashboard.title,
        itemCount: match.dashboard.dashboardItems.length,
    });
    await std.log(`[${TAG}] dashboard ${session.dashboardId} authenticated`, TAG);
}

async function handleSnapshotReply(
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
        await sendEncrypted(session, {
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

    await sendEncrypted(session, {
        type: "LANTANA_DASH_SNAPSHOT",
        dashboardId: session.dashboardId,
        title: dashboard.title,
        items,
        timestamp: data.ts ?? Date.now(),
    });
}

async function sendPlain(
    fd: number,
    address: string,
    port: number,
    localPort: number,
    value: unknown,
): Promise<void> {
    const sent = await net.sendto(fd, address, port, JSON.stringify(value), 0, localPort);
    if (!sent) await std.log(`[${TAG}] gagal mengirim MQTNL control ke ${address}:${port}`, TAG);
}

async function sendEncrypted(session: DashboardSession, value: unknown): Promise<void> {
    if (!session.agent) return;
    const payload = session.agent.securePacketOut(JSON.stringify(value));
    const sent = await net.sendto(
        session.fd,
        session.src,
        session.srcPort,
        payload,
        0,
        session.localPort,
    );
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
