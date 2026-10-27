import { KContext } from "./IDevice";
import { PacketFlags } from "../../common/PacketFlags";
import { SecurityAgent } from "../../common/SecurityAgent";
import { SimpleMQTNLDriver } from "./SimpleMQTNLDriver";
import {
  TunnelFrame,
  TunnelKind,
  TunnelProto,
  TUNNEL_VERSION,
  decodeTunnelFrame,
  encodeTunnelFrame,
  isTunnelControl,
  protoNameToCode,
} from "../../common/protocols/TunnelEnvelope";

/**
 * SIMPLE MQTNL DRIVER â€” TUNNEL VARIANT (`/dev/smqtnltun0`)
 *
 * Device jaringan yang **menyerupai** `/dev/smqtnl0` dari sudut pandang
 * aplikasi, tetapi paket yang keluar tidak langsung menuju tujuan: paket
 * dibungkus **amplop tunnel** (`TunnelEnvelope`) lalu dikirim ke node relay
 * (`vpns`) yang berada di broker lain. Relay itu yang meneruskan ke tujuan
 * sesungguhnya.
 *
 * KENAPA DEVICE, BUKAN DAEMON USERLAND:
 *   - Aplikasi tidak perlu diubah. Cukup arahkan interface default ke device
 *     ini (`ifconfig smqtnltun0`), semua `sendTo()` otomatis lewat tunnel.
 *   - Balasan bisa diserahkan kembali ke aplikasi dengan **identitas asli**
 *     pengirim (`deliverLocal`) â€” sesuatu yang tidak mungkin dilakukan daemon
 *     biasa karena `send()` selalu menimpa `srcAddress` dengan alamat lokal.
 *   - Fragmentasi, reassembly, enkripsi per-port, loopback, dan statistik
 *     diwarisi dari `SimpleMQTNLDriver` â€” tidak ada yang ditulis ulang.
 *
 * MODEL ROUTING (default route, mirip `ssh -D` / subnet router, BUKAN WARP):
 *
 *   1. tujuan == alamat lokal / node di proses ini â†’ loopback (tanpa tunnel)
 *   2. tujuan ada di `exclude`                     â†’ langsung ke broker lokal
 *   3. selain itu (termasuk "*" broadcast)         â†’ lewat tunnel
 *
 * Jadi relay TIDAK perlu daftar node: alamat tujuan dibawa di amplop, dan
 * broker tujuan yang melakukan routing (MQTT = topic per alamat). Node baru di
 * broker seberang langsung terjangkau tanpa konfigurasi tambahan.
 *
 * (c) 2026 TSIX Project
 */

/** Port tunnel bawaan (harus sama dengan `vpns --listen`). */
export const DEFAULT_TUNNEL_PORT = 9360;

/** Batas amplop yang ditahan selama handshake (anti-memory-leak). */
const MAX_PENDING = 64;
/** Batas percobaan handshake sebelum menyerah & melapor. */
const MAX_HS_ATTEMPTS = 12;
/** Jeda antar percobaan handshake (ms). */
const HS_RETRY_MS = 2000;

