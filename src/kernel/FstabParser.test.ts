import { describe, it, expect } from "vitest";
import { parseFstabContent, FSTAB_MOUNT_TYPES } from "./FstabParser";

/**
 * FSTAB parser (A4) — pembacaan `/etc/fstab.conf` (INI) & `/etc/fstab.json` (lama).
 *
 * Regresi yang dijaga (semuanya ditemukan saat review):
 *   - berkas `.conf` belum ada di mana pun → kernel lama membaca `.json`, jadi
 *     `.conf` harus DIUTAMAKAN tapi `.json` tetap dibaca (fallback);
 *   - `mode = 775` (niat oktal) dulu jadi 775 desimal = 0o1363 tanpa peringatan;
 *   - `key` (64 hex) bisa berubah jadi Number kalau kebetulan semua digit;
 *   - `type` typo dulu diam-diam jatuh ke HostVFS;
 *   - satu entri rusak menjatuhkan seluruh loop mount (semua di satu `try`);
 *   - `active = no` dulu tetap AKTIF (string "no" itu truthy).
 */
describe("FstabParser (A4)", () => {
    it("A4.01 INI: section, kutip, angka, boolean", () => {
        const { format, entries, warnings } = parseFstabContent(`
# komentar
; juga komentar
[/tmp]
hostPath = RAM
type     = ramfs
uid      = 0
gid      = 100
mode     = 0o1777
active   = true

[/mnt/shared]
hostPath = "shared"
type     = host
readOnly = no
uid      = 1000
`);

        expect(format).toBe("ini");
        expect(warnings).toEqual([]);
        expect(entries).toHaveLength(2);

        expect(entries[0]).toMatchObject({
            vfsPath: "/tmp",
            hostPath: "RAM",
            type: "ramfs",
            uid: 0,
            gid: 100,
            mode: 0o1777,
            active: true,
        });
        expect(entries[1]).toMatchObject({
            vfsPath: "/mnt/shared",
            hostPath: "shared",
            type: "host",
            readOnly: false,
            uid: 1000,
        });
    });

    it("A4.02 JSON lama tetap terbaca, mode desimal tidak berubah arti", () => {
        const { format, entries, warnings } = parseFstabContent(
            JSON.stringify([
                { vfsPath: "/tmp", hostPath: "RAM", type: "ramfs", mode: 1023, active: true },
                { vfsPath: "/mnt/sbak", hostPath: "systembak.db", type: "bkfs", mode: 509, uid: 1000 },
            ]),
        );

        expect(format).toBe("json");
        expect(warnings).toEqual([]);
        // 1023 & 509 adalah desimal di JSON lama (0o1777 & 0o775) — jangan diubah.
        expect(entries[0].mode).toBe(1023);
        expect(entries[1].mode).toBe(509);
    });

    it("A4.03 mode: 0o775 & 0775 = oktal; 775 telanjang diberi peringatan", () => {
        const octalPrefix = parseFstabContent("[/a]\ntype = ramfs\nmode = 0o775\n");
        const leadingZero = parseFstabContent("[/a]\ntype = ramfs\nmode = 0775\n");
        expect(octalPrefix.entries[0].mode).toBe(0o775);
        expect(leadingZero.entries[0].mode).toBe(0o775);
        expect(octalPrefix.warnings).toEqual([]);
        expect(leadingZero.warnings).toEqual([]);

        // Jebakan klasik: `mode = 775` dibaca DESIMAL (0o1363) → harus diwarnai.
        const bare = parseFstabContent("[/a]\ntype = ramfs\nmode = 775\n");
        expect(bare.entries[0].mode).toBe(775);
        expect(bare.warnings.join(" ")).toContain("0o775");

        // Di luar rentang / bukan angka → diabaikan (bukan diteruskan ke chmod).
        const tooBig = parseFstabContent("[/a]\ntype = ramfs\nmode = 99999\n");
        expect(tooBig.entries[0].mode).toBeUndefined();
        expect(tooBig.warnings.length).toBeGreaterThan(0);

        const notNumber = parseFstabContent("[/a]\ntype = ramfs\nmode = rwxr-xr-x\n");
        expect(notNumber.entries[0].mode).toBeUndefined();
        expect(notNumber.warnings.join(" ")).toContain("bukan angka");
    });

    it("A4.04 hanya key numerik yang jadi Number (kunci NetFS tetap string)", () => {
        const hex = "c50f67b70e2f0dcf5246ccde04cb1297742ea20a51355eb61807137e003b5c65";
        const { entries } = parseFstabContent(`
[/mnt/net]
hostPath  = jatitsix:7777
type      = netfs
via       = 8888
key       = ${hex}
timeoutMs = 8000
agent     = chacha20
`);

        expect(entries[0]).toMatchObject({
            hostPath: "jatitsix:7777", // mengandung ':' tapi BUKAN JSON
            type: "netfs",
            via: 8888, // numerik
            key: hex, // 64 hex → tetap string
            timeoutMs: 8000,
            agent: "chacha20",
        });

        // Kunci yang seluruhnya digit pun tetap string (dulu bisa jadi Number).
        const numericKey = parseFstabContent("[/mnt/net]\ntype = netfs\nkey = 1234567890\n");
        expect(numericKey.entries[0].key).toBe("1234567890");
        expect(typeof numericKey.entries[0].key).toBe("string");
    });

    it("A4.05 typo dilaporkan, bukan diam-diam jadi HostVFS", () => {
        const { entries, warnings } = parseFstabContent(`
[/a]
type = disk
hostPath = shared

[/b]
type = ramfs
`);
        expect(entries).toHaveLength(1);
        expect(entries[0].vfsPath).toBe("/b");
        expect(warnings.join(" ")).toContain("type='disk'");
        expect(FSTAB_MOUNT_TYPES).toContain("host");
    });

    it("A4.06 aktif/nonaktif menerima no/off/0 (dulu 'no' tetap aktif)", () => {
        const { entries } = parseFstabContent(`
[/a]
type = ramfs
active = no

[/b]
type = ramfs
active = on

[/c]
type = ramfs
active = 0
`);
        expect(entries.map((e) => e.active)).toEqual([false, true, false]);
    });

    it("A4.07 entri rusak tidak menjatuhkan entri lain + baris aneh dilaporkan", () => {
        const { entries, warnings } = parseFstabContent(`
hostPath = nyasar
[/a]
type = ramfs
[/b]
type = typo-sekali
[/c]
mode = 0o755
type = ramfs
bukan-baris-valid
`);

        expect(entries.map((e) => e.vfsPath)).toEqual(["/a", "/c"]);
        const joined = warnings.join(" | ");
        expect(joined).toContain("sebelum [section]");
        expect(joined).toContain("typo-sekali");
        expect(joined).toContain("tanpa '='");
    });

    it("A4.08 komentar sebaris & berkas kosong", () => {
        const { entries } = parseFstabContent(`
[/a]
type = ramfs          # ramfs murni
hostPath = RAM        ; tanpa hostPath pun boleh
`);
        expect(entries[0].type).toBe("ramfs");
        expect(entries[0].hostPath).toBe("RAM");

        // Nilai berkutip TIDAK dipotong komentarnya (bisa memuat '#').
        const quoted = parseFstabContent('[/a]\ntype = host\nhostPath = "di#rumah"\n');
        expect(quoted.entries[0].hostPath).toBe("di#rumah");

        const empty = parseFstabContent("\n# cuma komentar\n");
        expect(empty.entries).toEqual([]);
        expect(empty.format).toBe("ini");
    });
});
