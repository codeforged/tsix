import { describe, it, expect } from "vitest";
import * as bcrypt from "bcryptjs";
import { hasDefaultRootPassword, rootPasswordProblem } from "./default-credentials";

describe("default-credentials (SEC-20)", () => {
    const shadow = (rootPw: string) =>
        `root:${bcrypt.hashSync(rootPw, 4)}:19000:0:99999:7:::\nalice:${bcrypt.hashSync("x", 4)}\n`;

    it("hash root = 'root' → terdeteksi sebagai password bawaan", () => {
        expect(hasDefaultRootPassword(shadow("root"))).toBe(true);
    });

    it("password root lain, akun terkunci, atau tanpa entri root → bukan bawaan", () => {
        expect(hasDefaultRootPassword(shadow("s3cret!"))).toBe(false);
        expect(hasDefaultRootPassword("root:!:19000::::::\n")).toBe(false);
        expect(hasDefaultRootPassword("root:*\n")).toBe(false);
        expect(hasDefaultRootPassword("alice:x\n")).toBe(false);
        expect(hasDefaultRootPassword("")).toBe(false);
    });

    it("password root baru: kosong dan 'root' ditolak, selain itu diterima", () => {
        expect(rootPasswordProblem("")).toMatch(/empty/i);
        expect(rootPasswordProblem("root")).toMatch(/default/i);
        expect(rootPasswordProblem("ROOT")).toMatch(/default/i);
        expect(rootPasswordProblem("kebun-2026")).toBeNull();
    });
});
