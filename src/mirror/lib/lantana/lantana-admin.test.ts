import { describe, it, expect } from "vitest";
import { LANTANA_ADMIN_GROUP, isLantanaAdmin, lantanaAdminGid } from "./lantana-admin";

const PASSWD = [
    "root:x:0:0:root:/root:/bin/tsh.js",
    "andri:x:1000:100:Andri:/home/andri:/bin/tsh.js",
    "budi:x:1001:100:Budi:/home/budi:/bin/tsh.js",
    "cici:x:1002:990:Cici:/home/cici:/bin/tsh.js",
].join("\n");

const GROUP = ["root:x:0:root", "users:x:100:", `${LANTANA_ADMIN_GROUP}:x:990:andri, eko`].join("\n");

describe("isLantanaAdmin (K-10)", () => {
    it("root selalu admin", () => {
        expect(isLantanaAdmin(0, PASSWD, GROUP)).toBe(true);
        expect(isLantanaAdmin(0, "", "")).toBe(true);
    });

    it("anggota tambahan grup lantana-admin diterima", () => {
        expect(isLantanaAdmin(1000, PASSWD, GROUP)).toBe(true);
    });

    it("grup utama lantana-admin diterima", () => {
        expect(isLantanaAdmin(1002, PASSWD, GROUP)).toBe(true);
    });

    it("user lain ditolak", () => {
        expect(isLantanaAdmin(1001, PASSWD, GROUP)).toBe(false);
    });

    it("uid tidak dikenal / grup tidak ada / input aneh ditolak", () => {
        expect(isLantanaAdmin(4242, PASSWD, GROUP)).toBe(false);
        expect(isLantanaAdmin(1000, PASSWD, "users:x:100:andri")).toBe(false);
        expect(isLantanaAdmin(undefined as any, PASSWD, GROUP)).toBe(false);
        expect(isLantanaAdmin(1000, null as any, null as any)).toBe(false);
    });

    it("lantanaAdminGid membaca GID grup, null bila tidak ada", () => {
        expect(lantanaAdminGid(GROUP)).toBe(990);
        expect(lantanaAdminGid("users:x:100:")).toBeNull();
        expect(lantanaAdminGid(`${LANTANA_ADMIN_GROUP}:x::`)).toBeNull();
    });

    it("nama grup harus persis", () => {
        expect(isLantanaAdmin(1000, PASSWD, "lantana-admins:x:991:andri")).toBe(false);
    });
});
