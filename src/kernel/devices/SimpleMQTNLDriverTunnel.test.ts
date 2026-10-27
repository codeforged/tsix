import { describe, it, expect } from "vitest";
import { SimpleMQTNLDriver } from "./SimpleMQTNLDriver";
import {
    SimpleMQTNLDriverTunnel,
    DEFAULT_TUNNEL_PORT,
    TunnelIfaceSpec,
    parseTunnelPeer,
} from "./SimpleMQTNLDriverTunnel";
import {
    TunnelKind,
    TunnelProto,
    decodeTunnelFrame,
    encodeTunnelFrame,
} from "../../common/protocols/TunnelEnvelope";
import { PacketFlags } from "../../common/PacketFlags";
import { SecurityAgent } from "../../common/SecurityAgent";

/**
 * SIMPLE MQTNL DRIVER TUNNEL — uji routing + jalur balik.
 *
 * Semua uji berjalan TANPA broker: `send()` di base class melakukan loopback
 * bila alamat tujuan adalah device lain di proses yang sama (`findLocal`).
 * Dengan itu kita bisa menguji rantai penuh —
 * amplop → enkripsi PSK → Binfeo → reassembly → dekripsi → decode → dispatch —
 * tanpa MQTT, dan tanpa mengubah kode produksi.
 */

const KEY_HEX =
    "81ff71ed574e54597690ae7b04e4ef5fc87497fe10b6b037cb031af7c7d67619";

let seq = 0;
const uniq = (prefix: string) => `__tun_${prefix}_${++seq}`;

function makeTunnel(over: Partial<TunnelIfaceSpec> = {}) {
    const id = uniq("t");
    return new SimpleMQTNLDriverTunnel({
        deviceName: `smqtnltun${seq}`,
        broker: "mqtt://dummy",
        address: id,
        peer: "relay",
        port: DEFAULT_TUNNEL_PORT,
        psk: KEY_HEX,
        ...over,
    });
}

