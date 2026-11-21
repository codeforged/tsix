import { IDevice } from "../IDevice";
import * as mysql from "mysql2/promise";

interface MySQLQueryRequest {
    sql: string;
    params?: any[] | Record<string, any>;
    includeFields?: boolean;
}

/**
 * MYSQL DEVICE (/dev/mysql) - Real Integration
 * 
 * Provides real database connectivity using mysql2 library.
 */
export class MySQLDevice implements IDevice {
    name = "mysql";
    uid = 0;
    gid = 0;
    mode = 0o660;
    disabled: boolean = false;

    /**
     * MULTI-INSTANCE: koneksi disimpan per-PID (Map<pid, Connection>).
     * Tiap proses pemakai (via DbLib / syscall DB_*) punya koneksi sendiri,
     * jadi dua app bisa akses server/database berbeda secara paralel tanpa
     * saling menutup koneksi. Jalur raw ioctl tanpa pid (legacy, mis.
     * iot-listener) memakai slot anonim (ANON_PID).
     */
    private static readonly ANON_PID = 0;

    /** Koneksi per-PID: pid → mysql.Connection */
    private connections = new Map<number, mysql.Connection>();
    /** Config per-PID (untuk read()) */
    private dbConfigs = new Map<number, any>();

    constructor() { }

    public read(): any {
        if (this.connections.size === 0) return "MySQL: Disconnected.\n";
        const lines: string[] = [];
        for (const [pid, _conn] of this.connections) {
            const cfg = this.dbConfigs.get(pid) || {};
            const label = pid === MySQLDevice.ANON_PID ? "anonymous" : `PID ${pid}`;
            lines.push(`MySQL: ${label} → ${cfg.host} (${cfg.database}).`);
        }
        return lines.join("\n") + "\n";
    }

    public async write(data: string): Promise<boolean> {
        if (this.connections.size === 0) return false;

        const sql = data.trim();
        if (sql.toUpperCase().startsWith("INSERT")) {
            let ok = false;
            for (const conn of this.connections.values()) {
                try {
                    await conn.execute(sql);
                    ok = true;
                } catch (err: any) {
                    console.error(`[MySQL Error] SQL: ${sql} | Error: ${err.message}`);
                }
            }
            return ok;
        }
        return false;
    }

    public async ioctl(cmd: number, arg: any): Promise<any> {
        if (cmd === 0x2001) { // MYSQL_IOCTL_CONNECT
            try {
                const { host, user, password, database } = arg || {};
                if (!host || !user || !database) return false;
                // Jalur raw ioctl tanpa pid → slot anonim (legacy).
                const pid = arg?.pid ?? MySQLDevice.ANON_PID;
                const port = arg?.port;

                // Tutup koneksi lama milik PID ini (jika ada) sebelum buat baru
                const old = this.connections.get(pid);
                if (old) {
                    try { await old.end(); } catch (_) {}
                }

                const conn = await mysql.createConnection({
                    host,
                    user,
                    password,
                    database,
                    ...(port ? { port } : {}),
                    namedPlaceholders: true,
                    connectTimeout: 5000
                });

                // Handle connection errors to prevent system crashes
                conn.on('error', (err) => {
                    console.error(`[MySQLDevice] Connection error: ${err.message}`);
                    // Don't crash the system, connection will be marked as invalid
                });

                this.connections.set(pid, conn);
                this.dbConfigs.set(pid, { host, database });
                return true;
            } catch (err: any) {
                console.error(`[MySQL Connection Error] ${err.message}`);
                return false;
            }
        }

        if (cmd === 0x2002) { // MYSQL_IOCTL_DISCONNECT
            const pid = arg?.pid ?? MySQLDevice.ANON_PID;
            const conn = this.connections.get(pid);
            if (!conn) return false;
            try { await conn.end(); } catch (_) {}
            this.connections.delete(pid);
            this.dbConfigs.delete(pid);
            return true;
        }

        return null;
    }

    /** release(): paksa tutup koneksi milik PID (dipanggil kernel saat proses mati). */
    public async release(pid: number): Promise<boolean> {
        const conn = this.connections.get(pid);
        if (!conn) return false;
        try { await conn.end(); } catch (_) {}
        this.connections.delete(pid);
        this.dbConfigs.delete(pid);
        return true;
    }

    /**
     * connect(): Buka koneksi milik PID — dipanggil oleh syscall DB_CONNECT (DbLib).
     * Reuse ioctl 0x2001 (MYSQL_IOCTL_CONNECT).
     */
    public async connect(cfg: any, pid: number): Promise<boolean> {
        return await this.ioctl(0x2001, { ...(cfg || {}), pid });
    }

    /**
     * disconnect(): Tutup koneksi milik PID — dipanggil oleh syscall DB_DISCONNECT (DbLib).
     * Reuse ioctl 0x2002 (MYSQL_IOCTL_DISCONNECT).
     */
    public async disconnect(pid: number): Promise<boolean> {
        return await this.ioctl(0x2002, { pid });
    }

    /**
     * query(): Eksekusi SQL arbitrer pada koneksi milik PID — dipanggil syscall DB_QUERY (DbLib).
     * - SELECT → array of rows
     * - INSERT/UPDATE/DELETE → ResultSetHeader (insertId, affectedRows, dll)
     * - Error → { error: message } (tidak throw, agar tidak crash proses)
     */
    public async query(
        input: string | MySQLQueryRequest,
        pid: number,
    ): Promise<any> {
        const conn = this.connections.get(pid);
        if (!conn) return { error: "MySQL: not connected" };
        const request: MySQLQueryRequest =
            typeof input === "string" ? { sql: input } : input;
        const trimmed = (request?.sql || "").trim();
        if (!trimmed) return { error: "MySQL: empty query" };
        try {
            const [rows, fields] =
                request.params === undefined
                    ? await conn.execute(trimmed)
                    : await conn.execute(trimmed, request.params);
            if (request.includeFields) {
                const metadata = (fields ?? []).map((field) => ({
                    name: field.name,
                    ...(field.schema ? { schema: field.schema } : {}),
                    table: field.table,
                    ...(field.orgName ? { orgName: field.orgName } : {}),
                    ...(field.orgTable ? { orgTable: field.orgTable } : {}),
                    columnType: field.columnType,
                    flags: field.flags,
                    decimals: field.decimals,
                    columnLength: field.columnLength,
                }));
                const header = Array.isArray(rows) ? null : rows;
                return {
                    rows,
                    fields: metadata,
                    ...(typeof header?.affectedRows === "number"
                        ? { affectedRows: header.affectedRows }
                        : {}),
                    ...(typeof header?.insertId === "number"
                        ? { insertId: header.insertId }
                        : {}),
                };
            }
            return rows;
        } catch (err: any) {
            console.error(`[MySQLDevice] Query error: ${err.message}`);
            return { error: err.message };
        }
    }
}

export default MySQLDevice;
