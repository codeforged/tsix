import { describe, it, expect, beforeEach } from "vitest";
import { RamFS } from "../../vfs/RamFS";
import { NetFSServer } from "./NetFSServer";
import {
  NETFS_MAX_CHUNK_BYTES,
  NETFS_VERSION,
  decodeContent,
  encodeContent,
  formatNetFSSpec,
  netfsErrorCodeOf,
  parseNetFSSpec,
} from "./NetFSProtocol";

/**
 * NetFS Server (SL core) tests
 *
 * Yang diuji di sini adalah sisi SH (storage host): request dari jaringan
 * masuk → dijalankan ke filesystem lokal yang di-attach. Sengaja TANPA
 * jaringan (tidak ada NetSocket) supaya logika bisa diuji cepat & deterministik.
 */

const PREFIX = "/export";

function req(id: number, op: string, path?: string, args?: any[]): string {
  return JSON.stringify({ v: NETFS_VERSION, id, op, path, args });
}

describe("NetFSServer — SL core (N1)", () => {
  let backend: RamFS;
  let server: NetFSServer;

  beforeEach(() => {
    backend = new RamFS("netfs-test");
    backend.mkdir(PREFIX, 0, 0, 0o755);
    backend.mkdir(`${PREFIX}/docs`, 0, 0, 0o755);
    backend.touch(`${PREFIX}/docs/a.txt`, "halo netfs", 0, 0, 0o644);
    server = new NetFSServer(backend, { prefix: PREFIX, label: "shared" });
  });

  it("N1.01 info mengembalikan metadata export", async () => {
    const res = await server.handle(req(1, "info"));

    expect(res.ok).toBe(true);
    expect(res.id).toBe(1);
    expect(res.result.label).toBe("shared");
    expect(res.result.prefix).toBe(PREFIX);
    expect(res.result.readOnly).toBe(false);
    expect(res.result.ops).toContain("readChunk");
  });

  it("N1.02 ls dibaca relatif terhadap prefix export", async () => {
    const res = await server.handle(req(2, "ls", "/docs"));

    expect(res.ok).toBe(true);
    expect(res.result.map((e: any) => e.name)).toEqual(["a.txt"]);
    // Prefix TIDAK boleh bocor ke klien
    expect(JSON.stringify(res.result)).not.toContain(PREFIX);
  });

  it("N1.03 read mengembalikan konten yang bisa didekode", async () => {
    const res = await server.handle(req(3, "read", "/docs/a.txt"));

    expect(res.ok).toBe(true);
    expect(res.result.enc).toBe("base64");
    expect(decodeContent(res.result)).toBe("halo netfs");
  });

  it("N1.03b payload Buffer (framing biner Binfeo) tetap diproses", async () => {
    // Regresi: dulu Buffer dianggap "sudah diparse" → op jadi undefined →
    // jawaban EBADOP walau request-nya sebenarnya valid.
    const res = await server.handle(Buffer.from(req(31, "info"), "utf8"));

    expect(res.ok).toBe(true);
    expect(res.id).toBe(31);
    expect(res.result.label).toBe("shared");
  });

  it("N1.03c payload biner yang bukan JSON → EBADREQ (jelas, bukan hang)", async () => {
    const res = await server.handle(Buffer.from([0x00, 0xff, 0x01]));

    expect(res.ok).toBe(false);
    expect(res.code).toBe("EBADREQ");
  });

  it("N1.04 touch round-trip konten biner-safe (byte 0..255)", async () => {
    const binary = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join("");
    const docPath = "/docs/bytes.txt";

    const write = await server.handle(req(4, "touch", docPath, [binary, 0, 0, 420]));
    expect(write.ok).toBe(true);

    const read = await server.handle(req(5, "read", docPath));
    expect(decodeContent(read.result)).toBe(binary);
  });

  it("N1.05 path '..' tidak bisa keluar dari prefix", () => {
    expect(server.resolvePath("/../../etc/passwd")).toBe(`${PREFIX}/etc/passwd`);
    expect(server.resolvePath("/")).toBe(PREFIX);
    expect(server.resolvePath("/docs/../secrets")).toBe(`${PREFIX}/secrets`);
  });

  it("N1.06 export read-only menolak op tulis tapi tetap melayani baca", async () => {
    const roServer = new NetFSServer(backend, { prefix: PREFIX, readOnly: true });

    const write = await roServer.handle(
      req(6, "touch", "/docs/baru.txt", ["x", 0, 0, 420]),
    );
    expect(write.ok).toBe(false);
    expect(write.code).toBe("EROFS");

    const read = await roServer.handle(req(7, "read", "/docs/a.txt"));
    expect(read.ok).toBe(true);
  });

  it("N1.07 op tak dikenal ditolak EBADOP", async () => {
    const res = await server.handle(req(8, "format-c"));

    expect(res.ok).toBe(false);
    expect(res.code).toBe("EBADOP");
  });

  it("N1.08 payload bukan JSON ditolak EBADREQ dengan id 0", async () => {
    const res = await server.handle("bukan json");

    expect(res.ok).toBe(false);
    expect(res.code).toBe("EBADREQ");
    expect(res.id).toBe(0);
  });

  it("N1.09 readChunk di luar batas ukuran ditolak ETOOBIG", async () => {
    const res = await server.handle(
      req(9, "readChunk", "/docs/a.txt", [0, NETFS_MAX_CHUNK_BYTES + 1]),
    );

    expect(res.ok).toBe(false);
    expect(res.code).toBe("ETOOBIG");
  });

  it("N1.10 daftar allow menolak client lain", async () => {
    const limited = new NetFSServer(backend, { prefix: PREFIX, allow: ["tsix_2"] });

    const denied = await limited.handle(req(10, "ls", "/docs"), { src: "tsix_9" });
    expect(denied.ok).toBe(false);
    expect(denied.code).toBe("EACCES");

    const allowed = await limited.handle(req(11, "ls", "/docs"), { src: "tsix_2" });
    expect(allowed.ok).toBe(true);
  });

  it("N1.11 error backend diterjemahkan jadi kode, bukan melempar ke transport", async () => {
    const throwing = {
      ls: () => {
        throw new Error("Permission Denied: ls /rahasia");
      },
      mkdir: () => true,
      read: () => null,
      touch: () => true,
      stat: () => null,
      chmod: () => true,
      chown: () => true,
      unlink: () => true,
      rmdir: () => true,
      exists: () => false,
      append: () => true,
      getUsage: async () => ({ size: 0, files: 0, dirs: 0 }),
      readChunk: () => null,
      writeChunk: () => true,
      getSize: () => -1,
    } as any;

    const srv = new NetFSServer(throwing, { prefix: "/" });
    const res = await srv.handle(req(12, "ls", "/rahasia"));

    expect(res.ok).toBe(false);
    expect(res.code).toBe("EACCES");
    expect(res.err).toContain("Permission Denied");
  });

  it("N1.12 stats mencatat request sukses dan gagal", async () => {
    await server.handle(req(13, "ls", "/docs"));
    await server.handle(req(14, "op-ngawur"));

    expect(server.stats.served).toBe(1);
    expect(server.stats.failed).toBe(1);
  });
});

