/**
 * session-manager.test.ts — State sesi MQTNL.
 */

import { describe, it, expect } from "vitest";
import { SessionManager, SESSION_IDLE_TTL_MS } from "./session-manager";

describe("SessionManager", () => {
    it("sesi baru belum terautentikasi", () => {
        const mgr = new SessionManager();
        const s = mgr.open("10.0.0.1:4000", 1000);
        expect(s.authenticated).toBe(false);
        expect(mgr.isAuthenticated(s.id)).toBe(false);
    });

    it("bind mengikat akun dan device", () => {
        const mgr = new SessionManager();
        mgr.open("s1", 1000);
        mgr.bind("s1", "acc", "dev", 2000);

        const s = mgr.get("s1")!;
        expect(s).toMatchObject({ accountId: "acc", deviceId: "dev", authenticated: true });
        expect(mgr.isAuthenticated("s1")).toBe(true);
    });

    it("nonce disimpan sampai auth berhasil", () => {
        const mgr = new SessionManager();
        mgr.open("s1");
        mgr.setNonce("s1", "abc");
        expect(mgr.get("s1")!.nonce).toBe("abc");

        mgr.bind("s1", "acc", "dev");
        expect(mgr.get("s1")!.nonce).toBeNull();
    });

    it("cleanup membuang sesi yang idle", () => {
        const mgr = new SessionManager();
        mgr.open("lama", 1000);
        mgr.open("baru", 100_000);

        const removed = mgr.cleanup(1000 + SESSION_IDLE_TTL_MS + 1);
        expect(removed).toEqual(["lama"]);
        expect(mgr.get("baru")).toBeDefined();
    });

    it("touch memperpanjang masa hidup sesi", () => {
        const mgr = new SessionManager();
        mgr.open("s1", 1000);
        mgr.touch("s1", 50_000);

        expect(mgr.cleanup(60_000)).toEqual([]);
    });

    it("close menghapus sesi", () => {
        const mgr = new SessionManager();
        mgr.open("s1");
        mgr.close("s1");
        expect(mgr.isAuthenticated("s1")).toBe(false);
        expect(mgr.size).toBe(0);
    });
});
