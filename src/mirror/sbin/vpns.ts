import { UserLib } from "@tsix/UserLib";
import { NetSocket, NetPacket } from "@tsix/NetworkLib";
import { PacketFlags } from "@common/PacketFlags";
import { SecurityAgent } from "@common/SecurityAgent";
import {
  TunnelFrame,
  TunnelKind,
  TunnelProto,
  decodeTunnelFrame,
  encodeTunnelFrame,
  isTunnelControl,
  protoCodeToName,
} from "@common/protocols/TunnelEnvelope";

/**
 * VPNS — MQTNL Tunnel Relay (sisi "server")
 *
 * Menerima amplop tunnel (`TunnelEnvelope`) dari node yang berada di broker
 * LAIN, membuka sesi keluar ke tujuan sesungguhnya di broker LOKAL, lalu
 * mengembalikan jawabannya lewat amplop yang sama.
 *
 * Ini adalah NAPT pada level MQTNL: alamat tujuan TIDAK dikonfigurasi. Relay
 * membaca `dstAddress`/`dstPort` dari amplop dan meneruskannya apa adanya —
 * karena MQTT memakai nama node sebagai topik, broker lokal sendiri yang
 * melakukan routing. Akibatnya node baru di broker ini langsung terjangkau
 * tanpa menyentuh konfigurasi relay.
 *
 * PEMETAAN SESI (mirip NAT table):
 *
 *   (clientAddr, clientPort, dstAddr, dstPort) → { socket ephemeral, lastActive }
 *
 * Satu socket ephemeral per kombinasi, jadi satu klien bisa bicara ke banyak
 * node × banyak port sekaligus, dan balasan dari masing-masing kembali ke
 * port aplikasi yang benar. Socket itu yang menyediakan "NPR" (nomor port
 * acak) di sisi broker lokal.
 *
 * KEAMANAN — dua mode:
 *   1. `--psk <hex64>`  → kunci statis ChaCha20-Poly1305 (tahan restart relay,
 *                          tetapi secret harus sama di klien & relay).
 *   2. (default)         → handshake RSA-OAEP + ChaCha20-Poly1305 otomatis,
 *                          pola sama dengan `RsaChaSocket`/`tsshd`. Klien cukup
 *                          memverifikasi fingerprint relay; TIDAK ada secret
 *                          yang perlu dibagikan lebih dulu.
 *
 * Pemakaian:
 *   vpns --listen 9360                      # handshake RSA (disarankan)
 *   vpns --listen 9360 --psk <hex64>        # kunci statis
 *   vpns --listen 9360 --trust-fp <16 hex>  # hanya layani klien yang pin fp ini
 *   vpns --listen 9360 --foreground         # jangan jadi daemon
 *   vpns --help
 *
 * Relay TIDAK menyentuh enkripsi lapis aplikasi — kalau aplikasi mengenkripsi
 * sendiri (mis. airterm v2), relay tetap buta terhadap isinya.
 *
 * (c) 2026 TSIX Project
 */

const TAG = "vpns";
const DEFAULT_IDLE_SEC = 60;
const BROADCAST_IDLE_SEC = 5;
const DEFAULT_MAX_SESSIONS = 512;
const DEFAULT_MAX_HOPS = 4;
/** Session key hanya untuk satu klien; relay menyimpan per-alamat klien. */

interface Session {
  key: string;
  sock: NetSocket;
  clientAddr: string;
  clientPort: number;
  dstAddr: string;
  dstPort: number;
  proto: TunnelProto;
  hops: number;
  lastActive: number;
  idleMs: number;
  packetsOut: number;
  packetsIn: number;
  bytesOut: number;
  bytesIn: number;
}

interface VpnsOptions {
  listen: number;
  iface?: string;
  psk?: string;
  agent: string;
  idleSec: number;
  maxSessions: number;
  maxHops: number;
  foreground: boolean;
  trace: boolean;
  /**
   * Handshake RSA: tanpa PSK statis, relay membangkitkan keypair sendiri dan
   * membagikan kunci sesi ke tiap klien lewat RSA-OAEP.
   */
  handshake: boolean;
  /** Hanya layani klien yang fingerprint-nya cocok (opsional). */
  trustFingerprint?: string;
  /** Port kontrol untuk handshake (default `listen + 1`). */
  ctrlPort: number;
}

