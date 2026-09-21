/**
 * NETFS PROTOCOL (NetFS v2) — Wire protocol filesystem-over-MQTNL, BINER
 *
 * Satu request = satu paket MQTNL, satu balasan = satu paket. Berisi definisi
 * op, codec frame biner (kompak, tanpa JSON/base64), dan util parsing spec
 * alamat (`tsix_2:7777`).
 *
 * KENAPA BINER (v2), BUKAN JSON + base64 (v1):
 *
 *   - v1 mengirim konten sebagai **base64 di dalam JSON**; karena Binfeo
 *     mengenkripsi payload string menjadi **HEX**, satu chunk 32 KiB menjadi
 *     ~87,6 KB di wire. v2 mengirim byte mentah: ~32,8 KB (+28 byte IV/tag
 *     saat terenkripsi) — hemat ~62% dan 3 fragmen → 1 fragmen.
 *   - Tidak ada lagi `JSON.parse`/`stringify` untuk payload besar, dan relay
 *     `netfsd --client` cukup menambal 4 byte `id` di offset tetap — dulu ia
 *     mem-parse lalu men-serialize ulang setiap request.
 *   - Ukuran frame tidak lagi menggelembung 4/3x, jadi satu chunk bisa
 *     dirancang PAS satu fragmen MQTNL (`NETFS_MAX_CHUNK_BYTES` = 31 KiB,
 *     di bawah `SimpleMQTNLDriver.packetSize` = 32 KiB).
 *
 * Transport-nya tetap MQTNL — protocol **Binfeo** (`mqtnl@1.2/`, biner yang
 * bisa dienkripsi) — jadi TIDAK butuh IP publik / sewa VPS: cukup reach-ability
 * lewat broker yang sama. Protokol JSON/base64 v1 sudah **tidak didukung**.
 *
 * File ini SENGAJA dependency-free (tidak impor apa pun dari kernel/vfs)
 * karena dipakai oleh DUA dunia:
 *
 *   - KERNEL  : `src/vfs/NetFS.ts` (driver klien, `mount --netfs ...`)
 *   - USERLAND: `src/mirror/sbin/netfsd.ts` (SL / server listener) dan
 *               `src/mirror/lib/NetFSClient.ts` (`netfs info|ls|cat`) via NetSocket
 *
 * (c) 2026 TSIX Project
 */

/** Versi wire protocol — v2 = frame biner (Binfeo). v1 (JSON/base64) dibuang. */
export const NETFS_VERSION = 2;

/**
 * Protocol MQTNL yang WAJIB di-pin di semua socket/port NetFS
 * (`protocol:` NetSocket, `ioctl 0x1002` untuk port kernel).
 *
 * Di-pin eksplisit — bukan diwarisi dari `protocolRegistry` — karena
 * penerima tidak mengontrol framing pengirim: sekali ada trafik biner lain di
 * node yang sama, port tanpa pin bisa ikut ter-frame lain dan request NetFS
 * tiba dalam bentuk yang salah (di v1 ini pernah bikin mount hang).
 */
export const NETFS_WIRE_PROTOCOL = "Binfeo";

/** Port default SL (netfsd) di node storage host. */
export const NETFS_DEFAULT_PORT = 7777;

/**
 * Port default daemon KLIEN (netfsd --client) di node yang me-mount.
 * Kernel mengirim request mount ke port ini lewat MQTNL loopback.
 */
export const NETFS_DEFAULT_CLIENT_PORT = 7778;

/** Timeout default satu operasi (ms). Mount bisa override via --timeout. */
export const NETFS_DEFAULT_TIMEOUT_MS = 5000;

/**
 * Batas ukuran satu frame request (BYTE, bukan karakter). Konten besar tetap
 * harus lewat `readChunk`/`writeChunk`; pagar ini hanya jaring pengaman supaya
 * peer yang salah bisa ditolak cepat (`ETOOBIG`), bukan mengisi RAM SL.
 */
export const NETFS_MAX_REQUEST_BYTES = 64 * 1024;

/**
 * Ukuran maksimum konten per potongan (`readChunk`/`writeChunk`) — sekaligus
 * batas konten inline untuk `touch`/`append`/`read`, byte.
 *
 * 31 KiB dipilih supaya SATU potongan (frame + overhead keamanan 28 byte)
 * muat dalam SATU fragmen MQTNL 32 KiB: tanpa ini chunk 32 KiB justru terpecah
 * jadi dua paket. Driver `NetFS` memakai angka ini untuk memutuskan kapan
 * sebuah tulis harus dipecah otomatis.
 */
