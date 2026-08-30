import { describe, it, expect } from "vitest";
import { AesGcmAgent } from "./AesGcmAgent";
import { ISecurityAgent } from "./ISecurityAgent";

const KEY_HEX =
  "81ff71ed574e54597690ae7b04e4ef5fc87497fe10b6b037cb031af7c7d67619";

describe("AesGcmAgent (contoh custom agent — Jalur A)", () => {
  it("mengimplementasikan kontrak ISecurityAgent (5 method)", () => {
    const agent: ISecurityAgent = new AesGcmAgent();
    expect(typeof agent.setSessionKey).toBe("function");
    expect(typeof agent.hasSessionKey).toBe("function");
    expect(typeof agent.securePacketOut).toBe("function");
    expect(typeof agent.securePacketIn).toBe("function");
    expect(typeof agent.securePacketInRaw).toBe("function");
  });

  it("round-trip string — securePacketOut -> securePacketIn", () => {
    const agent = new AesGcmAgent();
    expect(agent.hasSessionKey()).toBe(false);

    agent.setSessionKey(KEY_HEX);
    expect(agent.hasSessionKey()).toBe(true);

    const cipher = agent.securePacketOut("halo dari netsocket!");
    // Format: IV[12] + Tag[16] + Cipher → hex selalu lebih panjang dari plaintext
    expect(cipher).not.toContain("halo");
    expect(cipher.length).toBeGreaterThan(28 * 2);

    const plain = agent.securePacketIn(cipher);
    expect(plain).toBe("halo dari netsocket!");
  });

  it("round-trip Buffer — securePacketOutRaw -> securePacketInRaw", () => {
    const agent = new AesGcmAgent();
    agent.setSessionKey(KEY_HEX);

    const payload = Buffer.from("binary-frame-0x4C-0x01", "utf8");
    const enc = agent.securePacketOutRaw(payload) as Buffer;
    expect(Buffer.isBuffer(enc)).toBe(true);
    expect(enc.length).toBe(payload.length + 28); // 12 IV + 16 Tag

    const dec = agent.securePacketInRaw(enc);
    expect(dec).toBe(payload.toString("utf8"));
  });

  it("tanpa key → passthrough plain (untuk handshake)", () => {
    const agent = new AesGcmAgent();
    expect(agent.securePacketOut("plain")).toBe("plain");
    expect(agent.securePacketIn("plain")).toBe("plain");
    expect(agent.securePacketInRaw(Buffer.from("plain")).toString()).toBe(
      "plain",
    );
  });

  it("menolak key dengan panjang salah", () => {
    const agent = new AesGcmAgent();
    expect(() => agent.setSessionKey("abcd")).toThrow();
    expect(() => agent.setSessionKey(Buffer.alloc(16))).toThrow();
  });

  it("data rusak → hasil dekripsi kosong (tidak throw)", () => {
    const agent = new AesGcmAgent();
    agent.setSessionKey(KEY_HEX);
    expect(agent.securePacketInRaw(Buffer.from("too-short"))).toBe("");
    expect(agent.securePacketIn("zzzz-not-valid-hex")).toBe("");
  });
});
