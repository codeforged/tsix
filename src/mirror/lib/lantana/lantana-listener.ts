/**
 * lantana-listener.ts — Ingest MQTNL dengan sesi terautentikasi.
 *
 * Alur per device (semua di atas port layanan yang sama):
 *   1. LANTANA_HELLO      → server balas LANTANA_CHALLENGE (nonce + public key)
 *   2. LANTANA_KEYSET     → device kirim session key yang dibungkus RSA-OAEP
 *   3. LANTANA_AUTH       → (terenkripsi) accountId + deviceId + AccessKey
 *   4. payload sensor     → (terenkripsi) Lantana V2 frame/teks
 *
 * Keamanan bersifat PER SESI, bukan per port: banyak device dengan AccessKey
 * berbeda boleh memakai port layanan yang sama. Port hanya alamat routing.
 *
 * Tidak ada fallback plaintext: paket sensor tanpa sesi terautentikasi dibuang.
 *
 * (c) 2026 TSIX Project — Lantana
 */

import * as crypto from "crypto";
import { net, std } from "@tsix/Application";
import { SecurityAgent } from "@common/SecurityAgent";
import { AccountManager } from "@tsix/lantana/account-manager";
import { DeviceRegistry } from "@tsix/lantana/device-registry";
import { IngestPipeline } from "@tsix/lantana/lantana-ingest";
import { LantanaDistributor } from "@tsix/lantana/lantana-distributor";
import { DeviceBank } from "@tsix/lantana/lantana-device-bank";
import { DataBankQueue } from "@tsix/lantana/lantana-databank";
import { SessionManager } from "@tsix/lantana/session-manager";
import { loadConfig, enabledPorts } from "@tsix/lantana/lantana-config";
import { ServerKeyPair } from "@tsix/lantana/lantana-keys";
import {
    Endpoint,
    EVT_READING,
    LantanaError,
    MSG_AUTH,
    MSG_CHALLENGE,
    MSG_HELLO,
    MSG_KEYSET,
    NormalizedReadingBatch,
    errorName,
    parsePayload,
} from "@tsix/lantana/lantana-core";
import {
    clientProof,
    deriveSessionKey,
    safeEqualHex,
    serverProof,
} from "@tsix/lantana/lantana-psk";

const TAG = "lantana-listener";

const MSG_KEYSET_OK = "LANTANA_KEYSET_OK";
const MSG_AUTH_OK = "LANTANA_AUTH_OK";
const MSG_NACK = "LANTANA_NACK";

/** Jarak minimum NACK "sesi tidak aktif" per device agar tidak membanjiri link. */
const SESSION_NACK_INTERVAL_MS = 5000;

/** Panjang IV ChaCha20 di depan setiap ciphertext (format SecurityAgent). */
const PACKET_IV_BYTES = 12;
/**
 * Jumlah IV terakhir yang diingat per sesi untuk menolak paket duplikat/replay.
 * IV acak (tanpa urutan), jadi yang bisa dilakukan hanya jendela berbatas:
 * dengan interval kirim 5 detik, 4096 IV ≈ 5,7 jam riwayat per sesi.
 */
export const REPLAY_WINDOW = 4096;

/** Jendela IV per sesi: Set untuk lookup + antrean FIFO untuk eviksi. */
export class ReplayWindow {
    private seen = new Set<string>();
    private order: string[] = [];
    private head = 0;

    constructor(private capacity: number) {}

    /** true bila IV baru (dan langsung dicatat); false bila sudah pernah. */
    accept(id: string): boolean {
        if (this.seen.has(id)) return false;
        this.seen.add(id);
        this.order.push(id);
        if (this.order.length - this.head > this.capacity) {
            this.seen.delete(this.order[this.head++]);
            // Rapatkan sesekali agar array tidak tumbuh tanpa batas.
            if (this.head >= this.capacity) {
                this.order = this.order.slice(this.head);
                this.head = 0;
            }
        }
        return true;
    }
}

export interface ListenerDeps {
    accounts: AccountManager;
    devices: DeviceRegistry;
    sessions: SessionManager;
    ingest: IngestPipeline;
    bank: DeviceBank;
    dataBank: DataBankQueue;
    distributor: LantanaDistributor;
    serverKey: ServerKeyPair;
}

