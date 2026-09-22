import { describe, it, expect } from "vitest";
import { ConfigParser } from "./ConfigParser";

/**
 * CONFIG PARSER (C11.70+) — pembacaan `.conf` gaya INI di userland.
 *
 * Semua uji di sini memakai `reader` yang disuntik, jadi TIDAK butuh kernel /
 * `global._tsixLib`: yang diuji murni logika teks → objek.
 *
 * Regresi yang dijaga (semua ditemukan saat review pertama):
 *   - C11.71: regex pemisah koma memakai `\$` (dolar literal, bukan anchor `$`),
 *     jadi `123, 456, 789` tidak pernah jadi array;
 *   - C11.72: `false` jadi string `"false"` alias truthy → `if (cfg.get(..))`
 *     selalu benar;
 *   - C11.73: komentar ekor (`nilai # catatan`) ikut tersimpan sebagai nilai;
 *   - C11.74: `0755` dipaksa jadi 755 desimal — niat oktalnya hilang;
 *   - C11.75: kunci 64 digit kehilangan presisi karena dikonversi ke Number.
 */
const read = (text: string | null) => async () => text;
const load = async (text: string | null) => {
  const parser = new ConfigParser("/etc/test.conf", { reader: read(text) });
  const ok = await parser.load();
  return { parser, ok };
};

