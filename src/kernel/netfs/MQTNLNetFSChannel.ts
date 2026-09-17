import { Config } from "../../common/Config";
import { Logger } from "../../common/Logger";
import { PacketFlags } from "../../common/PacketFlags";
import { NetFSError } from "../../common/netfs/NetFSProtocol";
import { SimpleMQTNLDriver } from "../devices/SimpleMQTNLDriver";
import type { INetFSChannel } from "../../vfs/NetFS";

/**
 * MQTNLNetFSChannel — sisi KERNEL dari transport NetFS
 *
 * Menghubungkan driver VFS `NetFS` (`src/vfs/NetFS.ts`) ke jaringan MQTNL
 * tanpa membuat proses userland di sisi kernel: socket-nya ditangani langsung
 * oleh driver MQTNL di kernel (port ephemeral + handler, seperti layaknya
 * `bind()` pada syscall).
 *
 * Kenapa MQTNL dan bukan TCP? Karena MQTNL adalah medium network andalan
 * TSIX: routing lewat broker, jadi TIDAK butuh IP publik dan tidak perlu
 * sewa VPS.
 *
 * Dua mode pemakaian:
 *
 *   1. Lewat daemon klien (pola yang disarankan):
 *        address = "localhost", port = <port netfsd --client>
 *      Paket di-loopback di dalam node oleh driver (`findLocal()`), lalu
 *      daemon klien (userland, NetSocket) yang meneruskan ke SH.
 *
 *   2. Langsung ke SL (`--direct`):
 *        address = "tsix_2", port = 7777
 *      Tidak butuh daemon klien, tapi seluruh urusan jaringan ada di kernel.
 *
 * Keduanya memakai class ini — bedanya cuma alamat tujuan.
 *
 * (c) 2026 TSIX Project
 */

export interface MQTNLNetFSChannelOptions {
  /** Alamat MQTNL tujuan (mis. "tsix_2", atau "localhost" untuk daemon klien). */
  address: string;
  /** Port tujuan. */
  port: number;
  /** Interface MQTNL lokal (default: interface default dari sysconfig). */
  iface?: string;
  /** Session key hex (64 char) — aktifkan enkripsi di port lokal ini. */
  key?: string;
  /** Nama agent enkripsi (default chacha20). */
  agent?: string;
  /** Nama proses/owner yang muncul di netstat (default "netfs"). */
  procName?: string;
}

type KernelLike = {
  devices?: Record<string, any>;
  getPortManager?: () => any;
};

export class MQTNLNetFSChannel implements INetFSChannel {
  private readonly driver: SimpleMQTNLDriver;
  private readonly portManager: any;
  private readonly localPort: number;
  private readonly destAddress: string;
  private readonly destPort: number;
  private readonly logger: Logger;

  private handler: ((raw: any) => void) | null = null;
  private closed = false;

  private constructor(
    driver: SimpleMQTNLDriver,
    portManager: any,
    localPort: number,
    opts: MQTNLNetFSChannelOptions,
    logger: Logger,
  ) {
    this.driver = driver;
    this.portManager = portManager;
    this.localPort = localPort;
    this.destAddress = opts.address;
    this.destPort = opts.port;
    this.logger = logger;
  }

  /** Peer yang dituju — dipakai driver NetFS di log/pesan error. */
  public get peer(): string {
    return `${this.destAddress}:${this.destPort}`;
  }

  /** Port MQTNL lokal yang dipakai kernel untuk mount ini. */
  public get port(): number {
    return this.localPort;
  }

