/**
 * mysqld.ts — MySQL Service Daemon (transport alternatif DbLib)
 *
 * Lokasi: /opt/mysqld/mysqld.ts  (mirror: src/mirror/opt/mysqld/mysqld.ts)
 *
 * Backend MySQL sebagai SERVICE (Ring 4), pengganti /dev/mysql device.
 * Aplikasi TIDAK berubah — kernel me-route DB_* (connect/query/disconnect)
 * ke daemon ini setelah daemon mendaftar via shell.registerDbService().
 *
 * Alur:
 *   App → DbLib.query() → dispatch(DB_QUERY)
 *     → Kernel: dbServicePid terdaftar? → sendEvent(daemon, "db_request", {requestId, op, args})
 *     → Daemon: eksekusi mysql2 → shell.dbServiceReply(requestId, result)
 *     → Kernel: resolve pending → kembali ke App
 *
 * ⚠️ Daemon TIDAK menyimpan kredensial. Cred dikirim oleh aplikasi pemakai
 *    saat memanggil db.connect(cfg) → diteruskan kernel → daemon.
 *
 * 🔌 MULTI-INSTANCE: koneksi disimpan PER-PID (Map<pid, connection>).
 *    Tiap aplikasi pemakai punya koneksi sendiri → dua app bisa akses
 *    server/database MySQL berbeda secara paralel tanpa saling menutup.
 *    Saat app mati, kernel mengirim event "cleanup" agar koneksinya dilepas.
 *
 * Usage:
 *   mysqld             → start (default)
 *   mysqld --start     → start 
 *   mysqld --stop      → stop (kill PID dari pidfile)
 *   mysqld --restart   → restart
 *
 * Single-instance: PID file /opt/mysqld/mysqld.pid — run 2x → peringatan.
 *
 * (c) 2026 TSIX Project
 */

import { Program, std, shell, fs } from "@tsix/Application";

const PID_FILE = "/opt/mysqld/mysqld.pid";

// ─── Helpers pidfile & proses ───
async function readPid(): Promise<number | null> {
    try {
        const raw = await fs.readFile(PID_FILE);
        if (!raw) return null;
        const n = parseInt(String(raw).trim(), 10);
        return isNaN(n) ? null : n;
    } catch {
        return null;
    }
}
async function writePid(): Promise<void> {
    try { await fs.mkdir("/opt/mysqld"); } catch (_) { /* sudah ada */ }
    await fs.writeFile(PID_FILE, String(shell.getPid()));
}
async function removePid(): Promise<void> {
    try { await fs.unlink(PID_FILE); } catch (_) { /* tidak ada */ }
}
/**
 * Cek apakah PID tertentu adalah instance mysqld yang BENAR-BENAR hidup.
 * Cek nama proses juga — krusial karena PID bisa di-reuse antar reboot:
 * pidfile basi yang menunjuk ke PID yang sekarang dipakai proses lain TIDAK
 * boleh dianggap "mysqld sedang jalan" (dan tidak boleh di-kill saat --stop).
 */
async function isMysqldAlive(pid: number): Promise<boolean> {
    try {
        const procs = await shell.ps();
        return (
            Array.isArray(procs) &&
            procs.some(
                (p: any) =>
                    p.pid === pid &&
                    String(p.name || "").toLowerCase().includes("mysqld") &&
                    p.state !== "EXITED",
            )
        );
    } catch {
        return false;
    }
}

// ─── Stop: kill PID dari pidfile ───
async function stop(): Promise<boolean> {
    const pid = await readPid();
    if (!pid) {
        await std.print("[mysqld] tidak ada PID file — daemon tidak berjalan.\n");
        return false;
    }
    if (!(await isMysqldAlive(pid))) {
        // Pidfile basi (PID reuse / daemon sudah mati) — bersihkan, jangan kill proses lain!
        await std.print(`[mysqld] PID ${pid} bukan mysqld aktif — membersihkan pidfile.\n`);
        await removePid();
        return false;
    }
    await std.print(`[mysqld] menghentikan PID ${pid}...\n`);
    try { await shell.kill(pid, 15); } catch (_) { /* SIGTERM */ }
    await std.sleep(300);
    if (await isMysqldAlive(pid)) {
        try { await shell.kill(pid, 9); } catch (_) { /* SIGKILL */ }
    }
    await removePid();
    return true;
}

