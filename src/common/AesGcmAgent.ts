import * as crypto from "crypto";
import { ISecurityAgent } from "./ISecurityAgent";

/**
 * AESGCM AGENT — Contoh agent enkripsi kustom (Jalur A)
 *
 * Mengimplementasikan ISecurityAgent dengan AES-256-GCM. Format wire dibuat
 * SAMA dengan SecurityAgent (ChaCha20) supaya jalur RX/TX driver tidak perlu
 * berubah: IV[12] + Tag[16] + Ciphertext.
 *
 * Cara memakai (SOP custom agent):
 *   1. Buat class yang `implements ISecurityAgent` (lihat file ini).
 *   2. Daftarkan: `SimpleMQTNLDriver.registerAgent("aes-gcm", () => new AesGcmAgent())`.
 *      (Sudah didaftarkan sebagai built-in di SimpleMQTNLDriver.)
 *   3. Pilih dari userland: `net.upgradeSecurity(key, { agent: "aes-gcm" })`
 *      atau `NetSocket.upgradeSecurity(key, { agent: "aes-gcm" })`.
 *
 * (c) 2026 TSIX Project
 */
export class AesGcmAgent implements ISecurityAgent {
  private sessionKey: Buffer | null = null;

  hasSessionKey(): boolean {
    return this.sessionKey !== null;
  }

  setSessionKey(key: Buffer | string): void {
    if (typeof key === "string") {
      const buf = Buffer.from(key, "hex");
      if (buf.length !== 32)
        throw new Error(
          "AES-256-GCM requires a 32-byte session key (64 hex chars).",
        );
      this.sessionKey = buf;
    } else {
      if (key.length !== 32)
        throw new Error("AES-256-GCM requires a 32-byte session key.");
      this.sessionKey = key;
    }
  }

  /** securePacketOut(): Enkripsi → string HEX (format: IV[12] + Tag[16] + Cipher). */
  public securePacketOut(data: string | Buffer): string {
    const out = this.securePacketOutRaw(data);
    if (Buffer.isBuffer(out)) return out.toString("hex");
    return out;
  }

  /** securePacketOutRaw(): Enkripsi → Buffer mentah. Tanpa key → passthrough. */
  public securePacketOutRaw(data: string | Buffer): Buffer | string {
    const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");

    if (this.sessionKey) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", this.sessionKey, iv);
      const encrypted = Buffer.concat([
        cipher.update(dataBuffer),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([iv, tag, encrypted]);
    }
    // Tanpa key → plain (passthrough), dipakai untuk handshake.
    return dataBuffer.toString("utf8");
  }

  /** securePacketIn(): Dekripsi string HEX → string. */
  public securePacketIn(data: string): string {
    if (!data) return "";
    if (this.sessionKey) {
      try {
        const raw = Buffer.from(data, "hex");
        return this.securePacketInRaw(raw);
      } catch (_e) {
        return "";
      }
    }
    return data;
  }

  /** securePacketInRaw(): Dekripsi Buffer mentah → string. */
  public securePacketInRaw(data: Buffer): string {
    if (!data || data.length === 0) return "";

    try {
      if (this.sessionKey) {
        if (data.length < 28) return ""; // 12 IV + 16 Tag
        const iv = data.subarray(0, 12);
        const tag = data.subarray(12, 28);
        const encrypted = data.subarray(28);

        const decipher = crypto.createDecipheriv(
          "aes-256-gcm",
          this.sessionKey,
          iv,
        );
        decipher.setAuthTag(tag);
        const decrypted = Buffer.concat([
          decipher.update(encrypted),
          decipher.final(),
        ]);
        return decrypted.toString("utf8");
      }
      return data.toString("utf8");
    } catch (_e) {
      return "";
    }
  }
}
