import type { IVFS } from "../../vfs/IVFS";
import {
    NETFS_HEADER_SIZE,
    NETFS_MAX_CHUNK_BYTES,
    NETFS_MAX_REQUEST_BYTES,
    NETFS_OP_LIST,
    NETFS_TYPE_REQUEST,
    NETFS_VERSION,
    NETFS_WRITE_OPS,
    NetFSExportInfo,
    NetFSRequest,
    NetFSResponse,
    NetFSError,
    NetFSErrorCode,
    NetFSOp,
    blob,
    blobData,
    decodeNetFSRequest,
    isNetFSFrame,
    isNetFSOp,
    netfsErrorCodeOf,
    netfsErrorMessage,
    netfsWireHint,
    readNetFSFrameHeader,
    toNetFSBuffer,
} from "./NetFSProtocol";

/**
 * NETFS SERVER (SL — Server Listener core)
 *
 * Inti dari "Server Listener" di node storage host (SH): menerima request
 * NetFS (sudah didekode dari paket MQTNL) dan menjalankannya ke sebuah
 * filesystem lokal yang di-attach.
 *
 * Pemisahan peran (penting):
 *
 *   - `NetFSServer` (file ini) = LOGIKA. Murni, tanpa network, tanpa syscall.
 *     Bisa ditest langsung dengan RamFS/BKFS/HostVFS — dan dipakai juga oleh
 *     `netfsd` di userland dengan backend `NetFSBackend` (wrapper lib.fs).
 *   - `netfsd` (`src/mirror/sbin/netfsd.ts`) = TRANSPORT. Bungkus dengan
 *     NetSocket (MQTNL) supaya pesan-pesannya nyampe ke node lain.
 *
 * Jadi alur di SH: MQTNL → NetSocket.onData → `server.handle()` → NetSocket.reply.
 *
 * Keamanan (berlapis, tidak saling menggantikan):
 *   1. Identitas proses netfsd (uid/gid) di node SH → SATPAM menegakkan hak
 *      akses remote = hak user itu (efek "root squash" NFS, gratis).
 *   2. `readOnly` di sini → pagar kedua: walau klien minta tulis, ditolak EROFS.
 *   3. `allow` → filter daftar alamat MQTNL klien yang boleh bicara.
 *   4. `key` di `netfsd` (NetSocket.upgradeSecurity) → enkripsi di transport.
 *
 * (c) 2026 TSIX Project
 */

/** Logger minimal — supaya file ini tidak mengikat ke implementasi Logger mana pun. */
export interface NetFSLogger {
    info?(message: string): void;
    warn?(message: string): void;
    error?(message: string): void;
}

export interface NetFSServerOptions {
    /**
     * Prefix path di backend lokal. Semua path dari klien relatif terhadap
     * prefix ini, jadi klien TIDAK pernah melihat struktur direktori host.
     *
     * Contoh: `prefix: "/mnt/shared"` → klien minta "/docs/a.txt",
     * backend dipanggil dengan "/mnt/shared/docs/a.txt".
     */
    prefix?: string;
    /** Paksa read-only: semua op tulis ditolak `EROFS` (dipaksa di sisi SH). */
    readOnly?: boolean;
    /** Label export yang muncul di op `info` (mis. "shared", "systembak"). */
    label?: string;
    /**
     * Daftar alamat MQTNL klien yang diizinkan (mis. `["tsix_2", "tsix"]`).
     * Kosong/undefined = semua klien boleh (border default: transport + uid).
     */
    allow?: string[];
    /** Logger opsional (netfsd mengisi ini dengan Logger-nya). */
    logger?: NetFSLogger;
}

/**
 * normalizePath(): Rapikan path gaya POSIX tanpa menyentuh filesystem.
 * `..` dikolaps di sini (bukan ditolak) supaya hasil gabungan dengan prefix
 * tidak mungkin keluar dari prefix — sama semangatnya dengan HostVFS.toHostPath.
 */
export function normalizeNetFSPath(p: string): string {
    const parts: string[] = [];
    for (const seg of String(p ?? "").split("/")) {
        if (seg === "" || seg === ".") continue;
        if (seg === "..") {
            if (parts.length > 0) parts.pop();
            continue;
        }
        parts.push(seg);
    }
    return "/" + parts.join("/");
}

