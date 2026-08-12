import { Logger } from "../common/Logger";

/**
 * VNODE (Virtual Node)
 *
 * Di Linux, setiap file/folder direpresentasikan oleh sebuah 'Inode'.
 * Di sini kita sebut 'VNode' untuk mempermudah.
 */
export enum VNodeType {
  FILE = "FILE",
  DIRECTORY = "DIRECTORY",
}

export interface VNode {
  name: string;
  type: VNodeType;
  content: string | null; // Jika file, isinya string. Jika folder, null.
  children: Map<string, VNode>; // Jika folder, daftar anak-anaknya.
  parent: VNode | null; // Untuk memudahkan navigasi ke atas (cd ..)
  createdAt: number;
  modifiedAt: number;
  uid: number;
  gid: number;
  mode: number;
}

/**
 * VIRTUAL FILE SYSTEM (VFS)
 *
 * "Everything is a file" - Semboyan Linux.
 * VFS adalah layer yang mengatur folder dan file di dalam RAM.
 */
export class VirtualFileSystem {
  private root: VNode;
  private logger: Logger;

  constructor(
    rootUid: number = 0,
    rootGid: number = 0,
    rootMode: number = 0o755,
  ) {
    this.logger = new Logger("VFS");

    // Membuat Root Directory ("/")
    this.root = {
      name: "/",
      type: VNodeType.DIRECTORY,
      content: null,
      children: new Map(),
      parent: null,
      createdAt: Date.now(),
      modifiedAt: Date.now(),
      uid: rootUid,
      gid: rootGid,
      mode: rootMode,
    };

    this.logger.info("Virtual File System initialized with root (/).");
  }

  /**
   * mkdir(): Membuat direktori baru.
   * @param path Path folder baru (misal: "/bin")
   */
  public mkdir(
    path: string,
    uid?: number,
    gid?: number,
    mode?: number,
  ): boolean {
    const parts = this.cleanPath(path);
    let current = this.root;

    for (const part of parts) {
      if (!current.children.has(part)) {
        const now = Date.now();
        const newNode: VNode = {
          name: part,
          type: VNodeType.DIRECTORY,
          content: null,
          children: new Map(),
          parent: current,
          createdAt: now,
          modifiedAt: now,
          uid: uid ?? 0,
          gid: gid ?? 0,
          mode: mode ?? 0o755,
        };
        current.children.set(part, newNode);
        this.logger.debug(`Directory created: ${part}`);
      }
      current = current.children.get(part)!;
    }
    return true;
  }

  /**
   * touch(): Membuat file baru yang kosong.
   * @param path Path file (misal: "/etc/version")
   */
  public touch(
    path: string,
    content: string = "",
    uid?: number,
    gid?: number,
    mode?: number,
  ): boolean {
    const parts = this.cleanPath(path);
    const fileName = parts.pop();
    if (!fileName) return false;

    // Navigasi ke folder tujuan
    let current = this.root;
    for (const part of parts) {
      if (
        !current.children.has(part) ||
        current.children.get(part)!.type !== VNodeType.DIRECTORY
      ) {
        this.logger.error(`Path not found for touch: ${path}`);
        return false;
      }
      current = current.children.get(part)!;
    }

    const now = Date.now();
    const newFile: VNode = {
      name: fileName,
      type: VNodeType.FILE,
      content: content,
      children: new Map(),
      parent: current,
      createdAt: now,
      modifiedAt: now,
      uid: uid ?? 0,
      gid: gid ?? 0,
      mode: mode ?? 420, // 0o644
    };
    current.children.set(fileName, newFile);
    this.logger.debug(`File created: ${fileName}`);
    return true;
  }

  /**
   * ls(): Menampilkan isi direktori.
   */
  public ls(path: string = "/"): any[] {
    const parts = this.cleanPath(path);
    let current = this.root;

    if (path !== "/") {
      for (const part of parts) {
        if (!current.children.has(part)) return [];
        current = current.children.get(part)!;
      }
    }

    const items: any[] = [];
    current.children.forEach((node, name) => {
      items.push({
        name: node.name,
        type: node.type,
        size:
          node.type === VNodeType.DIRECTORY
            ? 0
            : node.content
              ? node.content.length
              : 0,
        mode: node.mode,
        uid: node.uid,
        gid: node.gid,
        createdAt: node.createdAt,
        modified_at: node.modifiedAt, // Map to modified_at for compatibility
      });
    });
    return items;
  }

  /**
   * stat(): Mengambil metadata dari sebuah path.
   */
  public stat(path: string): any {
    const node = this.getNode(path);
    if (!node) return null;
    return {
      name: node.name,
      type: node.type,
      size: node.type === VNodeType.FILE ? (node.content?.length ?? 0) : 0,
      uid: node.uid,
      gid: node.gid,
      mode: node.mode,
      createdAt: node.createdAt,
      modifiedAt: node.modifiedAt,
    };
  }

  /**
   * read(): Membaca seluruh konten file.
   */
  public read(path: string): string | null {
    const node = this.getNode(path);
    if (!node || node.type !== VNodeType.FILE) return null;
    return node.content;
  }

  /**
   * append(): Menambahkan konten ke akhir file.
   */
  public append(path: string, content: string): boolean {
    const node = this.getNode(path);
    if (!node || node.type !== VNodeType.FILE) {
      // Coba buat file baru jika belum ada
      return this.touch(path, content);
    }
    node.content = (node.content ?? "") + content;
    node.modifiedAt = Date.now();
    return true;
  }

