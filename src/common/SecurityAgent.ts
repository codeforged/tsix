import * as crypto from "crypto";
import { ISecurityAgent } from "./ISecurityAgent";

/**
 * SECURITY AGENT (v2.0 Antigonon)
 *
 * Abstraksi untuk enkripsi paket MQTNL.
 * Mendukung RSA (Handshake) dan ChaCha20 (Data Transfer).
 * Tetap mendukung XOR (Legacy) untuk test.
 *
 * Mengimplementasikan kontrak `ISecurityAgent` — agent ini adalah default
 * ("chacha20") di SimpleMQTNLDriver. Agent kustom lain bisa dibuat dengan
 * mengimplementasikan kontrak yang sama.
 */
export class SecurityAgent implements ISecurityAgent {
  private sessionKey: Buffer | null = null;

  constructor() {}

  // --- RSA RSA RSA ---

  /**
   * Generate RSA Key Pair (untuk Client)
   */
  public static generateKeyPair(): { publicKey: string; privateKey: string } {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "pkcs1", format: "pem" },
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
    });
    return { publicKey, privateKey };
  }

  /**
   * Encrypt session key with Public Key (untuk Server di ACK)
   */
  public static encryptWithPublicKey(
    publicKeyPem: string,
    data: Buffer,
  ): string {
    const encrypted = crypto.publicEncrypt(
      {
        key: publicKeyPem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      },
      data,
    );
    return encrypted.toString("hex");
  }

  /**
   * Decrypt session key with Private Key (untuk Client saat menerima ACK)
   */
  public static decryptWithPrivateKey(
    privateKeyPem: string,
    hexData: string,
  ): Buffer {
    return crypto.privateDecrypt(
      {
        key: privateKeyPem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      },
      Buffer.from(hexData, "hex"),
    );
  }

  // --- CHACHA20 CHACHA20 ---

  /**
   * Set Session Key (32 byte) untuk ChaCha20
   */
  public hasSessionKey(): boolean {
    return this.sessionKey !== null;
  }

  public setSessionKey(key: Buffer | string) {
    if (typeof key === "string") {
      const buf = Buffer.from(key, "hex");
      if (buf.length !== 32)
        throw new Error(
          "ChaCha20 requires a 32-byte session key (64 hex chars).",
        );
      this.sessionKey = buf;
    } else {
      if (key.length !== 32)
        throw new Error("ChaCha20 requires a 32-byte session key.");
      this.sessionKey = key;
    }
  }

  /**
   * Generate 32-byte Session Key
   */
  public static generateSessionKey(): Buffer {
    return crypto.randomBytes(32);
  }

  /**
   * securePacketOut(): Encrypt string.
   * V2: Concatenated Hex (IV[12] + Tag[16] + Ciphertext)
   * Fallback: Literal String -- "Plain" for handshakes
   */
  public securePacketOut(data: string | Buffer): string {
    const out = this.securePacketOutRaw(data);
    if (Buffer.isBuffer(out)) {
      return out.toString("hex");
    }
    return out;
  }

  /**
   * securePacketOutRaw(): Encrypt string/buffer to raw Buffer.
   * Binary optimized version of securePacketOut.
   */
  public securePacketOutRaw(data: string | Buffer): Buffer | string {
    const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");

    if (this.sessionKey) {
      // Airterm V2: ChaCha20-Poly1305
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv(
        "chacha20-poly1305",
        this.sessionKey,
        iv,
        {
          authTagLength: 16,
        },
      );
      const encrypted = Buffer.concat([
        cipher.update(dataBuffer),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();

      // Format: IV[12] + Tag[16] + EncryptedData (RAW BINARY)
      return Buffer.concat([iv, tag, encrypted]);
    } else {
      // Fallback: Plain (Literal String) -- Used for Handshakes
      return dataBuffer.toString("utf8");
    }
  }

  /**
   * securePacketIn(): Decrypt string (HEX).
   */
  public securePacketIn(data: string): string {
    if (!data) return "";
    if (this.sessionKey) {
      try {
        const raw = Buffer.from(data, "hex");
        return this.securePacketInRaw(raw);
      } catch (e) {
        return "";
      }
    } else {
      return data;
    }
  }

  /**
   * securePacketInRaw(): Decrypt raw Buffer.
   */
  public securePacketInRaw(data: Buffer): string {
    if (!data || data.length === 0) return "";

    try {
      if (this.sessionKey) {
        // Airterm V2: ChaCha20-Poly1305
        if (data.length < 28) return ""; // Malformed (12 IV + 16 Tag)
        const iv = data.subarray(0, 12);
        const tag = data.subarray(12, 28);
        const encrypted = data.subarray(28);

        const decipher = crypto.createDecipheriv(
          "chacha20-poly1305",
          this.sessionKey,
          iv,
          {
            authTagLength: 16,
          },
        );
        decipher.setAuthTag(tag);
        const decrypted = Buffer.concat([
          decipher.update(encrypted),
          decipher.final(),
        ]);
        return decrypted.toString("utf8");
      } else {
        // Fallback: Plain (Literal String)
        return data.toString("utf8");
      }
    } catch (e) {
      return "";
    }
  }

  /**
   * sign(): Sign data using Private Key (RSA)
   */
  public static sign(privateKeyPem: string, data: string): string {
    const sign = crypto.createSign("SHA256");
    sign.update(data);
    sign.end();
    return sign.sign(privateKeyPem, "hex");
  }

  /**
   * verify(): Verify signature using Public Key (RSA)
   */
  public static verify(
    publicKeyPem: string,
    data: string,
    signatureHex: string,
  ): boolean {
    const verify = crypto.createVerify("SHA256");
    verify.update(data);
    verify.end();
    return verify.verify(publicKeyPem, signatureHex, "hex");
  }

  /**
   * getFingerprint(): Generate fingerprint dari Public Key (SHA-256)
   */
  public static getFingerprint(publicKeyPem: string): string {
    return crypto
      .createHash("sha256")
      .update(publicKeyPem)
      .digest("hex")
      .substring(0, 16)
      .toUpperCase();
  }

  public static hash(data: string): string {
    return crypto.createHash("sha256").update(data, "utf8").digest("hex");
  }

  /**
   * generateVisualIdentity(): Generate ANSI color bar from fingerprint.
   */
  public static generateVisualIdentity(fingerprint: string): string {
    // Available ANSI background colors (16 colors)
    const colors = [
      41, 42, 43, 44, 45, 46, 47, 100, 101, 102, 103, 104, 105, 106, 107, 40,
    ];

    // Generate MD5 hash from the fingerprint
    const md5Hash = crypto.createHash("md5").update(fingerprint).digest("hex");

    // Split into 16 hex pairs (2 chars each)
    const hexBytes = md5Hash.match(/.{1,2}/g) || [];

    let row = "";
    const colorsPerRow = 8; // 8 blocks per row

    hexBytes.forEach((hex: string, index: number) => {
      const decimalValue = parseInt(hex, 16);
      const colorIndex = decimalValue % colors.length;
      const color = colors[colorIndex];

      // Add colored block (4 spaces wide)
      row += `\x1b[${color}m    \x1b[0m`;

      // Add newline after 8 blocks
      if ((index + 1) % colorsPerRow === 0 && index + 1 < hexBytes.length) {
        row += "\n";
      }
    });

    return row;
  }
}
