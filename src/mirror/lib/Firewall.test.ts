import { describe, it, expect } from "vitest";
import { Firewall, FIREWALL_DEFAULT_PATH } from "./Firewall";

/**
 * FIREWALL (ACL broker bridge) — uji semantik aturan.
 *
 * Skenario acuan (dipakai juga oleh dokumentasi tunnel):
 *
 *   Broker 1: X, X'
 *   Broker 2: Y, Z
 *   forward memblokir Y dua arah; Z diizinkan.
 *
 * Yang diuji di sini murni keputusan aturan (tanpa broker), karena kesalahan
 * di lapisan ini berarti "blokir diam-diam tidak jalan" — jenis bug yang paling
 * sulit dilihat saat simulasi.
 */

const pkt = (
    srcAddress: string,
    srcPort: number,
    dstAddress: string,
    dstPort: number,
) => ({ srcAddress, srcPort, dstAddress, dstPort });

const load = (text: string) => Firewall.fromText(text, "/tmp/fw.conf");

describe("Firewall — [address]", () => {
    it("F1.01 tanpa aturan → non-aktif, semua lolos", async () => {
        const fw = await load("[address]\n[port]\n");
        expect(fw.active).toBe(false);
        expect(fw.evaluate(pkt("x", 1, "y", 24)).allowed).toBe(true);
    });

    it("F1.02 deny satu alamat memblokir DUA arah (tujuan & sumber)", async () => {
        const fw = await load(`[address]\ndeny = "tsix-y"\n`);
        expect(fw.active).toBe(true);

        // X → Y (tujuan Y)
        expect(fw.evaluate(pkt("wintsix", 5000, "tsix-y", 24)).allowed).toBe(false);
        // Y → X (sumber Y) — balasan juga harus diblokir
        expect(fw.evaluate(pkt("tsix-y", 24, "wintsix", 5000)).allowed).toBe(false);
        // X → Z tetap lolos
        expect(fw.evaluate(pkt("wintsix", 5000, "tsix-z", 24)).allowed).toBe(true);
    });

    it("F1.03 beberapa alamat di daftar deny", async () => {
        const fw = await load(`[address]\ndeny = "tsix-y", "tsix-d"\n`);
        expect(fw.evaluate(pkt("x", 1, "tsix-y", 2)).allowed).toBe(false);
        expect(fw.evaluate(pkt("x", 1, "tsix-d", 2)).allowed).toBe(false);
        expect(fw.evaluate(pkt("x", 1, "tsix-c", 2)).allowed).toBe(true);
    });

    it("F1.04 allow-list membatasi: hanya salah satu ujung yang terdaftar", async () => {
        const fw = await load(`[address]\nallow = "tsix-z", "tsix-c"\n`);
        expect(fw.active).toBe(true);

        // X → Z (tujuan terdaftar) lolos
        expect(fw.evaluate(pkt("wintsix", 5000, "tsix-z", 24)).allowed).toBe(true);
        // Z → X (sumber terdaftar) lolos — penting agar balasan tidak putus
        expect(fw.evaluate(pkt("tsix-z", 24, "wintsix", 5000)).allowed).toBe(true);
        // X → Y (tidak terdaftar) diblokir
        expect(fw.evaluate(pkt("wintsix", 5000, "tsix-y", 24)).allowed).toBe(false);
    });

    it('F1.05 allow = "*" berarti semua alamat boleh', async () => {
        const fw = await load(`[address]\nallow = "*"\n`);
        expect(fw.evaluate(pkt("apa", 1, "saja", 2)).allowed).toBe(true);
    });

    it('F1.06 deny = "*" memblokir semua', async () => {
        const fw = await load(`[address]\ndeny = "*"\n`);
        expect(fw.evaluate(pkt("a", 1, "b", 2)).allowed).toBe(false);
    });

    it("F1.07 deny menang atas allow", async () => {
        const fw = await load(
            `[address]\nallow = "tsix-z", "tsix-y"\ndeny = "tsix-y"\n`,
        );
        expect(fw.evaluate(pkt("x", 1, "tsix-y", 2)).allowed).toBe(false);
        expect(fw.evaluate(pkt("x", 1, "tsix-z", 2)).allowed).toBe(true);
    });

    it("F1.08 nama alamat tidak peka huruf besar/kecil", async () => {
        const fw = await load(`[address]\ndeny = "TSIX-Y"\n`);
        expect(fw.evaluate(pkt("X", 1, "tsix-y", 2)).allowed).toBe(false);
        expect(fw.evaluate(pkt("x", 1, "Tsix-Y", 2)).allowed).toBe(false);
    });
});