const HELP = `vpns — MQTNL Tunnel Relay (server tunnel)

Usage:
  vpns --listen <port> [opsi]

Opsi keamanan:
  (default)           Handshake RSA-OAEP + ChaCha20-Poly1305 otomatis.
                      Klien TIDAK perlu secret; cukup verifikasi fingerprint.
  --psk <hex64>       Pakai kunci statis (64 hex) — klien harus memakai PSK sama.
  --trust-fp <hex16>  Hanya layani klien dengan fingerprint ini (opsional).
  --agent <nama>      Agent enkripsi (default: chacha20)

Opsi lain:
  --listen <port>     Port tunnel yang didengarkan (wajib). Contoh: 9360
  --iface <nama>      Interface MQTNL yang dipakai (default: interface default)
  --idle <detik>      Idle timeout sesi (default: ${DEFAULT_IDLE_SEC})
  --max-sessions <n>  Batas sesi bersamaan (default: ${DEFAULT_MAX_SESSIONS})
  --max-hops <n>      Tolak amplop yang hops-nya melebihi ini (default: ${DEFAULT_MAX_HOPS})
  --trace             Log setiap paket yang diteruskan
  --foreground        Jangan daemonize (untuk debug)
  -h, --help          Tampilkan bantuan ini

Contoh:
  vpns --listen 9360
  vpns --listen 9360 --iface smqtnl1 --trace --foreground
  vpns --listen 9360 --psk 81ff71ed...d67619
`;

/** Ambil nilai flag `--name value` / `--name=value`. */
function flagValue(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith("-")) {
    return args[idx + 1];
  }
  return undefined;
}

/** Nomor aman dari argumen (NaN → fallback). */
function num(value: string | undefined, fallback: number): number {
  const n = parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function toBuffer(data: any): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data === null || data === undefined) return Buffer.alloc(0);
  if (typeof data === "string") return Buffer.from(data, "utf8");
  return Buffer.from(String(data), "utf8");
}

export default class Vpns {
  private lib!: UserLib;
  private opts!: VpnsOptions;
  private inSocket: NetSocket | null = null;
  /** Socket TANPA kunci untuk frame handshake (lihat catatan desain di atas). */
  private ctrlSocket: NetSocket | null = null;
  private sessions = new Map<string, Session>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;

  // ── Kunci & identitas relay (mode handshake) ──
  private keyPair: { publicKey: string; privateKey: string } | null = null;
  private fingerprint: string | null = null;
  /** Kunci sesi bersama; SATU per relay karena driver = satu kunci per port. */
  private sessionKey: Buffer | null = null;
  /** Nonce per klien (anti-replay pada pembuktian kunci). */
  private nonces = new Map<string, { nonce: string; at: number }>();
  private authedClients = new Map<string, string>(); // clientAddr → fingerprint

  private stats = {
    envelopesIn: 0,
    envelopesOut: 0,
    bytesIn: 0,
    bytesOut: 0,
    sessionsCreated: 0,
    sessionsExpired: 0,
    dropped: 0,
    nackSent: 0,
    hsAck: 0,
    hsOk: 0,
    hsFail: 0,
  };

