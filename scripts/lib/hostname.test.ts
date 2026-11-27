import { describe, it, expect } from "vitest";
import { hostnameProblem, suggestHostname } from "./hostname";

describe("hostname installer (SEC-21b)", () => {
    it("nama umum yang mudah bentrok di broker bersama ditolak", () => {
        for (const h of ["tsix", "TSIX", "localhost", "node", "test", "esp32"]) {
            expect(hostnameProblem(h)).not.toBeNull();
        }
    });

    it("nama tidak valid untuk topik MQTT ditolak", () => {
        for (const h of ["", "a b", "kebun/1", "x#", "y+", "*"]) expect(hostnameProblem(h)).not.toBeNull();
    });

    it("nama unik diterima", () => {
        expect(hostnameProblem("kebun-pakdhe")).toBeNull();
        expect(hostnameProblem("wintsix")).toBeNull();
    });

    it("saran: tsix-<6 huruf/angka acak>, lolos pemeriksaan, berbeda tiap panggilan", () => {
        const a = suggestHostname();
        const b = suggestHostname();
        expect(a).toMatch(/^tsix-[a-z0-9]{6}$/);
        expect(hostnameProblem(a)).toBeNull();
        expect(a).not.toBe(b);
    });
});