export const NETFS_MAX_CHUNK_BYTES = 31 * 1024;

// ==================== OP ====================

/** Semua operasi yang dilayani SL — 1:1 dengan method `IVFS`. */
export type NetFSOp =
    | "info"
    | "ls"
    | "mkdir"
    | "read"
    | "touch"
    | "stat"
    | "chmod"
    | "chown"
    | "unlink"
    | "rmdir"
    | "exists"
    | "append"
    | "getUsage"
    | "readChunk"
    | "writeChunk"
    | "getSize";

/** Daftar op runtime (dipakai validasi request + `netfs info`). */
export const NETFS_OP_LIST: readonly NetFSOp[] = [
    "info",
    "ls",
    "mkdir",
    "read",
    "touch",
    "stat",
    "chmod",
    "chown",
    "unlink",
    "rmdir",
    "exists",
    "append",
    "getUsage",
    "readChunk",
    "writeChunk",
    "getSize",
];

/** Op yang MENGUBAH isi filesystem — diblokir saat `readOnly`. */
export const NETFS_WRITE_OPS: readonly NetFSOp[] = [
    "mkdir",
    "touch",
    "chmod",
    "chown",
    "unlink",
    "rmdir",
    "append",
    "writeChunk",
];

/** Cek apakah sebuah string adalah op NetFS yang dikenal. */
export function isNetFSOp(op: any): op is NetFSOp {
    return typeof op === "string" && (NETFS_OP_LIST as readonly string[]).includes(op);
}

/**
 * Tabel kode op di wire (1 byte). Diturunkan dari NETFS_OP_LIST supaya
 * urutannya satu sumber dan tidak bisa desinkron: op ke-i → kode i+1
 * (0 disisakan sebagai "tidak valid", berguna untuk deteksi frame sampah).
 */
export const NETFS_OP_CODE: Readonly<Record<NetFSOp, number>> = Object.freeze(
    Object.fromEntries(NETFS_OP_LIST.map((op, i) => [op, i + 1])),
) as Readonly<Record<NetFSOp, number>>;

/** Kebalikan NETFS_OP_CODE: kode wire → nama op. */
export const NETFS_OP_BY_CODE: Readonly<Record<number, NetFSOp>> = Object.freeze(
    Object.fromEntries(NETFS_OP_LIST.map((op, i) => [i + 1, op])),
) as Readonly<Record<number, NetFSOp>>;

// ==================== KODE ERROR ====================

/**
 * Tabel kode error di wire (1 byte = indeks di sini). Urutan TIDAK boleh
 * berubah setelah dirilis — frame lama di jaringan akan salah tafsir kalau iya.
 */
export const NETFS_ERROR_CODES: readonly NetFSErrorCode[] = [
    "ENOENT",
    "EACCES",
    "EPERM",
    "EROFS",
    "ENOTEMPTY",
    "EINVAL",
    "EBADREQ",
    "EBADOP",
    "ETOOBIG",
    "ETIMEDOUT",
    "ESTALE",
    "EIO",
];

/** Indeks wire untuk kode error — 0xFF = "tidak ada error" (ok: true). */
export const NETFS_NO_ERROR = 0xff;

// ==================== AMPLOP ====================

/** Request dari klien (kernel `NetFS` driver) ke SL (`netfsd`). */
export interface NetFSRequest {
    /** Versi protocol (selalu `NETFS_VERSION` di frame yang dikirim). */
    v?: number;
    /** Nomor urut request — dipakai klien mencocokkan balasan. */
    id: number;
    /** Operasi yang diminta. */
    op: NetFSOp;
    /** Path relatif terhadap root export SL (mis. "/docs/a.txt"). */
    path?: string;
    /**
     * Argumen tambahan per-op. Konten biner WAJIB dibungkus `blob()` supaya
     * dikirim sebagai byte mentah (latin1), bukan sebagai teks UTF-8.
     */
    args?: any[];
}

/** Kode error — subset POSIX yang relevan untuk filesystem. */
export type NetFSErrorCode =
    | "ENOENT"
    | "EACCES"
    | "EPERM"
    | "EROFS"
    | "ENOTEMPTY"
    | "EINVAL"
    | "EBADREQ"
    | "EBADOP"
    | "ETOOBIG"
    | "ETIMEDOUT"
    | "ESTALE"
    | "EIO";