  async execute(lib: UserLib, args: string[]): Promise<void> {
    this.lib = lib;

    if (args.includes("--help") || args.includes("-h") || args.length === 0) {
      await lib.std.print(HELP);
      return;
    }

    const listenRaw = flagValue(args, "--listen");
    const listen = num(listenRaw, -1);
    if (listen <= 0 || listen > 65535) {
      await lib.std.print("vpns: --listen <port> wajib (1-65535).\n");
      await lib.std.print(HELP);
      await lib.shell.exit(1);
      return;
    }

    const psk = flagValue(args, "--psk");
    if (psk && !/^[0-9a-fA-F]{64}$/.test(psk)) {
      await lib.std.print(
        "vpns: --psk harus 64 karakter hex (32 byte).\n",
      );
      await lib.shell.exit(1);
      return;
    }

    const ctrlPortRaw = flagValue(args, "--ctrl-port");

    this.opts = {
      listen,
      iface: flagValue(args, "--iface"),
      psk,
      agent: flagValue(args, "--agent") ?? "chacha20",
      idleSec: num(flagValue(args, "--idle"), DEFAULT_IDLE_SEC),
      maxSessions: num(flagValue(args, "--max-sessions"), DEFAULT_MAX_SESSIONS),
      maxHops: num(flagValue(args, "--max-hops"), DEFAULT_MAX_HOPS),
      foreground: args.includes("--foreground") || args.includes("--debug"),
      trace: args.includes("--trace"),
      // Tanpa PSK → handshake RSA (default). Kunci statis tetap didukung.
      handshake: !psk,
      trustFingerprint: flagValue(args, "--trust-fp")
        ?.replace(/^SHA256:/i, "")
        .toUpperCase(),
      ctrlPort: ctrlPortRaw ? num(ctrlPortRaw, listen + 1) : listen + 1,
    };

    // Banner ditulis SEBELUM daemonize supaya terlihat di terminal pemanggil
    // (setelah jadi daemon, output hanya masuk log).
    await lib.std.print(
      `🔒 vpns: relay tunnel MQTNL di port ${this.opts.listen}` +
      `${this.opts.iface ? ` [${this.opts.iface}]` : ""}\n`,
    );

    if (this.opts.handshake) {
      this.keyPair = SecurityAgent.generateKeyPair();
      this.fingerprint = SecurityAgent.getFingerprint(this.keyPair.publicKey).toUpperCase();
      this.sessionKey = SecurityAgent.generateSessionKey();
      await lib.std.print(
        `   🔑 Mode: handshake RSA (port kontrol ${this.opts.ctrlPort})\n` +
        `   Fingerprint relay: ${this.fingerprint}\n` +
        `   ${this.opts.trustFingerprint ? `Hanya menerima klien: ${this.opts.trustFingerprint}` : "Semua klien yang lolos verifikasi tanda tangan dilayani"}\n`,
      );
    } else {
      this.sessionKey = Buffer.from(psk!, "hex");
      await lib.std.print(
        `   🔑 Mode: PSK statis (${this.opts.agent})\n`,
      );
    }

    if (!this.opts.foreground) {
      await lib.shell.daemonize("MQTNL Tunnel Relay (vpns)");
    }

    this.inSocket = new NetSocket({
      port: this.opts.listen,
      iface: this.opts.iface,
      // Binfeo = biner terenkripsi: amplop (header + payload) tetap utuh,
      // tanpa overhead hex seperti jalur JSON.
      protocol: "Binfeo",
      autoCleanup: false,
    });

    this.inSocket.onData = (pkt: NetPacket) => {
      void this.handleEnvelope(pkt);
    };
    this.inSocket.onError = (err) =>
      void lib.std.log(`socket error: ${err.message}`, TAG);

    // Port data memakai kunci sesi (PSK statis atau kunci hasil handshake).
    try {
      await this.inSocket.open();
      if (this.sessionKey) {
        await this.inSocket.upgradeSecurity(this.sessionKey.toString("hex"), {
          agent: this.opts.agent,
        });
      }
    } catch (e: any) {
      await lib.std.print(`vpns: gagal membuka port ${listen}: ${e.message}\n`);
      await lib.shell.exit(1);
      return;
    }

    // Port kontrol (handshake) — TANPA kunci, supaya frame handshake terbaca
    // plaintext. Hanya dibuka pada mode handshake.
    if (this.opts.handshake) {
      this.ctrlSocket = new NetSocket({
        port: this.opts.ctrlPort,
        iface: this.opts.iface,
        protocol: "Binfeo",
        autoCleanup: false,
      });
      this.ctrlSocket.onData = (pkt: NetPacket) => {
        void this.handleEnvelope(pkt);
      };
      this.ctrlSocket.onError = (err) =>
        void lib.std.log(`ctrl socket error: ${err.message}`, TAG);

      try {
        await this.ctrlSocket.open();
      } catch (e: any) {
        await lib.std.print(
          `vpns: gagal membuka port kontrol ${this.opts.ctrlPort}: ${e.message}\n`,
        );
        await lib.shell.exit(1);
        return;
      }
    }

    const actual = this.inSocket.port ?? listen;
    await lib.std.print(
      `✅ vpns siap — amplop data di port ${actual}` +
      `${this.opts.handshake ? `, kontrol di ${this.ctrlSocket?.port ?? this.opts.ctrlPort}` : ""}` +
      `${this.sessionKey ? ` (${this.opts.handshake ? "RSA+ChaCha" : `PSK ${this.opts.agent}`})` : ""}\n`,
    );

    this.cleanupTimer = setInterval(() => this.sweepSessions(), 15_000);

    try {
      await lib.shell.onSignal("SIGINT", async () => {
        await this.shutdown(130);
      });
      await lib.shell.onSignal("SIGTERM", async () => {
        await this.shutdown(143);
      });
    } catch (_) {
      /* signal handler tidak selalu tersedia (mis. mode foreground debug) */
    }

    if (this.inSocket.onClose === null) {
      // Jaga-jaga: kalau socket ditutup dari luar, lepaskan sesi.
      this.inSocket.onClose = () => {
        void this.shutdown(0);
      };
    }
  }
  /** Amplop masuk dari klien tunnel. */
  private async handleEnvelope(pkt: NetPacket): Promise<void> {
    const raw = toBuffer(pkt.data);
    this.stats.envelopesIn++;
    this.stats.bytesIn += raw.length;

    const frame = decodeTunnelFrame(raw);
    if (!frame) {
      this.stats.dropped++;
      await this.lib.std.log(
        `amplop rusak dari ${pkt.src}:${pkt.port} (${raw.length} B) — drop`,
        TAG,
      );
      return;
    }

    if (frame.hops > this.opts.maxHops) {
      this.stats.dropped++;
      await this.lib.std.log(
        `hops ${frame.hops} > ${this.opts.maxHops} dari ${pkt.src} — drop (anti-loop)`,
        TAG,
      );
      return;
    }

    if (frame.kind === TunnelKind.NACK) {
      this.stats.dropped++;
      return; // klien tidak seharusnya mengirim NACK
    }

    // ── Frame kontrol handshake (port kontrol, plaintext) ──
    if (isTunnelControl(frame.kind)) {
      await this.handleControl(pkt, frame);
      return;
    }

    if (!frame.dstAddress) {
      await this.sendNack(pkt.src, frame, "dstAddress kosong");
      return;
    }

    // Broadcast ("*") memakai sesi berumur pendek: satu NPR socket bisa
    // menerima balasan dari BANYAK node sekaligus.
    const isBroadcast = frame.dstAddress === "*";
    const key = `${pkt.src}|${frame.srcPort}|${frame.dstAddress}|${frame.dstPort}`;

    let session: Session | undefined = this.sessions.get(key);
    if (!session) {
      const created = await this.createSession(key, pkt, frame, isBroadcast);
      if (!created) return;
      session = created;
    }
    session.lastActive = Date.now();
    session.hops = frame.hops;

    const payload = frame.payload;
    session.packetsOut++;
    session.bytesOut += payload.length;

    // Framing menentukan tipe data yang harus diserahkan ke driver:
    //  - JSON  → string (driver menjalankan securePacketOut/JSON.stringify)
    //  - Binary/Binfeo → Buffer mentah (byte >= 0x80 tidak boleh di-utf8-kan)
    const outData =
      frame.proto === TunnelProto.JSON
        ? payload.toString("utf8")
        : payload;

    try {
      await session.sock.sendTo(
        frame.dstAddress,
        frame.dstPort,
        outData,
        frame.flag ?? PacketFlags.FLAG_DATA,
      );
    } catch (e: any) {
      this.stats.dropped++;
      await this.lib.std.log(
        `gagal meneruskan ke ${frame.dstAddress}:${frame.dstPort}: ${e.message}`,
        TAG,
      );
      return;
    }

    if (this.opts.trace) {
      await this.lib.std.log(
        `→ ${pkt.src}:${frame.srcPort} ⇒ ${frame.dstAddress}:${frame.dstPort} ` +
        `[${protoCodeToName(frame.proto)}] ${payload.length} B`,
        TAG,
      );
    }
  }

