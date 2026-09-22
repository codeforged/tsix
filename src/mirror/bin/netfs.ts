import { Program, fs, std } from "@tsix/Application";
import { NetFSClient } from "@tsix/NetFSClient";
import { blobData } from "@common/netfs/NetFSProtocol";

/**
 * NETFS Utility
 *
 * Alat periksa NetFS (filesystem node TSIX lain lewat MQTNL) — pakai
 * NetSocket langsung, jadi bisa dipakai SEBELUM mount.
 *
 *   netfs info   <addr[:port]>        metadata export (label, ro, prefix, ops)
 *   netfs ls     <addr[:port]> [path] daftar isi export
 *   netfs cat    <addr[:port]> <path> baca satu file
 *   netfs probe  <addr[:port]> <path> lacak per-layer: stat/getSize/read/readChunk
 *   netfs status                      mount netfs aktif + status stale
 *
 * Opsi: --key <64 hex> | --agent <nama> | --iface <nama> | --timeout <ms>
 *
 * (c) 2026 TSIX Project
 */

const HELP = `Usage:
  netfs info   <addr[:port]>         Show export metadata of a NetFS server
  netfs ls     <addr[:port]> [path]  List a directory on the remote export
  netfs cat    <addr[:port]> <path>  Print a remote file
  netfs probe  <addr[:port]> <path>  Trace stat/getSize/read/readChunk (tanpa cetak isi)
  netfs status                       List active NetFS mounts (incl. stale)

Options:
  --key <64 hex>    Session key (must match netfsd --key)
  --agent <name>    Encryption agent (default: chacha20)
  --iface <name>    Local MQTNL interface
  --timeout <ms>    Per-call timeout (default: 5000)

Examples:
  netfs info tsix_2:7777
  netfs ls tsix_2:7777 /docs
  netfs cat tsix_2:7777 /docs/readme.txt
  netfs probe tsix_2:7777 /video.mov
`;

/** valueOf(): Ambil nilai setelah flag (`--key abc` → "abc"). */
function valueOf(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const v = args[idx + 1];
  return v && !v.startsWith("--") ? v : undefined;
}

