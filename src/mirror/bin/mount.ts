import { Program, fs, std, shell } from "@tsix/Application";

/**
 * MOUNT Utility
 *
 * Mount a file system.
 */
export default Program(async (args) => {
  if (args.includes("--help") || args.includes("-h")) {
    await std.print(
      "Usage: mount [vfs_path host_path] [--ro] [--bkfs] [--ramfs] [--uid N] [--gid N]\n" +
        "  mount <path> --ramfs                  Mount RAM-only filesystem (no host path needed)\n" +
        "  mount <path> <source> --bkfs          Mount BKFS (SQLite) database\n" +
        "  mount <path> <source>                 Mount host directory\n" +
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
  } else {
    fsType = "host";
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

    const ok = await fs.mount(vfsPath, hostPath, isReadOnly, fsType, uid, gid);
    if (ok) {
      await std.print(
        `Successfully mounted ${hostPath} to ${vfsPath}${isReadOnly ? " (read-only)" : ""}\n`,
      );
    } else {
      await std.print(`Failed to mount ${hostPath} to ${vfsPath}\n`);
    }
  } catch (e: any) {
    await std.print(`Mount Error: ${e.message}\n`);
  }
});
