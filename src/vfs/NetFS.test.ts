import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RamFS } from "./RamFS";
import { NetFS, INetFSChannel } from "./NetFS";
import { NetFSServer } from "../common/netfs/NetFSServer";
import {
    NETFS_MAX_CHUNK_BYTES,
    NETFS_MAX_REQUEST_BYTES,
    NETFS_MAX_RESPONSE_BYTES,
    NetFSError,
    encodeNetFSResponse,
} from "../common/netfs/NetFSProtocol";

/**
 * NetFS client driver tests (N2)
 *
 * Driver diuji lewat channel LOOPBACK in-memory: request dari `NetFS` masuk ke
 * `NetFSServer` dan balasannya kembali — persis alur produksi, tapi tanpa
 * MQTNL/broker. Jadi logika korelasi `id`, timeout, cache, dan pagar
 * read-only teruji deterministik.
 */

const PREFIX = "/export";

class LoopbackChannel implements INetFSChannel {
    public readonly peer = "tsix_2:7777";
    public sent = 0;
    /** Panjang payload request TERBESAR yang lewat — untuk uji pagar ukuran. */
    public maxSent = 0;
    private handler: ((raw: any) => void) | null = null;

    constructor(
        private readonly server: NetFSServer,
        private readonly opts: { drop?: boolean; delayMs?: number } = {},
    ) {}

    public onMessage(handler: (raw: any) => void): void {
        this.handler = handler;
    }

    public async send(payload: Buffer): Promise<boolean> {
        this.sent++;
        if (payload.length > this.maxSent) this.maxSent = payload.length;
        if (this.opts.drop) return true; // paket "hilang di jaringan"

        setTimeout(() => {
            void this.server.handle(payload, { src: "tsix" }).then((res) => this.handler?.(encodeNetFSResponse(res)));
        }, this.opts.delayMs ?? 0);

        return true;
    }

    public async close(): Promise<void> {
        this.handler = null;
    }
}

