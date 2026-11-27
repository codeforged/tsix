/**
 * lantana-admin.ts — siapa yang boleh mengelola Lantana (K-10, K-11).
 *
 * Model: admin = pemilik node TSIX. Akun Lantana milik client admin, dan client
 * tidak punya user TSIX (mereka hanya memakai dashboard). Jadi yang boleh
 * mengelola Lantana (lantana-ctl / Control Panel, IPC Lantana) cukup:
 * root, atau user anggota grup `lantana-admin` (grup utama atau tambahan).
 *
 * Dependency-free: menerima isi /etc/passwd dan /etc/group sebagai teks.
 */

export const LANTANA_ADMIN_GROUP = "lantana-admin";

function lines(text: unknown): string[][] {
    if (typeof text !== "string") return [];
    return text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => l.split(":"));
}

/** GID grup lantana-admin dari isi /etc/group, atau null bila grup belum ada. */
export function lantanaAdminGid(group: string): number | null {
    const entry = lines(group).find((f) => f.length >= 3 && f[0] === LANTANA_ADMIN_GROUP);
    if (!entry || entry[2] === "") return null;
    const gid = Number(entry[2]);
    return Number.isInteger(gid) && gid >= 0 ? gid : null;
}

/** isLantanaAdmin(): apakah `uid` root atau anggota grup lantana-admin. */
export function isLantanaAdmin(uid: number, passwd: string, group: string): boolean {
    if (!Number.isInteger(uid) || uid < 0) return false;
    if (uid === 0) return true;

    const user = lines(passwd).find((f) => f.length >= 4 && Number(f[2]) === uid);
    if (!user) return false;
    const [username, , , primaryGid] = user;

    const admin = lines(group).find((f) => f.length >= 3 && f[0] === LANTANA_ADMIN_GROUP);
    if (!admin) return false;
    if (admin[2] !== "" && Number(admin[2]) === Number(primaryGid)) return true;

    const members = (admin[3] ?? "").split(",").map((m) => m.trim()).filter(Boolean);
    return members.includes(username);
}