export const main = Program(async (args: string[]) => {
    const cmd = args[0] || "--start";

    if (cmd === "--stop") {
        await stop();
        return;
    }
    if (cmd === "--restart") {
        await stop();
    }

    // ═══ START (default / --start / --restart) ═══
    // 1. Single-instance guard — cek instance LAIN yang benar-benar mysqld.
    //    existing !== selfPid: pidfile basi + PID reuse antar reboot TIDAK boleh
    //    membuat proses ini berhenti (diri sendiri bisa dapat PID yang sama).
    //    isMysqldAlive: pastikan PID itu benar-benar mysqld yang hidup, bukan
    //    proses lain yang kebetulan mewarisi PID lama.
    const selfPid = shell.getPid();
    const existing = await readPid();
    if (existing && existing !== selfPid && (await isMysqldAlive(existing))) {
        await std.log(
            `mysqld sudah berjalan (PID ${existing}) — gunakan --restart untuk memulai ulang.`,
            "mysqld",
        );
        return;
    }
    // Pidfile basi / reuse PID → tulis ulang dengan PID proses ini nanti (writePid).

    // 2. Konektor mysql2 — modul host, boleh karena appName "mysqld" (privileged)
    const mysql = require("mysql2/promise");
    // Koneksi PER-PID: Map<pid, connection> — tiap aplikasi pemakai punya
    // koneksi sendiri (beda server/database bisa dipakai paralel).
    const connections = new Map<number, any>();
    const configs = new Map<number, any>();

    // 3. Daftar sebagai DB service → kernel route DB_* ke daemon ini
    await shell.registerDbService();
    await std.log("[mysqld] registered as DB service. Kernel will route DB_* here.");

    // 4. Tulis PID file
    await writePid();
    await std.log(`[mysqld] PID file: ${PID_FILE} (PID ${shell.getPid()})`);

    // 5. Listen "db_request" dari kernel (Scheduler.sendEvent → ipc_message)
    (global as any)._tsixLib.onEvent("db_request", async (req: any) => {
        const { requestId, pid, op, args: reqArgs } = req || {};
        try {
            let result: any;
            switch (op) {
                case "connect": {
                    // Cred datang dari aplikasi pemakai (db.connect(cfg)), bukan hardcoded di sini.
                    const c = reqArgs;
                    if (!pid || !c || !c.host || !c.user || !c.database) {
                        result = {
                            error: "mysqld: connect memerlukan cfg {host,user,password,database}",
                        };
                        break;
                    }
                    // Ganti koneksi milik PID ini (jika sudah ada)
                    const old = connections.get(pid);
                    if (old) {
                        try { await old.end(); } catch (_) {}
                    }
                    const conn = await mysql.createConnection({
                        host: c.host,
                        user: c.user,
                        password: c.password,
                        database: c.database,
                        connectTimeout: 5000,
                    });
                    conn.on("error", (err: any) => {
                        console.error(`[mysqld] Connection error (PID ${pid}): ${err.message}`);
                    });
                    connections.set(pid, conn);
                    configs.set(pid, c);
                    result = true;
                    break;
                }
                case "query": {
                    const conn = pid ? connections.get(pid) : undefined;
                    if (!conn) result = { error: "MySQL: not connected" };
                    else {
                        const [rows] = await conn.execute(String(reqArgs || ""));
                        result = rows;
                    }
                    break;
                }
                case "disconnect": {
                    const conn = pid ? connections.get(pid) : undefined;
                    if (conn) {
                        try { await conn.end(); } catch (_) {}
                        connections.delete(pid);
                        configs.delete(pid);
                    }
                    result = true;
                    break;
                }
                case "cleanup": {
                    // App pemakai mati → lepas koneksinya (fire-and-forget dari kernel)
                    const conn = pid ? connections.get(pid) : undefined;
                    if (conn) {
                        try { await conn.end(); } catch (_) {}
                        connections.delete(pid);
                        configs.delete(pid);
                    }
                    result = true;
                    break;
                }
                default:
                    result = { error: `mysqld: unknown op '${op}'` };
            }
            if (requestId) await shell.dbServiceReply(requestId, result);
        } catch (e: any) {
            if (requestId) await shell.dbServiceReply(requestId, { error: e.message });
        }
    });

    // 6. Detach ke background (lepas dari shell/TTY) lalu stay alive
    await shell.daemonize();
    await std.log("[mysqld] ready. Waiting for db_request...");
    while (true) {
        await new Promise((r) => setTimeout(r, 5000));
    }
}); 