export class LantanaListener {
    private socketFds: Map<number, number> = new Map(); // port → fd
    private agents: Map<string, SecurityAgent> = new Map(); // sessionId → agent
    private warned: Set<string> = new Set();
    /** Waktu NACK terakhir per sesi (rate limit permintaan handshake ulang). */
    private nackSentAt: Map<string, number> = new Map();
    /** State handshake PSK per sesi (ESP8266 / device tanpa RSA). */
    /**
     * `accountId` dicatat saat HELLO karena PSK dipilih dari akun itu; AUTH
     * wajib memakai akun yang sama supaya sesi tidak bisa diikat ke akun lain.
     */
    private pskState: Map<
        string,
        { accountId: string; psk: Buffer; clientNonce: string; serverNonce: string }
    > = new Map();

    /** IV yang sudah diterima per sesi; direset setiap handshake baru. */
    private replay: Map<string, ReplayWindow> = new Map();
    /** Sesi yang sudah dicatat mengirim duplikat (log sekali per sesi). */
    private replayWarned: Set<string> = new Set();

    constructor(private deps: ListenerDeps) {}

    private sessionIdOf(src: string, srcPort: number): string {
        return `${src}:${srcPort}`;
    }

    async start(): Promise<boolean> {
        const config = await loadConfig();
        const ports = enabledPorts(config);

        for (const port of ports) {
            const fd = await net.socket();
            if (fd < 0) {
                await std.log(`[${TAG}] gagal membuat socket port ${port}`, TAG);
                continue;
            }
            if (!(await net.bind(fd, port))) {
                await std.log(`[${TAG}] gagal bind port ${port}`, TAG);
                continue;
            }
            this.socketFds.set(port, fd);
            await std.log(`[${TAG}] mendengarkan MQTNL port ${port}`, TAG);
        }

        if (this.socketFds.size === 0) {
            await std.log(`[${TAG}] tidak ada port aktif`, TAG);
            return false;
        }

        for (const [port, fd] of this.socketFds.entries()) {
            this.receiveLoop(port, fd).catch(async (e: any) => {
                await std.log(`[${TAG}] loop port ${port} berhenti: ${e?.message}`, TAG);
            });
        }

        await std.log(`[${TAG}] fingerprint server: ${this.deps.serverKey.fingerprint}`, TAG);
        return true;
    }

    private async receiveLoop(port: number, fd: number): Promise<void> {
        while (true) {
            const pkt = await net.recv(fd);
            if (pkt) {
                try {
                    await this.handlePacket(port, fd, pkt);
                } catch (e: any) {
                    await std.log(`[${TAG}] paket dari ${pkt.src}:${pkt.port} ditolak: ${e?.message}`, TAG);
                }
            }
            await new Promise((r) => setTimeout(r, 5));
        }
    }

    private async handlePacket(port: number, fd: number, pkt: any): Promise<void> {
        const src = pkt.src || "unknown";
        const srcPort = pkt.port || 0;
        const sessionId = this.sessionIdOf(src, srcPort);
        const endpoint: Endpoint = { address: src, port: srcPort };

        const session = this.deps.sessions.open(sessionId);
        const agent = this.agents.get(sessionId) || null;

        const control = this.asJson(pkt.data);
        if (control && typeof control.type === "string") {
            await this.handleControl(port, fd, sessionId, endpoint, control, agent);
            return;
        }

        if (!agent || !session.authenticated) {
            if (!this.warned.has(sessionId)) {
                this.warned.add(sessionId);
                await std.log(
                    `[${TAG}] data tanpa sesi terautentikasi dari ${sessionId} dibuang`,
                    TAG,
                );
            }
            await this.requestHandshake(fd, port, endpoint, sessionId);
            return;
        }

        await this.handleSensorPayload(fd, port, sessionId, endpoint, pkt.data, agent);
    }