/** Balasan dari SL ke klien. */
export interface NetFSResponse {
    /** Versi protocol SL. */
    v: number;
    /** Sama dengan id request (0 kalau request tak terbaca). */
    id: number;
    /** true = sukses (`result` terisi), false = gagal (`err`+`code` terisi). */
    ok: boolean;
    /** Hasil operasi (bentuknya per-op). */
    result?: any;
    /** Pesan error manusiawi. */
    err?: string;
    /** Kode error mesin (lihat NetFSErrorCode). */
    code?: NetFSErrorCode;
    /** Path yang sedang diproses — membantu diagnosa di sisi klien. */
    path?: string;
}

/** Info export yang dikembalikan op `info` (handshake / `netfs info`). */
export interface NetFSExportInfo {
    /** Versi protocol SL. */
    v: number;
    /** Nama export (dari `netfsd --label`). */
    label: string;
    /** Prefix path di backend SH. */
    prefix: string;
    /** true = SL dipaksa read-only. */
    readOnly: boolean;
    /** Daftar op yang dilayani. */
    ops: readonly NetFSOp[];
    /** Epoch ms saat export di-attach. */
    attachedAt: number;
}

/**
 * NetFSError — error yang membawa kode POSIX-style.
 * Dipakai bersama oleh klien (throw ke pemanggil) dan SL (jadi `code`).
 */ export class NetFSError extends Error {
    public readonly code: NetFSErrorCode;
    public readonly op?: string;

    constructor(code: NetFSErrorCode, message: string, op?: string) {
        super(message);
        this.name = "NetFSError";
        this.code = code;
        this.op = op;
    }
}

// ==================== CODEC FRAME BINER ====================

/**
 * LAYOUT FRAME (little detail, big-endian semua):
 *
 *   offset  size  REQUEST                        RESPONSE
 *   0       1     magic 0x4E ('N')               magic 0x4E
 *   1       1     version (NETFS_VERSION)        version
 *   2       1     type 0 (request)               type 1 (response)
 *   3       1     kode op                        flag (bit0 = ok)
 *   4       4     id (uint32 BE)                 id (uint32 BE)
 *   8       ...   u16 pathLen + path(utf8)       u8 errCode + u16 errLen + err(utf8)
 *                 nilai(args)  ← array            u16 pathLen + path(utf8)
 *                                                 nilai(result)
 *
 * `id` SELALU di offset 4 pada dua tipe frame: relay `netfsd --client` bisa
 * menambal nomor urut tanpa men-decode seluruh payload (dulu: parse + serialize
 * ulang JSON tiap request).
 */
export const NETFS_MAGIC = 0x4e; // 'N'
export const NETFS_HEADER_SIZE = 8;
export const NETFS_ID_OFFSET = 4;
export const NETFS_TYPE_REQUEST = 0;
export const NETFS_TYPE_RESPONSE = 1;
/** Batas kedalaman nilai bersarang — penjaga terhadap frame jahat/rusak. */
export const NETFS_MAX_DEPTH = 8;

/** Nilai wire — 1 byte tag di depan tiap nilai. */
const T_NULL = 0x00;
const T_FALSE = 0x01;
const T_TRUE = 0x02;
const T_NUM = 0x03; // i64 BE (semua angka NetFS = bilangan bulat)
const T_STR = 0x04; // u32 len + byte UTF-8   (metadata: path, name, label)
const T_BLOB = 0x05; // u32 len + byte MENTAH  (konten file, latin1-safe)
const T_ARR = 0x06; // u16 count + [nilai]*
const T_OBJ = 0x07; // u16 count + [u16 keyLen + key(utf8), nilai]*

/**
 * NetFSBlob — pembungkus konten biner-safe di codec.
 *
 * String internal TSIX = latin1 (tiap char = 1 byte; lihat BKFS/HostVFS), jadi
 * konten file dikirim sebagai byte mentah hasil `Buffer.from(str, "latin1")`.
 * Tanpa pembungkus ini codec tidak bisa membedakan konten (byte apa pun) dari
 * teks metadata (harus UTF-8) — dan byte ≥ 0x80 akan rusak.
 */
export class NetFSBlob {
    public readonly data: string;
    constructor(data: string) {
        this.data = data;
    }
}

