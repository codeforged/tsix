/**
 * lantana-listener.test.ts — Handshake dan ingest lewat jalur listener asli.
 *
 * `net` diganti implementasi in-memory supaya alur kripto (RSA-OAEP + ChaCha20)
 * benar-benar dijalankan, bukan dimock.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { SecurityAgent } from "@common/SecurityAgent";

interface SentPacket {
    fd: number;
    address: string;
    port: number;
    data: any;
    srcPort: number;
}

const sent: SentPacket[] = [];

vi.mock("@tsix/Application", () => {
    const net = {
        socket: async () => 1,
        bind: async () => true,
        recv: async () => null,
        sendto: async (fd: number, address: string, port: number, data: any, _flags: number, srcPort: number) => {
            sent.push({ fd, address, port, data, srcPort });
            return true;
        },
        ioctl: async () => true,
    };
    return {
        net,
        std: {
            log: async () => true,
            print: async () => true,
            println: async () => true,
        },
        NetworkLib: {},
    };
});

import { AccountManager } from "./account-manager";
import { DeviceRegistry } from "./device-registry";
import { SchemeRegistry } from "./scheme-registry";
import { PermissionPolicy } from "./permission-policy";
import { SessionManager } from "./session-manager";
import { IngestPipeline } from "./lantana-ingest";
import { DeviceBank } from "./lantana-device-bank";
import { LantanaDistributor } from "./lantana-distributor";
import { DataBankQueue, MemoryDataBank } from "./lantana-databank";
import { LantanaListener, ReplayWindow } from "./lantana-listener";
import { ServerKeyPair } from "./lantana-keys";
import { encodeBinaryPayload, encodePlainPayload } from "./lantana-core";
import { packetReadingId } from "./lantana-ingest";
import { clientProof, derivePsk, deriveSessionKey, serverProof } from "./lantana-psk";

const SERVICE_PORT = 1000;
const DEVICE_ADDR = "10.0.0.9";
const DEVICE_PORT = 41000;

function setup(dataBankCapacity = 4096) {
    sent.length = 0;

    const accounts = new AccountManager();
    accounts.createRoot("juragan");
    const accessKey = accounts.issueAccessKey("juragan");

    const devices = new DeviceRegistry();
    const device = devices.register("juragan", { name: "Sensor A", city: "Bandung" });

    const schemes = new SchemeRegistry();
    schemes.add({ schemeId: 101, ownerAccountId: "juragan", label: "Suhu", unit: "°C", type: "number", min: -40, max: 125 });
    schemes.add({ schemeId: 102, ownerAccountId: "juragan", label: "Kelembapan", unit: "%", type: "number", min: 0, max: 100 });

    const policy = new PermissionPolicy(accounts, schemes);
    const sessions = new SessionManager();
    const ingest = new IngestPipeline({ accounts, devices, schemes, policy, sessions });
    const bank = new DeviceBank();
    const distributor = new LantanaDistributor(bank, policy);
    const dataBank = new DataBankQueue(new MemoryDataBank(), { capacity: dataBankCapacity });

    const pair = SecurityAgent.generateKeyPair();
    const serverKey: ServerKeyPair = {
        ...pair,
        fingerprint: SecurityAgent.getFingerprint(pair.publicKey),
    };

    const listener = new LantanaListener({
        accounts,
        devices,
        sessions,
        ingest,
        bank,
        dataBank,
        distributor,
        serverKey,
    });

    const send = (data: any) =>
        (listener as any).handlePacket(SERVICE_PORT, 1, {
            src: DEVICE_ADDR,
            port: DEVICE_PORT,
            data,
        });

    return { listener, send, accessKey, device, bank, dataBank, serverKey, sessions };
}

function lastSent(): any {
    return sent[sent.length - 1]?.data;
}

describe("listener handshake + ingest", () => {
    let ctx: ReturnType<typeof setup>;

    beforeEach(() => {
        ctx = setup();
    });

    it("menolak data sensor sebelum sesi terautentikasi", async () => {
        await ctx.send(encodePlainPayload(ctx.device.deviceId, [{ schemeId: 101, value: 25 }]));
        expect(ctx.bank.size).toBe(0);
        // Device diminta handshake ulang lewat NACK plaintext (sesi server hilang).
        expect(JSON.parse(lastSent())).toMatchObject({
            type: "LANTANA_NACK",
            name: "UNAUTHENTICATED",
        });
    });

    it("meminta handshake ulang saat port sumber device berubah", async () => {
        // Sesi lama hidup di port DEVICE_PORT; device reconnect memakai port baru.
        await ctx.send(JSON.stringify({ type: "LANTANA_HELLO" }));
        const challenge = JSON.parse(lastSent());
        const client = new SecurityAgent();
        const sessionKey = SecurityAgent.generateSessionKey();
        await ctx.send(
            JSON.stringify({
                type: "LANTANA_KEYSET",
                encryptedKey: SecurityAgent.encryptWithPublicKey(challenge.publicKey, sessionKey),
            }),
        );
        client.setSessionKey(sessionKey);
        await ctx.send(
            JSON.stringify({
                type: "LANTANA_AUTH",
                payload: client.securePacketOut(
                    JSON.stringify({
                        accountId: "juragan",
                        deviceId: ctx.device.deviceId,
                        accessKey: ctx.accessKey,
                        nonce: challenge.nonce,
                    }),
                ),
            }),
        );
        sent.length = 0;

        await (ctx.listener as any).handlePacket(SERVICE_PORT, 1, {
            src: DEVICE_ADDR,
            port: DEVICE_PORT + 1,
            data: client.securePacketOut(
                encodePlainPayload(ctx.device.deviceId, [{ schemeId: 101, value: 31 }]),
            ),
        });

        expect(JSON.parse(lastSent())).toMatchObject({
            type: "LANTANA_NACK",
            name: "UNAUTHENTICATED",
        });
        expect(ctx.bank.size).toBe(0);
    });

    it("membatasi NACK handshake ulang per device", async () => {
        const payload = encodePlainPayload(ctx.device.deviceId, [{ schemeId: 101, value: 25 }]);

        await ctx.send(payload);
        await ctx.send(payload);
        await ctx.send(payload);

        expect(sent).toHaveLength(1);
    });

    it("menjalankan HELLO → KEYSET → AUTH → data terenkripsi", async () => {
        // 1. HELLO → CHALLENGE
        await ctx.send(JSON.stringify({ type: "LANTANA_HELLO", accountId: "juragan", deviceId: ctx.device.deviceId }));
        const challenge = JSON.parse(lastSent());
        expect(challenge.type).toBe("LANTANA_CHALLENGE");
        expect(challenge.fingerprint).toBe(ctx.serverKey.fingerprint);
        expect(challenge.nonce).toMatch(/^[0-9a-f]{32}$/);

        // 2. KEYSET dengan session key yang dibungkus public key server
        const client = new SecurityAgent();
        const sessionKey = SecurityAgent.generateSessionKey();
        await ctx.send(
            JSON.stringify({
                type: "LANTANA_KEYSET",
                encryptedKey: SecurityAgent.encryptWithPublicKey(challenge.publicKey, sessionKey),
            }),
        );
        expect(JSON.parse(lastSent()).type).toBe("LANTANA_KEYSET_OK");
        client.setSessionKey(sessionKey);

        // 3. AUTH terenkripsi
        await ctx.send(
            JSON.stringify({
                type: "LANTANA_AUTH",
                payload: client.securePacketOut(
                    JSON.stringify({
                        accountId: "juragan",
                        deviceId: ctx.device.deviceId,
                        accessKey: ctx.accessKey,
                        nonce: challenge.nonce,
                    }),
                ),
            }),
        );
        expect(JSON.parse(client.securePacketIn(lastSent())).type).toBe("LANTANA_AUTH_OK");

        // 4. Data terenkripsi masuk ke DeviceBank
        const payload = encodePlainPayload(ctx.device.deviceId, [{ schemeId: 101, value: 30 }]);
        await ctx.send(client.securePacketOut(payload));

        expect(ctx.bank.size).toBe(1);
        expect(ctx.bank.getReadings("juragan", ctx.device.deviceId)).toEqual([
            expect.objectContaining({ schemeId: 101, value: 30, unit: "°C" }),
        ]);
        expect(ctx.dataBank.pending).toBe(1);
        // Data sensor tidak di-ACK; balasan hanya 3 pesan handshake.
        expect(sent).toHaveLength(3);
    });

    it("membalas NACK dan tidak mengubah DeviceBank jika antrean DataBank penuh", async () => {
        ctx = setup(1);
        await ctx.send(JSON.stringify({ type: "LANTANA_HELLO" }));
        const challenge = JSON.parse(lastSent());
        const client = new SecurityAgent();
        const sessionKey = SecurityAgent.generateSessionKey();
        await ctx.send(
            JSON.stringify({
                type: "LANTANA_KEYSET",
                encryptedKey: SecurityAgent.encryptWithPublicKey(challenge.publicKey, sessionKey),
            }),
        );
        client.setSessionKey(sessionKey);
        await ctx.send(
            JSON.stringify({
                type: "LANTANA_AUTH",
                payload: client.securePacketOut(
                    JSON.stringify({
                        accountId: "juragan",
                        deviceId: ctx.device.deviceId,
                        accessKey: ctx.accessKey,
                        nonce: challenge.nonce,
                    }),
                ),
            }),
        );
        sent.length = 0;

        await ctx.send(
            client.securePacketOut(
                encodeBinaryPayload(ctx.device.deviceId, [
                    { schemeId: 101, value: 30 },
                    { schemeId: 102, value: 60 },
                ]),
            ),
        );

        expect(JSON.parse(client.securePacketIn(lastSent()))).toMatchObject({
            type: "LANTANA_NACK",
            name: "DATABANK_UNAVAILABLE",
        });
        expect(ctx.dataBank.pending).toBe(0);
        expect(ctx.bank.size).toBe(0);
    });

    it("menerima frame biner terenkripsi tanpa merusak byte >= 0x80", async () => {
        await ctx.send(JSON.stringify({ type: "LANTANA_HELLO" }));
        const challenge = JSON.parse(lastSent());

        const client = new SecurityAgent();
        const sessionKey = SecurityAgent.generateSessionKey();
        await ctx.send(
            JSON.stringify({
                type: "LANTANA_KEYSET",
                encryptedKey: SecurityAgent.encryptWithPublicKey(challenge.publicKey, sessionKey),
            }),
        );
        client.setSessionKey(sessionKey);

        await ctx.send(
            JSON.stringify({
                type: "LANTANA_AUTH",
                payload: client.securePacketOut(
                    JSON.stringify({
                        accountId: "juragan",
                        deviceId: ctx.device.deviceId,
                        accessKey: ctx.accessKey,
                        nonce: challenge.nonce,
                    }),
                ),
            }),
        );

        // Nilai float dengan byte >= 0x80 (25.5 = 00 00 CC 41) akan rusak bila
        // dekripsi lewat jalur utf8.
        const frame = encodeBinaryPayload(ctx.device.deviceId, [
            { schemeId: 101, value: 25.5 },
            { schemeId: 102, value: 60.25 },
        ]);
        await ctx.send(client.securePacketOut(frame));

        expect(ctx.bank.size).toBe(1);
        const readings = ctx.bank.getReadings("juragan", ctx.device.deviceId);
        expect(readings.map((r) => [r.schemeId, r.value])).toEqual([
            [101, 25.5],
            [102, 60.25],
        ]);
    });

    it("handshake mode psk (ESP8266) lalu menerima data terenkripsi", async () => {
        const clientNonce = "00112233445566778899aabbccddeeff";
        await ctx.send(
            JSON.stringify({
                type: "LANTANA_HELLO",
                mode: "psk",
                accountId: "juragan",
                deviceId: ctx.device.deviceId,
                clientNonce,
            }),
        );

        const challenge = JSON.parse(lastSent());
        expect(challenge.type).toBe("LANTANA_CHALLENGE");
        expect(challenge.mode).toBe("psk");
        expect(challenge.publicKey).toBeUndefined();

        const psk = derivePsk(ctx.accessKey);
        // Device memverifikasi server SEBELUM mengirim proof.
        expect(challenge.serverProof).toBe(serverProof(psk, clientNonce, challenge.nonce));

        await ctx.send(
            JSON.stringify({
                type: "LANTANA_AUTH",
                mode: "psk",
                accountId: "juragan",
                deviceId: ctx.device.deviceId,
                proof: clientProof(psk, clientNonce, challenge.nonce),
            }),
        );

        const sessionKey = deriveSessionKey(psk, clientNonce, challenge.nonce);
        const client = new SecurityAgent();
        client.setSessionKey(sessionKey);

        const ack = JSON.parse(client.securePacketIn(lastSent()));
        expect(ack.type).toBe("LANTANA_AUTH_OK");

        await ctx.send(
            client.securePacketOut(encodePlainPayload(ctx.device.deviceId, [{ schemeId: 101, value: 42 }])),
        );
        expect(ctx.bank.getReadings("juragan", ctx.device.deviceId)).toEqual([
            expect.objectContaining({ schemeId: 101, value: 42 }),
        ]);
    });

    it("menolak proof PSK yang salah", async () => {
        const clientNonce = "00112233445566778899aabbccddeeff";
        await ctx.send(
            JSON.stringify({ type: "LANTANA_HELLO", mode: "psk", accountId: "juragan", clientNonce }),
        );
        const challenge = JSON.parse(lastSent());

        await ctx.send(
            JSON.stringify({
                type: "LANTANA_AUTH",
                mode: "psk",
                accountId: "juragan",
                deviceId: ctx.device.deviceId,
                proof: "00".repeat(32),
            }),
        );

        const nack = JSON.parse(lastSent());
        expect(nack.type).toBe("LANTANA_NACK");
        expect(nack.name).toBe("UNAUTHENTICATED");
        expect(ctx.sessions.isAuthenticated(`${DEVICE_ADDR}:${DEVICE_PORT}`)).toBe(false);
        expect(challenge.mode).toBe("psk");
    });

    it("menolak AUTH PSK yang memakai akun berbeda dari HELLO", async () => {
        // Akun korban dengan device sendiri; penyerang hanya tahu key "juragan".
        const deps = (ctx.listener as any).deps;
        deps.accounts.createRoot("tetangga");
        deps.accounts.issueAccessKey("tetangga");
        const victimDevice = deps.devices.register("tetangga", { name: "Korban" });

        const clientNonce = "00112233445566778899aabbccddeeff";
        await ctx.send(
            JSON.stringify({ type: "LANTANA_HELLO", mode: "psk", accountId: "juragan", clientNonce }),
        );
        const challenge = JSON.parse(lastSent());
        const psk = derivePsk(ctx.accessKey);

        await ctx.send(
            JSON.stringify({
                type: "LANTANA_AUTH",
                mode: "psk",
                accountId: "tetangga",
                deviceId: victimDevice.deviceId,
                proof: clientProof(psk, clientNonce, challenge.nonce),
            }),
        );

        const nack = JSON.parse(lastSent());
        expect(nack.type).toBe("LANTANA_NACK");
        expect(nack.name).toBe("UNAUTHENTICATED");
        expect(ctx.sessions.isAuthenticated(`${DEVICE_ADDR}:${DEVICE_PORT}`)).toBe(false);
        expect(ctx.sessions.get(`${DEVICE_ADDR}:${DEVICE_PORT}`)?.accountId).toBeNull();
    });

    it("menolak AccessKey salah dengan NACK terenkripsi", async () => {
        await ctx.send(JSON.stringify({ type: "LANTANA_HELLO" }));
        const challenge = JSON.parse(lastSent());

        const client = new SecurityAgent();
        const sessionKey = SecurityAgent.generateSessionKey();
        await ctx.send(
            JSON.stringify({
                type: "LANTANA_KEYSET",
                encryptedKey: SecurityAgent.encryptWithPublicKey(challenge.publicKey, sessionKey),
            }),
        );
        client.setSessionKey(sessionKey);

        await ctx.send(
            JSON.stringify({
                type: "LANTANA_AUTH",
                payload: client.securePacketOut(
                    JSON.stringify({
                        accountId: "juragan",
                        deviceId: ctx.device.deviceId,
                        accessKey: "deadbeef",
                        nonce: challenge.nonce,
                    }),
                ),
            }),
        );

        const nack = JSON.parse(client.securePacketIn(lastSent()));
        expect(nack.type).toBe("LANTANA_NACK");
        expect(nack.name).toBe("UNAUTHENTICATED");
        expect(ctx.sessions.isAuthenticated(`${DEVICE_ADDR}:${DEVICE_PORT}`)).toBe(false);
    });

    it("menolak device yang tidak terdaftar pada akun", async () => {
        await ctx.send(JSON.stringify({ type: "LANTANA_HELLO" }));
        const challenge = JSON.parse(lastSent());

        const client = new SecurityAgent();
        const sessionKey = SecurityAgent.generateSessionKey();
        await ctx.send(
            JSON.stringify({
                type: "LANTANA_KEYSET",
                encryptedKey: SecurityAgent.encryptWithPublicKey(challenge.publicKey, sessionKey),
            }),
        );
        client.setSessionKey(sessionKey);

        await ctx.send(
            JSON.stringify({
                type: "LANTANA_AUTH",
                payload: client.securePacketOut(
                    JSON.stringify({
                        accountId: "juragan",
                        deviceId: "device-tidak-ada",
                        accessKey: ctx.accessKey,
                        nonce: challenge.nonce,
                    }),
                ),
            }),
        );

        const nack = JSON.parse(client.securePacketIn(lastSent()));
        expect(nack.type).toBe("LANTANA_NACK");
        expect(nack.name).toBe("UNKNOWN_DEVICE");
    });

    it("menolak nonce lama (replay)", async () => {
        await ctx.send(JSON.stringify({ type: "LANTANA_HELLO" }));
        const first = JSON.parse(lastSent());

        const client = new SecurityAgent();
        const sessionKey = SecurityAgent.generateSessionKey();
        await ctx.send(
            JSON.stringify({
                type: "LANTANA_KEYSET",
                encryptedKey: SecurityAgent.encryptWithPublicKey(first.publicKey, sessionKey),
            }),
        );
        client.setSessionKey(sessionKey);

        // Handshake kedua mengganti nonce dan membuang session key lama.
        await ctx.send(JSON.stringify({ type: "LANTANA_HELLO" }));

        await ctx.send(
            JSON.stringify({
                type: "LANTANA_AUTH",
                payload: client.securePacketOut(
                    JSON.stringify({
                        accountId: "juragan",
                        deviceId: ctx.device.deviceId,
                        accessKey: ctx.accessKey,
                        nonce: first.nonce,
                    }),
                ),
            }),
        );

        const last = lastSent();
        const decoded = client.securePacketIn(last);
        // Agent lama sudah dibuang → balasan berupa NACK plaintext JSON.
        expect(JSON.parse(decoded || last).type).toBe("LANTANA_NACK");
        expect(ctx.sessions.isAuthenticated(`${DEVICE_ADDR}:${DEVICE_PORT}`)).toBe(false);
    });
});

describe("dedup paket duplikat / replay", () => {
    let ctx: ReturnType<typeof setup>;

    /** Handshake RSA lengkap; kembalikan agent klien yang memegang key sesi. */
    async function authenticate(): Promise<SecurityAgent> {
        await ctx.send(JSON.stringify({ type: "LANTANA_HELLO" }));
        const challenge = JSON.parse(lastSent());
        const client = new SecurityAgent();
        const sessionKey = SecurityAgent.generateSessionKey();
        await ctx.send(
            JSON.stringify({
                type: "LANTANA_KEYSET",
                encryptedKey: SecurityAgent.encryptWithPublicKey(challenge.publicKey, sessionKey),
            }),
        );
        client.setSessionKey(sessionKey);
        await ctx.send(
            JSON.stringify({
                type: "LANTANA_AUTH",
                payload: client.securePacketOut(
                    JSON.stringify({
                        accountId: "juragan",
                        deviceId: ctx.device.deviceId,
                        accessKey: ctx.accessKey,
                        nonce: challenge.nonce,
                    }),
                ),
            }),
        );
        expect(JSON.parse(client.securePacketIn(lastSent())).type).toBe("LANTANA_AUTH_OK");
        sent.length = 0;
        return client;
    }

    const queued = () => (ctx.dataBank as any).queue as { readingId: string; value: unknown }[];

    beforeEach(() => {
        ctx = setup();
    });

    it("membuang ciphertext yang sama persis tanpa NACK", async () => {
        const client = await authenticate();
        const packet = client.securePacketOut(
            encodePlainPayload(ctx.device.deviceId, [{ schemeId: 101, value: 30 }]),
        );

        await ctx.send(packet);
        await ctx.send(packet);
        await ctx.send(packet);

        expect(ctx.dataBank.pending).toBe(1);
        // Duplikat dibuang diam-diam: NACK akan memaksa device restart sesi.
        expect(sent).toHaveLength(0);
    });

    it("tidak bisa dilewati dengan menambah karakter non-hex di ujung ciphertext", async () => {
        const client = await authenticate();
        const packet = client.securePacketOut(
            encodePlainPayload(ctx.device.deviceId, [{ schemeId: 101, value: 30 }]),
        );

        await ctx.send(packet);
        await ctx.send(`${packet}zz`);
        await ctx.send(`  ${packet}  `);

        expect(ctx.dataBank.pending).toBe(1);
    });

    it("membuang duplikat frame biner (Buffer mentah)", async () => {
        const client = await authenticate();
        const raw = client.securePacketOutRaw(
            encodeBinaryPayload(ctx.device.deviceId, [{ schemeId: 101, value: 21.5 }]),
        ) as Buffer;

        await ctx.send(raw);
        await ctx.send(Buffer.from(raw));

        expect(ctx.dataBank.pending).toBe(1);
    });

    it("menerima dua paket berbeda walaupun isinya identik", async () => {
        const client = await authenticate();
        const payload = encodePlainPayload(ctx.device.deviceId, [{ schemeId: 101, value: 30 }]);

        await ctx.send(client.securePacketOut(payload));
        await ctx.send(client.securePacketOut(payload));

        expect(ctx.dataBank.pending).toBe(2);
        const [a, b] = queued();
        expect(a.readingId).not.toBe(b.readingId);
    });

    it("readingId diturunkan dari paket sehingga stabil dan berformat UUID", async () => {
        const client = await authenticate();
        const packet = client.securePacketOut(
            encodePlainPayload(ctx.device.deviceId, [
                { schemeId: 101, value: 30 },
                { schemeId: 102, value: 55 },
            ]),
        );
        await ctx.send(packet);

        const iv = Buffer.from(packet, "hex").subarray(0, 12).toString("hex");
        expect(queued().map((r) => r.readingId)).toEqual([
            packetReadingId("juragan", ctx.device.deviceId, iv, 101),
            packetReadingId("juragan", ctx.device.deviceId, iv, 102),
        ]);
        expect(queued()[0].readingId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
    });

    it("paket dengan tag rusak tidak meracuni riwayat IV", async () => {
        const client = await authenticate();
        const packet = client.securePacketOut(
            encodePlainPayload(ctx.device.deviceId, [{ schemeId: 101, value: 30 }]),
        );
        // IV sama, tag dibalik → gagal dekripsi, IV tidak boleh tercatat.
        const forged = packet.slice(0, 24) + "00".repeat(16) + packet.slice(56);

        await ctx.send(forged);
        expect(JSON.parse(client.securePacketIn(lastSent())).name).toBe("UNAUTHENTICATED");

        await ctx.send(packet);
        expect(ctx.dataBank.pending).toBe(1);
    });
});

describe("ReplayWindow", () => {
    it("mengingat IV terbaru dan melupakan yang tertua saat penuh", () => {
        const w = new ReplayWindow(3);
        expect(["a", "b", "c"].map((id) => w.accept(id))).toEqual([true, true, true]);
        expect(w.accept("b")).toBe(false);

        expect(w.accept("d")).toBe(true); // "a" tergusur
        expect(w.accept("a")).toBe(true);
        expect(w.accept("c")).toBe(false);
    });

    it("tetap benar setelah banyak eviksi (pemadatan array internal)", () => {
        const w = new ReplayWindow(4);
        for (let i = 0; i < 50; i++) expect(w.accept(`iv-${i}`)).toBe(true);
        for (let i = 46; i < 50; i++) expect(w.accept(`iv-${i}`)).toBe(false);
        expect(w.accept("iv-45")).toBe(true);
    });
});
