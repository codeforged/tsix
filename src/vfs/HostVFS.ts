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
        // MASK 0o777: `fs.Stats.mode` Node memuat bit TIPE (S_IFREG 0o100000,
        // S_IFDIR 0o040000) di atas bit izin. BKFS menyimpan bit izin saja
        // (0o644 = 420), jadi tanpa mask ini `ls -l` di userland menampilkan
        // "100644" dan pembanding mode (mis. `mode === 0o644`) meleset.
        mode: s.mode & 0o777,
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
    // `mode` dihormati untuk pembuatan BARU (umask tetap berlaku, seperti mkdir
    // biasa); direktori yang sudah ada tidak diubah izinnya — sama seperti BKFS.
    fs.mkdirSync(hostPath, { recursive: true, ...(mode ? { mode } : {}) });
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
    // `mode` dihormati untuk berkas BARU saja — sama seperti BKFS dan `touch` Unix:
    // berkas yang sudah ada hanya isinya yang diganti, izinnya tidak diubah.
    // Tanpa ini `rootType = "host"` kehilangan bit `x` yang diminta pemanggil
    // (mis. `/etc/rc.local` 0o755), dan skrip boot dilewati init.
    const isNew = !fs.existsSync(hostPath);
    fs.writeFileSync(hostPath, content, "binary");
    if (isNew && mode !== undefined) fs.chmodSync(hostPath, mode);
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
      // MASK 0o777 (lihat `ls()`): buang bit tipe S_IF* supaya bentuknya sama
      // dengan mode di BKFS (bit izin saja).
      mode: this.ownerMode ?? (s.mode & 0o777),
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
    try {
      fs.chownSync(hostPath, uid, gid);
      return true;
    } catch (e: any) {
      // EPERM/EACCES = host tidak mengizinkan ganti kepemilikan (butuh root /
      // CAP_CHOWN). Ini NORMAL begitu HostVFS dipakai sebagai root `/` (mode
      // `rootType = "host"`): folder proyek dimiliki user biasa, sedangkan
      // fstab biasanya meminta uid/gid 0.
      //
      // Dulu ini DILEMPAR, dan akibatnya nyata: entri fstab seperti `/tmp` dan
      // `/hostsrc` gagal ter-mount seluruhnya hanya karena chown-nya ditolak —
      // padahal isi berkasnya baik-baik saja. Kini dilaporkan sebagai "tidak
      // bisa" (return false) tanpa membatalkan mount; kepemilikan efektif
      // mengikuti berkas host.
      if (e?.code === "EPERM" || e?.code === "EACCES") {
        this.logger.debug(
          `chown ${vfsPath} → ${uid}:${gid} diabaikan (${e.code}) — kepemilikan mengikuti berkas host`,
        );
        return false;
      }
      throw e;
    }
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