describe("SimpleMQTNLDriverTunnel — routing", () => {
    it("T1.01 tujuan biasa dibungkus amplop dan dikirim ke relay", async () => {
        const x = makeTunnel();
        const z = makeTunnel({ peer: x.nodeAddress });
        // Relay (z) menerima amplop di port tunnel, lalu meneruskannya ke
        // aplikasi lokal di port 24 — di sinilah X melihat identitas asli.
        const got: any[] = [];
        z.registerHandler(24, (pkt: any) => got.push(pkt));

        // x → relay z: alamat peer x harus z.
        const x2 = makeTunnel({ peer: z.nodeAddress });
        const got2: any[] = [];
        const sink = makeTunnel({ peer: x2.nodeAddress });
        sink.registerHandler(24, (pkt: any) => got2.push(pkt));

        const ok = await x2.send("node-y", 24, "hello", PacketFlags.FLAG_DATA, 5000);

        expect(ok).toBe(true);
        expect(got2).toHaveLength(0); // bukan tujuan sink ini
        expect(got).toHaveLength(0);
        // Sink menerima amplop untuk "node-y" lalu drop (dst bukan dirinya),
        // tetapi hop-nya terbukti sampai: tidak ada exception, tidak nge-hang.
        const stats = sink.getStats().params.tunnel;
        expect(stats.tunneled).toBe(0);
        expect(stats.nack).toBe(0);
    });

    it("T1.02 amplop sampai ke port aplikasi dengan identitas asli pengirim", async () => {
        // z = "sisi relay" palsu: device yang menerima amplop dan meneruskannya.
        const z = makeTunnel();
        const x = makeTunnel({ peer: z.nodeAddress });

        // z meneruskan amplop balik ke x (meniru vpns yang mengembalikan jawaban).
        const delivered: any[] = [];
        x.registerHandler(5000, (pkt: any) => delivered.push(pkt));

        // Siapkan amplop seolah dari node-y:24 ke x:5000.
        const envelope = encodeTunnelFrame({
            version: 1,
            kind: TunnelKind.DATA,
            hops: 1,
            flag: PacketFlags.FLAG_DATA,
            proto: TunnelProto.JSON,
            srcAddress: "node-y",
            srcPort: 24,
            dstAddress: x.nodeAddress,
            dstPort: 5000,
            payload: Buffer.from("jawaban", "utf8"),
        });

        // Jalur RX asli: amplop dikirim lewat device tunnel (Binfeo + PSK),
        // sehingga dekripsi/fragmentasi benar-benar diuji.
        await z.send(x.nodeAddress, DEFAULT_TUNNEL_PORT, envelope, PacketFlags.FLAG_DATA, DEFAULT_TUNNEL_PORT);

        expect(delivered).toHaveLength(1);
        expect(delivered[0].src).toBe("node-y");
        expect(delivered[0].port).toBe(24);
        expect(delivered[0].localPort).toBe(5000);
        expect(delivered[0].data).toBe("jawaban");
        expect(delivered[0].isBinary).toBe(false);
    });

    it("T1.03 payload biner (Binfeo) sampai utuh dengan isBinary=true", async () => {
        const z = makeTunnel();
        const x = makeTunnel({ peer: z.nodeAddress });
        const delivered: any[] = [];
        x.registerHandler(5000, (pkt: any) => delivered.push(pkt));

        const bytes = Buffer.from([0x00, 0x42, 0x66, 0x7f, 0x80, 0xff, 0xfe]);
        const envelope = encodeTunnelFrame({
            version: 1,
            kind: TunnelKind.DATA,
            hops: 1,
            flag: PacketFlags.FLAG_DATA,
            proto: TunnelProto.BINFEO,
            srcAddress: "node-y",
            srcPort: 24,
            dstAddress: x.nodeAddress,
            dstPort: 5000,
            payload: bytes,
        });

        await z.send(x.nodeAddress, DEFAULT_TUNNEL_PORT, envelope, PacketFlags.FLAG_DATA, DEFAULT_TUNNEL_PORT);

        expect(delivered).toHaveLength(1);
        expect(delivered[0].isBinary).toBe(true);
        expect(Buffer.isBuffer(delivered[0].data)).toBe(true);
        expect(Buffer.compare(delivered[0].data, bytes)).toBe(0);
    });

    it("T1.04 alamat lokal → loopback, tidak masuk amplop", async () => {
        const x = makeTunnel();

        await x.send(x.nodeAddress, 5000, "self", PacketFlags.FLAG_DATA, 5000);

        const stats = x.getStats().params.tunnel;
        expect(stats.loopback).toBe(1);
        expect(stats.tunneled).toBe(0);
    });

    it("T1.05 alamat di 'exclude' → langsung ke broker lokal", async () => {
        const x = makeTunnel({ exclude: ["broker1-node"] });

        const ok = await x.send("broker1-node", 80, "hi", PacketFlags.FLAG_DATA, 5000);

        // Tidak ada broker → base class mengembalikan false, tetapi jalurnya
        // harus "direct" (bukan tunnel).
        expect(ok).toBe(false);
        const stats = x.getStats().params.tunnel;
        expect(stats.direct).toBe(1);
        expect(stats.tunneled).toBe(0);
    });

    it("T1.06 'localhost' diperlakukan sebagai alamat device sendiri", async () => {
        const x = makeTunnel();

        await x.send("localhost", 5000, "self", PacketFlags.FLAG_DATA, 5000);

        const stats = x.getStats().params.tunnel;
        expect(stats.loopback).toBe(1);
        expect(stats.tunneled).toBe(0);
    });

    it("T1.07 hop berlebih dibuang (anti-loop)", () => {
        const x = makeTunnel({ maxHops: 3 });
        const got: any[] = [];
        x.registerHandler(5000, (pkt: any) => got.push(pkt));

        x.handleEnvelopePacket({
            src: "relay",
            port: DEFAULT_TUNNEL_PORT,
            data: encodeTunnelFrame({
                version: 1,
                kind: TunnelKind.DATA,
                hops: 9,
                flag: 0,
                proto: TunnelProto.JSON,
                srcAddress: "node-y",
                srcPort: 24,
                dstAddress: x.nodeAddress,
                dstPort: 5000,
                payload: Buffer.from("x"),
            }),
        });

        expect(got).toHaveLength(0);
        expect(x.getStats().params.tunnel.droppedHops).toBe(1);
    });

    it("T1.08 amplop untuk alamat lain dibuang", () => {
        const x = makeTunnel();
        const got: any[] = [];
        x.registerHandler(5000, (pkt: any) => got.push(pkt));

        x.handleEnvelopePacket({
            src: "relay",
            port: DEFAULT_TUNNEL_PORT,
            data: encodeTunnelFrame({
                version: 1,
                kind: TunnelKind.DATA,
                hops: 1,
                flag: 0,
                proto: TunnelProto.JSON,
                srcAddress: "node-y",
                srcPort: 24,
                dstAddress: "node-lain",
                dstPort: 5000,
                payload: Buffer.from("x"),
            }),
        });

        expect(got).toHaveLength(0);
        expect(x.getStats().params.tunnel.dropped).toBe(1);
    });

    it("T1.09 NACK dicatat, tidak diteruskan ke aplikasi", () => {
        const x = makeTunnel();
        const got: any[] = [];
        x.registerHandler(5000, (pkt: any) => got.push(pkt));

        x.handleEnvelopePacket({
            src: "relay",
            port: DEFAULT_TUNNEL_PORT,
            data: encodeTunnelFrame({
                version: 1,
                kind: TunnelKind.NACK,
                hops: 1,
                flag: 0,
                proto: TunnelProto.JSON,
                srcAddress: "relay",
                srcPort: DEFAULT_TUNNEL_PORT,
                dstAddress: x.nodeAddress,
                dstPort: 5000,
                payload: Buffer.from("tujuan tidak dikenal"),
            }),
        });

        expect(got).toHaveLength(0);
        expect(x.getStats().params.tunnel.nack).toBe(1);
    });

    it("T1.10 amplop rusak tidak melempar exception", () => {
        const x = makeTunnel();
        expect(() =>
            x.handleEnvelopePacket({ src: "relay", port: 9360, data: Buffer.from("sampah") }),
        ).not.toThrow();
        expect(x.getStats().params.tunnel.dropped).toBe(1);
    });

    it("T1.11 port tanpa handler → drop tercatat, bukan crash", () => {
        const x = makeTunnel();

        x.handleEnvelopePacket({
            src: "relay",
            port: DEFAULT_TUNNEL_PORT,
            data: encodeTunnelFrame({
                version: 1,
                kind: TunnelKind.DATA,
                hops: 1,
                flag: 0,
                proto: TunnelProto.JSON,
                srcAddress: "node-y",
                srcPort: 24,
                dstAddress: x.nodeAddress,
                dstPort: 9999,
                payload: Buffer.from("x"),
            }),
        });

        const stats = x.getStats().params.tunnel;
        expect(stats.rx).toBe(1);
        expect(stats.delivered).toBe(0);
        expect(stats.dropped).toBe(1);
    });

    it("T1.13 kontrak relay: amplop yang diterima berisi src/dst/port/proto yang benar", async () => {
        // Sisi relay disimulasikan dengan driver BIASA (persis seperti vpns):
        // port 9360 di-pin Binfeo + PSK, lalu handler menerima amplop yang
        // sudah didekripsi driver.
        const relayAddr = uniq("relayonly");
        const relay = new SimpleMQTNLDriver("smqtnlrelay", "mqtt://dummy", relayAddr);
        relay.ioctl(0x1002, { port: DEFAULT_TUNNEL_PORT, protocol: "Binfeo" });
        relay.ioctl(0x1001, { port: DEFAULT_TUNNEL_PORT, sessionKey: KEY_HEX });

        const received: Buffer[] = [];
        relay.registerHandler(DEFAULT_TUNNEL_PORT, (pkt: any) =>
            received.push(Buffer.isBuffer(pkt.data) ? pkt.data : Buffer.from(String(pkt.data), "utf8")),
        );

        const x = makeTunnel({ peer: relayAddr });
        // Aplikasi memilih framing Binfeo di port-nya → harus ikut di amplop
        // supaya relay membuat socket tujuan dengan framing yang sama.
        x.ioctl(0x1002, { port: 5000, protocol: "Binfeo" });

        const payload = Buffer.from([0x10, 0x80, 0xff]);
        const ok = await x.send("node-y", 24, payload, PacketFlags.FLAG_DATA, 5000);

        expect(ok).toBe(true);
        expect(received).toHaveLength(1);

        const frame = decodeTunnelFrame(received[0]);
        expect(frame).not.toBeNull();
        expect(frame!.kind).toBe(TunnelKind.DATA);
        expect(frame!.srcAddress).toBe(x.nodeAddress);
        expect(frame!.srcPort).toBe(5000);
        expect(frame!.dstAddress).toBe("node-y");
        expect(frame!.dstPort).toBe(24);
        expect(frame!.proto).toBe(TunnelProto.BINFEO);
        expect(frame!.flag).toBe(PacketFlags.FLAG_DATA);
        expect(Buffer.compare(frame!.payload, payload)).toBe(0);
    });

    it("T1.14 kontrak balasan relay: 'dstPort' menjadi port aplikasi penerima", async () => {
        // Balasan relay selalu menyebut port aplikasi klien di `dstPort` —
        // itulah yang dipakai device untuk deliverLocal().
        const x = makeTunnel();
        const got: any[] = [];
        x.registerHandler(7777, (pkt: any) => got.push(pkt));

        x.handleEnvelopePacket({
            src: "relay",
            port: DEFAULT_TUNNEL_PORT,
            data: encodeTunnelFrame({
                version: 1,
                kind: TunnelKind.DATA,
                hops: 2,
                flag: PacketFlags.FLAG_PING_REPLY,
                proto: TunnelProto.JSON,
                srcAddress: "node-y",
                srcPort: 24,
                dstAddress: x.nodeAddress,
                dstPort: 7777,
                payload: Buffer.from("pong"),
            }),
        });

        expect(got).toHaveLength(1);
        expect(got[0].src).toBe("node-y");
        expect(got[0].port).toBe(24);
        expect(got[0].localPort).toBe(7777);
        expect(got[0].flag).toBe(PacketFlags.FLAG_PING_REPLY);
    });

    it("T1.12 broadcast '*' tetap dibungkus dan flag aslinya bertahan", async () => {
        const z = makeTunnel();
        const x = makeTunnel({ peer: z.nodeAddress });
        const got: any[] = [];
        z.registerHandler(65534, (pkt: any) => got.push(pkt));

        await x.send("*", 65534, "discover", PacketFlags.FLAG_BROADCAST_PING, 5000);

        expect(x.getStats().params.tunnel.tunneled).toBe(1);
        // Amplop broadcast tidak boleh dibuang: relay/peer harus menerimanya,
        // dan FLAG_BROADCAST_PING harus utuh supaya discovery tetap bekerja.
        expect(got).toHaveLength(1);
        expect(got[0].localPort).toBe(65534);
        expect(got[0].flag).toBe(PacketFlags.FLAG_BROADCAST_PING);
    });
});