/** blob(): Tandai string sebagai konten biner (kirim byte mentah). */
export function blob(content: string | null | undefined): NetFSBlob | null {
    if (content === null || content === undefined) return null;
    return new NetFSBlob(typeof content === "string" ? content : String(content));
}

/** blobData(): Ambil kembali isi konten dari hasil decode (tahan `null`). */
export function blobData(value: any): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value;
    if (value instanceof NetFSBlob) return value.data;
    return null;
}

/** u16()/u32(): Nilai big-endian sebagai Buffer kecil. */
function u16(value: number): Buffer {
    const b = Buffer.allocUnsafe(2);
    b.writeUInt16BE(Math.max(0, Math.min(0xffff, value | 0)), 0);
    return b;
}

function u32(value: number): Buffer {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32BE(value >>> 0, 0);
    return b;
}

/** writeValue(): Serialisasi satu nilai JS → potongan Buffer. */
function writeValue(parts: Buffer[], value: any, depth = 0): void {
    if (depth > NETFS_MAX_DEPTH) {
        throw new NetFSError("EBADREQ", "netfs: nilai bersarang terlalu dalam");
    }
    if (value === null || value === undefined) {
        parts.push(Buffer.from([T_NULL]));
        return;
    }
    if (value instanceof NetFSBlob) {
        const bytes = Buffer.from(value.data, "latin1");
        parts.push(Buffer.from([T_BLOB]), u32(bytes.length), bytes);
        return;
    }
    switch (typeof value) {
        case "boolean":
            parts.push(Buffer.from([value ? T_TRUE : T_FALSE]));
            return;
        case "number": {
            if (!Number.isFinite(value)) {
                parts.push(Buffer.from([T_NULL]));
                return;
            }
            const b = Buffer.allocUnsafe(9);
            b.writeUInt8(T_NUM, 0);
            b.writeBigInt64BE(BigInt(Math.trunc(value)), 1);
            parts.push(b);
            return;
        }
        case "string": {
            const bytes = Buffer.from(value, "utf8");
            parts.push(Buffer.from([T_STR]), u32(bytes.length), bytes);
            return;
        }
    }
    if (Array.isArray(value)) {
        parts.push(Buffer.from([T_ARR]), u16(value.length));
        for (const item of value) writeValue(parts, item, depth + 1);
        return;
    }
    if (typeof value === "object") {
        const entries = Object.entries(value as Record<string, any>);
        parts.push(Buffer.from([T_OBJ]), u16(entries.length));
        for (const [key, item] of entries) {
            const keyBytes = Buffer.from(key, "utf8");
            parts.push(u16(keyBytes.length), keyBytes);
            writeValue(parts, item, depth + 1);
        }
        return;
    }
    parts.push(Buffer.from([T_NULL]));
}

/**
 * FrameReader — kursor baca dengan penjaga batas. SEMUA panjang dibaca dari
 * wire divalidasi di sini lewat `need()`, jadi frame terpotong/panjang bohong
 * melempar error (jadi balasan EBADREQ yang jelas), bukan membaca memori liar.
 */
class FrameReader {
    public offset: number;
    constructor(
        private readonly buf: Buffer,
        offset = 0,
    ) {
        this.offset = offset;
    }

    public u8(): number {
        this.need(1);
        return this.buf.readUInt8(this.offset++);
    }

    public u16(): number {
        this.need(2);
        const v = this.buf.readUInt16BE(this.offset);
        this.offset += 2;
        return v;
    }

    public u32(): number {
        this.need(4);
        const v = this.buf.readUInt32BE(this.offset);
        this.offset += 4;
        return v;
    }

    public i64(): number {
        this.need(8);
        const v = this.buf.readBigInt64BE(this.offset);
        this.offset += 8;
        return Number(v);
    }

    public bytes(length: number): Buffer {
        this.need(length);
        const view = this.buf.subarray(this.offset, this.offset + length);
        this.offset += length;
        return view;
    }

    private need(length: number): void {
        if (length < 0 || this.buf.length - this.offset < length) {
            throw new NetFSError("EBADREQ", "netfs: frame terpotong / panjang tidak konsisten");
        }
    }
}

