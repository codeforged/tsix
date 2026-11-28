/**
 * known-hosts — pinning kunci host untuk klien (scp; format sama dengan tssh).
 *
 * File `~/.ssh/known_hosts`, per baris `<host> <sha256-hex-64>`. Fingerprint
 * SELALU dihitung klien dari public key yang diterima; fingerprint kiriman server
 * tidak pernah menentukan kepercayaan (SEC-02, SEC-33).
 *
 * scpd dan tsshd memakai host key yang sama (`/etc/keys/rsa`), jadi host yang
 * sudah dipercaya di tssh otomatis dipercaya di scp, dan sebaliknya.
 */
import { SecurityAgent } from "@common/SecurityAgent";

export type HostTrust = "trusted" | "mismatch" | "unknown";

function isPublicKey(pem: unknown): pem is string {
    return typeof pem === "string" && pem.includes("PUBLIC KEY");
}

export function checkKnownHost(content: string, host: string, publicKeyPem: string): HostTrust {
    if (!isPublicKey(publicKeyPem)) return "mismatch";
    let seen = false;
    for (const line of String(content ?? "").split("\n")) {
        const [h, fp] = line.trim().split(/\s+/);
        if (!h || !fp || h !== host) continue;
        seen = true;
        if (SecurityAgent.verifyPinnedKey(publicKeyPem, fp)) return "trusted";
    }
    return seen ? "mismatch" : "unknown";
}

export function knownHostLine(host: string, publicKeyPem: string): string {
    return `${host} ${SecurityAgent.publicKeyFingerprint(publicKeyPem)}\n`;
}
