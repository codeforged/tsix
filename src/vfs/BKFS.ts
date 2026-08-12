import Database from "better-sqlite3";
import * as path from "path";
import { Logger } from "../common/Logger";
import { IVFS } from "./IVFS";
import { VNodeType } from "./VFS";

/**
 * BKFS (Bukan Kernel File System)
 *
 * VFS berbasis SQLite untuk penyimpanan persisten di User-land.
 * Ini mensimulasikan Disk Drive (seperti /dev/sda di Linux).
 */
export class BKFS implements IVFS {
  private db: Database.Database;
  private logger: Logger;
  private readOnly: boolean;

  constructor(
    dbPath: string = "system.db",
    readOnly: boolean = false,
    uid?: number,
    gid?: number,
    mode?: number,
  ) {
    this.logger = new Logger("BKFS");
    this.readOnly = readOnly;
    this.db = new Database(dbPath, { readonly: readOnly });

    // Inisialisasi tabel jika belum ada
    this.initSchema();

    // Override root ownership/permissions if specified
    if (uid !== undefined || gid !== undefined || mode !== undefined) {
      this.db
        .prepare(
          "UPDATE vnodes SET uid = ?, gid = ?, mode = ? WHERE name = '/' AND parent_id IS NULL",
        )
        .run(uid ?? 0, gid ?? 0, mode ?? 0o755);
    }

    const absPath = path.resolve(dbPath);
    this.logger.info(`VFS Database connected: ${absPath}`);
  }

  private initSchema() {
    // Tabel vnodes: menyimpan struktur folder dan file + Metadata Security
    this.db.exec(`
            CREATE TABLE IF NOT EXISTS vnodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                parent_id INTEGER,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                content TEXT,
                size INTEGER DEFAULT 0,
                uid INTEGER DEFAULT 0,    -- User ID (0 = root)
                gid INTEGER DEFAULT 0,    -- Group ID (0 = root)
                mode INTEGER DEFAULT 420, -- Permission (Decimal dari Octal: 644 = 420, 755 = 493)
                created_at INTEGER,
                modified_at INTEGER,
                FOREIGN KEY (parent_id) REFERENCES vnodes(id),
                UNIQUE(parent_id, name)
            );
        `);

    // Hapus duplikasi jika ada (Migration Hack dari Lapis 10.2)
    try {
      this.db.exec(`
                DELETE FROM vnodes 
                WHERE id NOT IN (
                    SELECT MIN(id) 
                    FROM vnodes 
                    GROUP BY parent_id, name
                );
            `);
    } catch (e) {
      // Ignore if migration fails on fresh DB
    }

    // Migration: Tambahkan kolom jika belum ada (SQLite ALTER TABLE)
    try {
      this.db.exec("ALTER TABLE vnodes ADD COLUMN uid INTEGER DEFAULT 0");
    } catch (e) {}
    try {
      this.db.exec("ALTER TABLE vnodes ADD COLUMN gid INTEGER DEFAULT 0");
    } catch (e) {}
    try {
      this.db.exec("ALTER TABLE vnodes ADD COLUMN mode INTEGER DEFAULT 420");
    } catch (e) {}
    try {
      this.db.exec("ALTER TABLE vnodes ADD COLUMN modified_at INTEGER");
    } catch (e) {}
    try {
      this.db.exec("ALTER TABLE vnodes ADD COLUMN size INTEGER DEFAULT 0");
    } catch (e) {}

    // Masukkan root (/) jika belum ada (Mode 755 = 493)
    const root = this.db
      .prepare("SELECT id FROM vnodes WHERE name = '/' AND parent_id IS NULL")
      .get();
    if (!root) {
      this.db
        .prepare(
          "INSERT INTO vnodes (name, type, uid, gid, mode, created_at) VALUES ('/', 'DIRECTORY', 0, 0, 493, ?)",
        )
        .run(Date.now());
      this.logger.debug("Root (/) created in BKFS with root permissions.");
    }
  }

