import { describe, it, expect } from "vitest";
import { SimpleMQTNLDriver } from "./SimpleMQTNLDriver";
import { SecurityAgent } from "../../common/SecurityAgent";
import { AesGcmAgent } from "../../common/AesGcmAgent";
import { ISecurityAgent } from "../../common/ISecurityAgent";

const KEY_HEX =
  "81ff71ed574e54597690ae7b04e4ef5fc87497fe10b6b037cb031af7c7d67619";

describe("SimpleMQTNLDriver — Security Agent Registry (Jalur A)", () => {
  it("getAgent() tanpa nama → default SecurityAgent (chacha20)", () => {
    const agent = SimpleMQTNLDriver.getAgent();
    expect(agent).toBeInstanceOf(SecurityAgent);
  });

  it("getAgent('chacha20') → SecurityAgent", () => {
    const agent = SimpleMQTNLDriver.getAgent("chacha20");
    expect(agent).toBeInstanceOf(SecurityAgent);
  });

  it("getAgent('aes-gcm') → AesGcmAgent yang bisa enkripsi/dekripsi", () => {
    const agent = SimpleMQTNLDriver.getAgent("aes-gcm");
    expect(agent).toBeInstanceOf(AesGcmAgent);

    agent.setSessionKey(KEY_HEX);
    const cipher = agent.securePacketOut("secure via aes-gcm");
    expect(agent.securePacketIn(cipher)).toBe("secure via aes-gcm");
  });

  it("getAgent('nama-tidak-dikenal') → fallback ke SecurityAgent (backward-compat)", () => {
    const agent = SimpleMQTNLDriver.getAgent("tidak-ada");
    expect(agent).toBeInstanceOf(SecurityAgent);
  });

  it("registerAgent() → SOP custom agent bisa dipilih via nama", () => {
    class MyCustomAgent implements ISecurityAgent {
      private key: Buffer | null = null;
      hasSessionKey() {
        return this.key !== null;
      }
      setSessionKey(k: Buffer | string) {
        this.key = typeof k === "string" ? Buffer.from(k, "hex") : k;
      }
      securePacketOut(d: string | Buffer) {
        return `[custom:${String(d)}]`;
      }
      securePacketIn(d: string) {
        return d.replace("[custom:", "").replace("]", "");
      }
      securePacketInRaw(d: Buffer) {
        return d.toString("utf8");
      }
    }

    SimpleMQTNLDriver.registerAgent("test-custom", () => new MyCustomAgent());
    const agent = SimpleMQTNLDriver.getAgent("test-custom");
    expect(agent).toBeInstanceOf(MyCustomAgent);

    agent.setSessionKey(KEY_HEX);
    expect(agent.hasSessionKey()).toBe(true);
    expect(agent.securePacketOut("pesan")).toContain("custom");
    expect(agent.securePacketIn("[custom:pesan]")).toBe("pesan");
  });

  it("tiap pemanggilan getAgent() menghasilkan instance baru (state key terisolasi)", () => {
    const a = SimpleMQTNLDriver.getAgent("aes-gcm");
    const b = SimpleMQTNLDriver.getAgent("aes-gcm");
    a.setSessionKey(KEY_HEX);
    expect(a.hasSessionKey()).toBe(true);
    expect(b.hasSessionKey()).toBe(false);
  });

  it("listAgents() → nama agent yang terdaftar (dipakai tool secagent)", () => {
    const agents = SimpleMQTNLDriver.listAgents();
    expect(Array.isArray(agents)).toBe(true);
    expect(agents).toContain("chacha20");
    expect(agents).toContain("aes-gcm");
    // Agent custom yang didaftarkan di tes sebelumnya ikut terdaftar.
    expect(agents).toContain("test-custom");
  });
});