  /**
   * exists(): Cek apakah path ada dengan tipe tertentu (opsional).
   */
  public exists(path: string, type?: VNodeType): boolean {
    const node = this.getNode(path);
    if (!node) return false;
    if (type !== undefined && node.type !== type) return false;
    return true;
  }

  /**
   * unlink(): Menghapus file.
   */
  public unlink(path: string): boolean {
    const parts = this.cleanPath(path);
    const fileName = parts.pop();
    if (!fileName) return false;

    const parent = this.getNode(parts.join("/") || "/");
    if (!parent || parent.type !== VNodeType.DIRECTORY) return false;

    const child = parent.children.get(fileName);
    if (!child || child.type !== VNodeType.FILE) return false;

    parent.children.delete(fileName);
    this.logger.debug(`File unlinked: ${fileName}`);
    return true;
  }

  /**
   * rmdir(): Menghapus direktori kosong.
   */
  public rmdir(path: string): boolean {
    const parts = this.cleanPath(path);
    const dirName = parts.pop();
    if (!dirName) return false;

    const parent = this.getNode(parts.join("/") || "/");
    if (!parent || parent.type !== VNodeType.DIRECTORY) return false;

    const child = parent.children.get(dirName);
    if (!child || child.type !== VNodeType.DIRECTORY) return false;
    if (child.children.size > 0) return false; // Directory not empty

    parent.children.delete(dirName);
    this.logger.debug(`Directory removed: ${dirName}`);
    return true;
  }

  // ==================== CHMOD / CHOWN ====================

  /**
   * chmod(): Mengubah permission mode node.
   */
  public chmod(path: string, mode: number): boolean {
    const node = this.getNode(path);
    if (!node) return false;
    node.mode = mode;
    return true;
  }

  /**
   * chown(): Mengubah kepemilikan node.
   */
  public chown(path: string, uid: number, gid: number): boolean {
    const node = this.getNode(path);
    if (!node) return false;
    if (uid !== -1) node.uid = uid;
    if (gid !== -1) node.gid = gid;
    return true;
  }

  /**
   * getUsage(): Statistik penggunaan disk.
   */
  public async getUsage(): Promise<{
    size: number;
    files: number;
    dirs: number;
    diskSize?: number;
  }> {
    let totalSize = 0;
    let fileCount = 0;
    let dirCount = 1; // root

    const walk = (node: VNode) => {
      node.children.forEach((child) => {
        if (child.type === VNodeType.FILE) {
          fileCount++;
          totalSize += child.content?.length ?? 0;
        } else {
          dirCount++;
          walk(child);
        }
      });
    };
    walk(this.root);
    return { size: totalSize, files: fileCount, dirs: dirCount };
  }

  // ==================== CHUNKED I/O ====================

  /**
   * readChunk(): Membaca potongan konten file dari offset tertentu.
   * Return null jika path tidak valid, bukan file, atau offset di luar jangkauan.
   *
   * @param path   Path file
   * @param offset Posisi mulai baca (0-based)
   * @param length Jumlah karakter yang dibaca
   */
  public readChunk(
    path: string,
    offset: number,
    length: number,
  ): string | null {
    const node = this.getNode(path);
    if (!node || node.type !== VNodeType.FILE) return null;

    const content = node.content ?? "";
    if (offset < 0 || offset >= content.length) return null;

    return content.substring(offset, offset + length);
  }

  /**
   * writeChunk(): Menulis (mengganti) potongan konten file di offset tertentu.
   * Jika offset melebihi panjang file, akan membuat file baru / memperpanjang.
   *
   * @param path   Path file
   * @param chunk  Data yang ditulis
   * @param offset Posisi mulai tulis (0-based)
   */
  public writeChunk(path: string, chunk: string, offset: number): boolean {
    // Cari file, jika tidak ada buat baru
    let node = this.getNode(path);
    if (!node) {
      // Buat file baru dulu
      const success = this.touch(path, "");
      if (!success) return false;
      node = this.getNode(path);
      if (!node) return false;
    }
    if (node.type !== VNodeType.FILE) return false;

    const existing = node.content ?? "";
    if (offset >= existing.length) {
      // Perlu padding (spasi) jika offset jauh di luar
      const padding = " ".repeat(offset - existing.length);
      node.content = existing + padding + chunk;
    } else {
      // Replace di dalam konten yang sudah ada
      node.content =
        existing.substring(0, offset) +
        chunk +
        existing.substring(offset + chunk.length);
    }
    node.modifiedAt = Date.now();
    return true;
  }

  /**
   * getSize(): Mendapatkan ukuran file dalam byte.
   * Return -1 jika file tidak ditemukan.
   */
  public getSize(path: string): number {
    const node = this.getNode(path);
    if (!node || node.type !== VNodeType.FILE) return -1;
    return node.content?.length ?? 0;
  }

  // ==================== PRIVATE HELPERS ====================

  /**
   * Fungsi pembantu untuk memproses path string menjadi array.
   */
  private cleanPath(path: string): string[] {
    return path.split("/").filter((p) => p.length > 0);
  }

  /**
   * getNode(): Navigasi ke VNode berdasarkan path.
   * Return null jika tidak ditemukan.
   */
  private getNode(path: string): VNode | null {
    if (path === "/" || path === "") return this.root;

    const parts = this.cleanPath(path);
    let current = this.root;
    for (const part of parts) {
      if (!current.children.has(part)) return null;
      current = current.children.get(part)!;
    }
    return current;
  }
}