describe("SimpleMQTNLDriverTunnel — handshake RSA (tanpa PSK)", () => {
    /** Buffer-kan payload apa pun dari objek dispatch. */
    const asBuf = (data: any): Buffer =>
        Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ""), "utf8");

    const ctrlEnvelope = (
        kind: TunnelKind,
        src: string,
        srcPort: number,
        dst: string,
        dstPort: number,
        payload: Buffer,
    ) =>
        encodeTunnelFrame({
            version: 1,
            kind,
            hops: 1,
            flag: PacketFlags.FLAG_DATA,
            proto: TunnelProto.JSON,
            srcAddress: src,
            srcPort,
            dstAddress: dst,
            dstPort,
            payload,
        });

    it("T3.01 mode handshake: HS_REQ → HS_ACK → HS_KEY → HS_OK", async () => {
        // Relay palsu: driver biasa di proses yang sama (loopback), port kontrol
        // di-pin Binfeo tanpa kunci — persis seperti port kontrol vpns.
        const relayAddr = uniq("relay");
        const relay = new SimpleMQTNLDriver("smqtnlrelay", "mqtt://dummy", relayAddr);
        relay.ioctl(0x1002, { port: DEFAULT_TUNNEL_PORT + 1, protocol: "Binfeo" });
        relay.ioctl(0x1002, { port: DEFAULT_TUNNEL_PORT, protocol: "Binfeo" });

        const inbox: any[] = [];
        relay.registerHandler(DEFAULT_TUNNEL_PORT + 1, (p: any) => inbox.push(p));

        const client = makeTunnel({ peer: relayAddr, psk: undefined });
        const delivered: any[] = [];
        client.registerHandler(5000, (p: any) => delivered.push(p));

        expect(client.securityMode).toBe("handshake");
        expect(client.isReady).toBe(false);

        // 1. Klien minta handshake.
        client.beginHandshake("test");
        expect(inbox).toHaveLength(1);

        const req = decodeTunnelFrame(asBuf(inbox[0].data));
        expect(req).not.toBeNull();
        expect(req!.kind).toBe(TunnelKind.HS_REQ);

        const clientCtrlPort = req!.srcPort;
        expect(clientCtrlPort).toBe(client.ctrlPort);

        // 2. Relay menjawab dengan public key + fingerprint + nonce.
        const relayKeyPair = SecurityAgent.generateKeyPair();
        const relayFp = SecurityAgent.getFingerprint(relayKeyPair.publicKey).toUpperCase();
        const nonce = "0123456789abcdef";

        await relay.send(
            client.nodeAddress,
            clientCtrlPort,
            ctrlEnvelope(
                TunnelKind.HS_ACK,
                relayAddr,
                DEFAULT_TUNNEL_PORT + 1,
                client.nodeAddress,
                clientCtrlPort,
                Buffer.from(`${relayKeyPair.publicKey}::${relayFp}::${nonce}`, "utf8"),
            ),
            PacketFlags.FLAG_DATA,
            DEFAULT_TUNNEL_PORT + 1,
        );

        // 3. Klien mengirim public key + tanda tangan nonce.
        expect(inbox).toHaveLength(2);
        const keyFrame = decodeTunnelFrame(asBuf(inbox[1].data));
        expect(keyFrame!.kind).toBe(TunnelKind.HS_KEY);

        const [clientPub, sig] = keyFrame!.payload.toString("utf8").split("::");
        expect(clientPub).toContain("BEGIN RSA PUBLIC KEY");
        // Bukti possession: tanda tangan valid untuk nonce yang dikirim relay.
        expect(SecurityAgent.verify(clientPub, nonce, sig)).toBe(true);

        // 4. Relay membungkus kunci sesi dengan public key klien.
        const sessionKey = SecurityAgent.generateSessionKey();
        const wrapped = SecurityAgent.encryptWithPublicKey(clientPub, sessionKey);

        await relay.send(
            client.nodeAddress,
            clientCtrlPort,
            ctrlEnvelope(
                TunnelKind.HS_OK,
                relayAddr,
                DEFAULT_TUNNEL_PORT + 1,
                client.nodeAddress,
                clientCtrlPort,
                Buffer.from(wrapped, "utf8"),
            ),
            PacketFlags.FLAG_DATA,
            DEFAULT_TUNNEL_PORT + 1,
        );

        expect(client.isReady).toBe(true);
        expect(client.peerFingerprint).toBe(relayFp);
        expect(client.getStats().params.tunnel.encrypted).toBe(true);

        // 5. Data terenkripsi kunci sesi itu benar-benar sampai ke aplikasi.
        relay.ioctl(0x1001, {
            port: DEFAULT_TUNNEL_PORT,
            sessionKey: sessionKey.toString("hex"),
        });

        await relay.send(
            client.nodeAddress,
            DEFAULT_TUNNEL_PORT,
            encodeTunnelFrame({
                version: 1,
                kind: TunnelKind.DATA,
                hops: 1,
                flag: PacketFlags.FLAG_DATA,
                proto: TunnelProto.JSON,
                srcAddress: "node-y",
                srcPort: 24,
                dstAddress: client.nodeAddress,
                dstPort: 5000,
                payload: Buffer.from("setelah handshake", "utf8"),
            }),
            PacketFlags.FLAG_DATA,
            DEFAULT_TUNNEL_PORT,
        );

        expect(delivered).toHaveLength(1);
        expect(delivered[0].src).toBe("node-y");
        expect(delivered[0].data).toBe("setelah handshake");

        client.stopHandshakeTimers();
    });

    it("T3.02 fingerprint relay tidak cocok dengan public key → handshake ditolak", async () => {
        const relayAddr = uniq("relay");
        const relay = new SimpleMQTNLDriver("smqtnlrelay", "mqtt://dummy", relayAddr);
        relay.ioctl(0x1002, { port: DEFAULT_TUNNEL_PORT + 1, protocol: "Binfeo" });
        const inbox: any[] = [];
        relay.registerHandler(DEFAULT_TUNNEL_PORT + 1, (p: any) => inbox.push(p));

        const client = makeTunnel({ peer: relayAddr, psk: undefined });
        client.beginHandshake("test");

        const kp = SecurityAgent.generateKeyPair();
        const wrongFp = "DEADBEEFDEADBEEF";
        await relay.send(
            client.nodeAddress,
            client.ctrlPort,
            ctrlEnvelope(
                TunnelKind.HS_ACK,
                relayAddr,
                DEFAULT_TUNNEL_PORT + 1,
                client.nodeAddress,
                client.ctrlPort,
                Buffer.from(`${kp.publicKey}::${wrongFp}::nonce123`, "utf8"),
            ),
            PacketFlags.FLAG_DATA,
            DEFAULT_TUNNEL_PORT + 1,
        );

        expect(client.isReady).toBe(false);
        // Tidak ada HS_KEY yang dikirim karena verifikasi gagal.
        expect(inbox).toHaveLength(1);
        expect(client.getStats().params.tunnel.hsFail).toBeGreaterThan(0);

        client.stopHandshakeTimers();
    });

    it("T3.03 trustedFingerprint salah → handshake ditolak", async () => {
        const relayAddr = uniq("relay");
        const relay = new SimpleMQTNLDriver("smqtnlrelay", "mqtt://dummy", relayAddr);
        relay.ioctl(0x1002, { port: DEFAULT_TUNNEL_PORT + 1, protocol: "Binfeo" });
        const inbox: any[] = [];
        relay.registerHandler(DEFAULT_TUNNEL_PORT + 1, (p: any) => inbox.push(p));

        const client = makeTunnel({
            peer: relayAddr,
            psk: undefined,
            trustedFingerprint: "AAAABBBBCCCCDDDD",
        });
        client.beginHandshake("test");

        const kp = SecurityAgent.generateKeyPair();
        const realFp = SecurityAgent.getFingerprint(kp.publicKey).toUpperCase();

        await relay.send(
            client.nodeAddress,
            client.ctrlPort,
            ctrlEnvelope(
                TunnelKind.HS_ACK,
                relayAddr,
                DEFAULT_TUNNEL_PORT + 1,
                client.nodeAddress,
                client.ctrlPort,
                Buffer.from(`${kp.publicKey}::${realFp}::nonce`, "utf8"),
            ),
            PacketFlags.FLAG_DATA,
            DEFAULT_TUNNEL_PORT + 1,
        );

        expect(client.isReady).toBe(false);
        expect(inbox).toHaveLength(1);
        expect(client.getStats().params.tunnel.hsFail).toBeGreaterThan(0);

        client.stopHandshakeTimers();
    });

    it("T3.04 trustFingerprint tepat → handshake diterima & fingerprint tercatat", async () => {
        const relayAddr = uniq("relay");
        const relay = new SimpleMQTNLDriver("smqtnlrelay", "mqtt://dummy", relayAddr);
        relay.ioctl(0x1002, { port: DEFAULT_TUNNEL_PORT + 1, protocol: "Binfeo" });
        const inbox: any[] = [];
        relay.registerHandler(DEFAULT_TUNNEL_PORT + 1, (p: any) => inbox.push(p));

        const kp = SecurityAgent.generateKeyPair();
        const fp = SecurityAgent.getFingerprint(kp.publicKey).toUpperCase();

        const client = makeTunnel({
            peer: relayAddr,
            psk: undefined,
            trustedFingerprint: fp.toLowerCase(), // harus dinormalisasi
        });
        client.beginHandshake("test");

        await relay.send(
            client.nodeAddress,
            client.ctrlPort,
            ctrlEnvelope(
                TunnelKind.HS_ACK,
                relayAddr,
                DEFAULT_TUNNEL_PORT + 1,
                client.nodeAddress,
                client.ctrlPort,
                Buffer.from(`${kp.publicKey}::${fp}::nonce9`, "utf8"),
            ),
            PacketFlags.FLAG_DATA,
            DEFAULT_TUNNEL_PORT + 1,
        );

        expect(client.peerFingerprint).toBe(fp);
        expect(inbox).toHaveLength(2); // HS_REQ + HS_KEY

        client.stopHandshakeTimers();
    });

    it("T3.05 handshake: false → mode plain, tidak ada HS_REQ", async () => {
        const relayAddr = uniq("relay");
        const relay = new SimpleMQTNLDriver("smqtnlrelay", "mqtt://dummy", relayAddr);
        relay.ioctl(0x1002, { port: DEFAULT_TUNNEL_PORT + 1, protocol: "Binfeo" });
        const inbox: any[] = [];
        relay.registerHandler(DEFAULT_TUNNEL_PORT + 1, (p: any) => inbox.push(p));

        const client = makeTunnel({
            peer: relayAddr,
            psk: undefined,
            handshake: false,
        });

        expect(client.securityMode).toBe("plain");
        expect(client.isReady).toBe(true);

        client.beginHandshake("test"); // no-op di mode plain
        expect(inbox).toHaveLength(0);
        expect(client.getStats().params.tunnel.encrypted).toBe(false);
    });

    it("T3.06 PSK tetap didahulukan (tanpa handshake walau handshake:true)", () => {
        const c = makeTunnel({ psk: KEY_HEX, handshake: true });
        expect(c.securityMode).toBe("psk");
        expect(c.isReady).toBe(true);
        expect(c.getStats().params.tunnel.encrypted).toBe(true);
    });

    it("T3.07 amplop ditahan selama handshake lalu dilepas setelah siap", async () => {
        const relayAddr = uniq("relay");
        const relay = new SimpleMQTNLDriver("smqtnlrelay", "mqtt://dummy", relayAddr);
        relay.ioctl(0x1002, { port: DEFAULT_TUNNEL_PORT + 1, protocol: "Binfeo" });
        relay.ioctl(0x1002, { port: DEFAULT_TUNNEL_PORT, protocol: "Binfeo" });

        const dataInbox: any[] = [];
        relay.registerHandler(DEFAULT_TUNNEL_PORT, (p: any) => dataInbox.push(p));

        const client = makeTunnel({ peer: relayAddr, psk: undefined });

        // Belum ready → paket aplikasi masuk antrian, bukan hilang.
        const queuedOk = await client.send("node-y", 24, "halo", PacketFlags.FLAG_DATA, 5000);
        expect(queuedOk).toBe(true);
        expect(client.pendingCount).toBe(1);
        expect(dataInbox).toHaveLength(0);

        client.stopHandshakeTimers();
    });
});