  /**
   * mkdir(): Membuat direktori di database.
   */
  public mkdir(
    path: string,
    uid: number = 0,
    gid: number = 0,
    mode: number = 493,
  ): boolean {
    if (this.readOnly) throw new Error("Read-only filesystem");
    const parts = path
      .split("/")
      .filter((p) => p.length > 0 && p !== "." && p !== "..");
    let parentId = this.getRootId();

    for (const part of parts) {
      let node = this.db
        .prepare("SELECT id FROM vnodes WHERE name = ? AND parent_id = ?")
        .get(part, parentId) as { id: number } | undefined;

      if (!node) {
        const now = Date.now();
        const result = this.db
          .prepare(
            "INSERT INTO vnodes (parent_id, name, type, uid, gid, mode, created_at, modified_at) VALUES (?, ?, 'DIRECTORY', ?, ?, ?, ?, ?)",
          )
          .run(parentId, part, uid, gid, mode, now, now);
        parentId = result.lastInsertRowid as number;
        this.logger.debug(
          `Directory created in BKFS: ${part} (Mode: ${mode.toString(8)})`,
        );
      } else {
        parentId = node.id;
      }
    }
    return true;
  }

  /**
   * touch(): Membuat file di database.
   */
  public touch(
    path: string,
    content: string = "",
    uid: number = 0,
    gid: number = 0,
    mode: number = 420,
  ): boolean {
    if (this.readOnly) throw new Error("Read-only filesystem");
    const parts = path
      .split("/")
      .filter((p) => p.length > 0 && p !== "." && p !== "..");
    const fileName = parts.pop();
    if (!fileName) return false;

    let parentId = this.getRootId();
    // Navigasi ke folder tujuan
    for (const part of parts) {
      let node = this.db
        .prepare(
          "SELECT id FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'DIRECTORY'",
        )
        .get(part, parentId) as { id: number } | undefined;
      if (!node) return false;
      parentId = node.id;
    }

    // Cek apakah file sudah ada
    const existing = this.db
      .prepare(
        "SELECT id FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'FILE'",
      )
      .get(fileName, parentId);

    if (existing) {
      this.db
        .prepare(
          "UPDATE vnodes SET content = ?, size = ?, modified_at = ? WHERE id = ?",
        )
        .run(content, content.length, Date.now(), (existing as any).id);
      return true;
    }

    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO vnodes (parent_id, name, type, content, size, uid, gid, mode, created_at, modified_at) VALUES (?, ?, 'FILE', ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        parentId,
        fileName,
        content,
        content.length,
        uid,
        gid,
        mode,
        now,
        now,
      );

    this.logger.debug(
      `File created/updated in BKFS: ${fileName} (Mode: ${mode.toString(8)})`,
    );
    return true;
  }

  /**
   * append(): Menambahkan konten ke akhir file.
   */
  public append(path: string, content: string): boolean {
    if (this.readOnly) throw new Error("Read-only filesystem");

    const parts = path
      .split("/")
      .filter((p) => p.length > 0 && p !== "." && p !== "..");
    const fileName = parts.pop();
    if (!fileName) return false;

    let parentId = this.getRootId();
    for (const part of parts) {
      let node = this.db
        .prepare(
          "SELECT id FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'DIRECTORY'",
        )
        .get(part, parentId) as { id: number } | undefined;
      if (!node) return false;
      parentId = node.id;
    }

    const existing = this.db
      .prepare(
        "SELECT id FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'FILE'",
      )
      .get(fileName, parentId);

    if (existing) {
      // Append to existing content
      this.db
        .prepare(
          "UPDATE vnodes SET content = IFNULL(content, '') || ?, size = IFNULL(size, 0) + ?, modified_at = ? WHERE id = ?",
        )
        .run(content, content.length, Date.now(), (existing as any).id);
      return true;
    } else {
      // Create new file if not exists
      return this.touch(path, content);
    }
  }

