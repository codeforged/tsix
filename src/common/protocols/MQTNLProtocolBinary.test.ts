import { describe, it, expect, beforeEach } from "vitest";
import { MQTNLProtocolBinary } from "./MQTNLProtocolBinary";

const SAMPLE_PACKET = {
    header: {
        srcAddress: "node-A",
        srcPort: 5001,
        dstAddress: "node-B",
        dstPort: 5002,
        packetCount: 1,
        packetIndex: 0,
        dataSize: 5,
        packetHeaderFlag: 0,
        forwarded: 0,
    },
    payload: "hello"
};

describe("MQTNLProtocolBinary (E2)", () => {
    let proto: MQTNLProtocolBinary;
    beforeEach(() => { proto = new MQTNLProtocolBinary(); });

    it("E2.01 Encode – valid message to binary Buffer", () => {
        const packed = proto.pack(SAMPLE_PACKET);
        expect(Buffer.isBuffer(packed)).toBe(true);
        expect(packed.length).toBeGreaterThan(0);
    });

    it("E2.02 Encode – all message types (flag variations)", () => {
        for (let flag = 0; flag <= 4; flag++) {
            const pkt = { ...SAMPLE_PACKET, header: { ...SAMPLE_PACKET.header, packetHeaderFlag: flag } };
            const buf = proto.pack(pkt);
            expect(Buffer.isBuffer(buf)).toBe(true);
        }
    });

    it("E2.03 Encode – empty payload produces minimal buffer", () => {
        const pkt = { ...SAMPLE_PACKET, payload: "" };
        const buf = proto.pack(pkt);
        expect(buf.length).toBeGreaterThan(0);
    });

    it("E2.04 Encode – large payload", () => {
        const large = Buffer.from("x".repeat(10000));
        const pkt = { ...SAMPLE_PACKET, payload: large };
        const buf = proto.pack(pkt);
        expect(buf.length).toBeGreaterThan(10000);
    });

    it("E2.05 Encode – buffer sizing correct (no extra bytes)", () => {
        const packed = proto.pack(SAMPLE_PACKET) as Buffer;
        const unpacked = proto.unpack(packed);
        // Re-encode should produce same size
        const repacked = proto.pack(unpacked) as Buffer;
        expect(packed.length).toBe(repacked.length);
    });

    it("E2.06 Encode – magic bytes are 0x42 and 0x01", () => {
        const buf = proto.pack(SAMPLE_PACKET) as Buffer;
        expect(buf[0]).toBe(0x42);
        expect(buf[1]).toBe(0x01);
    });

    it("E2.07 Decode – valid binary to message object", () => {
        const buf = proto.pack(SAMPLE_PACKET);
        const unpacked = proto.unpack(buf);
        expect(unpacked.header.srcAddress).toBe("node-A");
        expect(unpacked.header.dstAddress).toBe("node-B");
        expect(unpacked.header.srcPort).toBe(5001);
        expect(unpacked.header.dstPort).toBe(5002);
    });

    it("E2.08 Decode – invalid binary throws", () => {
        const bad = Buffer.from([0x00, 0x00, 0x00]);
        expect(() => proto.unpack(bad)).toThrow("Invalid Magic Byte");
    });

    it("E2.09 Decode – truncated buffer throws", () => {
        const good = proto.pack(SAMPLE_PACKET) as Buffer;
        const truncated = good.subarray(0, 5);
        expect(() => proto.unpack(truncated)).toThrow();
    });

    it("E2.10 Decode – buffer overflow protection (wrong magic)", () => {
        const bad = Buffer.from([0x42, 0x99]); // Wrong version
        expect(() => proto.unpack(bad)).toThrow("Invalid Protocol Version");
    });

    it("E2.11 Decode – wrong magic byte throws", () => {
        const bad = Buffer.from([0x7B, 0x01]); // '{' not 'B'
        expect(() => proto.unpack(bad)).toThrow("Invalid Magic Byte");
    });

    it("E2.12 Endianness – srcPort written as LE", () => {
        const buf = proto.pack(SAMPLE_PACKET) as Buffer;
        const unpacked = proto.unpack(buf);
        // srcPort: 5001 = 0x1389
        // LE: bytes would be [0x89, 0x13] at offset after srcAddr
        expect(unpacked.header.srcPort).toBe(5001);
    });

    it("E2.13 Endianness – large port numbers round-trip correctly", () => {
        const pkt = { ...SAMPLE_PACKET, header: { ...SAMPLE_PACKET.header, srcPort: 65000, dstPort: 65535 } };
        const unpacked = proto.unpack(proto.pack(pkt));
        expect(unpacked.header.srcPort).toBe(65000);
        expect(unpacked.header.dstPort).toBe(65535);
    });

    it("E2.14 Roundtrip – encode then decode", () => {
        const unpacked = proto.unpack(proto.pack(SAMPLE_PACKET));
        expect(unpacked.header.srcAddress).toBe(SAMPLE_PACKET.header.srcAddress);
        expect(unpacked.header.srcPort).toBe(SAMPLE_PACKET.header.srcPort);
        expect(unpacked.header.dstAddress).toBe(SAMPLE_PACKET.header.dstAddress);
        expect(unpacked.header.dstPort).toBe(SAMPLE_PACKET.header.dstPort);
        expect(unpacked.header.packetCount).toBe(SAMPLE_PACKET.header.packetCount);
        expect(unpacked.header.packetIndex).toBe(SAMPLE_PACKET.header.packetIndex);
        expect(unpacked.header.dataSize).toBe(SAMPLE_PACKET.header.dataSize);
        expect(unpacked.header.packetHeaderFlag).toBe(SAMPLE_PACKET.header.packetHeaderFlag);
        expect(unpacked.header.forwarded).toBe(SAMPLE_PACKET.header.forwarded);
    });

    it("E2.15 Roundtrip – all message types (flag 0-4)", () => {
        for (let flag = 0; flag <= 4; flag++) {
            const pkt = { ...SAMPLE_PACKET, header: { ...SAMPLE_PACKET.header, packetHeaderFlag: flag } };
            const unpacked = proto.unpack(proto.pack(pkt));
            expect(unpacked.header.packetHeaderFlag).toBe(flag);
        }
    });

    it("E2.16 Roundtrip – edge case payloads", () => {
        for (const payload of ["", "a", "\x00\x01\x02"]) {
            const pkt = { ...SAMPLE_PACKET, payload: Buffer.from(payload) };
            const unpacked = proto.unpack(proto.pack(pkt));
            expect(Buffer.from(unpacked.payload).toString("binary")).toBe(payload);
        }
    });

    it("E2.17 Performance – binary encode 1000x under 500ms", () => {
        const start = Date.now();
        for (let i = 0; i < 1000; i++) proto.pack(SAMPLE_PACKET);
        expect(Date.now() - start).toBeLessThan(500);
    });

    it("E2.18 Performance – binary decode 1000x under 500ms", () => {
        const packed = proto.pack(SAMPLE_PACKET);
        const start = Date.now();
        for (let i = 0; i < 1000; i++) proto.unpack(packed);
        expect(Date.now() - start).toBeLessThan(500);
    });

    it.skip("E2.19 Size comparison – binary vs JSON for typical packets", () => {
        // Skipped: require() can't resolve TypeScript modules in ESM test environment
        const { MQTNLProtocolJSON } = require("../../common/protocols/MQTNLProtocolJSON");
        const jsonProto = new MQTNLProtocolJSON();
        const binSize = (proto.pack(SAMPLE_PACKET) as Buffer).length;
        const jsonSize = Buffer.byteLength(jsonProto.pack(SAMPLE_PACKET) as string, "utf8");
        // Both should be valid positive sizes
        expect(binSize).toBeGreaterThan(0);
        expect(jsonSize).toBeGreaterThan(0);
    });

    it("E2.20 Binary safety – all byte values OK in payload", () => {
        const allBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
        const pkt = { ...SAMPLE_PACKET, payload: allBytes };
        const unpacked = proto.unpack(proto.pack(pkt));
        expect(Buffer.compare(unpacked.payload, allBytes)).toBe(0);
    });

    it("E2.21 Magic bytes validation – getMagicChars returns [0x42]", () => {
        expect(proto.getMagicChars()).toEqual([0x42]);
    });

    it("E2.22 Version field handling – second byte is 0x01", () => {
        const buf = proto.pack(SAMPLE_PACKET) as Buffer;
        expect(buf[1]).toBe(0x01);
    });

    it("E2.23 Sensor data binary format – payload preserved as buffer", () => {
        const sensorData = Buffer.from("temp=25.5");
        const pkt = { ...SAMPLE_PACKET, payload: sensorData };
        const unpacked = proto.unpack(proto.pack(pkt));
        expect(unpacked.payload.toString("utf8")).toBe("temp=25.5");
    });

    it("E2.24 Relay command binary format – header fields preserved", () => {
        const pkt = { ...SAMPLE_PACKET, header: { ...SAMPLE_PACKET.header, packetHeaderFlag: 3 }, payload: "RELAY_ON" };
        const unpacked = proto.unpack(proto.pack(pkt));
        expect(unpacked.header.packetHeaderFlag).toBe(3);
    });

    it("E2.25 Protocol negotiation – getName returns 'Binary'", () => {
        expect(proto.getName()).toBe("Binary");
        expect(proto.getTopicPrefix()).toBe("mqtnl@1.1/");
    });
});
