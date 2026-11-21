import { Program, std, fs, shell, NetSocket } from "@tsix/Application";
import { NetFSServer } from "@common/netfs/NetFSServer";
import { NetFSBackend } from "@tsix/NetFSBackend";
import {
    NETFS_DEFAULT_CLIENT_PORT,
    NETFS_DEFAULT_PORT,
    NETFS_TYPE_REQUEST,
    NETFS_TYPE_RESPONSE,
    NETFS_WIRE_PROTOCOL,
    encodeNetFSResponse,
    parseNetFSSpec,
    patchNetFSFrameId,
    readNetFSFrameHeader,
    toNetFSBuffer,
} from "@common/netfs/NetFSProtocol";

/**
 * NETFSD — NetFS daemon (Server Listener + Client proxy)
 *
 * Satu binary, dua peran:
 *
 *  1) `netfsd --export <path>`   → SL di node STORAGE HOST (SH).
 *     Menyulap folder/filesystem lokal jadi export NetFS yang bisa di-mount
 *     node lain. Semua I/O lewat <b>NetSocket</b> (MQTNL), jadi tidak butuh
 *     IP publik / sewa VPS — cukup berada di broker yang sama.
 *
 *  2) `netfsd --client --to <addr[:port]>` → daemon KLIEN.
 *     Jembatan untuk mount di sisi klien: kernel bicara ke daemon ini lewat
 *     MQTNL loopback (localhost), daemon meneruskan ke SL di SH, lalu
 *     mengembalikan balasannya. Manfaatnya: seluruh urusan jaringan tetap di
 *     userland (NetSocket), dan driver VFS di kernel tetap tipis.
 *
 * WIRE: **Binfeo** (`mqtnl@1.2/`) dengan frame BINER NetFS v2 — tanpa JSON,
 * tanpa base64. Konten file lewat sebagai byte mentah, jadi tidak lagi
 * menggelembung 4/3x (base64) lalu 2x lagi (hex saat ada `--key`).
 *
 * Contoh:
 *   # Di node storage host (SH):
 *   root@tsix_2# netfsd --export /mnt/shared --label shared --port 7777 --ro
 *
 *   # Di node klien:
 *   root@tsix# netfsd --client --to tsix_2:7777 --port 7778
 *   root@tsix# mount /mnt/net --netfs tsix_2:7777 --via 7778 --ro
 *
 * Tanpa daemon klien pun bisa: `mount /mnt/net --netfs tsix_2:7777 --direct`
 * (kernel langsung bicara ke SL).
 *
 * (c) 2026 TSIX Project
 */

const KEY_HEX_RE = /^[0-9a-f]{64}$/i;
const PENDING_TTL_MS = 30000;

interface CommonOpts {
    port: number;
    iface?: string;
    key?: string;
    agent?: string;
    debug: boolean;
}

/** Ambil nilai setelah flag (`--port 7777`). */
function valueOf(args: string[], flag: string): string | undefined {
    const idx = args.indexOf(flag);
    if (idx === -1) return undefined;
    const v = args[idx + 1];
    return v && !v.startsWith("--") ? v : undefined;
}

function hasFlag(args: string[], ...flags: string[]): boolean {
    return flags.some((f) => args.includes(f));
}

/** Validasi key: salah panjang = gagal cepat, bukan timeout misterius nanti. */
function normalizeKey(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    const key = raw.trim();
    if (!KEY_HEX_RE.test(key)) {
        throw new Error(`netfsd: key harus 64 karakter hex (32 byte). Diterima: ${key.length} karakter.`);
    }
    return key;
}

function parseCommon(args: string[], defaultPort: number): CommonOpts {
    const portRaw = valueOf(args, "--port");
    const port = portRaw ? Number(portRaw) : defaultPort;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`netfsd: port tidak valid: ${portRaw}`);
    }
    return {
        port,
        iface: valueOf(args, "--iface"),
        key: normalizeKey(valueOf(args, "--key")),
        agent: valueOf(args, "--agent"),
        debug: hasFlag(args, "--debug", "-d"),
    };
}

/**
 * safeParse(): Ambil frame biner dari payload MQTNL (payload liar dari
 * jaringan).
 *
 * WAJIB lewat `toNetFSBuffer()`: bentuk payload bergantung jalur — Buffer dari
 * kernel, `Uint8Array` lewat IPC userland, atau string saat Binfeo berjalan
 * tanpa session key tapi isinya kebetulan valid UTF-8. Menebak-nebak bentuknya
 * adalah penyebab klasik request yang dibuang diam-diam.
 */
function frameOf(raw: any): Buffer | null {
    return toNetFSBuffer(raw);
}

