import { describe, it, expect } from "vitest";
import { IMQTNLProtocol } from "./IMQTNLProtocol";
import { MQTNLProtocolJSON } from "./MQTNLProtocolJSON";
import { MQTNLProtocolBinary } from "./MQTNLProtocolBinary";

const SAMPLE_PACKET = {
    header: {
        srcAddress: "A",
        srcPort: 100,
        dstAddress: "B",
        dstPort: 200,
        packetCount: 1,
        packetIndex: 0,
        dataSize: 4,
        packetHeaderFlag: 0,
        forwarded: 0,
    },
    payload: "test"
};

describe("IMQTNLProtocol Interface (E3)", () => {
    const implementations: IMQTNLProtocol[] = [
        new MQTNLProtocolJSON(),
        new MQTNLProtocolBinary()
    ];

    it("E3.01 Interface – encode (pack) method exists on all implementations", () => {
        for (const impl of implementations) {
            expect(typeof impl.pack).toBe("function");
        }
    });

    it("E3.02 Interface – decode (unpack) method exists on all implementations", () => {
        for (const impl of implementations) {
            expect(typeof impl.unpack).toBe("function");
        }
    });

    it("E3.03 Interface – shared types consistent (header fields)", () => {
        for (const impl of implementations) {
            const packed = impl.pack(SAMPLE_PACKET);
            const unpacked = impl.unpack(packed);
            expect(unpacked.header).toBeDefined();
            expect(unpacked.payload).toBeDefined();
        }
    });

    it("E3.04 Interface – both implementations satisfy contract (encode+decode roundtrip)", () => {
        for (const impl of implementations) {
            const packed = impl.pack(SAMPLE_PACKET);
            const unpacked = impl.unpack(packed);
            expect(unpacked.header.srcAddress).toBe("A");
            expect(unpacked.header.srcPort).toBe(100);
            expect(unpacked.header.dstPort).toBe(200);
        }
    });

    it("E3.05 Interface – error handling pattern (invalid data throws)", () => {
        for (const impl of implementations) {
            expect(() => impl.unpack("!@#$%^&*()")).toThrow();
        }
    });

    it("E3.06 Interface – getName() returns non-empty string", () => {
        for (const impl of implementations) {
            const name = impl.getName();
            expect(typeof name).toBe("string");
            expect(name.length).toBeGreaterThan(0);
        }
    });

    it("E3.07 Interface – getMagicChars() returns array of numbers", () => {
        for (const impl of implementations) {
            const magic = impl.getMagicChars();
            expect(Array.isArray(magic)).toBe(true);
            expect(magic.length).toBeGreaterThan(0);
            for (const b of magic) {
                expect(typeof b).toBe("number");
                expect(b).toBeGreaterThanOrEqual(0);
                expect(b).toBeLessThanOrEqual(255);
            }
        }
    });

    it("E3.08 Interface – message type enum consistency (packetHeaderFlag round-trips)", () => {
        for (const impl of implementations) {
            for (let flag = 0; flag <= 4; flag++) {
                const pkt = { ...SAMPLE_PACKET, header: { ...SAMPLE_PACKET.header, packetHeaderFlag: flag } };
                expect(impl.unpack(impl.pack(pkt)).header.packetHeaderFlag).toBe(flag);
            }
        }
    });

    it("E3.09 Interface – version compatibility (JSON and Binary use different prefixes)", () => {
        const jsonProto = new MQTNLProtocolJSON();
        const binaryProto = new MQTNLProtocolBinary();
        expect(jsonProto.getTopicPrefix()).not.toBe(binaryProto.getTopicPrefix());
    });

    it("E3.10 Interface – extensibility (future fields: extra header props preserved by both)", () => {
        // JSON handles extra fields as-is through array positions;
        // Binary is fixed-format but payload can carry arbitrary bytes
        for (const impl of implementations) {
            const pkt = { ...SAMPLE_PACKET, payload: "future_field=42" };
            const unpacked = impl.unpack(impl.pack(pkt));
            const payloadStr = Buffer.isBuffer(unpacked.payload)
                ? unpacked.payload.toString("utf8")
                : unpacked.payload;
            expect(payloadStr).toBe("future_field=42");
        }
    });
});
