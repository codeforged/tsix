import { IDevice, KContext } from "./IDevice";
import { Logger } from "../../common/Logger";
import { Config } from "../../common/Config";
import { PacketFlags } from "../../common/PacketFlags";
import { SecurityAgent } from "../../common/SecurityAgent";
import { IMQTNLProtocol } from "../../common/protocols/IMQTNLProtocol";
import { MQTNLProtocolJSON } from "../../common/protocols/MQTNLProtocolJSON";
import { MQTNLProtocolBinary } from "../../common/protocols/MQTNLProtocolBinary";
import * as mqtt from "mqtt";

/**
 * SIMPLE MQTNL DRIVER (/dev/smqtnl0)
 * 
 * Versi "Simple" tapi mengikuti standar wire MQTNL v1.0 "Masterpiece" Bapak.
 * Kompatibel dengan ESP32 dan NOS (Standard Packet Flags & SecurityAgent).
 * UPGRADED: Mendukung Packet Fragmentation & Reassembly untuk file besar (tpkg).
 */
export class SimpleMQTNLDriver implements IDevice {
    name = "smqtnl0";

    // [LOOPBACK] Registry semua instance driver (untuk deteksi alamat lokal).
    // Dipakai supaya paket yang menuju node lokal bisa langsung di-loopback
    // tanpa harus keluar ke broker MQTT (mirip localhost).
    private static instances: SimpleMQTNLDriver[] = [];

    private client: mqtt.MqttClient | null = null;
    private logger: Logger;
    private security: SecurityAgent;
    private onMessageHandlers: Map<number, (data: any) => void> = new Map();
    private portSecurity: Map<number, SecurityAgent> = new Map();

    // Instance config
    private brokerUrl: string;
    private localAddress: string;

    // Stats
    private rxBytes: number = 0;
    private txBytes: number = 0;
    private startTime: number = Date.now();

    // Fragmentation
    private packetSize: number = 32768; // 32KB chunks
    private receivedPackets: Map<string, { total: number, received: Map<number, Buffer | string>, timestamp: number }> = new Map();

    // Pluggable Protocols
    private protocols: IMQTNLProtocol[] = [];
    private activeProtocol: IMQTNLProtocol;
    private protocolRegistry: Map<string, IMQTNLProtocol> = new Map();

    // Sniffer (bitshark): callback menangkap paket
    // TX = payload SEBELUM dienkripsi, RX = payload SETELAH dekripsi (plaintext terbaca)
    private sniffers: Array<(sniff: any) => void> = [];

    constructor(deviceName: string, brokerUrl: string, localAddress: string) {
        this.name = deviceName;
        this.brokerUrl = brokerUrl;
        this.localAddress = localAddress;

        // Daftarkan instance untuk lookup loopback
        SimpleMQTNLDriver.instances.push(this);

        this.logger = new Logger(`SimpleMQTNL (${this.name})`);
        this.security = new SecurityAgent();

        // Initialize Protocols (Pluggable)
        this.protocols = [
            new MQTNLProtocolJSON(),
            new MQTNLProtocolBinary()
        ];
        this.activeProtocol = this.protocols[0]; // Default: JSON

        // Periodically cleanup abandoned packets (older than 1 minute)
        setInterval(() => this.cleanupExpiredPackets(), 60000);
    }

    /**
     * findLocal(): Cari driver yang memiliki alamat lokal tertentu (localAddress
     * atau nama device). Dipakai untuk loopback — paket menuju alamat ini tidak
     * perlu keluar ke broker MQTT.
     */
    public static findLocal(address: string): SimpleMQTNLDriver | undefined {
        return SimpleMQTNLDriver.instances.find(
            (d) => d.localAddress === address || d.name === address,
        );
    }

    /**
     * init(ctx): Unified initialization called by Kernel.
     * Use injected boot logging functions for TSIX standard output.
     */
    public init(ctx: KContext): void {
        ctx.syslog(`Mengaktifkan Interface '${this.name}' pada ${this.localAddress} via Broker: ${this.brokerUrl}`);

        try {
            this.client = mqtt.connect(this.brokerUrl);

            this.client.on("connect", () => {
                for (const proto of this.protocols) {
                    const prefix = proto.getTopicPrefix();
                    this.client?.subscribe(`${prefix}#`);
                }
            });

            this.client.on("error", (err) => {
                this.logger.error(`MQTT Client Error: ${err.message}`);
            });

            this.client.on("message", (topic, message) => {
                this.handleIncomingMessage(topic, message);
            });
        } catch (e: any) {
            ctx.syslog(`Koneksi MQTNL Gagal: ${e.message}`);
        }
    }

