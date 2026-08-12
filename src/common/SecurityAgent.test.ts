import { describe, it, expect } from "vitest";
import { SecurityAgent } from "./SecurityAgent";

describe("SecurityAgent", () => {
    let agent: SecurityAgent;

    beforeEach(() => {
        agent = new SecurityAgent();
    });

    // ============================================================
    // D3.01–D3.05: Hash & static utilities
    // ============================================================
    it("D3.01 HASH – generates deterministic hash", () => {
        const h1 = SecurityAgent.hash("hello");
        const h2 = SecurityAgent.hash("hello");
        expect(h1).toBe(h2);
        expect(h1.length).toBe(64); // SHA-256 → 64 hex chars
    });
    it("D3.02 HASH – different inputs produce different hashes", () => {
        expect(SecurityAgent.hash("hello")).not.toBe(SecurityAgent.hash("world"));
    });
    it("D3.03 HASH – empty string produces valid hash", () => {
        expect(SecurityAgent.hash("").length).toBe(64);
    });
    it("D3.04 HASH – unicode input works", () => {
        expect(SecurityAgent.hash("日本語").length).toBe(64);
    });
    it("D3.05 FINGERPRINT – generates 16-char hex uppercase", () => {
        const { publicKey } = SecurityAgent.generateKeyPair();
        const fp = SecurityAgent.getFingerprint(publicKey);
        expect(fp.length).toBe(16);
        expect(fp).toBe(fp.toUpperCase());
    });

    // ============================================================
    // D3.06–D3.10: RSA Key Pair + Encrypt/Decrypt
    // ============================================================
    it("D3.06 RSA – generates valid key pair", () => {
        const { publicKey, privateKey } = SecurityAgent.generateKeyPair();
        expect(publicKey).toContain("BEGIN RSA PUBLIC KEY");
        expect(privateKey).toContain("BEGIN RSA PRIVATE KEY");
    });
    it("D3.07 RSA – encrypt + decrypt roundtrip", () => {
        const { publicKey, privateKey } = SecurityAgent.generateKeyPair();
        const data = Buffer.from("secret session key 32bytes!!");
        const encrypted = SecurityAgent.encryptWithPublicKey(publicKey, data);
        const decrypted = SecurityAgent.decryptWithPrivateKey(privateKey, encrypted);
        expect(decrypted.equals(data)).toBe(true);
    });
    it("D3.08 RSA – wrong private key fails decrypt", () => {
        const { publicKey } = SecurityAgent.generateKeyPair();
        const { privateKey: wrongKey } = SecurityAgent.generateKeyPair();
        const encrypted = SecurityAgent.encryptWithPublicKey(publicKey, Buffer.from("test"));
        expect(() => SecurityAgent.decryptWithPrivateKey(wrongKey, encrypted)).toThrow();
    });
    it("D3.09 RSA – different keys produce different outputs", () => {
        const kp1 = SecurityAgent.generateKeyPair();
        const kp2 = SecurityAgent.generateKeyPair();
        expect(kp1.publicKey).not.toBe(kp2.publicKey);
        expect(kp1.privateKey).not.toBe(kp2.privateKey);
    });
    it("D3.10 RSA – deterministic encrypt yields different ciphertexts (OAEP random)", () => {
        const { publicKey } = SecurityAgent.generateKeyPair();
        const data = Buffer.from("test");
        const e1 = SecurityAgent.encryptWithPublicKey(publicKey, data);
        const e2 = SecurityAgent.encryptWithPublicKey(publicKey, data);
        expect(e1).not.toBe(e2); // OAEP padding includes randomness
    });

    // ============================================================
    // D3.11–D3.14: Session Key (ChaCha20)
    // ============================================================
    it("D3.11 SESSION KEY – generates 32-byte key", () => {
        const key = SecurityAgent.generateSessionKey();
        expect(key.length).toBe(32);
    });
    it("D3.12 SESSION KEY – set + get via hex string", () => {
        const key = SecurityAgent.generateSessionKey();
        agent.setSessionKey(key.toString("hex"));
        expect(agent.hasSessionKey()).toBe(true);
    });
    it("D3.13 SESSION KEY – rejects wrong length", () => {
        expect(() => agent.setSessionKey("deadbeef")).toThrow();
        expect(() => agent.setSessionKey(Buffer.alloc(16))).toThrow();
    });
    it("D3.14 SESSION KEY – set via raw Buffer", () => {
        const key = SecurityAgent.generateSessionKey();
        agent.setSessionKey(key);
        expect(agent.hasSessionKey()).toBe(true);
    });

    // ============================================================
    // D3.15–D3.20: ChaCha20-Poly1305 Encrypt/Decrypt
    // ============================================================
    it("D3.15 CHACHA – encrypt + decrypt roundtrip (string)", () => {
        agent.setSessionKey(SecurityAgent.generateSessionKey());
        const plain = "Hello, TSIX!";
        const encrypted = agent.securePacketOut(plain);
        const decrypted = agent.securePacketIn(encrypted);
        expect(decrypted).toBe(plain);
    });
    it("D3.16 CHACHA – encrypt + decrypt roundtrip (Buffer)", () => {
        agent.setSessionKey(SecurityAgent.generateSessionKey());
        const plain = Buffer.from("binary data test");
        const encrypted = agent.securePacketOut(plain);
        const decrypted = agent.securePacketIn(encrypted);
        expect(decrypted).toBe(plain.toString("utf8"));
    });
    it("D3.17 CHACHA – different plaintexts produce different ciphertexts", () => {
        agent.setSessionKey(SecurityAgent.generateSessionKey());
        const e1 = agent.securePacketOut("hello");
        const e2 = agent.securePacketOut("world");
        expect(e1).not.toBe(e2);
    });
    it("D3.18 CHACHA – empty string encrypt/decrypt", () => {
        agent.setSessionKey(SecurityAgent.generateSessionKey());
        const encrypted = agent.securePacketOut("");
        const decrypted = agent.securePacketIn(encrypted);
        expect(decrypted).toBe("");
    });
    it("D3.19 CHACHA – no session key → plain passthrough", () => {
        const encrypted = agent.securePacketOut("plaintext");
        const decrypted = agent.securePacketIn(encrypted);
        expect(decrypted).toBe("plaintext");
    });
    it("D3.20 CHACHA – decrypt empty string returns empty", () => {
        agent.setSessionKey(SecurityAgent.generateSessionKey());
        expect(agent.securePacketIn("")).toBe("");
    });
});