/** readValue(): Kebalikan `writeValue` — tag di depan, lalu nilainya. */
function readValue(r: FrameReader, depth = 0): any {
    if (depth > NETFS_MAX_DEPTH) {
        throw new NetFSError("EBADREQ", "netfs: nilai bersarang terlalu dalam");
    }
    const tag = r.u8();
    switch (tag) {
        case T_NULL:
            return null;
        case T_FALSE:
            return false;
        case T_TRUE:
            return true;
        case T_NUM:
            return r.i64();
        case T_STR:
            return r.bytes(r.u32()).toString("utf8");
        case T_BLOB:
            // Konten: byte → latin1, persis encoding string internal TSIX.
            return r.bytes(r.u32()).toString("latin1");
        case T_ARR: {
            const count = r.u16();
            const out: any[] = [];
            for (let i = 0; i < count; i++) out.push(readValue(r, depth + 1));
            return out;
        }
        case T_OBJ: {
            const count = r.u16();
            const out: Record<string, any> = {};
            for (let i = 0; i < count; i++) {
                const key = r.bytes(r.u16()).toString("utf8");
                out[key] = readValue(r, depth + 1);
            }
            return out;
        }
        default:
            throw new NetFSError("EBADREQ", `netfs: tag nilai tidak dikenal: 0x${tag.toString(16)}`);
    }
}

/** Header frame yang sudah dibaca (tanpa men-decode payload). */
export interface NetFSFrameHeader {
    /** NETFS_TYPE_REQUEST | NETFS_TYPE_RESPONSE. */
    type: number;
    /** Request: kode op. Response: flag (bit0 = ok). Lihat NETFS_OP_CODE. */
    opCodeOrFlags: number;
    /** Nomor urut — selalu di NETFS_ID_OFFSET (relay menambal di sini). */
    id: number;
}

/** isNetFSFrame(): Cek magic + versi, tanpa melempar. */
export function isNetFSFrame(buf: Buffer): boolean {
    return (
        Buffer.isBuffer(buf) && buf.length >= NETFS_HEADER_SIZE && buf[0] === NETFS_MAGIC && buf[1] === NETFS_VERSION
    );
}

/** readNetFSFrameHeader(): Baca header saja (dipakai relay `netfsd`). */
export function readNetFSFrameHeader(buf: Buffer): NetFSFrameHeader | null {
    if (!isNetFSFrame(buf)) return null;
    return {
        type: buf[2],
        opCodeOrFlags: buf[3],
        id: buf.readUInt32BE(NETFS_ID_OFFSET),
    };
}

/**
 * patchNetFSFrameId(): Tulis ulang `id` di header, TANPA men-decode payload.
 * Return salinan baru (buffer pemanggil tidak diubah).
 */
export function patchNetFSFrameId(buf: Buffer, id: number): Buffer {
    const out = Buffer.from(buf);
    out.writeUInt32BE(id >>> 0, NETFS_ID_OFFSET);
    return out;
}

/** encodeNetFSRequest(): Request → frame biner siap kirim. */
export function encodeNetFSRequest(req: NetFSRequest): Buffer {
    const opCode = NETFS_OP_CODE[req.op];
    if (!opCode) {
        throw new NetFSError("EBADOP", `netfs: op tidak dikenal: ${String(req.op)}`);
    }
    const head = Buffer.allocUnsafe(NETFS_HEADER_SIZE);
    head.writeUInt8(NETFS_MAGIC, 0);
    head.writeUInt8(NETFS_VERSION, 1);
    head.writeUInt8(NETFS_TYPE_REQUEST, 2);
    head.writeUInt8(opCode, 3);
    head.writeUInt32BE(req.id >>> 0, NETFS_ID_OFFSET);

    const parts: Buffer[] = [head];
    const pathBytes = Buffer.from(req.path ?? "/", "utf8");
    parts.push(u16(pathBytes.length), pathBytes);
    writeValue(parts, Array.isArray(req.args) ? req.args : []);
    return Buffer.concat(parts);
}

/** decodeNetFSRequest(): Frame biner → request. Melempar NetFSError kalau rusak. */
export function decodeNetFSRequest(buf: Buffer): NetFSRequest {
    const header = readNetFSFrameHeader(buf);
    if (!header) {
        throw new NetFSError("EBADREQ", "netfs: bukan frame NetFS v2");
    }
    if (header.type !== NETFS_TYPE_REQUEST) {
        throw new NetFSError("EBADREQ", "netfs: frame bukan REQUEST");
    }
    const op = NETFS_OP_BY_CODE[header.opCodeOrFlags];
    if (!op) {
        throw new NetFSError("EBADOP", `netfs: kode op tidak dikenal: 0x${header.opCodeOrFlags.toString(16)}`);
    }

    const r = new FrameReader(buf, NETFS_HEADER_SIZE);
    const path = r.bytes(r.u16()).toString("utf8");
    const args = readValue(r);
    return {
        v: NETFS_VERSION,
        id: header.id,
        op,
        path: path || "/",
        args: Array.isArray(args) ? args : [],
    };
}