  /** Kirim frame kontrol ke klien lewat port kontrol (plaintext). */
  private async sendControlTo(
    clientAddr: string,
    clientPort: number,
    kind: TunnelKind,
    payload: Buffer,
  ): Promise<void> {
    if (!this.ctrlSocket?.isOpen) return;

    const envelope = encodeTunnelFrame({
      version: 1,
      kind,
      hops: 1,
      flag: PacketFlags.FLAG_DATA,
      proto: TunnelProto.JSON,
      srcAddress: this.opts.iface ?? "relay",
      srcPort: this.ctrlSocket.port ?? this.opts.ctrlPort,
      dstAddress: clientAddr,
      dstPort: clientPort,
      payload,
    });

    try {
      await this.ctrlSocket.sendTo(
        clientAddr,
        this.ctrlSocket.port ?? this.opts.ctrlPort,
        envelope,
        PacketFlags.FLAG_DATA,
      );
      this.stats.envelopesOut++;
    } catch (e: any) {
      await this.lib.std.log(`gagal kirim kontrol: ${e.message}`, TAG);
    }
  }

  /**
   * handleControl(): handshake RSA-OAEP → ChaCha20-Poly1305.
   *
   *   klien --HS_REQ--> relay
   *   klien <--HS_ACK-- relay   (publicKey :: fingerprint :: nonce)
   *   klien --HS_KEY--> relay   (clientPublicKey :: signature(nonce))
   *   klien <--HS_OK--- relay   (session key, dibungkus public key klien)
   *
   * Kunci sesi dibangkitkan relay dan DIBAGIKAN ke semua klien: driver MQTNL
   * hanya menyimpan satu kunci per port, jadi kunci per-klien tidak mungkin.
   * Yang membedakan klien adalah tanda tangan nonce (bukti possession kunci).
   */
  private async handleControl(pkt: NetPacket, frame: TunnelFrame): Promise<void> {
    if (!this.opts.handshake || !this.keyPair || !this.fingerprint) {
      this.stats.dropped++;
      return; // klien meminta handshake padahal relay memakai PSK
    }

    const clientAddr = frame.srcAddress || pkt.src;
    const clientPort = frame.srcPort || pkt.port;

    if (frame.kind === TunnelKind.HS_REQ) {
      const nonce = SecurityAgent.generateSessionKey()
        .subarray(0, 16)
        .toString("hex");
      this.nonces.set(clientAddr, { nonce, at: Date.now() });
      this.stats.hsAck++;

      await this.sendControlTo(
        clientAddr,
        clientPort,
        TunnelKind.HS_ACK,
        Buffer.from(
          `${this.keyPair.publicKey}::${this.fingerprint}::${nonce}`,
          "utf8",
        ),
      );

      if (this.opts.trace) {
        await this.lib.std.log(`HS_REQ dari ${clientAddr} → HS_ACK (nonce ${nonce.slice(0, 8)}…)`, TAG);
      }
      return;
    }

    if (frame.kind === TunnelKind.HS_KEY) {
      const entry = this.nonces.get(clientAddr);
      if (!entry || Date.now() - entry.at > 60_000) {
        this.stats.hsFail++;
        await this.lib.std.log(
          `HS_KEY dari ${clientAddr} tanpa HS_REQ yang valid — abaikan`,
          TAG,
        );
        return;
      }

      const text = frame.payload.toString("utf8");
      const sep = text.indexOf("::");
      const clientPublicKey = sep === -1 ? "" : text.slice(0, sep);
      const signature = sep === -1 ? "" : text.slice(sep + 2).trim();

      // Bukti possession: tanda tangan atas nonce harus valid untuk public key
      // yang dikirim klien itu sendiri.
      let verified = false;
      try {
        verified =
          !!clientPublicKey &&
          !!signature &&
          SecurityAgent.verify(clientPublicKey, entry.nonce, signature);
      } catch (_e) {
        verified = false;
      }

      if (!verified) {
        this.stats.hsFail++;
        await this.lib.std.log(
          `HS_KEY dari ${clientAddr}: tanda tangan TIDAK valid — ditolak`,
          TAG,
        );
        return;
      }

      const clientFp = SecurityAgent.getFingerprint(clientPublicKey).toUpperCase();
      if (this.opts.trustFingerprint && this.opts.trustFingerprint !== clientFp) {
        this.stats.hsFail++;
        await this.lib.std.log(
          `HS_KEY dari ${clientAddr}: fingerprint klien ${clientFp} tidak diizinkan — ditolak`,
          TAG,
        );
        return;
      }

      this.nonces.delete(clientAddr);
      this.authedClients.set(clientAddr, clientFp);

      // Bungkus kunci sesi dengan public key klien: hanya dia yang bisa buka.
      const wrapped = SecurityAgent.encryptWithPublicKey(
        clientPublicKey,
        this.sessionKey!,
      );

      await this.sendControlTo(
        clientAddr,
        clientPort,
        TunnelKind.HS_OK,
        Buffer.from(wrapped, "utf8"),
      );

      this.stats.hsOk++;
      await this.lib.std.log(
        `✅ klien ${clientAddr} terautentikasi (fp ${clientFp}) — kunci sesi dibagikan`,
        TAG,
      );
      return;
    }

    // HS_ACK/HS_OK/HS_RESET dari klien tidak relevan di sisi relay.
    this.stats.dropped++;
  }


