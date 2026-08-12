import * as fs from "fs";
import * as path from "path";
import { IVFS } from "./IVFS";
import { VNodeType } from "./VFS";
import { Logger } from "../common/Logger";

/**
 * HostVFS
 *
 * Implementasi IVFS yang menghubungkan langsung ke folder di Host (Laptop).
 * Berguna untuk "Mount" folder nyata ke dalam TSIX.
 */
export class HostVFS implements IVFS {
  private hostRoot: string;
  private readOnly: boolean;
  private logger: Logger;
  private ownerUid?: number;
  private ownerGid?: number;
  private ownerMode?: number;

  constructor(
    hostRoot: string,
    readOnly: boolean = false,
    uid?: number,
    gid?: number,
    mode?: number,
  ) {
    this.hostRoot = path.resolve(hostRoot);
    this.readOnly = readOnly;
    this.ownerUid = uid;
    this.ownerGid = gid;
    this.ownerMode = mode;
    this.logger = new Logger(`HostVFS[${path.basename(hostRoot)}]`);

    if (!fs.existsSync(this.hostRoot)) {
      fs.mkdirSync(this.hostRoot, { recursive: true });
    }
  }

  private toHostPath(vfsPath: string): string {
    // Normalisasi path agar tidak bisa escape dari hostRoot (basic security)
    const relative = vfsPath.startsWith("/") ? vfsPath.substring(1) : vfsPath;
    const finalPath = path.resolve(this.hostRoot, relative);

    if (!finalPath.startsWith(this.hostRoot)) {
      throw new Error("Security Violation: Path escapes HostVFS root");
    }
    return finalPath;
  }

  public ls(vfsPath: string): any[] {
    const hostPath = this.toHostPath(vfsPath);
    if (!fs.existsSync(hostPath)) return [];

    const stats = fs.statSync(hostPath);
    if (!stats.isDirectory()) return [];

    const items = fs.readdirSync(hostPath);
    return items.map((name) => {
      const fullHostPath = path.join(hostPath, name);
      const s = fs.statSync(fullHostPath);
      return {
        name: name,
        type: s.isDirectory() ? VNodeType.DIRECTORY : VNodeType.FILE,
        size: s.size,
        mode: s.mode,
        uid: s.uid,
        gid: s.gid,
        modified_at: s.mtimeMs,
      };
    });
  }

  public mkdir(
    vfsPath: string,
    uid?: number,
    gid?: number,
    mode?: number,
  ): boolean {
    if (this.readOnly) throw new Error("Read-only filesystem");
    const hostPath = this.toHostPath(vfsPath);
    fs.mkdirSync(hostPath, { recursive: true });
    return true;
  }

  public read(vfsPath: string): string | null {
    const hostPath = this.toHostPath(vfsPath);
    if (!fs.existsSync(hostPath) || fs.statSync(hostPath).isDirectory())
      return null;
    return fs.readFileSync(hostPath, "binary");
  }

  public touch(
    vfsPath: string,
    content: string = "",
    uid?: number,
    gid?: number,
    mode?: number,
  ): boolean {
    if (this.readOnly) throw new Error("Read-only filesystem");
    const hostPath = this.toHostPath(vfsPath);
    fs.writeFileSync(hostPath, content, "binary");
    return true;
  }

  public append(vfsPath: string, content: string): boolean {
    if (this.readOnly) throw new Error("Read-only filesystem");
    const hostPath = this.toHostPath(vfsPath);
    fs.appendFileSync(hostPath, content, "binary");
    return true;
  }

  public stat(vfsPath: string): any {
    const hostPath = this.toHostPath(vfsPath);
    if (!fs.existsSync(hostPath)) return null;
    const s = fs.statSync(hostPath);
    return {
      name: path.basename(vfsPath),
      type: s.isDirectory() ? VNodeType.DIRECTORY : VNodeType.FILE,
      size: s.size,
      content: s.isDirectory() ? null : "PRESENT", // content read-only via read()
      uid: this.ownerUid ?? s.uid,
      gid: this.ownerGid ?? s.gid,
      mode: this.ownerMode ?? s.mode,
      modified_at: s.mtimeMs,
      created_at: s.birthtimeMs,
    };
  }