export class NetFSServer {
    private readonly backend: IVFS;
    private readonly prefix: string;
    private readonly readOnly: boolean;
    private readonly label: string;
    private readonly allow: string[];
    private readonly logger?: NetFSLogger;
    private readonly attachedAt: number = Date.now();

    private served = 0;
    private failed = 0;

    constructor(backend: IVFS, opts: NetFSServerOptions = {}) {
        if (!backend) throw new Error("NetFSServer: backend (IVFS) wajib diisi");
        this.backend = backend;
        this.prefix = normalizeNetFSPath(opts.prefix ?? "/");
        this.readOnly = opts.readOnly === true;
        this.label = opts.label ?? this.prefix;
        this.allow = (opts.allow ?? []).map((a) => String(a).trim()).filter(Boolean);
        this.logger = opts.logger;
    }

    /** info(): metadata export — dipakai op `info` dan `netfs info`. */
    public get info(): NetFSExportInfo {
        return {
            v: NETFS_VERSION,
            label: this.label,
            prefix: this.prefix,
            readOnly: this.readOnly,
            ops: NETFS_OP_LIST,
            attachedAt: this.attachedAt,
        };
    }

    /** stats(): hitungan request yang dilayani (diagnostik netfsd). */
    public get stats(): { served: number; failed: number; prefix: string } {
        return { served: this.served, failed: this.failed, prefix: this.prefix };
    }

    /**
     * handle(): Entry point SL.
     *
     * @param raw  Payload mentah dari NetSocket (`pkt.data`) — frame BINER NetFS
     *             v2 (transport Binfeo). Bentuknya bisa Buffer (kernel, atau saat
     *             ada session key), Uint8Array (lewat IPC userland), atau string
     *             (Binfeo tanpa key yang isinya kebetulan valid UTF-8) —
     *             `toNetFSBuffer()` menormalkan semuanya jadi Buffer.
     * @param ctx  Konteks transport (siapa pengirimnya), dipakai filter `allow`.
     * @returns    Balasan siap di-encode via `encodeNetFSResponse()`.
     */
    public async handle(raw: any, ctx: { src?: string } = {}): Promise<NetFSResponse> {
        const frame = toNetFSBuffer(raw);
        if (!frame || frame.length < NETFS_HEADER_SIZE) {
            this.failed++;
            return this.err(0, "EBADREQ", netfsWireHint(raw));
        }

        // Header diperiksa SEBELUM apa pun supaya payload sampah tidak di-decode,
        // dan supaya `id` bisa dikutip balik walau request-nya ditolak.
        if (!isNetFSFrame(frame)) {
            this.failed++;
            return this.err(0, "EBADREQ", netfsWireHint(frame));
        }
        const header = readNetFSFrameHeader(frame)!;
        if (header.type !== NETFS_TYPE_REQUEST) {
            this.failed++;
            return this.err(header.id, "EBADREQ", "netfs: frame bukan REQUEST");
        }

        // --- Pagar ukuran frame (byte mentah) ---
        if (frame.length > NETFS_MAX_REQUEST_BYTES) {
            this.failed++;
            return this.err(
                header.id,
                "ETOOBIG",
                `request ${frame.length} byte melebihi batas ${NETFS_MAX_REQUEST_BYTES}`,
            );
        }

        let req: NetFSRequest;
        try {
            req = decodeNetFSRequest(frame);
        } catch (e: any) {
            this.failed++;
            return this.err(header.id, netfsErrorCodeOf(e), netfsErrorMessage(e));
        }

        const id = req.id;
        if (!isNetFSOp(req.op)) {
            this.failed++;
            return this.err(id, "EBADOP", `op tidak dikenal: ${String(req.op)}`);
        }
        const op = req.op;

        // --- Filter client (kalau daftar allow diisi) ---
        if (this.allow.length > 0 && ctx.src && !this.allow.includes(ctx.src)) {
            this.failed++;
            this.logger?.warn?.(`[netfs] tolak ${op} dari ${ctx.src}: tidak ada di daftar allow`);
            return this.err(id, "EACCES", `client ${ctx.src} tidak diizinkan`);
        }

        // --- Pagar read-only (dipaksa di SH, bukan percaya klien) ---
        if (this.readOnly && NETFS_WRITE_OPS.includes(op)) {
            this.failed++;
            return this.err(id, "EROFS", `${op}: export read-only`);
        }

        try {
            if (op === "info") {
                this.served++;
                return {
                    v: NETFS_VERSION,
                    id,
                    ok: true,
                    result: this.info,
                };
            }

            const path = this.resolvePath(req.path ?? "/");
            const args = Array.isArray(req.args) ? req.args : [];

            // Konten besar: paksa klien pakai chunk API (biar RAM klien & SL aman)
            if (op === "readChunk") {
                const length = Number(args[1] ?? 0);
                if (!Number.isFinite(length) || length < 0 || length > NETFS_MAX_CHUNK_BYTES) {
                    this.failed++;
                    return this.err(
                        id,
                        "ETOOBIG",
                        `readChunk length=${args[1]} di luar rentang 0..${NETFS_MAX_CHUNK_BYTES}`,
                        path,
                    );
                }
            }
            if (op === "writeChunk") {
                const chunk = blobData(args[0]) ?? "";
                if (chunk.length > NETFS_MAX_CHUNK_BYTES) {
                    this.failed++;
                    return this.err(
                        id,
                        "ETOOBIG",
                        `writeChunk ${chunk.length} byte melebihi ${NETFS_MAX_CHUNK_BYTES}`,
                        path,
                    );
                }
            }

            const result = await this.exec(op, path, args);
            this.served++;
            return { v: NETFS_VERSION, id, ok: true, result };
        } catch (e: any) {
            this.failed++;
            const code: NetFSErrorCode = netfsErrorCodeOf(e);
            const message = netfsErrorMessage(e);
            this.logger?.warn?.(`[netfs] ${op} gagal (${code}): ${message}`);
            return this.err(id, code, message, req.path);
        }
    }

