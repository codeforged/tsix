import { describe, it, expect, beforeEach } from "vitest";
import { MQTNLProtocolBinfeo } from "./MQTNLProtocolBinfeo";
import { MQTNLProtocolBinary } from "./MQTNLProtocolBinary";
import { MQTNLProtocolJSON } from "./MQTNLProtocolJSON";

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
  payload: "test",
};

describe("MQTNLProtocolBinfeo (F1)", () => {
  let proto: MQTNLProtocolBinfeo;

  beforeEach(() => {
    proto = new MQTNLProtocolBinfeo();
  });

  it("F1.01 getName returns 'Binfeo'", () => {
    expect(proto.getName()).toBe("Binfeo");
  });

  it("F1.02 magic char distinct from OTA Binary & JSON", () => {
    expect(proto.getMagicChars()).toEqual([0x66]); // 'f'
    expect(proto.getMagicChars()).not.toEqual(
      new MQTNLProtocolBinary().getMagicChars(),
    );
    expect(proto.getMagicChars()).not.toEqual(
      new MQTNLProtocolJSON().getMagicChars(),
    );
  });

  it("F1.03 topic prefix distinct from Binary & JSON", () => {
    expect(proto.getTopicPrefix()).toBe("mqtnl@1.2/");
    expect(proto.getTopicPrefix()).not.toBe(
      new MQTNLProtocolBinary().getTopicPrefix(),
    );
    expect(proto.getTopicPrefix()).not.toBe(
      new MQTNLProtocolJSON().getTopicPrefix(),
    );
  });

  it("F1.04 roundtrip pack/unpack preserves header + payload", () => {
    const packed = proto.pack(SAMPLE_PACKET);
    expect(packed[0]).toBe(0x66); // magic di wire
    const unpacked = proto.unpack(packed);
    expect(unpacked.header.srcAddress).toBe("A");
    expect(unpacked.header.srcPort).toBe(100);
    expect(unpacked.header.dstPort).toBe(200);
    expect(unpacked.payload.toString("utf8")).toBe("test");
  });

  it("F1.05 binary payload preserved byte-for-byte (termasuk byte >= 0x80)", () => {
    const payload = Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xff, 0x42]);
    const packed = proto.pack({ ...SAMPLE_PACKET, payload });
    const unpacked = proto.unpack(packed);
    expect(Buffer.from(unpacked.payload).equals(payload)).toBe(true);
  });

  it("F1.06 menolak magic OTA (0x42) — paket binfeo tidak ketuker dgn OTA", () => {
    const packed = proto.pack(SAMPLE_PACKET);
    packed[0] = 0x42; // ganti jadi magic OTA
    expect(() => proto.unpack(packed)).toThrow("Invalid Magic Byte");
  });

  it("F1.07 error handling pola sama (invalid data throws)", () => {
    expect(() => proto.unpack("!@#$%^&*()")).toThrow();
  });
});
