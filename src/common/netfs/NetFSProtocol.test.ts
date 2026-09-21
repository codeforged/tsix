import { describe, it, expect } from "vitest";
import {
    NETFS_ERROR_CODES,
    NETFS_HEADER_SIZE,
    NETFS_ID_OFFSET,
    NETFS_MAGIC,
    NETFS_NO_ERROR,
    NETFS_OP_BY_CODE,
    NETFS_OP_CODE,
    NETFS_OP_LIST,
    NETFS_TYPE_REQUEST,
    NETFS_VERSION,
    NETFS_WIRE_PROTOCOL,
    blob,
    blobData,
    decodeNetFSRequest,
    decodeNetFSResponse,
    encodeNetFSRequest,
    encodeNetFSResponse,
    isNetFSFrame,
    patchNetFSFrameId,
    readNetFSFrameHeader,
    toNetFSBuffer,
} from "./NetFSProtocol";

/**
 * NetFS protocol v2 (N6) — codec frame BINER.
 *
 * Yang dijaga di sini adalah kontrak wire: kalau layout berubah, dua node
 * dengan versi berbeda bicara hal yang berbeda. Karena itu round-trip diuji
 * untuk semua bentuk nilai + byte biner 0..255, dan helper relay (baca header,
 * tambal `id`) diuji terpisah.
 */