describe("Firewall — [address] berarah (src/dst)", () => {
    it("F4.01 deny-src hanya memblokir peran sebagai pengirim", async () => {
        const fw = await load(`[address]\ndeny-src = "tsix-d"\n`);

        // D sebagai pengirim → diblokir
        expect(fw.evaluate(pkt("tsix-d", 24, "x", 5000)).allowed).toBe(false);
        // D sebagai tujuan → TIDAK diblokir (berbeda dari `deny`)
        expect(fw.evaluate(pkt("x", 5000, "tsix-d", 24)).allowed).toBe(true);
    });

    it("F4.02 deny-dst hanya memblokir peran sebagai tujuan", async () => {
        const fw = await load(`[address]\ndeny-dst = "tsix-y"\n`);

        expect(fw.evaluate(pkt("x", 5000, "tsix-y", 24)).allowed).toBe(false);
        // Balasan Y→X lolos karena Y bukan tujuan di paket itu
        expect(fw.evaluate(pkt("tsix-y", 24, "x", 5000)).allowed).toBe(true);
    });

    it("F4.03 allow-src membatasi pengirim saja", async () => {
        const fw = await load(`[address]\nallow-src = "wintsix"\n`);

        expect(fw.evaluate(pkt("wintsix", 5000, "siapa-saja", 24)).allowed).toBe(true);
        expect(fw.evaluate(pkt("lain", 5000, "wintsix", 24)).allowed).toBe(false);
    });

    it("F4.04 allow-dst membatasi tujuan saja (balasan ikut terblokir)", async () => {
        const fw = await load(`[address]\nallow-dst = "tsix-z"\n`);

        // X → Z lolos
        expect(fw.evaluate(pkt("wintsix", 5000, "tsix-z", 24)).allowed).toBe(true);
        // Balasan Z → X DIBLOKIR: dst balasan = X, bukan Z (dokumentasikan!)
        expect(fw.evaluate(pkt("tsix-z", 24, "wintsix", 5000)).allowed).toBe(false);
    });

    it("F4.05 allow-src + allow-dst = aturan berpasangan (AND)", async () => {
        const fw = await load(
            `[address]\nallow-src = "wintsix"\nallow-dst = "tsix-z", "wintsix"\n`,
        );

        expect(fw.evaluate(pkt("wintsix", 5000, "tsix-z", 24)).allowed).toBe(true);
        // sumber salah
        expect(fw.evaluate(pkt("lain", 5000, "tsix-z", 24)).allowed).toBe(false);
        // tujuan salah
        expect(fw.evaluate(pkt("wintsix", 5000, "tsix-y", 24)).allowed).toBe(false);
    });

    it("F4.06 allow dua arah + allow berarah: semuanya harus lolos", async () => {
        const fw = await load(
            `[address]\nallow = "wintsix", "tsix-z"\nallow-dst = "tsix-z"\n`,
        );

        expect(fw.evaluate(pkt("wintsix", 5000, "tsix-z", 24)).allowed).toBe(true);
        // `allow` lolos (src terdaftar) tetapi `allow-dst` gagal
        expect(fw.evaluate(pkt("wintsix", 5000, "tsix-c", 24)).allowed).toBe(false);
    });

    it("F4.07 deny-src/deny-dst menang atas allow-src/allow-dst", async () => {
        const fw = await load(
            `[address]\nallow-src = "tsix-d"\nallow-dst = "tsix-d"\ndeny-dst = "tsix-d"\n`,
        );
        expect(fw.evaluate(pkt("tsix-d", 1, "tsix-d", 2)).allowed).toBe(false);
    });

    it('F4.08 "*" pada key berarah = tanpa batasan dimensi itu', async () => {
        const fw = await load(
            `[address]\nallow-src = "*"\nallow-dst = "tsix-z"\n`,
        );
        expect(fw.evaluate(pkt("siapa", 1, "tsix-z", 2)).allowed).toBe(true);
        expect(fw.evaluate(pkt("siapa", 1, "lain", 2)).allowed).toBe(false);
    });

    it("F4.09 deny-src = \"*\" memblokir semua paket", async () => {
        const fw = await load(`[address]\ndeny-src = "*"\n`);
        expect(fw.evaluate(pkt("a", 1, "b", 2)).allowed).toBe(false);
        expect(fw.evaluate(pkt("b", 2, "a", 1)).allowed).toBe(false);
    });

    it("F4.10 hanya key berarah sudah membuat firewall aktif", async () => {
        const fw = await load(`[address]\nallow-dst = "tsix-z"\n`);
        expect(fw.active).toBe(true);

        const fw2 = await load(`[address]\ndeny-src = "tsix-d"\n`);
        expect(fw2.active).toBe(true);
    });

    it("F4.11 alasan penolakan menyebut key berarah yang kena", async () => {
        const fw = await load(`[address]\nallow-dst = "tsix-z"\n`);
        const v = fw.evaluate(pkt("wintsix", 5000, "tsix-y", 24));
        expect(v.allowed).toBe(false);
        expect(v.reason).toContain("allow-dst");
        expect(v.reason).toContain("tsix-y");
    });

    it("F4.12 deskripsi & ringkasan memuat aturan berarah", async () => {
        const fw = await load(
            `[address]\nallow-src = "wintsix"\ndeny-dst = "tsix-y"\n`,
        );

        const desc = fw.describe().join("\n");
        expect(desc).toContain("allow-src");
        expect(desc).toContain("deny-dst");
        expect(desc).toContain("wintsix");

        const s = fw.summary();
        expect(s).toContain("addr-allow-src=wintsix");
        expect(s).toContain("addr-deny-dst=tsix-y");
    });

    it("F4.13 aturan berarah digabung dengan [port] berarah", async () => {
        const fw = await load(
            `[address]\nallow-dst = "tsix-z"\nallow-src = "tsix-z", "wintsix"\n` +
                `\n[port]\nallow-dst = 24, 5000\n`,
        );

        expect(fw.evaluate(pkt("wintsix", 5000, "tsix-z", 24)).allowed).toBe(true);
        // alamat lolos, port tujuan tidak
        expect(fw.evaluate(pkt("wintsix", 5000, "tsix-z", 22)).allowed).toBe(false);
    });

    it("F4.14 key berarah tidak peka huruf besar/kecil & mendukung kutip", async () => {
        const fw = await load(`[address]\nALLOW-DST = "Tsix-Z"\n`);
        expect(fw.warnings).toEqual([]);
        expect(fw.evaluate(pkt("x", 1, "tsix-z", 2)).allowed).toBe(true);
        expect(fw.evaluate(pkt("x", 1, "tsix-y", 2)).allowed).toBe(false);
    });
});