describe("ConfigParser (C11.70+)", () => {
  it("C11.70 section, key, dan global section", async () => {
    const { parser, ok } = await load(`
versi = 1
[section1]
item1 = 1234
item2 = abcd
`);
    expect(ok).toBe(true);
    expect(parser.get("section1", "item1")).toBe(1234);
    expect(parser.get("section1", "item2")).toBe("abcd");
    // Key sebelum `[section]` pertama masuk global section "" + diberi warning.
    expect(parser.get("", "versi")).toBe(1);
    expect(parser.getStats().warnings.join(" ")).toContain("sebelum [section]");
    expect(parser.has("section1", "item2")).toBe(true);
    expect(parser.has("section1", "tidak-ada")).toBe(false);
  });

  it("C11.71 koma di luar kutip jadi array (regex lama tidak pernah pecah)", async () => {
    const { parser } = await load(`
[section2]
item21 = 123, 456, 789
item22 = "abc", 123, "xyz"
item23 = tunggal
`);
    expect(parser.get("section2", "item21")).toEqual([123, 456, 789]);
    expect(parser.get("section2", "item22")).toEqual(["abc", 123, "xyz"]);
    expect(parser.get("section2", "item23")).toBe("tunggal");
  });

  it("C11.71b koma DI DALAM kutip tidak memecah array", async () => {
    const { parser } = await load(`
[s]
alamat = "Jl. Cibogo, No. 5", "Bandung, Jawa Barat"
`);
    expect(parser.get("s", "alamat")).toEqual(["Jl. Cibogo, No. 5", "Bandung, Jawa Barat"]);
  });

  it("C11.72 boolean: false/no/off tidak lagi jadi string truthy", async () => {
    const { parser } = await load(`
[s]
aktif   = true
mati    = false
iya     = yes
tidak   = no
nyala   = on
padam   = off
`);
    expect(parser.get("s", "aktif")).toBe(true);
    expect(parser.get("s", "mati")).toBe(false);
    expect(parser.get("s", "iya")).toBe(true);
    expect(parser.get("s", "tidak")).toBe(false);
    expect(parser.get("s", "nyala")).toBe(true);
    expect(parser.get("s", "padam")).toBe(false);
    // Yang paling penting: `if (cfg.get("s","mati"))` sekarang TIDAK jalan.
    expect(!!parser.get("s", "mati")).toBe(false);
  });

  it("C11.73 komentar: baris penuh, ekor nilai, dan '#' di dalam kutip", async () => {
    const { parser, ok } = await load(`
# komentar penuh
; komentar gaya shell
[s]
kota   = Bandung      # ekor komentar
kanal  = kanal#1
kutip  = "/tmp/a#b"
`);
    expect(ok).toBe(true);
    expect(parser.get("s", "kota")).toBe("Bandung");
    // `#` tanpa spasi di depan bukan komentar (mis. nama kanal/tag).
    expect(parser.get("s", "kanal")).toBe("kanal#1");
    expect(parser.get("s", "kutip")).toBe("/tmp/a#b");
  });

  it("C11.74 angka: oktal/hex eksplisit, `0755` tidak dipaksa jadi desimal", async () => {
    const { parser } = await load(`
[s]
modeOk   = 0o755
modeTrap = 0755
hex      = 0x1f
suhu     = 36.5
suhuStr  = 36.50
besar    = 9007199254740993
`);
    expect(parser.get("s", "modeOk")).toBe(0o755);
    // `0755` adalah niat oktal — dipaksa jadi 755 desimal (= 0o1363) itu bug.
    expect(parser.get("s", "modeTrap")).toBe("0755");
    expect(parser.get("s", "hex")).toBe(31);
    expect(parser.get("s", "suhu")).toBe(36.5);
    expect(parser.get("s", "suhuStr")).toBe("36.50");
    // Angka yang tidak bisa bolak-balik utuh tetap string (tidak ada presisi hilang).
    expect(parser.get("s", "besar")).toBe("9007199254740993");
  });

  it("C11.75 kunci 64-hex tetap string & tidak kehilangan presisi", async () => {
    const key = "1234567890123456789012345678901234567890123456789012345678901234";
    const { parser } = await load(`
[net]
key = ${key}
`);
    expect(parser.get("net", "key")).toBe(key);
    expect(typeof parser.get("net", "key")).toBe("string");
  });

  it("C11.76 berkas kosong sah; berkas hilang → load() false + lastError", async () => {
    const empty = await load("");
    expect(empty.ok).toBe(true);
    expect(empty.parser.getAll()).toEqual({});

    const missing = await load(null);
    expect(missing.ok).toBe(false);
    expect(missing.parser.getStats().lastError).toContain("tidak ditemukan");
    // Tanpa load() sukses, `get()` tidak boleh menebak-nebak.
    expect(() => missing.parser.get("s", "k")).toThrow(/load\(\)/);
  });

  it("C11.77 warning dilaporkan, bukan diabaikan diam-diam", async () => {
    const { parser } = await load(`
baris rusak tanpa sama dengan
[s
key = nilai
[valid]
key = nilai
`);
    const stats = parser.getStats();
    expect(stats.warnings.join(" ")).toContain("bukan 'key = value'");
    expect(stats.warnings.join(" ")).toContain("tanpa ']'");
    expect(parser.get("valid", "key")).toBe("nilai");
  });

  it("C11.78 statistik pembacaan berkas", async () => {
    const { parser } = await load("[a]\nx = 1\n[b]\ny = 2\nz = 3\n");
    const stats = parser.getStats();
    expect(stats.path).toBe("/etc/test.conf");
    expect(stats.isLoaded).toBe(true);
    expect(stats.totalSections).toBe(2);
    expect(stats.totalKeys).toBe(3);
    expect(stats.fileLength).toBeGreaterThan(0);
    expect(stats.lastLoaded).not.toBe("never");
    expect(stats.lastError).toBeNull();
  });

  it("C11.79 contoh /etc/test.conf (mirror) dibaca sesuai ekspektasi demo", async () => {
    // Penjaga anti-drift: berkas contoh yang dipakai `/opt/test/read-config`
    // harus benar-benar menghasilkan nilai yang dijanjikan komentar di sana.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const sample = fs.readFileSync(
      path.resolve(__dirname, "../etc/test.conf"),
      "utf8",
    );

    const { parser, ok } = await load(sample);
    expect(ok).toBe(true);
    expect(parser.getStats().warnings).toEqual([]);
    expect(parser.get("section1", "item1")).toBe(1234);
    expect(parser.get("section1", "item2")).toBe("abcd");
    expect(parser.get("section2", "item21")).toEqual([123, 456, 789]);
    expect(parser.get("section2", "item22")).toEqual(["abc", 123, "xyz"]);
  });
});
