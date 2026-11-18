import { describe, it, expect, vi } from "vitest";
import { EchoGuard, messageFingerprint, ECHO_MAX_ENTRIES } from "./PacketForwarder";

/**
 * ANTI-BOUNCE (EchoGuard) — uji logika dedupe bridge.
 *
 * Konteks bug yang dijaga: bridge subscribe `mqtnl@1.x/#`, jadi publish-nya
 * sendiri dipantulkan broker kembali. Tanpa penjagaan, satu paket memantul
 * A↔B sampai MAX_FORWARD dan tiba 3× di tujuan (karakter berlipat di tssh).
 *
 * Yang diuji di sini logika jejak hash-nya saja (tanpa broker), karena inti
 * perbaikannya ada di "kapan sebuah byte dianggap echo".
 */

describe("EchoGuard — anti-bounce bridge", () => {
    it("P1.01 hash yang tidak pernah di-publish bukan echo", () => {
        const guard = new EchoGuard();
        expect(guard.consume("abc")).toBe(false);
    });

    it("P1.02 hash yang baru di-publish dikenali sebagai echo (sekali pakai)", () => {
        const guard = new EchoGuard();
        guard.remember("abc");

        expect(guard.consume("abc")).toBe(true);
        // Entri dihapus: echo kedua (mis. QoS retry) tidak lagi dianggap echo,
        // sehingga paket sah dengan byte sama tetap bisa lewat.
        expect(guard.consume("abc")).toBe(false);
    });

    it("P1.03 entri kedaluwarsa setelah TTL (paket identik sah tetap lolos)", () => {
        const guard = new EchoGuard(50);
        guard.remember("abc");

        const realNow = Date.now();
        const spy = vi.spyOn(Date, "now").mockReturnValue(realNow + 100);
        try {
            expect(guard.consume("abc")).toBe(false);
        } finally {
            spy.mockRestore();
        }
    });

    it("P1.04 dua arah terpisah: leak ke arah lain tidak dianggap echo", () => {
        // Satu instance per arah kirim → echo broker A tidak mengganggu broker B.
        const toA = new EchoGuard();
        const toB = new EchoGuard();

        toA.remember("pesan-1");
        expect(toB.consume("pesan-1")).toBe(false);
        expect(toA.consume("pesan-1")).toBe(true);
    });

    it("P1.05 banyak pesan berbeda tidak saling menghapus", () => {
        const guard = new EchoGuard();
        guard.remember("a");
        guard.remember("b");
        guard.remember("c");

        expect(guard.consume("b")).toBe(true);
        expect(guard.consume("a")).toBe(true);
        expect(guard.consume("c")).toBe(true);
        expect(guard.size).toBe(0);
    });

    it("P1.06 prune membuang entri kedaluwarsa", () => {
        const guard = new EchoGuard(50);
        guard.remember("lama");

        const realNow = Date.now();
        const spy = vi.spyOn(Date, "now").mockReturnValue(realNow + 1000);
        try {
            guard.prune();
            expect(guard.size).toBe(0);
        } finally {
            spy.mockRestore();
        }
    });

    it("P1.07 kapasitas dibatasi (anti-memory-leak)", () => {
        const guard = new EchoGuard(60_000, 10);
        for (let i = 0; i < 50; i++) guard.remember(`pesan-${i}`);
        expect(guard.size).toBeLessThanOrEqual(10);
    });

    it("P1.08 messageFingerprint stabil & peka satu byte", () => {
        const a = Buffer.from("halo dunia");
        const b = Buffer.from("halo dunia");
        const c = Buffer.from("halo dunia!");

        expect(messageFingerprint(a)).toBe(messageFingerprint(b));
        expect(messageFingerprint(a)).not.toBe(messageFingerprint(c));
        // 40 hex = SHA-1
        expect(messageFingerprint(a)).toMatch(/^[0-9a-f]{40}$/);
    });

    it("P1.09 default kapasitas besar tapi terbatas", () => {
        const guard = new EchoGuard();
        for (let i = 0; i < ECHO_MAX_ENTRIES + 10; i++) guard.remember(`p${i}`);
        expect(guard.size).toBeLessThanOrEqual(ECHO_MAX_ENTRIES);
    });
});