const HELP = `NetFS daemon — filesystem lewat MQTNL (tanpa IP publik)

Usage:
  netfsd --export <path> [opsi]              Server Listener (SL) di node storage host
  netfsd --client --to <addr[:port]> [opsi]  Daemon klien (jembatan mount kernel)
  netfsd --help

Opsi umum:
  --port <n>        Port MQTNL lokal (export: ${NETFS_DEFAULT_PORT}, client: ${NETFS_DEFAULT_CLIENT_PORT})
  --iface <nama>    Interface MQTNL lokal (default: interface default kernel)
  --key <64 hex>    Aktifkan enkripsi (ChaCha20-Poly1305) — WAJIB sama di kedua sisi
  --agent <nama>    Jenis agent enkripsi (default: chacha20; alternatif: aes-gcm)
  --debug, -d       Jalan di foreground (jangan daemonize)

Khusus --export:
  --label <nama>    Nama export yang muncul di 'netfs info' (default: path)
  --ro              Paksa read-only (dipaksa di SH, bukan percaya klien)
  --allow <a,b>     Batasi klien berdasarkan alamat MQTNL (mis. --allow tsix,tsix_2)
`;

export const main = Program(async (args) => {
    if (args.length === 0 || hasFlag(args, "--help", "-h")) {
        await std.print(HELP);
        return;
    }

    const isClient = hasFlag(args, "--client");
    const isExport = hasFlag(args, "--export");

    if (isClient && isExport) {
        await std.print("netfsd: pilih salah satu — --export atau --client.\n");
        return;
    }
    if (!isClient && !isExport) {
        await std.print("netfsd: butuh --export <path> atau --client --to <addr>.\n\n" + HELP);
        return;
    }

    return isClient ? await runClient(args) : await runExport(args);
});

// ==================== MODE EXPORT (SL) ====================

