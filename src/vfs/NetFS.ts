import { Logger } from "../common/Logger";
import type { IVFS } from "./IVFS";
import {
  NETFS_DEFAULT_TIMEOUT_MS,
  NETFS_VERSION,
  NetFSError,
  NetFSExportInfo,
  NetFSOp,
  NetFSRequest,
  NetFSResponse,
  decodeContent,
  netfsErrorCodeOf,
  netfsErrorMessage,
  parseNetFSPayload,
} from "../common/netfs/NetFSProtocol";

/**
 * NetFS — Network Filesystem (driver klien, kernel side)
 *
 * Menjadikan filesystem di node TSIX lain tampil sebagai mount point biasa:
 *
 *   root@tsix# mount /mnt/net --netfs tsix_2:7777 --ro
 *   root@tsix# ls /mnt/net            # dibaca dari SH lewat MQTNL
 *
 * Kenapa MQTNL (bukan TCP/IP)? Karena MQTNL adalah medium network andalan
 * TSIX: routing lewat broker, jadi TIDAK butuh IP publik dan tidak perlu
 * sewa VPS. Cukup dua node berada di broker yang sama.
 *
 * Arsitektur:
 *
 *   app → Syscalls → MountManager.resolve() → NetFS (file ini)
 *                                              │ request/response (id-matched)
 *                                              ▼
 *                                          INetFSChannel   ← transport
 *                                              │
 *                        MQTNL (paket) ────────┘
 *                                              ▼
 *                            netfsd (SL) → NetFSServer → IVFS lokal di SH
 *
 * `INetFSChannel` sengaja jadi seam tipis supaya driver ini tidak tahu apa
 * pun soal MQTNL: implementasi kernel ada di `MQTNLNetFSChannel`, dan test
 * memakai channel in-memory (loopback) tanpa jaringan sama sekali.
 *
 * Catatan performa (penting, sudah diketahui & diterima):
 *   - 1 op = 1 round-trip. Latensi wajar untuk file <500KB, tapi `ls` yang
 *     diikuti banyak `stat` tetap 2x RTT — karena itu ada `cacheTtlMs`.
 *   - Transfer besar WAJIB lewat `readChunk`/`writeChunk` (konten dikirim
 *     base64 per potong), bukan `read()` sekali besar.
 *
 * (c) 2026 TSIX Project
 */

/**
 * INetFSChannel — transport untuk NetFS.
 *
 * Kontraknya sengaja minimal, bukan "client/server library":
 *   - `send()`      : kirim satu payload teks (string JSON) ke peer
 *   - `onMessage()` : daftarkan handler untuk payload yang datang dari peer
 *   - `peer`        : label untuk log/lsblk (mis. "tsix_2:7777")
 *
 * Semua korelasi request/balasan (nomor `id`), timeout, dan cache dikerjakan
 * oleh `NetFS` — channel hanya urusan "sampai/tidak sampai".
 */
export interface INetFSChannel {
  /** Label peer, dipakai di log & `lsblk` (mis. "tsix_2:7777"). */
  readonly peer: string;
  /** Kirim payload (string JSON). Return false kalau gagal kirim. */
  send(payload: string): Promise<boolean> | boolean;
  /** Daftarkan handler untuk payload masuk (sudah didekripsi transport). */
  onMessage(handler: (raw: any) => void): void;
  /** Tutup channel & lepas resource (port MQTNL, dsb). */
  close?(): Promise<void> | void;
}

export interface NetFSOptions {
  /** Transport yang dipakai driver ini. */
  channel: INetFSChannel;
  /** Timeout satu operasi (ms). Default NETFS_DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * TTL cache untuk `ls`/`stat`/`exists` (ms). 0 = mati (default).
   * Cache SELALU dibersihkan begitu ada operasi tulis.
   */
  cacheTtlMs?: number;
  /** TTL cache `getUsage()` (ms) — `df` sering memanggil ini. Default 15s. */
  usageCacheTtlMs?: number;
  /** Paksa read-only di sisi klien (pagar tambahan; SL juga menolak). */
  readOnly?: boolean;
  /** Nama tampilan mount untuk log (default: `channel.peer`). */
  label?: string;
}