/** Spesifikasi interface tunnel (dipetakan dari `[tunnel.*]` di sysconfig.conf). */
export interface TunnelIfaceSpec {
  /** Nama device, mis. "smqtnltun0". */
  deviceName: string;
  /** Broker yang dipakai (broker LOKAL â€” keluar lewat forwarder). */
  broker: string;
  /** Alamat node untuk device ini (harus UNIK dalam satu proses). */
  address: string;
  /** Alamat relay: "node" atau "node:port" (mis. "tsixz-vpn:9360"). */
  peer: string;
  /** Port tunnel di relay (default {@link DEFAULT_TUNNEL_PORT}). */
  port?: number;
  /** PSK ChaCha20-Poly1305 (hex 64 karakter). Kosong = handshake RSA (disarankan). */
  psk?: string;
  /**
   * Aktifkan handshake RSA â†’ ChaCha20 otomatis (default: aktif bila `psk` kosong).
   * Dengan ini TIDAK perlu menulis secret yang sama di kedua sisi; cukup
   * percayai fingerprint relay (lihat `trustedFingerprint`).
   */
  handshake?: boolean;
  /**
   * Port KONTROL relay untuk handshake (default: `port + 1`).
   *
   * Kenapa terpisah: driver MQTNL hanya menyimpan SATU session key per port,
   * sedangkan relay harus melayani banyak klien sekaligus. Port kontrol tanpa
   * kunci â†’ frame handshake lewat plaintext (isinya memang sudah aman: public
   * key + kunci sesi terenkripsi RSA), sementara port data memakai kunci sesi
   * bersama yang dibagikan relay.
   */
  controlPort?: number;
  /** Fingerprint SHA-256 relay yang dipercaya (16 karakter). Kosong = terima + catat. */
  trustedFingerprint?: string;
  /**
   * Handshake ulang tiap N detik (0 = hanya saat start).
   * Berguna kalau relay restart (kunci sesinya berubah): klien akan mengambil
   * kunci baru tanpa perlu reboot.
   */
  rekey?: number;
  /** Nama agent enkripsi (default "chacha20"). */
  agent?: string;
  /** Alamat yang TIDAK lewat tunnel (mis. node lain di broker lokal). */
  exclude?: string[];
  /** Batas hop amplop â€” anti-loop. Default 3. */
  maxHops?: number;
}

/** Mode keamanan tunnel. */
export type TunnelSecurityMode = "psk" | "handshake" | "plain";

interface TunnelStats {
  tunneled: number;
  direct: number;
  loopback: number;
  bytesTunneled: number;
  rx: number;
  delivered: number;
  dropped: number;
  droppedHops: number;
  nack: number;
  queued: number;
  hsRequests: number;
  hsOk: number;
  hsFail: number;
}

/**
 * toPayloadBuffer(): Normalisasi payload userland â†’ Buffer untuk amplop.
 *
 * Sengaja menerima bentuk "aneh" yang biasa muncul di userland TSIX
 * (Buffer terdekomposisi jadi POJO saat melewati IPC, Uint8Array, objek biasa)
 * supaya perilakunya sejalan dengan `send()` di base class.
 */
function toPayloadBuffer(data: any): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data === null || data === undefined) return Buffer.alloc(0);
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (typeof data === "object") {
    if ((data as any).type === "Buffer" && Array.isArray((data as any).data)) {
      return Buffer.from((data as any).data);
    }
    const values = Object.values(data);
    if (values.length > 0 && values.every((v) => typeof v === "number")) {
      return Buffer.from(values as number[]);
    }
    return Buffer.from(JSON.stringify(data), "utf8");
  }
  return Buffer.from(String(data), "utf8");
}

/** parsePeer(): "node" / "node:port" â†’ { address, port }. */
export function parseTunnelPeer(
  peer: string,
  fallbackPort: number = DEFAULT_TUNNEL_PORT,
): { address: string; port: number } {
  const raw = String(peer ?? "").trim();
  const idx = raw.lastIndexOf(":");
  if (idx > 0) {
    const addr = raw.slice(0, idx).trim();
    const port = parseInt(raw.slice(idx + 1), 10);
    if (addr && Number.isFinite(port) && port > 0) {
      return { address: addr, port };
    }
  }
  return { address: raw, port: fallbackPort };
}

export class SimpleMQTNLDriverTunnel extends SimpleMQTNLDriver {
  private readonly peerAddress: string;
  private readonly tunnelPort: number;
  private readonly controlPort: number;
  private readonly psk: string | undefined;
  private readonly agentName: string;
  private readonly maxHops: number;
  private readonly excluded: Set<string>;
  private readonly secMode: TunnelSecurityMode;
  private readonly trustedFingerprint?: string;
  private readonly rekeySec: number;

