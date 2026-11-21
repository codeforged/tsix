import { IVFS } from "./IVFS";
import { VirtualFileSystem, VNodeType } from "./VFS";
import { Logger } from "../common/Logger";

/**
 * RamFS — RAM-only Filesystem
 *
 * Filesystem yang seluruh datanya disimpan di RAM (volatile).
 * Tidak ada persistence ke disk/SQLite — semua data hilang saat proses restart.
 *
 * Cocok untuk:
 *   - /tmp   (file sementara)
 *   - /run   (runtime data seperti PID file, socket)
 *   - /dev/shm (shared memory POSIX)
 *
 * Di Linux, ramfs mirip tmpfs tapi TANPA batas ukuran (grows dynamically)
 * dan TANPA swap backing — murni di RAM.
 */
export class RamFS implements IVFS {
  private vfs: VirtualFileSystem;
  private logger: Logger;

  /**
   * @param label  Label opsional untuk logging (misal: "tmp", "run")
   * @param uid    UID untuk root directory (default: 0)
   * @param gid    GID untuk root directory (default: 0)
   * @param mode   Permission mode untuk root directory (default: 0o755)
   */
  constructor(label?: string, uid?: number, gid?: number, mode?: number) {
    this.vfs = new VirtualFileSystem(uid ?? 0, gid ?? 0, mode ?? 0o755);
    this.logger = new Logger(`RamFS${label ? `[${label}]` : ""}`);
    this.logger.info(
      "RAM filesystem initialized (volatile, no backing store).",
    );
  }

  // ==================== BASIC OPERATIONS ====================

  public ls(path: string): any[] {
    return this.vfs.ls(path);
  }

  public mkdir(
    path: string,
    uid?: number,
    gid?: number,
    mode?: number,
  ): boolean {
    return this.vfs.mkdir(path, uid, gid, mode);
  }

  public read(path: string): string | null {
    return this.vfs.read(path);
  }

  public touch(
    path: string,
    content: string = "",
    uid?: number,
    gid?: number,
    mode?: number,
  ): boolean {
    return this.vfs.touch(path, content, uid, gid, mode);
  }

  public stat(path: string): any {
    return this.vfs.stat(path);
  }

  public chmod(path: string, mode: number): boolean {
    return this.vfs.chmod(path, mode);
  }

  public chown(path: string, uid: number, gid: number): boolean {
    return this.vfs.chown(path, uid, gid);
  }

  public unlink(path: string): boolean {
    return this.vfs.unlink(path);
  }

  public rmdir(path: string): boolean {
    return this.vfs.rmdir(path);
  }

  public exists(path: string, type?: VNodeType): boolean {
    return this.vfs.exists(path, type);
  }

  public append(path: string, content: string): boolean {
    return this.vfs.append(path, content);
  }

  // ==================== CHUNKED I/O ====================

  public readChunk(
    path: string,
    offset: number,
    length: number,
  ): string | null {
    return this.vfs.readChunk(path, offset, length);
  }

  public writeChunk(path: string, chunk: string, offset: number): boolean {
    return this.vfs.writeChunk(path, chunk, offset);
  }

  public getSize(path: string): number {
    return this.vfs.getSize(path);
  }

  // ==================== STATISTICS ====================

  /**
   * getUsage(): Statistik penggunaan RAM oleh filesystem ini.
   * RamFS tidak punya batas disk — `diskSize` akan selalu undefined
   * (unlimited, grows dynamically seperti Linux ramfs).
   */
  public async getUsage(): Promise<{
    size: number;
    files: number;
    dirs: number;
    diskSize?: number;
  }> {
    const usage = await this.vfs.getUsage();
    // RamFS: no disk size limit (unbounded)
    return {
      size: usage.size,
      files: usage.files,
      dirs: usage.dirs,
      // diskSize sengaja tidak diset — ramfs tidak punya batas
    };
  }

  /**
   * getMemoryUsage(): Mengembalikan estimasi penggunaan memori dalam bytes.
   * Ini menghitung ukuran konten + overhead struktur VNode.
   */
  public async getMemoryUsage(): Promise<{
    contentBytes: number;
    structCount: number;
    estimatedOverheadBytes: number;
    totalEstimatedBytes: number;
  }> {
    const usage = await this.vfs.getUsage();
    const structCount = usage.files + usage.dirs;
    // Estimasi overhead: ~200 bytes per VNode (Map entries, string keys, object props)
    const estimatedOverhead = structCount * 200;
    return {
      contentBytes: usage.size,
      structCount,
      estimatedOverheadBytes: estimatedOverhead,
      totalEstimatedBytes: usage.size + estimatedOverhead,
    };
  }
}