  /** Buat (dan buka) socket keluar untuk satu kombinasi klien×tujuan. */
  private async createSession(
    key: string,
    pkt: NetPacket,
    frame: TunnelFrame,
    isBroadcast: boolean,
  ): Promise<Session | null> {
    if (this.sessions.size >= this.opts.maxSessions) {
      await this.sendNack(pkt.src, frame, "relay penuh");
      return null;
    }

    const sock = new NetSocket({
      port: 0, // ephemeral → inilah "NPR" di sisi broker lokal
      iface: this.opts.iface,
      protocol: protoCodeToName(frame.proto),
      autoCleanup: false,
    });

    const session: Session = {
      key,
      sock,
      clientAddr: pkt.src,
      clientPort: frame.srcPort,
      dstAddr: frame.dstAddress,
      dstPort: frame.dstPort,
      proto: frame.proto,
      hops: frame.hops,
      lastActive: Date.now(),
      idleMs: (isBroadcast ? BROADCAST_IDLE_SEC : this.opts.idleSec) * 1000,
      packetsOut: 0,
      packetsIn: 0,
      bytesOut: 0,
      bytesIn: 0,
    };

    sock.onData = (reply: NetPacket) => {
      void this.forwardReply(session, reply);
    };
    sock.onError = (err) => {
      void this.lib.std.log(
        `sesi ${session.dstAddr}:${session.dstPort} error: ${err.message}`,
        TAG,
      );
    };

    try {
      await sock.open();
    } catch (e: any) {
      await this.sendNack(pkt.src, frame, `gagal buka socket: ${e.message}`);
      return null;
    }

    this.sessions.set(key, session);
    this.stats.sessionsCreated++;

    if (this.opts.trace) {
      await this.lib.std.log(
        `+ sesi ${pkt.src}:${frame.srcPort} ⇒ ${frame.dstAddress}:${frame.dstPort} ` +
        `via NPR ${sock.port}`,
        TAG,
      );
    }
    return session;
  }