describe("NetFS client driver (N2)", () => {
    let backend: RamFS;
    let server: NetFSServer;
    let channel: LoopbackChannel;
    let mounts: NetFS[] = [];

    /** expectError(): Jalankan promise yang seharusnya gagal, ambil error-nya. */
    async function expectError(promise: Promise<any>): Promise<NetFSError> {
        try {
            await promise;
        } catch (e) {
            return e as NetFSError;
        }
        throw new Error("diharapkan gagal, tapi promise berhasil");
    }

    function mountFS(
        opts: Partial<{ readOnly: boolean; cacheTtlMs: number; timeoutMs: number }> = {},
        srv = server,
        ch: INetFSChannel = channel,
    ) {
        const fs = new NetFS({
            channel: ch,
            label: "net-test",
            readOnly: opts.readOnly,
            cacheTtlMs: opts.cacheTtlMs,
            timeoutMs: opts.timeoutMs,
        });
        mounts.push(fs);
        return fs;
    }

    beforeEach(() => {
        backend = new RamFS("netfs-client-test");
        backend.mkdir(PREFIX, 0, 0, 0o755);
        backend.mkdir(`${PREFIX}/docs`, 0, 0, 0o755);
        backend.touch(`${PREFIX}/docs/a.txt`, "halo netfs", 0, 0, 0o644);
        server = new NetFSServer(backend, { prefix: PREFIX, label: "shared" });
        channel = new LoopbackChannel(server);
        mounts = [];
    });

    afterEach(async () => {
        for (const m of mounts) await m.close();
    });

    it("N2.01 handshake mengambil metadata export dari SL", async () => {
        const fs = mountFS();
        const info = await fs.handshake();

        expect(info.label).toBe("shared");
        expect(info.readOnly).toBe(false);
        expect(fs.isStale).toBe(false);
    });

    it("N2.02 ls/stat/read jalan seperti filesystem lokal", async () => {
        const fs = mountFS();

        const entries = await fs.ls("/docs");
        expect(entries.map((e: any) => e.name)).toEqual(["a.txt"]);

        const node = await fs.stat("/docs/a.txt");
        expect(node.type).toBe("FILE");
        expect(node.size).toBe("halo netfs".length);

        expect(await fs.read("/docs/a.txt")).toBe("halo netfs");
        expect(await fs.exists("/docs/a.txt")).toBe(true);
        expect(await fs.exists("/docs/hantu.txt")).toBe(false);
        expect(await fs.read("/docs/hantu.txt")).toBe(null);
    });

    it("N2.03 tulis-baca ulang konsisten (konten biner-safe byte 0..255)", async () => {
        const fs = mountFS();
        const binary = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join("");

        expect(await fs.touch("/docs/bytes.bin", binary)).toBe(true);
        expect(await fs.read("/docs/bytes.bin")).toBe(binary);

        expect(await fs.append("/docs/bytes.bin", "-tambahan")).toBe(true);
        expect(await fs.read("/docs/bytes.bin")).toBe(binary + "-tambahan");

        expect(await fs.unlink("/docs/bytes.bin")).toBe(true);
        expect(await fs.exists("/docs/bytes.bin")).toBe(false);
    });

    it("N2.04 chunked I/O untuk file besar (di bawah 500KB) tetap utuh", async () => {
        const fs = mountFS();
        const chunk = "A".repeat(30000);
        const chunk2 = "B".repeat(30000);
        const chunk3 = "C".repeat(30000);

        expect(await fs.touch("/docs/big.bin", "")).toBe(true);
        expect(await fs.writeChunk("/docs/big.bin", chunk, 0)).toBe(true);
        expect(await fs.writeChunk("/docs/big.bin", chunk2, 30000)).toBe(true);
        expect(await fs.writeChunk("/docs/big.bin", chunk3, 60000)).toBe(true);

        expect(await fs.getSize("/docs/big.bin")).toBe(90000);

        const part1 = await fs.readChunk("/docs/big.bin", 0, 30000);
        const part2 = await fs.readChunk("/docs/big.bin", 30000, 30000);
        const part3 = await fs.readChunk("/docs/big.bin", 60000, 30000);
        expect(part1! + part2! + part3!).toBe(chunk + chunk2 + chunk3);
    });

    it("N2.05 mkdir/rmdir/chmod/chown/getUsage jalan lewat jaringan", async () => {
        const fs = mountFS();

        expect(await fs.mkdir("/docs/sub", 0, 0, 0o755)).toBe(true);
        expect(await fs.exists("/docs/sub", "DIRECTORY" as any)).toBe(true);

        expect(await fs.chmod("/docs/sub", 0o700)).toBe(true);
        expect((await fs.stat("/docs/sub")).mode).toBe(0o700);

        expect(await fs.chown("/docs/sub", 0, 0)).toBe(true);
        expect(await fs.rmdir("/docs/sub")).toBe(true);

        const usage = await fs.getUsage();
        expect(usage.files).toBeGreaterThan(0);
        expect(usage.size).toBe("halo netfs".length);
    });

    it("N2.06 client read-only menolak tulis tanpa mengirim apa pun", async () => {
        const fs = mountFS({ readOnly: true });

        await expect(fs.touch("/docs/x.txt", "x")).rejects.toThrow(/read-only/);
        await expect(fs.unlink("/docs/a.txt")).rejects.toThrow(/read-only/);
        await expect(fs.writeChunk("/docs/a.txt", "x", 0)).rejects.toThrow(/read-only/);

        expect(channel.sent).toBe(0);
        expect(await fs.read("/docs/a.txt")).toBe("halo netfs"); // baca tetap boleh
    });

    it("N2.07 pagar read-only di SH ditegakkan walau klien bukan read-only", async () => {
        const roServer = new NetFSServer(backend, { prefix: PREFIX, readOnly: true });
        const roChannel = new LoopbackChannel(roServer);
        const fs = mountFS({}, roServer, roChannel);

        await expect(fs.touch("/docs/y.txt", "y")).rejects.toMatchObject({ code: "EROFS" });
    });

    it("N2.08 timeout menandai mount stale (soft mount, bukan hang)", async () => {
        const deadChannel = new LoopbackChannel(server, { drop: true });
        const fs = mountFS({ timeoutMs: 40 }, server, deadChannel);

        const err = await expectError(fs.read("/docs/a.txt"));
        expect(err).toBeInstanceOf(NetFSError);
        expect(err.code).toBe("ETIMEDOUT");
        expect(fs.isStale).toBe(true);
        expect(fs.health().lastError).toContain("timeout");
    });

    it("N2.09 mount pulih sendiri setelah SL hidup lagi", async () => {
        let drop = true;
        const ch = new LoopbackChannel(server);

        const flaky: INetFSChannel = {
            peer: "tsix_2:7777",
            send: (payload: Buffer) => {
                if (drop) return true; // hilang
                return ch.send(payload);
            },
            onMessage: (h) => ch.onMessage(h),
        };

        const fs = mountFS({ timeoutMs: 40 }, server, flaky);
        await expect(fs.read("/docs/a.txt")).rejects.toThrow();
        expect(fs.isStale).toBe(true);

        drop = false;
        expect(await fs.read("/docs/a.txt")).toBe("halo netfs");
        expect(fs.isStale).toBe(false);
    });

    it("N2.10 cache ls/stat menghemat round-trip, dan invalid saat menulis", async () => {
        const fs = mountFS({ cacheTtlMs: 5000 });

        await fs.ls("/docs");
        const afterFirstLs = channel.sent;
        await fs.ls("/docs");
        expect(channel.sent).toBe(afterFirstLs); // ls kedua 100% dari cache

        await fs.stat("/docs/a.txt");
        const afterFirstStat = channel.sent;
        await fs.stat("/docs/a.txt");
        expect(channel.sent).toBe(afterFirstStat); // stat kedua juga dari cache

        await fs.touch("/docs/a.txt", "berubah");
        const afterWrite = channel.sent;
        await fs.ls("/docs");
        expect(channel.sent).toBe(afterWrite + 1); // cache dibersihkan → ambil ulang
    });

    it("N2.11 getUsage di-cache lebih lama (df dipanggil berulang)", async () => {
        const fs = mountFS();

        await fs.getUsage();
        const after = channel.sent;
        await fs.getUsage();
        await fs.getUsage();

        expect(channel.sent).toBe(after);
    });

    it("N2.12 close() membatalkan operasi berikutnya dengan ESTALE", async () => {
        const fs = mountFS();
        await fs.read("/docs/a.txt");

        await fs.close();

        const err = await expectError(fs.read("/docs/a.txt"));
        expect(err).toBeInstanceOf(NetFSError);
        expect(err.code).toBe("ESTALE");
    });

    it("N2.13 peer dipakai di pesan error supaya mount bermasalah mudah dilacak", async () => {
        const deadChannel = new LoopbackChannel(server, { drop: true });
        const fs = mountFS({ timeoutMs: 30 }, server, deadChannel);

        const err = await expectError(fs.ls("/docs"));
        expect(err.message).toContain("tsix_2:7777");
    });

    it("N2.14 append konten besar dipecah otomatis (tidak kena ETOOBIG)", async () => {
        const fs = mountFS();
        const big = "X".repeat(NETFS_MAX_CHUNK_BYTES + 3 * 1024 + 7);

        // Inilah jalur `cp`: open(dst,"w") → write() → vfs.append() dengan isi penuh.
        expect(await fs.append("/docs/big.bin", big)).toBe(true);

        expect(await fs.getSize("/docs/big.bin")).toBe(big.length);
        expect(await fs.read("/docs/big.bin")).toBe(big);

        // Lebih dari satu frame, dan TIDAK ADA yang menabrak pagar ukuran.
        expect(channel.sent).toBeGreaterThan(2);
        expect(channel.maxSent).toBeLessThanOrEqual(NETFS_MAX_REQUEST_BYTES);
    });

    it("N2.15 touch konten besar mengganti isi tanpa menyisakan ekor lama", async () => {
        const fs = mountFS();
        const big = "A".repeat(NETFS_MAX_CHUNK_BYTES + 5);

        expect(await fs.touch("/docs/big.txt", big)).toBe(true);
        expect(await fs.read("/docs/big.txt")).toBe(big);

        // Ganti dengan konten lebih pendek → tidak boleh ada sisa "big" di ekor.
        expect(await fs.touch("/docs/big.txt", "pendek")).toBe(true);
        expect(await fs.read("/docs/big.txt")).toBe("pendek");
        expect(await fs.getSize("/docs/big.txt")).toBe("pendek".length);
    });

    it("N2.16 konten biner 0..255 utuh melewati frame biner (tanpa base64)", async () => {
        const fs = mountFS();
        const binary = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join("");
        const big = binary.repeat(Math.ceil((NETFS_MAX_CHUNK_BYTES + 100) / binary.length));

        expect(await fs.append("/docs/bin.dat", big)).toBe(true);
        expect(await fs.getSize("/docs/bin.dat")).toBe(big.length);
        expect(await fs.read("/docs/bin.dat")).toBe(big);
    });

    it("N2.17 read file besar jatuh ke readChunk otomatis (arah baca, kebalikan writeContent)", async () => {
        // Jalur tulis sudah dipecah otomatis (N2.14). Arah BACA dulu belum: satu
        // `read` file 70 MB = satu balasan raksasa → klien timeout 5 s dan node SH
        // kehabisan heap. SL kini menolaknya (ETOOBIG) dan klien memakai readChunk.
        const fs = mountFS();
        const big = "R".repeat(NETFS_MAX_RESPONSE_BYTES + 3 * 1024);

        // Siapkan lewat jalur tulis (sudah teruji aman).
        expect(await fs.append("/docs/huge.bin", big)).toBe(true);

        const before = channel.sent;
        expect(await fs.read("/docs/huge.bin")).toBe(big);

        // Terbukti dipecah: banyak frame, dan tidak ada yang melewati pagar.
        expect(channel.sent - before).toBeGreaterThan(2);
        expect(channel.maxSent).toBeLessThanOrEqual(NETFS_MAX_REQUEST_BYTES);
    });

    it("N2.18 read file kecil tetap satu round-trip (jalur cepat tidak dikorbankan)", async () => {
        const fs = mountFS();
        const before = channel.sent;

        expect(await fs.read("/docs/a.txt")).toBe("halo netfs");

        // 1 frame request saja — fallback chunk hanya untuk konten besar.
        expect(channel.sent - before).toBe(1);
    });

    it("N2.19 readChunk kosong = ERROR, bukan file 0 byte yang senyap", async () => {
        // Regresi nyata: versi pertama fallback ini `return null`/`""` diam-diam
        // saat potongan kosong, sehingga `cp` melaporkan SUKSES dengan file 0 byte.
        // Sekarang harus MELEMPAR dengan pesan yang menyebut lapisan penyebabnya.
        const stub = {
            getSize: () => 70499395, // > NETFS_MAX_RESPONSE_BYTES → `read` ditolak
            readChunk: () => null, // mis. backend/ekspor peer tidak melayani
            read: () => "tidak dipakai",
        } as any;
        const srv = new NetFSServer(stub, { prefix: "/" });
        const ch = new LoopbackChannel(srv);
        const fs = mountFS({}, srv, ch);

        const err = await expectError(fs.read("/video.mov"));
        expect(err.message).toContain("readChunk");
        expect(err.message).toContain("KOSONG");
        expect(err.message).toContain("70499395"); // ukuran dicantumkan untuk diagnosa
    });
});
