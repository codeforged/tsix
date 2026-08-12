import { IMQTNLProtocol } from "./IMQTNLProtocol";

/**
 * MQTNLProtocolBinary (v1.0 Compact)
 * 
 * Format: [MAGIC: 0x42 0x01] [S_ADDR_LEN: 1] [S_ADDR...] [S_PORT: 2] [D_ADDR_LEN: 1] [D_ADDR...] [D_PORT: 2] ...
 */
export class MQTNLProtocolBinary implements IMQTNLProtocol {
    getName(): string { return "Binary"; }
    getMagicChars(): number[] { return [0x42]; } // 'B'
    getTopicPrefix(): string { return "mqtnl@1.1/"; }

    /**
     * pack(): Merubah paket internal menjadi Buffer biner yang kompak.
     */
    pack(packet: any): Buffer {
        const srcAddr = Buffer.from(packet.header.srcAddress || "", "utf8");
        const dstAddr = Buffer.from(packet.header.dstAddress || "", "utf8");
        const payload = Buffer.isBuffer(packet.payload) ? packet.payload : Buffer.from(packet.payload || "", "utf8");

        const headerSize = 2 + 1 + srcAddr.length + 2 + 1 + dstAddr.length + 2 + 2 + 2 + 4 + 1 + 1;
        const buf = Buffer.alloc(headerSize + payload.length);
        let offset = 0;
        buf.writeUInt8(0x42, offset++); // Magic 'B'
        buf.writeUInt8(0x01, offset++); // Proto Ver 1
        buf.writeUInt8(srcAddr.length, offset++);
        srcAddr.copy(buf, offset);
        offset += srcAddr.length;
        buf.writeUInt16LE(packet.header.srcPort, offset);
        offset += 2;
        buf.writeUInt8(dstAddr.length, offset++);
        dstAddr.copy(buf, offset);
        offset += dstAddr.length;
        buf.writeUInt16LE(packet.header.dstPort, offset);
        offset += 2;
        buf.writeUInt16LE(packet.header.packetCount, offset);
        offset += 2;
        buf.writeUInt16LE(packet.header.packetIndex, offset);
        offset += 2;
        buf.writeUInt32LE(packet.header.dataSize, offset);
        offset += 4;
        buf.writeUInt8(packet.header.packetHeaderFlag, offset++);
        buf.writeUInt8(packet.header.forwarded, offset++);
        payload.copy(buf, offset);
        return buf;
    }

    /**
     * unpack(): Merubah Buffer biner kembali menjadi paket internal.
     */
    unpack(data: Buffer | string): any {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
        
        let offset = 0;
        if (buffer.readUInt8(offset++) !== 0x42) throw new Error("Invalid Magic Byte");
        if (buffer.readUInt8(offset++) !== 0x01) throw new Error("Invalid Protocol Version");

        const srcAddrLen = buffer.readUInt8(offset++);
        const srcAddress = buffer.subarray(offset, offset + srcAddrLen).toString("utf8");
        offset += srcAddrLen;
        const srcPort = buffer.readUInt16LE(offset);
        offset += 2;

        const dstAddrLen = buffer.readUInt8(offset++);
        const dstAddress = buffer.subarray(offset, offset + dstAddrLen).toString("utf8");
        offset += dstAddrLen;
        const dstPort = buffer.readUInt16LE(offset);
        offset += 2;

        const packetCount = buffer.readUInt16LE(offset);
        offset += 2;
        const packetIndex = buffer.readUInt16LE(offset);
        offset += 2;
        const dataSize = buffer.readUInt32LE(offset);
        offset += 4;
        const packetHeaderFlag = buffer.readUInt8(offset++);
        const forwarded = buffer.readUInt8(offset++);
        const payload = buffer.subarray(offset);

        return {
            header: {
                srcAddress, srcPort, dstAddress, dstPort,
                packetCount, packetIndex, dataSize,
                packetHeaderFlag, forwarded
            },
            payload: payload
        };
    }
}
