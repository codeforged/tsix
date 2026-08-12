import { describe, it, expect } from "vitest";
import { MQTNLProtocolJSON } from "./MQTNLProtocolJSON";

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

describe("MQTNLProtocolJSON (E1)", () => {
    let proto: MQTNLProtocolJSON;
    beforeEach(() => { proto = new MQTNLProtocolJSON(); });

    it("E1.01 Encode – valid message to JSON string", () => {
        const packed = proto.pack(SAMPLE_PACKET);
        expect(typeof packed).toBe("string");
        const parsed = JSON.parse(packed as string);
        expect(Array.isArray(parsed)).toBe(true);
    });

    it("E1.02 Encode – JSON array has 10 elements (all header + payload)", () => {
        const packed = JSON.parse(proto.pack(SAMPLE_PACKET) as string);
        expect(packed.length).toBe(10);
    });

    it("E1.03 Encode – empty payload", () => {
        const pkt = { ...SAMPLE_PACKET, payload: "" };
        const packed = proto.pack(pkt);
        const parsed = JSON.parse(packed as string);
        expect(parsed[9]).toBe("");
    });

    it("E1.04 Encode – large payload", () => {
        const large = "x".repeat(10000);
        const pkt = { ...SAMPLE_PACKET, payload: large };
        const packed = proto.pack(pkt);
        const parsed = JSON.parse(packed as string);
        expect(parsed[9]).toBe(large);
    });

    it("E1.05 Encode – special characters in payload", () => {
        const pkt = { ...SAMPLE_PACKET, payload: "こんにちは 🔥 <>&\"'" };
        const packed = proto.pack(pkt);
        const parsed = JSON.parse(packed as string);
        expect(parsed[9]).toBe("こんにちは 🔥 <>&\"'");
    });

    it("E1.06 Encode – null payload field handled", () => {
        const pkt = { ...SAMPLE_PACKET, payload: null };
        const packed = proto.pack(pkt);
        const parsed = JSON.parse(packed as string);
        expect(parsed[9]).toBeNull();
    });

    it("E1.07 Encode – srcPort and dstPort preserved as numbers", () => {
        const packed = JSON.parse(proto.pack(SAMPLE_PACKET) as string);
        expect(packed[1]).toBe(5001); // srcPort
        expect(packed[3]).toBe(5002); // dstPort
    });

    it("E1.08 Decode – valid JSON to message object", () => {
        const packed = proto.pack(SAMPLE_PACKET);
        const unpacked = proto.unpack(packed);
        expect(unpacked.header.srcAddress).toBe("node-A");
        expect(unpacked.header.dstAddress).toBe("node-B");
        expect(unpacked.payload).toBe("hello");
    });

    it("E1.09 Decode – invalid JSON throws", () => {
        expect(() => proto.unpack("not valid json")).toThrow();
    });

    it("E1.10 Decode – missing required fields (uses positions, might be undefined)", () => {
        const malformed = JSON.stringify(["node-A"]);
        const unpacked = proto.unpack(malformed);
        expect(unpacked.header.srcAddress).toBe("node-A");
        expect(unpacked.header.srcPort).toBeUndefined();
    });

    it("E1.11 Decode – from Buffer input", () => {
        const packed = proto.pack(SAMPLE_PACKET);
        const buf = Buffer.from(packed as string, "utf8");
        const unpacked = proto.unpack(buf);
        expect(unpacked.header.srcAddress).toBe("node-A");
    });

    it("E1.12 Decode – wrong structure (non-array JSON) throws or returns bad data", () => {
        const jsonStr = JSON.stringify({ key: "value" });
        const unpacked = proto.unpack(jsonStr);
        // Non-array: positions are undefined
        expect(unpacked.header.srcAddress).toBeUndefined();
    });

    it("E1.13 Roundtrip – encode then decode", () => {
        const packed = proto.pack(SAMPLE_PACKET);
        const unpacked = proto.unpack(packed);
        expect(unpacked.header.srcAddress).toBe(SAMPLE_PACKET.header.srcAddress);
        expect(unpacked.header.srcPort).toBe(SAMPLE_PACKET.header.srcPort);
        expect(unpacked.header.dstAddress).toBe(SAMPLE_PACKET.header.dstAddress);
        expect(unpacked.header.dstPort).toBe(SAMPLE_PACKET.header.dstPort);
        expect(unpacked.header.packetCount).toBe(SAMPLE_PACKET.header.packetCount);
        expect(unpacked.header.packetIndex).toBe(SAMPLE_PACKET.header.packetIndex);
        expect(unpacked.header.dataSize).toBe(SAMPLE_PACKET.header.dataSize);
        expect(unpacked.header.packetHeaderFlag).toBe(SAMPLE_PACKET.header.packetHeaderFlag);
        expect(unpacked.header.forwarded).toBe(SAMPLE_PACKET.header.forwarded);
        expect(unpacked.payload).toBe(SAMPLE_PACKET.payload);
    });

    it("E1.14 Roundtrip – all message types (flag variations)", () => {
        for (let flag = 0; flag <= 4; flag++) {
            const pkt = { ...SAMPLE_PACKET, header: { ...SAMPLE_PACKET.header, packetHeaderFlag: flag } };
            const unpacked = proto.unpack(proto.pack(pkt));
            expect(unpacked.header.packetHeaderFlag).toBe(flag);
        }
    });

    it("E1.15 Roundtrip – edge case payloads (empty, whitespace, unicode)", () => {
        for (const payload of ["", "   ", "日本語", "null", "undefined"]) {
            const pkt = { ...SAMPLE_PACKET, payload };
            const unpacked = proto.unpack(proto.pack(pkt));
            expect(unpacked.payload).toBe(payload);
        }
    });

    it("E1.16 Performance – encode 1000 packets under 500ms", () => {
        const start = Date.now();
        for (let i = 0; i < 1000; i++) proto.pack(SAMPLE_PACKET);
        expect(Date.now() - start).toBeLessThan(500);
    });

    it("E1.17 Performance – decode 1000 packets under 500ms", () => {
        const packed = proto.pack(SAMPLE_PACKET);
        const start = Date.now();
        for (let i = 0; i < 1000; i++) proto.unpack(packed);
        expect(Date.now() - start).toBeLessThan(500);
    });

    it("E1.18 Binary safety – null bytes in payload via JSON (escaped)", () => {
        const pkt = { ...SAMPLE_PACKET, payload: "a\x00b" };
        const unpacked = proto.unpack(proto.pack(pkt));
        expect(unpacked.payload).toBe("a\x00b");
    });

    it("E1.19 Unicode – all code points preserved", () => {
        const unicodeStr = "🌏🌍🌎你好세계";
        const pkt = { ...SAMPLE_PACKET, payload: unicodeStr };
        const unpacked = proto.unpack(proto.pack(pkt));
        expect(unpacked.payload).toBe(unicodeStr);
    });

    it("E1.20 Schema validation – valid message passes parse", () => {
        const packed = proto.pack(SAMPLE_PACKET);
        expect(() => JSON.parse(packed as string)).not.toThrow();
    });

    it("E1.21 Schema validation – invalid message throws on unpack", () => {
        expect(() => proto.unpack("not-json-at-all!")).toThrow();
    });

    it("E1.22 Timestamp handling – forwarded field preserved", () => {
        const pkt = { ...SAMPLE_PACKET, header: { ...SAMPLE_PACKET.header, forwarded: 1 } };
        const unpacked = proto.unpack(proto.pack(pkt));
        expect(unpacked.header.forwarded).toBe(1);
    });

    it("E1.23 Node ID handling – srcAddress and dstAddress preserved", () => {
        const pkt = { ...SAMPLE_PACKET, header: { ...SAMPLE_PACKET.header, srcAddress: "sensor-001", dstAddress: "server-001" } };
        const unpacked = proto.unpack(proto.pack(pkt));
        expect(unpacked.header.srcAddress).toBe("sensor-001");
        expect(unpacked.header.dstAddress).toBe("server-001");
    });

    it("E1.24 Sensor data message format – dataSize matches payload length", () => {
        const sensorPayload = "temperature=25.5";
        const pkt = {
            ...SAMPLE_PACKET,
            header: { ...SAMPLE_PACKET.header, packetHeaderFlag: 0, dataSize: sensorPayload.length },
            payload: sensorPayload
        };
        const unpacked = proto.unpack(proto.pack(pkt));
        expect(unpacked.header.dataSize).toBe(sensorPayload.length);
        expect(unpacked.payload).toBe(sensorPayload);
    });

    it("E1.25 Relay command message format – flag 0 = FLAG_DATA", () => {
        const pkt = { ...SAMPLE_PACKET, header: { ...SAMPLE_PACKET.header, packetHeaderFlag: 0 }, payload: "RELAY_ON" };
        const unpacked = proto.unpack(proto.pack(pkt));
        expect(unpacked.header.packetHeaderFlag).toBe(0);
        expect(unpacked.payload).toBe("RELAY_ON");
    });

    it("E1.26 Protocol info – getName returns 'JSON'", () => {
        expect(proto.getName()).toBe("JSON");
    });

    it("E1.27 Protocol info – getMagicChars returns [0x5B]", () => {
        expect(proto.getMagicChars()).toEqual([0x5B]);
    });

    it("E1.28 Protocol info – getTopicPrefix is string", () => {
        expect(typeof proto.getTopicPrefix()).toBe("string");
        expect(proto.getTopicPrefix()).toBe("mqtnl@1.0/");
    });
});

// needed for beforeEach
import { beforeEach } from "vitest";