    private async handleControl(
        port: number,
        fd: number,
        sessionId: string,
        endpoint: Endpoint,
        msg: any,
        agent: SecurityAgent | null,
    ): Promise<void> {
        const session = this.deps.sessions.open(sessionId);

        switch (msg.type) {
            case MSG_HELLO: {
                // Handshake baru selalu memulai sesi kripto baru; agent lama
                // dibuang agar key sebelumnya tidak bisa dipakai ulang.
                this.agents.delete(sessionId);
                this.pskState.delete(sessionId);
                // Key sesi baru → ciphertext lama tidak bisa didekripsi lagi,
                // jadi riwayat IV sesi sebelumnya tidak diperlukan.
                this.replay.delete(sessionId);
                this.replayWarned.delete(sessionId);

                const mode = msg.mode === "psk" ? "psk" : "rsa";
                const serverNonce = crypto.randomBytes(16).toString("hex");

                if (mode === "psk") {
                    const clientNonce = String(msg.clientNonce || "");
                    if (!/^[0-9a-f]{16,64}$/i.test(clientNonce)) {
                        await this.sendPlain(fd, port, endpoint, this.nack(
                            LantanaError.BAD_REQUEST,
                            "clientNonce (hex) wajib untuk mode psk",
                        ));
                        return;
                    }

                    // Akun belum tentu valid di tahap ini. Bila tidak dikenal,
                    // pakai PSK acak supaya balasan tidak membocorkan keberadaan akun.
                    const accountId = String(msg.accountId || "");
                    const psk =
                        this.deps.accounts.getPsk(accountId) ||
                        crypto.randomBytes(32);

                    this.pskState.set(sessionId, { accountId, psk, clientNonce, serverNonce });

                    await this.sendPlain(fd, port, endpoint, {
                        type: MSG_CHALLENGE,
                        mode: "psk",
                        nonce: serverNonce,
                        clientNonce,
                        serverProof: serverProof(psk, clientNonce, serverNonce),
                    });
                    return;
                }

                this.deps.sessions.setNonce(sessionId, serverNonce);
                await this.sendPlain(fd, port, endpoint, {
                    type: MSG_CHALLENGE,
                    mode: "rsa",
                    nonce: serverNonce,
                    publicKey: this.deps.serverKey.publicKey,
                    fingerprint: this.deps.serverKey.fingerprint,
                });
                return;
            }

            case MSG_KEYSET: {
                if (!session.nonce) {
                    await this.sendPlain(fd, port, endpoint, this.nack(
                        LantanaError.UNAUTHENTICATED,
                        "hello belum dikirim",
                    ));
                    return;
                }
                const encryptedKeyHex = msg.encryptedKey;
                if (typeof encryptedKeyHex !== "string" || !encryptedKeyHex) {
                    await this.sendPlain(fd, port, endpoint, this.nack(
                        LantanaError.BAD_REQUEST,
                        "encryptedKey wajib diisi",
                    ));
                    return;
                }

                let sessionKey: Buffer;
                try {
                    sessionKey = SecurityAgent.decryptWithPrivateKey(
                        this.deps.serverKey.privateKey,
                        encryptedKeyHex,
                    );
                } catch {
                    await this.sendPlain(fd, port, endpoint, this.nack(
                        LantanaError.UNAUTHENTICATED,
                        "session key tidak bisa didekripsi",
                    ));
                    return;
                }
                if (sessionKey.length !== 32) {
                    await this.sendPlain(fd, port, endpoint, this.nack(
                        LantanaError.BAD_REQUEST,
                        "session key harus 32 byte",
                    ));
                    return;
                }

                const newAgent = new SecurityAgent();
                newAgent.setSessionKey(sessionKey);
                this.agents.set(sessionId, newAgent);
                await this.sendPlain(fd, port, endpoint, { type: MSG_KEYSET_OK });
                return;
            }

            case MSG_AUTH: {
                // ── Jalur PSK: proof HMAC, tanpa RSA ──
                if (msg.mode === "psk" || (!agent && this.pskState.has(sessionId))) {
                    const state = this.pskState.get(sessionId);
                    if (!state) {
                        await this.sendPlain(fd, port, endpoint, this.nack(
                            LantanaError.UNAUTHENTICATED,
                            "challenge psk belum dilakukan",
                        ));
                        return;
                    }

                    const expect = clientProof(state.psk, state.clientNonce, state.serverNonce);
                    if (!safeEqualHex(String(msg.proof || ""), expect)) {
                        this.pskState.delete(sessionId);
                        await this.sendPlain(fd, port, endpoint, this.nack(
                            LantanaError.UNAUTHENTICATED,
                            "proof klien tidak cocok",
                        ));
                        return;
                    }

                    // Proof hanya membuktikan kepemilikan PSK akun dari HELLO.
                    // Akun di AUTH harus sama; jika tidak, pemegang key akun A
                    // bisa mengikat sesi ke device milik akun B.
                    const accountId = String(msg.accountId || "");
                    const deviceId = String(msg.deviceId || "");
                    if (!accountId || accountId !== state.accountId) {
                        this.pskState.delete(sessionId);
                        await this.sendPlain(fd, port, endpoint, this.nack(
                            LantanaError.UNAUTHENTICATED,
                            "accountId tidak cocok dengan hello",
                        ));
                        return;
                    }
                    if (!this.deps.accounts.getPsk(accountId)) {
                        this.pskState.delete(sessionId);
                        await this.sendPlain(fd, port, endpoint, this.nack(
                            LantanaError.UNAUTHENTICATED,
                            "accountId tidak dikenal",
                        ));
                        return;
                    }
                    if (!this.deps.devices.belongsTo(accountId, deviceId)) {
                        this.pskState.delete(sessionId);
                        await this.sendPlain(fd, port, endpoint, this.nack(
                            LantanaError.UNKNOWN_DEVICE,
                            "device tidak terdaftar pada akun",
                        ));
                        return;
                    }

                    const sessionKey = deriveSessionKey(
                        state.psk,
                        state.clientNonce,
                        state.serverNonce,
                    );
                    const pskAgent = new SecurityAgent();
                    pskAgent.setSessionKey(sessionKey);
                    this.agents.set(sessionId, pskAgent);
                    this.pskState.delete(sessionId);

                    this.deps.sessions.bind(sessionId, accountId, deviceId);
                    this.warned.delete(sessionId);
                    await this.sendEncrypted(fd, port, endpoint, pskAgent, { type: MSG_AUTH_OK });
                    await std.log(
                        `[${TAG}] sesi terautentikasi (psk): ${accountId}/${deviceId} (${sessionId})`,
                        TAG,
                    );
                    return;
                }

                if (!agent) {
                    await this.sendPlain(fd, port, endpoint, this.nack(
                        LantanaError.UNAUTHENTICATED,
                        "keyset belum dilakukan",
                    ));
                    return;
                }

                const plain = agent.securePacketIn(String(msg.payload || ""));
                if (!plain) {
                    await this.sendNack(fd, port, endpoint, agent, LantanaError.UNAUTHENTICATED, "payload auth tidak bisa didekripsi");
                    return;
                }

                let auth: any;
                try {
                    auth = JSON.parse(plain);
                } catch {
                    await this.sendNack(fd, port, endpoint, agent, LantanaError.BAD_REQUEST, "payload auth bukan JSON");
                    return;
                }

                if (auth.nonce !== session.nonce) {
                    await this.sendNack(fd, port, endpoint, agent, LantanaError.UNAUTHENTICATED, "nonce tidak cocok");
                    return;
                }

                const accountId = String(auth.accountId || "");
                const deviceId = String(auth.deviceId || "");
                const accessKey = String(auth.accessKey || "");

                if (!this.deps.accounts.verifyAccessKey(accountId, accessKey)) {
                    await this.sendNack(fd, port, endpoint, agent, LantanaError.UNAUTHENTICATED, "accountId/AccessKey tidak cocok");
                    return;
                }
                if (!this.deps.devices.belongsTo(accountId, deviceId)) {
                    await this.sendNack(fd, port, endpoint, agent, LantanaError.UNKNOWN_DEVICE, "device tidak terdaftar pada akun");
                    return;
                }

                this.deps.sessions.bind(sessionId, accountId, deviceId);
                this.warned.delete(sessionId);
                await this.sendEncrypted(fd, port, endpoint, agent, { type: MSG_AUTH_OK });
                await std.log(`[${TAG}] sesi terautentikasi: ${accountId}/${deviceId} (${sessionId})`, TAG);
                return;
            }

            default:
                // Pesan kontrol tak dikenal dari sesi belum tentu berbahaya;
                // abaikan tanpa membocorkan detail.
                return;
        }
    }

