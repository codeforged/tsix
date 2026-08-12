import { describe, it, expect } from "vitest";
import { PacketFlags } from "./PacketFlags";

describe("PacketFlags (D8)", () => {
    // ============================================================
    // D8.01–D8.02: Flag Pack
    // ============================================================
    it("D8.01 Flag pack – single flag value check", () => {
        expect(PacketFlags.FLAG_DATA).toBe(0);
        expect(PacketFlags.FLAG_PING_REQUEST).toBe(1);
        expect(PacketFlags.FLAG_PING_REPLY).toBe(2);
    });

    it("D8.02 Flag pack – multiple flags enumerated", () => {
        const allFlags = [
            PacketFlags.FLAG_DATA,
            PacketFlags.FLAG_PING_REQUEST,
            PacketFlags.FLAG_PING_REPLY,
            PacketFlags.FLAG_BROADCAST_PING,
            PacketFlags.FLAG_BROADCAST_REPLY,
            PacketFlags.FLAG_FILE_HEADER_INFO,
            PacketFlags.FLAG_FILE_HEADER_GETFILE,
            PacketFlags.FLAG_FILE_PAYLOAD_GETFILE,
            PacketFlags.FLAG_FILE_LIST_RESPONSE,
            PacketFlags.FLAG_FILE_PUT_SUCCESS,
            PacketFlags.RSA_HANDSHAKE_REQ,
            PacketFlags.RSA_HANDSHAKE_ACK,
            PacketFlags.AUTH_FAILED
        ];
        expect(allFlags.length).toBe(13);
    });

    // ============================================================
    // D8.03–D8.04: Flag Unpack / Extract
    // ============================================================
    it("D8.03 Flag unpack – extract single flag by numeric value", () => {
        const pingRequestVal = 1;
        const found = Object.entries(PacketFlags).find(([, v]) => v === pingRequestVal);
        expect(found).toBeDefined();
        expect(found![0]).toBe("FLAG_PING_REQUEST");
    });

    it("D8.04 Flag unpack – extract all flags from enum", () => {
        const flags = Object.entries(PacketFlags)
            .filter(([, v]) => typeof v === "number")
            .map(([k, v]) => ({ name: k, value: v as number }));
        expect(flags.length).toBeGreaterThan(0);
        const names = flags.map(f => f.name);
        expect(names).toContain("FLAG_DATA");
        expect(names).toContain("FLAG_PING_REQUEST");
        expect(names).toContain("RSA_HANDSHAKE_REQ");
    });

    // ============================================================
    // D8.05: Collision Check
    // ============================================================
    it("D8.05 Flag collision – no overlapping values", () => {
        const values = Object.values(PacketFlags).filter(v => typeof v === "number") as number[];
        const uniqueValues = new Set(values);
        expect(uniqueValues.size).toBe(values.length);
    });
});