/** encodeNetFSResponse(): Balasan → frame biner siap kirim. */
export function encodeNetFSResponse(res: NetFSResponse): Buffer {
    const head = Buffer.allocUnsafe(NETFS_HEADER_SIZE);
    head.writeUInt8(NETFS_MAGIC, 0);
    head.writeUInt8(NETFS_VERSION, 1);
    head.writeUInt8(NETFS_TYPE_RESPONSE, 2);
    head.writeUInt8(res.ok ? 0x01 : 0x00, 3);
    head.writeUInt32BE(res.id >>> 0, NETFS_ID_OFFSET);

    const codeIndex = res.ok ? NETFS_NO_ERROR : Math.max(0, NETFS_ERROR_CODES.indexOf(res.code ?? "EIO"));
    const errBytes = Buffer.from(res.ok ? "" : (res.err ?? ""), "utf8");
    const pathBytes = Buffer.from(res.path ?? "", "utf8");

    const parts: Buffer[] = [
        head,
        Buffer.from([codeIndex]),
        u16(errBytes.length),
        errBytes,
        u16(pathBytes.length),
        pathBytes,
    ];
    writeValue(parts, res.ok ? (res.result ?? null) : null);
    return Buffer.concat(parts);
}

/** decodeNetFSResponse(): Frame biner → balasan. Melempar NetFSError kalau rusak. */
export function decodeNetFSResponse(buf: Buffer): NetFSResponse {
    const header = readNetFSFrameHeader(buf);
    if (!header) {
        throw new NetFSError("EBADREQ", "netfs: bukan frame NetFS v2");
    }
    if (header.type !== NETFS_TYPE_RESPONSE) {
        throw new NetFSError("EBADREQ", "netfs: frame bukan RESPONSE");
    }

    const r = new FrameReader(buf, NETFS_HEADER_SIZE);
    const codeIndex = r.u8();
    const err = r.bytes(r.u16()).toString("utf8");
    const path = r.bytes(r.u16()).toString("utf8");
    const result = readValue(r);

    const ok = (header.opCodeOrFlags & 0x01) === 1;
    const code = ok ? undefined : (NETFS_ERROR_CODES[codeIndex] ?? "EIO");
    return {
        v: NETFS_VERSION,
        id: header.id,
        ok,
        result: ok ? result : undefined,
        err: ok ? undefined : err || "netfs: operasi gagal",
        code,
        path: path || undefined,
    };
}

/**
 * toNetFSBuffer(): Normalkan payload mentah dari transport jadi Buffer.
 *
 * Kenapa perlu: bentuk payload yang tiba bergantung pada jalur, dan NetFS
 * tidak boleh menebak-nebak:
 *   - kernel (driver MQTNL) → `Buffer` utuh;
 *   - userland lewat IPC → `Uint8Array` (structured clone) atau artefak
 *     `{ type: "Buffer", data: [...] }` / `{ "0": 78, ... }`;
 *   - Binfeo TANPA session key → driver mengubah payload yang kebetulan valid
 *     UTF-8 menjadi **string** (`Buffer.from(str,"utf8")` di sini persis
 *     mengembalikannya — cek round-trip UTF-8 di driver menjamin itu).
 *
 * Return null kalau payload kosong / tidak bisa dinormalkan.
 */
export function toNetFSBuffer(raw: any): Buffer | null {
    if (raw === null || raw === undefined || raw === "") return null;
    if (Buffer.isBuffer(raw)) return raw;
    if (raw instanceof Uint8Array) {
        return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    }
    if (typeof raw === "string") return Buffer.from(raw, "utf8");
    if (typeof raw === "object") {
        if (raw.type === "Buffer" && Array.isArray(raw.data)) {
            return Buffer.from(raw.data);
        }
        if (typeof raw[0] === "number") {
            return Buffer.from(Object.values(raw) as number[]);
        }
    }
    return null;
}

/**
 * netfsWireHint(): Pesan diagnosa kalau payload BUKAN frame v2.
 *
 * Bukan lapisan kompatibilitas — hanya supaya salah-versi tidak terlihat
 * seperti "mount hang": peer v1 mengirim JSON (base64) yang tidak lagi
 * didukung, jadi operator langsung tahu penyebabnya.
 */