describe("Firewall — [port]", () => {
    it("F2.01 deny-dst memblokir port tujuan tertentu", async () => {
        const fw = await load(`[port]\ndeny-dst = 22, 24\n`);
        expect(fw.evaluate(pkt("x", 5000, "y", 24)).allowed).toBe(false);
        expect(fw.evaluate(pkt("x", 5000, "y", 22)).allowed).toBe(false);
        expect(fw.evaluate(pkt("x", 5000, "y", 80)).allowed).toBe(true);
    });

    it("F2.02 deny-src memblokir port sumber tertentu", async () => {
        const fw = await load(`[port]\ndeny-src = 4000\n`);
        expect(fw.evaluate(pkt("x", 4000, "y", 24)).allowed).toBe(false);
        expect(fw.evaluate(pkt("x", 4001, "y", 24)).allowed).toBe(true);
    });

    it("F2.03 allow-dst membatasi port tujuan", async () => {
        const fw = await load(`[port]\nallow-dst = 24, 5000\n`);
        expect(fw.evaluate(pkt("x", 5000, "y", 24)).allowed).toBe(true);
        expect(fw.evaluate(pkt("x", 5000, "y", 80)).allowed).toBe(false);
    });

    it("F2.04 allow-src membatasi port sumber", async () => {
        const fw = await load(`[port]\nallow-src = 11, 21\n`);
        expect(fw.evaluate(pkt("x", 11, "y", 9999)).allowed).toBe(true);
        expect(fw.evaluate(pkt("x", 12, "y", 9999)).allowed).toBe(false);
    });

    it('F2.05 "*" pada allow-src/allow-dst berarti tanpa batasan', async () => {
        const fw = await load(`[port]\nallow-src = "*"\nallow-dst = "*"\n`);
        expect(fw.evaluate(pkt("x", 1, "y", 2)).allowed).toBe(true);
    });

    it("F2.06 kombinasi address+port: dua-duanya harus lolos", async () => {
        const fw = await load(
            `[address]\ndeny = "tsix-y"\n\n[port]\ndeny-dst = 22\n`,
        );
        // Y diblokir walau portnya diizinkan
        expect(fw.evaluate(pkt("x", 1, "tsix-y", 24)).allowed).toBe(false);
        // Z diblokir karena port 22
        expect(fw.evaluate(pkt("x", 1, "tsix-z", 22)).allowed).toBe(false);
        // Z:24 lolos
        expect(fw.evaluate(pkt("x", 1, "tsix-z", 24)).allowed).toBe(true);
    });
});

