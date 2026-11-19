import * as crypto from "crypto";
import { SyscallCode } from "../../common/SyscallCode";
import { PacketFlags } from "../../common/PacketFlags";
import { SecurityAgent } from "../../common/SecurityAgent";
import { AesGcmAgent } from "../../common/AesGcmAgent";
import { OSContext } from "./IProgram";

/**
 * NETWORK LIB + NETSOCKET (MQTNL)
 *
 * Satu source of truth untuk networking userland. Sebelumnya ada DUA class
 * NetworkLib yang tumpang tindih (satu di NetworkLib.ts, satu di dalam
 * UserLib.ts) dan API-nya masih syscall-level:
 *
 *   - user harus manual socket() → bind() → pegang fd → loop recv() → close()
 *   - magic number ioctl (0x1001 / 0x1002) bocor ke user
 *   - tidak ada lifecycle eksplisit (release port + normalisasi security agent)
 *
 * Sekarang dibagi menjadi dua lapisan:
 *
 *   1. `NetworkLib`  — wrapper syscall level-rendah (dipakai singleton `net`).
 *   2. `NetSocket`   — komponen high-level ala Cashew: instantiate → open()
 *                      → events (onData/onError/onClose) → close(). Tanpa
 *                      magic number, tanpa urus fd manual, auto-release port
 *                      + security agent saat close().
 *
 * (c) 2026 TSIX Project
 */

/**
 * Konstanta IOCTL jaringan — dulu magic number (0x1001/0x1002) dipakai
 * langsung oleh aplikasi. Sekarang disimpan bernama di sini supaya tidak
 * bocor ke userland.
 */
export const SMQTNL_IOCTL = {
  /** SMQTNL_IOCTL_UPGRADE_SECURITY — aktifkan ChaCha20-Poly1305 per port. */
  UPGRADE_SECURITY: 0x1001,
  /** SMQTNL_IOCTL_SET_BINARY_MODE — aktifkan protocol biner per port. */
  SET_BINARY_MODE: 0x1002,
} as const;

/**
 * Bentuk paket yang diterima aplikasi (dikirim SimpleMQTNLDriver saat ada
 * data masuk ke port yang sudah di-bind).
 */
export interface NetPacket {
  /** Address pengirim (mis. "tsix-node-2"). */
  src: string;
  /** Port asal pengirim. */
  port: number;
  /** Port lokal tujuan (port yang kita bind). */
  localPort: number;
  /** Payload (string untuk JSON, Buffer untuk protocol biner). */
  data: any;
  /** True kalau datang lewat protocol biner (MQTNL v1.1). */
  isBinary?: boolean;
  /**
   * Flag paket (`PacketFlags`) — hanya diisi kalau driver mengirimkannya.
   * Dipakai relay/tunnel untuk membedakan DATA dari PING_REPLY/BROADCAST.
   */
  flag?: number;
  /** Timestamp kedatangan (ms). */
  ts: number;
}

type DispatchFn = (code: SyscallCode, args: any) => Promise<any>;

/**
 * Argumen konstruktor `NetworkLib` — boleh dua bentuk supaya kompatibel
 * dengan pemakai lama:
 *  - fungsi `dispatch` (dipakai UserLib/`net` singleton)
 *  - `OSContext` / `_tsixOsc` (dipakai ping.ts, network-traffic.ts)
 */
type NetLibSource = DispatchFn | OSContext;

/** Ambil fungsi dispatch dari sumber (fungsi langsung atau OSContext). */
function resolveDispatch(source: NetLibSource): DispatchFn {
  if (typeof source === "function") return source as DispatchFn;
  const os = source as OSContext;
  const d = (os.shell as any).dispatch;
  if (typeof d === "function") return d.bind(os.shell);
  throw new Error("NetworkLib: tidak ada dispatch yang valid dari source");
}

/**
 * NETWORK LIB (Low-level syscall wrapper)
 *
 * Lapisan tipis di atas syscall MQTNL: SOCKET, BIND, SENDTO, RECVFROM,
 * CLOSE, IOCTL, NETSTAT. Dipakai oleh singleton `net` di @tsix/Application
 * dan aplikasi yang memang butuh kontrol penuh (tssh, tpkgd, airtermd, dll).
 *
 * Sebagian besar aplikasi baru sebaiknya pakai `NetSocket` (di bawah) yang
 * membungkus lifecycle + events + security.
 */
export class NetworkLib {
  private readonly dispatch: DispatchFn;

  constructor(source: NetLibSource) {
    this.dispatch = resolveDispatch(source);
  }

  /** socket(): Membuat socket baru, return fd (atau -1 jika gagal). */
  public async socket(): Promise<number> {
    return await this.dispatch(SyscallCode.SOCKET, null);
  }

  /**
   * bind(): Mengikat socket ke port lokal (address/interface opsional).
   * Return port ASLI yang ter-bind (angka). Kalau `port` = 0, kernel memilih
   * port random yang available dan nilainya dikembalikan di sini — penting
   * untuk per-srcPort encryption (upgradeSecurity). Lempar error kalau gagal.
   */
  public async bind(
    fd: number,
    port: number,
    address?: string,
  ): Promise<number> {
    return await this.dispatch(SyscallCode.BIND, { fd, port, address });
  }

  /** listen(): shortcut socket() + bind() untuk server. Return fd atau -1. */
  public async listen(port: number): Promise<number> {
    const fd = await this.socket();
    const bound = await this.bind(fd, port);
    return bound ? fd : -1;
  }

