import { describe, it, expect } from "vitest";
import * as crypto from "crypto";
import {
    TPKG_DEFAULT_PORT,
    TPKG_EXEC_MODE,
    TPKG_SBIN_MODE,
    TPKG_SETUID_MODE,
    bundleDigest,
    bundleMeta,
    compareVersions,
    formatBytes,
    isSafeHostDst,
    parseHostPort,
    resolveMode,
    sha256Hex,
    verifyBundleFiles,
    type TpkgBundleFile,
} from "./TpkgProtocol";

/**
 * TPKG protocol (P1) — util murni yang dipakai klien (`tpkg`) DAN server (`tpkgd`).
 *
 * Yang dijaga di sini adalah KESEPAKATAN: kalau server dan klien menghitung
 * digest/hash/mode dengan cara berbeda, paket yang sehat bisa gagal verifikasi
 * atau (lebih buruk) file biner rusak tanpa error. Karena itu tiap rumus diuji
 * eksplisit di sini.
 */

/** file(): Buat entri bundle yang konsisten (size + sha dihitung benar). */
function file(path: string, content: string, extra: Partial<TpkgBundleFile> = {}): TpkgBundleFile {
    return { path, size: content.length, sha256: sha256Hex(content), content, ...extra };
}

describe("TpkgProtocol — util (P1)", () => {
    it("P1.01 parseHostPort menerima node, node:port, dan skema", () => {
        expect(parseHostPort("jati")).toEqual({ address: "jati", port: TPKG_DEFAULT_PORT });
        expect(parseHostPort("jati:8090")).toEqual({ address: "jati", port: 8090 });
        expect(parseHostPort("tpkg://jati:8090")).toEqual({ address: "jati", port: 8090 });
        expect(parseHostPort("jati:1")).toEqual({ address: "jati", port: 1 });
        expect(parseHostPort(" node : 8090 ")).toEqual({ address: "node", port: 8090 });
    });

    it("P1.02 parseHostPort menolak yang tidak masuk akal (dulu diam-diam salah kirim)", () => {
        expect(() => parseHostPort("")).toThrow(/kosong/i);
        expect(() => parseHostPort("jati:0")).toThrow(/port/i);
        expect(() => parseHostPort("jati:70000")).toThrow(/port/i);
        expect(() => parseHostPort("jati:abc")).toThrow(/port/i);
    });

    it("P1.03 compareVersions ala semver (panjang segmen bebas)", () => {
        expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
        expect(compareVersions("1.2", "1.2.0")).toBe(0);
        expect(compareVersions("1.2.1", "1.2.0")).toBe(1);
        expect(compareVersions("1.2.0", "1.10.0")).toBe(-1);
        expect(compareVersions("2.0.0-rc1", "2.0.0")).toBe(0);
        expect(compareVersions("1.7.4", "1.7.3")).toBe(1);
    });

    it("P1.04 sha256Hex memakai byte LATIN1, bukan utf8 (regresi korupsi biner)", () => {
        const content = "\u00ff\u00fe\u0080"; // 0xFF 0xFE 0x80 dalam string internal TSIX

        const viaLatin1 = crypto.createHash("sha256").update(Buffer.from(content, "latin1")).digest("hex");
        const viaUtf8 = crypto.createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");

        expect(sha256Hex(content)).toBe(viaLatin1);
        // Bukti bahwa pilihan encoding memang berpengaruh: utf8 akan memberi hasil lain
        // (dan itulah bug yang membuat file biner ≥ 0x80 rusak di implementasi lain).
        expect(sha256Hex(content)).not.toBe(viaUtf8);
    });

    it("P1.05 bundleMeta/bundleDigest memuat path+hostDst+size+sha (stabil)", () => {
        const files = [file("/bin/a", "aaa"), file("/etc/b.conf", "bbb")];
        const meta = bundleMeta(files);

        expect(meta).toEqual([
            { path: "/bin/a", hostDst: "", size: 3, sha256: files[0].sha256 },
            { path: "/etc/b.conf", hostDst: "", size: 3, sha256: files[1].sha256 },
        ]);
        // Deterministik: dua pemanggilan dengan data sama → string identik.
        expect(bundleDigest(files)).toBe(bundleDigest([...files]));
        // Digest TIDAK memuat konten (payload tanda tangan kecil).
        expect(bundleDigest(files)).not.toContain("aaa");
    });

    it("P1.05b hostDst ikut ditandatangani (anti belokkan file engine ke path lain)", () => {
        const plain = file("/tmp/tpkg-stage/kernel/Kernel.ts", "// kernel");
        const withHost = file("/tmp/tpkg-stage/kernel/Kernel.ts", "// kernel", {
            hostDst: "src/kernel/Kernel.ts",
        });

        expect(bundleDigest([withHost])).not.toBe(bundleDigest([plain]));
        expect(bundleDigest([withHost])).toContain("src/kernel/Kernel.ts");
    });

    it("P1.05c isSafeHostDst menolak path yang keluar dari root proyek", () => {
        expect(isSafeHostDst("src/kernel/Kernel.ts")).toBe(true);
        expect(isSafeHostDst("src/mirror/bin/ls.ts")).toBe(true);

        expect(isSafeHostDst("/etc/shadow")).toBe(false); // absolut
        expect(isSafeHostDst("~/x")).toBe(false);
        expect(isSafeHostDst("../../etc/shadow")).toBe(false);
        expect(isSafeHostDst("src/../../x")).toBe(false);
        expect(isSafeHostDst("src//kernel")).toBe(false); // segmen kosong
        expect(isSafeHostDst("src\\kernel")).toBe(false);
        expect(isSafeHostDst("")).toBe(false);
    });

    it("P1.06 verifyBundleFiles menerima bundle sehat (termasuk byte 0..255)", () => {
        const binary = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join("");
        const result = verifyBundleFiles([file("/opt/bin.dat", binary), file("/etc/x.conf", "konfigurasi")]);

        expect(result.ok).toBe(true);
        expect(result.error).toBeUndefined();
    });

    it("P1.07 verifyBundleFiles menangkap size palsu, hash palsu, dan bundle kosong", () => {
        const broken = file("/etc/a.conf", "asli");
        broken.size = 99; // ukuran bohong
        expect(verifyBundleFiles([broken])).toMatchObject({ ok: false });
        expect(verifyBundleFiles([broken]).error).toMatch(/ukuran/i);

        const tampered = file("/etc/a.conf", "asli");
        tampered.sha256 = sha256Hex("palsu");
        expect(verifyBundleFiles([tampered]).error).toMatch(/SHA-256/i);

        expect(verifyBundleFiles([]).error).toMatch(/kosong/i);
        expect(verifyBundleFiles([{ path: "", size: 0, sha256: "", content: "" }]).error).toMatch(/path/i);
    });

    it("P1.08 resolveMode: permissions menang, lalu SetUID/EXEC_DIRS (sama dgn vfs-bootstrap)", () => {
        expect(resolveMode(file("/opt/skrip.ts", "x", { isExecutable: true }))).toBe(TPKG_EXEC_MODE);
        expect(resolveMode(file("/bin/ls.ts", "x"))).toBe(TPKG_EXEC_MODE);
        expect(resolveMode(file("/usr/bin/x.ts", "x"))).toBe(TPKG_EXEC_MODE);
        expect(resolveMode(file("/opt/skrip.ts", "x", { permissions: 0o700 }))).toBe(0o700);
        // permissions menang walau isExecutable juga diset
        expect(resolveMode(file("/opt/skrip.ts", "x", { isExecutable: true, permissions: 0o600 }))).toBe(0o600);
        // file biasa → biarkan mode bawaan VFS
        expect(resolveMode(file("/etc/app.conf", "x"))).toBeUndefined();

        // `/sbin` = root-only (0o744), bukan 0o755 seperti /bin.
        expect(resolveMode(file("/sbin/apply-update.ts", "x"))).toBe(TPKG_SBIN_MODE);
        // SetUID wajib untuk login/passwd/sudo (baca /etc/shadow), dan menang atas
        // `isExecutable` — kalau tidak, sudo mendadak tidak bisa baca shadow.
        expect(resolveMode(file("/bin/sudo.ts", "x", { isExecutable: true }))).toBe(TPKG_SETUID_MODE);
        // File DATA di dalam direktori eksekusi tidak ikut jadi executable
        // (bootstrap lama men-chmod 0o755 semua isi /opt — kunci rahasia pun).
        expect(resolveMode(file("/opt/esp-ota/activation-keys.txt", "x"))).toBeUndefined();
    });

    it("P1.09 formatBytes untuk pesan CLI", () => {
        expect(formatBytes(512)).toBe("512 B");
        expect(formatBytes(2048)).toBe("2.0 KB");
        expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    });
});