  /** True setelah kunci sesi terpasang (PSK langsung, atau handshake selesai). */
  private ready = false;
  private sessionKeyHex: string | null = null;
  private relayFingerprint: string | null = null;
  /** Keypair RSA sementara milik klien (hanya selama handshake). */
  private clientKeyPair: { publicKey: string; privateKey: string } | null = null;
  private hsAttempts = 0;
  private hsTimer: ReturnType<typeof setTimeout> | null = null;
  private rekeyTimer: ReturnType<typeof setInterval> | null = null;
  /** Amplop yang menunggu handshake selesai (terbatas, anti-memory-leak). */
  private readonly pending: Buffer[] = [];

  private readonly tunnelStats: TunnelStats = {
    tunneled: 0,
    direct: 0,
    loopback: 0,
    bytesTunneled: 0,
    rx: 0,
    delivered: 0,
    dropped: 0,
    droppedHops: 0,
    nack: 0,
    queued: 0,
    hsRequests: 0,
    hsOk: 0,
    hsFail: 0,
  };

  constructor(spec: TunnelIfaceSpec) {
    super(spec.deviceName, spec.broker, spec.address);

    const peer = parseTunnelPeer(spec.peer, spec.port ?? DEFAULT_TUNNEL_PORT);
    this.peerAddress = peer.address;
    this.tunnelPort = spec.port ?? peer.port;
    this.controlPort =
      spec.controlPort && spec.controlPort > 0
        ? spec.controlPort
        : this.tunnelPort + 1;
    this.psk = spec.psk && spec.psk.trim() !== "" ? spec.psk.trim() : undefined;
    this.agentName = spec.agent ?? "chacha20";
    this.maxHops = spec.maxHops && spec.maxHops > 0 ? spec.maxHops : 3;
    this.excluded = new Set(
      (spec.exclude ?? []).map((s) => String(s).trim()).filter((s) => s !== ""),
    );
    this.trustedFingerprint = spec.trustedFingerprint
      ?.replace(/^SHA256:/i, "")
      .toUpperCase();
    this.rekeySec = spec.rekey && spec.rekey > 0 ? spec.rekey : 0;

    if (!this.peerAddress) {
      throw new Error(
        `SimpleMQTNLDriverTunnel(${spec.deviceName}): 'peer' wajib diisi (alamat node relay)`,
      );
    }

    // Tentukan mode keamanan:
    //   psk        â†’ kunci statis (tahan restart relay, tanpa handshake)
    //   handshake  â†’ RSA + ChaCha (DEFAULT; tidak perlu secret di dua sisi)
    //   plain      â†’ hanya bila diminta eksplisit (handshake: false)
    if (this.psk) {
      this.secMode = "psk";
    } else if (spec.handshake === false) {
      this.secMode = "plain";
    } else {
      this.secMode = "handshake";
    }

    // Konfigurasi dipasang di KONSTRUKTOR (bukan init()) supaya device sudah
    // konsisten sejak lahir: `init()` hanya menyambung MQTT. Ini juga membuat
    // device bisa diuji tanpa broker.
    //
    // Port tunnel dipin Binfeo: Binfeo = biner, jadi seluruh amplop (header +
    // payload) utuh sampai relay, tanpa overhead hex.
    this.ioctl(0x1002, { port: this.tunnelPort, protocol: "Binfeo" });

    // Port kontrol (handshake) juga Binfeo, tetapi TANPA kunci sesi: frame
    // handshake memang harus terbaca plaintext oleh relay.
    this.ioctl(0x1002, { port: this.controlPort, protocol: "Binfeo" });

    if (this.secMode === "psk") {
      this.ioctl(0x1001, {
        port: this.tunnelPort,
        sessionKey: this.psk,
        agent: this.agentName,
      });
      this.sessionKeyHex = this.psk!.toLowerCase();
      this.ready = true;
    } else if (this.secMode === "plain") {
      // Tanpa kunci: Binfeo mengirim byte mentah (passthrough).
      this.ready = true;
    }

    // Handler amplop masuk. `registerHandler` milik base class â†’ otomatis
    // memakai jalur RX yang sudah menangani fragmentasi + dekripsi.
    this.registerHandler(this.tunnelPort, (pkt: any) =>
      this.handleEnvelopePacket(pkt),
    );
    this.bindProcess(this.tunnelPort, "tunnel");

    // Frame kontrol (plaintext) masuk lewat port kontrol.
    if (this.secMode === "handshake") {
      this.registerHandler(this.controlPort, (pkt: any) =>
        this.handleEnvelopePacket(pkt),
      );
      this.bindProcess(this.controlPort, "tunnel-ctrl");
    }

    const modeLabel =
      this.secMode === "psk"
        ? "PSK"
        : this.secMode === "handshake"
          ? `RSA+ChaCha handshake (ctrl :${this.controlPort})`
          : "PLAIN";

    this.logger.info(
      `[TUNNEL] ${spec.deviceName} (${spec.address}) â†’ relay ${this.peerAddress}:${this.tunnelPort}` +
        ` [${modeLabel}]${this.excluded.size ? ` exclude=[${[...this.excluded].join(", ")}]` : ""}`,
    );
  }

