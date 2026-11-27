/**
 * account-manager.test.ts — Akun parent-child dan AccessKey.
 */

import { describe, it, expect } from "vitest";
import { AccountError, AccountManager } from "./account-manager";
import { derivePsk } from "./lantana-psk";

describe("hierarki akun", () => {
    it("membuat root dan child dengan parent yang benar", () => {
        const mgr = new AccountManager();
        mgr.createRoot("root");
        mgr.createChild("root", "anak");

        expect(mgr.get("root")!.parentId).toBeNull();
        expect(mgr.get("anak")!.parentId).toBe("root");
        expect(mgr.listChildren("root").map((a) => a.accountId)).toEqual(["anak"]);
    });

    it("menolak accountId duplikat", () => {
        const mgr = new AccountManager();
        mgr.createRoot("root");
        expect(() => mgr.createRoot("root")).toThrow(AccountError);
    });

    it("menolak child tanpa parent terdaftar", () => {
        const mgr = new AccountManager();
        expect(() => mgr.createChild("tidak-ada", "anak")).toThrow(/parent tidak ditemukan/);
    });

    it("canManage hanya untuk diri sendiri dan keturunan", () => {
        const mgr = new AccountManager();
        mgr.createRoot("root");
        mgr.createChild("root", "anak");
        mgr.createChild("anak", "cucu");
        mgr.createRoot("lain");

        expect(mgr.canManage("root", "anak")).toBe(true);
        expect(mgr.canManage("root", "cucu")).toBe(true);
        expect(mgr.canManage("anak", "cucu")).toBe(true);
        expect(mgr.canManage("anak", "root")).toBe(false);
        expect(mgr.canManage("lain", "cucu")).toBe(false);
    });

    it("menolak hapus akun yang masih punya child", () => {
        const mgr = new AccountManager();
        mgr.createRoot("root");
        mgr.createChild("root", "anak");
        expect(() => mgr.remove("root")).toThrow(/masih punya child/);
        mgr.remove("anak");
        mgr.remove("root");
        expect(mgr.has("root")).toBe(false);
    });
});

describe("izin", () => {
    it("default menolak semua", () => {
        const mgr = new AccountManager();
        const acc = mgr.createRoot("root");
        expect(acc.permissions.allowedInjectSchemes).toEqual([]);
        expect(acc.permissions.allowedQuerySchemes).toEqual([]);
        expect(acc.permissions.allowedCommandDevices).toEqual([]);
    });

    it("menormalisasi rentang dan membuang entri tidak valid", () => {
        const mgr = new AccountManager();
        const acc = mgr.createRoot("root", {
            allowedInjectSchemes: [100, { from: 201, to: 205 }, { from: 9, to: 1 } as any, -5 as any],
            allowedQuerySchemes: [{ from: 100, to: 103 }],
            allowedCommandDevices: ["dev-1", "dev-1", ""],
        });
        expect(acc.permissions.allowedInjectSchemes).toEqual([100, { from: 201, to: 205 }]);
        expect(acc.permissions.allowedQuerySchemes).toEqual([{ from: 100, to: 103 }]);
        expect(acc.permissions.allowedCommandDevices).toEqual(["dev-1"]);
    });
});