  /** Balasan dari broker lokal → bungkus amplop → kembalikan ke klien. */
  private async forwardReply(session: Session, reply: NetPacket): Promise<void> {
    session.lastActive = Date.now();
    session.packetsIn++;

    const payload = toBuffer(reply.data);
    session.bytesIn += payload.length;

    const envelope = this.buildEnvelope(
      {
        srcAddress: reply.src,
        srcPort: reply.port,
        dstAddress: session.clientAddr,
        dstPort: session.clientPort,
        proto: session.proto,
        hops: session.hops + 1,
        flag: reply.flag ?? PacketFlags.FLAG_DATA,
      },
      payload,
    );

    if (!envelope) return;

    if (!this.inSocket?.isOpen) return;
    try {
      await this.inSocket.sendTo(
        session.clientAddr,
        this.inSocket.port ?? this.opts.listen,
        envelope,
        PacketFlags.FLAG_DATA,
      );
      this.stats.envelopesOut++;
      this.stats.bytesOut += envelope.length;
    } catch (e: any) {
      await this.lib.std.log(`gagal kirim balasan: ${e.message}`, TAG);
    }

    if (this.opts.trace) {
      await this.lib.std.log(
        `← ${reply.src}:${reply.port} ⇒ ${session.clientAddr}:${session.clientPort} ` +
        `[${protoCodeToName(session.proto)}] ${payload.length} B`,
        TAG,
      );
    }
  }