describe("NetFS frame codec (N6)", () => {
    /** Konten biner lengkap: 256 byte, bukan cuma teks. */
    const binary = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join("");

    it("N6.01 request round-trip: op, path, args (campuran tipe)", () => {
        const frame = encodeNetFSRequest({
            id: 42,
            op: "touch",
            path: "/docs/a.txt",
            args: [blob("isi"), 1000, 1000, 420],
        });
        const decoded = decodeNetFSRequest(frame);

        expect(decoded.id).toBe(42);
        expect(decoded.op).toBe("touch");
        expect(decoded.path).toBe("/docs/a.txt");
        expect(blobData(decoded.args![0])).toBe("isi");
        expect(decoded.args!.slice(1)).toEqual([1000, 1000, 420]);
    });

    it("N6.02 konten biner 0..255 lewat sebagai byte mentah (tanpa base64)", () => {
        const frame = encodeNetFSRequest({
            id: 1,
            op: "writeChunk",
            path: "/x",
            args: [blob(binary), 0],
        });
        const decoded = decodeNetFSRequest(frame);

        expect(blobData(decoded.args![0])).toBe(binary);
        // Frame ≈ header + konten: TIDAK ada pembengkakan 4/3x seperti base64.
        expect(frame.length).toBeLessThan(binary.length + 64);
    });

    it("N6.03 response sukses round-trip (objek & array ala stat/info)", () => {
        const result = {
            label: "shared",
            readOnly: false,
            ops: ["ls", "read"],
            attachedAt: 1700000000000,
            diskSize: null,
        };
        const decoded = decodeNetFSResponse(encodeNetFSResponse({ v: NETFS_VERSION, id: 7, ok: true, result }));

        expect(decoded.ok).toBe(true);
        expect(decoded.id).toBe(7);
        expect(decoded.result).toEqual(result);
    });

    it("N6.04 response gagal membawa kode + pesan + path", () => {
        const decoded = decodeNetFSResponse(
            encodeNetFSResponse({
                v: NETFS_VERSION,
                id: 9,
                ok: false,
                code: "ENOENT",
                err: "tidak ada",
                path: "/docs/x",
            }),
        );

        expect(decoded.ok).toBe(false);
        expect(decoded.code).toBe("ENOENT");
        expect(decoded.err).toBe("tidak ada");
        expect(decoded.path).toBe("/docs/x");
        expect(decoded.result).toBeUndefined();
    });

    it("N6.05 header dibaca tanpa decode payload, id ditambal di tempat (relay)", () => {
        const frame = encodeNetFSRequest({ id: 5, op: "read", path: "/a" });
        const header = readNetFSFrameHeader(frame)!;

        expect(header.type).toBe(NETFS_TYPE_REQUEST);
        expect(header.id).toBe(5);
        expect(header.opCodeOrFlags).toBe(NETFS_OP_CODE.read);
        expect(frame.readUInt32BE(NETFS_ID_OFFSET)).toBe(5);

        // Relay: id 5 → 99; byte SETELAH header harus tidak tersentuh sama sekali.
        const patched = patchNetFSFrameId(frame, 99);
        expect(readNetFSFrameHeader(patched)!.id).toBe(99);
        expect(patched.subarray(NETFS_HEADER_SIZE)).toEqual(frame.subarray(NETFS_HEADER_SIZE));
        expect(readNetFSFrameHeader(frame)!.id).toBe(5); // buffer asli utuh
    });

    it("N6.06 frame rusak / versi lama ditolak jelas (bukan diam-diam)", () => {
        expect(isNetFSFrame(Buffer.from([NETFS_MAGIC, NETFS_VERSION, 0, 1, 0, 0, 0, 1]))).toBe(true);

        // JSON v1 (base64) tidak lagi didukung — dulu ini tampak seperti mount hang.
        expect(() => decodeNetFSRequest(Buffer.from('{"v":1,"id":1,"op":"ls"}'))).toThrow(/bukan frame NetFS v2/i);

        // Versi berbeda
        const old = Buffer.from(encodeNetFSRequest({ id: 1, op: "ls", path: "/" }));
        old[1] = 1;
        expect(() => decodeNetFSRequest(old)).toThrow();

        // Frame terpotong
        const full = encodeNetFSRequest({
            id: 1,
            op: "touch",
            path: "/a",
            args: [blob("x")],
        });
        expect(() => decodeNetFSRequest(full.subarray(0, full.length - 2))).toThrow();
    });

    it("N6.07 toNetFSBuffer menormalkan semua bentuk payload transport", () => {
        const frame = encodeNetFSRequest({ id: 3, op: "info" });

        expect(toNetFSBuffer(frame)!.equals(frame)).toBe(true); // Buffer (kernel)
        expect(toNetFSBuffer(new Uint8Array(frame))!.equals(frame)).toBe(true); // IPC clone
        expect(toNetFSBuffer({ type: "Buffer", data: [...frame] })!.equals(frame)).toBe(true);
        expect(toNetFSBuffer({ ...frame })!.equals(frame)).toBe(true); // objek bernomor
        expect(toNetFSBuffer(frame.toString("utf8"))!.equals(frame)).toBe(true); // Binfeo tanpa key

        expect(toNetFSBuffer("")).toBeNull();
        expect(toNetFSBuffer(null)).toBeNull();
        expect(toNetFSBuffer(12345)).toBeNull();
    });

    it("N6.08 tabel op & kode error stabil (unik, decode balik persis)", () => {
        const codes = NETFS_OP_LIST.map((op) => NETFS_OP_CODE[op]);
        expect(new Set(codes).size).toBe(NETFS_OP_LIST.length);
        expect(codes.every((c) => c > 0)).toBe(true);
        for (const op of NETFS_OP_LIST) {
            expect(NETFS_OP_BY_CODE[NETFS_OP_CODE[op]]).toBe(op);
        }

        for (const code of NETFS_ERROR_CODES) {
            const decoded = decodeNetFSResponse(
                encodeNetFSResponse({ v: NETFS_VERSION, id: 1, ok: false, code, err: "x" }),
            );
            expect(decoded.code).toBe(code);
        }

        expect(NETFS_NO_ERROR).toBeGreaterThan(NETFS_ERROR_CODES.length - 1);
        expect(NETFS_WIRE_PROTOCOL).toBe("Binfeo");
    });

    it("N6.09 nilai bersarang berlebihan ditolak (penjaga frame jahat)", () => {
        let deep: any = null;
        for (let i = 0; i < 12; i++) deep = [deep];

        expect(() => encodeNetFSRequest({ id: 1, op: "ls", path: "/", args: [deep] })).toThrow(/terlalu dalam/);
    });

    it("N6.10 null / boolean / angka negatif tetap utuh", () => {
        const args = [null, true, false, -1, 0, Number.MAX_SAFE_INTEGER];
        const decoded = decodeNetFSRequest(encodeNetFSRequest({ id: 1, op: "mkdir", path: "/d", args }));

        expect(decoded.args).toEqual(args);
    });
});
