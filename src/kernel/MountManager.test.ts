import { describe, it, expect, beforeEach } from "vitest";
import { MountManager } from "./MountManager";
import { VirtualFileSystem } from "../vfs/VFS";
import { IVFS } from "../vfs/IVFS";

// Mock IVFS implementation
class MockVFS implements IVFS {
    public storage: Map<string, string> = new Map();
    public readOnly: boolean = false;

    ls(path: string): any[] { return []; }
    mkdir(path: string): boolean { return true; }
    read(path: string): string | null { return this.storage.get(path) ?? null; }
    touch(path: string, content = ""): boolean {
        if (this.readOnly) return false;
        this.storage.set(path, content);
        return true;
    }
    stat(path: string): any { return { name: path, size: 0 }; }
    chmod(path: string, mode: number): boolean { return true; }
    chown(path: string, uid: number, gid: number): boolean { return true; }
    unlink(path: string): boolean {
        if (this.readOnly) return false;
        return this.storage.delete(path);
    }
    rmdir(path: string): boolean { return true; }
    exists(path: string): boolean { return this.storage.has(path); }
    async getUsage() { return { size: 0, files: 0, dirs: 0 }; }
    append(path: string, content: string): boolean {
        if (this.readOnly) return false;
        const current = this.read(path) ?? "";
        this.storage.set(path, current + content);
        return true;
    }
    readChunk(path: string, offset: number, length: number): string | null {
        const content = this.read(path);
        if (!content) return null;
        return content.substring(offset, offset + length);
    }
    writeChunk(path: string, chunk: string, offset: number): boolean {
        if (this.readOnly) return false;
        const current = this.read(path) ?? "";
        const updated = current.substring(0, offset) + chunk + current.substring(offset + chunk.length);
        this.storage.set(path, updated);
        return true;
    }
    getSize(path: string): number { return this.read(path)?.length ?? -1; }
}