describe("AccessKey", () => {
    it("menerbitkan key 64 hex dan memverifikasinya", () => {
        const mgr = new AccountManager();
        mgr.createRoot("root");
        const key = mgr.issueAccessKey("root");

        expect(key).toMatch(/^[0-9a-f]{64}$/);
        expect(mgr.verifyAccessKey("root", key)).toBe(true);
        expect(mgr.verifyAccessKey("root", "deadbeef")).toBe(false);
    });

    it("tidak menyimpan key mentah", () => {
        const mgr = new AccountManager();
        mgr.createRoot("root");
        const key = mgr.issueAccessKey("root");
        const serialized = JSON.stringify(mgr.toJSON());
        expect(serialized).not.toContain(key);
        expect(mgr.get("root")!.credential!.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("menyimpan PSK = SHA-256(accessKey) untuk handshake ESP8266", () => {
        const mgr = new AccountManager();
        mgr.createRoot("root");
        const key = mgr.issueAccessKey("root");

        expect(mgr.getPsk("root")!.equals(derivePsk(key))).toBe(true);
        mgr.revokeAccessKey("root");
        expect(mgr.getPsk("root")).toBeNull();
    });

    it("rotasi mengganti PSK", () => {
        const mgr = new AccountManager();
        mgr.createRoot("root");
        mgr.issueAccessKey("root");
        const oldPsk = Buffer.from(mgr.getPsk("root")!);
        mgr.rotateAccessKey("root");
        expect(mgr.getPsk("root")!.equals(oldPsk)).toBe(false);
    });

    it("rotasi membatalkan key lama", () => {
        const mgr = new AccountManager();
        mgr.createRoot("root");
        const oldKey = mgr.issueAccessKey("root");
        const newKey = mgr.rotateAccessKey("root");

        expect(newKey).not.toBe(oldKey);
        expect(mgr.verifyAccessKey("root", oldKey)).toBe(false);
        expect(mgr.verifyAccessKey("root", newKey)).toBe(true);
    });

    it("pencabutan menolak semua key", () => {
        const mgr = new AccountManager();
        mgr.createRoot("root");
        const key = mgr.issueAccessKey("root");
        mgr.revokeAccessKey("root");

        expect(mgr.hasAccessKey("root")).toBe(false);
        expect(mgr.verifyAccessKey("root", key)).toBe(false);
    });

    it("key akun lain tidak berlaku", () => {
        const mgr = new AccountManager();
        mgr.createRoot("a");
        mgr.createRoot("b");
        const keyA = mgr.issueAccessKey("a");
        mgr.issueAccessKey("b");

        expect(mgr.verifyAccessKey("b", keyA)).toBe(false);
    });
});

describe("serialisasi", () => {
    it("round-trip mempertahankan akun, izin, dan verifier", () => {
        const mgr = new AccountManager();
        mgr.createRoot("root", { allowedInjectSchemes: [{ from: 1, to: 5 }] });
        mgr.createChild("root", "anak");
        const key = mgr.issueAccessKey("anak");

        const restored = AccountManager.fromJSON(JSON.parse(JSON.stringify(mgr.toJSON())));
        expect(restored.get("anak")!.parentId).toBe("root");
        expect(restored.verifyAccessKey("anak", key)).toBe(true);
        expect(restored.get("root")!.permissions.allowedInjectSchemes).toEqual([{ from: 1, to: 5 }]);
    });

    // SEC-15: PSK langsung bisa dipakai login sebagai device akun → tidak boleh
    // ikut accounts.json; disimpan di tabel terpisah (file 0600).
    it("toJSON tidak memuat PSK; pskTable() memuatnya; round-trip lewat keduanya", () => {
        const mgr = new AccountManager();
        mgr.createRoot("root");
        mgr.createRoot("tanpa-key");
        const key = mgr.issueAccessKey("root");
        const psk = derivePsk(key).toString("hex");

        const records = JSON.parse(JSON.stringify(mgr.toJSON()));
        expect(JSON.stringify(records)).not.toContain(psk);
        expect(records[0].credential.psk).toBeUndefined();
        expect(mgr.pskTable()).toEqual({ root: psk });

        const restored = AccountManager.fromJSON(records, mgr.pskTable());
        expect(restored.getPsk("root")!.toString("hex")).toBe(psk);
        expect(restored.getPsk("tanpa-key")).toBeNull();
        expect(AccountManager.fromJSON(records).getPsk("root")).toBeNull();
    });

    it("PSK lama di accounts.json dibaca (migrasi) bila tabel tidak punya", () => {
        const legacy = [
            {
                accountId: "root",
                parentId: null,
                permissions: {},
                credential: { salt: "00", hash: "11", psk: "ab".repeat(32), issuedAt: 1 },
                createdAt: 1,
            },
        ];
        const mgr = AccountManager.fromJSON(legacy as any, {});
        expect(mgr.getPsk("root")!.toString("hex")).toBe("ab".repeat(32));
        expect(mgr.hasLegacyPsk).toBe(true);
        expect(JSON.stringify(mgr.toJSON())).not.toContain("ab".repeat(32));
    });
});

describe("batas panjang accountId", () => {
    it("menerima 64 karakter dan menolak 65", () => {
        const mgr = new AccountManager();
        expect(mgr.createRoot("a".repeat(64)).accountId).toHaveLength(64);
        expect(() => mgr.createRoot("b".repeat(65))).toThrow(/maksimal 64/);
        expect(() => mgr.createChild("a".repeat(64), "c".repeat(65))).toThrow(/maksimal 64/);
        expect(mgr.has("b".repeat(65))).toBe(false);
    });
});