    private async handleSensorPayload(
        fd: number,
        port: number,
        sessionId: string,
        endpoint: Endpoint,
        data: any,
        agent: SecurityAgent,
    ): Promise<void> {
        // Device mengirim ciphertext sebagai Buffer mentah atau hex. Hex WAJIB
        // didekode ke Buffer dulu: frame biner mengandung byte >= 0x80 yang
        // rusak bila dikonversi ke utf8 (gejala: "tipe bacaan tidak dikenal: 0x66").
        // Decoding hex Node berhenti di karakter non-hex pertama, sama seperti
        // SecurityAgent.securePacketIn, sehingga IV yang dicek di bawah selalu
        // IV dari byte yang benar-benar didekripsi.
        let cipher: Buffer | null = null;
        if (Buffer.isBuffer(data)) cipher = data;
        else if (typeof data === "string") cipher = Buffer.from(data.trim(), "hex");

        const plain = cipher ? agent.securePacketInRawBuffer(cipher) : null;
        if (!cipher || !plain) {
            await this.sendNack(fd, port, endpoint, agent, LantanaError.UNAUTHENTICATED, "payload tidak bisa didekripsi");
            return;
        }

        // Dekripsi sukses berarti tag Poly1305 valid → IV berasal dari pemegang
        // key sesi, jadi aman dipakai sebagai ID paket. Duplikat (retransmit
        // broker atau replay penyadap) dibuang diam-diam: NACK akan memaksa
        // device yang sah me-restart sesinya.
        const packetId = cipher.subarray(0, PACKET_IV_BYTES).toString("hex");
        let window = this.replay.get(sessionId);
        if (!window) {
            window = new ReplayWindow(REPLAY_WINDOW);
            this.replay.set(sessionId, window);
        }
        if (!window.accept(packetId)) {
            if (!this.replayWarned.has(sessionId)) {
                this.replayWarned.add(sessionId);
                await std.log(`[${TAG}] paket duplikat/replay dari ${sessionId} dibuang`, TAG);
            }
            return;
        }

        const parsed = this.parseDecrypted(plain);
        if (!parsed.ok) {
            await this.sendNack(fd, port, endpoint, agent, parsed.error, parsed.message);
            return;
        }

        const result = this.deps.ingest.ingest({
            sessionId,
            deviceId: parsed.deviceId,
            readings: parsed.readings,
            endpoint,
            packetId,
        });

        if (!result.ok) {
            await this.sendNack(fd, port, endpoint, agent, result.error, result.message);
            return;
        }

        const queued = await this.deps.dataBank.submit(result.readings);
        if (!queued.ok) {
            await std.log(
                `[${TAG}] DataBank menolak ${result.readings.length} bacaan (${queued.error}) — antrean ${this.deps.dataBank.pending}`,
                TAG,
            );
            await this.sendNack(
                fd,
                port,
                endpoint,
                agent,
                LantanaError.DATABANK_UNAVAILABLE,
                "DataBank tidak dapat menerima bacaan saat ini",
            );
            return;
        }

        const device = this.deps.devices.get(result.accountId, result.deviceId);
        const meta = device?.meta || {};
        const entry = this.deps.bank.upsert(
            result.accountId,
            result.deviceId,
            meta,
            result.readings,
            endpoint,
        );

        const batch: NormalizedReadingBatch = {
            type: EVT_READING,
            accountId: result.accountId,
            deviceId: result.deviceId,
            name: entry.meta.name || result.deviceId,
            category: entry.meta.category || "generic",
            group: entry.meta.group,
            city: entry.meta.city,
            receivedAt: result.readings[0]?.receivedAt || Date.now(),
            dataAgeMs: 0,
            deviceStatus: "ONLINE",
            readings: result.readings.map((r) => ({
                readingId: r.readingId,
                schemeId: r.schemeId,
                value: r.value,
                label: r.label,
                unit: r.unit,
                ts: r.receivedAt,
            })),
        };
        await this.deps.distributor.broadcastBatch(batch);
    }

