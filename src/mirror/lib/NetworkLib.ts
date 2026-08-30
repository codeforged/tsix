import { SyscallCode } from "../../common/SyscallCode";
import { PacketFlags } from "../../common/PacketFlags";
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

  /** bind(): Mengikat socket ke port lokal (address/interface opsional). */
  public async bind(
    fd: number,
    port: number,
    address?: string,
  ): Promise<boolean> {
    return await this.dispatch(SyscallCode.BIND, { fd, port, address });
  }

  /** listen(): shortcut socket() + bind() untuk server. Return fd atau -1. */
  public async listen(port: number): Promise<number> {
    const fd = await this.socket();
    const ok = await this.bind(fd, port);
    return ok ? fd : -1;
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
 * Contoh klien (kirim tanpa perlu bind port tetap):
 *
 *   const sock = new NetSocket({ port: 0 });
 *   await sock.open();
 *   await sock.sendTo("leptopus", 1000, "hello");
 *   await sock.close();
 */
export interface NetSocketOptions {
  /**
   * Port lokal untuk bind. WAJIB diisi (angka).
   * Gunakan 0 untuk port ephemeral acak (dikelola kernel).
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
  /** Mode protocol biner per-port (default: false → JSON). */
  binary?: boolean;
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

export class NetSocket {
  /** Event: ada data masuk (aktif kalau diisi — recv() manual tidak dipakai). */
  public onData: ((pkt: NetPacket) => void) | null = null;
  /** Event: terjadi error (kecuali error saat close() normal). */
  public onError: ((err: Error) => void) | null = null;
  /** Event: socket sudah ditutup (port dilepas + security dinormalisasi). */
  public onClose: (() => void) | null = null;

  private readonly portWanted: number;
  private readonly iface?: string;
  private key: string | null = null;
  private readonly binary: boolean;
  private readonly autoCleanup: boolean;
  private secured = false;
  private agentName: string = "chacha20";

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
    this.binary = opts.binary ?? false;
    this.autoCleanup = opts.autoCleanup !== false;
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

    const bound = await lib.bind(fd, this.portWanted, this.iface);
    if (!bound) {
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

    // Protocol biner per-port (dulu magic ioctl 0x1002)
    if (this.binary) {
      await lib.ioctl(fd, SMQTNL_IOCTL.SET_BINARY_MODE, {
        port: this.portWanted,
      });
    }

    this.opened = true;
    this.boundPort = this.portWanted;

    if (this.autoCleanup) this.armAutoCleanup();
    if (this.onData) this.startLoop();

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
    await this.lib.ioctl(this.fd, SMQTNL_IOCTL.UPGRADE_SECURITY, {
      port: this.portWanted,
      sessionKey,
      ...(opts?.agent ? { agent: opts.agent } : {}),
    });
    this.key = sessionKey;
    this.secured = true;
    this.agentName = opts?.agent ?? "chacha20";
    return this;
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
    return await this.lib.sendTo(
      this.fd,
      address,
      port,
      data,
      flag,
      srcPort ?? this.boundPort ?? 0,
    );
  }

  /** reply(): Balas balik ke pengirim paket (shortcut sendTo ke pkt.src:pkt.port). */
  public async reply(
    pkt: NetPacket,
    data: any,
    flag: PacketFlags = PacketFlags.FLAG_DATA,
  ): Promise<boolean> {
    return await this.sendTo(pkt.src, pkt.port, data, flag);
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
  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.opened = false;

    if (this.fd >= 0) {
      const fd = this.fd;
      this.fd = -1;
      try {
        await this.lib.close(fd);
      } catch (_e) {
        // fd sudah ditutup / tidak valid — abaikan, lifecycle tetap bersih
      }
    }

    this.emitClose();
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

  /** Jalankan recv-loop event-driven — mendispatch paket ke `onData`. */
  private startLoop(): void {
    if (this.loopRunning) return;
    this.loopRunning = true;

    const loop = async () => {
      while (this.isOpen) {
        try {
          const pkt = await this.lib.recv(this.fd);
          if (pkt && this.onData) {
            try {
              this.onData(pkt);
            } catch (e) {
              this.emitError(e);
            }
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

  private emitError(err: any): void {
    if (!this.onError) return;
    try {
      this.onError(err instanceof Error ? err : new Error(String(err)));
    } catch (_e) {
      /* jangan biarkan handler user merusak loop */
    }
  }

  /** Panggil semua listener close (public onClose + internal waitClosed). */
  private emitClose(): void {
    if (this.onClose) {
      try {
        this.onClose();
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
