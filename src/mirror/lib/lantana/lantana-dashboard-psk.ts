/**
 * lantana-dashboard-psk.ts — Handshake PSK untuk portable dashboard.
 *
 * PIN dashboard (6 digit) hanya dipegang pengguna dashboard. Server menyimpan
 * `accessKeyHash = SHA-256(PIN)` di dashboard.json; hash itulah yang dipakai
 * sebagai PSK, jadi PIN mentah tidak pernah dikirim ke jaringan.
 *
 * Alur:
 *  - Client mengirim keyTag (prefix SHA-256(PIN)) + clientNonce.
 *  - Server membalas serverProof = HMAC(psk, "DASH-SERVER|nonceC|nonceS").
 *  - Client membalas clientProof = HMAC(psk, "DASH-CLIENT|nonceC|nonceS").
 *  - Session key = HKDF-SHA256(psk, salt=nonceC|nonceS,
 *    info="LANTANA-DASH-SESSION") untuk ChaCha20-Poly1305.
 *
 * Label sengaja dipisah dari handshake device (lantana-psk.ts) supaya proof
 * tidak bisa dipakai silang antar protokol.
 *
 * (c) 2026 TSIX Project — Lantana
 */

import * as crypto from "crypto";
import { hmacHex } from "./lantana-psk";

export const DASH_KEY_TAG_HEX = 16;
export const DASH_NONCE_HEX = 32;
export const DASH_PSK_INFO_SESSION = "LANTANA-DASH-SESSION";
export const DASH_PSK_LABEL_SERVER = "LANTANA-DASH-SERVER";
export const DASH_PSK_LABEL_CLIENT = "LANTANA-DASH-CLIENT";

/** Prefix accessKeyHash yang dikirim client untuk lookup dashboard. */
export function dashboardKeyTag(accessKeyHash: string): string {
    return accessKeyHash.trim().slice(0, DASH_KEY_TAG_HEX).toLowerCase();
}

export function isDashboardKeyTag(value: unknown): value is string {
    return typeof value === "string" && new RegExp(`^[0-9a-f]{${DASH_KEY_TAG_HEX}}$`, "i").test(value);
}

export function isDashboardNonce(value: unknown): value is string {
    return (
        typeof value === "string" &&
        new RegExp(`^[0-9a-f]{${DASH_NONCE_HEX}}$`, "i").test(value)
    );
}

/** PSK = byte SHA-256(PIN), yaitu accessKeyHash yang tersimpan di registry. */
export function dashboardPsk(accessKeyHash: string): Buffer {
    return Buffer.from(accessKeyHash, "hex");
}

export function dashboardServerProof(
    psk: Buffer,
    clientNonce: string,
    serverNonce: string,
): string {
    return hmacHex(psk, `${DASH_PSK_LABEL_SERVER}|${clientNonce}|${serverNonce}`);
}

export function dashboardClientProof(
    psk: Buffer,
    clientNonce: string,
    serverNonce: string,
): string {
    return hmacHex(psk, `${DASH_PSK_LABEL_CLIENT}|${clientNonce}|${serverNonce}`);
}

/** Session key 32 byte untuk SecurityAgent (ChaCha20-Poly1305). */
export function deriveDashboardSessionKey(
    psk: Buffer,
    clientNonce: string,
    serverNonce: string,
): Buffer {
    const salt = Buffer.from(`${clientNonce}|${serverNonce}`, "utf8");
    return Buffer.from(
        crypto.hkdfSync(
            "sha256",
            psk,
            salt,
            Buffer.from(DASH_PSK_INFO_SESSION, "utf8"),
            32,
        ),
    );
}