    /** Payload bisa berupa frame biner V2 atau teks LANTANA|... */
    private parseDecrypted(plain: Buffer) {
        const asText = plain.toString("utf8");
        if (asText.startsWith("LANTANA|")) {
            return parsePayload(asText);
        }
        return parsePayload(plain);
    }

    private asJson(data: any): any | null {
        if (typeof data === "string") {
            const s = data.trim();
            if (!s.startsWith("{")) return null;
            try {
                const parsed = JSON.parse(s);
                return parsed && typeof parsed === "object" ? parsed : null;
            } catch {
                return null;
            }
        }
        if (data && typeof data === "object" && !Buffer.isBuffer(data) && typeof (data as any).type === "string") {
            return data;
        }
        return null;
    }

    /**
     * Minta device mengulang handshake setelah sesinya hilang (server restart,
     * port sumber berubah, atau TTL habis). Dikirim plaintext karena device
     * tidak mungkin membaca pesan terenkripsi dengan kunci sesi lama.
     */
    private async requestHandshake(
        fd: number,
        port: number,
        to: Endpoint,
        sessionId: string,
    ): Promise<void> {
        const now = Date.now();
        const last = this.nackSentAt.get(sessionId) ?? 0;
        if (now - last < SESSION_NACK_INTERVAL_MS) return;
        this.nackSentAt.set(sessionId, now);
        await this.sendPlain(fd, port, to, this.nack(
            LantanaError.UNAUTHENTICATED,
            "sesi tidak aktif — kirim LANTANA_HELLO",
        ));
    }