    /**
     * resolvePath(): Ubah path kiriman klien jadi path backend lokal.
     * Klien selalu bicara relatif terhadap root export (`/`), prefix dipasang
     * di sini — jadi klien tidak bisa menyebut path di luar export.
     */
    public resolvePath(clientPath: string): string {
        const rel = normalizeNetFSPath(clientPath);
        if (this.prefix === "/") return rel;
        return rel === "/" ? this.prefix : this.prefix + rel;
    }

    /** exec(): Eksekusi satu op ke backend (1:1 dengan method IVFS). */
    private async exec(op: NetFSOp, path: string, args: any[]): Promise<any> {
        const b = this.backend;
        switch (op) {
            case "ls":
                return await b.ls(path);
            case "mkdir":
                return await b.mkdir(
                    path,
                    this.numOrUndef(args[0]),
                    this.numOrUndef(args[1]),
                    this.numOrUndef(args[2]),
                );
            case "read":
                return blob(await b.read(path));
            case "touch":
                // Args: [content, uid, gid, mode]
                return await b.touch(
                    path,
                    blobData(args[0]) ?? "",
                    this.numOrUndef(args[1]),
                    this.numOrUndef(args[2]),
                    this.numOrUndef(args[3]),
                );
            case "stat":
                return await b.stat(path);
            case "chmod":
                return await b.chmod(path, Number(args[0]));
            case "chown":
                return await b.chown(path, Number(args[0]), Number(args[1]));
            case "unlink":
                return await b.unlink(path);
            case "rmdir":
                return await b.rmdir(path);
            case "exists":
                // Type opsional — string enum (VNodeType), dikirim sebagai T_STR.
                return await (b.exists as any)(path, args[0] ?? undefined);
            case "append":
                return await b.append(path, blobData(args[0]) ?? "");
            case "getUsage":
                return await b.getUsage();
            case "readChunk":
                return blob(await b.readChunk(path, Number(args[0] ?? 0), Number(args[1] ?? 0)));
            case "writeChunk":
                return await b.writeChunk(path, blobData(args[0]) ?? "", Number(args[1] ?? 0));
            case "getSize":
                return await b.getSize(path);
            case "info":
                return this.info;
            default:
                throw new NetFSError("EBADOP", `op tidak dikenal: ${String(op)}`);
        }
    }

    private numOrUndef(value: any): number | undefined {
        return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    }

    private err(id: number, code: NetFSErrorCode, message: string, path?: string): NetFSResponse {
        return { v: NETFS_VERSION, id, ok: false, code, err: message, path };
    }
}