    private handleIncomingMessage(topic: string, message: Buffer) {
        try {
            let packet: any;

            // Detect protocol by Magic Byte
            const magicByte = Buffer.isBuffer(message) ? message[0] : (message as string).charCodeAt(0);
            const proto = this.protocols.find(p => p.getMagicChars().includes(magicByte));
            if (!proto) {
                this.logger.error(`Protocol mismatch on ${topic}. Magic: 0x${message[0].toString(16)}`);
                return;
            }

            packet = proto.unpack(message);

            // [MULTI-PROTO] Register protocol for this sender
            this.protocolRegistry.set(packet.header.srcAddress, proto);

            // --- PACKET FILTERING ---
            const localAddr = this.localAddress;

            if (packet.header.srcAddress === localAddr && packet.header.dstAddress !== localAddr) {
                return;
            }

            if (packet.header.dstAddress !== localAddr && packet.header.dstAddress !== "*") {
                this.logger.debug(`[FILTER DROP] Packet for ${packet.header.dstAddress} dropped (Local: ${localAddr})`);
                return;
            }

            // Stats
            this.rxBytes += message.length;

            // --- REASSEMBLY LAYER ---
            const key = `${packet.header.srcAddress}:${packet.header.srcPort}->${packet.header.dstAddress}:${packet.header.dstPort}`;

            if (!this.receivedPackets.has(key)) {
                this.receivedPackets.set(key, {
                    total: packet.header.packetCount,
                    received: new Map(),
                    timestamp: Date.now()
                });
            }

            const session = this.receivedPackets.get(key)!;
            session.received.set(packet.header.packetIndex, packet.payload);
            session.timestamp = Date.now();

            if (session.received.size < session.total) {
                // Progress logging for large transfers
                if (session.total > 1) {
                    this.logger.debug(`[REASSEMBLY] Progress ${key}: ${session.received.size}/${session.total}`);
                }
                return;
            }

            // All chunks arrived!
            this.receivedPackets.delete(key);

            let assembledPayload: any;
            const entries = Array.from(session.received.entries()).sort((a, b) => a[0] - b[0]);

            if (entries.length > 0 && Buffer.isBuffer(entries[0][1])) {
                assembledPayload = Buffer.concat(entries.map(e => e[1] as Buffer));
            } else {
                assembledPayload = entries.map(e => e[1] as string).join("");
            }

            if (session.total > 1) {
                this.logger.debug(`[REASSEMBLY] Complete ${key}. Total Size: ${assembledPayload.length}`);
            }

            // --- SECURITY LAYER ---
            const dstPort = packet.header.dstPort;
            const portSec = this.portSecurity.get(dstPort) || this.security;
            const isBinary = proto.getName() === "Binary";

            let decryptedPayload: any;
            // Apakah `data` benar-benar hasil DEKRIPSI? Kalau driver tidak punya
            // session key utk port ini (mis. air-type server yang dekripsi manual
            // di app), `data` hanyalah passthrough ciphertext.
            let actuallyDecrypted = false;
            if (isBinary) {
                if (portSec.hasSessionKey()) {
                    // Ada session key utk port ini → coba decrypt otomatis.
                    decryptedPayload = portSec.securePacketInRaw(assembledPayload as Buffer);
                    if (decryptedPayload) actuallyDecrypted = true;
                } else if (Buffer.isBuffer(assembledPayload)) {
                    // TANPA session key (plain/passthrough). JANGAN panggil
                    // securePacketInRaw() — tanpa key ia melakukan
                    // buffer.toString("utf8") yang MERUSAK byte >= 0x80 (frame
                    // biner seperti TSSH, OTA, dsb) menjadi U+FFFD.
                    //
                    // Deteksi pintar: round-trip UTF-8.
                    //  - Payload teks valid (ASCII/UTF-8) → kirim string
                    //    (backward-compat utk airterm/scp/telechat/JSON dll).
                    //  - Payload binary asli (byte tidak valid UTF-8) → kirim
                    //    Buffer utuh supaya byte >= 0x80 tidak rusak.
                    const utf8 = assembledPayload.toString("utf8");
                    if (Buffer.from(utf8, "utf8").equals(assembledPayload)) {
                        decryptedPayload = utf8;
                    } else {
                        decryptedPayload = assembledPayload;
                    }
                } else {
                    // Payload sudah string sejak reassembly (kasus legacy).
                    decryptedPayload = assembledPayload;
                }

                // [FALLBACK] If decryption failed, but we are using binary protocol, 
                // permit the raw payload (Plain Mode) to support optimized OTA.
                if (!decryptedPayload && assembledPayload.length > 0) {
                    decryptedPayload = assembledPayload;
                }
            } else {
                // [PROTOCOL 1.0] Legacy path
                decryptedPayload = portSec.securePacketIn(assembledPayload as string);
                // Hanya benar 'decrypted' kalau driver punya key utk port ini
                // (portSecurity) dan hasilnya non-kosong. Tanpa key → passthrough.
                actuallyDecrypted = portSec.hasSessionKey() && !!decryptedPayload;
            }

            if (!decryptedPayload && assembledPayload.length > 0) {
                this.logger.warn(`[SECURITY] Decryption failed for ${Buffer.isBuffer(assembledPayload) ? 'binary' : 'legacy'} packet from ${packet.header.srcAddress}:${packet.header.srcPort} to port ${dstPort}.`);
                return;
            }

            // [SNIFFER] RX — `data` = hasil DEKRIPSI (plaintext, terbaca langsung),
            // `raw` = yang benar-benar tiba di wire (masih encrypted). Kernel
            // memfilter siapa dapat versi mana: root → `data`, non-root → `raw`.
            this.emitSniff({
                type: "NET_SNIFF",
                dir: "RX",
                iface: this.name,
                timestamp: Date.now(),
                srcAddress: packet.header.srcAddress,
                srcPort: packet.header.srcPort,
                dstAddress: packet.header.dstAddress,
                dstPort: packet.header.dstPort,
                flag: packet.header.packetHeaderFlag,
                protocol: isBinary ? "Binary" : "JSON",
                size: Buffer.isBuffer(decryptedPayload) ? decryptedPayload.length : String(decryptedPayload || "").length,
                data: Buffer.isBuffer(decryptedPayload) ? decryptedPayload.toString("utf8") : decryptedPayload,
                raw: Buffer.isBuffer(assembledPayload) ? assembledPayload.toString("utf8") : assembledPayload,
                decrypted: actuallyDecrypted,
            });


            // --- INTERNAL PROTOCOL HANDLING ---
            const flag = packet.header.packetHeaderFlag;

            if (flag === PacketFlags.FLAG_PING_REQUEST && dstPort === 65535) {
                this.logger.info(`Responded to PING REQUEST from ${packet.header.srcAddress}`);
                this.reply(packet, "", PacketFlags.FLAG_PING_REPLY);
                return;
            }

            if (flag === PacketFlags.FLAG_BROADCAST_PING && dstPort === 65534) {
                this.logger.info(`Responded to BROADCAST PING from ${packet.header.srcAddress}`);
                this.reply(packet, "TSIX Node", PacketFlags.FLAG_BROADCAST_REPLY);
                return;
            }

            // --- USERLAND DISPATCH ---
            const handler = this.onMessageHandlers.get(packet.header.dstPort);
            if (handler) {
                const messageObj = {
                    src: packet.header.srcAddress,
                    port: packet.header.srcPort,
                    localPort: packet.header.dstPort,
                    data: decryptedPayload,
                    isBinary: isBinary,
                    ts: Date.now()
                };

                // [EMERGENCY LOG] Track if flag survives
                this.logger.info(`[DISPATCH] Port ${packet.header.dstPort}, BinaryFlag: ${isBinary}`);

                handler(messageObj);
            }
        } catch (e: any) {
            this.logger.error(`Malformatted packet on ${topic}: ${e.message}`);
        }
    }

