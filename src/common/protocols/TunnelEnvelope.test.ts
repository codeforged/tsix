import { describe, it, expect } from "vitest";
import {
    TunnelFrame,
    TunnelKind,
    TunnelProto,
    TUNNEL_MIN_LENGTH,
    bumpTunnelFrame,
    decodeTunnelFrame,
    encodeTunnelFrame,
    isTunnelFrame,
    protoCodeToName,
    protoNameToCode,
} from "./TunnelEnvelope";

/**
 * TUNNEL ENVELOPE — uji codec.
 *
 * Amplop ini satu-satunya bagian tunnel yang menyentuh byte mentah: salah satu
 * bit saja (offset, endianness, atau konversi utf8) akan merusak payload biner
 * (frame TSSH/OTA/NetFS). Karena itu codec diuji terpisah dari device/kernel.
 */

const baseFrame = (over: Partial<TunnelFrame> = {}): TunnelFrame => ({
    version: 1,
    kind: TunnelKind.DATA,
    hops: 1,
    flag: 0,
    proto: TunnelProto.JSON,
    srcAddress: "node-a",
    srcPort: 5001,
    dstAddress: "node-b",
    dstPort: 24,
    payload: Buffer.from("hello", "utf8"),
    ...over,
});

describe("TunnelEnvelope — codec", () => {
    it("E1.01 round-trip semua field utuh", () => {
        const frame = baseFrame();
        const decoded = decodeTunnelFrame(encodeTunnelFrame(frame));

        expect(decoded).not.toBeNull();
        expect(decoded!.version).toBe(1);
        expect(decoded!.kind).toBe(TunnelKind.DATA);
        expect(decoded!.hops).toBe(1);
        expect(decoded!.flag).toBe(0);
        expect(decoded!.proto).toBe(TunnelProto.JSON);
        expect(decoded!.srcAddress).toBe("node-a");
        expect(decoded!.srcPort).toBe(5001);
        expect(decoded!.dstAddress).toBe("node-b");
        expect(decoded!.dstPort).toBe(24);
        expect(decoded!.payload.toString("utf8")).toBe("hello");
    });

    it("E1.02 payload biner 0..255 lolos byte-exact", () => {
        const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
        const decoded = decodeTunnelFrame(
            encodeTunnelFrame(baseFrame({ proto: TunnelProto.BINFEO, payload: bytes })),
        );

        expect(decoded).not.toBeNull();
        expect(Buffer.compare(decoded!.payload, bytes)).toBe(0);
    });

    it("E1.03 port batas (0 dan 65535) tetap valid", () => {
        const decoded = decodeTunnelFrame(
            encodeTunnelFrame(baseFrame({ srcPort: 0, dstPort: 65535 })),
        );

        expect(decoded!.srcPort).toBe(0);
        expect(decoded!.dstPort).toBe(65535);
    });

    it("E1.04 alamat kosong & payload kosong tetap bisa di-decode", () => {
        const decoded = decodeTunnelFrame(
            encodeTunnelFrame(baseFrame({ srcAddress: "", dstAddress: "", payload: Buffer.alloc(0) })),
        );

        expect(decoded).not.toBeNull();
        expect(decoded!.srcAddress).toBe("");
        expect(decoded!.dstAddress).toBe("");
        expect(decoded!.payload.length).toBe(0);
    });

    it("E1.05 broadcast '*' diterima sebagai alamat biasa", () => {
        const decoded = decodeTunnelFrame(
            encodeTunnelFrame(baseFrame({ dstAddress: "*", dstPort: 65534 })),
        );

        expect(decoded!.dstAddress).toBe("*");
        expect(decoded!.dstPort).toBe(65534);
    });

    it("E1.06 magic salah / data acak → null (tidak melempar)", () => {
        expect(decodeTunnelFrame(Buffer.from("hello world", "utf8"))).toBeNull();
        expect(decodeTunnelFrame(Buffer.alloc(0))).toBeNull();
        expect(decodeTunnelFrame(null)).toBeNull();
        expect(decodeTunnelFrame(undefined)).toBeNull();
    });

    it("E1.07 frame terpotong → null, bukan exception", () => {
        const full = encodeTunnelFrame(baseFrame());
        expect(full.length).toBeGreaterThanOrEqual(TUNNEL_MIN_LENGTH);

        // Potong di setiap offset yang mungkin: tidak satu pun boleh melempar.
        for (let len = 0; len < full.length; len++) {
            expect(() => decodeTunnelFrame(full.subarray(0, len))).not.toThrow();
        }
        expect(decodeTunnelFrame(full.subarray(0, 10))).toBeNull();
    });

    it("E1.08 isTunnelFrame membedakan amplop vs payload biasa", () => {
        expect(isTunnelFrame(encodeTunnelFrame(baseFrame()))).toBe(true);
        expect(isTunnelFrame('{"hello":1}')).toBe(false);
        expect(isTunnelFrame(Buffer.alloc(0))).toBe(false);
    });

    it("E1.09 bumpTunnelFrame menaikkan hops tanpa menyentuh payload", () => {
        const frame = baseFrame({ hops: 2 });
        const bumped = bumpTunnelFrame(frame);

        expect(bumped.hops).toBe(3);
        expect(frame.hops).toBe(2); // asli tidak dimutasi
        expect(Buffer.compare(bumped.payload, frame.payload)).toBe(0);
    });

    it("E1.10 hops di-clamp ke 255 (tidak membungkus jadi 0)", () => {
        const bumped = bumpTunnelFrame(baseFrame({ hops: 255 }));
        expect(bumped.hops).toBe(255);

        const decoded = decodeTunnelFrame(encodeTunnelFrame(baseFrame({ hops: 999 })));
        expect(decoded!.hops).toBe(255);
    });

    it("E1.11 alamat > 255 byte ditolak keras (bukan frame rusak)", () => {
        const long = "x".repeat(256);
        expect(() => encodeTunnelFrame(baseFrame({ dstAddress: long }))).toThrow(/terlalu panjang/);
    });

    it("E1.12 pemetaan nama protocol ↔ kode amplop", () => {
        expect(protoNameToCode("JSON")).toBe(TunnelProto.JSON);
        expect(protoNameToCode("Binary")).toBe(TunnelProto.BINARY);
        expect(protoNameToCode("Binfeo")).toBe(TunnelProto.BINFEO);
        expect(protoNameToCode(undefined)).toBe(TunnelProto.JSON);

        expect(protoCodeToName(TunnelProto.JSON)).toBe("JSON");
        expect(protoCodeToName(TunnelProto.BINARY)).toBe("Binary");
        expect(protoCodeToName(TunnelProto.BINFEO)).toBe("Binfeo");
        expect(protoCodeToName(99)).toBe("JSON"); // nilai tak dikenal → default aman
    });

    it("E1.13 field flag (PacketFlags) bertahan supaya ping/broadcast hidup", () => {
        // FLAG_BROADCAST_PING = 3, FLAG_PING_REQUEST = 1
        for (const flag of [0, 1, 2, 3, 4, 20, 21, 22]) {
            const decoded = decodeTunnelFrame(encodeTunnelFrame(baseFrame({ flag })));
            expect(decoded!.flag).toBe(flag);
        }
    });

    it("E1.14 NACK memakai kind terpisah dan payload bisa jadi alasan teks", () => {
        const decoded = decodeTunnelFrame(
            encodeTunnelFrame(
                baseFrame({
                    kind: TunnelKind.NACK,
                    payload: Buffer.from("tujuan tidak dikenal", "utf8"),
                }),
            ),
        );

        expect(decoded!.kind).toBe(TunnelKind.NACK);
        expect(decoded!.payload.toString("utf8")).toBe("tujuan tidak dikenal");
    });
});
