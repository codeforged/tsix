/**
 * TUNNEL ENVELOPE (MQTNL-over-MQTNL)
 *
 * Amplop biner untuk membungkus paket MQTNL agar bisa dilewatkan lewat node
 * lain (relay / "vpn server") tanpa menyentuh wire protocol MQTNL itu sendiri.
 *
 * KENAPA LAPISAN TERPISAH, BUKAN FIELD BARU DI HEADER MQTNL:
 *   - Header MQTNL di-pack oleh `IMQTNLProtocol` (JSON/Binary/Binfeo) dan
 *     dibaca SEMUA node — termasuk ESP32. Menambah field di sana berarti
 *     memutus kompatibilitas wire untuk semua peer lama.
 *   - Amplop ini hanya hidup di dalam PAYLOAD, jadi node yang tidak tahu
 *     konsep tunnel tetap bisa memproses paket normal seperti biasa.
 *
 * BENTUK (little-endian, mengikuti gaya `MQTNLProtocolBinary`):
 *
 *   off  size  field
 *   0    2     magic 'T' 'N'
 *   2    1     version (1)
 *   3    1     kind    (0 = DATA, 1 = NACK)
 *   4    1     hops    (dinaikkan tiap relay; anti-loop)
 *   5    1     flag    (PacketFlags ASLI — supaya ping/broadcast tetap hidup)
 *   6    1     proto   (0 = JSON, 1 = Binary, 2 = Binfeo → framing payload)
 *   7    1     srcLen
 *   8    n     srcAddress   (identitas asli pengirim)
 *   ..   2     srcPort      (port aplikasi pengirim)
 *   ..   1     dstLen
 *   ..   n     dstAddress   (nama node tujuan; "*" = broadcast)
 *   ..   2     dstPort      (port service tujuan)
 *   ..   *     payload
 *
 * Overhead tetap = 12 byte + panjang alamat. Port disimpan sebagai
 * pembeda-per-aplikasi (bukan TCP port), semantiknya sama dengan `srcPort`/
 * `dstPort` di header MQTNL.
 *
 * (c) 2026 TSIX Project
 */

/** Byte pertama amplop ('T'). */
export const TUNNEL_MAGIC_0 = 0x54;
/** Byte kedua amplop ('N'). */
export const TUNNEL_MAGIC_1 = 0x4e;
/** Versi format amplop. */
export const TUNNEL_VERSION = 1;
/** Panjang header tetap (tanpa alamat & payload). */
export const TUNNEL_FIXED_HEADER = 8;
/** Panjang minimum amplop valid (alamat kosong + payload kosong). */
export const TUNNEL_MIN_LENGTH = TUNNEL_FIXED_HEADER + 2 + 1 + 2;

/** Jenis frame. */
export enum TunnelKind {
  DATA = 0,
  /** Relay tidak bisa meneruskan (tujuan tidak dikenal / sesi penuh). */
  NACK = 1,
  // ── Kontrol handshake (RSA → ChaCha20-Poly1305) ──
  // Tanpa PSK manual: klien meminta kunci publik relay, membangkitkan session
  // key, lalu mengirimkannya terenkripsi RSA-OAEP. Pola sama dengan tssh/tsshd.
  /** Klien → relay: "mulai handshake". */
  HS_REQ = 2,
  /** Relay → klien: `publicKeyPem::fingerprint` (plain). */
  HS_ACK = 3,
  /** Klien → relay: session key terenkripsi RSA (hex, plain). */
  HS_KEY = 4,
  /** Relay → klien: konfirmasi (plain; klien belum memasang kunci). */
  HS_OK = 5,
  /** Klien/relay: minta ulang handshake (mis. relay restart). */
  HS_RESET = 6,
}

/** True kalau frame ini bagian dari handshake, bukan data aplikasi. */
export function isTunnelControl(kind: number): boolean {
  return (
    kind === TunnelKind.HS_REQ ||
    kind === TunnelKind.HS_ACK ||
    kind === TunnelKind.HS_KEY ||
    kind === TunnelKind.HS_OK ||
    kind === TunnelKind.HS_RESET
  );
}

/** Framing payload di dalam amplop — disamakan dengan nama protocol MQTNL. */
export enum TunnelProto {
  JSON = 0,
  BINARY = 1,
  BINFEO = 2,
}

export interface TunnelFrame {
  version: number;
  kind: TunnelKind;
  /** Jumlah relay yang sudah dilewati (anti-loop). */
  hops: number;
  /** `PacketFlags` asli dari paket yang dibungkus. */
  flag: number;
  /** Framing payload yang dipakai pengirim asli. */
  proto: TunnelProto;
  srcAddress: string;
  srcPort: number;
  dstAddress: string;
  dstPort: number;
  payload: Buffer;
}

/** Nama protocol MQTNL → kode amplop (default JSON, sama seperti driver). */
export function protoNameToCode(name?: string): TunnelProto {
  switch (name) {
    case "Binary":
      return TunnelProto.BINARY;
    case "Binfeo":
      return TunnelProto.BINFEO;
    default:
      return TunnelProto.JSON;
  }
}

