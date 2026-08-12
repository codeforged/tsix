/**
 * DbLib.ts — Database sub-library (pola FsLib/NetworkLib)
 *
 * Lapisan akses database untuk aplikasi TSIX. Ring 4 tidak perlu tahu
 * medium transport (syscall → /dev/mysql hari ini; IPC/service daemon
 * atau TCP/IP di masa depan) — cukup pakai API ini.
 *
 * 🔌 MULTI-INSTANCE: koneksi MySQL disimpan per-PID di kernel/daemon.
 *    Tiap aplikasi punya DbLib sendiri; dua app bisa mengakses server &
 *    database berbeda secara paralel tanpa saling menutup koneksi.
 *
 * Usage (via UserLib): lib.db.connect(cfg); lib.db.query(sql); lib.db.disconnect();
 * Usage (via Application): import { db } from "@tsix/Application";
 *
 * (c) 2026 TSIX Project — DbLib
 */

import { SyscallCode } from "../../common/SyscallCode";

/** Konfigurasi koneksi database eksternal */
export interface DbConfig {
  host: string;
  user: string;
  password: string;
  database: string;
}

export class DbLib {
  constructor(
    private dispatch: (code: SyscallCode, args: any) => Promise<any>,
  ) {}

  /**
   * connect(): Buka koneksi ke database eksternal.
   * @param cfg { host, user, password, database }
   * @returns true jika berhasil, false jika gagal
   */
  public async connect(cfg: DbConfig): Promise<boolean> {
    return await this.dispatch(SyscallCode.DB_CONNECT, cfg);
  }

  /**
   * query(): Eksekusi SQL.
   * @param sql SELECT → array of rows; INSERT/UPDATE/DELETE → ResultSetHeader
   * @returns rows/ResultSetHeader, atau { error: message } jika gagal
   */
  public async query(sql: string): Promise<any> {
    return await this.dispatch(SyscallCode.DB_QUERY, sql);
  }

  /** disconnect(): Tutup koneksi database. */
  public async disconnect(): Promise<boolean> {
    return await this.dispatch(SyscallCode.DB_DISCONNECT, null);
  }
}
