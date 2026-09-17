import type { IVFS } from "../../vfs/IVFS";
import {
  NETFS_MAX_CHUNK_BYTES,
  NETFS_MAX_REQUEST_CHARS,
  NETFS_OP_LIST,
  NETFS_VERSION,
  NETFS_WRITE_OPS,
  NetFSExportInfo,
  NetFSRequest,
  NetFSResponse,
  NetFSError,
  NetFSErrorCode,
  NetFSOp,
  decodeContent,
  encodeContent,
  isNetFSOp,
  netfsErrorCodeOf,
  netfsErrorMessage,
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
   * @param raw  Payload mentah dari NetSocket (`pkt.data`) — string JSON atau
   *             object yang sudah diparse.
   * @param ctx  Konteks transport (siapa pengirimnya), dipakai filter `allow`.
   * @returns    Balasan siap dikirim balik via `NetSocket.reply()`.
   */
  public async handle(
    raw: any,
    ctx: { src?: string } = {},
  ): Promise<NetFSResponse> {
    let req: NetFSRequest;
    try {
      req = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (e) {
      this.failed++;
      return this.err(0, "EBADREQ", "payload bukan JSON valid");
    }

    const id = typeof req?.id === "number" ? req.id : 0;

    if (!req || typeof req !== "object") {
      this.failed++;
      return this.err(id, "EBADREQ", "request kosong");
    }
    if (!isNetFSOp(req.op)) {
      this.failed++;
      return this.err(id, "EBADOP", `op tidak dikenal: ${String(req.op)}`);
    }
    const op = req.op;

    // --- Filter client (kalau daftar allow diisi) ---
    if (this.allow.length > 0 && ctx.src && !this.allow.includes(ctx.src)) {
      this.failed++;
      this.logger?.warn?.(
        `[netfs] tolak ${op} dari ${ctx.src}: tidak ada di daftar allow`,
      );
      return this.err(id, "EACCES", `client ${ctx.src} tidak diizinkan`);
    }

    // --- Pagar read-only (dipaksa di SH, bukan percaya klien) ---
    if (this.readOnly && NETFS_WRITE_OPS.includes(op)) {
      this.failed++;
      return this.err(id, "EROFS", `${op}: export read-only`);
    }

    // --- Pagar ukuran request (konten besar harus lewat writeChunk) ---
    if (typeof raw === "string" && raw.length > NETFS_MAX_REQUEST_CHARS) {
      this.failed++;
      return this.err(
        id,
        "ETOOBIG",
        `request ${raw.length} char melebihi batas ${NETFS_MAX_REQUEST_CHARS}`,
      );
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
        const chunk = decodeContent(args[0]) ?? "";
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
        return this.encode(await b.read(path));
      case "touch":
        // Args: [content, uid, gid, mode]
        return await b.touch(
          path,
          decodeContent(args[0]) ?? "",
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
        // Type opsional (VNodeType adalah string enum, jadi aman lewat JSON).
        return await (b.exists as any)(path, args[0] ?? undefined);
      case "append":
        return await b.append(path, decodeContent(args[0]) ?? "");
      case "getUsage":
        return await b.getUsage();
      case "readChunk":
        return this.encode(
          await b.readChunk(path, Number(args[0] ?? 0), Number(args[1] ?? 0)),
        );
      case "writeChunk":
        return await b.writeChunk(
          path,
          decodeContent(args[0]) ?? "",
          Number(args[1] ?? 0),
        );
      case "getSize":
        return await b.getSize(path);
      case "info":
        return this.info;
      default:
        throw new NetFSError("EBADOP", `op tidak dikenal: ${String(op)}`);
    }
  }

  /** encode(): Bungkus konten pakai codec protocol (base64). */
  private encode(content: string | null | undefined): any {
    return encodeContent(content);
  }

  private numOrUndef(value: any): number | undefined {
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  }

  private err(
    id: number,
    code: NetFSErrorCode,
    message: string,
    path?: string,
  ): NetFSResponse {
    return { v: NETFS_VERSION, id, ok: false, code, err: message, path };
  }
}
