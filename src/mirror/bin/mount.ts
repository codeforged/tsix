import { Program, fs, std, shell } from "@tsix/Application";

/** valueOf(): Ambil nilai setelah flag (`--via 7778` → "7778"). */
function valueOf(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const v = args[idx + 1];
  return v && !v.startsWith("--") ? v : undefined;
}

/**
 * MOUNT Utility
 *
 * Mount a file system.
 */
export default Program(async (args) => {
  if (args.includes("--help") || args.includes("-h")) {
    await std.print(
      "Usage: mount [vfs_path host_path] [--ro] [--bkfs] [--ramfs] [--netfs] [--uid N] [--gid N]\n" +
        "  mount <path> --ramfs                  Mount RAM-only filesystem (no host path needed)\n" +
        "  mount <path> <source> --bkfs          Mount BKFS (SQLite) database\n" +
        "  mount <path> <source>                 Mount host directory\n" +
        "  mount <path> <addr[:port]> --netfs    Mount filesystem node TSIX lain (NetFS via MQTNL)\n" +
        "     --via <port>       Lewat daemon klien lokal (netfsd --client), port-nya di sini\n" +
        "     --direct           Kernel bicara langsung ke SL di node tujuan\n" +
        "     --key <64 hex>     Aktifkan enkripsi (harus SAMA dengan netfsd)\n" +
        "     --agent <nama>     Agent enkripsi (default: chacha20)\n" +
        "     --timeout <ms>     Timeout satu operasi (default: 5000)\n" +
        "     --cache <ms>       TTL cache ls/stat (default: 0 = mati)\n" +
        "     --iface <nama>     Interface MQTNL lokal (default: interface default)\n" +
        "  mount <path> <source> --uid 1000      Mount with specific owner UID\n" +
        "  mount <path> <source> --gid 1000      Mount with specific group GID\n" +
        "List mounts if no arguments provided.\n",
    );
    return;
  }
  if (args.length === 0) {
    const mounts = await fs.getMounts();
    await std.print("Active mount points:\n");
    for (const m of mounts) {
      const opts = m.readOnly ? "ro" : "rw";
      const owner = m.uid !== undefined ? ` uid=${m.uid}` : "";
      const group = m.gid !== undefined ? ` gid=${m.gid}` : "";
      await std.print(
        `${m.vfsPath} on ${m.source} type ${m.type} (${opts}${owner}${group})\n`,
      );
    }
    return;
  }

  // SECURITY: Only root can perform MOUNT
  const user = await shell.whoami();
  if (user.uid !== 0) {
    await std.print(
      "Permission Denied: Only root can mount filesystems. Use sudo.\n",
    );
    return;
  }

  const isRamfs = args.includes("--ramfs");
  const isBkfs = args.includes("--bkfs");
  const isNetfs = args.includes("--netfs");

  // RamFS hanya butuh vfsPath (tanpa host_path)
  if (isRamfs) {
    if (args.length < 1) {
      await std.print("Usage: mount <vfs_path> --ramfs\n");
      return;
    }
  } else {
    if (args.length < 2) {
      await std.print("Usage: mount <vfs_path> <host_path> [--ro] [--bkfs]\n");
      return;
    }
  }

  const vfsPath = args[0];
  const hostPath = isRamfs ? "ram" : args[1];
  const isReadOnly = args.includes("--ro");

  // Parse --uid and --gid
  const uidIdx = args.indexOf("--uid");
  const gidIdx = args.indexOf("--gid");
  const uid = uidIdx !== -1 ? parseInt(args[uidIdx + 1], 10) : undefined;
  const gid = gidIdx !== -1 ? parseInt(args[gidIdx + 1], 10) : undefined;

  let fsType: string;
  if (isRamfs) {
    fsType = "ramfs";
  } else if (isBkfs) {
    fsType = "bkfs";
  } else if (isNetfs) {
    fsType = "netfs";
  } else {
    fsType = "host";
  }

  // Opsi khusus NetFS — diteruskan apa adanya ke syscall MOUNT.
  // Tanpa --via maupun --direct: default lewat daemon klien lokal bila ada,
  // kalau tidak ada mount akan gagal cepat dengan pesan yang menjelaskan.
  const netfsOptions: Record<string, any> = {};
  if (isNetfs) {
    const viaRaw = valueOf(args, "--via");
    if (viaRaw) {
      const viaPort = parseInt(viaRaw, 10);
      if (!Number.isInteger(viaPort) || viaPort <= 0 || viaPort > 65535) {
        await std.print(`mount: --via port tidak valid: ${viaRaw}\n`);
        return;
      }
      netfsOptions.via = viaPort;
    }
    const key = valueOf(args, "--key");
    if (key) netfsOptions.key = key;
    const agent = valueOf(args, "--agent");
    if (agent) netfsOptions.agent = agent;
    const iface = valueOf(args, "--iface");
    if (iface) netfsOptions.iface = iface;

    const timeoutRaw = valueOf(args, "--timeout");
    if (timeoutRaw) {
      const timeoutMs = parseInt(timeoutRaw, 10);
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        await std.print(`mount: --timeout tidak valid: ${timeoutRaw}\n`);
        return;
      }
      netfsOptions.timeoutMs = timeoutMs;
    }
    const cacheRaw = valueOf(args, "--cache");
    if (cacheRaw) {
      const cacheTtlMs = parseInt(cacheRaw, 10);
      if (!Number.isInteger(cacheTtlMs) || cacheTtlMs < 0) {
        await std.print(`mount: --cache tidak valid: ${cacheRaw}\n`);
        return;
      }
      netfsOptions.cacheTtlMs = cacheTtlMs;
    }
    if (args.includes("--direct")) netfsOptions.direct = true;
  }

  try {
    // Unix fidelity: mount point harus SUDAH ADA & berupa direktori.
    // Mount ke direktori yang tidak ada harus ditolak, bukan auto-create.
    const targetStat = await fs.stat(vfsPath).catch(() => null);
    if (!targetStat) {
      await std.print(`mount: mount point ${vfsPath} does not exist\n`);
      return;
    }
    if (targetStat.type !== "DIRECTORY") {
      await std.print(`mount: ${vfsPath} is not a directory\n`);
      return;
    }

    const ok = await fs.mount(
      vfsPath,
      hostPath,
      isReadOnly,
      fsType,
      uid,
      gid,
      netfsOptions,
    );
    if (ok) {
      const viaInfo = netfsOptions.via
        ? ` (via localhost:${netfsOptions.via})`
        : "";
      await std.print(
        `Successfully mounted ${hostPath}${viaInfo} to ${vfsPath}${isReadOnly ? " (read-only)" : ""}\n`,
      );
    } else {
      await std.print(`Failed to mount ${hostPath} to ${vfsPath}\n`);
    }
  } catch (e: any) {
    await std.print(`Mount Error: ${e.message}\n`);
  }
});
