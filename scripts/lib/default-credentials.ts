import * as bcrypt from "bcryptjs";

/**
 * Password bawaan akun root di checkout repo (`src/mirror/etc/shadow`).
 *
 * Diketahui publik (tertulis di README), jadi installer memaksa menggantinya
 * dan login dari jarak jauh menolaknya (`/bin/login.js --remote`).
 * Nilai ini harus sama dengan `Login.DEFAULT_ROOT_PASSWORD`.
 */
export const DEFAULT_ROOT_PASSWORD = "root";

/** hasDefaultRootPassword(): apakah entri root di isi /etc/shadow memakai password bawaan? */
export function hasDefaultRootPassword(shadowText: string): boolean {
    for (const line of (shadowText || "").split("\n")) {
        const fields = line.trim().split(":");
        if (fields[0] !== "root") continue;
        const hash = fields[1] || "";
        if (!hash.startsWith("$2")) return false; // terkunci (`!`, `*`) atau bukan bcrypt
        try {
            return bcrypt.compareSync(DEFAULT_ROOT_PASSWORD, hash);
        } catch {
            return false;
        }
    }
    return false;
}

/** rootPasswordProblem(): alasan password root baru ditolak, atau null jika boleh dipakai. */
export function rootPasswordProblem(password: string): string | null {
    if (!password) return "Root password must not be empty.";
    if (password.toLowerCase() === DEFAULT_ROOT_PASSWORD) {
        return `'${DEFAULT_ROOT_PASSWORD}' is the publicly known default password; choose another one.`;
    }
    return null;
}