  public chmod(vfsPath: string, mode: number): boolean {
    if (this.readOnly) throw new Error("Read-only filesystem");
    const hostPath = this.toHostPath(vfsPath);
    fs.chmodSync(hostPath, mode);
    return true;
  }

  public chown(vfsPath: string, uid: number, gid: number): boolean {
    if (this.readOnly) throw new Error("Read-only filesystem");
    const hostPath = this.toHostPath(vfsPath);
    fs.chownSync(hostPath, uid, gid);
    return true;
  }

  public unlink(vfsPath: string): boolean {
    if (this.readOnly) throw new Error("Read-only filesystem");
    const hostPath = this.toHostPath(vfsPath);
    if (fs.existsSync(hostPath)) {
      fs.unlinkSync(hostPath);
      return true;
    }
    return false;
  }

  public rmdir(vfsPath: string): boolean {
    if (this.readOnly) throw new Error("Read-only filesystem");
    const hostPath = this.toHostPath(vfsPath);
    if (fs.existsSync(hostPath)) {
      fs.rmdirSync(hostPath);
      return true;
    }
    return false;
  }

  public exists(vfsPath: string, type?: VNodeType): boolean {
    const hostPath = this.toHostPath(vfsPath);
    if (!fs.existsSync(hostPath)) return false;
    if (type) {
      const s = fs.statSync(hostPath);
      const actualType = s.isDirectory() ? VNodeType.DIRECTORY : VNodeType.FILE;
      return actualType === type;
    }
    return true;
  }
  public async getUsage(): Promise<{
    size: number;
    files: number;
    dirs: number;
    diskSize?: number;
  }> {
    let size = 0;
    let files = 0;
    let dirs = 0;

    const traverse = (dir: string) => {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const s = fs.statSync(fullPath);
        if (s.isDirectory()) {
          dirs++;
          traverse(fullPath);
        } else {
          files++;
          size += s.size;
        }
      }
    };

    try {
      traverse(this.hostRoot);
    } catch (e) {
      // Might happen if perms change during traverse
    }

    return { size, files, dirs };
  }

  // ==================== CHUNKED I/O ====================

  /**
   * readChunk(): Membaca potongan konten file langsung dari host disk.
   * Cocok untuk file besar — hanya baca byte yang diperlukan.
   */
  public readChunk(
    vfsPath: string,
    offset: number,
    length: number,
  ): string | null {
    const hostPath = this.toHostPath(vfsPath);
    if (!fs.existsSync(hostPath) || fs.statSync(hostPath).isDirectory())
      return null;

    const fd = fs.openSync(hostPath, "r");
    try {
      const buf = Buffer.alloc(length);
      const bytesRead = fs.readSync(fd, buf, 0, length, offset);
      if (bytesRead === 0) return null;
      return buf.toString("binary", 0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * writeChunk(): Menulis potongan konten ke file host di offset tertentu.
   */
  public writeChunk(vfsPath: string, chunk: string, offset: number): boolean {
    if (this.readOnly) throw new Error("Read-only filesystem");
    const hostPath = this.toHostPath(vfsPath);

    // Gunakan "r+" agar tidak truncate; buat baru jika belum ada
    if (!fs.existsSync(hostPath)) {
      const fd = fs.openSync(hostPath, "w");
      fs.closeSync(fd);
    }

    const fd = fs.openSync(hostPath, "r+");
    try {
      const buf = Buffer.from(chunk, "binary");
      fs.writeSync(fd, buf, 0, buf.length, offset);
      return true;
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * getSize(): Mendapatkan ukuran file dalam byte langsung dari host stat.
   */
  public getSize(vfsPath: string): number {
    const hostPath = this.toHostPath(vfsPath);
    if (!fs.existsSync(hostPath)) return -1;
    const s = fs.statSync(hostPath);
    if (s.isDirectory()) return -1;
    return s.size;
  }
}
