import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HostVFS } from "./HostVFS";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("HostVFS", () => {
    let tmpDir: string;
    let vfs: HostVFS;

    beforeEach(() => {
        tmpDir = path.join(os.tmpdir(), `tsix-hostvfs-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        vfs = new HostVFS(tmpDir);
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { }
    });

    // ============================================================
    // B3.01–B3.05: touch + read
    // ============================================================
    it("B3.01 touch – create host file", () => {
        expect(vfs.touch("/test.txt")).toBe(true);
        const hostPath = path.join(tmpDir, "test.txt");
        expect(fs.existsSync(hostPath)).toBe(true);
    });
    it("B3.02 touch – create file with content", () => {
        vfs.touch("/data.txt", "hello world");
        expect(vfs.read("/data.txt")).toBe("hello world");
    });
    it("B3.03 touch – overwrite existing", () => {
        vfs.touch("/test.txt", "old");
        vfs.touch("/test.txt", "new");
        expect(vfs.read("/test.txt")).toBe("new");
    });
    it("B3.04 read – file not found returns null", () => {
        expect(vfs.read("/nope.txt")).toBeNull();
    });
    it("B3.05 read – directory returns null", () => {
        vfs.mkdir("/mydir");
        expect(vfs.read("/mydir")).toBeNull();
    });

    // ============================================================
    // B3.06–B3.10: mkdir + ls + stat
    // ============================================================
    it("B3.06 mkdir – creates directory on host", () => {
        expect(vfs.mkdir("/subdir")).toBe(true);
        expect(fs.statSync(path.join(tmpDir, "subdir")).isDirectory()).toBe(true);
    });
    it("B3.07 mkdir – recursive nested path", () => {
        expect(vfs.mkdir("/a/b/c")).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, "a/b/c"))).toBe(true);
    });
    it("B3.08 ls – directory listing", () => {
        vfs.touch("/a.txt");
        vfs.touch("/b.txt");
        const items = vfs.ls("/");
        const names = items.map((i: any) => i.name).sort();
        expect(names).toContain("a.txt");
        expect(names).toContain("b.txt");
    });
    it("B3.09 stat – file metadata", () => {
        vfs.touch("/meta.txt", "12345");
        const s = vfs.stat("/meta.txt");
        expect(s).not.toBeNull();
        expect(s!.type).toBe("FILE");
        expect(s!.size).toBe(5);
    });
    it("B3.10 stat – directory metadata", () => {
        vfs.mkdir("/mydir");
        const s = vfs.stat("/mydir");
        expect(s).not.toBeNull();
        expect(s!.type).toBe("DIRECTORY");
    });

    // ============================================================
    // B3.11–B3.15: append + chmod + chown
    // ============================================================
    it("B3.11 append – append to existing file", () => {
        vfs.touch("/log.txt", "line1\n");
        vfs.append("/log.txt", "line2\n");
        expect(vfs.read("/log.txt")).toBe("line1\nline2\n");
    });
    it("B3.12 append – creates if not exists", () => {
        vfs.append("/newlog.txt", "fresh data");
        expect(vfs.read("/newlog.txt")).toBe("fresh data");
    });
    it("B3.13 unlink – delete file", () => {
        vfs.touch("/delme.txt");
        expect(vfs.unlink("/delme.txt")).toBe(true);
        expect(vfs.exists("/delme.txt")).toBe(false);
    });
    it("B3.14 unlink – not found returns false", () => {
        expect(vfs.unlink("/nope.txt")).toBe(false);
    });
    it("B3.15 rmdir – remove empty directory", () => {
        vfs.mkdir("/emptydir");
        expect(vfs.rmdir("/emptydir")).toBe(true);
    });

    // ============================================================
    // B3.16–B3.20: Chunked I/O
    // ============================================================
    it("B3.16 readChunk – read partial file with offset/length", () => {
        vfs.touch("/data.bin", "0123456789");
        expect(vfs.readChunk("/data.bin", 2, 4)).toBe("2345");
    });
    it("B3.17 writeChunk – sequential append", () => {
        vfs.writeChunk("/copy.bin", "AAAA", 0);
        vfs.writeChunk("/copy.bin", "BBBB", 4);
        expect(vfs.read("/copy.bin")).toBe("AAAABBBB");
    });
    it("B3.18 writeChunk – create file if not exists", () => {
        vfs.writeChunk("/new.bin", "hello", 0);
        expect(vfs.read("/new.bin")).toBe("hello");
    });
    it("B3.19 writeChunk – random write in middle", () => {
        vfs.touch("/mid.bin", "0123456789");
        vfs.writeChunk("/mid.bin", "XX", 3);
        expect(vfs.read("/mid.bin")).toBe("012XX56789");
    });
    it("B3.20 getSize – returns correct file size", () => {
        vfs.touch("/size.bin", "12345");
        expect(vfs.getSize("/size.bin")).toBe(5);
    });

    // ============================================================
    // B3.21–B3.25: Path security + edge cases
    // ============================================================
    it("B3.21 path traversal blocked (../)", () => {
        expect(() => vfs.touch("../escape.txt")).toThrow();
    });
    it("B3.22 getSize – not found returns -1", () => {
        expect(vfs.getSize("/nope.bin")).toBe(-1);
    });
    it("B3.23 readChunk – offset beyond content returns null", () => {
        vfs.touch("/data.bin", "abc");
        expect(vfs.readChunk("/data.bin", 100, 10)).toBeNull();
    });
    it("B3.24 exists – file exists check", () => {
        vfs.touch("/exists.txt");
        expect(vfs.exists("/exists.txt")).toBe(true);
        expect(vfs.exists("/nope.txt")).toBe(false);
    });
    it("B3.25 getUsage – reports file count and size", async () => {
        vfs.touch("/a.txt", "12345");
        vfs.touch("/b.txt", "67890");
        const u = await vfs.getUsage();
        expect(u.files).toBeGreaterThanOrEqual(2);
        expect(u.size).toBeGreaterThanOrEqual(10);
    });
});