  /**
   * open(): Siapkan "socket" kernel untuk NetFS.
   *
   * Langkahnya sengaja sama dengan syscall BIND di userland (alokasi port dari
   * PortManager + registerHandler), hanya saja tanpa PCB karena ini dipakai
   * kernel sendiri.
   */
  public static open(
    kernel: KernelLike,
    opts: MQTNLNetFSChannelOptions,
  ): MQTNLNetFSChannel {
    const logger = new Logger(`NetFSChannel[${opts.address}:${opts.port}]`);

    const driver = MQTNLNetFSChannel.resolveDriver(kernel, opts.iface);
    if (!driver) {
      throw new NetFSError(
        "EIO",
        `netfs: interface MQTNL '${opts.iface ?? "(default)"}' tidak ditemukan`,
      );
    }

    const portManager = kernel.getPortManager?.();
    if (!portManager) {
      throw new NetFSError("EIO", "netfs: PortManager kernel tidak tersedia");
    }

    const localPort = portManager.allocateRandomPort();
    if (!localPort) {
      throw new NetFSError("EIO", "netfs: tidak ada port MQTNL bebas untuk mount");
    }

    const channel = new MQTNLNetFSChannel(
      driver,
      portManager,
      localPort,
      opts,
      logger,
    );

    // Handler didaftarkan SEKARANG (bukan saat onMessage) supaya balasan yang
    // datang sangat cepat tidak hilang sebelum driver NetFS siap.
    driver.registerHandler(localPort, (msg: any) => {
      const raw = msg?.data;
      if (raw === undefined || raw === null || raw === "") return;
      channel.handler?.(raw);
    });
    driver.bindProcess(localPort, opts.procName ?? "netfs");

    // Protocol per-port DI-PIN ke JSON — NetFS selalu berbicara JSON v1.0.
    // Tanpa pin ini, port channel mewarisi `protocolRegistry` (protocol
    // "terakhir dipakai peer/diri sendiri") atau `activeProtocol` global;
    // pernah kejadian request NetFS ikut ter-frame Binfeo karena ada trafik
    // tssh/tsshd di node yang sama → payload sampai sebagai Buffer → dibuang
    // diam-diam oleh netfsd (mount hang sampai timeout).
    driver.ioctl(0x1002, { port: localPort, protocol: "JSON" });

    if (opts.key) {
      // Enkripsi per-port: sisi penerima memakai key yang sama untuk mendekripsi.
      driver.ioctl(0x1001, {
        port: localPort,
        sessionKey: opts.key,
        agent: opts.agent,
      });
    }

    logger.info(
      `channel siap: ${driver.name} port ${localPort} → ${opts.address}:${opts.port}${opts.key ? " [secure]" : ""}`,
    );
    return channel;
  }

  /** Cari driver MQTNL berdasarkan nama device ATAU alamat MQTNL-nya. */
  private static resolveDriver(
    kernel: KernelLike,
    iface?: string,
  ): SimpleMQTNLDriver | null {
    const name = iface ?? Config.get().network.defaultDevice;

    const byName = kernel.devices?.[name];
    if (byName instanceof SimpleMQTNLDriver) return byName;

    // Fallback: interface disebut lewat ALAMAT-nya (mis. "tsix_2").
    const byAddress = SimpleMQTNLDriver.findLocal(name);
    if (byAddress) return byAddress;

    // Terakhir: interface default dari konfigurasi.
    const fallback = kernel.devices?.[Config.get().network.defaultDevice];
    return fallback instanceof SimpleMQTNLDriver ? fallback : null;
  }

  /** onMessage(): Driver NetFS mendaftarkan handler balasan di sini. */
  public onMessage(handler: (raw: any) => void): void {
    this.handler = handler;
  }

  /** send(): Kirim payload request ke peer lewat MQTNL. */
  public async send(payload: string): Promise<boolean> {
    if (this.closed) return false;
    try {
      return await this.driver.send(
        this.destAddress,
        this.destPort,
        payload,
        PacketFlags.FLAG_DATA,
        this.localPort,
      );
    } catch (e: any) {
      this.logger.error(`gagal mengirim ke ${this.peer}: ${e?.message ?? e}`);
      return false;
    }
  }

  /**
   * close(): Lepas port, handler, dan setelan keamanan port ini.
   * Dipanggil saat `umount` — penting supaya tidak bocor port MQTNL dan
   * supaya session key mount lama tidak tertinggal di driver.
   */
  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.handler = null;

    try {
      this.driver.unregisterHandler(this.localPort);
    } catch (e) {
      /* sudah tidak terdaftar — aman diabaikan */
    }
    try {
      this.driver.unregisterPortSecurity(this.localPort);
    } catch (e) {
      /* tidak ada security terpasang — aman diabaikan */
    }
    try {
      // Lepas pin protocol port ini supaya nomor port yang dipakai ulang tidak
      // mewarisi framing lama.
      this.driver.ioctl(0x1002, { port: this.localPort, enabled: false });
    } catch (e) {
      /* pin tidak ada — aman diabaikan */
    }
    this.portManager.releasePort?.(this.localPort);
    this.logger.info(`channel ditutup (port ${this.localPort} dilepas)`);
  }
}