  /**
   * stat(): Mengambil metadata file/folder.
   */
  public stat(path: string) {
    const parts = path
      .split("/")
      .filter((p) => p.length > 0 && p !== "." && p !== "..");
    let parentId = this.getRootId();

    if (path === "/") {
      return this.db
        .prepare("SELECT * FROM vnodes WHERE id = ?")
        .get(parentId) as any;
    }

    const targetName = parts.pop();
    if (!targetName) return null; // Should not happen if path is not "/" and parts is not empty

    for (const part of parts) {
      let node = this.db
        .prepare(
          "SELECT id FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'DIRECTORY'",
        )
        .get(part, parentId) as { id: number } | undefined;
      if (!node) return null;
      parentId = node.id;
    }

    return this.db
      .prepare("SELECT * FROM vnodes WHERE name = ? AND parent_id = ?")
      .get(targetName, parentId) as any;
  }

  /**
   * chmod(): Mengubah permission file/folder.
   */
  public chmod(path: string, mode: number): boolean {
    if (this.readOnly) throw new Error("Read-only filesystem");
    const node = this.stat(path);
    if (!node) return false;

    this.db
      .prepare("UPDATE vnodes SET mode = ? WHERE id = ?")
      .run(mode, node.id);
    return true;
  }

  /**
   * chown(): Mengubah pemilik file/folder.
   */
  public chown(path: string, uid: number, gid: number): boolean {
    if (this.readOnly) throw new Error("Read-only filesystem");
    const node = this.stat(path);
    if (!node) return false;

    this.db
      .prepare("UPDATE vnodes SET uid = ?, gid = ? WHERE id = ?")
      .run(uid, gid, node.id);
    return true;
  }

  /**
   * ls(): List isi folder dari database.
   */
  public ls(path: string = "/"): any[] {
    let parentId = this.getRootId();

    if (path !== "/") {
      const parts = path
        .split("/")
        .filter((p) => p.length > 0 && p !== "." && p !== "..");
      for (const part of parts) {
        let node = this.db
          .prepare(
            "SELECT id FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'DIRECTORY'",
          )
          .get(part, parentId) as { id: number } | undefined;
        if (!node) return [];
        parentId = node.id;
      }
    }

    // Menggunakan GROUP BY name untuk mencegah duplikasi jika database "kotor"
    // Tambahkan filter untuk '.' dan '..' agar tidak terjadi infinite recursion di aplikasi userland
    const rows = this.db
      .prepare(
        "SELECT name, type, mode, uid, gid, modified_at, size FROM vnodes WHERE parent_id = ? AND name != '' AND name != '.' AND name != '..' GROUP BY name",
      )
      .all(parentId) as any[];
    return rows as any[];
  }

  /**
   * exists(): Cek apakah path ada di database dengan tipe tertentu.
   */
  public exists(path: string, type?: VNodeType): boolean {
    const parts = path
      .split("/")
      .filter((p) => p.length > 0 && p !== "." && p !== "..");
    let parentId = this.getRootId();

    if (path === "/") return true;

    const targetName = parts.pop();
    if (!targetName) return true; // root case already handled

    for (const part of parts) {
      let node = this.db
        .prepare(
          "SELECT id FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'DIRECTORY'",
        )
        .get(part, parentId) as { id: number } | undefined;
      if (!node) return false;
      parentId = node.id;
    }

    let query = "SELECT id FROM vnodes WHERE name = ? AND parent_id = ?";
    let params: any[] = [targetName, parentId];
    if (type) {
      query += " AND type = ?";
      params.push(type);
    }

    const result = this.db.prepare(query).get(...params);
    return !!result;
  }

  /**
   * read(): Membaca konten file dari database.
   */
  public read(path: string): string | null {
    const parts = path
      .split("/")
      .filter((p) => p.length > 0 && p !== "." && p !== "..");
    const fileName = parts.pop();
    if (!fileName) return null;

    let parentId = this.getRootId();
    for (const part of parts) {
      let node = this.db
        .prepare(
          "SELECT id FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'DIRECTORY'",
        )
        .get(part, parentId) as { id: number } | undefined;
      if (!node) return null;
      parentId = node.id;
    }

    const file = this.db
      .prepare(
        "SELECT content FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'FILE'",
      )
      .get(fileName, parentId) as { content: string } | undefined;

    return file ? file.content : null;
  }