describe("NetFS protocol utils (N3)", () => {
  it("N3.01 parseNetFSSpec menerima berbagai bentuk penulisan", () => {
    expect(parseNetFSSpec("tsix_2:7777")).toEqual({ address: "tsix_2", port: 7777 });
    expect(parseNetFSSpec("tsix_2")).toEqual({ address: "tsix_2", port: 7777 });
    expect(parseNetFSSpec("tsix://tsix_2:8000")).toEqual({ address: "tsix_2", port: 8000 });
    expect(parseNetFSSpec("netfs://tsix_3:9000/docs")).toEqual({
      address: "tsix_3",
      port: 9000,
    });
  });

  it("N3.02 parseNetFSSpec menolak alamat/port invalid", () => {
    expect(() => parseNetFSSpec("")).toThrow();
    expect(() => parseNetFSSpec("tsix_2:99999")).toThrow();
    expect(() => parseNetFSSpec("tsix_2:abc")).toThrow();
  });

  it("N3.03 formatNetFSSpec jadi bentuk kanonik untuk lsblk", () => {
    expect(formatNetFSSpec("tsix_2", 7777)).toBe("tsix://tsix_2:7777");
  });

  it("N3.04 encodeContent/decodeContent round-trip & null-safe", () => {
    expect(decodeContent(encodeContent(null))).toBe(null);
    expect(decodeContent(encodeContent(""))).toBe("");
    expect(decodeContent(encodeContent("abc"))).toBe("abc");
    expect(decodeContent("teks polos")).toBe("teks polos");
    expect(decodeContent(encodeContent("\u0000\u00ff"))).toBe("\u0000\u00ff");
  });

  it("N3.05 netfsErrorCodeOf menerjemahkan error gaya TSIX", () => {
    expect(netfsErrorCodeOf(new Error("Permission Denied: x"))).toBe("EACCES");
    expect(netfsErrorCodeOf(new Error("Read-only filesystem"))).toBe("EROFS");
    expect(netfsErrorCodeOf(new Error("File not found: /x"))).toBe("ENOENT");
    expect(netfsErrorCodeOf(new Error("Directory not empty"))).toBe("ENOTEMPTY");
    expect(netfsErrorCodeOf(new Error("aneh"))).toBe("EIO");
  });
});