  /** encodeTunnelFrame yang aman (alamat kepanjangan → log, bukan crash). */
  private buildEnvelope(
    fields: Omit<TunnelFrame, "version" | "kind" | "payload">,
    payload: Buffer,
    kind: TunnelKind = TunnelKind.DATA,
  ): Buffer | null {
    try {
      return encodeTunnelFrame({
        version: 1,
        kind,
        ...fields,
        payload,
      });
    } catch (e: any) {
      this.stats.dropped++;
      void this.lib.std.log(`encode amplop gagal: ${e.message}`, TAG);
      return null;
    }
  }

  /** Kirim NACK supaya klien tidak menunggu sampai timeout tanpa penjelasan. */
  private async sendNack(
    clientAddr: string,
    frame: TunnelFrame,
    reason: string,
  ): Promise<void> {
    if (!this.inSocket?.isOpen) return;
    const envelope = this.buildEnvelope(
      {
        srcAddress: this.inSocket ? (this.opts.iface ?? "relay") : "relay",
        srcPort: this.opts.listen,
        dstAddress: clientAddr,
        dstPort: frame.srcPort,
        proto: TunnelProto.JSON,
        hops: frame.hops + 1,
        flag: PacketFlags.FLAG_DATA,
      },
      Buffer.from(reason, "utf8"),
      TunnelKind.NACK,
    );
    if (!envelope) return;

    try {
      await this.inSocket.sendTo(
        clientAddr,
        this.inSocket.port ?? this.opts.listen,
        envelope,
        PacketFlags.FLAG_DATA,
      );
      this.stats.nackSent++;
      this.stats.envelopesOut++;
    } catch (_) {
      /* NACK bersifat best-effort */
    }
    void this.lib.std.log(
      `NACK → ${clientAddr}:${frame.srcPort} (${reason})`,
      TAG,
    );
  }

  /** Tutup sesi yang menganggur — mencegah kebocoran port (hanya ~10k ephemeral). */
  private sweepSessions(): void {
    if (this.stopping) return;
    const now = Date.now();
    for (const [key, s] of this.sessions.entries()) {
      if (now - s.lastActive <= s.idleMs) continue;

      this.sessions.delete(key);
      this.stats.sessionsExpired++;
      s.sock.close().catch(() => { });
      void this.lib.std.log(
        `- sesi ${s.clientAddr}:${s.clientPort} ⇒ ${s.dstAddr}:${s.dstPort} ` +
        `expired (${s.packetsOut}↑ ${s.packetsIn}↓)`,
        TAG,
      );
    }
  }

  private async shutdown(code: number): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    if (this.cleanupTimer) clearInterval(this.cleanupTimer);

    for (const s of this.sessions.values()) {
      try {
        await s.sock.close();
      } catch (_) {
        /* ignore */
      }
    }
    this.sessions.clear();

    try {
      await this.inSocket?.close();
    } catch (_) {
      /* ignore */
    }

    await this.lib.std.log(
      `vpns berhenti — ${this.stats.envelopesIn} masuk / ${this.stats.envelopesOut} keluar, ` +
      `${this.stats.sessionsCreated} sesi, ${this.stats.dropped} drop, ${this.stats.nackSent} NACK`,
      TAG,
    );

    if (code !== 0) await this.lib.shell.exit(code);
  }
}