  /**
   * unlink(): Menghapus file dari database.
   */
  public unlink(path: string): boolean {
    if (this.readOnly) throw new Error("Read-only filesystem");
    const parts = path.split("/").filter((p) => p.length > 0);
    const fileName = parts.pop();
    if (!fileName) return false;

    let parentId = this.getRootId();
    for (const part of parts) {
      let node = this.db
        .prepare(
          "SELECT id FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'DIRECTORY'",
        )
        .get(part, parentId) as { id: number } | undefined;
      if (!node) return false;
      parentId = node.id;
    }

    const result = this.db
      .prepare(
        "DELETE FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'FILE'",
      )
      .run(fileName, parentId);

    return result.changes > 0;
  }

  /**
   * rmdir(): Menghapus direktori kosong dari database.
   */
  public rmdir(path: string): boolean {
    if (this.readOnly) throw new Error("Read-only filesystem");
    const parts = path.split("/").filter((p) => p.length > 0);
    const dirName = parts.pop();
    if (!dirName) return false;

    let parentId = this.getRootId();
    for (const part of parts) {
      let node = this.db
        .prepare(
          "SELECT id FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'DIRECTORY'",
        )
        .get(part, parentId) as { id: number } | undefined;
      if (!node) return false;
      parentId = node.id;
    }

    // Ambil ID direktori target
    const targetNode = this.db
      .prepare(
        "SELECT id FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'DIRECTORY'",
      )
      .get(dirName, parentId) as { id: number } | undefined;

    if (!targetNode) return false;

    // Cek apakah kosong
    const childrenCount = this.db
      .prepare("SELECT COUNT(*) as count FROM vnodes WHERE parent_id = ?")
      .get(targetNode.id) as { count: number };

    if (childrenCount.count > 0) return false; // Directory not empty

    const result = this.db
      .prepare("DELETE FROM vnodes WHERE id = ?")
      .run(targetNode.id);
    return result.changes > 0;
  }

  private getRootId(): number {
    const root = this.db
      .prepare("SELECT id FROM vnodes WHERE name = '/' AND parent_id IS NULL")
      .get() as { id: number };
    return root.id;
  }

  // ==================== CHUNKED I/O (Optimized) ====================

  /**
   * readChunk(): Membaca potongan konten file menggunakan SQLite SUBSTR().
   * HANYA membaca byte yang diperlukan — tidak fetch seluruh konten ke memori.
   * SUBSTR di SQLite 1-indexed, jadi start = offset + 1.
   */
  public readChunk(
    path: string,
    offset: number,
    length: number,
  ): string | null {
    const nodeId = this.getNodeId(path);
    if (nodeId < 0) return null;

    const row = this.db
      .prepare(
        "SELECT SUBSTR(content, ? + 1, ?) as chunk FROM vnodes WHERE id = ? AND type = 'FILE'",
      )
      .get(offset, length, nodeId) as { chunk: string | null } | undefined;

    return row?.chunk ?? null;
  }

