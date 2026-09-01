import * as mqtt from "mqtt";

/**
 * PACKET FORWARDER (Broker Bridge)
 *
 * Bridges MQTNL traffic between two different MQTT brokers.
 * Mirrors ALL MQTNL protocol versions bidirectional, byte-exact:
 *   - v1.0 JSON   (mqtnl@1.0/, magic '[' 0x5B)
 *   - v1.1 Binary (mqtnl@1.1/, magic 'B' 0x42 — OTA)
 *   - v1.2 Binfeo (mqtnl@1.2/, magic 'f' 0x66 — biner terenkripsi)
 */
const MQTNL_TOPICS = ["mqtnl@1.0/#", "mqtnl@1.1/#", "mqtnl@1.2/#"];

/** Batas hop `forwarded` — paket dibuang bila sudah melewati MAX bridge (anti-loop). */
const MAX_FORWARD = 3;

export class PacketForwarder {
    private clientA: mqtt.MqttClient | null = null;
    private clientB: mqtt.MqttClient | null = null;
    private topics: string[] = MQTNL_TOPICS;
    private isRunning: boolean = false;

    // Config
    private brokerAUrl: string;
    private brokerBUrl: string;

    // Stats
    private packetsAtoB: number = 0;
    private packetsBtoA: number = 0;
    private bytesAtoB: number = 0;
    private bytesBtoA: number = 0;
    private startTime: number = 0;

    constructor(brokerA: string, brokerB: string) {
        this.brokerAUrl = this.ensureMqttProtocol(brokerA);
        this.brokerBUrl = this.ensureMqttProtocol(brokerB);
    }

    private ensureMqttProtocol(url: string): string {
        if (!url.startsWith("mqtt://") && !url.startsWith("ws://") && !url.startsWith("wss://")) {
            return `mqtt://${url}`;
        }
        return url;
    }

    /**
     * startForward(): Connect to both brokers and start mirroring
     */
    public async startForward(): Promise<boolean> {
        if (this.isRunning) return false;

        try {
            this.clientA = mqtt.connect(this.brokerAUrl);
            this.clientB = mqtt.connect(this.brokerBUrl);
            this.startTime = Date.now();

            // --- Broker A Setup ---
            this.clientA.on("connect", () => {
                console.log(`[PacketForwarder] Connected to Broker A: ${this.brokerAUrl}`);
                this.subscribeAll(this.clientA);
            });

            this.clientA.on("message", (topic, message) => {
                this.bridge(message, topic, this.clientB, "A->B");
            });

            // --- Broker B Setup ---
            this.clientB.on("connect", () => {
                console.log(`[PacketForwarder] Connected to Broker B: ${this.brokerBUrl}`);
                this.subscribeAll(this.clientB);
            });

            this.clientB.on("message", (topic, message) => {
                this.bridge(message, topic, this.clientA, "B->A");
            });

            this.clientA.on("error", (e) => console.error(`[Broker A] Error: ${e.message}`));
            this.clientB.on("error", (e) => console.error(`[Broker B] Error: ${e.message}`));

            this.isRunning = true;
            return true;
        } catch (e: any) {
            console.error(`[PacketForwarder] Start failed: ${e.message}`);
            return false;
        }
    }

    /**
     * bridge(): Forward packets from one broker to another.
     * Payload diteruskan byte-exact (tanpa re-encode) — hanya counter
     * `forwarded` di header yang di-increment untuk loop prevention.
     */
    private bridge(message: Buffer, topic: string, targetClient: mqtt.MqttClient | null, direction: string) {
        if (!targetClient || !targetClient.connected) return;

        const next = this.nextHop(message, topic);
        if (!next) return; // bukan MQTNL / forwarded sudah ≥ MAX_FORWARD → drop

        targetClient.publish(topic, next, (err) => {
            if (!err) {
                if (direction === "A->B") {
                    this.packetsAtoB++;
                    this.bytesAtoB += next.length;
                } else {
                    this.packetsBtoA++;
                    this.bytesBtoA += next.length;
                }

                // Periodic reporting
                const total = this.packetsAtoB + this.packetsBtoA;
                if (total % 100 === 0) {
                    console.log(`[PacketForwarder] Bridged: A->B: ${this.packetsAtoB} pkts, B->A: ${this.packetsBtoA} pkts`);
                }
            }
        });
    }

    /** Subscribe ke semua prefix protokol MQTNL. */
    private subscribeAll(client: mqtt.MqttClient | null) {
        for (const t of this.topics) {
            client?.subscribe(t);
        }
    }

    /**
     * nextHop(): validasi protokol + increment counter `forwarded` (loop prevention),
     * mengembalikan Buffer siap-teruskan, atau null bila paket di-drop.
     * Bekerja di level byte → payload biner/terenkripsi (OTA/Binfeo) tetap utuh.
     */
    private nextHop(message: Buffer, topic: string): Buffer | null {
        // ── v1.0 JSON: forwarded = elemen ke-8 dari array MQTNL ──
        if (topic.startsWith("mqtnl@1.0/")) {
            try {
                const arr = JSON.parse(message.toString("utf8"));
                const fwd = arr[8] || 0;
                if (fwd >= MAX_FORWARD) return null;
                arr[8] = fwd + 1;
                return Buffer.from(JSON.stringify(arr), "utf8");
            } catch {
                return null; // bukan JSON MQTNL yang valid → drop
            }
        }

        // ── v1.1 Binary (0x42) / v1.2 Binfeo (0x66): forwarded = byte ke-(17+srcLen+dstLen) ──
        const magic = message[0];
        if ((magic === 0x42 || magic === 0x66) && message[1] === 0x01 && message.length >= 6) {
            const srcLen = message[2];
            const dstLenPos = 5 + srcLen; // magic(2)+srcLen(1)+srcAddr(srcLen)+srcPort(2) → dstLen
            if (dstLenPos >= message.length) return null;
            const dstLen = message[dstLenPos];
            const fwdPos = 17 + srcLen + dstLen;
            if (fwdPos >= message.length) return null;
            const fwd = message[fwdPos];
            if (fwd >= MAX_FORWARD) return null;
            const out = Buffer.from(message); // salinan — patch 1 byte `forwarded`
            out[fwdPos] = fwd + 1;
            return out;
        }

        return null; // protokol tak dikenal → jangan diteruskan
    }

    /**
     * stopForward(): Disconnect from both brokers
     */
    public async stopForward(): Promise<boolean> {
        if (!this.isRunning) return false;

        try {
            if (this.clientA) await new Promise<void>(r => this.clientA!.end(false, () => r()));
            if (this.clientB) await new Promise<void>(r => this.clientB!.end(false, () => r()));

            this.isRunning = false;
            console.log(`[PacketForwarder] Bridge stopped. Stats: A->B: ${this.packetsAtoB}, B->A: ${this.packetsBtoA}`);
            return true;
        } catch (e: any) {
            console.error(`[PacketForwarder] Stop failed: ${e.message}`);
            return false;
        }
    }

    public getStats() {
        return {
            brokerA: this.brokerAUrl,
            brokerB: this.brokerBUrl,
            isRunning: this.isRunning,
            packetsAtoB: this.packetsAtoB,
            packetsBtoA: this.packetsBtoA,
            bytesAtoB: this.bytesAtoB,
            bytesBtoA: this.bytesBtoA,
            uptime: this.isRunning ? Date.now() - this.startTime : 0
        };
    }

}
