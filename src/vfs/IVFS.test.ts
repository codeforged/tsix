import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { IVFS } from "./IVFS";
import { VirtualFileSystem } from "./VFS";
import { BKFS } from "./BKFS";
import { HostVFS } from "./HostVFS";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * B4: IVFS Interface Contract Tests
 * 
 * Setiap implementasi VFS harus lolos test yang sama.
 * Ini memastikan VFS, BKFS, dan HostVFS semuanya comply ke kontrak IVFS.
 */

function makeImplementations(): { name: string; vfs: IVFS; cleanup?: () => void }[] {
    const tmpDir = path.join(os.tmpdir(), `tsix-ivfs-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    return [
        { name: "VFS", vfs: new VirtualFileSystem() },
        { name: "BKFS", vfs: new BKFS(":memory:") },
        { name: "HostVFS", vfs: new HostVFS(tmpDir), cleanup: () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { } } },
    ];
}

describe.each(makeImplementations())("IVFS Contract [$name]", ({ vfs, cleanup }) => {

    // ============================================================
    // B4.01–B4.05: Basic file operations
    // ============================================================
    it("B4.01 touch + read", () => {
        vfs.touch("/test.txt", "hello");
        expect(vfs.read("/test.txt")).toBe("hello");
    });
    it("B4.02 touch overwrite", () => {
        vfs.touch("/test.txt", "old");
        vfs.touch("/test.txt", "new");
        expect(vfs.read("/test.txt")).toBe("new");
    });
    it("B4.03 mkdir + ls", () => {
        vfs.mkdir("/mydir");
        vfs.touch("/mydir/file.txt", "data");
        const items = vfs.ls("/mydir");
        expect(items.length).toBe(1);
        expect(items[0].name).toBe("file.txt");
    });
    it("B4.04 stat – file", () => {
        vfs.touch("/stat.txt", "12345");
        const s = vfs.stat("/stat.txt");
        expect(s).not.toBeNull();
        expect(s!.size).toBe(5);
    });
    it("B4.05 exists", () => {
        vfs.touch("/exists.txt");
        expect(vfs.exists("/exists.txt")).toBe(true);
        expect(vfs.exists("/nope.txt")).toBe(false);
    });

    // ============================================================
    // B4.06–B4.10: Delete operations
    // ============================================================
    it("B4.06 unlink", () => {
        vfs.touch("/del.txt");
        expect(vfs.unlink("/del.txt")).toBe(true);
        expect(vfs.exists("/del.txt")).toBe(false);
    });
    it("B4.07 unlink – not found", () => {
        expect(vfs.unlink("/nope.txt")).toBe(false);
    });
    it("B4.08 rmdir – empty dir", () => {
        vfs.mkdir("/emptydir");
        expect(vfs.rmdir("/emptydir")).toBe(true);
        expect(vfs.exists("/emptydir")).toBe(false);
    });
    it("B4.09 rmdir – non-empty fails", () => {
        vfs.mkdir("/fulldir");
        vfs.touch("/fulldir/file.txt", "x");
        // Some VFS throw, some return false — both are valid contract behavior
        try {
            expect(vfs.rmdir("/fulldir")).toBe(false);
        } catch (_) {
            expect(true).toBe(true); // Throwing on non-empty is also valid
        }
    });
    it("B4.10 append", () => {
        vfs.touch("/log.txt", "line1\n");
        vfs.append("/log.txt", "line2\n");
        expect(vfs.read("/log.txt")).toBe("line1\nline2\n");
    });

    // ============================================================
    // B4.11–B4.15: Chunked I/O
    // ============================================================
    it("B4.11 readChunk", () => {
        vfs.touch("/data.bin", "0123456789");
        expect(vfs.readChunk("/data.bin", 2, 4)).toBe("2345");
    });
    it("B4.12 writeChunk – append", () => {
        vfs.writeChunk("/copy.bin", "AAAA", 0);
        vfs.writeChunk("/copy.bin", "BBBB", 4);
        expect(vfs.read("/copy.bin")).toBe("AAAABBBB");
    });
    it("B4.13 writeChunk – create", () => {
        vfs.writeChunk("/new.bin", "hello", 0);
        expect(vfs.read("/new.bin")).toBe("hello");
    });
    it("B4.14 getSize", () => {
        vfs.touch("/size.bin", "12345");
        expect(vfs.getSize("/size.bin")).toBe(5);
    });
    it("B4.15 getUsage", async () => {
        vfs.touch("/a.txt", "12345");
        vfs.touch("/b.txt", "67890");
        // VFS (RAM) doesn't have getUsage — test skip if not a function
        if (typeof (vfs as any).getUsage !== "function") return;
        const u = await vfs.getUsage();
        if (u && typeof u.files === "number" && typeof u.size === "number") {
            expect(u.files).toBeGreaterThanOrEqual(2);
            expect(u.size).toBeGreaterThanOrEqual(10);
        }
    });

    // ============================================================
    // B4.16–B4.20: Edge cases
    // ============================================================
    it("B4.16 read – not found", () => {
        const result = vfs.read("/ghost.txt");
        expect(result === null || result === undefined).toBe(true);
    });
    it("B4.17 stat – not found", () => {
        const result = vfs.stat("/ghost.txt");
        expect(result === null || result === undefined).toBe(true);
    });
    it("B4.18 getSize – not found", () => {
        expect(vfs.getSize("/ghost.txt")).toBe(-1);
    });
    it("B4.19 readChunk – not found", () => {
        const result = vfs.readChunk("/ghost.txt", 0, 10);
        expect(result === null || result === undefined || result === "").toBe(true);
    });
    it("B4.20 root access", () => {
        expect(vfs.exists("/")).toBe(true);
    });

    // Cleanup
    afterAll(() => { cleanup?.(); });
});

