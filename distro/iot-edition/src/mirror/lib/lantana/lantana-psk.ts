/**
 * lantana-psk.ts — Handshake PSK untuk device yang tidak sanggup RSA (ESP8266).
 *
 * Prinsip:
 *  - AccessKey tetap rahasia milik device; yang disimpan server adalah
 *    `psk = SHA-256(accessKey)` (lihat AccountManager). PSK tidak pernah
 *    dikirim lewat jaringan.
 *  - Server membuktikan dirinya lewat HMAC(psk, "SERVER"|nonceC|nonceS).
 *  - Device membuktikan dirinya lewat HMAC(psk, "CLIENT"|nonceC|nonceS).
 *  - Session key = HKDF-SHA256(psk, salt=nonceC||nonceS, info="LANTANA-V2-SESSION").
 *
 * Kedua sisi hanya butuh SHA-256 + HMAC + HKDF, tersedia di BearSSL (ESP8266),
 * mbedtls (ESP32), dan Node.
 *
 * (c) 2026 TSIX Project — Lantana
 */

import * as crypto from "crypto";

export const PSK_INFO_SESSION = "LANTANA-V2-SESSION";
export const PSK_LABEL_SERVER = "LANTANA-V2-SERVER";
export const PSK_LABEL_CLIENT = "LANTANA-V2-CLIENT";

/** psk = SHA-256 dari string AccessKey (64 hex char), bukan byte terdekode. */
export function derivePsk(accessKey: string): Buffer {
    return crypto.createHash("sha256").update(accessKey, "utf8").digest();
}

export function hmacHex(psk: Buffer, text: string): string {
    return crypto.createHmac("sha256", psk).update(text, "utf8").digest("hex");
}

export function serverProof(psk: Buffer, clientNonce: string, serverNonce: string): string {
    return hmacHex(psk, `${PSK_LABEL_SERVER}|${clientNonce}|${serverNonce}`);
}

export function clientProof(psk: Buffer, clientNonce: string, serverNonce: string): string {
    return hmacHex(psk, `${PSK_LABEL_CLIENT}|${clientNonce}|${serverNonce}`);
}

/** Session key 32 byte; kompatibel dengan HKDF manual di firmware. */
export function deriveSessionKey(
    psk: Buffer,
    clientNonce: string,
    serverNonce: string,
): Buffer {
    const salt = Buffer.from(`${clientNonce}|${serverNonce}`, "utf8");
    const out = crypto.hkdfSync("sha256", psk, salt, Buffer.from(PSK_INFO_SESSION, "utf8"), 32);
    return Buffer.from(out);
}

/** Perbandingan timing-safe untuk hex string. */
export function safeEqualHex(a: string, b: string): boolean {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const ba = Buffer.from(a.toLowerCase(), "hex");
    const bb = Buffer.from(b.toLowerCase(), "hex");
    if (ba.length === 0 || ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}
