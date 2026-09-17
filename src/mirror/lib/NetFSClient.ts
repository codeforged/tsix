import { NetSocket } from "./NetworkLib";
import {
  NETFS_DEFAULT_TIMEOUT_MS,
  NETFS_VERSION,
  NetFSExportInfo,
  NetFSOp,
  decodeContent,
  parseNetFSSpec,
} from "../../common/netfs/NetFSProtocol";

/**
 * NetFSClient — klien NetFS murni userland di atas NetSocket (MQTNL)
 *
 * Dipakai untuk *diagnosa tanpa mount*: tanya metadata export, lihat daftar
 * isi, atau baca satu file dari node lain — semuanya lewat NetSocket, jadi
 * tidak butuh IP publik dan tidak perlu VFS mount lebih dulu.
 *
 * Untuk pemakaian sehari-hari (file muncul sebagai folder biasa), tetap pakai
 * mount: `mount /mnt/net <addr:port> --netfs`. Modul ini melengkapinya dengan
 * alat periksa cepat sebelum mount.
 *
 * (c) 2026 TSIX Project
 */

export interface NetFSClientOptions {
  /** Interface MQTNL lokal (default: interface default kernel). */
  iface?: string;
  /** Session key hex (64 char) — harus sama dengan netfsd. */
  key?: string;
  /** Nama agent enkripsi (default chacha20). */
  agent?: string;
  /** Timeout satu panggilan (ms). */
  timeoutMs?: number;
}

export interface NetFSCallResult {
  ok: boolean;
  result?: any;
  error?: string;
  code?: string;
  /** Waktu bolak-balik (ms) — berguna untuk mengukur RTT ke node. */
  ms: number;
}

export class NetFSClient {
  /**
   * call(): Kirim satu op NetFS ke SL dan tunggu balasannya.
   *
   * Satu socket per panggilan (stateless) — sederhana dan aman untuk alat
   * diagnosa. Untuk trafik intensif, mount NetFS di kernel yang lebih hemat
   * (socket-nya dipertahankan selama mount hidup).
   */
  public static async call(
    spec: string,
    op: NetFSOp,
    opts: NetFSClientOptions & { path?: string; args?: any[] } = {},
  ): Promise<NetFSCallResult> {
    const started = Date.now();
    const timeoutMs = opts.timeoutMs ?? NETFS_DEFAULT_TIMEOUT_MS;

    let target: { address: string; port: number };
    try {
      target = parseNetFSSpec(spec);
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e), ms: 0 };
    }

    const sock = new NetSocket({
      port: 0, // ephemeral: kernel yang memilih
      iface: opts.iface,
      key: opts.key,
      autoCleanup: true,
    });

    try {
      // Handler dipasang SEBELUM open() supaya recv-loop internal langsung aktif
      // dan balasan yang datang cepat tidak terlewat.
      const reply = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timeout ${timeoutMs}ms (peer tidak merespons)`)),
          timeoutMs,
        );
        sock.onData = (pkt) => {
          const res =
            typeof pkt.data === "string" ? safeParse(pkt.data) : pkt.data;
          if (!res || res.id !== 1) return;
          clearTimeout(timer);
          resolve(res);
        };
      });

      await sock.open();
      if (opts.key) await sock.upgradeSecurity(opts.key, { agent: opts.agent });

      const sent = await sock.sendTo(
        target.address,
        target.port,
        JSON.stringify({
          v: NETFS_VERSION,
          id: 1,
          op,
          path: opts.path,
          args: opts.args,
        }),
      );
      if (!sent) {
        await sock.close();
        return {
          ok: false,
          error: `gagal mengirim ke ${target.address}:${target.port}`,
          ms: Date.now() - started,
        };
      }

      const res = await reply;
      await sock.close();
      return {
        ok: res.ok === true,
        result: res.result,
        error: res.err,
        code: res.code,
        ms: Date.now() - started,
      };
    } catch (e: any) {
      await sock.close().catch(() => {});
      return { ok: false, error: e?.message ?? String(e), ms: Date.now() - started };
    }
  }

  /** probe(): handshake — ambil metadata export (op "info"). */
  public static async probe(
    spec: string,
    opts: NetFSClientOptions = {},
  ): Promise<NetFSCallResult & { info?: NetFSExportInfo }> {
    const res = await NetFSClient.call(spec, "info", opts);
    return { ...res, info: res.ok ? (res.result as NetFSExportInfo) : undefined };
  }

  /** list(): daftar isi direktori export tanpa mount. */
  public static async list(
    spec: string,
    path: string = "/",
    opts: NetFSClientOptions = {},
  ): Promise<NetFSCallResult> {
    return await NetFSClient.call(spec, "ls", { ...opts, path });
  }

  /** readFile(): baca isi file export tanpa mount (konten sudah didekode). */
  public static async readFile(
    spec: string,
    path: string,
    opts: NetFSClientOptions = {},
  ): Promise<NetFSCallResult & { content?: string | null }> {
    const res = await NetFSClient.call(spec, "read", { ...opts, path });
    return { ...res, content: res.ok ? decodeContent(res.result) : undefined };
  }
}

/** Parse JSON payload dari jaringan tanpa melempar. */
function safeParse(raw: any): any {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}
