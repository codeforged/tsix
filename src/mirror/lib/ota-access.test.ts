import { describe, it, expect } from "vitest";
import { AkLimiter, OtaSessions, generateActivationKey, resolveFirmwarePath } from "./ota-access";

const DIR = "/opt/esp-ota/firmwares";

describe("ota-access (SEC-27, SEC-29)", () => {
    describe("resolveFirmwarePath", () => {
        it("path relatif dan absolut di dalam direktori firmware diterima", () => {
            expect(resolveFirmwarePath("/test/firmware.bin", DIR)).toBe(`${DIR}/test/firmware.bin`);
            expect(resolveFirmwarePath("test/firmware.bin", DIR)).toBe(`${DIR}/test/firmware.bin`);
            expect(resolveFirmwarePath(`${DIR}/test/firmware.bin`, DIR)).toBe(`${DIR}/test/firmware.bin`);
        });

        it("default /firmware.bin jika path kosong", () => {
            expect(resolveFirmwarePath(undefined, DIR)).toBe(`${DIR}/firmware.bin`);
        });

        it("menolak traversal, direktori tetangga, karakter aneh, dan bukan string", () => {
            expect(resolveFirmwarePath("/../activation-keys.txt", DIR)).toBeNull();
            // Direktori tetangga (`firmwares_other`) tidak dianggap di dalam DIR: diberi prefix.
            expect(resolveFirmwarePath(`${DIR}_other/x.bin`, DIR)).toBe(`${DIR}${DIR}_other/x.bin`);
            expect(resolveFirmwarePath("a\\..\\b", DIR)).toBeNull();
            expect(resolveFirmwarePath("a\u0000b", DIR)).toBeNull();
            expect(resolveFirmwarePath(42, DIR)).toBeNull();
            expect(resolveFirmwarePath(`${DIR}/`, DIR)).toBeNull();
            expect(resolveFirmwarePath("/sub/", DIR)).toBeNull();
        });
    });

    describe("OtaSessions", () => {
        it("ota.read tanpa sesi dari ota.info ditolak", () => {
            const s = new OtaSessions();
            expect(s.get("dev1", `${DIR}/test/firmware.bin`)).toBeNull();
        });

        it("sesi hanya berlaku untuk path yang divalidasi di ota.info", () => {
            const s = new OtaSessions();
            s.begin("dev1", { path: `${DIR}/a.bin`, ak: "ABC123", mac: "", dc: "esp32" });
            expect(s.get("dev1", `${DIR}/a.bin`)?.ak).toBe("ABC123");
            expect(s.get("dev1", `${DIR}/secret.bin`)).toBeNull();
            expect(s.get("dev2", `${DIR}/a.bin`)).toBeNull();
        });

        it("sesi kedaluwarsa setelah idle melewati TTL", () => {
            const s = new OtaSessions(1000);
            s.begin("dev1", { path: `${DIR}/a.bin`, ak: "ABC123", mac: "", dc: "x" }, 0);
            expect(s.get("dev1", `${DIR}/a.bin`, 900)).not.toBeNull();
            expect(s.get("dev1", `${DIR}/a.bin`, 1800)).not.toBeNull(); // get() memperpanjang
            expect(s.get("dev1", `${DIR}/a.bin`, 3000)).toBeNull();
        });

        it("end() menutup sesi; jumlah sesi dibatasi", () => {
            const s = new OtaSessions(60000, 2);
            s.begin("d1", { path: `${DIR}/a.bin`, ak: "A", mac: "", dc: "x" }, 0);
            s.begin("d2", { path: `${DIR}/a.bin`, ak: "B", mac: "", dc: "x" }, 1);
            s.begin("d3", { path: `${DIR}/a.bin`, ak: "C", mac: "", dc: "x" }, 2);
            expect(s.size).toBe(2);
            expect(s.get("d1", `${DIR}/a.bin`, 3)).toBeNull(); // yang paling lama digusur
            s.end("d3");
            expect(s.get("d3", `${DIR}/a.bin`, 3)).toBeNull();
        });
    });

    describe("AkLimiter", () => {
        it("memblokir sementara setelah terlalu banyak AK salah (global)", () => {
            const l = new AkLimiter(3, 60000);
            for (let i = 0; i < 3; i++) {
                expect(l.blocked(i)).toBe(false);
                l.fail(i);
            }
            expect(l.blocked(10)).toBe(true);
            expect(l.blocked(70000)).toBe(false);
        });
    });

    describe("generateActivationKey", () => {
        it("6 karakter A-Z0-9 dan tidak berulang", () => {
            const keys = new Set<string>();
            for (let i = 0; i < 200; i++) {
                const k = generateActivationKey();
                expect(k).toMatch(/^[A-Z0-9]{6}$/);
                keys.add(k);
            }
            expect(keys.size).toBeGreaterThan(195);
        });
    });
});
