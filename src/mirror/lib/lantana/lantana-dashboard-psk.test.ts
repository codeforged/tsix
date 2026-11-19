/**
 * lantana-dashboard-psk.test.ts — Handshake PSK portable dashboard.
 */

import { describe, expect, it } from "vitest";
import * as crypto from "crypto";
import {
    DASH_PSK_INFO_SESSION,
    dashboardClientProof,
    dashboardKeyTag,
    dashboardPsk,
    dashboardServerProof,
    deriveDashboardSessionKey,
    isDashboardKeyTag,
    isDashboardNonce,
} from "./lantana-dashboard-psk";

const PIN = "483920";
const HASH = crypto.createHash("sha256").update(PIN, "utf8").digest("hex");
const PSK = crypto.createHash("sha256").update(PIN, "utf8").digest();
const CLIENT_NONCE = "a".repeat(32);
const SERVER_NONCE = "b".repeat(32);

describe("handshake PSK dashboard", () => {
    it("PSK adalah SHA-256(PIN) dan keyTag adalah prefix-nya", () => {
        expect(dashboardPsk(HASH).equals(PSK)).toBe(true);
        expect(dashboardKeyTag(HASH)).toBe(HASH.slice(0, 16));
        expect(dashboardKeyTag(HASH.toUpperCase())).toBe(HASH.slice(0, 16));
    });

    it("proof server dan client berbeda tetapi deterministik", () => {
        const server = dashboardServerProof(PSK, CLIENT_NONCE, SERVER_NONCE);
        const client = dashboardClientProof(PSK, CLIENT_NONCE, SERVER_NONCE);

        expect(server).not.toBe(client);
        expect(server).toBe(
            crypto
                .createHmac("sha256", PSK)
                .update(`LANTANA-DASH-SERVER|${CLIENT_NONCE}|${SERVER_NONCE}`)
                .digest("hex"),
        );
        expect(client).toBe(
            crypto
                .createHmac("sha256", PSK)
                .update(`LANTANA-DASH-CLIENT|${CLIENT_NONCE}|${SERVER_NONCE}`)
                .digest("hex"),
        );
    });

    it("session key 32 byte diturunkan dari PSK dan kedua nonce", () => {
        const key = deriveDashboardSessionKey(PSK, CLIENT_NONCE, SERVER_NONCE);
        const other = deriveDashboardSessionKey(PSK, CLIENT_NONCE, "c".repeat(32));

        expect(key.length).toBe(32);
        expect(key.equals(other)).toBe(false);
        expect(
            key.equals(
                Buffer.from(
                    crypto.hkdfSync(
                        "sha256",
                        PSK,
                        Buffer.from(`${CLIENT_NONCE}|${SERVER_NONCE}`, "utf8"),
                        Buffer.from(DASH_PSK_INFO_SESSION, "utf8"),
                        32,
                    ),
                ),
            ),
        ).toBe(true);
    });

    it("memvalidasi format keyTag dan nonce", () => {
        expect(isDashboardKeyTag(HASH.slice(0, 16))).toBe(true);
        expect(isDashboardKeyTag(HASH.slice(0, 15))).toBe(false);
        expect(isDashboardKeyTag("zzzzzzzzzzzzzzzz")).toBe(false);
        expect(isDashboardNonce(CLIENT_NONCE)).toBe(true);
        expect(isDashboardNonce("a".repeat(31))).toBe(false);
        expect(isDashboardNonce(123)).toBe(false);
    });
});
