/**
 * Setiap modul `/lib` harus dimiliki sebuah paket tpkg. Kalau tidak, program
 * yang di-install lewat `tpkg install` gagal dengan "Cannot find module
 * '@tsix/...'" di node yang tidak memakai `vfs:bootstrap` (kejadian 2026-11-28:
 * `scp` dari paket nettools butuh `/lib/scp-access.ts` yang tidak ikut paket).
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const MIRROR = path.resolve(__dirname, "..");
const LIB = path.join(MIRROR, "lib");

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            // /lib/common = src/common, dipaketkan otomatis oleh generator base-system.
            if (full === path.join(LIB, "common")) continue;
            out.push(...walk(full));
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
            out.push(full);
        }
    }
    return out;
}

describe("packages.json mencakup semua modul /lib", () => {
    it("tidak ada file /lib/*.ts yang tidak dimiliki paket", () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(MIRROR, "etc/tpkg/packages.json"), "utf8"));
        const owned = new Set<string>();
        for (const pkg of manifest.packages) for (const item of pkg.items) owned.add(item.dst);

        const missing = walk(LIB)
            .map((full) => "/lib/" + path.relative(LIB, full).split(path.sep).join("/"))
            .filter((vfsPath) => !owned.has(vfsPath));

        expect(missing).toEqual([]);
    });
});
