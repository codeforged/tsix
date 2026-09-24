import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BKFS } from "../vfs/BKFS";
import { HostVFS } from "../vfs/HostVFS";
import {
    createRootFilesystem,
    resolveHostRootDir,
    resolveRootHostPath,
    resolveRootType,
} from "./RootFilesystem";
import { SysConfig } from "../common/Config";

/**
 * ROOT FILESYSTEM (A3.40+) — pemilihan backend root `/`.
 *
 * `createRootFilesystem()` sengaja murni (tanpa boot): yang diuji di sini adalah
 * KEPUTUSAN (BKFS vs HostVFS), resolusi path, dan penolakan konfigurasi salah —
 * bukan perilaku filesystem-nya (itu sudah diuji di BKFS.test.ts/HostVFS.test.ts).
 */

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
}

/**
 * makeProjectRoots(): Tiruan struktur repo — `src/kernel` (patokan resolusi) dan
 * `src/rootfs` (root host), supaya `rootHostPath: "../rootfs"` benar-benar diuji
 * dengan aturan yang sama seperti `GET_SYSPATH`.
 */
function makeProjectRoots() {
    const base = makeTmpDir("tsix-rootfs-");
    const kernelDir = path.join(base, "src", "kernel");
    const hostRoot = path.join(base, "src", "rootfs");
    fs.mkdirSync(kernelDir, { recursive: true });
    fs.mkdirSync(hostRoot, { recursive: true });
    return { base, kernelDir, hostRoot };
}

/** Config minimal; `database` pakai ":memory:" supaya tidak menyentuh berkas. */
function cfgWith(kernel: Partial<SysConfig["kernel"]> = {}): SysConfig {
    return {
        kernel: {
            version: "test",
            database: ":memory:",
            rootHostPath: "../mirror",
            bootLogPath: "/logs/boot.log",
            verbose: false,
            distroName: "test",
            engineName: "test",
            ...kernel,
        },
    } as SysConfig;
}

afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe("RootFilesystem", () => {
    // A3.40
    it("A3.40 tanpa rootType → BKFS (SQLite), perilaku lama tidak berubah", () => {
        const root = createRootFilesystem(cfgWith(), { env: {} });

        expect(root.type).toBe("bkfs");
        expect(root.driver).toBeInstanceOf(BKFS);
        expect(root.source).toBe(":memory:");
        expect(root.label).toContain("BKFS");
    });

    // A3.41
    it("A3.41 rootType=host → HostVFS pada folder rootHostPath (relatif src/kernel)", () => {
        const { kernelDir, hostRoot } = makeProjectRoots();

        const root = createRootFilesystem(
            cfgWith({ rootType: "host", rootHostPath: "../rootfs" }),
            { env: {}, kernelDir },
        );

        expect(root.type).toBe("host");
        expect(root.driver).toBeInstanceOf(HostVFS);
        expect(root.source).toBe(hostRoot);
        expect(root.label).toContain("HostVFS");
    });

    // A3.42
    it("A3.42 rootType=host but the folder is missing → hard failure (not an empty root)", () => {
        const { base, kernelDir } = makeProjectRoots();
        const missing = path.join(base, "src", "rootfs-tidak-ada");

        expect(() =>
            createRootFilesystem(cfgWith({ rootType: "host", rootHostPath: "../rootfs-tidak-ada" }), {
                env: {},
                kernelDir,
            }),
        ).toThrow(/not found/i);

        // Factory TIDAK boleh membuat foldernya sendiri (itu tugas HostVFS).
        expect(fs.existsSync(missing)).toBe(false);
    });

    // A3.43
    it("A3.43 env TSIX_ROOTFS mengalahkan sysconfig (bkfs → host)", () => {
        const { kernelDir, hostRoot } = makeProjectRoots();

        const root = createRootFilesystem(
            cfgWith({ rootType: "bkfs", rootHostPath: "../rootfs" }),
            { env: { TSIX_ROOTFS: "HOST" }, kernelDir }, // sengaja huruf besar
        );

        expect(root.type).toBe("host");
        expect(root.source).toBe(hostRoot);
    });

    // A3.44
    it("A3.44 unknown rootType → clear error, not a silent fallback to BKFS", () => {
        expect(() => resolveRootType(cfgWith({ rootType: "hostt" as any }), {})).toThrow(
            /Unknown rootType/,
        );
        expect(() =>
            createRootFilesystem(cfgWith({ rootType: "hostt" as any }), { env: {} }),
        ).toThrow(/Unknown rootType/);
    });

    // A3.45
    it("A3.45 resolveRootHostPath → absolut, relatif terhadap src/kernel", () => {
        const kernelDir = path.join(os.tmpdir(), "tsix-kernel-dir");
        expect(resolveRootHostPath(cfgWith({ rootHostPath: "../rootfs" }), kernelDir)).toBe(
            path.resolve(os.tmpdir(), "rootfs"),
        );
    });

    // A3.46
    it("A3.46 TSIX_ROOTFS_PATH menunjuk folder lain tanpa mengubah sysconfig", () => {
        const other = makeTmpDir("tsix-other-root-");
        const { kernelDir } = makeProjectRoots();

        const root = createRootFilesystem(cfgWith({ rootType: "host" }), {
            env: { TSIX_ROOTFS_PATH: other },
            kernelDir,
        });

        expect(root.type).toBe("host");
        expect(root.source).toBe(other);
    });

    // A3.47
    it("A3.47 resolveHostRootDir – TSIX_ROOTFS_PATH menang, fallback rootHostPath", () => {
        const { kernelDir, hostRoot } = makeProjectRoots();
        const cfg = cfgWith({ rootType: "host", rootHostPath: "../rootfs" });

        // Tanpa env: ikut rootHostPath (relatif src/kernel)
        expect(resolveHostRootDir(cfg, {}, kernelDir)).toBe(hostRoot);

        // Dengan env: env menang — ini yang membuat alat luar (sync-vfs,
        // rootfs:modes) tidak berbeda pendapat dengan kernel.
        const viaEnv = "tsix-rootfs-env-" + path.basename(hostRoot);
        expect(resolveHostRootDir(cfg, { TSIX_ROOTFS_PATH: viaEnv }, kernelDir)).toBe(
            path.resolve(viaEnv),
        );
    });
});
