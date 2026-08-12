import { Program, fs, std, shell } from "@tsix/Application";

/**
 * DF Utility
 *
 * Report file system disk space usage.
 */
export default Program(async (args) => {
  if (args.includes("--help") || args.includes("-h")) {
    await std.print(
      "Usage: df [-h]\nReport disk space usage of mounted filesystems.\n\nOptions:\n  -h    Human readable sizes\n",
    );
    return;
  }

  const isHuman = args.includes("-h");
  const mounts = await fs.getMounts();

  const formatSize = (bytes: number) => {
    if (!isHuman) return bytes.toString();
    if (bytes < 1024) return bytes + "B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "K";
    if (bytes < 1024 * 1024 * 1024)
      return (bytes / (1024 * 1024)).toFixed(1) + "M";
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + "G";
  };

  // Header
  await std.println(
    `${"Filesystem".padEnd(15)} ${"Disk".padStart(8)} ${"Data".padStart(8)} ${"Files".padStart(6)} ${"Dirs".padStart(6)} ${"Mounted on"}`,
  );
  await std.println("-".repeat(60));

  for (const m of mounts) {
    let onDiskSize = "0";
    let dataSize = "0";
    let files = 0;
    let dirs = 0;

    try {
      // 1. Get Advanced Stats via Syscall (includes physical diskSize if applicable)
      const usage = await fs.getUsage(m.vfsPath);

      if (m.type === "bkfs") {
        onDiskSize = usage.diskSize ? formatSize(usage.diskSize) : "VIRT";
      } else if (m.type === "ramfs") {
        onDiskSize = "RAM";
      } else {
        onDiskSize = "HOST";
      }

      dataSize = formatSize(usage.size);
      files = usage.files;
      dirs = usage.dirs;
    } catch (e: any) {
      onDiskSize = "err";
      dataSize = "err";
    }

    const fsRow =
      m.source.length > 15 ? m.source.substring(0, 12) + "..." : m.source;
    await std.println(
      `${fsRow.padEnd(15)} ${onDiskSize.padStart(8)} ${dataSize.padStart(8)} ${files.toString().padStart(6)} ${dirs.toString().padStart(6)} ${m.vfsPath}`,
    );
  }
});
