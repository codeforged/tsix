import { describe, it, expect } from "vitest";
import {
    MAX_RELATIVE_MODULES,
    collectRelativeModules,
    findRelativeImports,
    resolveVfsRelative,
    vfsCandidates,
} from "./VfsModuleResolver";

/**
 * VFS module resolver (R1) — import relatif userland (`./x`, `../y`).
 *
 * Regresi yang dijaga: dulu `require("./TpkgProtocol")` dari `/sbin/tpkgd.ts`
 * mencari file itu di HOST filesystem sehingga program apa pun yang punya modul
 * pendamping di direktori yang sama gagal dijalankan:
 *
 *     [Worker 35] Direct Execution Error: Cannot find module './TpkgProtocol'
 *
 * Helper di sini murni (tanpa `Module._load`, tanpa VFS), jadi bisa diuji
 * langsung dengan I/O tiruan.
 */

/** VFS palsu: peta path → isi file. */
function fakeVfs(files: Record<string, string>) {
    return async (vfsPath: string): Promise<string | null> => files[vfsPath] ?? null;
}

/** Transpile tiruan: cukup menandai bahwa file pernah diproses. */
const markerTranspile = (src: string, id: string) => `/*compiled:${id}*/${src}`;

describe("VfsModuleResolver — resolusi relatif (R1)", () => {
    it("R1.01 resolveVfsRelative: ./ dan ../ dihitung dari direktori file induk", () => {
        expect(resolveVfsRelative("/sbin/tpkgd.ts", "./TpkgProtocol")).toBe("/sbin/TpkgProtocol");
        expect(resolveVfsRelative("/sbin/tpkgd.js", "./TpkgProtocol")).toBe("/sbin/TpkgProtocol");
        expect(resolveVfsRelative("/sbin/tpkgd.ts", "./sub/x")).toBe("/sbin/sub/x");
        expect(resolveVfsRelative("/sbin/tpkgd.ts", "../lib/util")).toBe("/lib/util");
        expect(resolveVfsRelative("/opt/app/a/b/main.ts", "../../common/x")).toBe("/opt/app/common/x");
        expect(resolveVfsRelative("/bin/init.ts", "./helper.ts")).toBe("/bin/helper.ts");
    });

    it("R1.02 resolveVfsRelative: request non-relatif & escape root ditolak", () => {
        expect(resolveVfsRelative("/sbin/tpkgd.ts", "@tsix/UserLib")).toBeNull();
        expect(resolveVfsRelative("/sbin/tpkgd.ts", "left-pad")).toBeNull();
        expect(resolveVfsRelative("/sbin/tpkgd.ts", "../..")).toBeNull(); // naik dari /sbin → keluar
        expect(resolveVfsRelative("/a.ts", "./..")).toBeNull();
    });

    it("R1.03 vfsCandidates: .ts lebih dulu dari .js, lalu index", () => {
        expect(vfsCandidates("/sbin/TpkgProtocol")).toEqual([
            "/sbin/TpkgProtocol.ts",
            "/sbin/TpkgProtocol.js",
            "/sbin/TpkgProtocol/index.ts",
            "/sbin/TpkgProtocol/index.js",
        ]);
    });

    it("R1.04 findRelativeImports: import/export/require/dynamic-literal", () => {
        const source = [
            `import { a } from "./a";`,
            `import b from './b.ts';`,
            `export { c } from "./sub/c";`,
            `const d = require("../d");`,
            `const e = await import("./e");`,
            `import { f } from "@tsix/UserLib";`, // bukan relatif
            `import { g } from "../lib/NetworkLib";`, // relatif, tetap terdeteksi
        ].join("\n");

        const found = findRelativeImports(source);
        expect(found).toContain("./a");
        expect(found).toContain("./b"); // ekstensi dibuang
        expect(found).toContain("./sub/c");
        expect(found).toContain("../d");
        expect(found).toContain("./e");
        expect(found).toContain("../lib/NetworkLib");
        expect(found).not.toContain("@tsix/UserLib");
    });

    it("R1.05 collectRelativeModules: menelusuri transitif sampai kedalaman bebas", async () => {
        const readFile = fakeVfs({
            "/sbin/TpkgProtocol.ts": `export const X = 1; import { Y } from "./inner/Deep";`,
            "/sbin/inner/Deep.ts": `import { Z } from "./Deepest"; export const Y = Z;`,
            "/sbin/inner/Deepest.ts": `export const Z = 3;`,
        });

        const mods = await collectRelativeModules({
            entryId: "/sbin/tpkgd",
            source: `import { a } from "./TpkgProtocol"; import { b } from "../lib/NetworkLib";`,
            readFile,
            transpile: markerTranspile,
        });

        expect(Object.keys(mods).sort()).toEqual(["/sbin/TpkgProtocol", "/sbin/inner/Deep", "/sbin/inner/Deepest"]);
        expect(mods["/sbin/TpkgProtocol"]).toContain("compiled:/sbin/TpkgProtocol");
        // Entry sendiri TIDAK ikut (sudah di-compile jalur program).
        expect(mods["/sbin/tpkgd"]).toBeUndefined();
    });

    it("R1.06 collectRelativeModules: file .js dipakai apa adanya, .ts ditranspile", async () => {
        const readFile = fakeVfs({
            "/opt/app/plain.js": `module.exports = 1;`,
            "/opt/app/typed.ts": `export const t = 1;`,
        });

        const mods = await collectRelativeModules({
            entryId: "/opt/app/main",
            source: `require("./plain"); require("./typed");`,
            readFile,
            transpile: markerTranspile,
        });

        expect(mods["/opt/app/plain"]).toBe(`module.exports = 1;`); // tanpa marker
        expect(mods["/opt/app/typed"]).toContain("compiled:");
    });

    it("R1.07 collectRelativeModules: file tidak ada / bukan VFS → dilewati, tidak melempar", async () => {
        const mods = await collectRelativeModules({
            entryId: "/sbin/tpkgd",
            source: `import x from "./TidakAda"; import y from "node:fs"; import z from "@tsix/UserLib";`,
            readFile: fakeVfs({}),
            transpile: markerTranspile,
        });

        expect(mods).toEqual({});
    });

    it("R1.08 collectRelativeModules: siklus import tidak menggantung", async () => {
        const readFile = fakeVfs({
            "/a/One.ts": `import { b } from "./Two";`,
            "/a/Two.ts": `import { a } from "./One";`,
        });

        const mods = await collectRelativeModules({
            entryId: "/a/Main",
            source: `import { a } from "./One";`,
            readFile,
            transpile: markerTranspile,
        });

        expect(Object.keys(mods).sort()).toEqual(["/a/One", "/a/Two"]);
    });

    it("R1.09 collectRelativeModules: ada pagar jumlah modul (tidak liar)", async () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < 20; i++) files[`/many/M${i}.ts`] = `export const v = ${i};`;

        const mods = await collectRelativeModules({
            entryId: "/many/Main",
            source: Array.from({ length: 20 }, (_, i) => `require("./M${i}");`).join("\n"),
            readFile: fakeVfs(files),
            transpile: markerTranspile,
            maxFiles: 5,
        });

        expect(Object.keys(mods).length).toBeLessThanOrEqual(6);
        expect(MAX_RELATIVE_MODULES).toBeGreaterThan(5);
    });

    it("R1.10 resolveVfsRelative: `..` tidak menembus root (regresi `/common/SyscallCode.ts`)", () => {
        // Regresi nyata: `/lib/UserLib` meng-import `../../common/SyscallCode`
        // (layout host: src/mirror/lib → src/common). Dulu hasilnya
        // "/common/SyscallCode" — path yang TIDAK ada di VFS, sehingga pembaca
        // VFS melempar di tengah pemindaian:
        //   [Worker 46] Local module scan failed: File not found: /common/SyscallCode.ts
        expect(resolveVfsRelative("/lib/UserLib.ts", "../../common/SyscallCode")).toBeNull();
        expect(resolveVfsRelative("/lib/UserLib.ts", "../../common/IPCTypes")).toBeNull();
        expect(resolveVfsRelative("/usr/local/bin/tsd.ts", "../../../../common/SecurityAgent")).toBeNull();
        // Naik sampai akar masih legal; satu langkah lagi = keluar.
        expect(resolveVfsRelative("/lib/sub/x.ts", "../NetworkLib")).toBe("/lib/NetworkLib");
        expect(resolveVfsRelative("/a/b/c.ts", "../../c")).toBe("/c");
        expect(resolveVfsRelative("/a/b/c.ts", "../../../c")).toBeNull();
    });

    it("R1.11 collectRelativeModules: pembaca yang MELEMPAR untuk file hilang tidak membatalkan scan", async () => {
        // `lib.fs.readFile` di dalam worker MELEMPAR `File not found: <path>`
        // (bukan return null). Satu kandidat yang hilang dulu membatalkan SELURUH
        // pemindaian → program kehilangan semua modul sesama direktori.
        const throwingVfs = async (vfsPath: string): Promise<string | null> => {
            if (vfsPath === "/sbin/Ada.ts") return `import { b } from "./Hilang"; export const a = 1;`;
            if (vfsPath === "/sbin/Anak.ts") return `export const b = 2;`;
            throw new Error(`File not found: ${vfsPath}`);
        };

        const mods = await collectRelativeModules({
            entryId: "/sbin/app",
            source: `import { a } from "./Ada"; import { c } from "./Anak"; import { d } from "./Hilang";`,
            readFile: throwingVfs,
            transpile: markerTranspile,
        });

        expect(Object.keys(mods).sort()).toEqual(["/sbin/Ada", "/sbin/Anak"]);
        // Import opsional (hilang) dilewati tanpa menghentikan penelusuran anak.
        expect(mods["/sbin/Anak"]).toContain("compiled:/sbin/Anak");
    });
});
