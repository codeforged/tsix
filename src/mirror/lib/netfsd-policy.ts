/**
 * netfsd-policy — keputusan keamanan untuk `netfsd --export` (SEC-10).
 *
 *   1. Tanpa `--key` request tidak terautentikasi sama sekali (siapa pun di
 *      broker bisa membaca/menulis export). Maka netfsd menolak start tanpa
 *      `--key`, kecuali `--insecure` eksplisit, yang memaksa read-only.
 *   2. netfsd berjalan sebagai root, jadi tanpa turun hak setiap request
 *      dilayani sebagai root. Daemon turun ke identitas `--as <user>` sebelum
 *      melayani; default = pemilik direktori export.
 *
 * Dependency-free: isi /etc/passwd diterima sebagai teks.
 */

export interface ExportSecurity {
    ok: boolean;
    readOnly: boolean;
    warnings: string[];
    error?: string;
}

export function exportSecurity(o: { hasKey: boolean; insecure: boolean; readOnly: boolean }): ExportSecurity {
    if (o.hasKey) return { ok: true, readOnly: o.readOnly, warnings: [] };
    if (!o.insecure) {
        return {
            ok: false,
            readOnly: o.readOnly,
            warnings: [],
            error:
                "netfsd: --key wajib (64 hex, sama di kedua sisi). Tanpa key, siapa pun di broker bisa " +
                "membaca/menulis export ini. Pakai --insecure hanya untuk uji di jaringan tertutup (dipaksa read-only).",
        };
    }
    return {
        ok: true,
        readOnly: true,
        warnings: ["--insecure: export TANPA autentikasi dan enkripsi; dipaksa read-only."],
    };
}

export type ServeIdentity = { uid: number; gid: number; name: string } | { error: string };

export function serveIdentity(
    asUser: string | undefined,
    exportOwner: { uid: number; gid: number },
    passwd: string,
): ServeIdentity {
    const users = String(passwd ?? "")
        .split(/\r?\n/)
        .map((l) => l.trim().split(":"))
        .filter((f) => f.length >= 4 && f[0]);
    if (asUser) {
        const u = users.find((f) => f[0] === asUser);
        if (!u) return { error: `user tidak dikenal: ${asUser}` };
        return { uid: Number(u[2]), gid: Number(u[3]), name: u[0] };
    }
    const owner = users.find((f) => Number(f[2]) === exportOwner.uid);
    return { uid: exportOwner.uid, gid: exportOwner.gid, name: owner ? owner[0] : String(exportOwner.uid) };
}