interface PendingRequest {
  op: NetFSOp;
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
}

/** Statistik ringan untuk diagnosa (`netfs status`, `lsblk -s`). */
export interface NetFSStats {
  sent: number;
  ok: number;
  failed: number;
  timeouts: number;
  lastRttMs: number;
  pending: number;
}

export class NetFS implements IVFS {
  private readonly channel: INetFSChannel;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly usageCacheTtlMs: number;
  private readonly readOnly: boolean;
  private readonly label: string;
  private readonly logger: Logger;

  private seq = 0;
  private readonly pending: Map<number, PendingRequest> = new Map();
  private readonly cache: Map<string, { at: number; value: any }> = new Map();

  private stale = false;
  private lastOkAt = 0;
  private lastError: string | null = null;
  private closed = false;

  private readonly counters: NetFSStats = {
    sent: 0,
    ok: 0,
    failed: 0,
    timeouts: 0,
    lastRttMs: 0,
    pending: 0,
  };

  constructor(opts: NetFSOptions) {
    if (!opts || !opts.channel) {
      throw new Error("NetFS: opsi 'channel' wajib diisi");
    }
    this.channel = opts.channel;
    this.timeoutMs = opts.timeoutMs ?? NETFS_DEFAULT_TIMEOUT_MS;
    this.cacheTtlMs = opts.cacheTtlMs ?? 0;
    this.usageCacheTtlMs = opts.usageCacheTtlMs ?? 15000;
    this.readOnly = opts.readOnly === true;
    this.label = opts.label ?? opts.channel.peer;
    this.logger = new Logger(`NetFS[${this.label}]`);

    this.channel.onMessage((raw) => this.onMessage(raw));
    this.logger.info(
      `NetFS siap → ${this.channel.peer} (timeout ${this.timeoutMs}ms, cache ${this.cacheTtlMs}ms${this.readOnly ? ", read-only" : ""})`,
    );
  }

  // ==================== DIAGNOSTIK ====================

  /** peer yang sedang dipakai (untuk `lsblk` / pesan error). */
  public get peer(): string {
    return this.channel.peer;
  }

  /**
   * describe(): Identitas mount untuk log/pesan error.
   * Kalau label mount berbeda dari peer (mis. mount point vs node), keduanya
   * ditampilkan supaya operator tahu node mana yang bermasalah.
   */
  private describe(): string {
    return this.label === this.channel.peer
      ? this.channel.peer
      : `${this.label} → ${this.channel.peer}`;
  }

  /** true kalau operasi terakhir gagal/timeout (mount "stale", ala NFS). */
  public get isStale(): boolean {
    return this.stale;
  }

  /** true kalau mount ini read-only. */
  public get isReadOnly(): boolean {
    return this.readOnly;
  }

  /** stats(): hitungan operasi — untuk `netfs status`/debug. */
  public get stats(): NetFSStats {
    return { ...this.counters, pending: this.pending.size };
  }

  /** health(): ringkasan kondisi mount (dipakai `lsblk`/`netfs status`). */
  public health(): {
    peer: string;
    stale: boolean;
    readOnly: boolean;
    lastOkAt: number;
    lastError: string | null;
    stats: NetFSStats;
  } {
    return {
      peer: this.channel.peer,
      stale: this.stale,
      readOnly: this.readOnly,
      lastOkAt: this.lastOkAt,
      lastError: this.lastError,
      stats: this.stats,
    };
  }

  /**
   * handshake(): Ambil metadata export dari SL (op `info`).
   *
   * Dipanggil saat mount supaya `mount --netfs` GAGAL CEPAT kalau peer tidak
   * hidup / bukan netfsd, bukan mengembalikan mount "setengah hidup".
   */
  public async handshake(): Promise<NetFSExportInfo> {
    return await this.rpc<NetFSExportInfo>("info");
  }