    private cleanupExpiredPackets() {
        const now = Date.now();
        const ttl = 30000; // 30 seconds for abandoned chunks
        for (const [key, session] of this.receivedPackets.entries()) {
            if (now - session.timestamp > ttl) {
                this.logger.warn(`[REASSEMBLY] Dropped incomplete packet from ${key} (TTL Expired)`);
                this.receivedPackets.delete(key);
            }
        }
    }


    private reply(originalPacket: any, data: any, flag: PacketFlags) {
        const addr = originalPacket.header.srcAddress;
        const port = originalPacket.header.srcPort;
        this.send(addr, port, data, flag, 65535); // Standard system port
    }

    public registerHandler(port: number, handler: (data: any) => void) {
        this.onMessageHandlers.set(port, handler);
    }

    /**
     * onSniff(): Daftarkan callback sniffer untuk interface ini (dipanggil kernel).
     */
    public onSniff(cb: (sniff: any) => void) {
        this.sniffers.push(cb);
    }

    /** emitSniff(): Sebarkan paket ke semua callback sniffer (TX/RX). */
    private emitSniff(sniff: any) {
        for (const cb of this.sniffers) {
            try { cb(sniff); } catch (_) { /* ignore */ }
        }
    }

    public unregisterHandler(port: number) {
        this.onMessageHandlers.delete(port);
        this.unregisterPortSecurity(port); // Prevent security settings from persisting
        this.logger.debug(`Handler for port ${port} unregistered.`);
    }

