/**
 * NETFS PROTOCOL (NetFS v1) — Wire protocol filesystem-over-MQTNL
 *
 * Satu request = satu paket MQTNL, satu balasan = satu paket. Berisi
 * definisi op, amplop (envelope) request/response, codec konten biner, dan
 * util parsing spec alamat (`tsix_2:7777`).
 *
 * File ini SENGAJA dependency-free (tidak impor apa pun dari kernel/vfs)
 * karena dipakai oleh DUA dunia:
 *
 *   - KERNEL  : `src/vfs/NetFS.ts` (driver klien, `mount --netfs ...`)
 *   - USERLAND: `src/mirror/sbin/netfsd.ts` (SL / server listener) dan
 *               `src/mirror/bin/netfs.ts` (probe/info CLI) via NetSocket
 *
 * Analogi: ini "NFS protocol" versi TSIX. Transport-nya MQTNL, jadi TIDAK
 * butuh IP publik / sewa VPS — cukup reach-ability lewat broker yang sama.
 *
 * (c) 2026 TSIX Project
 */

/** Versi wire protocol — naikkan kalau ada perubahan yang tidak kompatibel. */
export const NETFS_VERSION = 1;

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
 * Batas ukuran payload request (karakter). MQTNL sudah punya fragmentasi &
 * reassembly, tapi request netfs tidak perlu besar: konten besar dikirim
 * per-chunk (`readChunk`/`writeChunk`), bukan sekali kirim.
 */
export const NETFS_MAX_REQUEST_CHARS = 96 * 1024;

/** Ukuran maksimum satu potongan konten (`readChunk`/`writeChunk`), byte. */
export const NETFS_MAX_CHUNK_BYTES = 32 * 1024;

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

// ==================== AMPLOP ====================

/** Request dari klien (kernel `NetFS` driver) ke SL (`netfsd`). */
export interface NetFSRequest {
  /** Versi protocol (opsional, untuk kompatibilitas maju). */
  v?: number;
  /** Nomor urut request — dipakai klien mencocokkan balasan. */
  id: number;
  /** Operasi yang diminta. */
  op: NetFSOp;
  /** Path relatif terhadap root export SL (mis. "/docs/a.txt"). */
  path?: string;
  /** Argumen tambahan per-op (konten sudah di-encode via encodeContent). */
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
 */export class NetFSError extends Error {
  public readonly code: NetFSErrorCode;
  public readonly op?: string;

  constructor(code: NetFSErrorCode, message: string, op?: string) {
    super(message);
    this.name = "NetFSError";
    this.code = code;
    this.op = op;
  }
}

// ==================== CODEC KONTEN ====================

/**
 * encodeContent(): Bungkus konten string (latin1/binary-safe) menjadi objek
 * base64 agar selamat lewat JSON MQTNL.
 *
 * Encoding string internal TSIX = "binary"/latin1 (lihat BKFS/HostVFS), jadi
 * base64 dihitung dari byte latin1 supaya round-trip 100% identik.
 */
export function encodeContent(content: string | null | undefined): any {
  if (content === null || content === undefined) return null;
  if (typeof content !== "string") return null;
  return {
    enc: "base64",
    size: content.length,
    data: Buffer.from(content, "latin1").toString("base64"),
  };
}

/** decodeContent(): Kebalikan `encodeContent` — terima string polos juga. */
export function decodeContent(payload: any): string | null {
  if (payload === null || payload === undefined) return null;
  if (typeof payload === "string") return payload;
  if (typeof payload === "object" && typeof payload.data === "string") {
    if (payload.enc && payload.enc !== "base64") return null;
    return Buffer.from(payload.data, "base64").toString("latin1");
  }
  return null;
}

// ==================== DECODER PAYLOAD ====================

/**
 * parseNetFSPayload(): Decode payload mentah dari MQTNL menjadi objek pesan.
 *
 * KENAPA INI PENTING (jangan diganti jadi `JSON.parse` polos):
 * driver MQTNL memilih framing berdasarkan protocol per-port, dan penerima
 * TIDAK mengontrol protocol yang dipakai pengirim. Untuk port yang di-pin
 * "JSON" payload tiba sebagai **string**; tapi untuk port yang jatuh ke
 * framing biner (Binfeo/Binary — mis. port yang belum di-pin, atau ada
 * trafik biner lain di node yang sama) payload tiba sebagai **Buffer**
 * (lebih-lebih kalau port punya session key → hasil dekripsi =
 * `Buffer.securePacketInRawBuffer`).
 *
 * Pola lama `typeof raw === "string" ? JSON.parse(raw) : raw` membuat Buffer
 * dianggap "sudah diparse" → `req.id`/`res.id` undefined → request DIBUANG
 * DIAM-DIAM (mount tampak hang sampai timeout, tanpa error apa pun di log).
 * Karena itu semua titik masuk NetFS memakai helper ini.
 *
 * Menerima: string JSON, Buffer (utf8 JSON), objek `{type:"Buffer",data:[]}`,
 * dan objek yang sudah diparse. Return null kalau tidak bisa di-decoded.
 */
export function parseNetFSPayload(raw: any): any | null {
  if (raw === null || raw === undefined) return null;

  // Buffer langsung (framing biner Binfeo/Binary) — kasus yang dulu hilang.
  if (Buffer.isBuffer(raw)) {
    try {
      return JSON.parse(raw.toString("utf8"));
    } catch (e) {
      return null;
    }
  }

  // String JSON (framing JSON v1.0) atau payload kosong.
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  // Artefak serialisasi IPC: { type: "Buffer", data: [..] } atau { "0": .. }
  if (typeof raw === "object") {
    if (raw.type === "Buffer" && Array.isArray(raw.data)) {
      try {
        return JSON.parse(Buffer.from(raw.data).toString("utf8"));
      } catch (e) {
        return null;
      }
    }
    if (typeof raw[0] === "number" && !Array.isArray(raw)) {
      try {
        return JSON.parse(Buffer.from(Object.values(raw) as number[]).toString("utf8"));
      } catch (e) {
        return null;
      }
    }
    return raw; // sudah objek (diparse pemanggil / IPC)
  }

  return null;
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
