import { VNodeType } from "./VFS";

/**
 * IVFS (Interface Virtual File System)
 * 
 * Standar kontrak untuk semua implementasi file system di TSIX.
 * Memungkinkan Kernel menggunakan berbagai backend (SQLite, Host, RAM) secara transparan.
 */
export interface IVFS {
    ls(path: string): any[];
    mkdir(path: string, uid?: number, gid?: number, mode?: number): boolean;
    read(path: string): string | null;
    touch(path: string, content?: string, uid?: number, gid?: number, mode?: number): boolean;
    stat(path: string): any;
    chmod(path: string, mode: number): boolean;
    chown(path: string, uid: number, gid: number): boolean;
    unlink(path: string): boolean;
    rmdir(path: string): boolean;
    exists(path: string, type?: VNodeType): boolean;
    getUsage(): Promise<{ size: number, files: number, dirs: number, diskSize?: number }>;
    append(path: string, content: string): boolean;

    // --- Chunked I/O (Progress-aware, untuk file besar) ---
    /** Membaca sebagian konten file (offset-based, return null jika di luar range) */
    readChunk(path: string, offset: number, length: number): string | null;
    /** Menulis (replace) sebagian konten file di offset tertentu */
    writeChunk(path: string, chunk: string, offset: number): boolean;
    /** Mendapatkan ukuran file dalam byte, atau -1 jika tidak ditemukan */
    getSize(path: string): number;
}
