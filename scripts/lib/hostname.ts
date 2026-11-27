import * as crypto from "crypto";

/**
 * Hostname node = alamat MQTNL interface (dan nama topik MQTT).
 *
 * Di broker MQTT bersama (mis. broker publik gratisan), dua pengguna yang
 * memakai nama yang sama saling menerima paket satu sama lain. Nama bawaan
 * (`tsix`) dan nama umum dari tutorial paling sering bentrok, jadi installer
 * menolaknya dan menawarkan nama acak (SEC-21b).
 */
export const COMMON_HOSTNAMES = new Set([
    "tsix",
    "localhost",
    "node",
    "node1",
    "test",
    "demo",
    "server",
    "client",
    "esp32",
    "esp8266",
    "raspberrypi",
    "pi",
    "home",
    "iot",
]);

/** hostnameProblem(): alasan hostname ditolak, atau null jika boleh dipakai. */
export function hostnameProblem(hostname: string): string | null {
    const h = (hostname || "").trim();
    if (!h) return "Hostname must not be empty.";
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,30}$/.test(h)) {
        return "Use 1-31 letters, digits, '-' or '_' (no spaces, '/', '+', '#', '*').";
    }
    if (COMMON_HOSTNAMES.has(h.toLowerCase())) {
        return `'${h}' is a common name and likely to collide with other nodes on a shared MQTT broker.`;
    }
    return null;
}

/** suggestHostname(): nama acak `tsix-xxxxxx` (huruf kecil/angka). */
export function suggestHostname(): string {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    const bytes = crypto.randomBytes(6);
    let suffix = "";
    for (const b of bytes) suffix += alphabet[b % alphabet.length];
    return `tsix-${suffix}`;
}
