import { IVFS } from "../vfs/IVFS";
import { Logger } from "../common/Logger";
import { PathResolver } from "../common/PathResolver";

export interface MountPoint {
  vfsPath: string;
  vfs: IVFS;
  type: string;
  source: string;
  readOnly: boolean;
  uid?: number;
  gid?: number;
}

/**
 * MOUNT MANAGER
 *
 * Mengatur titik kait (Mount Points) dalam VFS TSIX.
 * Bertanggung jawab memilih driver filesystem yang tepat berdasarkan path.
 */
export class MountManager {
  private mounts: MountPoint[] = [];
  private logger: Logger;

  constructor() {
    this.logger = new Logger("MountManager");
  }

  /**
   * mount(): Menambahkan titik kait baru.
   */
  public mount(
    vfsPath: string,
    vfs: IVFS,
    type: string = "bkfs",
    source: string = "system.db",
    readOnly: boolean = false,
    uid?: number,
    gid?: number,
  ) {
    // Normalisasi path menggunakan PathResolver agar konsisten
    const cleanPath = PathResolver.resolve("/", vfsPath);

    // Cek apakah sudah ada
    const existing = this.mounts.find((m) => m.vfsPath === cleanPath);
    if (existing) {
      this.logger.warn(`Mount point ${cleanPath} already exists. Replacing...`);
      existing.vfs = vfs;
      existing.type = type;
      existing.source = source;
      existing.readOnly = readOnly;
      existing.uid = uid;
      existing.gid = gid;
    } else {
      this.mounts.push({
        vfsPath: cleanPath,
        vfs,
        type,
        source,
        readOnly,
        uid,
        gid,
      });
      // Sort by path length descending so longest match wins
      this.mounts.sort((a, b) => b.vfsPath.length - a.vfsPath.length);
    }

    this.logger.info(
      `Mounted ${type} filesystem at ${cleanPath} from ${source} (${readOnly ? "ro" : "rw"})`,
    );
  }

  public unmount(vfsPath: string): boolean {
    const cleanPath = PathResolver.resolve("/", vfsPath);
    const index = this.mounts.findIndex((m) => m.vfsPath === cleanPath);
    if (index !== -1) {
      this.mounts.splice(index, 1);
      this.logger.info(`Unmounted ${cleanPath}`);
      return true;
    }
    return false;
  }

  /**
   * resolve(): Mencari driver dan relative path untuk sebuah path vfs.
   */
  public resolve(path: string): {
    vfs: IVFS;
    relativePath: string;
    mountPoint: string;
  } {
    // Normalize: robustly handle //, ./ and .. using PathResolver
    const normalized = PathResolver.resolve("/", path);

    for (const m of this.mounts) {
      // Case 1: Exact match
      if (normalized === m.vfsPath) {
        return { vfs: m.vfs, relativePath: "/", mountPoint: m.vfsPath };
      }

      // Case 2: Sub-path match
      // Special handling for root mount point "/"
      const prefix = m.vfsPath === "/" ? "/" : m.vfsPath + "/";
      if (normalized.startsWith(prefix)) {
        let relative = normalized.substring(
          m.vfsPath === "/" ? 0 : m.vfsPath.length,
        );
        if (!relative.startsWith("/")) relative = "/" + relative;
        return { vfs: m.vfs, relativePath: relative, mountPoint: m.vfsPath };
      }
    }

    throw new Error(`Path not found in any mounted filesystem: ${path}`);
  }

  public listMounts() {
    return this.mounts.map((m) => ({
      vfsPath: m.vfsPath,
      type: m.type,
      source: m.source,
      readOnly: m.readOnly,
      uid: m.uid,
      gid: m.gid,
    }));
  }
}