export function netfsWireHint(raw: any): string {
    const buf = toNetFSBuffer(raw);
    if (buf && buf.length > 0) {
        const first = buf[0];
        if (first === 0x7b || first === 0x5b) {
            return "payload JSON terdeteksi — NetFS v2 hanya berbicara BINER (Binfeo). Pastikan peer memakai build terbaru.";
        }
        if (buf.length >= 2 && buf[1] < NETFS_VERSION) {
            return `peer memakai NetFS v${buf[1]} (lama) — v${NETFS_VERSION} hanya menerima frame biner.`;
        }
    }
    return "payload bukan frame NetFS v2 (butuh transport Binfeo/biner).";
}

// ==================== ERROR MAPPING ====================

/**
 * netfsErrorCodeOf(): Terjemahkan error sembarang (dari backend lokal) jadi
 * kode NetFS. Dipakai SL supaya klien dapat kode yang bisa ditindak-lanjuti,
 * bukan sekadar teks.
 */
export function netfsErrorCodeOf(err: any): NetFSErrorCode {
    if (err instanceof NetFSError) return err.code;
    const code = typeof err?.code === "string" ? err.code : "";
    if (/^E[A-Z]+$/.test(code)) return code as NetFSErrorCode;
    const msg = String(err?.message ?? err ?? "");
    if (/permission denied|eacces|access denied/i.test(msg)) return "EACCES";
    if (/read-?only/i.test(msg)) return "EROFS";
    if (/not found|does not exist|no such|enoent/i.test(msg)) return "ENOENT";
    if (/not empty/i.test(msg)) return "ENOTEMPTY";
    if (/already exists|exists/i.test(msg)) return "EINVAL";
    if (/not a directory|is a directory|invalid/i.test(msg)) return "EINVAL";
    return "EIO";
}

/** netfsErrorMessage(): Pesan error yang selalu berupa string non-kosong. */
export function netfsErrorMessage(err: any): string {
    const msg = String(err?.message ?? err ?? "");
    return msg.trim().length > 0 ? msg : "unknown filesystem error";
}

// ==================== SPEC ALAMAT ====================

/** Hasil parsing spec alamat mount NetFS. */
export interface NetFSSpec {
    /** Alamat MQTNL node storage host (mis. "tsix_2"). */
    address: string;
    /** Port SL di node tersebut. */
    port: number;
}

/**
 * parseNetFSSpec(): Terima beberapa bentuk penulisan yang wajar:
 *
 *   "tsix_2:7777"             → { address: "tsix_2", port: 7777 }
 *   "tsix_2"                  → port default (NETFS_DEFAULT_PORT)
 *   "tsix://tsix_2:7777"      → skema dibuang
 *   "netfs://tsix_2:7777"     → skema dibuang
 *   "tsix_2:7777/docs"        → path diabaikan (mount selalu root export)
 *
 * Melempar NetFSError(EINVAL) kalau alamat/port tidak valid.
 */
export function parseNetFSSpec(spec: string): NetFSSpec {
    const raw = String(spec ?? "").trim();
    if (!raw) throw new NetFSError("EINVAL", "netfs: alamat kosong");

    // Buang skema (tsix://, netfs://, mqtnl://)
    const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    // Buang path export (kalau ada) — mount NetFS selalu dari root export SL
    const hostPart = withoutScheme.replace(/\/.*$/, "");
    if (!hostPart) throw new NetFSError("EINVAL", `netfs: alamat tidak valid: ${spec}`);

    const idx = hostPart.lastIndexOf(":");
    let address = hostPart;
    let port = NETFS_DEFAULT_PORT;

    if (idx > 0) {
        address = hostPart.slice(0, idx);
        const portStr = hostPart.slice(idx + 1);
        const parsed = Number(portStr);
        if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
            throw new NetFSError("EINVAL", `netfs: port tidak valid: ${portStr}`);
        }
        port = parsed;
    }

    if (!address || /\s/.test(address)) {
        throw new NetFSError("EINVAL", `netfs: alamat tidak valid: ${spec}`);
    }

    return { address, port };
}

/** formatNetFSSpec(): Bentuk kanonik untuk ditampilkan (`lsblk`, `df`). */
export function formatNetFSSpec(address: string, port: number): string {
    return `tsix://${address}:${port}`;
}
