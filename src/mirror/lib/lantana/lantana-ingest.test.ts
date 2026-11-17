/**
 * lantana-ingest.test.ts — Pipeline autentikasi → otorisasi → validasi.
 *
 * Test ini adalah kontrak keamanan utama Lantana V2: data tidak boleh diterima
 * hanya karena datang ke port yang benar.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { AccountManager } from "./account-manager";
import { DeviceRegistry } from "./device-registry";
import { SchemeRegistry } from "./scheme-registry";
import { PermissionPolicy } from "./permission-policy";
import { SessionManager } from "./session-manager";
import { IngestPipeline } from "./lantana-ingest";
import { LantanaError } from "./lantana-core";

const SESSION = "10.0.0.9:41000";
const ENDPOINT = { address: "10.0.0.9", port: 41000 };

function setup() {
    const accounts = new AccountManager();
    accounts.createRoot("root", { allowedInjectSchemes: [{ from: 201, to: 205 }] });
    accounts.createChild("root", "anak", { allowedInjectSchemes: [101] });

    const devices = new DeviceRegistry();
    const devRoot = devices.register("root", { name: "Root Dev" });
    const devAnak = devices.register("anak", { name: "Anak Dev" });
    const devLain = devices.register("anak", { name: "Anak Dev 2" });

    const schemes = new SchemeRegistry();
    schemes.add({ schemeId: 101, ownerAccountId: "anak", label: "Suhu", unit: "°C", type: "number", min: -40, max: 125 });
    schemes.add({ schemeId: 203, ownerAccountId: "root", label: "Tekanan", unit: "hPa", type: "number", min: 800, max: 1100 });
    schemes.add({ schemeId: 999, ownerAccountId: "root", label: "Lain", type: "number" });

    const policy = new PermissionPolicy(accounts, schemes);
    const sessions = new SessionManager();
    const ingest = new IngestPipeline({ accounts, devices, schemes, policy, sessions });

    return { accounts, devices, schemes, policy, sessions, ingest, devRoot, devAnak, devLain };
}

describe("ingest", () => {
    let ctx: ReturnType<typeof setup>;

    beforeEach(() => {
        ctx = setup();
        ctx.sessions.open(SESSION);
    });

    it("menolak sesi yang belum terautentikasi", () => {
        const r = ctx.ingest.ingest({
            sessionId: SESSION,
            deviceId: ctx.devAnak.deviceId,
            readings: [{ schemeId: 101, value: 25 }],
            endpoint: ENDPOINT,
        });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toBe(LantanaError.UNAUTHENTICATED);
    });

    it("menerima data valid dan mengisi identitas akun/device + readingId", () => {
        ctx.sessions.bind(SESSION, "anak", ctx.devAnak.deviceId);
        const r = ctx.ingest.ingest({
            sessionId: SESSION,
            deviceId: ctx.devAnak.deviceId,
            readings: [{ schemeId: 101, value: 25.5 }],
            receivedAt: 1000,
            endpoint: ENDPOINT,
        });

        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.accountId).toBe("anak");
        expect(r.readings).toHaveLength(1);
        expect(r.readings[0]).toMatchObject({
            accountId: "anak",
            deviceId: ctx.devAnak.deviceId,
            schemeId: 101,
            value: 25.5,
            label: "Suhu",
            unit: "°C",
            receivedAt: 1000,
        });
        expect(r.readings[0].readingId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("menolak payload dengan deviceId berbeda dari sesi (anti-spoofing)", () => {
        ctx.sessions.bind(SESSION, "anak", ctx.devAnak.deviceId);
        const r = ctx.ingest.ingest({
            sessionId: SESSION,
            deviceId: ctx.devLain.deviceId,
            readings: [{ schemeId: 101, value: 25 }],
            endpoint: ENDPOINT,
        });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toBe(LantanaError.UNKNOWN_DEVICE);
    });

    it("menolak device yang tidak terdaftar pada akun", () => {
        ctx.sessions.bind(SESSION, "anak", "device-hantu");
        const r = ctx.ingest.ingest({
            sessionId: SESSION,
            deviceId: "device-hantu",
            readings: [{ schemeId: 101, value: 25 }],
            endpoint: ENDPOINT,
        });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toBe(LantanaError.UNKNOWN_DEVICE);
    });

    it("menolak scheme yang tidak diizinkan (0x07)", () => {
        ctx.sessions.bind(SESSION, "anak", ctx.devAnak.deviceId);
        const r = ctx.ingest.ingest({
            sessionId: SESSION,
            deviceId: ctx.devAnak.deviceId,
            readings: [{ schemeId: 203, value: 1000 }],
            endpoint: ENDPOINT,
        });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toBe(LantanaError.UNAUTHORIZED_INJECT);
        expect(r.schemeId).toBe(203);
    });

    it("menolak scheme tidak dikenal", () => {
        ctx.sessions.bind(SESSION, "anak", ctx.devAnak.deviceId);
        const r = ctx.ingest.ingest({
            sessionId: SESSION,
            deviceId: ctx.devAnak.deviceId,
            readings: [{ schemeId: 555, value: 1 }],
            endpoint: ENDPOINT,
        });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toBe(LantanaError.UNKNOWN_SCHEME);
    });

    it("menolak nilai di luar rentang", () => {
        ctx.sessions.bind(SESSION, "anak", ctx.devAnak.deviceId);
        const r = ctx.ingest.ingest({
            sessionId: SESSION,
            deviceId: ctx.devAnak.deviceId,
            readings: [{ schemeId: 101, value: 500 }],
            endpoint: ENDPOINT,
        });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toBe(LantanaError.INVALID_VALUE);
    });

    it("menolak paket utuh bila satu bacaan tidak sah (all-or-nothing)", () => {
        ctx.sessions.bind(SESSION, "anak", ctx.devAnak.deviceId);
        const r = ctx.ingest.ingest({
            sessionId: SESSION,
            deviceId: ctx.devAnak.deviceId,
            readings: [
                { schemeId: 101, value: 25 },
                { schemeId: 203, value: 1000 },
            ],
            endpoint: ENDPOINT,
        });
        expect(r.ok).toBe(false);
    });

    it("menolak scheme duplikat dalam satu paket", () => {
        ctx.sessions.bind(SESSION, "anak", ctx.devAnak.deviceId);
        const r = ctx.ingest.ingest({
            sessionId: SESSION,
            deviceId: ctx.devAnak.deviceId,
            readings: [
                { schemeId: 101, value: 25 },
                { schemeId: 101, value: 26 },
            ],
            endpoint: ENDPOINT,
        });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toBe(LantanaError.PAYLOAD_INVALID);
    });

    it("menolak paket kosong", () => {
        ctx.sessions.bind(SESSION, "anak", ctx.devAnak.deviceId);
        const r = ctx.ingest.ingest({
            sessionId: SESSION,
            deviceId: ctx.devAnak.deviceId,
            readings: [],
            endpoint: ENDPOINT,
        });
        expect(r.ok).toBe(false);
    });

    it("sesi device root tidak bisa dipakai akun lain", () => {
        ctx.sessions.bind(SESSION, "root", ctx.devRoot.deviceId);
        const r = ctx.ingest.ingest({
            sessionId: SESSION,
            deviceId: ctx.devRoot.deviceId,
            readings: [{ schemeId: 203, value: 1000 }],
            endpoint: ENDPOINT,
        });
        expect(r.ok).toBe(true);

        // Device milik "anak" tidak bisa dikirim lewat sesi root.
        const spoof = ctx.ingest.ingest({
            sessionId: SESSION,
            deviceId: ctx.devAnak.deviceId,
            readings: [{ schemeId: 101, value: 25 }],
            endpoint: ENDPOINT,
        });
        expect(spoof.ok).toBe(false);
    });
});
