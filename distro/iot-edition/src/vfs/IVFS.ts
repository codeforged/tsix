import { MaybePromise } from "../common/MaybePromise";
import { VNodeType } from "./VFS";

/**
 * IVFS (Interface Virtual File System)
 *
 * Standar kontrak untuk semua implementasi file system di TSIX.
 * Memungkinkan Kernel menggunakan berbagai backend secara transparan:
 *
 *   | Driver   | Backing store              | Sinkron? |
 *   |----------|----------------------------|----------|
 *   | VFS      | in-memory tree             | ya       |
 *   | BKFS     | SQLite (system.db, .db)    | ya       |
 *   | HostVFS  | folder di host laptop (SH) | ya       |
 *   | RamFS    | RAM murni (/tmp, /run)     | ya       |
 *   | NetFS    | node TSIX lain via MQTNL   | TIDAK    |
 *
 * NetFS butuh bolak-balik jaringan, jadi return-nya `Promise`. Karena itu
 * semua method di bawah bertipe `MaybePromise<T>`:
 *
 *   - Pemakai (kernel) SELALU `await` hasilnya.
 *   - Driver sinkron tetap menulis `return nilai` biasa — tidak perlu diubah,
 *     karena `await` pada nilai biasa mengembalikan nilai itu apa adanya.
 */
export interface IVFS {
    ls(path: string): MaybePromise<any[]>;
    mkdir(path: string, uid?: number, gid?: number, mode?: number): MaybePromise<boolean>;
    read(path: string): MaybePromise<string | null>;
    touch(path: string, content?: string, uid?: number, gid?: number, mode?: number): MaybePromise<boolean>;
    stat(path: string): MaybePromise<any>;
    chmod(path: string, mode: number): MaybePromise<boolean>;
    chown(path: string, uid: number, gid: number): MaybePromise<boolean>;
    unlink(path: string): MaybePromise<boolean>;
    rmdir(path: string): MaybePromise<boolean>;
    exists(path: string, type?: VNodeType): MaybePromise<boolean>;
    getUsage(): Promise<{ size: number, files: number, dirs: number, diskSize?: number }>;
    append(path: string, content: string): MaybePromise<boolean>;

    // --- Chunked I/O (Progress-aware, untuk file besar) ---
    /** Membaca sebagian konten file (offset-based, return null jika di luar range) */
    readChunk(path: string, offset: number, length: number): MaybePromise<string | null>;
    /** Menulis (replace) sebagian konten file di offset tertentu */
    writeChunk(path: string, chunk: string, offset: number): MaybePromise<boolean>;
    /** Mendapatkan ukuran file dalam byte, atau -1 jika tidak ditemukan */
    getSize(path: string): MaybePromise<number>;
}