  /** accept(): Tunggu klien pertama, return pseudo-connection { fd, src, port }. */
  public async accept(serverFd: number): Promise<any> {
    while (true) {
      const pkt = await this.recv(serverFd);
      if (pkt) {
        return {
          fd: serverFd,
          src: pkt.src,
          port: pkt.port,
          localPort: pkt.localPort || 0,
          firstPkt: pkt,
        };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** sendTo(): Kirim data ke address:port tujuan. */
  public async sendTo(
    fd: number,
    address: string,
    port: number,
    data: any,
    flag: PacketFlags = PacketFlags.FLAG_DATA,
    srcPort: number = 0,
  ): Promise<boolean> {
    return await this.dispatch(SyscallCode.SENDTO, {
      fd,
      address,
      port,
      data,
      flag,
      srcPort,
    });
  }

  /** Alias `sendTo` (dipakai sebagian app lama dengan huruf kecil). */
  public async sendto(
    fd: number,
    address: string,
    port: number,
    data: any,
    flag: PacketFlags = PacketFlags.FLAG_DATA,
    srcPort: number = 0,
  ): Promise<boolean> {
    return await this.sendTo(fd, address, port, data, flag, srcPort);
  }

  /** recv(): Baca satu paket (blocking, event-driven di kernel). */
  public async recv(fd: number): Promise<NetPacket | null> {
    return await this.dispatch(SyscallCode.RECVFROM, fd);
  }

  /** recvFrom(): Baca satu paket dengan batas timeout keseluruhan. */
  public async recvFrom(
    fd: number,
    timeoutMs: number = 5000,
  ): Promise<NetPacket | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await this.recv(fd);
      if (res) return res;
    }
    return null;
  }

  /** close(): Tutup fd — kernel melepas port + security agent. */
  public async close(fd: number): Promise<boolean> {
    return await this.dispatch(SyscallCode.CLOSE, fd);
  }

  /** netstat(): Info semua interface MQTNL + statistik. */
  public async netstat(): Promise<any> {
    return await this.dispatch(SyscallCode.NETSTAT, null);
  }

  /**
   * setDefaultDevice(): Ganti interface MQTNL default secara RUNTIME.
   *
   * Hanya mengubah nilai di memori kernel — TIDAK menulis ulang
   * `sysconfig.conf`, jadi perubahan hilang saat reboot. `name` boleh berupa
   * deviceName ("smqtnl1") atau address ("mactsix_2").
   * Return `{ defaultDevice, previous }` (deviceName kanonik + nilai sebelumnya).
   */
  public async setDefaultDevice(name: string): Promise<any> {
    return await this.dispatch(SyscallCode.SET_NET_DEFAULT, {
      deviceName: name,
    });
  }

  /**
   * listAgents(): Nama semua Security Agent enkripsi yang terdaftar di kernel
   * (lihat registri SimpleMQTNLDriver; dipakai tool `secagent`).
   */
  public async listAgents(): Promise<string[]> {
    return await this.dispatch(SyscallCode.SECAGENT_LIST, null);
  }

  /**
   * cha20P1305Agent(): Upgrade security ChaCha20-Poly1305 untuk sebuah port
   * (membungkus ioctl SMQTNL_IOCTL.UPGRADE_SECURITY).
   */
  public async cha20P1305Agent(
    fd: number,
    port: number,
    key: any,
  ): Promise<any> {
    return await this.dispatch(SyscallCode.IOCTL, {
      fd,
      cmd: SMQTNL_IOCTL.UPGRADE_SECURITY,
      arg: { port, sessionKey: key },
    });
  }

  /** ioctl(): Kontrol device tingkat rendah (umumnya tidak perlu oleh user). */
  public async ioctl(fd: number, cmd: number, arg: any): Promise<any> {
    return await this.dispatch(SyscallCode.IOCTL, { fd, cmd, arg });
  }

  /**
   * toBuffer(): Reconstruct a Buffer from an IPC/MQTNL packet payload.
   *
   * Menangani semua artefak serialisasi IPC:
   *  - payload sudah Buffer  → langsung return
   *  - payload berupa JSON string `{"type":"Buffer","data":[…]}` atau raw number array string
   *  - payload berupa object `{ type:"Buffer", data:[…] }`
   *  - payload berupa raw binary string
   *
   * Return Buffer.alloc(0) jika payload null/undefined atau tidak dikenali.
   */
  public static toBuffer(payload: any): Buffer {
    if (payload == null) return Buffer.alloc(0);

    // 1. Jika payload berupa JSON string, coba parse dulu
    if (typeof payload === "string") {
      try {
        const parsed = JSON.parse(payload);
        if (
          parsed &&
          (parsed.type === "Buffer" || typeof parsed[0] === "number")
        ) {
          payload = parsed;
        }
      } catch (_e) {
        // bukan JSON — akan ditangani di bawah sebagai raw string
      }
    }

    // 2. Sudah Buffer
    if (Buffer.isBuffer(payload)) {
      return payload;
    }

    // 3. Object { type: "Buffer", data: number[] }
    if (payload && payload.type === "Buffer" && Array.isArray(payload.data)) {
      return Buffer.from(payload.data);
    }

    // 4. Raw binary string
    if (typeof payload === "string") {
      return Buffer.from(payload, "binary");
    }

    return Buffer.alloc(0);
  }
}

/**
 * NETSOCKET — Komponen networking high-level ala Cashew.
 *
 * Instanisasi sekali, konfigurasi via object literal, pakai event handler,
 * dan lifecycle eksplisit open()/close(). Semua kerumitan syscall, magic
 * ioctl, dan pegang fd disembunyikan di dalam.
 *
 * Contoh server (plain dulu, lalu switch ke secure):
 *
 *   const sock = new NetSocket({ port: 2500, key: KEY_HEX });
 *   sock.onData = (pkt) => std.println(`[${pkt.src}:${pkt.port}] ${pkt.data}`);
 *   await sock.open();                       // socket + bind (+ recv-loop)
 *   await sock.upgradeSecurity();            // switch ke ChaCha20-Poly1305
 *   await sock.sendTo("leptopus", 1000, "halo");
 *   await sock.close();                      // release port + normalisasi security agent
 *
 * Contoh klien (kirim tanpa perlu bind port tetap — port ephemeral dari kernel):
 *
 *   const sock = new NetSocket({ port: 0 });   // 0 = minta port random
 *   await sock.open();
 *   // sock.port sekarang berisi port ASLI hasil pilihan kernel — dipakai juga
 *   // oleh upgradeSecurity()/sendTo() untuk per-srcPort encryption.
 *   await sock.sendTo("leptopus", 1000, "hello");
 *   await sock.close();
 *
 * Contoh PSK (tanpa RSA/handshake — TX & RX memakai PSK yang sama):
 *
 *   const sock = new NetSocket({ port: 2700, psk: "rahasia-bersama" });
 *   sock.onData = (pkt) => std.println(String(pkt.data));
 *   await sock.open();          // bind port (masih plain)
 *   await sock.upgradePsk();    // ChaCha20-Poly1305 dari PSK
 */
export interface NetSocketOptions {
  /**
   * Port lokal untuk bind. WAJIB diisi (angka).
   * Gunakan 0 untuk port ephemeral acak (dikelola kernel) — setelah `open()`,
   * baca `sock.port` untuk port ASLI yang dipilih (dipakai juga oleh
   * `upgradeSecurity()`/`sendTo()` supaya session key menempel di port yang benar).
   */
  port: number;
  /** Interface/address MQTNL (opsional). Contoh: "tsix-node-2" atau "smqtnl1". */
  iface?: string;
  /**
   * Session key (hex, 64 karakter) untuk `upgradeSecurity()`.
   * TIDAK diterapkan otomatis saat open() — aplikasi memanggil
   * `upgradeSecurity()` secara eksplisit kapan pun (mis. setelah handshake).
   * Jenis enkripsi diatur lewat argumen `agent` di `upgradeSecurity()`
   * (default "chacha20").
   */
  key?: string;
  /**
   * Pre-shared key untuk `upgradePsk()`: passphrase bebas atau 64 karakter hex.
   * Session key ChaCha20-Poly1305 diturunkan dari PSK ini (HKDF-SHA256), jadi
   * TX dan RX cukup memakai PSK yang sama tanpa handshake/RSA.
   */
  psk?: string;
  /**
   * Aktifkan enkripsi otomatis saat `open()`:
   * - `psk` diisi  → `upgradePsk()`
   * - `key` diisi  → `upgradeSecurity()`
   * Tanpa `key`/`psk` → error saat open.
   */
  autoSecure?: boolean;
  /** Nama agent enkripsi untuk autoSecure/upgradePsk (default "chacha20"). */
  agent?: string;
  /** Mode protocol biner per-port (default: false → JSON). */
  binary?: boolean;
  /**
   * Nama protocol per-port (opsional, mengalahkan `binary`). Contoh:
   *  - "Binary" → biner OTA (bypass enkripsi)
   *  - "Binfeo" → biner TERSANDI untuk komunikasi normal (dipasang via
   *    `upgradeSecurity()`; payload bisa Buffer, terdekripsi utuh di RX)
   * Kosong + `binary: true` → "Binary".
   */
  protocol?: string;
  /**
   * Auto-cleanup saat SIGINT/SIGTERM (default: true): close() lalu exit(130/143).
   * Set false jika aplikasi ingin menangani signal sendiri.
   */
  autoCleanup?: boolean;
}

/** Opsi tambahan untuk `upgradeSecurity()` — pilih jenis agent enkripsi. */
export interface NetSocketSecurityOptions {
  /**
   * Nama agent enkripsi yang terdaftar di SimpleMQTNLDriver (default "chacha20").
   * Contoh: "chacha20" (SecurityAgent asli), "aes-gcm" (AES-256-GCM), atau
   * nama agent kustom yang didaftarkan via SimpleMQTNLDriver.registerAgent().
   */
  agent?: string;
}

export interface NetSocketStats {
  /** Jumlah paket berhasil dikirim. */
  sent: number;
  /** Jumlah paket diterima loop. */
  received: number;
  /** Perkiraan byte payload terkirim. */
  bytesSent: number;
  /** Perkiraan byte payload diterima. */
  bytesReceived: number;
  /** Jumlah error yang dilaporkan lewat onError. */
  errors: number;
  /** Epoch ms saat open() berhasil (0 sebelum open). */
  openedAt: number;
  /** Epoch ms aktivitas terakhir (kirim/terima). */
  lastActivityAt: number;
}

interface PendingRequest {
  match: (pkt: NetPacket) => boolean;
  resolve: (pkt: NetPacket | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

function payloadLength(data: any): number {
  if (data == null) return 0;
  if (typeof data === "string") return data.length;
  if (Buffer.isBuffer(data)) return data.length;
  try {
    return JSON.stringify(data)?.length ?? 0;
  } catch (_e) {
    return 0;
  }
}

function tryParseJsonValue(
  value: any,
): { ok: true; value: any } | { ok: false } {
  if (typeof value !== "string") return { ok: false };
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch (_e) {
    return { ok: false };
  }
}

export class NetSocket {
  /**
   * Event: ada data masuk (aktif kalau diisi — recv() manual tidak dipakai).
   * Boleh async; loop internal menunggu handler selesai sebelum paket berikutnya
   * sehingga urutan terjaga tanpa queue manual.
   */
  public onData: ((pkt: NetPacket) => void | Promise<void>) | null = null;
  /**
   * Event JSON: dipanggil kalau payload bisa di-parse sebagai JSON. Paket
   * non-JSON tetap dikirim ke `onData` (jika diisi).
   */
  public onJson: ((value: any, pkt: NetPacket) => void | Promise<void>) | null =
    null;
  /** Event: socket siap dipakai (setelah open + autoSecure). */
  public onOpen: (() => void) | null = null;
  /** Event: terjadi error (kecuali error saat close() normal). */
  public onError: ((err: Error) => void) | null = null;
  /** Event: socket sudah ditutup (port dilepas + security dinormalisasi). */
  public onClose: ((reason?: string) => void) | null = null;

  private readonly portWanted: number;
  private readonly iface?: string;
  private key: string | null = null;
  private psk: string | null = null;
  private binary: boolean;
  private protocolName?: string;
  private readonly autoCleanup: boolean;
  private readonly autoSecure: boolean;
  private readonly preferredAgent?: string;
  private secured = false;
  private pskActive = false;
  private agentName: string = "chacha20";
  private closedReason?: string;
  private readonly pendingRequests: PendingRequest[] = [];
  private readonly statsData: NetSocketStats = {
    sent: 0,
    received: 0,
    bytesSent: 0,
    bytesReceived: 0,
    errors: 0,
    openedAt: 0,
    lastActivityAt: 0,
  };

  private fd: number = -1;
  private opened = false;
  private closed = false;
  private boundPort: number | null = null;
  private loopRunning = false;
  private closeListeners: Array<() => void> = [];

  constructor(opts: NetSocketOptions) {
    if (opts == null || typeof opts.port !== "number") {
      throw new Error(
        "NetSocket: opsi 'port' wajib diisi (angka). Contoh: new NetSocket({ port: 2500 })",
      );
    }
    this.portWanted = opts.port;
    this.iface = opts.iface;
    this.key = opts.key ?? null;
    this.psk = opts.psk ?? null;
    this.binary = opts.binary ?? false;
    this.protocolName = opts.protocol;
    this.autoCleanup = opts.autoCleanup !== false;
    this.autoSecure = opts.autoSecure === true;
    this.preferredAgent = opts.agent;
  }

  /** Port lokal yang berhasil di-bind (null sebelum open()). */
  get port(): number | null {
    return this.boundPort;
  }

  /** True selama socket terbuka dan belum di-close(). */
  get isOpen(): boolean {
    return this.opened && !this.closed;
  }

  /**
   * Ambil `NetworkLib` (low-level) dari UserLib thread ini — sama seperti
   * @tsix/Application mengakses `global._tsixLib` (menghindari circular import).
   */
  private get lib(): NetworkLib {
    const lib = (global as any)._tsixLib;
    if (!lib?.net) {
      throw new Error(
        "NetSocket: 'net' (NetworkLib) tidak tersedia di thread ini",
      );
    }
    return lib.net as NetworkLib;
  }

  /**
   * open(): Buka socket — socket() + bind() (+ protocol biner bila diminta)
   * + auto-cleanup + memulai recv-loop event-driven kalau `onData` diisi.
   * Security TIDAK di-upgrade di sini — pakai `upgradeSecurity()`.
   */
  public async open(): Promise<this> {
    if (this.opened) throw new Error("NetSocket: socket sudah dibuka");

    const lib = this.lib;

    const fd = await lib.socket();
    if (fd < 0) throw new Error("NetSocket: gagal membuat socket");
    this.fd = fd;

    // bind() return port ASLI yang ter-bind. Kalau portWanted = 0 (ephemeral),
    // ini port random yang dipilih kernel — dipakai untuk per-srcPort security.
    const actualPort = await lib.bind(fd, this.portWanted, this.iface);
    if (!actualPort) {
      await lib.close(fd).catch(() => {});
      this.fd = -1;
      throw new Error(
        `NetSocket: gagal bind port ${this.portWanted}${this.iface ? ` (${this.iface})` : ""}`,
      );
    }

    // NOTE: Security TIDAK di-upgrade otomatis di sini — aplikasi yang mau
    // mode aman memanggil `upgradeSecurity(key)` secara eksplisit, sehingga
    // bisa mulai plain dulu lalu switch ke ChaCha20-Poly1305 (mis. setelah
    // handshake / pertukaran session key).

    // Wire protocol PER-PORT dipin eksplisit (ioctl 0x1002) — supaya pilihan
    // `binary`/`protocol` deterministik dan TIDAK ikut di-override
    // `protocolRegistry` (protocol "terakhir dipakai" peer). Resolusi nama:
    //   - opsi `protocol` ("Binfeo" | "Binary" | "JSON" | ...) → nama itu
    //   - selain itu, `binary: true` → "Binary" (OTA plain/bypass enkripsi)
    //   - default (`binary: false` / kosong) → "JSON" (text JSON, bisa dienkripsi)
    const wireProto = this.protocolName || (this.binary ? "Binary" : "JSON");
    await lib.ioctl(fd, SMQTNL_IOCTL.SET_BINARY_MODE, {
      port: actualPort,
      protocol: wireProto,
    });

    this.opened = true;
    this.boundPort = actualPort;
    this.statsData.openedAt = Date.now();
    this.statsData.lastActivityAt = this.statsData.openedAt;

    try {
      if (this.autoSecure) {
        const securityOptions = this.preferredAgent
          ? { agent: this.preferredAgent }
          : undefined;
        if (this.psk) await this.upgradePsk(undefined, securityOptions);
        else if (this.key) {
          await this.upgradeSecurity(undefined, securityOptions);
        } else {
          throw new Error(
            "NetSocket: autoSecure butuh opsi 'key' atau 'psk'",
          );
        }
      }
    } catch (error) {
      await this.close("autoSecure gagal");
      throw error;
    }

    if (this.autoCleanup) this.armAutoCleanup();
    if (this.onData || this.onJson) this.startLoop();
    this.onOpen?.();

    return this;
  }

  /** listen(): Alias `open()` — secara semantik untuk server yang menunggu data. */
  public async listen(): Promise<this> {
    return await this.open();
  }

  /** True kalau port sudah di-upgrade ke mode aman. */
  get isSecured(): boolean {
    return this.secured;
  }

  /** Nama agent enkripsi yang aktif (default "chacha20", di-set saat upgradeSecurity). */
  get agent(): string {
    return this.agentName;
  }

  /** True setelah close() dipanggil. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Alasan close() (jika ada). */
  get closeReason(): string | undefined {
    return this.closedReason;
  }

  /** Statistik ringkas socket (salinan, aman diubah pemanggil). */
  get stats(): NetSocketStats {
    return { ...this.statsData };
  }

  /** Wire protocol per-port yang sedang dipakai. */
  get protocol(): string | undefined {
    return this.protocolName;
  }

  /** Reset penghitung statistik (openedAt/lastActivityAt ikut di-reset). */
  public resetStats(): void {
    this.statsData.sent = 0;
    this.statsData.received = 0;
    this.statsData.bytesSent = 0;
    this.statsData.bytesReceived = 0;
    this.statsData.errors = 0;
    this.statsData.openedAt = this.isOpen ? Date.now() : 0;
    this.statsData.lastActivityAt = this.statsData.openedAt;
  }

  /**
   * upgradeSecurity(key?, opts?): Upgrade port ke mode aman.
   *
   * Eksplisit — TIDAK dilakukan otomatis oleh open(). Berguna kalau aplikasi
   * mau mulai plain dulu lalu switch ke secure (mis. setelah pertukaran key
   * handshake). Key bisa dari opsi `key` saat konstruksi atau argumen di sini.
   * Opsi `agent` memilih jenis enkripsi (default "chacha20"; custom agent via
   * SimpleMQTNLDriver.registerAgent — contoh built-in: "aes-gcm").
   */
  public async upgradeSecurity(
    key?: string,
    opts?: NetSocketSecurityOptions,
  ): Promise<this> {
    this.ensureOpen();
    const sessionKey = key ?? this.key;
    if (!sessionKey) {
      throw new Error(
        "NetSocket: tidak ada session key — berikan argumen atau set opsi 'key'",
      );
    }
    // Key dipasang ke port ASLI yang ter-bind — krusial untuk port ephemeral
    // (port 0): kalau pakai portWanted = 0, session key nyasar ke port 0.
    const securePort = this.boundPort ?? this.portWanted;
    await this.lib.ioctl(this.fd, SMQTNL_IOCTL.UPGRADE_SECURITY, {
      port: securePort,
      sessionKey,
      ...(opts?.agent ? { agent: opts.agent } : {}),
    });
    this.key = sessionKey;
    this.secured = true;
    this.pskActive = false;
    this.agentName = opts?.agent ?? "chacha20";
    return this;
  }

  /** True kalau enkripsi aktif dan session key diturunkan dari PSK. */
  get isPsk(): boolean {
    return this.pskActive;
  }

  /**
   * upgradePsk(): Aktifkan ChaCha20-Poly1305 dengan session key yang diturunkan
   * dari pre-shared key. TX dan RX tinggal memakai PSK yang sama — tanpa RSA,
   * tanpa handshake, tanpa bertukar session key.
   *
   * PSK boleh berupa passphrase bebas atau 64 karakter hex. Derivasi memakai
   * HKDF-SHA256 (info "TSIX-NETSOCKET-PSK-v1"), jadi hasilnya 32 byte acak
   * yang deterministik untuk PSK yang sama.
   *
   * ⚠️ Ini kunci statis per-PSK (tanpa forward secrecy). Cocok untuk jaringan
   * tepercaya; untuk koneksi publik gunakan `upgradeSecurity()` dengan session
   * key hasil handshake.
   */
  public async upgradePsk(
    psk?: string,
    opts?: NetSocketSecurityOptions,
  ): Promise<this> {
    this.ensureOpen();
    const shared = psk ?? this.psk;
    if (!shared) {
      throw new Error(
        "NetSocket: PSK belum diisi — berikan argumen atau set opsi 'psk'",
      );
    }
    await this.upgradeSecurity(NetSocket.derivePskSessionKey(shared), opts);
    this.psk = shared;
    this.pskActive = true;
    return this;
  }

  /**
   * derivePskSessionKey(): Turunkan session key 32-byte (hex) dari PSK.
   * Passphrase di-hash sebagai UTF-8; string 64-hex dipakai sebagai byte mentah.
   */
  public static derivePskSessionKey(psk: string): string {
    if (typeof psk !== "string" || psk.length === 0) {
      throw new Error("NetSocket: PSK wajib berupa string non-kosong");
    }
    const ikm = /^[0-9a-f]{64}$/i.test(psk)
      ? Buffer.from(psk, "hex")
      : Buffer.from(psk, "utf8");
    const derived = crypto.hkdfSync(
      "sha256",
      ikm,
      Buffer.alloc(0),
      Buffer.from("TSIX-NETSOCKET-PSK-v1", "utf8"),
      32,
    );
    return Buffer.from(derived).toString("hex");
  }

  /** sendJson(): Kirim objek sebagai JSON (otomatis JSON.stringify). */
  public async sendJson(
    address: string,
    port: number,
    value: any,
    flag: PacketFlags = PacketFlags.FLAG_DATA,
    srcPort?: number,
  ): Promise<boolean> {
    return await this.sendTo(
      address,
      port,
      JSON.stringify(value),
      flag,
      srcPort,
    );
  }

  /** ping(): Kirim MQTNL PING_REQUEST ke address:port (default port 65535). */
  public async ping(
    address: string,
    port: number = 65535,
    payload: string = "PING_REQ_V1",
  ): Promise<boolean> {
    return await this.sendTo(
      address,
      port,
      payload,
      PacketFlags.FLAG_PING_REQUEST,
    );
  }

  /**
   * discover(): Broadcast PING untuk menemukan node (port 65534, alamat "*").
   * Balasan node datang lewat onData/onJson dengan flag BROADCAST_REPLY.
   */
  public async discover(payload: string = "TSIX_DISCOVERY"): Promise<boolean> {
    return await this.sendTo(
      "*",
      65534,
      payload,
      PacketFlags.FLAG_BROADCAST_PING,
    );
  }

  /** setProtocol(): Ganti wire protocol per-port saat socket terbuka. */
  public async setProtocol(protocol: string): Promise<this> {
    this.ensureOpen();
    await this.lib.ioctl(this.fd, SMQTNL_IOCTL.SET_BINARY_MODE, {
      port: this.boundPort ?? this.portWanted,
      protocol,
    });
    this.protocolName = protocol;
    return this;
  }

  /** setBinary(): Shortcut setProtocol("Binary"|"JSON"). */
  public async setBinary(enabled: boolean = true): Promise<this> {
    this.binary = enabled;
    return await this.setProtocol(enabled ? "Binary" : "JSON");
  }

  /** listAgents(): Nama semua encryption agent yang terdaftar di kernel. */
  public async listAgents(): Promise<string[]> {
    return await this.lib.listAgents();
  }

  /**
   * request(): Kirim data lalu tunggu satu balasan yang cocok.
   *
   * Matcher default: paket dari `address:port` yang sama. Return `null` jika
   * timeout atau pengiriman gagal. Loop internal dijalankan otomatis (tidak
   * boleh dicampur dengan `recv()` manual).
   */
  public async request(
    address: string,
    port: number,
    data: any,
    opts: {
      timeoutMs?: number;
      match?: (pkt: NetPacket) => boolean;
      flag?: PacketFlags;
    } = {},
  ): Promise<NetPacket | null> {
    this.ensureOpen();
    this.ensureLoop();

    const timeoutMs = opts.timeoutMs ?? 5000;
    const match =
      opts.match ??
      ((pkt: NetPacket) => pkt.src === address && pkt.port === port);

    let entry!: PendingRequest;
    const reply = new Promise<NetPacket | null>((resolve) => {
      const timer = setTimeout(() => {
        const index = this.pendingRequests.indexOf(entry);
        if (index >= 0) this.pendingRequests.splice(index, 1);
        resolve(null);
      }, timeoutMs);
      entry = { match, resolve, timer };
      this.pendingRequests.push(entry);
    });

    const sent = await this.sendTo(address, port, data, opts.flag);
    if (!sent) {
      clearTimeout(entry.timer);
      const index = this.pendingRequests.indexOf(entry);
      if (index >= 0) this.pendingRequests.splice(index, 1);
      return null;
    }
    return await reply;
  }

  /** sendTo(): Kirim data dari socket ini ke address:port tujuan. */
  public async sendTo(
    address: string,
    port: number,
    data: any,
    flag: PacketFlags = PacketFlags.FLAG_DATA,
    srcPort?: number,
  ): Promise<boolean> {
    this.ensureOpen();
    const sent = await this.lib.sendTo(
      this.fd,
      address,
      port,
      data,
      flag,
      srcPort ?? this.boundPort ?? 0,
    );
    if (sent) {
      this.statsData.sent += 1;
      this.statsData.bytesSent += payloadLength(data);
      this.statsData.lastActivityAt = Date.now();
    }
    return sent;
  }

  /** reply(): Balas balik ke pengirim paket (shortcut sendTo ke pkt.src:pkt.port). */
  public async reply(
    pkt: NetPacket,
    data: any,
    flag: PacketFlags = PacketFlags.FLAG_DATA,
  ): Promise<boolean> {
    return await this.sendTo(pkt.src, pkt.port, data, flag);
  }

  /** replyJson(): Balas pengirim paket dengan objek JSON. */
  public async replyJson(
    pkt: NetPacket,
    value: any,
    flag: PacketFlags = PacketFlags.FLAG_DATA,
  ): Promise<boolean> {
    return await this.reply(pkt, JSON.stringify(value), flag);
  }

  /**
   * recv(): Baca satu paket manual (blocking).
   * Hanya boleh dipakai kalau `onData` TIDAK diisi (mode event vs manual).
   */
  public async recv(): Promise<NetPacket | null> {
    if (this.loopRunning) {
      throw new Error(
        "NetSocket: mode event (onData) aktif — gunakan onData, bukan recv()",
      );
    }
    this.ensureOpen();
    return await this.lib.recv(this.fd);
  }

  /** netstat(): Info interface MQTNL + statistik. */
  public async netstat(): Promise<any> {
    return await this.lib.netstat();
  }

  /**
   * close(): Tutup socket — idempotent. Kernel melepas port dari PortManager,
   * membatalkan handler (unregisterHandler) dan membersihkan security agent
   * (unregisterPortSecurity). Aman dipanggil berulang.
   */
  public async close(reason: string = "closed"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.opened = false;
    this.pskActive = false;
    this.closedReason = reason;
    for (const pending of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this.pendingRequests.length = 0;

    if (this.fd >= 0) {
      const fd = this.fd;
      this.fd = -1;
      try {
        await this.lib.close(fd);
      } catch (_e) {
        // fd sudah ditutup / tidak valid — abaikan, lifecycle tetap bersih
      }
    }

    this.emitClose(this.closedReason);
  }

  /**
   * waitClosed(): Promise yang resolve saat socket ditutup (close() dipanggil).
   *
   * Berguna menjaga proses tetap hidup selama socket terbuka, karena WorkerEntry
   * langsung exit(0) begitu main() return. Contoh:
   *
   *   await sock.open();
   *   await sock.waitClosed();   // main menunggu sampai socket ditutup
   */
  public async waitClosed(): Promise<void> {
    if (this.closed) return;
    await new Promise<void>((resolve) => {
      this.closeListeners.push(resolve);
    });
  }

  /** Reconstruct Buffer dari payload paket (delegasi ke NetworkLib.toBuffer). */
  public static toBuffer(payload: any): Buffer {
    return NetworkLib.toBuffer(payload);
  }

  /** Pastikan socket sudah dibuka sebelum operasi I/O. */
  private ensureOpen(): void {
    if (!this.isOpen) {
      throw new Error("NetSocket: socket belum dibuka (panggil open() dulu)");
    }
  }

  /** Daftarkan auto-cleanup SIGINT/SIGTERM → close + exit (mirip default OS). */
  private armAutoCleanup(): void {
    try {
      const shell = (global as any)._tsixLib?.shell;
      if (!shell || typeof shell.onSignal !== "function") return;

      const closeAndExit = (sig: string) => {
        const code = sig === "SIGINT" ? 130 : 143;
        this.close()
          .then(() => shell.exit(code))
          .catch(() => shell.exit(code));
      };

      shell.onSignal("SIGINT", () => closeAndExit("SIGINT"));
      shell.onSignal("SIGTERM", () => closeAndExit("SIGTERM"));
    } catch (_e) {
      // signal belum tersedia → cleanup tetap bisa dilakukan manual via close()
    }
  }

  /** Mulai loop kalau belum berjalan (dipakai onData/onJson/request()). */
  private ensureLoop(): void {
    if (this.isOpen && !this.loopRunning) this.startLoop();
  }

  /** Jalankan recv-loop event-driven — mendispatch paket ke onJson/onData. */
  private startLoop(): void {
    if (this.loopRunning) return;
    this.loopRunning = true;

    const loop = async () => {
      while (this.isOpen) {
        try {
          const pkt = await this.lib.recv(this.fd);
          if (!pkt) continue;

          this.statsData.received += 1;
          this.statsData.bytesReceived += payloadLength(pkt.data);
          this.statsData.lastActivityAt = Date.now();
          this.settlePendingRequests(pkt);

          try {
            await this.dispatchPacket(pkt);
          } catch (e) {
            this.emitError(e);
          }
        } catch (err) {
          if (this.closed) break; // close() → fd sudah ditutup, bukan error
          this.emitError(err);
          break;
        }
      }
      this.loopRunning = false;
    };

    // fire-and-forget — loop berjalan di background sampai close()
    loop().catch((e) => this.emitError(e));
  }

  private async dispatchPacket(pkt: NetPacket): Promise<void> {
    if (this.onJson) {
      const parsed = tryParseJsonValue(pkt.data);
      if (parsed.ok) {
        await this.onJson(parsed.value, pkt);
        return;
      }
    }
    if (this.onData) await this.onData(pkt);
  }

  private settlePendingRequests(pkt: NetPacket): void {
    for (let i = this.pendingRequests.length - 1; i >= 0; i--) {
      const request = this.pendingRequests[i];
      if (!request.match(pkt)) continue;
      clearTimeout(request.timer);
      this.pendingRequests.splice(i, 1);
      request.resolve(pkt);
    }
  }

  private emitError(err: any): void {
    this.statsData.errors += 1;
    if (!this.onError) return;
    try {
      this.onError(err instanceof Error ? err : new Error(String(err)));
    } catch (_e) {
      /* jangan biarkan handler user merusak loop */
    }
  }

  /** Panggil semua listener close (public onClose + internal waitClosed). */
  private emitClose(reason?: string): void {
    if (this.onClose) {
      try {
        this.onClose(reason);
      } catch (_e) {
        /* jangan biarkan handler user merusak close() */
      }
    }
    const listeners = this.closeListeners;
    this.closeListeners = [];
    for (const l of listeners) {
      try {
        l();
      } catch (_e) {
        /* abaikan */
      }
    }
  }
}

/** Peran socket dalam handshake RSA + ChaCha20. */
export type RsaChaRole = "server" | "client";

export interface RsaChaSocketOptions extends NetSocketOptions {
  /** Server menunggu client; client otomatis menghubungi peer ini. */
  role: RsaChaRole;
  /** Tujuan handshake dan pengiriman data untuk role `client`. */
  peer?: { address: string; port: number };
  /**
   * Fingerprint public key server yang dipercaya (16 karakter SHA-256 uppercase).
   * Jika diisi pada client, koneksi dibatalkan sebelum key exchange saat tidak cocok.
   */
  trustedFingerprint?: string;
  /** Callback verifikasi interaktif sebelum key exchange (mis. prompt yes/no). */
  verifyFingerprint?: (fingerprint: string) => boolean | Promise<boolean>;
  /** RSA key pair server yang stabil agar fingerprint tidak berubah saat restart. */
  keyPair?: { publicKey: string; privateKey: string };
}

/**
 * Event-driven socket dengan handshake RSA-OAEP + ChaCha20-Poly1305 bawaan.
 *
 * Server:
 *   const sock = new RsaChaSocket({ role: "server", port: 2600 });
 *   sock.onMessage = (message, packet) => sock.reply(packet, `echo: ${message}`);
 *   await sock.open();
 *
 * Client:
 *   const sock = new RsaChaSocket({
 *     role: "client", port: 2601, peer: { address: "localhost", port: 2600 },
 *     trustedFingerprint: "A1B2C3D4E5F60718",
 *   });
 *   sock.onMessage = (message) => std.println(message);
 *   await sock.open(); // selesai setelah channel aman aktif
 *   await sock.send("hello");
 */
export class RsaChaSocket {
  public onMessage: ((message: string, packet: NetPacket) => void) | null =
    null;
  public onReady: (() => void) | null = null;
  public onError: ((err: Error) => void) | null = null;
  public onClose: (() => void) | null = null;

  private readonly role: RsaChaRole;
  private readonly peer?: { address: string; port: number };
  private readonly socket: NetSocket;
  private readonly keyPair: { publicKey: string; privateKey: string } | null;
  private readonly trustedFingerprint?: string;
  private readonly verifyFingerprint?: (
    fingerprint: string,
  ) => boolean | Promise<boolean>;
  private readonly serverFingerprint: string | null;
  private ready = false;
  private readyResolve!: () => void;
  private readyReject!: (err: Error) => void;
  private readonly readyPromise: Promise<void>;

  private static readonly REQUEST_KEY = "1";
  private static readonly PUBLIC_KEY = "2";
  private static readonly SECRET_KEY = "3";
  private static readonly MESSAGE = "4";

  constructor(opts: RsaChaSocketOptions) {
    if (opts.role !== "server" && opts.role !== "client") {
      throw new Error("RsaChaSocket: role harus 'server' atau 'client'");
    }
    if (opts.role === "client" && (!opts.peer || !opts.peer.address)) {
      throw new Error(
        "RsaChaSocket: opsi peer { address, port } wajib untuk client",
      );
    }

    this.role = opts.role;
    this.peer = opts.peer;
    this.socket = new NetSocket(opts);
    this.keyPair =
      this.role === "server"
        ? (opts.keyPair ?? SecurityAgent.generateKeyPair())
        : null;
    this.trustedFingerprint = opts.trustedFingerprint
      ?.replace(/^SHA256:/i, "")
      .toUpperCase();
    this.verifyFingerprint = opts.verifyFingerprint;
    this.serverFingerprint = this.keyPair
      ? SecurityAgent.getFingerprint(this.keyPair.publicKey)
      : null;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.socket.onData = (packet) => this.handlePacket(packet);
    this.socket.onError = (err) => this.emitError(err);
    this.socket.onClose = () => {
      if (!this.ready)
        this.readyReject(
          new Error("RsaChaSocket: socket ditutup sebelum handshake selesai"),
        );
      this.onClose?.();
    };
  }

  get port(): number | null {
    return this.socket.port;
  }

  get isOpen(): boolean {
    return this.socket.isOpen;
  }

  get isSecured(): boolean {
    return this.ready;
  }

  /** Fingerprint SHA-256 public key server (16 karakter uppercase). */
  get fingerprint(): string | null {
    return this.serverFingerprint;
  }

  /** Buka socket dan jalankan handshake otomatis. Client menunggu sampai ready. */
  public async open(): Promise<this> {
    await this.socket.open();
    if (this.role === "client") {
      await this.socket.sendTo(
        this.peer!.address,
        this.peer!.port,
        RsaChaSocket.REQUEST_KEY,
      );
      await this.waitReady();
    }
    return this;
  }

  /** Alias semantik untuk server. */
  public async listen(): Promise<this> {
    return await this.open();
  }

  /** Tunggu sampai RSA selesai dan ChaCha20 aktif. */
  public async waitReady(): Promise<void> {
    await this.readyPromise;
  }

  /** Kirim pesan aman ke peer client. */
  public async send(
    message: string,
    flag: PacketFlags = PacketFlags.FLAG_DATA,
  ): Promise<boolean> {
    if (!this.peer) {
      throw new Error(
        "RsaChaSocket: send() membutuhkan peer; gunakan sendTo() atau reply() di server",
      );
    }
    await this.waitReady();
    return await this.socket.sendTo(
      this.peer.address,
      this.peer.port,
      RsaChaSocket.MESSAGE + message,
      flag,
    );
  }

  /** Kirim pesan aman ke address:port tertentu, terutama untuk server. */
  public async sendTo(
    address: string,
    port: number,
    message: string,
    flag: PacketFlags = PacketFlags.FLAG_DATA,
  ): Promise<boolean> {
    await this.waitReady();
    return await this.socket.sendTo(
      address,
      port,
      RsaChaSocket.MESSAGE + message,
      flag,
    );
  }

  /** Balas pesan aman ke pengirim packet. */
  public async reply(
    packet: NetPacket,
    message: string,
    flag: PacketFlags = PacketFlags.FLAG_DATA,
  ): Promise<boolean> {
    await this.waitReady();
    return await this.socket.reply(
      packet,
      RsaChaSocket.MESSAGE + message,
      flag,
    );
  }

  public async close(): Promise<void> {
    await this.socket.close();
  }

  public async waitClosed(): Promise<void> {
    await this.socket.waitClosed();
  }

  private async handlePacket(packet: NetPacket): Promise<void> {
    const text = String(packet.data);
    const opcode = text.charAt(0);
    const body = text.slice(1);

    try {
      if (
        this.role === "server" &&
        !this.ready &&
        opcode === RsaChaSocket.REQUEST_KEY
      ) {
        await this.socket.reply(
          packet,
          RsaChaSocket.PUBLIC_KEY +
            this.keyPair!.publicKey +
            "::" +
            this.serverFingerprint,
        );
        return;
      }

      if (
        this.role === "server" &&
        !this.ready &&
        opcode === RsaChaSocket.SECRET_KEY
      ) {
        const sessionKey = SecurityAgent.decryptWithPrivateKey(
          this.keyPair!.privateKey,
          body,
        );
        await this.socket.upgradeSecurity(sessionKey.toString("hex"));
        this.markReady();
        return;
      }

      if (
        this.role === "client" &&
        !this.ready &&
        opcode === RsaChaSocket.PUBLIC_KEY
      ) {
        const [serverPublicKey, fingerprint] = body.split("::");
        const normalizedFingerprint = fingerprint?.trim().toUpperCase();
        if (!normalizedFingerprint) {
          throw new Error("RsaChaSocket: server tidak mengirim fingerprint");
        }
        const calculatedFingerprint =
          SecurityAgent.getFingerprint(serverPublicKey);
        if (calculatedFingerprint !== normalizedFingerprint) {
          throw new Error(
            "RsaChaSocket: fingerprint tidak cocok dengan public key server",
          );
        }
        if (
          this.trustedFingerprint &&
          this.trustedFingerprint !== normalizedFingerprint
        ) {
          throw new Error(
            `RsaChaSocket: fingerprint server tidak cocok (expected ${this.trustedFingerprint}, received ${normalizedFingerprint})`,
          );
        }
        if (
          !this.trustedFingerprint &&
          this.verifyFingerprint &&
          !(await this.verifyFingerprint(normalizedFingerprint))
        ) {
          throw new Error("RsaChaSocket: koneksi ditolak oleh user");
        }

        const sessionKey = SecurityAgent.generateSessionKey();
        const encryptedKey = SecurityAgent.encryptWithPublicKey(
          serverPublicKey,
          sessionKey,
        );
        await this.socket.sendTo(
          this.peer!.address,
          this.peer!.port,
          RsaChaSocket.SECRET_KEY + encryptedKey,
        );
        await this.socket.upgradeSecurity(sessionKey.toString("hex"));
        this.markReady();
        return;
      }

      if (this.ready && opcode === RsaChaSocket.MESSAGE) {
        await this.onMessage?.(body, packet);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (!this.ready) {
        this.readyReject(error);
        await this.socket.close();
      }
      this.emitError(error);
    }
  }

  private markReady(): void {
    if (this.ready) return;
    this.ready = true;
    this.readyResolve();
    this.onReady?.();
  }

  private emitError(err: Error): void {
    try {
      this.onError?.(err);
    } catch (_e) {
      // User handlers must not break the receive loop.
    }
  }
}

// ============================================================
// PSK SOCKET — handshake PSK tanpa RSA
// ============================================================

export type PskRole = "server" | "client";

export interface PskSocketOptions extends NetSocketOptions {
  role: PskRole;
  /** Pre-shared key: passphrase bebas atau 64 karakter hex. */
  psk: string;
  /** Tujuan handshake & data untuk role client. */
  peer?: { address: string; port: number };
  /** Batas waktu handshake client (ms). Default 8000. */
  handshakeTimeoutMs?: number;
}

const PSK_OP_HELLO = "H";
const PSK_OP_CHALLENGE = "C";
const PSK_OP_AUTH = "A";
const PSK_OP_READY = "K";
const PSK_OP_MESSAGE = "M";

function hmacSha256Hex(key: Buffer, text: string): string {
  return crypto.createHmac("sha256", key).update(text, "utf8").digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a.toLowerCase(), "hex");
  const bb = Buffer.from(b.toLowerCase(), "hex");
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString("hex");
}

function isHexNonce(value: string): boolean {
  return /^[0-9a-f]{32}$/i.test(value);
}

/**
 * PSK SOCKET — handshake nonce + HMAC, lalu ChaCha20-Poly1305.
 *
 * Beda dengan `NetSocket.upgradePsk()` (kunci statis), PskSocket menurunkan
 * session key unik per koneksi dari PSK + nonce kedua sisi, dan saling
 * membuktikan identitas lewat HMAC (mutual auth). Tidak butuh RSA.
 *
 * Server:
 *   const sock = new PskSocket({ role: "server", port: 2600, psk: "rahasia" });
 *   sock.onMessage = (msg, pkt) => sock.reply(pkt, `echo: ${msg}`);
 *   await sock.open();
 *
 * Client:
 *   const sock = new PskSocket({
 *     role: "client", port: 2601, psk: "rahasia",
 *     peer: { address: "localhost", port: 2600 },
 *   });
 *   sock.onMessage = (msg) => std.println(msg);
 *   await sock.open();   // selesai setelah channel aman aktif
 *   await sock.send("hello");
 */
export class PskSocket {
  public onMessage: ((message: string, packet: NetPacket) => void) | null = null;
  public onReady: (() => void) | null = null;
  public onError: ((err: Error) => void) | null = null;
  public onClose: (() => void) | null = null;

  private readonly role: PskRole;
  private readonly peer?: { address: string; port: number };
  private readonly socket: NetSocket;
  private readonly handshakeKey: Buffer;
  private readonly handshakeTimeoutMs: number;
  private ready = false;
  private clientNonce = "";
  private serverNonce = "";
  private readyResolve!: () => void;
  private readyReject!: (err: Error) => void;
  private readonly readyPromise: Promise<void>;

  constructor(opts: PskSocketOptions) {
    if (opts.role !== "server" && opts.role !== "client") {
      throw new Error("PskSocket: role harus 'server' atau 'client'");
    }
    if (opts.role === "client" && (!opts.peer || !opts.peer.address)) {
      throw new Error("PskSocket: opsi peer { address, port } wajib untuk client");
    }
    if (!opts.psk) {
      throw new Error("PskSocket: opsi 'psk' wajib diisi");
    }

    this.role = opts.role;
    this.peer = opts.peer;
    this.handshakeKey = PskSocket.deriveHandshakeKey(opts.psk);
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 8000;
    this.socket = new NetSocket({
      ...opts,
      autoSecure: false,
      psk: undefined,
      key: undefined,
    });
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.socket.onData = (packet) => this.handlePacket(packet);
    this.socket.onError = (err) => this.emitError(err);
    this.socket.onClose = () => {
      if (!this.ready) {
        this.readyReject(
          new Error("PskSocket: socket ditutup sebelum handshake selesai"),
        );
      }
      this.onClose?.();
    };
  }

  /** Turunkan kunci handshake 32 byte dari PSK (HKDF-SHA256). */
  public static deriveHandshakeKey(psk: string): Buffer {
    const ikm = /^[0-9a-f]{64}$/i.test(psk)
      ? Buffer.from(psk, "hex")
      : Buffer.from(psk, "utf8");
    return Buffer.from(
      crypto.hkdfSync(
        "sha256",
        ikm,
        Buffer.alloc(0),
        Buffer.from("TSIX-NETSOCKET-PSK-HANDSHAKE-v1", "utf8"),
        32,
      ),
    );
  }

  get port(): number | null {
    return this.socket.port;
  }

  get isOpen(): boolean {
    return this.socket.isOpen;
  }

  /** True setelah handshake selesai dan channel terenkripsi aktif. */
  get isSecured(): boolean {
    return this.ready;
  }

  get stats(): NetSocketStats {
    return this.socket.stats;
  }

  /** Buka socket; client menunggu sampai handshake selesai. */
  public async open(): Promise<this> {
    await this.socket.open();
    if (this.role === "client") {
      this.clientNonce = randomHex(16);
      this.serverNonce = "";
      await this.socket.sendTo(
        this.peer!.address,
        this.peer!.port,
        PSK_OP_HELLO + this.clientNonce,
      );
      try {
        await this.waitReady(this.handshakeTimeoutMs);
      } catch (error) {
        await this.socket.close("handshake timeout");
        throw error;
      }
    }
    return this;
  }

  /** Alias semantik untuk server. */
  public async listen(): Promise<this> {
    return await this.open();
  }

  /** Tunggu sampai handshake selesai & enkripsi aktif (opsional timeout). */
  public async waitReady(timeoutMs?: number): Promise<void> {
    if (timeoutMs === undefined) {
      await this.readyPromise;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.readyPromise,
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("PskSocket: handshake timeout")),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Kirim pesan aman ke peer client. */
  public async send(
    message: string,
    flag: PacketFlags = PacketFlags.FLAG_DATA,
  ): Promise<boolean> {
    if (!this.peer) {
      throw new Error(
        "PskSocket: send() membutuhkan peer; gunakan sendTo()/reply() di server",
      );
    }
    await this.waitReady();
    return await this.socket.sendTo(
      this.peer.address,
      this.peer.port,
      PSK_OP_MESSAGE + message,
      flag,
    );
  }

  /** Kirim pesan aman ke address:port tertentu (terutama untuk server). */
  public async sendTo(
    address: string,
    port: number,
    message: string,
    flag: PacketFlags = PacketFlags.FLAG_DATA,
  ): Promise<boolean> {
    await this.waitReady();
    return await this.socket.sendTo(
      address,
      port,
      PSK_OP_MESSAGE + message,
      flag,
    );
  }

  /** Balas pesan aman ke pengirim packet. */
  public async reply(
    packet: NetPacket,
    message: string,
    flag: PacketFlags = PacketFlags.FLAG_DATA,
  ): Promise<boolean> {
    await this.waitReady();
    return await this.socket.reply(packet, PSK_OP_MESSAGE + message, flag);
  }

  public async close(reason: string = "closed"): Promise<void> {
    await this.socket.close(reason);
  }

  public async waitClosed(): Promise<void> {
    await this.socket.waitClosed();
  }

  private async handlePacket(packet: NetPacket): Promise<void> {
    const text = String(packet.data);
    const opcode = text.charAt(0);
    const body = text.slice(1);

    try {
      if (this.role === "server" && !this.ready && opcode === PSK_OP_HELLO) {
        if (!isHexNonce(body)) {
          throw new Error("PskSocket: clientNonce tidak valid");
        }
        this.clientNonce = body.toLowerCase();
        this.serverNonce = randomHex(16);
        const proof = this.proof("SERVER", this.serverNonce);
        await this.socket.reply(
          packet,
          `${PSK_OP_CHALLENGE}${this.serverNonce}|${proof}`,
        );
        return;
      }

      if (this.role === "server" && !this.ready && opcode === PSK_OP_AUTH) {
        if (!this.clientNonce || !this.serverNonce) {
          throw new Error("PskSocket: challenge belum dikirim");
        }
        const expected = this.proof("CLIENT", this.serverNonce);
        if (!safeEqualHex(body, expected)) {
          throw new Error("PskSocket: client proof tidak cocok");
        }
        // READY dikirim plaintext dulu, baru port di-upgrade.
        await this.socket.reply(packet, PSK_OP_READY);
        await this.socket.upgradeSecurity(this.sessionKeyHex());
        this.markReady();
        return;
      }

      if (this.role === "client" && !this.ready && opcode === PSK_OP_CHALLENGE) {
        const [serverNonce, serverProof] = body.split("|");
        if (!serverNonce || !isHexNonce(serverNonce) || !serverProof) {
          throw new Error("PskSocket: challenge server tidak valid");
        }
        this.serverNonce = serverNonce.toLowerCase();
        const expected = this.proof("SERVER", this.serverNonce);
        if (!safeEqualHex(serverProof, expected)) {
          throw new Error("PskSocket: server proof tidak cocok (PSK salah?)");
        }
        await this.socket.sendTo(
          this.peer!.address,
          this.peer!.port,
          PSK_OP_AUTH + this.proof("CLIENT", this.serverNonce),
        );
        return;
      }

      if (this.role === "client" && !this.ready && opcode === PSK_OP_READY) {
        await this.socket.upgradeSecurity(this.sessionKeyHex());
        this.markReady();
        return;
      }

      if (this.ready && opcode === PSK_OP_MESSAGE) {
        await this.onMessage?.(body, packet);
      }
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private proof(label: "SERVER" | "CLIENT", serverNonce: string): string {
    return hmacSha256Hex(
      this.handshakeKey,
      `TSIX-NETSOCKET-PSK-${label}|${this.clientNonce}|${serverNonce}`,
    );
  }

  private sessionKeyHex(): string {
    const salt = Buffer.from(
      `${this.clientNonce}|${this.serverNonce}`,
      "utf8",
    );
    const derived = crypto.hkdfSync(
      "sha256",
      this.handshakeKey,
      salt,
      Buffer.from("TSIX-NETSOCKET-PSK-SESSION-v1", "utf8"),
      32,
    );
    return Buffer.from(derived).toString("hex");
  }

  private markReady(): void {
    if (this.ready) return;
    this.ready = true;
    this.readyResolve();
    this.onReady?.();
  }

  private fail(err: Error): void {
    if (!this.ready) this.readyReject(err);
    this.emitError(err);
    void this.socket.close("PSK handshake gagal");
  }

  private emitError(err: Error): void {
    try {
      this.onError?.(err);
    } catch (_e) {
      // User handlers must not break the receive loop.
    }
  }
}

// ============================================================
// NETSOCKET SERVER — satu port, banyak peer, key per-peer
// ============================================================

export interface NetSocketServerOptions {
  port: number;
  iface?: string;
  protocol?: string;
  binary?: boolean;
  autoCleanup?: boolean;
  /** Idle timeout per peer (ms). 0 = nonaktif. Default 5 menit. */
  sessionIdleMs?: number;
}

type PeerAgent = SecurityAgent | AesGcmAgent;

function createPeerAgent(name?: string): PeerAgent {
  if (!name || name === "chacha20") return new SecurityAgent();
  if (name === "aes-gcm") return new AesGcmAgent();
  throw new Error(
    `NetPeerSession: agent '${name}' tidak didukung per-peer (pakai "chacha20" atau "aes-gcm")`,
  );
}

/**
 * Satu peer di dalam `NetSocketServer`.
 *
 * Enkripsi di sini BUKAN lewat kernel (yang hanya mendukung satu key per port
 * lokal), melainkan agent per-peer di userland. Jadi server bisa melayani
 * banyak peer dengan key/PSK berbeda di satu port.
 */
export class NetPeerSession {
  public readonly id: string;
  public readonly address: string;
  public readonly port: number;
  public readonly firstSeen: number = Date.now();
  public lastSeen: number = Date.now();
  /** Metadata bebas milik aplikasi (mis. accountId, dashboardId). */
  public data?: unknown;

  /** Handler payload mentah (string/Buffer). Boleh async. */
  public onData:
    | ((data: any, packet: NetPacket) => void | Promise<void>)
    | null = null;
  /** Handler payload JSON; dipakai kalau payload bisa di-parse. */
  public onJson:
    | ((value: any, packet: NetPacket) => void | Promise<void>)
    | null = null;
  public onError: ((err: Error) => void) | null = null;
  public onClose: (() => void) | null = null;

  private agent: PeerAgent | null = null;
  private agentLabel = "plain";
  private closed = false;

  constructor(
    private readonly server: NetSocketServer,
    private readonly socket: NetSocket,
    packet: NetPacket,
  ) {
    this.address = packet.src;
    this.port = packet.port;
    this.id = `${packet.src}:${packet.port}`;
  }

  get isSecured(): boolean {
    return this.agent !== null;
  }

  get agentName(): string {
    return this.agentLabel;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Aktifkan enkripsi untuk peer ini (session key hex 64 karakter).
   * Agent default "chacha20"; "aes-gcm" juga tersedia.
   */
  public enableSecurity(
    key: string,
    opts: { agent?: string } = {},
  ): this {
    const agent = createPeerAgent(opts.agent);
    agent.setSessionKey(key);
    this.agent = agent;
    this.agentLabel = opts.agent ?? "chacha20";
    return this;
  }

  /** Aktifkan enkripsi dari PSK (diturunkan via HKDF-SHA256). */
  public enablePsk(psk: string, opts: { agent?: string } = {}): this {
    return this.enableSecurity(NetSocket.derivePskSessionKey(psk), opts);
  }

  /** Kirim data ke peer ini (otomatis dienkripsi kalau security aktif). */
  public async send(
    data: any,
    flag: PacketFlags = PacketFlags.FLAG_DATA,
  ): Promise<boolean> {
    if (this.closed) {
      throw new Error("NetPeerSession: sesi sudah ditutup");
    }
    const plain =
      Buffer.isBuffer(data) || typeof data === "string"
        ? data
        : JSON.stringify(data);
    const payload = this.agent ? this.agent.securePacketOut(plain) : plain;
    return await this.socket.sendTo(this.address, this.port, payload, flag);
  }

  /** Kirim objek JSON ke peer ini. */
  public async sendJson(
    value: any,
    flag: PacketFlags = PacketFlags.FLAG_DATA,
  ): Promise<boolean> {
    return await this.send(JSON.stringify(value), flag);
  }

  /** Balas pengirim packet (src/port sudah terikat di sesi). */
  public async reply(
    _packet: NetPacket,
    data: any,
    flag: PacketFlags = PacketFlags.FLAG_DATA,
  ): Promise<boolean> {
    return await this.send(data, flag);
  }

  /** Balas pengirim packet dengan objek JSON. */
  public async replyJson(
    packet: NetPacket,
    value: any,
    flag: PacketFlags = PacketFlags.FLAG_DATA,
  ): Promise<boolean> {
    return await this.reply(packet, JSON.stringify(value), flag);
  }

  /** Tutup sesi (socket server tetap hidup). */
  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
  }

  /** Internal: proses satu paket milik peer ini. */
  public async handle(packet: NetPacket): Promise<void> {
    this.lastSeen = Date.now();
    const text =
      typeof packet.data === "string"
        ? packet.data
        : String(packet.data ?? "");

    let payload: any = text;
    if (this.agent) {
      try {
        payload = this.agent.securePacketIn(text);
      } catch (err) {
        this.emitError(err instanceof Error ? err : new Error(String(err)));
        return;
      }
    }

    if (this.onJson) {
      const parsed = tryParseJsonValue(payload);
      if (parsed.ok) {
        await this.onJson(parsed.value, packet);
        return;
      }
    }
    await this.onData?.(payload, packet);
  }

  private emitError(err: Error): void {
    try {
      this.onError?.(err);
    } catch (_e) {
      // jangan biarkan handler user merusak loop
    }
    this.server.reportSessionError(this, err);
  }
}

/**
 * NETSOCKET SERVER — satu port MQTNL, banyak peer.
 *
 * Cocok untuk server yang butuh key/PSK berbeda per client (mis. dashboard
 * portable). `NetSocket` biasa hanya mendukung satu key per port lokal; kelas
 * ini memakai `NetPeerSession` + agent per-peer di userland.
 *
 * Contoh:
 *   const server = new NetSocketServer({ port: 1515 });
 *   server.onSession = (peer) => {
 *     peer.onJson = (data) => peer.replyJson({ ok: true });
 *     peer.enablePsk("rahasia-bersama");
 *   };
 *   await server.listen();
 */
export class NetSocketServer {
  public onSession: ((session: NetPeerSession) => void) | null = null;
  public onError: ((err: Error) => void) | null = null;
  public onClose: ((reason?: string) => void) | null = null;

  private readonly socket: NetSocket;
  private readonly sessions = new Map<string, NetPeerSession>();
  private readonly sessionIdleMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(opts: NetSocketServerOptions) {
    this.sessionIdleMs = opts.sessionIdleMs ?? 5 * 60 * 1000;
    this.socket = new NetSocket({
      port: opts.port,
      iface: opts.iface,
      protocol: opts.protocol ?? "JSON",
      binary: opts.binary ?? false,
      autoCleanup: opts.autoCleanup ?? false,
      autoSecure: false,
    });

    this.socket.onData = (packet) => this.handlePacket(packet);
    this.socket.onError = (err) => this.emitError(err);
    this.socket.onClose = (reason) => this.handleClose(reason);
  }

  get port(): number | null {
    return this.socket.port;
  }

  get isOpen(): boolean {
    return this.socket.isOpen;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get stats(): NetSocketStats {
    return this.socket.stats;
  }

  /** Salinan daftar sesi aktif. */
  get peers(): NetPeerSession[] {
    return Array.from(this.sessions.values());
  }

  /** Buka socket server dan mulai sweep idle-session. */
  public async listen(): Promise<this> {
    await this.socket.open();
    if (this.sessionIdleMs > 0) {
      const tick = Math.max(250, Math.min(1000, this.sessionIdleMs));
      this.timer = setInterval(() => this.sweepIdle(), tick);
    }
    return this;
  }

  /** Alias `listen()`. */
  public async open(): Promise<this> {
    return await this.listen();
  }

  /** Ambil sesi peer berdasarkan address:port. */
  public session(address: string, port: number): NetPeerSession | undefined {
    return this.sessions.get(`${address}:${port}`);
  }

  public async close(reason: string = "closed"): Promise<void> {
    await this.socket.close(reason);
  }

  public async waitClosed(): Promise<void> {
    await this.socket.waitClosed();
  }

  /** Internal: error dari sesi diteruskan ke onError server. */
  public reportSessionError(session: NetPeerSession, err: Error): void {
    this.emitError(new Error(`[${session.id}] ${err.message}`));
  }

  private async handlePacket(packet: NetPacket): Promise<void> {
    const id = `${packet.src}:${packet.port}`;
    let session = this.sessions.get(id);
    if (!session) {
      session = new NetPeerSession(this, this.socket, packet);
      this.sessions.set(id, session);
      try {
        this.onSession?.(session);
      } catch (err) {
        this.emitError(err instanceof Error ? err : new Error(String(err)));
      }
    }
    await session.handle(packet);
  }

  private sweepIdle(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastSeen > this.sessionIdleMs) {
        this.sessions.delete(id);
        session.close();
      }
    }
  }

  private handleClose(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    this.onClose?.(reason);
  }

  private emitError(err: Error): void {
    try {
      this.onError?.(err);
    } catch (_e) {
      // jangan biarkan handler user merusak loop
    }
  }
}