describe("Firewall — parsing & ketahanan", () => {
    it("F3.01 nilai integer dari parser dipakai apa adanya", async () => {
        const fw = await load(`[port]\ndeny-dst = 22, "8080"\n`);
        expect(fw.evaluate(pkt("x", 1, "y", 22)).allowed).toBe(false);
        expect(fw.evaluate(pkt("x", 1, "y", 8080)).allowed).toBe(false);
    });

    it("F3.02 port di luar 0-65535 diabaikan + peringatan", async () => {
        const fw = await load(`[port]\ndeny-dst = 70000, 22\n`);
        expect(fw.warnings.join("\n")).toMatch(/70000/);
        expect(fw.evaluate(pkt("x", 1, "y", 22)).allowed).toBe(false);
    });

    it("F3.03 wildcard sebagian (tsix-*) diperingatkan, tidak dipakai", async () => {
        const fw = await load(`[address]\ndeny = "tsix-*"\n`);
        expect(fw.warnings.join("\n")).toMatch(/wildcard/);
        // Karena pola tidak didukung, alamat tidak cocok → lolos (bukan blokir palsu)
        expect(fw.evaluate(pkt("x", 1, "tsix-y", 2)).allowed).toBe(true);
    });

    it("F3.04 key tak dikenal diperingatkan, bukan crash", async () => {
        const fw = await load(
            `[address]\nallow = "a"\nwarna = biru\n\n[port]\nblokir = 1\n`,
        );
        const w = fw.warnings.join("\n");
        expect(w).toMatch(/warna/);
        expect(w).toMatch(/blokir/);
        expect(fw.evaluate(pkt("a", 1, "b", 2)).allowed).toBe(true);
    });

    it("F3.05 komentar & kutip dihormati", async () => {
        const fw = await load(
            `# komentar penuh\n[address]\ndeny = "tsix-y"  # ekor komentar\n`,
        );
        expect(fw.evaluate(pkt("x", 1, "tsix-y", 2)).allowed).toBe(false);
    });

    it("F3.06 berkas tidak ada → non-aktif dengan peringatan jelas", async () => {
        const fw = await Firewall.load({
            path: FIREWALL_DEFAULT_PATH,
            reader: async () => null,
        });
        expect(fw.active).toBe(false);
        expect(fw.warnings.join("\n")).toMatch(/tidak ditemukan/);
        expect(fw.evaluate(pkt("x", 1, "y", 2)).allowed).toBe(true);
    });

    it("F3.07 reader melempar error → non-aktif, bukan crash", async () => {
        const fw = await Firewall.load({
            reader: async () => {
                throw new Error("VFS down");
            },
        });
        expect(fw.active).toBe(false);
        expect(fw.warnings.join("\n")).toMatch(/VFS down/);
    });

    it("F3.08 deskripsi & ringkasan mencerminkan aturan", async () => {
        const fw = await load(
            `[address]\ndeny = "tsix-y"\nallow = "tsix-z"\n\n[port]\ndeny-dst = 22\n`,
        );
        expect(fw.summary()).toContain("deny=tsix-y");
        expect(fw.summary()).toContain("allow=tsix-z");
        expect(fw.summary()).toContain("deny-dst=22");

        const desc = fw.describe().join("\n");
        expect(desc).toContain("AKTIF");
        expect(desc).toContain("tsix-y");
    });

    it("F3.09 alasan penolakan menyebut aturan yang kena", async () => {
        const fw = await load(`[address]\ndeny = "tsix-y"\n`);
        const v = fw.evaluate(pkt("x", 1, "tsix-y", 2));
        expect(v.allowed).toBe(false);
        expect(v.reason).toMatch(/deny/);
        expect(v.reason).toMatch(/tujuan/);
    });
});
