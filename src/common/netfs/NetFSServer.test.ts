import { describe, it, expect, beforeEach } from "vitest";
import { RamFS } from "../../vfs/RamFS";
import { NetFSServer } from "./NetFSServer";
import {
    NETFS_MAX_CHUNK_BYTES,
    NETFS_MAX_REQUEST_BYTES,
    NETFS_MAX_RESPONSE_BYTES,
    NETFS_VERSION,
    blob,
    blobData,
    encodeNetFSRequest,
    formatNetFSSpec,
    netfsErrorCodeOf,
    parseNetFSSpec,
} from "./NetFSProtocol";

/**
 * NetFS Server (SL core) tests
 *
 * Yang diuji di sini adalah sisi SH (storage host): frame biner dari jaringan
 * masuk → dijalankan ke filesystem lokal yang di-attach. Sengaja TANPA jaringan
 * (tidak ada NetSocket) supaya logika bisa diuji cepat & deterministik.
 */

const PREFIX = "/export";

/** req(): Frame request biner siap kirim (persis yang dikirim driver klien). */
function req(id: number, op: string, path?: string, args?: any[]): Buffer {
    return encodeNetFSRequest({ v: NETFS_VERSION, id, op: op as any, path, args });
}

/** bogusOp(): Frame valid dengan kode op karangan (untuk uji jalur EBADOP). */
function bogusOp(id: number, path = "/"): Buffer {
    const frame = req(id, "ls", path);
    frame[3] = 0x7f;
    return frame;
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
        expect(blobData(res.result)).toBe("halo netfs");
    });

    it("N1.03b payload Buffer (transport Binfeo) diproses apa adanya", async () => {
        // Regresi: dulu payload biner dianggap "sudah diparse" → op jadi
        // undefined → request dibuang / EBADOP walau sebenarnya valid.
        const res = await server.handle(req(31, "info"));

        expect(res.ok).toBe(true);
        expect(res.id).toBe(31);
        expect(res.result.label).toBe("shared");
    });

    it("N1.03c payload bukan frame NetFS v2 → EBADREQ (jelas, bukan hang)", async () => {
        const res = await server.handle(Buffer.from([0x00, 0xff, 0x01]));

        expect(res.ok).toBe(false);
        expect(res.code).toBe("EBADREQ");
    });

    it("N1.04 touch round-trip konten biner-safe (byte 0..255)", async () => {
        const binary = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join("");
        const docPath = "/docs/bytes.txt";

        const write = await server.handle(req(4, "touch", docPath, [blob(binary), 0, 0, 420]));
        expect(write.ok).toBe(true);

        const read = await server.handle(req(5, "read", docPath));
        expect(blobData(read.result)).toBe(binary);
    });

    it("N1.05 path '..' tidak bisa keluar dari prefix", () => {
        expect(server.resolvePath("/../../etc/passwd")).toBe(`${PREFIX}/etc/passwd`);
        expect(server.resolvePath("/")).toBe(PREFIX);
        expect(server.resolvePath("/docs/../secrets")).toBe(`${PREFIX}/secrets`);
    });

    it("N1.06 export read-only menolak op tulis tapi tetap melayani baca", async () => {
        const roServer = new NetFSServer(backend, { prefix: PREFIX, readOnly: true });

        const write = await roServer.handle(req(6, "touch", "/docs/baru.txt", [blob("x"), 0, 0, 420]));
        expect(write.ok).toBe(false);
        expect(write.code).toBe("EROFS");

        const read = await roServer.handle(req(7, "read", "/docs/a.txt"));
        expect(read.ok).toBe(true);
    });

    it("N1.07 kode op tak dikenal ditolak EBADOP", async () => {
        const res = await server.handle(bogusOp(8, "/docs"));

        expect(res.ok).toBe(false);
        expect(res.code).toBe("EBADOP");
    });

    it("N1.08 payload bukan frame v2 ditolak EBADREQ dengan id 0 + petunjuk wire", async () => {
        // Peer versi lama mengirim JSON v1 → pesannya harus menyebut Binfeo,
        // supaya salah-versi tidak terlihat seperti "mount hang".
        const json = await server.handle('{"v":1,"id":4,"op":"ls"}');
        expect(json.ok).toBe(false);
        expect(json.code).toBe("EBADREQ");
        expect(json.id).toBe(0);
        expect(json.err).toMatch(/BINER|Binfeo/i);

        const junk = await server.handle(Buffer.from([0x01, 0x02, 0x03]));
        expect(junk.code).toBe("EBADREQ");
        expect(junk.id).toBe(0);
    });

    it("N1.09 readChunk di luar batas ukuran ditolak ETOOBIG", async () => {
        const res = await server.handle(req(9, "readChunk", "/docs/a.txt", [0, NETFS_MAX_CHUNK_BYTES + 1]));

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
        await server.handle(bogusOp(14));

        expect(server.stats.served).toBe(1);
        expect(server.stats.failed).toBe(1);
    });

    it("N1.13 frame di atas pagar 256 KiB ditolak ETOOBIG, chunk 124 KiB diterima", async () => {
        // Konten besar yang dikirim inline dalam SATU frame (pola lama `cp`)
        // harus ditolak dengan kode jelas — bukan diam-diam atau menggantung.
        const huge = "Z".repeat(NETFS_MAX_REQUEST_BYTES);
        const rejected = await server.handle(req(15, "append", "/docs/huge.bin", [blob(huge)]));
        expect(rejected.ok).toBe(false);
        expect(rejected.code).toBe("ETOOBIG");
        expect(rejected.id).toBe(15); // id tetap dikutip walau ditolak

        // Jalur yang benar: potongan tepat di batas 124 KiB diterima utuh.
        const chunk = "Y".repeat(NETFS_MAX_CHUNK_BYTES);
        const first = await server.handle(req(16, "writeChunk", "/docs/chunked.bin", [blob(chunk), 0]));
        expect(first.ok).toBe(true);

        const second = await server.handle(
            req(17, "writeChunk", "/docs/chunked.bin", [blob(chunk), NETFS_MAX_CHUNK_BYTES]),
        );
        expect(second.ok).toBe(true);

        const size = await server.handle(req(18, "getSize", "/docs/chunked.bin"));
        expect(size.result).toBe(NETFS_MAX_CHUNK_BYTES * 2);
    });

    it("N1.14 read konten besar ditolak ETOOBIG (pagar balasan), readChunk tetap jalan", async () => {
        // Kejadian nyata: klien `cp` file 70 MB dari export bkfs → SL mencoba
        // mengirim seluruh isi dalam SATU balasan → node SH OOM, dan klien
        // timeout 5 s lebih dulu. Pagar ini menolaknya SEBELUM konten dibaca.
        const big = "B".repeat(NETFS_MAX_RESPONSE_BYTES + 1);
        await server.handle(req(19, "writeChunk", "/docs/big.bin", [blob(big.slice(0, NETFS_MAX_CHUNK_BYTES)), 0]));
        backend.touch(`${PREFIX}/docs/big.bin`, big, 0, 0, 0o644);

        const rejected = await server.handle(req(20, "read", "/docs/big.bin"));
        expect(rejected.ok).toBe(false);
        expect(rejected.code).toBe("ETOOBIG");
        expect(rejected.err).toContain("readChunk"); // pesannya menuntun ke solusi

        // Jalur pengganti: potongan tetap dilayani (ini yang dipakai klien).
        const piece = await server.handle(req(21, "readChunk", "/docs/big.bin", [0, NETFS_MAX_CHUNK_BYTES]));
        expect(piece.ok).toBe(true);
        expect(blobData(piece.result)!.length).toBe(NETFS_MAX_CHUNK_BYTES);

        // File kecil tetap 1 balasan (jalur cepat tidak dikorbankan).
        const small = await server.handle(req(22, "read", "/docs/a.txt"));
        expect(small.ok).toBe(true);
        expect(blobData(small.result)).toBe("halo netfs");
    });

    it("N1.15 baris korup (size>0 tapi isi kosong) dilaporkan EIO, bukan dikirim sebagai ''", async () => {
        // Kejadian nyata: metadata bilang 70 MB tapi isi baris kosong; dulu SL
        // mengirim "" dan klien menuliskannya sebagai file 0 byte yang dilaporkan
        // SUKSES. Sekarang harus gagal jelas.
        const corrupt = {
            ls: () => [],
            mkdir: () => true,
            read: () => "", // isi kosong
            touch: () => true,
            stat: () => ({ name: "x", type: "FILE", size: 100 }),
            chmod: () => true,
            chown: () => true,
            unlink: () => true,
            rmdir: () => true,
            exists: () => true,
            append: () => true,
            getUsage: async () => ({ size: 100, files: 1, dirs: 0 }),
            readChunk: () => "",
            writeChunk: () => true,
            getSize: () => 100, // klaim 100 byte
        } as any;

        const srv = new NetFSServer(corrupt, { prefix: "/" });
        const res = await srv.handle(req(23, "read", "/rusak.bin"));

        expect(res.ok).toBe(false);
        expect(res.code).toBe("EIO");
        expect(res.err).toContain("korup");
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

    it("N3.04 blob/blobData round-trip & null-safe (konten biner-safe)", () => {
        expect(blobData(blob(null))).toBe(null);
        expect(blobData(blob(""))).toBe("");
        expect(blobData(blob("abc"))).toBe("abc");
        expect(blobData("teks polos")).toBe("teks polos");
        expect(blobData(blob("\u0000\u00ff"))).toBe("\u0000\u00ff");
    });

    it("N3.05 netfsErrorCodeOf menerjemahkan error gaya TSIX", () => {
        expect(netfsErrorCodeOf(new Error("Permission Denied: x"))).toBe("EACCES");
        expect(netfsErrorCodeOf(new Error("Read-only filesystem"))).toBe("EROFS");
        expect(netfsErrorCodeOf(new Error("File not found: /x"))).toBe("ENOENT");
        expect(netfsErrorCodeOf(new Error("Directory not empty"))).toBe("ENOTEMPTY");
        expect(netfsErrorCodeOf(new Error("aneh"))).toBe("EIO");
    });
});