    private nack(error: LantanaError, message: string) {
        return { type: MSG_NACK, code: error, name: errorName(error), message };
    }

    private async sendPlain(fd: number, port: number, to: Endpoint, payload: unknown): Promise<void> {
        await net.sendto(fd, to.address, to.port, JSON.stringify(payload), 0, port);
    }

    private async sendEncrypted(
        fd: number,
        port: number,
        to: Endpoint,
        agent: SecurityAgent,
        payload: unknown,
    ): Promise<void> {
        const encrypted = agent.securePacketOut(JSON.stringify(payload));
        await net.sendto(fd, to.address, to.port, encrypted, 0, port);
    }

    private async sendNack(
        fd: number,
        port: number,
        to: Endpoint,
        agent: SecurityAgent,
        error: LantanaError,
        message: string,
    ): Promise<void> {
        await this.sendEncrypted(fd, port, to, agent, this.nack(error, message));
    }

    /**
     * Kirim command ke device. Payload dienkripsi dengan session key device
     * sehingga hanya device dengan sesi aktif yang bisa menerimanya.
     */
    async sendCommand(
        accountId: string,
        deviceId: string,
        endpoint: Endpoint,
        command: string,
    ): Promise<boolean> {
        const sessionId = this.sessionIdOf(endpoint.address, endpoint.port);
        const agent = this.agents.get(sessionId);
        const session = this.deps.sessions.get(sessionId);

        if (!agent || !session?.authenticated) {
            await std.log(`[${TAG}] command ke ${deviceId} gagal: sesi tidak aktif`, TAG);
            return false;
        }
        if (session.accountId !== accountId || session.deviceId !== deviceId) {
            await std.log(`[${TAG}] command ke ${deviceId} gagal: sesi bukan milik device itu`, TAG);
            return false;
        }

        const payload = agent.securePacketOut(command);

        for (const [port, fd] of this.socketFds.entries()) {
            try {
                const ok = await net.sendto(fd, endpoint.address, endpoint.port, payload, 0, port);
                if (ok) {
                    await std.log(
                        `[${TAG}] command "${command}" → ${deviceId} (${endpoint.address}:${endpoint.port})`,
                        TAG,
                    );
                    return true;
                }
            } catch {
                /* coba port lain */
            }
        }
        return false;
    }
}