/** Kode amplop → nama protocol MQTNL (untuk `NetSocket({ protocol })`). */
export function protoCodeToName(code: number): "JSON" | "Binary" | "Binfeo" {
  if (code === TunnelProto.BINARY) return "Binary";
  if (code === TunnelProto.BINFEO) return "Binfeo";
  return "JSON";
}

/** True kalau buffer ini amplop tunnel (magic + versi cocok). */
export function isTunnelFrame(data: Buffer | string | null | undefined): boolean {
  if (data === null || data === undefined) return false;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
  return (
    buf.length >= TUNNEL_MIN_LENGTH &&
    buf[0] === TUNNEL_MAGIC_0 &&
    buf[1] === TUNNEL_MAGIC_1 &&
    buf[2] === TUNNEL_VERSION
  );
}

/** Batasi port ke rentang u16 (nilai aneh dari userland tidak merusak frame). */
function clampPort(port: number): number {
  const n = Number.isFinite(port) ? Math.trunc(port) : 0;
  if (n < 0) return 0;
  if (n > 0xffff) return 0xffff;
  return n;
}

/**
 * encodeTunnelFrame(): Objek frame → Buffer amplop.
 * Melempar error kalau alamat > 255 byte (batas 1 byte panjang) — lebih baik
 * gagal keras daripada mengirim frame yang tidak bisa di-decode peer.
 */
export function encodeTunnelFrame(frame: TunnelFrame): Buffer {
  const src = Buffer.from(frame.srcAddress ?? "", "utf8");
  const dst = Buffer.from(frame.dstAddress ?? "", "utf8");
  if (src.length > 255) {
    throw new Error(`TunnelEnvelope: srcAddress terlalu panjang (${src.length} > 255 byte)`);
  }
  if (dst.length > 255) {
    throw new Error(`TunnelEnvelope: dstAddress terlalu panjang (${dst.length} > 255 byte)`);
  }

  const payload = Buffer.isBuffer(frame.payload)
    ? frame.payload
    : Buffer.from(frame.payload ?? "", "utf8");

  const total =
    TUNNEL_FIXED_HEADER + src.length + 2 + 1 + dst.length + 2 + payload.length;
  const buf = Buffer.alloc(total);

  let off = 0;
  buf.writeUInt8(TUNNEL_MAGIC_0, off++);
  buf.writeUInt8(TUNNEL_MAGIC_1, off++);
  buf.writeUInt8(TUNNEL_VERSION, off++);
  buf.writeUInt8(frame.kind ?? TunnelKind.DATA, off++);
  buf.writeUInt8(Math.min(frame.hops ?? 0, 0xff), off++);
  buf.writeUInt8((frame.flag ?? 0) & 0xff, off++);
  buf.writeUInt8(frame.proto ?? TunnelProto.JSON, off++);
  buf.writeUInt8(src.length, off++);
  src.copy(buf, off);
  off += src.length;
  buf.writeUInt16LE(clampPort(frame.srcPort), off);
  off += 2;
  buf.writeUInt8(dst.length, off++);
  dst.copy(buf, off);
  off += dst.length;
  buf.writeUInt16LE(clampPort(frame.dstPort), off);
  off += 2;
  payload.copy(buf, off);

  return buf;
}

/**
 * decodeTunnelFrame(): Buffer amplop → objek frame (atau `null` kalau rusak).
 * Semua pembacaan dibatasi panjang buffer; frame cacat TIDAK boleh melempar
 * exception ke pemanggil (jalur RX harus tahan paket sampah dari broker).
 */
export function decodeTunnelFrame(data: Buffer | string | null | undefined): TunnelFrame | null {
  if (!isTunnelFrame(data)) return null;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");

  let off = TUNNEL_FIXED_HEADER; // magic+ver+kind+hops+flag+proto+srcLen
  const kind = buf[3] as TunnelKind;
  const hops = buf[4];
  const flag = buf[5];
  const proto = buf[6] as TunnelProto;
  const srcLen = buf[7];

  if (off + srcLen + 2 + 1 > buf.length) return null;
  const srcAddress = buf.subarray(off, off + srcLen).toString("utf8");
  off += srcLen;
  const srcPort = buf.readUInt16LE(off);
  off += 2;

  const dstLen = buf[off];
  off += 1;
  if (off + dstLen + 2 > buf.length) return null;
  const dstAddress = buf.subarray(off, off + dstLen).toString("utf8");
  off += dstLen;
  const dstPort = buf.readUInt16LE(off);
  off += 2;

  return {
    version: buf[2],
    kind,
    hops,
    flag,
    proto,
    srcAddress,
    srcPort,
    dstAddress,
    dstPort,
    payload: buf.subarray(off),
  };
}

/**
 * bumpTunnelFrame(): Salinan frame dengan `hops + 1` (dipakai relay sebelum
 * meneruskan). Payload TIDAK disentuh — relay tidak perlu tahu isinya.
 */
export function bumpTunnelFrame(frame: TunnelFrame): TunnelFrame {
  return { ...frame, hops: Math.min((frame.hops ?? 0) + 1, 0xff) };
}