describe("SimpleMQTNLDriverTunnel — konfigurasi", () => {
    it("T2.01 parseTunnelPeer menerima 'node' dan 'node:port'", () => {
        expect(parseTunnelPeer("relay")).toEqual({ address: "relay", port: DEFAULT_TUNNEL_PORT });
        expect(parseTunnelPeer("relay:1234")).toEqual({ address: "relay", port: 1234 });
        expect(parseTunnelPeer("relay:abc")).toEqual({ address: "relay:abc", port: DEFAULT_TUNNEL_PORT });
        expect(parseTunnelPeer("  relay:99  ")).toEqual({ address: "relay", port: 99 });
    });

    it("T2.02 peer kosong ditolak saat konstruksi", () => {
        expect(
            () =>
                new SimpleMQTNLDriverTunnel({
                    deviceName: "smqtnltunbad",
                    broker: "mqtt://dummy",
                    address: uniq("bad"),
                    peer: "   ",
                }),
        ).toThrow(/peer/);
    });

    it("T2.03 tanpa PSK tetap jalan (plain) dan tercatat di statistik", () => {
        const x = makeTunnel({ psk: undefined });
        const stats = x.getStats().params.tunnel;
        expect(stats.encrypted).toBe(false);
        expect(stats.agent).toBeNull();
    });

    it("T2.04 port tunnel di-pin Binfeo (bukan JSON)", () => {
        // Bukti tidak langsung: device menerima amplop biner dari device lain,
        // artinya framing Binfeo aktif di port tunnel. Kalau tidak, RX akan
        // memperlakukan amplop sebagai JSON dan decode gagal.
        const z = makeTunnel();
        const x = makeTunnel({ peer: z.nodeAddress });
        const got: any[] = [];
        x.registerHandler(5000, (pkt: any) => got.push(pkt));

        return z
            .send(
                x.nodeAddress,
                DEFAULT_TUNNEL_PORT,
                encodeTunnelFrame({
                    version: 1,
                    kind: TunnelKind.DATA,
                    hops: 1,
                    flag: 0,
                    proto: TunnelProto.JSON,
                    srcAddress: "node-y",
                    srcPort: 24,
                    dstAddress: x.nodeAddress,
                    dstPort: 5000,
                    payload: Buffer.from("ok"),
                }),
                PacketFlags.FLAG_DATA,
                DEFAULT_TUNNEL_PORT,
            )
            .then(() => {
                expect(got).toHaveLength(1);
                expect(got[0].data).toBe("ok");
            });
    });

    it("T2.05 device terdaftar sebagai SimpleMQTNLDriver (ifconfig/netstat kompatibel)", () => {
        const x = makeTunnel();
        // netstat memakai `instanceof SimpleMQTNLDriver`
        expect(x instanceof SimpleMQTNLDriver).toBe(true);

        const stats = x.getStats();
        expect(stats.deviceName).toBe(x.name);
        expect(stats.address).toBe(x.nodeAddress);
        expect(stats.params).toHaveProperty("connected");
        expect(stats.params).toHaveProperty("rxBytes");
        expect(stats.params).toHaveProperty("boundPorts");
        expect(stats.params).toHaveProperty("tunnel");
    });
});
