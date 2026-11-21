import { NetSocket } from "./NetworkLib";
import {
    NETFS_DEFAULT_TIMEOUT_MS,
    NETFS_WIRE_PROTOCOL,
    NetFSExportInfo,
    NetFSOp,
    blobData,
    decodeNetFSResponse,
    encodeNetFSRequest,
    parseNetFSSpec,
    toNetFSBuffer,
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
            // Frame NetFS v2 = biner, jadi wire-nya wajib Binfeo (di-pin eksplisit).
            protocol: NETFS_WIRE_PROTOCOL,
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
                    const frame = toNetFSBuffer(pkt.data);
                    if (!frame) return;
                    let res: any;
                    try {
                        res = decodeNetFSResponse(frame);
                    } catch (e: any) {
                        clearTimeout(timer);
                        reject(e);
                        return;
                    }
                    if (res.id !== 1) return;
                    clearTimeout(timer);
                    resolve(res);
                };
            });

            await sock.open();
            if (opts.key) await sock.upgradeSecurity(opts.key, { agent: opts.agent });

            const frame = encodeNetFSRequest({
                id: 1,
                op,
                path: opts.path,
                args: opts.args,
            });
            const sent = await sock.sendTo(target.address, target.port, frame);
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
        return { ...res, content: res.ok ? blobData(res.result) : undefined };
    }
}