    /**
     * unregisterPortSecurity(): Reset security settings for a specific port.
     */
    public unregisterPortSecurity(port: number) {
        if (this.portSecurity.has(port)) {
            this.portSecurity.delete(port);
            this.logger.debug(`Security settings for port ${port} cleared.`);
        }
    }

    public async send(address: string, port: number, data: any, flag: PacketFlags = PacketFlags.FLAG_DATA, srcPort: number = 0) {
        // [LOOPBACK] Reserved alias "localhost" selalu menunjuk ke interface
        // pengirim sendiri — mirip localhost di OS sungguhan.
        if (address === "localhost") {
            address = this.localAddress;
        }

        // [LOOPBACK] Kalau tujuan adalah alamat lokal (milik node ini), kirim
        // langsung ke receiver tanpa keluar ke broker MQTT. Aplikasi userland
        // tetap menganggapnya sebagai node MQTN biasa.
        const localTarget = SimpleMQTNLDriver.findLocal(address);

        // Cek koneksi hanya untuk paket yang benar-benar keluar ke broker.
        if (!localTarget && (!this.client || !this.client.connected)) return false;

        let payload = data;
        let incoming = data;

        // [DEEP INSPECTION] Handle strings that are actually stringified decomposed buffers
        if (typeof incoming === "string" && incoming.startsWith('{"') && incoming.includes('"0":')) {
            try {
                const parsed = JSON.parse(incoming);
                if (parsed && typeof parsed === "object" && typeof parsed[0] === "number") {
                    incoming = parsed;
                }
            } catch (e) {
                // Not a valid JSON or not a buffer object, ignore
            }
        }

        // [RECONSTRUCT] Fix decomposed Buffers that converted to POJOs during transit
        if (incoming && typeof incoming === "object" && !Buffer.isBuffer(incoming)) {
            if ((incoming as any).type === "Buffer" && Array.isArray((incoming as any).data)) {
                payload = Buffer.from((incoming as any).data);
            } else if (typeof (incoming as any)[0] === "number") {
                // It's a numbered object like {"0":85, "1":0...}
                payload = Buffer.from(Object.values(incoming) as number[]);
            } else {
                payload = JSON.stringify(incoming);
            }
        } else {
            payload = incoming;
        }

        // Final safety stringification for non-buffers if they escaped the logic above
        if (typeof payload !== "string" && !Buffer.isBuffer(payload)) {
            payload = JSON.stringify(payload);
        }

        // --- PROTOCOL SELECTION ---
        // Look up registered protocol for this destination or fallback to global default
        const protocol = this.protocolRegistry.get(address) || this.activeProtocol;
        const useRaw = protocol.getName() === "Binary";
        const prefix = protocol.getTopicPrefix();

        // Security: Prioritize specific local port (e.g., 4000 for otad) then fallback to global
        let portSec = this.portSecurity.get(srcPort);
        if (!portSec) portSec = this.security;

        // [BYPASS SECURITY] If using Binary protocol (useRaw), DO NOT add security overhead.
        // This ensures the payload length matches exactly what the receiver expects (e.g. for OTA flash alignment).
        const securedPayload = useRaw ? payload : (typeof payload === "string" ? portSec.securePacketOut(payload) : JSON.stringify(payload));

        // [SNIFFER] TX — `data` = payload SEBELUM enkripsi (plaintext), `raw` = yang
        // benar-benar keluar ke wire (encrypted). Kernel memfilter siapa dapat versi
        // mana: root → `data` (plain), non-root → `raw` (encrypted).
        this.emitSniff({
            type: "NET_SNIFF",
            dir: "TX",
            iface: this.name,
            timestamp: Date.now(),
            srcAddress: this.localAddress,
            srcPort,
            dstAddress: address,
            dstPort: port,
            flag,
            protocol: useRaw ? "Binary" : "JSON",
            size: Buffer.isBuffer(payload) ? payload.length : String(payload).length,
            data: Buffer.isBuffer(payload) ? payload.toString("utf8") : payload,
            raw: Buffer.isBuffer(securedPayload) ? securedPayload.toString("utf8") : securedPayload,
            // TX: `data` = plaintext hanya kalau driver akan mengenkripsi (punya key
            // utk srcPort). Tanpa key (mis. air-type server kirim ciphertext manual),
            // `data` sebenarnya ciphertext → decrypted:false.
            decrypted: portSec.hasSessionKey(),
        });

        // --- FRAGMENTATION LAYER ---
        const chunks: (string | Buffer)[] = [];
        if (securedPayload.length === 0) {
            chunks.push(useRaw ? Buffer.alloc(0) : "");
        } else {
            for (let i = 0; i < securedPayload.length; i += this.packetSize) {
                if (typeof securedPayload === "string") {
                    chunks.push(securedPayload.substring(i, i + this.packetSize));
                } else {
                    chunks.push(securedPayload.subarray(i, i + this.packetSize));
                }
            }
        }

        const packetCount = chunks.length;
        const topic = `${prefix}${address}`;

        if (packetCount > 1) {
            this.logger.debug(`[FRAGMENTATION] Sending ${securedPayload.length} bytes in ${packetCount} chunks...`);
        }

        for (let i = 0; i < packetCount; i++) {
            const packet = {
                header: {
                    srcAddress: this.localAddress,
                    srcPort: srcPort,
                    dstAddress: address,
                    dstPort: port,
                    packetCount: packetCount,
                    packetIndex: i,
                    dataSize: securedPayload.length,
                    packetHeaderFlag: flag,
                    forwarded: 0
                },
                payload: chunks[i]
            };

            const payloadBuffer = protocol.pack(packet);
            this.txBytes += payloadBuffer.length;

            if (localTarget) {
                // [LOOPBACK] Langsung serahkan ke receiver driver lokal (tanpa broker)
                this.logger.info(`[DRIVER] MQTNL LOOPBACK -> ${address} (${payloadBuffer.length} bytes)`);
                localTarget.handleIncomingMessage(topic, payloadBuffer);
            } else {
                // Promise-based publish to ensure it's on the wire before returning
                await new Promise((resolve) => {
                    this.logger.info(`[DRIVER] MQTNL Publish to ${topic} (${payloadBuffer.length} bytes)`);
                    this.client!.publish(topic, payloadBuffer, { qos: 0, retain: false }, (err) => {
                        if (err) this.logger.error(`MQTT Publish error: ${err.message}`);
                        resolve(true);
                    });
                });
            }
        }

        return true;
    }

