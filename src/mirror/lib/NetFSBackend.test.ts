import { describe, it, expect, beforeEach } from "vitest";
import { NetFSBackend, UserlandFsLike } from "./NetFSBackend";

/**
 * NetFSBackend tests (N5)
 *
 * Adapter userland `IVFS → lib.fs`. Diuji dengan `lib.fs` palsu (Map in-memory)
 * supaya kontraknya jelas: apa yang diteruskan, apa yang sengaja diabaikan
 * (uid/gid), dan bagaimana error diterjemahkan.
 */

interface FakeNode {
  type: "FILE" | "DIRECTORY";
  content: string;
  mode: number;
}

class FakeFs implements UserlandFsLike {
  public files: Map<string, FakeNode> = new Map();
  public chmodCalls: Array<{ path: string; mode: number }> = [];
  public failWrite = false;
  public written: string | null = null;

  private node(path: string): FakeNode | undefined {
    return this.files.get(path);
  }

  async mkdir(path: string): Promise<any> {
    this.files.set(path, { type: "DIRECTORY", content: "", mode: 0o755 });
    return true;
  }

  async ls(path = "/"): Promise<any> {
    const prefix = path.endsWith("/") ? path : path + "/";
    const out: any[] = [];
    for (const [p, n] of this.files) {
      if (p.startsWith(prefix) && !p.slice(prefix.length).includes("/")) {
        out.push({ name: p.slice(prefix.length), type: n.type, size: n.content.length });
      }
    }
    return out;
  }

  async stat(path: string): Promise<any> {
    const n = this.node(path);
    if (!n) throw new Error(`stat: not found: ${path}`);
    return { name: path, type: n.type, size: n.content.length, mode: n.mode };
  }

  async chmod(path: string, mode: number): Promise<any> {
    this.chmodCalls.push({ path, mode });
    const n = this.node(path);
    if (n) n.mode = mode;
    return true;
  }

  async chown(): Promise<any> {
    return true;
  }

  async unlink(path: string): Promise<boolean> {
    return this.files.delete(path);
  }

  async rmdir(path: string): Promise<boolean> {
    return this.files.delete(path);
  }

  async readFile(path: string): Promise<string | null> {
    return this.node(path)?.content ?? null;
  }

  async writeFile(path: string, content: string): Promise<boolean> {
    this.written = content;
    if (this.failWrite) return false;
    this.files.set(path, {
      type: "FILE",
      content,
      mode: this.node(path)?.mode ?? 0o644,
    });
    return true;
  }

  async readChunk(path: string, offset: number, length: number): Promise<string | null> {
    const c = this.node(path)?.content ?? null;
    if (c === null) return null;
    return c.substring(offset, offset + length);
  }

  async writeChunk(): Promise<boolean> {
    return true;
  }

  async getSize(path: string): Promise<number> {
    return this.node(path)?.content.length ?? -1;
  }

  async getUsage(path = "/"): Promise<{ size: number; files: number; dirs: number }> {
    let size = 0;
    let files = 0;
    let dirs = 0;
    for (const [p, n] of this.files) {
      if (!p.startsWith(path)) continue;
      if (n.type === "DIRECTORY") dirs++;
      else {
        files++;
        size += n.content.length;
      }
    }
    return { size, files, dirs };
  }
}

describe("NetFSBackend (N5)", () => {
  let fake: FakeFs;
  let backend: NetFSBackend;

  beforeEach(() => {
    fake = new FakeFs();
    backend = new NetFSBackend(fake, { root: "/mnt/shared" });
  });

  it("N5.01 ls mengembalikan daftar, dan [] untuk direktori yang tidak ada", async () => {
    await fake.writeFile("/mnt/shared/a.txt", "isi");

    const items = await backend.ls("/mnt/shared");
    expect(items.map((i: any) => i.name)).toEqual(["a.txt"]);

    expect(await backend.ls("/mnt/tidak-ada")).toEqual([]);
  });

  it("N5.02 stat → null (bukan throw) kalau tidak ada, exists mengikuti tipe", async () => {
    await fake.mkdir("/mnt/shared/docs");

    expect(await backend.stat("/mnt/hantu")).toBe(null);
    expect(await backend.exists("/mnt/shared/docs")).toBe(true);
    expect(await backend.exists("/mnt/shared/docs", "DIRECTORY")).toBe(true);
    expect(await backend.exists("/mnt/shared/docs", "FILE")).toBe(false);
    expect(await backend.exists("/mnt/hantu")).toBe(false);
  });

  it("N5.03 mkdir menerapkan mode klien lewat chmod (mode tidak dibuang)", async () => {
    await backend.mkdir("/mnt/shared/private", 1000, 1000, 0o700);

    expect(fake.chmodCalls).toEqual([{ path: "/mnt/shared/private", mode: 0o700 }]);
    expect((await backend.stat("/mnt/shared/private")).mode).toBe(0o700);
  });

  it("N5.04 touch menulis konten + mode, dan gagal → NetFSError EACCES", async () => {
    await backend.touch("/mnt/shared/f.txt", "halo", 0, 0, 0o600);

    expect(await backend.read("/mnt/shared/f.txt")).toBe("halo");
    expect((await backend.stat("/mnt/shared/f.txt")).mode).toBe(0o600);

    fake.failWrite = true;
    await expect(backend.touch("/mnt/shared/g.txt", "x")).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  it("N5.05 append: file ada → digabung, file belum ada → dibuat", async () => {
    await fake.writeFile("/mnt/shared/log.txt", "baris1");

    await backend.append("/mnt/shared/log.txt", "\nbaris2");
    expect(await backend.read("/mnt/shared/log.txt")).toBe("baris1\nbaris2");

    await backend.append("/mnt/shared/baru.txt", "awal");
    expect(await backend.read("/mnt/shared/baru.txt")).toBe("awal");
  });

  it("N5.06 getUsage memakai root export, bukan seluruh VFS", async () => {
    await fake.writeFile("/mnt/shared/a.txt", "12345");
    await fake.writeFile("/lain/b.txt", "xxxxxxxxxx");

    const usage = await backend.getUsage();

    expect(usage.files).toBe(1);
    expect(usage.size).toBe(5);
  });

  it("N5.07 chunk I/O diteruskan apa adanya", async () => {
    await fake.writeFile("/mnt/shared/chunk.bin", "0123456789");

    expect(await backend.readChunk("/mnt/shared/chunk.bin", 2, 4)).toBe("2345");
    expect(await backend.getSize("/mnt/shared/chunk.bin")).toBe(10);
    expect(await backend.writeChunk("/mnt/shared/chunk.bin", "xx", 0)).toBe(true);
  });

  it("N5.08 uid/gid diabaikan (hak akses ikut identitas netfsd, ala root-squash)", async () => {
    // chown tetap diteruskan ke syscall CHOWN — SATPAM di SH yang memutuskan.
    await expect(backend.chown("/mnt/shared/a.txt", 1234, 5678)).resolves.toBe(true);
  });
});
