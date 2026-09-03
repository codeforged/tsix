var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var stdin_exports = {};
__export(stdin_exports, {
  NetSocket: () => NetSocket,
  NetworkLib: () => NetworkLib,
  SMQTNL_IOCTL: () => SMQTNL_IOCTL
});
module.exports = __toCommonJS(stdin_exports);
var import_SyscallCode = require("../../common/SyscallCode");
var import_PacketFlags = require("../../common/PacketFlags");
const SMQTNL_IOCTL = {
  /** SMQTNL_IOCTL_UPGRADE_SECURITY — aktifkan ChaCha20-Poly1305 per port. */
  UPGRADE_SECURITY: 4097,
  /** SMQTNL_IOCTL_SET_BINARY_MODE — aktifkan protocol biner per port. */
  SET_BINARY_MODE: 4098
};
function resolveDispatch(source) {
  if (typeof source === "function") return source;
  const os = source;
  const d = os.shell.dispatch;
  if (typeof d === "function") return d.bind(os.shell);
  throw new Error("NetworkLib: tidak ada dispatch yang valid dari source");
}
class NetworkLib {
  dispatch;
  constructor(source) {
    this.dispatch = resolveDispatch(source);
  }
  /** socket(): Membuat socket baru, return fd (atau -1 jika gagal). */
  async socket() {
    return await this.dispatch(import_SyscallCode.SyscallCode.SOCKET, null);
  }
  /**
   * bind(): Mengikat socket ke port lokal (address/interface opsional).
   * Return port ASLI yang ter-bind (angka). Kalau `port` = 0, kernel memilih
   * port random yang available dan nilainya dikembalikan di sini — penting
   * untuk per-srcPort encryption (upgradeSecurity). Lempar error kalau gagal.
   */
  async bind(fd, port, address) {
    return await this.dispatch(import_SyscallCode.SyscallCode.BIND, { fd, port, address });
  }
  /** listen(): shortcut socket() + bind() untuk server. Return fd atau -1. */
  async listen(port) {
    const fd = await this.socket();
    const bound = await this.bind(fd, port);
    return bound ? fd : -1;
  }
  /** accept(): Tunggu klien pertama, return pseudo-connection { fd, src, port }. */
  async accept(serverFd) {
    while (true) {
      const pkt = await this.recv(serverFd);
      if (pkt) {
        return {
          fd: serverFd,
          src: pkt.src,
          port: pkt.port,
          localPort: pkt.localPort || 0,
          firstPkt: pkt
        };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  /** sendTo(): Kirim data ke address:port tujuan. */
  async sendTo(fd, address, port, data, flag = import_PacketFlags.PacketFlags.FLAG_DATA, srcPort = 0) {
    return await this.dispatch(import_SyscallCode.SyscallCode.SENDTO, {
      fd,
      address,
      port,
      data,
      flag,
      srcPort
    });
  }
  /** Alias `sendTo` (dipakai sebagian app lama dengan huruf kecil). */
  async sendto(fd, address, port, data, flag = import_PacketFlags.PacketFlags.FLAG_DATA, srcPort = 0) {
    return await this.sendTo(fd, address, port, data, flag, srcPort);
  }
  /** recv(): Baca satu paket (blocking, event-driven di kernel). */
  async recv(fd) {
    return await this.dispatch(import_SyscallCode.SyscallCode.RECVFROM, fd);
  }
  /** recvFrom(): Baca satu paket dengan batas timeout keseluruhan. */
  async recvFrom(fd, timeoutMs = 5e3) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await this.recv(fd);
      if (res) return res;
    }
    return null;
  }
  /** close(): Tutup fd — kernel melepas port + security agent. */
  async close(fd) {
    return await this.dispatch(import_SyscallCode.SyscallCode.CLOSE, fd);
  }
  /** netstat(): Info semua interface MQTNL + statistik. */
  async netstat() {
    return await this.dispatch(import_SyscallCode.SyscallCode.NETSTAT, null);
  }
  /**
   * listAgents(): Nama semua Security Agent enkripsi yang terdaftar di kernel
   * (lihat registri SimpleMQTNLDriver; dipakai tool `secagent`).
   */
  async listAgents() {
    return await this.dispatch(import_SyscallCode.SyscallCode.SECAGENT_LIST, null);
  }
  /**
   * cha20P1305Agent(): Upgrade security ChaCha20-Poly1305 untuk sebuah port
   * (membungkus ioctl SMQTNL_IOCTL.UPGRADE_SECURITY).
   */
  async cha20P1305Agent(fd, port, key) {
    return await this.dispatch(import_SyscallCode.SyscallCode.IOCTL, {
      fd,
      cmd: SMQTNL_IOCTL.UPGRADE_SECURITY,
      arg: { port, sessionKey: key }
    });
  }
  /** ioctl(): Kontrol device tingkat rendah (umumnya tidak perlu oleh user). */
  async ioctl(fd, cmd, arg) {
    return await this.dispatch(import_SyscallCode.SyscallCode.IOCTL, { fd, cmd, arg });
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
  static toBuffer(payload) {
    if (payload == null) return Buffer.alloc(0);
    if (typeof payload === "string") {
      try {
        const parsed = JSON.parse(payload);
        if (parsed && (parsed.type === "Buffer" || typeof parsed[0] === "number")) {
          payload = parsed;
        }
      } catch (_e) {
      }
    }
    if (Buffer.isBuffer(payload)) {
      return payload;
    }
    if (payload && payload.type === "Buffer" && Array.isArray(payload.data)) {
      return Buffer.from(payload.data);
    }
    if (typeof payload === "string") {
      return Buffer.from(payload, "binary");
    }
    return Buffer.alloc(0);
  }
}
class NetSocket {
  /** Event: ada data masuk (aktif kalau diisi — recv() manual tidak dipakai). */
  onData = null;
  /** Event: terjadi error (kecuali error saat close() normal). */
  onError = null;
  /** Event: socket sudah ditutup (port dilepas + security dinormalisasi). */
  onClose = null;
  portWanted;
  iface;
  key = null;
  binary;
  protocol;
  autoCleanup;
  secured = false;
  agentName = "chacha20";
  fd = -1;
  opened = false;
  closed = false;
  boundPort = null;
  loopRunning = false;
  closeListeners = [];
  constructor(opts) {
    if (opts == null || typeof opts.port !== "number") {
      throw new Error(
        "NetSocket: opsi 'port' wajib diisi (angka). Contoh: new NetSocket({ port: 2500 })"
      );
    }
    this.portWanted = opts.port;
    this.iface = opts.iface;
    this.key = opts.key ?? null;
    this.binary = opts.binary ?? false;
    this.protocol = opts.protocol;
    this.autoCleanup = opts.autoCleanup !== false;
  }
  /** Port lokal yang berhasil di-bind (null sebelum open()). */
  get port() {
    return this.boundPort;
  }
  /** True selama socket terbuka dan belum di-close(). */
  get isOpen() {
    return this.opened && !this.closed;
  }
  /**
   * Ambil `NetworkLib` (low-level) dari UserLib thread ini — sama seperti
   * @tsix/Application mengakses `global._tsixLib` (menghindari circular import).
   */
  get lib() {
    const lib = global._tsixLib;
    if (!lib?.net) {
      throw new Error(
        "NetSocket: 'net' (NetworkLib) tidak tersedia di thread ini"
      );
    }
    return lib.net;
  }
  /**
   * open(): Buka socket — socket() + bind() (+ protocol biner bila diminta)
   * + auto-cleanup + memulai recv-loop event-driven kalau `onData` diisi.
   * Security TIDAK di-upgrade di sini — pakai `upgradeSecurity()`.
   */
  async open() {
    if (this.opened) throw new Error("NetSocket: socket sudah dibuka");
    const lib = this.lib;
    const fd = await lib.socket();
    if (fd < 0) throw new Error("NetSocket: gagal membuat socket");
    this.fd = fd;
    const actualPort = await lib.bind(fd, this.portWanted, this.iface);
    if (!actualPort) {
      await lib.close(fd).catch(() => {
      });
      this.fd = -1;
      throw new Error(
        `NetSocket: gagal bind port ${this.portWanted}${this.iface ? ` (${this.iface})` : ""}`
      );
    }
    if (this.binary || this.protocol) {
      await lib.ioctl(fd, SMQTNL_IOCTL.SET_BINARY_MODE, {
        port: actualPort,
        ...this.protocol ? { protocol: this.protocol } : {}
      });
    }
    this.opened = true;
    this.boundPort = actualPort;
    if (this.autoCleanup) this.armAutoCleanup();
    if (this.onData) this.startLoop();
    return this;
  }
  /** listen(): Alias `open()` — secara semantik untuk server yang menunggu data. */
  async listen() {
    return await this.open();
  }
  /** True kalau port sudah di-upgrade ke mode aman. */
  get isSecured() {
    return this.secured;
  }
  /** Nama agent enkripsi yang aktif (default "chacha20", di-set saat upgradeSecurity). */
  get agent() {
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
  async upgradeSecurity(key, opts) {
    this.ensureOpen();
    const sessionKey = key ?? this.key;
    if (!sessionKey) {
      throw new Error(
        "NetSocket: tidak ada session key \u2014 berikan argumen atau set opsi 'key'"
      );
    }
    const securePort = this.boundPort ?? this.portWanted;
    await this.lib.ioctl(this.fd, SMQTNL_IOCTL.UPGRADE_SECURITY, {
      port: securePort,
      sessionKey,
      ...opts?.agent ? { agent: opts.agent } : {}
    });
    this.key = sessionKey;
    this.secured = true;
    this.agentName = opts?.agent ?? "chacha20";
    return this;
  }
  /** sendTo(): Kirim data dari socket ini ke address:port tujuan. */
  async sendTo(address, port, data, flag = import_PacketFlags.PacketFlags.FLAG_DATA, srcPort) {
    this.ensureOpen();
    return await this.lib.sendTo(
      this.fd,
      address,
      port,
      data,
      flag,
      srcPort ?? this.boundPort ?? 0
    );
  }
  /** reply(): Balas balik ke pengirim paket (shortcut sendTo ke pkt.src:pkt.port). */
  async reply(pkt, data, flag = import_PacketFlags.PacketFlags.FLAG_DATA) {
    return await this.sendTo(pkt.src, pkt.port, data, flag);
  }
  /**
   * recv(): Baca satu paket manual (blocking).
   * Hanya boleh dipakai kalau `onData` TIDAK diisi (mode event vs manual).
   */
  async recv() {
    if (this.loopRunning) {
      throw new Error(
        "NetSocket: mode event (onData) aktif \u2014 gunakan onData, bukan recv()"
      );
    }
    this.ensureOpen();
    return await this.lib.recv(this.fd);
  }
  /** netstat(): Info interface MQTNL + statistik. */
  async netstat() {
    return await this.lib.netstat();
  }
  /**
   * close(): Tutup socket — idempotent. Kernel melepas port dari PortManager,
   * membatalkan handler (unregisterHandler) dan membersihkan security agent
   * (unregisterPortSecurity). Aman dipanggil berulang.
   */
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.opened = false;
    if (this.fd >= 0) {
      const fd = this.fd;
      this.fd = -1;
      try {
        await this.lib.close(fd);
      } catch (_e) {
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
  async waitClosed() {
    if (this.closed) return;
    await new Promise((resolve) => {
      this.closeListeners.push(resolve);
    });
  }
  /** Reconstruct Buffer dari payload paket (delegasi ke NetworkLib.toBuffer). */
  static toBuffer(payload) {
    return NetworkLib.toBuffer(payload);
  }
  /** Pastikan socket sudah dibuka sebelum operasi I/O. */
  ensureOpen() {
    if (!this.isOpen) {
      throw new Error("NetSocket: socket belum dibuka (panggil open() dulu)");
    }
  }
  /** Daftarkan auto-cleanup SIGINT/SIGTERM → close + exit (mirip default OS). */
  armAutoCleanup() {
    try {
      const shell = global._tsixLib?.shell;
      if (!shell || typeof shell.onSignal !== "function") return;
      const closeAndExit = (sig) => {
        const code = sig === "SIGINT" ? 130 : 143;
        this.close().then(() => shell.exit(code)).catch(() => shell.exit(code));
      };
      shell.onSignal("SIGINT", () => closeAndExit("SIGINT"));
      shell.onSignal("SIGTERM", () => closeAndExit("SIGTERM"));
    } catch (_e) {
    }
  }
  /** Jalankan recv-loop event-driven — mendispatch paket ke `onData`. */
  startLoop() {
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
          if (this.closed) break;
          this.emitError(err);
          break;
        }
      }
      this.loopRunning = false;
    };
    loop().catch((e) => this.emitError(e));
  }
  emitError(err) {
    if (!this.onError) return;
    try {
      this.onError(err instanceof Error ? err : new Error(String(err)));
    } catch (_e) {
    }
  }
  /** Panggil semua listener close (public onClose + internal waitClosed). */
  emitClose() {
    if (this.onClose) {
      try {
        this.onClose();
      } catch (_e) {
      }
    }
    const listeners = this.closeListeners;
    this.closeListeners = [];
    for (const l of listeners) {
      try {
        l();
      } catch (_e) {
      }
    }
  }
}