  /** Alamat relay yang dipakai device ini. */
  public get peer(): { address: string; port: number } {
    return { address: this.peerAddress, port: this.tunnelPort };
  }

  /** Port kontrol (handshake) di relay. */
  public get ctrlPort(): number {
    return this.controlPort;
  }

  /** Alamat node device ini (mis. "wintsix-tun"). */
  public get nodeAddress(): string {
    return this.localAddress;
  }

  /** Mode keamanan yang dipakai ("psk" | "handshake" | "plain"). */
  public get securityMode(): TunnelSecurityMode {
    return this.secMode;
  }

  /** True setelah jalur aman siap (atau mode plain). */
  public get isReady(): boolean {
    return this.ready;
  }

  /** Fingerprint relay (terisi setelah handshake). */
  public get peerFingerprint(): string | null {
    return this.relayFingerprint;
  }

  public override init(ctx: KContext): void {
    super.init(ctx);

    if (this.secMode === "plain") {
      this.logger.warn(
        `[TUNNEL] ${this.name} berjalan TANPA enkripsi (handshake: false) â€” amplop dikirim plain`,
      );
      return;
    }

    if (this.secMode === "psk") {
      this.logger.info(`[TUNNEL] ${this.name} memakai PSK statis (tanpa handshake)`);
      return;
    }

    // Mode handshake: mulai setelah MQTT tersambung. `init()` tidak bisa
    // menunggu, jadi percobaan pertama dijadwalkan sedikit lebih lambat dan
    // diulang sampai relay menjawab.
    this.scheduleHandshake(500);

    if (this.rekeySec > 0) {
      this.rekeyTimer = setInterval(() => {
        this.logger.info(`[TUNNEL] rekey tiap ${this.rekeySec}s â€” handshake ulang`);
        this.beginHandshake("rekey");
      }, this.rekeySec * 1000);
    }
  }

  /** Hentikan timer handshake/rekey (dipakai saat device ditutup atau di uji). */
  public stopHandshakeTimers(): void {
    if (this.hsTimer) {
      clearTimeout(this.hsTimer);
      this.hsTimer = null;
    }
    if (this.rekeyTimer) {
      clearInterval(this.rekeyTimer);
      this.rekeyTimer = null;
    }
  }

  /** isExcluded(): true kalau alamat harus langsung (tidak lewat tunnel). */
  private isExcluded(address: string): boolean {
    return this.excluded.has(address);
  }

