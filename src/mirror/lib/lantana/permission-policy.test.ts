/**
 * permission-policy.test.ts — Otorisasi inject/query/command.
 */

import { describe, it, expect } from "vitest";
import { AccountManager } from "./account-manager";
import { SchemeRegistry } from "./scheme-registry";
import { PermissionPolicy } from "./permission-policy";
import { LantanaError } from "./lantana-core";

function setup() {
    const accounts = new AccountManager();
    const schemes = new SchemeRegistry();

    accounts.createRoot("root", {
        allowedInjectSchemes: [{ from: 201, to: 205 }],
        allowedCommandDevices: ["dev-root"],
    });
    accounts.createChild("root", "anak", {
        allowedInjectSchemes: [100],
        allowedQuerySchemes: [{ from: 100, to: 103 }],
    });

    schemes.add({ schemeId: 100, ownerAccountId: "anak", label: "Suhu", type: "number" });
    schemes.add({ schemeId: 203, ownerAccountId: "root", label: "Tekanan", type: "number" });
    schemes.add({ schemeId: 300, ownerAccountId: "root", label: "Lain", type: "number" });

    return { accounts, schemes, policy: new PermissionPolicy(accounts, schemes) };
}

describe("canInject", () => {
    it("pemilik scheme selalu boleh", () => {
        const { policy } = setup();
        expect(policy.canInject("anak", 100).ok).toBe(true);
        expect(policy.canInject("root", 203).ok).toBe(true);
    });

    it("akun lain harus punya izin eksplisit", () => {
        const { policy } = setup();
        expect(policy.canInject("root", 203).ok).toBe(true);
        expect(policy.canInject("anak", 203).ok).toBe(false);
        expect(policy.canInject("anak", 203).error).toBe(LantanaError.UNAUTHORIZED_INJECT);
    });

    it("child tidak mewarisi izin parent", () => {
        const { policy } = setup();
        // root punya 201-205, anak tidak.
        expect(policy.canInject("anak", 204).ok).toBe(false);
    });

    it("menolak akun tidak dikenal", () => {
        const { policy } = setup();
        const r = policy.canInject("hantu", 100);
        expect(r.ok).toBe(false);
        expect(r.error).toBe(LantanaError.UNKNOWN_ACCOUNT);
    });
});

describe("canQuery", () => {
    it("mengikuti daftar allowedQuerySchemes", () => {
        const { policy } = setup();
        expect(policy.canQuery("anak", 102).ok).toBe(true);
        expect(policy.canQuery("anak", 103).ok).toBe(true);
        expect(policy.canQuery("anak", 104).ok).toBe(false);
        expect(policy.canQuery("anak", 104).error).toBe(LantanaError.UNAUTHORIZED_QUERY);
    });

    it("filterQueryable membuang scheme tanpa izin", () => {
        const { policy } = setup();
        expect(policy.filterQueryable("anak", [100, 101, 203, 300])).toEqual([100, 101]);
    });
});

describe("canCommand", () => {
    it("hanya device yang terdaftar di izin", () => {
        const { policy } = setup();
        expect(policy.canCommand("root", "dev-root").ok).toBe(true);
        expect(policy.canCommand("root", "dev-lain").ok).toBe(false);
        expect(policy.canCommand("root", "dev-lain").error).toBe(LantanaError.UNAUTHORIZED_COMMAND);
        expect(policy.canCommand("anak", "dev-root").ok).toBe(false);
    });
});
