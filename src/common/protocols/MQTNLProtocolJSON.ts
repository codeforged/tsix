import { IMQTNLProtocol } from "./IMQTNLProtocol";

/**
 * MQTNLProtocolJSON (Legacy Standard)
 * 
 * Format: JSON Array [srcA, srcP, dstA, dstP, cnt, idx, sz, flg, fwd, payload]
 */
export class MQTNLProtocolJSON implements IMQTNLProtocol {
    getName(): string { return "JSON"; }
    getMagicChars(): number[] { return [0x5B]; } // '['
    getTopicPrefix(): string { return "mqtnl@1.0/"; }

    /**
     * pack(): Merubah paket internal menjadi JSON Array (string).
     */
    pack(packet: any): string {
        return JSON.stringify([
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
        ]);
    }

    /**
     * unpack(): Merubah JSON Array (string) menjadi paket internal.
     */
    unpack(data: Buffer | string): any {
        const str = Buffer.isBuffer(data) ? data.toString("utf8") : data;
        const packed = JSON.parse(str);
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
                forwarded: packed[8],
            },
            payload: packed[9],
        };
    }
}