describe("MountManager", () => {
    let mountManager: MountManager;
    let rootVFS: MockVFS;
    let mntVFS: MockVFS;
    let dataVFS: MockVFS;

    beforeEach(() => {
        mountManager = new MountManager();
        rootVFS = new MockVFS();
        mntVFS = new MockVFS();
        dataVFS = new MockVFS();

        // Register a root filesystem
        mountManager.mount("/", rootVFS as any, "ram", "root");
    });

    // ============================================================
    // A4.01–A4.05: Mounting
    // ============================================================
    it("A4.01 Mount VFS at valid path", () => {
        mountManager.mount("/mnt/vfs", mntVFS as any, "ram", "mnt");
        const resolved = mountManager.resolve("/mnt/vfs/file.txt");
        expect(resolved.vfs).toBe(mntVFS);
        expect(resolved.relativePath).toBe("/file.txt");
        expect(resolved.mountPoint).toBe("/mnt/vfs");
    });

    it("A4.02 Mount VFS – path doesn't exist (registers and resolves path)", () => {
        // MountManager parses and normalizes the mount point path without throwing
        mountManager.mount("/nonexistent/dir", mntVFS as any);
        const resolved = mountManager.resolve("/nonexistent/dir/file.txt");
        expect(resolved.vfs).toBe(mntVFS);
        expect(resolved.relativePath).toBe("/file.txt");
    });

    it("A4.03 Mount VFS – path is file (registers mount point lexically)", () => {
        // MountManager treats paths lexically
        mountManager.mount("/file.txt", mntVFS as any);
        const resolved = mountManager.resolve("/file.txt/nested");
        expect(resolved.vfs).toBe(mntVFS);
        expect(resolved.relativePath).toBe("/nested");
    });

    it("A4.04 Mount VFS – already mounted (overmount)", () => {
        mountManager.mount("/mnt", mntVFS as any);
        // Replace with dataVFS
        mountManager.mount("/mnt", dataVFS as any);
        const resolved = mountManager.resolve("/mnt/file.txt");
        expect(resolved.vfs).toBe(dataVFS);
    });

    it("A4.05 Mount VFS – nested mount points", () => {
        mountManager.mount("/mnt", mntVFS as any);
        mountManager.mount("/mnt/data", dataVFS as any);

        const res1 = mountManager.resolve("/mnt/file.txt");
        const res2 = mountManager.resolve("/mnt/data/file.txt");

        expect(res1.vfs).toBe(mntVFS);
        expect(res2.vfs).toBe(dataVFS);
    });

    // ============================================================
    // A4.06–A4.08: Unmounting
    // ============================================================
    it("A4.06 Unmount VFS", () => {
        mountManager.mount("/mnt", mntVFS as any);
        expect(mountManager.unmount("/mnt")).toBe(true);
        // Should fall back to root VFS now
        const resolved = mountManager.resolve("/mnt/file.txt");
        expect(resolved.vfs).toBe(rootVFS);
    });

    it("A4.07 Unmount VFS – path not mounted", () => {
        expect(mountManager.unmount("/notmounted")).toBe(false);
    });

    it("A4.08 Unmount VFS – mount point not active/removed", () => {
        mountManager.mount("/mnt", mntVFS as any);
        expect(mountManager.unmount("/mnt")).toBe(true);
        expect(mountManager.unmount("/mnt")).toBe(false);
    });

    // ============================================================
    // A4.09–A4.16: Path Resolution
    // ============================================================
    it("A4.09 Resolve path – root '/'", () => {
        const resolved = mountManager.resolve("/");
        expect(resolved.vfs).toBe(rootVFS);
        expect(resolved.relativePath).toBe("/");
    });

    it("A4.10 Resolve path – simple path '/home/file'", () => {
        const resolved = mountManager.resolve("/home/file");
        expect(resolved.vfs).toBe(rootVFS);
        expect(resolved.relativePath).toBe("/home/file");
    });

    it("A4.11 Resolve path – mounted path '/mnt/data/file'", () => {
        mountManager.mount("/mnt/data", dataVFS as any);
        const resolved = mountManager.resolve("/mnt/data/file");
        expect(resolved.vfs).toBe(dataVFS);
        expect(resolved.relativePath).toBe("/file");
    });

    it("A4.12 Resolve path – nested mount '/mnt/a/b/file'", () => {
        mountManager.mount("/mnt/a/b", dataVFS as any);
        const resolved = mountManager.resolve("/mnt/a/b/file");
        expect(resolved.vfs).toBe(dataVFS);
        expect(resolved.relativePath).toBe("/file");
    });

    it("A4.13 Resolve path – no matching mount (fallback to root VFS)", () => {
        const resolved = mountManager.resolve("/etc/config");
        expect(resolved.vfs).toBe(rootVFS);
    });

    it("A4.14 Resolve path – longest prefix match wins", () => {
        mountManager.mount("/mnt", mntVFS as any);
        mountManager.mount("/mnt/data", dataVFS as any);

        const resolved = mountManager.resolve("/mnt/data/sub/file");
        expect(resolved.vfs).toBe(dataVFS);
        expect(resolved.relativePath).toBe("/sub/file");
    });

    it("A4.15 Resolve path – trailing slash normalization", () => {
        mountManager.mount("/mnt/", mntVFS as any);
        const resolved = mountManager.resolve("/mnt/file/");
        expect(resolved.mountPoint).toBe("/mnt");
        expect(resolved.relativePath).toBe("/file");
    });

    it("A4.16 Resolve path – relative path resolution (handled by PathResolver)", () => {
        mountManager.mount("/mnt", mntVFS as any);
        const resolved = mountManager.resolve("/mnt/../mnt/file");
        expect(resolved.vfs).toBe(mntVFS);
        expect(resolved.relativePath).toBe("/file");
    });

    // ============================================================
    // A4.17–A4.19: Cross-VFS Operations
    // ============================================================
    it("A4.17 Cross-VFS file op – read from one, write to another", () => {
        mountManager.mount("/mnt", mntVFS as any);
        rootVFS.touch("/file.txt", "data");
        
        const srcRes = mountManager.resolve("/file.txt");
        const destRes = mountManager.resolve("/mnt/file_copy.txt");

        const data = srcRes.vfs.read(srcRes.relativePath);
        expect(data).toBe("data");
        destRes.vfs.touch(destRes.relativePath, data!);
        expect(destRes.vfs.read(destRes.relativePath)).toBe("data");
    });

    it("A4.18 Cross-VFS file op – stat across mounts", () => {
        mountManager.mount("/mnt", mntVFS as any);
        const resRoot = mountManager.resolve("/file.txt");
        const resMnt = mountManager.resolve("/mnt/file.txt");

        expect(resRoot.vfs.stat(resRoot.relativePath)).toBeDefined();
        expect(resMnt.vfs.stat(resMnt.relativePath)).toBeDefined();
    });

    it("A4.19 Cross-VFS file op – chunked I/O across mounts", () => {
        mountManager.mount("/mnt", mntVFS as any);
        rootVFS.touch("/source.bin", "hello world");
        
        const src = mountManager.resolve("/source.bin");
        const dest = mountManager.resolve("/mnt/dest.bin");

        const chunk = src.vfs.readChunk(src.relativePath, 6, 5);
        expect(chunk).toBe("world");
        dest.vfs.writeChunk(dest.relativePath, chunk!, 0);
        expect(dest.vfs.read(dest.relativePath)).toBe("world");
    });

    // ============================================================
    // A4.20–A4.25: Mount options and list
    // ============================================================
    it("A4.20 Mount depth limit (nested paths work without crash)", () => {
        mountManager.mount("/a/b/c/d/e/f", mntVFS as any);
        const resolved = mountManager.resolve("/a/b/c/d/e/f/file");
        expect(resolved.vfs).toBe(mntVFS);
    });

    it("A4.21 List all mount points", () => {
        mountManager.mount("/mnt", mntVFS as any, "ram", "memory", true);
        const list = mountManager.listMounts();
        expect(list.length).toBe(2); // root + /mnt
        const mntEntry = list.find(m => m.vfsPath === "/mnt");
        expect(mntEntry).toBeDefined();
        expect(mntEntry!.type).toBe("ram");
        expect(mntEntry!.source).toBe("memory");
        expect(mntEntry!.readOnly).toBe(true);
    });

    it("A4.22 Mount persistence simulation", () => {
        expect(mountManager.listMounts().length).toBe(1);
    });

    it("A4.23 Mount umount – fallback to parent VFS", () => {
        mountManager.mount("/mnt", mntVFS as any);
        mountManager.mount("/mnt/data", dataVFS as any);

        expect(mountManager.unmount("/mnt/data")).toBe(true);
        const resolved = mountManager.resolve("/mnt/data/file");
        expect(resolved.vfs).toBe(mntVFS); // falls back to /mnt VFS
    });

    it("A4.24 Read-only mount option matches config", () => {
        mountManager.mount("/ro-mnt", mntVFS as any, "ram", "db", true);
        const list = mountManager.listMounts();
        const entry = list.find(m => m.vfsPath === "/ro-mnt");
        expect(entry!.readOnly).toBe(true);
    });

    it("A4.25 Multiple VFS backends simultaneously mounted", () => {
        mountManager.mount("/mnt/ram", rootVFS as any);
        mountManager.mount("/mnt/db", dataVFS as any);

        expect(mountManager.resolve("/mnt/ram/f").vfs).toBe(rootVFS);
        expect(mountManager.resolve("/mnt/db/f").vfs).toBe(dataVFS);
    });
});