async function runExport(args: string[]): Promise<string | void> {
    const attachArg = valueOf(args, "--export");
    if (!attachArg) {
        await std.print("netfsd: --export butuh path folder/filesystem lokal.\n");
        return;
    }

    const opts = parseCommon(args, NETFS_DEFAULT_PORT);
    const attach = attachArg.startsWith("/") ? attachArg : `/${attachArg}`;

    // Validasi cepat: export harus ada & direktori.
    const node = await fs.stat(attach).catch(() => null);
    if (!node) {
        await std.print(`netfsd: export '${attach}' tidak ditemukan.\n`);
        return;
    }
    if (node.type !== "DIRECTORY") {
        await std.print(`netfsd: export '${attach}' bukan direktori.\n`);
        return;
    }

    const label = valueOf(args, "--label") ?? attach;
    const readOnly = hasFlag(args, "--ro");
    const allow = (valueOf(args, "--allow") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

    const backend = new NetFSBackend(fs, {
        root: attach,
        logger: { warn: (m) => void std.log(`warn: ${m}`, "netfsd") },
    });
    const server = new NetFSServer(backend, {
        prefix: attach,
        readOnly,
        label,
        allow,
        logger: {
            warn: (m) => void std.log(`warn: ${m}`, "netfsd"),
            info: (m) => void std.log(m, "netfsd"),
        },
    });

    const sock = new NetSocket({
        port: opts.port,
        iface: opts.iface,
        key: opts.key,
        // EKSPLISIT Binfeo: SL NetFS v2 berbicara frame BINER (mqtnl@1.2/). Walau
        // NetSocket sudah mem-pin protocol saat open(), menyebutkannya di sini
        // bikin kontrak wire terlihat dari daemon-nya — dan mencegah port ini
        // mewarisi framing node (JSON/Binfeo/OTA milik aplikasi lain).
        protocol: NETFS_WIRE_PROTOCOL,
        autoCleanup: true,
    });
    sock.onError = (err) => void std.log(`error: ${err.message}`, "netfsd");

    // SL: tiap paket = satu request; balasan = satu frame biner (reply ke pengirim).
    sock.onData = (pkt: any) => {
        void (async () => {
            try {
                const res = await server.handle(pkt.data, { src: pkt.src });
                await sock.reply(pkt, encodeNetFSResponse(res));
            } catch (err: any) {
                await std.log(`gagal memproses request dari ${pkt.src}: ${err.message}`, "netfsd");
            }
        })();
    };

    await sock.open();
    if (opts.key) await sock.upgradeSecurity(opts.key, { agent: opts.agent });

    await std.print(
        `netfsd: export '${attach}' siap${readOnly ? " (read-only)" : ""} di port ${sock.port}` +
            `${opts.key ? " [terenkripsi]" : " [plain]"}${allow.length ? ` — allow: ${allow.join(",")}` : ""}\n`,
    );
    await std.log(`SL aktif: ${attach} → port ${opts.port} (label=${label}${readOnly ? ", ro" : ""})`, "netfsd");

    if (!opts.debug) await shell.daemonize("NetFS Server");

    await keepAlive((tick) => {
        if (tick % 300 === 0) {
            void std.log(`status: ${JSON.stringify(server.stats)}`, "netfsd");
        }
    });
}

// ==================== MODE KLIEN (PROXY) ====================

async function runClient(args: string[]): Promise<string | void> {
    const to = valueOf(args, "--to");
    if (!to) {
        await std.print("netfsd --client: butuh --to <addr[:port]> (alamat node SH).\n");
        return;
    }

    const opts = parseCommon(args, NETFS_DEFAULT_CLIENT_PORT);
    const target = parseNetFSSpec(to);

    // Socket A: menghadap kernel (mount lokal). Port tetap supaya mount tahu ke mana.
    const local = new NetSocket({
        port: opts.port,
        iface: opts.iface,
        key: opts.key,
        // EKSPLISIT Binfeo (lihat catatan di mode export): jangan bergantung pada
        // protocol default node — port ini wajib biner supaya relay & kernel selalu
        // sepakat soal framing, apa pun trafik lain yang lewat di node ini.
        protocol: NETFS_WIRE_PROTOCOL,
        autoCleanup: true,
    });

    // Socket B: ke SL di SH (port ephemeral — kernel memilih).
    const upstream = new NetSocket({
        port: 0,
        iface: opts.iface,
        key: opts.key,
        protocol: NETFS_WIRE_PROTOCOL,
        autoCleanup: true,
    });

    local.onError = (err) => void std.log(`error(local): ${err.message}`, "netfsd");
    upstream.onError = (err) => void std.log(`error(upstream): ${err.message}`, "netfsd");

    // id request → pemanggil (kernel) yang menunggu jawaban.
    //
    // PENTING: relay memakai id SENDIRI (naik monoton) untuk tiap request yang
    // diteruskan ke SH, lalu memulihkan id asli milik kernel saat membalas.
    // Alasannya: setiap driver NetFS di kernel memulai hitungan id dari 1, jadi
    // kalau dua mount berbagi satu daemon klien, id mereka akan bentrok dan
    // balasan bisa salah rute. Dengan id unik relay, aman untuk banyak mount.
    //
    // Di v2 ini MURAH: frame biner menaruh `id` di offset tetap, jadi relay cukup
    // menambal 4 byte di header — tidak ada `JSON.parse` + `JSON.stringify` untuk
    // setiap payload besar seperti di v1.
    let relaySeq = 0;
    const pending: Map<number, { src: string; port: number; originalId: number; at: number }> = new Map();

    // Balasan dari SH → kembalikan ke kernel lewat socket lokal (id dipulihkan).
    upstream.onData = (pkt: any) => {
        const frame = frameOf(pkt.data);
        const header = frame ? readNetFSFrameHeader(frame) : null;
        if (!frame || !header || header.type !== NETFS_TYPE_RESPONSE) return;

        const requester = pending.get(header.id);
        if (!requester) return; // balasan telat / tidak dikenal
        pending.delete(header.id);

        void local
            .sendTo(requester.src, requester.port, patchNetFSFrameId(frame, requester.originalId))
            .catch(() => {});
    };

    // Request dari kernel → teruskan ke SH dengan id relay (hanya header disentuh).
    local.onData = (pkt: any) => {
        const frame = frameOf(pkt.data);
        const header = frame ? readNetFSFrameHeader(frame) : null;
        if (!frame || !header || header.type !== NETFS_TYPE_REQUEST) return;

        const relayId = ++relaySeq;
        pending.set(relayId, {
            src: pkt.src,
            port: pkt.port,
            originalId: header.id,
            at: Date.now(),
        });

        void upstream.sendTo(target.address, target.port, patchNetFSFrameId(frame, relayId)).catch(async (err: any) => {
            pending.delete(relayId);
            await std.log(`gagal meneruskan ke ${target.address}: ${err.message}`, "netfsd");
        });
    };

    await local.open();
    await upstream.open();
    if (opts.key) {
        await local.upgradeSecurity(opts.key, { agent: opts.agent });
        await upstream.upgradeSecurity(opts.key, { agent: opts.agent });
    }

    await std.print(
        `netfsd: jembatan klien aktif — localhost:${local.port} ⇄ ${target.address}:${target.port}` +
            `${opts.key ? " [terenkripsi]" : " [plain]"}\n`,
    );
    await std.log(`client proxy: port ${local.port} → ${target.address}:${target.port}`, "netfsd");

    if (!opts.debug) await shell.daemonize("NetFS Client");

    await keepAlive((tick) => {
        // Buang request yang klien-nya sudah timeout (balasan tak akan datang)
        // supaya tabel `pending` tidak tumbuh terus di daemon yang hidup lama.
        const now = Date.now();
        for (const [id, entry] of pending) {
            if (now - entry.at > PENDING_TTL_MS) pending.delete(id);
        }
        if (tick % 300 === 0) {
            void std.log(`status: ${pending.size} request tertunda`, "netfsd");
        }
    });
}

// ==================== KEEP-ALIVE ====================

/**
 * keepAlive(): Daemon harus tetap hidup selama socket-nya mendengarkan.
 * `onTick` dipanggil tiap detik — dipakai untuk sweep TTL / log status.
 */
async function keepAlive(onTick?: (tick: number) => void): Promise<void> {
    let tick = 0;
    for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        tick++;
        try {
            onTick?.(tick);
        } catch (e) {
            /* tick tidak boleh mematikan daemon */
        }
    }
}