  /**
   * send(): titik sisip tunnel.
   *
   * Semua pengiriman userland lewat sini (kernel memanggil `socket.driver.send`).
   * Keputusan routing dilakukan di sini agar `sendTo()` aplikasi tidak berubah.
   */
  public override async send(
    address: string,
    port: number,
    data: any,
    flag: PacketFlags = PacketFlags.FLAG_DATA,
    srcPort: number = 0,
  ): Promise<boolean> {
    const dst = address === "localhost" ? this.localAddress : address;

    // 0. Pengiriman amplop internal (peer relay) â€” jangan dibungkus lagi.
    if (dst === this.peerAddress && port === this.tunnelPort) {
      return super.send(address, port, data, flag, srcPort);
    }

    // 1. Tujuan lokal (node ini atau interface lain di proses yang sama).
    //    Base class yang menangani loopback; srcAddress akan berisi alamat
    //    device ini (bukan alamat node asli) â€” konsekuensi tak terhindarkan
    //    dari satu proses memuat beberapa interface.
    if (SimpleMQTNLDriver.findLocal(dst)) {
      this.tunnelStats.loopback++;
      return super.send(address, port, data, flag, srcPort);
    }

    // 2. Alamat yang dikecualikan â†’ langsung ke broker lokal.
    if (this.isExcluded(dst)) {
      this.tunnelStats.direct++;
      return super.send(address, port, data, flag, srcPort);
    }

    // 3. Default route â†’ tunnel.
    const frame: TunnelFrame = {
      version: TUNNEL_VERSION,
      kind: TunnelKind.DATA,
      hops: 1,
      flag,
      proto: protoNameToCode(this.portProtocols.get(srcPort)),
      srcAddress: this.localAddress,
      srcPort,
      dstAddress: dst,
      dstPort: port,
      payload: toPayloadBuffer(data),
    };

    let envelope: Buffer;
    try {
      envelope = encodeTunnelFrame(frame);
    } catch (e: any) {
      this.logger.error(`[TUNNEL] encode amplop gagal: ${e.message}`);
      this.tunnelStats.dropped++;
      return false;
    }

    this.tunnelStats.tunneled++;
    this.tunnelStats.bytesTunneled += envelope.length;

    // Mode handshake: sebelum kunci siap, amplop ditahan sebentar (bukan
    // dibuang) supaya paket pertama aplikasi tidak hilang saat boot.
    if (!this.ready) {
      if (this.pending.length >= MAX_PENDING) {
        this.pending.shift();
        this.tunnelStats.dropped++;
        this.logger.warn(
          `[TUNNEL] antrian handshake penuh (${MAX_PENDING}) â€” amplop terlama dibuang`,
        );
      }
      this.pending.push(envelope);
      this.tunnelStats.queued = this.pending.length;
      this.beginHandshake("queued");
      return true;
    }

    return this.sendEnvelope(envelope);
  }

  /** Kirim amplop apa adanya ke relay (dipakai DATA maupun kontrol). */
  private async sendEnvelope(envelope: Buffer): Promise<boolean> {
    // srcPort WAJIB port tunnel (bukan port aplikasi): relay membalas ke port
    // ini, dan di sinilah kunci sesi + framing Binfeo terpasang.
    return super.send(
      this.peerAddress,
      this.tunnelPort,
      envelope,
      PacketFlags.FLAG_DATA,
      this.tunnelPort,
    );
  }

