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
  port?: number;
}

export type DbQueryParameters =
  | readonly unknown[]
  | Readonly<Record<string, unknown>>;

export interface DbQueryRequest {
  sql: string;
  params?: DbQueryParameters;
  includeFields?: boolean;
}

export interface DbQueryField {
  name: string;
  schema?: string;
  table?: string;
  orgName?: string;
  orgTable?: string;
  columnType?: number;
  flags?: number;
  decimals?: number;
  columnLength?: number;
}

export interface DbQueryResult {
  rows: unknown;
  fields: DbQueryField[];
  affectedRows?: number;
  insertId?: number | string;
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
   * query(): Eksekusi SQL, dengan parameter opsional untuk prepared statement.
   * @param sql SELECT → array of rows; INSERT/UPDATE/DELETE → ResultSetHeader
   * @param params positional (`?`) atau named (`:name`) parameters
   * @returns rows/ResultSetHeader, atau { error: message } jika gagal
   */
  public async query(
    sql: string,
    params?: DbQueryParameters,
  ): Promise<any> {
    const request = params === undefined ? sql : { sql, params };
    return await this.dispatch(SyscallCode.DB_QUERY, request);
  }

  /** Eksekusi SQL dan kembalikan metadata kolom bersama hasilnya. */
  public async queryWithFields(
    sql: string,
    params: DbQueryParameters = [],
  ): Promise<DbQueryResult | { error: string }> {
    return await this.dispatch(SyscallCode.DB_QUERY, {
      sql,
      params,
      includeFields: true,
    });
  }

  /** disconnect(): Tutup koneksi database. */
  public async disconnect(): Promise<boolean> {
    return await this.dispatch(SyscallCode.DB_DISCONNECT, null);
  }
}
