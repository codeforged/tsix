import { describe, it, expect } from "vitest";
import { SecurityAgent } from "@common/SecurityAgent";
import { checkKnownHost, knownHostLine } from "./known-hosts";

describe("known-hosts (SEC-33, format sama dengan tssh)", () => {
    const real = SecurityAgent.generateKeyPair().publicKey;
    const fake = SecurityAgent.generateKeyPair().publicKey;
    const file = knownHostLine("wintsix", real);

    it("baris = `<host> <sha256 dihitung klien>`", () => {
        expect(file).toBe(`wintsix ${SecurityAgent.publicKeyFingerprint(real)}\n`);
    });

    it("host dikenal + kunci sama → trusted; kunci lain → mismatch; host lain → unknown", () => {
        expect(checkKnownHost(file, "wintsix", real)).toBe("trusted");
        expect(checkKnownHost(file, "wintsix", fake)).toBe("mismatch");
        expect(checkKnownHost(file, "jatitsix_3", real)).toBe("unknown");
        expect(checkKnownHost("", "wintsix", real)).toBe("unknown");
    });

    it("nama host harus persis (tidak cocok sebagian)", () => {
        expect(checkKnownHost(file, "wintsi", real)).toBe("unknown");
        expect(checkKnownHost(file.replace("wintsix", "wintsix2"), "wintsix", real)).toBe("unknown");
    });

    it("bukan public key → mismatch (jangan pernah dipercaya)", () => {
        expect(checkKnownHost(file, "wintsix", "bukan kunci")).toBe("mismatch");
        expect(checkKnownHost("", "wintsix", "bukan kunci")).toBe("mismatch");
    });
});
