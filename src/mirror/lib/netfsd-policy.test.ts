import { describe, it, expect } from "vitest";
import { exportSecurity, serveIdentity } from "./netfsd-policy";

const PASSWD = [
    "root:x:0:0:root:/root:/bin/tsh.js",
    "andri:x:1000:100:Andri:/home/andri:/bin/tsh.js",
    "nobody:x:65534:65534:nobody:/:/bin/false",
].join("\n");

describe("netfsd-policy (SEC-10)", () => {
    describe("exportSecurity", () => {
        it("dengan --key: jalan, read-only mengikuti --ro", () => {
            expect(exportSecurity({ hasKey: true, insecure: false, readOnly: false })).toEqual({
                ok: true,
                readOnly: false,
                warnings: [],
            });
        });

        it("tanpa --key dan tanpa --insecure: menolak start", () => {
            const r = exportSecurity({ hasKey: false, insecure: false, readOnly: false });
            expect(r.ok).toBe(false);
            expect(r.error).toMatch(/--key/);
        });

        it("--insecure tanpa key: dipaksa read-only + peringatan", () => {
            const r = exportSecurity({ hasKey: false, insecure: true, readOnly: false });
            expect(r.ok).toBe(true);
            expect(r.readOnly).toBe(true);
            expect(r.warnings.join(" ")).toMatch(/insecure|tanpa autentikasi/i);
        });
    });

    describe("serveIdentity", () => {
        it("--as <user> → uid/gid user itu", () => {
            expect(serveIdentity("andri", { uid: 0, gid: 0 }, PASSWD)).toEqual({ uid: 1000, gid: 100, name: "andri" });
            expect(serveIdentity("nobody", { uid: 0, gid: 0 }, PASSWD)).toEqual({ uid: 65534, gid: 65534, name: "nobody" });
        });

        it("--as user tidak dikenal → error", () => {
            expect(serveIdentity("hantu", { uid: 0, gid: 0 }, PASSWD)).toEqual({ error: "user tidak dikenal: hantu" });
        });

        it("tanpa --as: pemilik direktori export", () => {
            expect(serveIdentity(undefined, { uid: 1000, gid: 100 }, PASSWD)).toEqual({ uid: 1000, gid: 100, name: "andri" });
        });

        it("tanpa --as, export milik root → root (pemanggil memberi peringatan)", () => {
            expect(serveIdentity(undefined, { uid: 0, gid: 0 }, PASSWD)).toEqual({ uid: 0, gid: 0, name: "root" });
        });

        it("pemilik export tidak ada di passwd → tetap pakai uid/gid numeriknya", () => {
            expect(serveIdentity(undefined, { uid: 1500, gid: 1500 }, PASSWD)).toEqual({ uid: 1500, gid: 1500, name: "1500" });
        });
    });
});
