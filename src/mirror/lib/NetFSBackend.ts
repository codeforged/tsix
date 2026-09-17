import type { IVFS } from "../../vfs/IVFS";
import { NetFSError } from "../../common/netfs/NetFSProtocol";

/**
 * NetFSBackend — jembatan USERLAND: `IVFS` → `lib.fs` (syscall)
 *
 * Dipakai oleh `netfsd --export` di node storage host (SH). `NetFSServer`
 * (inti SL) bicara ke sebuah `IVFS`; di userland tidak ada IVFS langsung
 * (aplikasi hanya punya `lib.fs` yang berbasis syscall), jadi adapter inilah
 * yang menjembatani keduanya.
 *
 * Pembagian tugas:
 *
 *   NetFSServer    → pemilik prefix + pagar read-only + mapping error
 *   NetFSBackend   → menerjemahkan 1 op ke 1..n pemanggilan `lib.fs`
 *
 * Catatan semantik (disengaja, bukan bug):
 *   - `uid`/`gid` pada mkdir/touch/chown DIABAIKAN. Hak akses remote = hak
 *     identitas proses `netfsd` di node SH — efek "root squash" ala NFS.
 *     Jadi SATPAM tetap penentu akhir, dan klien tidak bisa memalsukan uid.
 *   - `append()` butuh 2 syscall (read lalu write) karena `lib.fs` tidak punya
 *     append native. Untuk file besar, klien sebaiknya pakai `writeChunk`.
 *   - `root` HANYA dipakai `getUsage()` (perintah `df`) supaya angka yang
 *     dilaporkan adalah ukuran export, bukan seluruh VFS.
 *
 * (c) 2026 TSIX Project
 */

/**
 * Permukaan `lib.fs` yang dipakai backend ini (structural typing).
 * Ditulis eksplisit supaya modul ini tidak perlu meng-import UserLib —
 * jadi mudah ditest dengan objek palsu.
 */
export interface UserlandFsLike {
  mkdir(path: string): Promise<any>;
  ls(path?: string): Promise<any>;
  stat(path: string): Promise<any>;
  chmod(path: string, mode: number): Promise<any>;
  chown(path: string, uid: number, gid: number): Promise<any>;
  unlink(path: string): Promise<boolean>;
  rmdir(path: string): Promise<boolean>;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<boolean>;
  readChunk(path: string, offset: number, length: number): Promise<string | null>;
  writeChunk(path: string, chunk: string, offset: number): Promise<boolean>;
  getSize(path: string): Promise<number>;
  getUsage(
    path?: string,
  ): Promise<{ size: number; files: number; dirs: number; diskSize?: number }>;
}

export interface NetFSBackendOptions {
  /** Root export — dipakai untuk `getUsage()` (df) saja. */
  root?: string;
  /** Logger opsional (biasanya logger netfsd). */
  logger?: { warn?(message: string): void };
}

export class NetFSBackend implements IVFS {
  private readonly fs: UserlandFsLike;
  private readonly root: string;
  private readonly logger?: { warn?(message: string): void };

  constructor(fs: UserlandFsLike, opts: NetFSBackendOptions = {}) {
    if (!fs) throw new Error("NetFSBackend: lib.fs wajib diisi");
    this.fs = fs;
    this.root = opts.root ?? "/";
    this.logger = opts.logger;
  }

  // ==================== BACA ====================

  /** ls(): direktori tidak ada → daftar kosong (semantik IVFS lokal). */
  public async ls(path: string): Promise<any[]> {
    try {
      const items = await this.fs.ls(path);
      return Array.isArray(items) ? items : [];
    } catch (e: any) {
      this.logger?.warn?.(`ls ${path} gagal: ${e.message}`);
      return [];
    }
  }

  public async read(path: string): Promise<string | null> {
    try {
      return await this.fs.readFile(path);
    } catch (e: any) {
      // File tidak ada → null (kontrak IVFS), error lain dibiarkan naik.
      if (/not found|enoent|no such/i.test(String(e?.message ?? ""))) return null;
      throw e;
    }
  }

  public async stat(path: string): Promise<any> {
    try {
      const node = await this.fs.stat(path);
      return node ?? null;
    } catch (e) {
      return null;
    }
  }

  public async exists(path: string, type?: any): Promise<boolean> {
    const node = await this.stat(path);
    if (!node) return false;
    if (type && node.type !== type) return false;
    return true;
  }

  public async readChunk(
    path: string,
    offset: number,
    length: number,
  ): Promise<string | null> {
    return await this.fs.readChunk(path, offset, length);
  }

  public async getSize(path: string): Promise<number> {
    return await this.fs.getSize(path);
  }

  public async getUsage(): Promise<{
    size: number;
    files: number;
    dirs: number;
    diskSize?: number;
  }> {
    return await this.fs.getUsage(this.root);
  }

  // ==================== TULIS ====================

  public async mkdir(
    path: string,
    _uid?: number,
    _gid?: number,
    mode?: number,
  ): Promise<boolean> {
    await this.fs.mkdir(path);
    // `lib.fs.mkdir` tidak menerima mode; mode klien diterapkan lewat chmod
    // supaya `mkdir -m 700` di sisi klien tetap terasa di SH.
    if (typeof mode === "number") await this.fs.chmod(path, mode);
    return true;
  }

  public async touch(
    path: string,
    content: string = "",
    _uid?: number,
    _gid?: number,
    mode?: number,
  ): Promise<boolean> {
    const ok = await this.fs.writeFile(path, content ?? "");
    if (!ok) throw new NetFSError("EACCES", `tidak bisa menulis ${path}`);
    if (typeof mode === "number") await this.fs.chmod(path, mode);
    return true;
  }

  public async append(path: string, content: string): Promise<boolean> {
    // lib.fs tidak punya append native → read + write (2 syscall).
    const current = await this.read(path);
    if (current === null && !(await this.exists(path))) {
      // File belum ada: append == create (perilaku POSIX O_APPEND|O_CREAT).
      return await this.touch(path, content ?? "");
    }
    return await this.touch(path, (current ?? "") + (content ?? ""));
  }

  public async writeChunk(
    path: string,
    chunk: string,
    offset: number,
  ): Promise<boolean> {
    const ok = await this.fs.writeChunk(path, chunk, offset);
    if (!ok) throw new NetFSError("EIO", `writeChunk gagal: ${path}`);
    return true;
  }

  public async unlink(path: string): Promise<boolean> {
    return await this.fs.unlink(path);
  }

  public async rmdir(path: string): Promise<boolean> {
    return await this.fs.rmdir(path);
  }

  public async chmod(path: string, mode: number): Promise<boolean> {
    await this.fs.chmod(path, mode);
    return true;
  }

  public async chown(path: string, uid: number, gid: number): Promise<boolean> {
    // Bukan root di SH → syscall CHOWN akan ditolak SATPAM (EPERM/EACCES).
    await this.fs.chown(path, uid, gid);
    return true;
  }
}