  /**
   * writeChunk(): Menulis potongan konten menggunakan SQL concatenation.
   *
   * Untuk sequential append (offset == current size) → simple CONCAT, SUPER CEPAT.
   * Untuk random write di tengah → SUBSTR + CONCAT.
   *
   * TIDAK membaca seluruh konten ke memori JS — semua dilakukan di SQL.
   */
  public writeChunk(path: string, chunk: string, offset: number): boolean {
    if (this.readOnly) throw new Error("Read-only filesystem");

    // Dapatkan node ID + current size tanpa baca konten
    let info = this.getNodeIdAndSize(path);
    if (!info) {
      // Buat file baru jika belum ada
      const success = this.touch(path, "");
      if (!success) return false;
      info = this.getNodeIdAndSize(path);
      if (!info) return false;
    }

    const { id: nodeId, sz: currentSize } = info;
    const chunkLen = chunk.length;
    const newSize = Math.max(currentSize, offset + chunkLen);
    const now = Date.now();

    if (offset >= currentSize) {
      // Sequential append — paling cepat, simple CONCAT
      this.db
        .prepare(
          `
                UPDATE vnodes SET 
                    content = IFNULL(content,'') || ?,
                    size = ?,
                    modified_at = ?
                WHERE id = ?
            `,
        )
        .run(chunk, newSize, now, nodeId);
    } else {
      // Random write di tengah — SUBSTR + CONCAT (SQLite 1-indexed)
      this.db
        .prepare(
          `
                UPDATE vnodes SET 
                    content = SUBSTR(content, 1, ?) || ? || SUBSTR(content, ? + 1),
                    size = ?,
                    modified_at = ?
                WHERE id = ?
            `,
        )
        .run(offset, chunk, offset + chunkLen, newSize, now, nodeId);
    }

    return true;
  }

  /**
   * getNodeIdAndSize(): Navigasi path → (id, size) tanpa fetch konten.
   * Return null jika tidak ditemukan.
   */
  private getNodeIdAndSize(path: string): { id: number; sz: number } | null {
    const nodeId = this.getNodeId(path);
    if (nodeId < 0) return null;

    const row = this.db
      .prepare(
        "SELECT IFNULL(size, 0) as sz FROM vnodes WHERE id = ? AND type = 'FILE'",
      )
      .get(nodeId) as { sz: number } | undefined;

    return row ? { id: nodeId, sz: row.sz } : null;
  }

  /**
   * getSize(): Membaca langsung dari kolom `size` — tanpa fetch konten.
   */
  public getSize(path: string): number {
    const nodeId = this.getNodeId(path);
    if (nodeId < 0) return -1;

    const row = this.db
      .prepare(
        "SELECT IFNULL(size, 0) as sz FROM vnodes WHERE id = ? AND type = 'FILE'",
      )
      .get(nodeId) as { sz: number } | undefined;

    return row ? row.sz : -1;
  }

  /**
   * getNodeId(): Navigasi path ke node ID tanpa membaca konten.
   */
  private getNodeId(path: string): number {
    const parts = path
      .split("/")
      .filter((p) => p.length > 0 && p !== "." && p !== "..");
    let parentId = this.getRootId();

    if (path === "/") return parentId;

    const targetName = parts.pop();
    if (!targetName) return parentId;

    for (const part of parts) {
      let node = this.db
        .prepare(
          "SELECT id FROM vnodes WHERE name = ? AND parent_id = ? AND type = 'DIRECTORY'",
        )
        .get(part, parentId) as { id: number } | undefined;
      if (!node) return -1;
      parentId = node.id;
    }

    const target = this.db
      .prepare("SELECT id FROM vnodes WHERE name = ? AND parent_id = ?")
      .get(targetName, parentId) as { id: number } | undefined;

    return target ? target.id : -1;
  }

  public async getUsage(): Promise<{
    size: number;
    files: number;
    dirs: number;
    diskSize?: number;
  }> {
    const stats = this.db
      .prepare(
        `
            SELECT 
                SUM(CASE WHEN type = 'FILE' THEN length(content) ELSE 0 END) as total_size,
                SUM(CASE WHEN type = 'FILE' THEN 1 ELSE 0 END) as file_count,
                SUM(CASE WHEN type = 'DIRECTORY' THEN 1 ELSE 0 END) as dir_count
            FROM vnodes
            WHERE name != '/'
        `,
      )
      .get() as { total_size: number; file_count: number; dir_count: number };

    return {
      size: stats.total_size || 0,
      files: stats.file_count || 0,
      dirs: stats.dir_count || 0,
    };
  }
}
