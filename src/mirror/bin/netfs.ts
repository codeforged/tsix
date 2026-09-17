import { Program, fs, std } from "@tsix/Application";
import { NetFSClient } from "@tsix/NetFSClient";

/**
 * NETFS Utility
 *
 * Alat periksa NetFS (filesystem node TSIX lain lewat MQTNL) — pakai
 * NetSocket langsung, jadi bisa dipakai SEBELUM mount.
 *
 *   netfs info   <addr[:port]>        metadata export (label, ro, prefix, ops)
 *   netfs ls     <addr[:port]> [path] daftar isi export
 *   netfs cat    <addr[:port]> <path> baca satu file
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