    public getStats() {
        return {
            deviceName: this.name,
            address: this.localAddress,
            broker: this.brokerUrl,
            params: {
                connected: this.client?.connected || false,
                rxBytes: this.rxBytes,
                txBytes: this.txBytes,
                uptime: Date.now() - this.startTime,
                binds: this.onMessageHandlers.size
            }
        };
    }

    public read(): any { return null; }
    public write(_data: any): boolean { return false; }
    public ioctl(cmd: number, arg: any): any {
        if (cmd === 0x1001) { // SMQTNL_IOCTL_UPGRADE_SECURITY
            const { port, sessionKey } = arg;
            if (port && sessionKey) {
                const agent = new SecurityAgent();
                agent.setSessionKey(sessionKey);
                this.portSecurity.set(port, agent);
                this.logger.info(`✅ SECURITY UPGRADED for port ${port}. ChaCha20-Poly1305 is now ACTIVE.`);
                return true;
            }
        }
        if (cmd === 0x1002) { // SMQTNL_IOCTL_SET_BINARY_MODE
            const mode = !!arg;
            this.activeProtocol = mode ?
                this.protocols.find(p => p.getName() === "Binary")! :
                this.protocols.find(p => p.getName() === "JSON")!;

            this.logger.info(`Interface ${this.name} protocol switched to: ${this.activeProtocol.getName()}`);
            return true;
        }
        return true;
    }
}

export default SimpleMQTNLDriver;