  /** Buang sisa amplop yang tertahan (mis. handshake gagal). */
  public get pendingCount(): number {
    return this.pending.length;
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // HANDSHAKE RSA â†’ ChaCha20 (pola sama dengan RsaChaSocket/tsshd)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /** Jadwalkan percobaan handshake setelah `delayMs`. */
  private scheduleHandshake(delayMs: number): void {
    if (this.secMode !== "handshake" || this.ready) return;
    if (this.hsTimer) return;

    this.hsTimer = setTimeout(() => {
      this.hsTimer = null;
      if (this.ready) return; // sudah siap — jangan kirim HS_REQ tambahan
      this.beginHandshake("retry");
    }, delayMs);
  }

  /**
   * beginHandshake(): minta kunci publik relay (frame HS_REQ).
   *
   * Sebelum mengirim, kunci sesi lama DILEPAS (`clearSessionKey`). Alasannya:
   * port kontrol di relay tidak punya kunci, jadi frame handshake harus
   * plaintext â€” dan kalau relay sempat restart (kunci sesinya berubah), klien
   * yang masih memakai kunci lama tidak akan pernah bisa membaca balasan.
   * Amplop data yang menunggu ditahan di antrian sampai handshake selesai.
   */
  public beginHandshake(reason: string = "manual"): void {
    if (this.secMode !== "handshake") return;
    if (this.hsAttempts >= MAX_HS_ATTEMPTS && !this.ready) {
      this.tunnelStats.hsFail++;
      this.logger.error(
        `[TUNNEL] handshake gagal setelah ${MAX_HS_ATTEMPTS} percobaan â€” ` +
          `periksa 'peer'/'controlPort' dan apakah vpns berjalan`,
      );
      return;
    }

    // Kunci lama dilepas supaya handshake bisa dibaca plaintext.
    if (this.sessionKeyHex) this.clearSessionKey();
    this.clientKeyPair = null;

    this.hsAttempts++;
    this.tunnelStats.hsRequests++;
    if (reason !== "rekey") {
      this.logger.info(
        `[TUNNEL] handshake #${this.hsAttempts} â†’ ${this.peerAddress}:${this.controlPort} (${reason})`,
      );
    } else {
      this.logger.info(`[TUNNEL] handshake ulang (rekey) â†’ ${this.peerAddress}:${this.controlPort}`);
    }

    void this.sendControl(TunnelKind.HS_REQ, Buffer.alloc(0)).catch((e) => {
      this.logger.warn(`[TUNNEL] gagal kirim HS_REQ: ${e?.message ?? e}`);
    });

    // Coba lagi kalau relay belum menjawab (MQTT bisa belum siap saat boot).
    if (!this.ready) {
      this.scheduleHandshake(HS_RETRY_MS);
    }
  }

  /**
   * sendControl(): kirim frame handshake ke PORT KONTROL relay.
   *
   * Port kontrol tidak punya kunci sesi di kedua sisi, jadi frame ini selalu
   * plaintext â€” aman karena isinya public key, nonce, tanda tangan, dan kunci
   * sesi yang sudah dibungkus RSA-OAEP.
   */
  private async sendControl(kind: TunnelKind, payload: Buffer): Promise<boolean> {
    const envelope = encodeTunnelFrame({
      version: TUNNEL_VERSION,
      kind,
      hops: 1,
      flag: PacketFlags.FLAG_DATA,
      proto: TunnelProto.JSON,
      srcAddress: this.localAddress,
      srcPort: this.controlPort,
      dstAddress: this.peerAddress,
      dstPort: this.controlPort,
      payload,
    });
    return super.send(
      this.peerAddress,
      this.controlPort,
      envelope,
      PacketFlags.FLAG_DATA,
      this.controlPort,
    );
  }

  /**
   * onHandshakeAck(): relay mengirim `publicKey :: fingerprint :: nonce`.
   *
   * Klien memverifikasi fingerprint (relay tidak bisa memalsukan), lalu
   * membuktikan possession kunci dengan menandatangani nonce memakai keypair
   * RSA sementara miliknya. Kunci sesi TIDAK dibuat di sini â€” relay yang
   * membangkitkannya (satu kunci untuk semua klien, karena driver hanya
   * menyimpan satu kunci per port) lalu mengirimkannya terbungkus RSA.
   */
  private async onHandshakeAck(payload: Buffer): Promise<void> {
    const [publicKey, fingerprintRaw, nonce] = payload
      .toString("utf8")
      .split("::");

    const fingerprint = (fingerprintRaw ?? "").trim().toUpperCase();
    if (!publicKey || !fingerprint || !nonce) {
      this.failHandshake("HS_ACK tidak lengkap (publicKey::fingerprint::nonce)");
      return;
    }

    // Fingerprint dihitung ulang dari public key: relay tidak bisa memalsukan
    // salah satunya tanpa ketahuan (pola sama dengan RsaChaSocket).
    const computed = SecurityAgent.getFingerprint(publicKey).toUpperCase();
    if (computed !== fingerprint) {
      this.failHandshake(
        `fingerprint tidak cocok dengan public key (hitung: ${computed}, relay: ${fingerprint})`,
      );
      return;
    }

    if (this.trustedFingerprint && this.trustedFingerprint !== fingerprint) {
      this.failHandshake(
        `fingerprint relay tidak cocok (diharapkan ${this.trustedFingerprint}, diterima ${fingerprint})`,
      );
      return;
    }

    if (!this.relayFingerprint) {
      this.relayFingerprint = fingerprint;
      const note = this.trustedFingerprint
        ? "sesuai konfigurasi"
        : "BARU â€” catat & pasang sebagai trustedFingerprint untuk mencegah MITM";
      this.logger.info(`[TUNNEL] fingerprint relay: ${fingerprint} (${note})`);
    }

    // Keypair sementara: kunci sesi dari relay dibungkus dengan public key ini,
    // jadi hanya klien ini yang bisa membukanya.
    this.clientKeyPair = SecurityAgent.generateKeyPair();
    const signature = SecurityAgent.sign(this.clientKeyPair.privateKey, nonce);

    await this.sendControl(
      TunnelKind.HS_KEY,
      Buffer.from(`${this.clientKeyPair.publicKey}::${signature}`, "utf8"),
    );
  }

  /**
   * onHandshakeOk(): relay mengirim kunci sesi (hex) yang dibungkus RSA-OAEP.
   * Setelah dibuka & dipasang, jalur data siap dipakai.
   */
  private async onHandshakeOk(payload: Buffer): Promise<void> {
    if (!this.clientKeyPair) {
      this.failHandshake("HS_OK diterima sebelum HS_ACK");
      return;
    }

    let keyHex: string;
    try {
      const wrapped = payload.toString("utf8").trim();
      const sessionKey = SecurityAgent.decryptWithPrivateKey(
        this.clientKeyPair.privateKey,
        wrapped,
      );
      keyHex = sessionKey.toString("hex");
    } catch (e: any) {
      this.failHandshake(`gagal membuka kunci sesi: ${e?.message ?? e}`);
      return;
    }

    this.installSessionKey(keyHex);
    this.clientKeyPair = null; // keypair sementara tidak dipakai lagi

    const firstTime = !this.ready;
    this.ready = true;
    this.hsAttempts = 0;
    this.tunnelStats.hsOk++;

    if (firstTime) {
      this.logger.info(
        `[TUNNEL] jalur aman SIAP (agent=${this.agentName}) â€” ${this.pending.length} amplop tertahan dilepas`,
      );
    } else {
      this.logger.info(`[TUNNEL] handshake ulang selesai â€” kunci sesi diperbarui`);
    }

    const queued = this.pending.splice(0, this.pending.length);
    this.tunnelStats.queued = 0;
    for (const envelope of queued) {
      await this.sendEnvelope(envelope);
    }
  }

  /** Pasang kunci sesi di port tunnel (dipakai PSK & hasil handshake). */
  private installSessionKey(keyHex: string): void {
    this.ioctl(0x1001, {
      port: this.tunnelPort,
      sessionKey: keyHex,
      agent: this.agentName,
    });
    this.sessionKeyHex = keyHex;
  }

  /**
   * clearSessionKey(): lepas kunci sesi (kembali plaintext).
   *
   * Dipakai sebelum handshake ulang: port kontrol relay tidak berkunci, jadi
   * frame handshake harus plaintext. Ini juga satu-satunya jalan pulih kalau
   * relay restart (kunci sesinya ikut hilang/berubah).
   */
  private clearSessionKey(): void {
    this.unregisterPortSecurity(this.tunnelPort);
    this.sessionKeyHex = null;
  }

  /** Catat kegagalan handshake, lalu coba lagi (kecuali sudah menyerah). */
  private failHandshake(reason: string): void {
    this.tunnelStats.hsFail++;
    this.logger.error(`[TUNNEL] handshake gagal: ${reason}`);
    if (this.hsAttempts < MAX_HS_ATTEMPTS) {
      this.scheduleHandshake(HS_RETRY_MS);
    }
  }

  /**
   * handleControlFrame(): frame handshake dari relay.
   *
   * Alur (sama seperti RsaChaSocket, hanya dibawa di dalam amplop):
   *   klien --HS_REQ--> relay
   *   klien <--HS_ACK-- relay   (public key + fingerprint, plain)
   *   klien --HS_KEY--> relay   (session key terenkripsi RSA-OAEP)
   *   klien <--HS_OK--- relay   (terenkripsi session key baru)
   */
  private async handleControlFrame(frame: TunnelFrame): Promise<void> {
    switch (frame.kind) {
      case TunnelKind.HS_ACK:
        await this.onHandshakeAck(frame.payload);
        return;

      case TunnelKind.HS_OK:
        await this.onHandshakeOk(frame.payload);
        return;

      case TunnelKind.HS_RESET:
        // Relay kehilangan sesi (mis. restart) â€” mulai ulang handshake.
        this.logger.warn(`[TUNNEL] relay meminta handshake ulang (HS_RESET)`);
        this.ready = false;
        this.hsAttempts = 0;
        this.beginHandshake("reset");
        return;

      default:
        // HS_REQ/HS_KEY hanya untuk sisi relay â€” diabaikan di device klien.
        return;
    }
  }

  /**
   * handleEnvelopePacket(): amplop dari relay sudah didekripsi base class.
   * Tugas kita: validasi, lalu serahkan ke port aplikasi yang benar.
   *
   * Publik supaya bisa dipakai untuk injeksi manual (debug/uji) tanpa broker.
   */
  public handleEnvelopePacket(pkt: { src?: string; port?: number; data: any }): void {
    const frame = decodeTunnelFrame(toPayloadBuffer(pkt.data));

    if (!frame) {
      this.tunnelStats.dropped++;
      this.logger.warn(
        `[TUNNEL] amplop rusak dari ${pkt?.src ?? "?"}:${pkt?.port ?? "?"} (drop)`,
      );
      return;
    }

    // â”€â”€ Frame kontrol (handshake) â€” bukan data aplikasi â”€â”€
    if (isTunnelControl(frame.kind)) {
      this.handleControlFrame(frame).catch((e) =>
        this.failHandshake(`pemrosesan kontrol gagal: ${e?.message ?? e}`),
      );
      return;
    }

    if (frame.dstAddress !== this.localAddress && frame.dstAddress !== "*") {
      this.tunnelStats.dropped++;
      this.logger.warn(
        `[TUNNEL] amplop untuk '${frame.dstAddress}' tiba di '${this.localAddress}' (drop)`,
      );
      return;
    }

    if (frame.hops > this.maxHops) {
      this.tunnelStats.droppedHops++;
      this.logger.warn(
        `[TUNNEL] hops ${frame.hops} > ${this.maxHops} â€” dibuang (anti-loop)`,
      );
      return;
    }

    if (frame.kind === TunnelKind.NACK) {
      this.tunnelStats.nack++;
      const note = frame.payload.toString("utf8");
      this.logger.warn(
        `[TUNNEL] NACK untuk ${frame.dstAddress}:${frame.dstPort}${note ? ` â€” ${note}` : ""}`,
      );
      return;
    }

    const isBinary = frame.proto !== TunnelProto.JSON;
    const payload = isBinary
      ? frame.payload
      : frame.payload.toString("utf8");

    this.tunnelStats.rx++;
    const ok = this.deliverLocal(
      frame.srcAddress,
      frame.srcPort,
      frame.dstPort,
      payload,
      isBinary,
      frame.flag,
    );

    if (ok) {
      this.tunnelStats.delivered++;
    } else {
      this.tunnelStats.dropped++;
      this.logger.warn(
        `[TUNNEL] tidak ada handler di port ${frame.dstPort} (dari ${frame.srcAddress}:${frame.srcPort})`,
      );
    }
  }

  public override getStats() {
    const base = super.getStats();
    return {
      ...base,
      params: {
        ...base.params,
        tunnel: {
          peer: `${this.peerAddress}:${this.tunnelPort}`,
          // `encrypted` = ada kunci sesi aktif (PSK atau hasil handshake).
          encrypted: this.sessionKeyHex !== null,
          mode: this.secMode,
          ready: this.ready,
          agent: this.sessionKeyHex !== null ? this.agentName : null,
          fingerprint: this.relayFingerprint,
          rekeySec: this.rekeySec || null,
          maxHops: this.maxHops,
          exclude: [...this.excluded],
          ...this.tunnelStats,
        },
      },
    };
  }
}

export default SimpleMQTNLDriverTunnel;
