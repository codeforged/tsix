import * as mqtt from "mqtt";

/**
 * PACKET FORWARDER (Broker Bridge)
 * 
 * Bridges MQTNL traffic between two different MQTT brokers.
 * Mirrors all traffic on mqtnl@1.0/# bidirectional.
 */
export class PacketForwarder {
    private clientA: mqtt.MqttClient | null = null;
    private clientB: mqtt.MqttClient | null = null;
    private wildcardTopic = "mqtnl@1.0/#";
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
                this.clientA?.subscribe(this.wildcardTopic);
            });

            this.clientA.on("message", (topic, message) => {
                this.bridge(message, topic, this.clientB, "A->B");
            });

            // --- Broker B Setup ---
            this.clientB.on("connect", () => {
                console.log(`[PacketForwarder] Connected to Broker B: ${this.brokerBUrl}`);
                this.clientB?.subscribe(this.wildcardTopic);
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
     * bridge(): Forward packets from one broker to another
     */
    private bridge(message: Buffer, topic: string, targetClient: mqtt.MqttClient | null, direction: string) {
        if (!targetClient || !targetClient.connected) return;

        try {
            const packed = JSON.parse(message.toString());
            const packet = this.unpack(packed);

            // 1. Loop Prevention (MQTNL Header)
            if (packet.header.forwarded >= 3) {
                // Drop packet silently to avoid log flooding
                return;
            }

            // 2. Increment forward counter
            packet.header.forwarded = (packet.header.forwarded || 0) + 1;

            // 3. Republish
            const newPacked = this.pack(packet);
            const payload = JSON.stringify(newPacked);

            targetClient.publish(topic, payload, (err) => {
                if (!err) {
                    if (direction === "A->B") {
                        this.packetsAtoB++;
                        this.bytesAtoB += payload.length;
                    } else {
                        this.packetsBtoA++;
                        this.bytesBtoA += payload.length;
                    }

                    // Periodic reporting
                    const total = this.packetsAtoB + this.packetsBtoA;
                    if (total % 100 === 0) {
                        console.log(`[PacketForwarder] Bridged: A->B: ${this.packetsAtoB} pkts, B->A: ${this.packetsBtoA} pkts`);
                    }
                }
            });
        } catch (e) {
            // Ignore malformed packets that are not MQTNL format
        }
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

    private pack(packet: any): any[] {
        return [
            packet.header.srcAddress,
            packet.header.srcPort,
            packet.header.dstAddress,
            packet.header.dstPort,
            packet.header.packetCount,
            packet.header.packetIndex,
            packet.header.dataSize,
            packet.header.packetHeaderFlag,
            packet.header.forwarded,
            packet.payload,
        ];
    }

    private unpack(packed: any[]): any {
        return {
            header: {
                srcAddress: packed[0],
                srcPort: packed[1],
                dstAddress: packed[2],
                dstPort: packed[3],
                packetCount: packed[4],
                packetIndex: packed[5],
                dataSize: packed[6],
                packetHeaderFlag: packed[7],
                forwarded: packed[8] || 0,
            },
            payload: packed[9],
        };
    }
}