export default Program(async (args) => {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    await std.print(HELP);
    return;
  }

  const key = valueOf(args, "--key");
  const agent = valueOf(args, "--agent");
  const iface = valueOf(args, "--iface");
  const timeoutRaw = valueOf(args, "--timeout");
  const timeoutMs = timeoutRaw ? parseInt(timeoutRaw, 10) : undefined;
  const opts = { key, agent, iface, timeoutMs };

  const sub = args[0];
  const spec = args[1];

  if (sub === "status") {
    const mounts = await fs.getMounts();
    const netfsMounts = mounts.filter((m) => m.type === "netfs");

    if (netfsMounts.length === 0) {
      await std.print("No active NetFS mounts.\n");
      return;
    }

    await std.println(
      `${"MOUNTPOINT".padEnd(20)} ${"SOURCE".padEnd(28)} ${"OPTS"}`,
    );
    await std.println("-".repeat(62));
    for (const m of netfsMounts) {
      const stale = (m as any).stale ? " (STALE — peer tidak merespons)" : "";
      await std.println(
        `${m.vfsPath.padEnd(20)} ${m.source.padEnd(28)} ${m.readOnly ? "ro" : "rw"}${stale}`,
      );
    }
    return;
  }

  if (!spec) {
    await std.print(`netfs: subcommand '${sub}' butuh alamat node (mis. tsix_2:7777).\n\n` + HELP);
    return;
  }

  if (sub === "info") {
    const res = await NetFSClient.probe(spec, opts);
    if (!res.ok || !res.info) {
      await std.print(
        `netfs: ${spec} tidak merespons (${res.error ?? "unknown"})\n` +
          `  Pastikan 'netfsd --export <path>' jalan di node tersebut.\n`,
      );
      return;
    }
    const info = res.info;
    await std.println(`NetFS export di ${spec}  (RTT ${res.ms}ms)`);
    await std.println(`  label      : ${info.label}`);
    await std.println(`  prefix     : ${info.prefix}`);
    await std.println(`  read-only  : ${info.readOnly ? "yes" : "no"}`);
    await std.println(`  ops        : ${info.ops.length} operasi`);
    return;
  }

  if (sub === "ls") {
    const path = args[2] ?? "/";
    const res = await NetFSClient.list(spec, path, opts);
    if (!res.ok) {
      await std.print(`netfs ls: ${res.code ?? "?"} ${res.error ?? "gagal"}\n`);
      return;
    }
    const entries = Array.isArray(res.result) ? res.result : [];
    await std.println(`${spec}:${path}  (${entries.length} entri, RTT ${res.ms}ms)`);
    for (const e of entries) {
      const kind = e.type === "DIRECTORY" ? "d" : "-";
      const size = String(e.size ?? 0).padStart(8);
      await std.println(`${kind} ${size}  ${e.name}`);
    }
    return;
  }

  if (sub === "probe") {
    // Alat pelacak: op mana yang gagal dan berapa byte yang benar-benar kembali.
    // Dilatari kasus nyata: `cp` file 70 MB dari mount melaporkan SUKSES tapi
    // menghasilkan file 0 byte — perlu dipisahkan apakah yang salah jaringan,
    // SL, atau backend/ekspor di peer.
    const path = args[2];
    if (!path) {
      await std.print("netfs probe: butuh path file.\n");
      return;
    }

    await std.println(`netfs probe → ${spec}  ${path}`);
    await std.println("-".repeat(66));

    // 1. info — handshake + metadata export
    const info = await NetFSClient.probe(spec, opts);
    if (!info.ok || !info.info) {
      await std.println(`  info        GAGAL     ${info.error ?? "tidak merespons"}`);
      return;
    }
    await std.println(
      `  info        ok   ${String(info.ms).padStart(4)}ms  label=${info.info.label} prefix=${info.info.prefix} ro=${info.info.readOnly ? "yes" : "no"} ops=${info.info.ops.length}`,
    );

    // 2. stat — metadata yang dilihat pemanggil mount
    const st = await NetFSClient.call(spec, "stat", { ...opts, path });
    const node: any = st.ok ? st.result : null;
    await std.println(
      st.ok
        ? `  stat        ok   ${String(st.ms).padStart(4)}ms  type=${node?.type ?? "?"} size=${node?.size ?? "?"}`
        : `  stat        ${st.code ?? "GAGAL"}  ${st.error ?? ""}`,
    );

    // 3. getSize — angka mentah; dipakai driver untuk fallback readChunk
    const gs = await NetFSClient.call(spec, "getSize", { ...opts, path });
    const size = gs.ok && typeof gs.result === "number" ? gs.result : -1;
    await std.println(
      gs.ok
        ? `  getSize     ok   ${String(gs.ms).padStart(4)}ms  ${size}`
        : `  getSize     ${gs.code ?? "GAGAL"}  ${gs.error ?? ""}`,
    );

    // 4. read — untuk file besar HARUS ditolak ETOOBIG (pagar balasan 256 KiB)
    const rd = await NetFSClient.call(spec, "read", { ...opts, path });
    if (rd.ok) {
      const body = blobData(rd.result);
      await std.println(`  read        ok   ${String(rd.ms).padStart(4)}ms  ${body === null ? "null" : `${body.length} byte`}`);
    } else {
      await std.println(`  read        ${(rd.code ?? "GAGAL").padEnd(9)} ${String(rd.ms).padStart(4)}ms  ${rd.error ?? ""}`);
    }

    // 5/6. readChunk di kepala & ekor — INI penentu: kalau kosong/pendek,
    //      yang bermasalah backend/ekspor di peer, bukan jaringan.
    const probeChunk = async (label: string, offset: number, length: number) => {
      if (length <= 0) return;
      const res = await NetFSClient.call(spec, "readChunk", { ...opts, path, args: [offset, length] });
      if (!res.ok) {
        await std.println(
          `  readChunk   ${label.padEnd(5)} ${(res.code ?? "GAGAL").padEnd(9)} ${String(res.ms).padStart(4)}ms  ${res.error ?? ""}`,
        );
        return;
      }
      const body = blobData(res.result);
      const got = body === null ? "null" : `${body.length} byte`;
      const verdict = body !== null && body.length === length ? "ok" : "<<< PENDEK/KOSONG";
      await std.println(
        `  readChunk   ${label.padEnd(5)} ok   ${String(res.ms).padStart(4)}ms  minta ${length} @${offset} → ${got}  ${verdict}`,
      );
    };

    const edge = Math.min(4096, size > 0 ? size : 4096);
    await probeChunk("head", 0, edge);
    if (size > edge) await probeChunk("tail", size - edge, edge);
    return;
  }

  if (sub === "cat") {
    const path = args[2];
    if (!path) {
      await std.print("netfs cat: butuh path file.\n");
      return;
    }
    const res = await NetFSClient.readFile(spec, path, opts);
    if (!res.ok) {
      await std.print(`netfs cat: ${res.code ?? "?"} ${res.error ?? "gagal"}\n`);
      return;
    }
    if (res.content === null || res.content === undefined) {
      await std.print(`netfs cat: ${path} kosong atau tidak ada.\n`);
      return;
    }
    await std.print(res.content.endsWith("\n") ? res.content : res.content + "\n");
    return;
  }

  await std.print(`netfs: subcommand tidak dikenal: ${sub}\n\n` + HELP);
});
