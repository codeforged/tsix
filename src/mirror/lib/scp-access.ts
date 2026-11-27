/**
 * scp-access — keputusan izin file untuk scpd (SEC-03).
 *
 * scpd berjalan sebagai root. Tanpa pemeriksaan ini, user mana pun yang
 * berhasil login bisa membaca/menulis file APA PUN (mis. /etc/shadow,
 * /etc/rc.local) dengan hak root. Modul ini memutuskan, atas nama user yang
 * login, apakah sebuah operasi boleh, dengan semantik izin Unix yang sama
 * seperti PermissionManager kernel (kelas pertama yang cocok menentukan).
 *
 * Ini perbaikan MINIMAL. Perbaikan yang lebih kuat: worker per sesi yang
 * menurunkan identitas ke user (setgroups/setgid/setuid) sehingga kernel
 * sendiri yang memutuskan, tanpa jeda cek-lalu-tulis (TOCTOU).
 */

export const READ = 4;
export const WRITE = 2;
export const EXEC = 1;

export interface ScpUser {
    name: string;
    uid: number;
    gid: number;
    groups: number[];
    /** Home directory (dasar path relatif, seperti scp di Unix). */
    home: string;
}

export interface FsNodeLike {
    uid?: number;
    gid?: number;
    mode?: number;
    type?: string;
}

/** lookupUser(): identitas user dari isi /etc/passwd + /etc/group. */
export function lookupUser(passwd: string, group: string, name: string): ScpUser | null {
    const entry = (passwd || "")
        .split("\n")
        .map((l) => l.trim().split(":"))
        .find((p) => p[0] === name && p.length > 3);
    if (!entry) return null;
    const uid = parseInt(entry[2], 10);
    const gid = parseInt(entry[3], 10);
    if (!Number.isInteger(uid) || !Number.isInteger(gid)) return null;
    const groups = new Set<number>([gid]);
    for (const line of (group || "").split("\n")) {
        const g = line.trim().split(":");
        if (g.length < 3) continue;
        const members = (g[3] || "").split(",").map((m) => m.trim());
        const id = parseInt(g[2], 10);
        if (members.includes(name) && Number.isInteger(id)) groups.add(id);
    }
    return { name, uid, gid, groups: [...groups], home: entry[5] || "/" };
}

/**
 * normalizeScpPath(): path absolut ternormalisasi (tanpa `.`/`..`), atau null.
 * Path relatif diselesaikan terhadap `base` (home user); tanpa `base` ditolak.
 */
export function normalizeScpPath(input: unknown, base?: string): string | null {
    if (typeof input !== "string" || !input || input.includes("\0")) return null;
    let full: string = input;
    if (!full.startsWith("/")) {
        if (!base || !base.startsWith("/")) return null;
        full = `${base}/${full}`;
    }
    const parts: string[] = [];
    for (const seg of full.split("/")) {
        if (!seg || seg === ".") continue;
        if (seg === "..") parts.pop();
        else parts.push(seg);
    }
    return "/" + parts.join("/");
}

export function parentDir(p: string): string {
    const i = p.lastIndexOf("/");
    return i <= 0 ? "/" : p.substring(0, i);
}

/** allowed(): apakah `user` boleh `want` (gabungan READ/WRITE/EXEC) atas `node`? */
export function allowed(user: ScpUser, node: FsNodeLike, want: number): boolean {
    if (user.uid === 0) return true;
    const mode = typeof node.mode === "number" ? node.mode : 0;
    let bits: number;
    if (node.uid === user.uid) bits = (mode >> 6) & 7;
    else if (node.gid !== undefined && user.groups.includes(node.gid)) bits = (mode >> 3) & 7;
    else bits = mode & 7;
    return (bits & want) === want;
}

/**
 * AuthLimiter — batas percobaan login scpd.
 *   - per sesi: `perSession` gagal → sesi harus diulang dari key exchange;
 *   - global: `global` gagal per jendela waktu, karena alamat sumber (dan
 *     jadi sesi baru) bisa dibuat sesuka penyerang.
 * Saat terblokir, bcrypt tidak dijalankan sama sekali.
 */
export class AuthLimiter {
    private perSessionFails = new Map<string, number>();
    private globalFails: number[] = [];

    constructor(
        private readonly perSession = 5,
        private readonly global = 30,
        private readonly windowMs = 60_000,
    ) {}

    blocked(sessionId: string, now: number = Date.now()): boolean {
        this.globalFails = this.globalFails.filter((t) => now - t < this.windowMs);
        return (
            (this.perSessionFails.get(sessionId) || 0) >= this.perSession ||
            this.globalFails.length >= this.global
        );
    }

    fail(sessionId: string, now: number = Date.now()): void {
        this.perSessionFails.set(sessionId, (this.perSessionFails.get(sessionId) || 0) + 1);
        this.globalFails.push(now);
    }

    forget(sessionId: string): void {
        this.perSessionFails.delete(sessionId);
    }
}