  /** close(): Tutup channel + batalkan semua request yang masih menunggu. */
  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const err = new NetFSError(
      "ESTALE",
      `NetFS[${this.describe()}]: mount ditutup`,
    );
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.cache.clear();
    await this.channel.close?.();
    this.logger.info(`NetFS unmounted: ${this.channel.peer}`);
  }

  // ==================== IVFS ====================

  public async ls(path: string): Promise<any[]> {
    const key = `ls:${path}`;
    return await this.withCache(key, this.cacheTtlMs, async () => {
      const result = await this.rpc<any[]>("ls", path);
      return Array.isArray(result) ? result : [];
    });
  }

  public async mkdir(
    path: string,
    uid?: number,
    gid?: number,
    mode?: number,
  ): Promise<boolean> {
    this.guardWrite("mkdir");
    const ok = (await this.rpc<boolean>("mkdir", path, [
      uid ?? null,
      gid ?? null,
      mode ?? null,
    ])) === true;
    this.invalidateCache();
    return ok;
  }

  public async read(path: string): Promise<string | null> {
    return decodeContent(await this.rpc<any>("read", path));
  }

  public async touch(
    path: string,
    content: string = "",
    uid?: number,
    gid?: number,
    mode?: number,
  ): Promise<boolean> {
    this.guardWrite("touch");
    const ok = (await this.rpc<boolean>("touch", path, [
      content,
      uid ?? null,
      gid ?? null,
      mode ?? null,
    ])) === true;
    this.invalidateCache();
    return ok;
  }

  public async stat(path: string): Promise<any> {
    const key = `stat:${path}`;
    return await this.withCache(key, this.cacheTtlMs, async () => {
      return await this.rpc<any>("stat", path);
    });
  }

  public async chmod(path: string, mode: number): Promise<boolean> {
    this.guardWrite("chmod");
    const ok = (await this.rpc<boolean>("chmod", path, [mode])) === true;
    this.invalidateCache();
    return ok;
  }

  public async chown(path: string, uid: number, gid: number): Promise<boolean> {
    this.guardWrite("chown");
    const ok = (await this.rpc<boolean>("chown", path, [uid, gid])) === true;
    this.invalidateCache();
    return ok;
  }

  public async unlink(path: string): Promise<boolean> {
    this.guardWrite("unlink");
    const ok = (await this.rpc<boolean>("unlink", path)) === true;
    this.invalidateCache();
    return ok;
  }

  public async rmdir(path: string): Promise<boolean> {
    this.guardWrite("rmdir");
    const ok = (await this.rpc<boolean>("rmdir", path)) === true;
    this.invalidateCache();
    return ok;
  }

  public async exists(path: string, type?: any): Promise<boolean> {
    return (await this.rpc<boolean>("exists", path, [type ?? null])) === true;
  }

  public async append(path: string, content: string): Promise<boolean> {
    this.guardWrite("append");
    const ok = (await this.rpc<boolean>("append", path, [content])) === true;
    this.invalidateCache();
    return ok;
  }

  public async getUsage(): Promise<{
    size: number;
    files: number;
    dirs: number;
    diskSize?: number;
  }> {
    const result = await this.withCache(
      "usage:/",
      this.usageCacheTtlMs,
      async () => await this.rpc<any>("getUsage"),
    );
    return {
      size: Number(result?.size ?? 0),
      files: Number(result?.files ?? 0),
      dirs: Number(result?.dirs ?? 0),
      diskSize:
        typeof result?.diskSize === "number" ? result.diskSize : undefined,
    };
  }

  public async readChunk(
    path: string,
    offset: number,
    length: number,
  ): Promise<string | null> {
    return decodeContent(await this.rpc<any>("readChunk", path, [offset, length]));
  }

  public async writeChunk(
    path: string,
    chunk: string,
    offset: number,
  ): Promise<boolean> {
    this.guardWrite("writeChunk");
    const ok =
      (await this.rpc<boolean>("writeChunk", path, [chunk, offset])) === true;
    this.invalidateCache();
    return ok;
  }

  public async getSize(path: string): Promise<number> {
    const size = await this.rpc<number>("getSize", path);
    return typeof size === "number" ? size : -1;
  }

  // ==================== INTERNAL ====================

  /** onMessage(): Cocokkan balasan dengan request yang menunggu (by id). */
  private onMessage(raw: any): void {
    // `parseNetFSPayload()` menerima string JSON **dan** Buffer (framing biner)
    // — balasan Buffer tidak boleh dibuang, itu penyebab "mount hang" tanpa error.
    const res: NetFSResponse | null = parseNetFSPayload(raw);
    if (!res) {
      this.logger.warn(`Balasan bukan JSON valid — dibuang.`);
      return;
    }
    if (typeof res.id !== "number") return;

    const p = this.pending.get(res.id);
    if (!p) {
      // Balasan telat (timeout sudah terjadi) — buang diam-diam.
      return;
    }
    this.pending.delete(res.id);
    clearTimeout(p.timer);

    if (res.ok) {
      this.counters.ok++;
      this.counters.lastRttMs = Date.now() - p.startedAt;
      this.stale = false;
      this.lastOkAt = Date.now();
      this.lastError = null;
      p.resolve(res.result);
      return;
    }

    this.counters.failed++;
    const code = res.code ?? netfsErrorCodeOf(res.err);
    const message = `${p.op}: ${res.err ?? "gagal"}`;
    this.lastError = message;
    p.reject(new NetFSError(code, message, p.op));
  }

  /** rpc(): Kirim satu operasi dan tunggu balasannya (dengan timeout). */
  private rpc<T>(op: NetFSOp, path?: string, args?: any[]): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new NetFSError(
          "ESTALE",
          `NetFS[${this.describe()}]: mount sudah ditutup`,
          op,
        ),
      );
    }

    const id = ++this.seq;
    const req: NetFSRequest = { v: NETFS_VERSION, id, op, path, args };
    this.counters.sent++;

    return new Promise<T>((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.counters.timeouts++;
        this.stale = true;
        this.lastError = `${op}: timeout`;
        reject(
          new NetFSError(
            "ETIMEDOUT",
            `NetFS[${this.describe()}]: timeout ${this.timeoutMs}ms pada ${op} ${path ?? ""}`.trim(),
            op,
          ),
        );
      }, this.timeoutMs);
      // Jangan tahan proses hidup hanya karena menunggu balasan FS.
      (timer as any)?.unref?.();

      this.pending.set(id, { op, resolve, reject, timer, startedAt });

      const fail = (err: Error) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      };

      try {
        const sent = this.channel.send(JSON.stringify(req));
        Promise.resolve(sent)
          .then((ok) => {
            if (ok === false) {
              this.counters.failed++;
              this.stale = true;
              fail(
                new NetFSError(
                  "EIO",
                  `NetFS[${this.describe()}]: gagal mengirim ${op} (transport menolak)`,
                  op,
                ),
              );
            }
          })
          .catch((err) => {
            this.counters.failed++;
            this.stale = true;
            fail(
              new NetFSError(
                "EIO",
                `NetFS[${this.describe()}]: ${netfsErrorMessage(err)}`,
                op,
              ),
            );
          });
      } catch (err) {
        this.counters.failed++;
        this.stale = true;
        fail(
          new NetFSError(
            "EIO",
            `NetFS[${this.describe()}]: ${netfsErrorMessage(err)}`,
            op,
          ),
        );
      }
    });
  }

  /** withCache(): Bungkus loader dengan cache TTL (ttl <= 0 → tanpa cache). */
  private async withCache<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
  ): Promise<T> {
    if (ttlMs <= 0) return await loader();

    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) {
      // undefined = "tidak ada" (mis. stat path yang belum ada) juga di-cache.
      return hit.value as T;
    }

    const value = await loader();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  /** guardWrite(): Cegah op tulis saat mount read-only (fail fast). */
  private guardWrite(op: NetFSOp): void {
    if (!this.readOnly) return;
    throw new NetFSError("EROFS", `${op}: mount read-only`, op);
  }

  /** invalidateCache(): Dipanggil setiap op tulis — metadata pasti berubah. */
  private invalidateCache(): void {
    if (this.cache.size > 0) this.cache.clear();
  }
}
