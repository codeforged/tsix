import { describe, it, expect, vi, beforeAll } from "vitest";
import { SecurityAgent } from "@common/SecurityAgent";
import TSSHClient from "./tssh";

/**
 * tssh — pinning host key.
 *
 * Fingerprint yang dibandingkan dengan known_hosts harus DIHITUNG client dari
 * public key yang benar-benar dipakai untuk mengenkripsi session key, bukan
 * diambil dari fingerprint kiriman server (yang bisa saja milik host lain).
 */

let A: { publicKey: string; privateKey: string };
let B: { publicKey: string; privateKey: string };

beforeAll(() => {
    A = SecurityAgent.generateKeyPair();
    B = SecurityAgent.generateKeyPair();
});

function makeLib(knownHosts: string, answer = "no") {
    const files: Record<string, string> = { "/root/.ssh/known_hosts": knownHosts };
    const out: string[] = [];
    const lib = {
        shell: { getenv: vi.fn(async () => "/root") },
        fs: {
            readFile: vi.fn(async (p: string) => files[p] ?? null),
            writeFile: vi.fn(async (p: string, c: string) => {
                files[p] = c;
            }),
            mkdir: vi.fn(async () => undefined),
        },
        std: {
            print: vi.fn((s: string) => {
                out.push(s);
            }),
            readLine: vi.fn(async () => answer),
        },
    } as any;
    return { lib, files, out: () => out.join("") };
}

const fp = (pem: string) => SecurityAgent.publicKeyFingerprint(pem);
const accept = (lib: any, payload: string) =>
    (new TSSHClient() as any).acceptServerKey(lib, "rumah", payload);

describe("tssh acceptServerKey", () => {
    it("public key A + fingerprint B (B ada di known_hosts) → ditolak", async () => {
        const { lib, out } = makeLib(`rumah ${fp(B.publicKey)}\n`);
        const key = await accept(lib, `${A.publicKey}::${fp(B.publicKey)}`);
        expect(key).toBeNull();
        expect(out()).toMatch(/mismatch|CHANGED/i);
    });

    it("public key A tanpa klaim fingerprint, known_hosts berisi B → ditolak", async () => {
        const { lib } = makeLib(`rumah ${fp(B.publicKey)}\n`);
        expect(await accept(lib, A.publicKey)).toBeNull();
    });

    it("respons sah (key B, known_hosts B) → diterima, key yang dipakai = B", async () => {
        const { lib } = makeLib(`rumah ${fp(B.publicKey)}\n`);
        expect(await accept(lib, `${B.publicKey}::${fp(B.publicKey)}`)).toBe(B.publicKey);
    });

    it("TOFU: host baru → yang disimpan fingerprint hasil hitung client", async () => {
        const { lib, files } = makeLib("", "yes");
        expect(await accept(lib, `${A.publicKey}::${fp(A.publicKey)}`)).toBe(A.publicKey);
        expect(files["/root/.ssh/known_hosts"]).toContain(`rumah ${fp(A.publicKey)}`);
    });

    it("TOFU: klaim fingerprint server ≠ hasil hitung → ditolak tanpa prompt", async () => {
        const { lib, files } = makeLib("", "yes");
        expect(await accept(lib, `${A.publicKey}::${fp(B.publicKey)}`)).toBeNull();
        expect(lib.std.readLine).not.toHaveBeenCalled();
        expect(files["/root/.ssh/known_hosts"]).toBe("");
    });

    it("fingerprint sama dengan cara tsshd (SHA-256 penuh, hex) → known_hosts lama tetap cocok", () => {
        const crypto = require("crypto");
        const tsshdStyle = crypto.createHash("sha256").update(A.publicKey).digest("hex");
        expect(fp(A.publicKey)).toBe(tsshdStyle);
    });
});

describe("SecurityAgent.verifyPinnedKey", () => {
    it("cocok → true; beda key → false; abaikan huruf besar/kecil", () => {
        expect(SecurityAgent.verifyPinnedKey(A.publicKey, fp(A.publicKey))).toBe(true);
        expect(SecurityAgent.verifyPinnedKey(A.publicKey, fp(A.publicKey).toUpperCase())).toBe(true);
        expect(SecurityAgent.verifyPinnedKey(A.publicKey, fp(B.publicKey))).toBe(false);
        expect(SecurityAgent.verifyPinnedKey(A.publicKey, "")).toBe(false);
        expect(SecurityAgent.verifyPinnedKey(A.publicKey, "zz")).toBe(false);
    });
});
