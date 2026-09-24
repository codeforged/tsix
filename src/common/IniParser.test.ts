import { describe, it, expect } from "vitest";
import { parseIni, parseIniScalar, stripInlineComment } from "./IniParser";
import {
    createDefaultSysConfig,
    formatSysConfigIni,
    parseSysConfigIni,
} from "./SysConfigIni";
import type { SysConfig } from "./Config";

/**
 * INI PARSER + SYS CONFIG (D9.xx)
 *
 * Yang diuji di sini adalah LOGIKA MURNI (tanpa I/O): aturan nilai, peta
 * section sysconfig, dan round-trip formatter → parser. Pembacaan berkas &
 * migrasi JSON ada di `Config.ts`, sedangkan tulis-baca installer di
 * `scripts/install.ts`.
 */

describe("IniParser (D9)", () => {
    // D9.01
    it("D9.01 scalar: string, angka, boolean, kutip, dan komentar", () => {
        expect(parseIniScalar("system.db")).toBe("system.db");
        expect(parseIniScalar("1883")).toBe(1883);
        expect(parseIniScalar("true")).toBe(true);
        expect(parseIniScalar("OFF")).toBe(false);
        expect(parseIniScalar("0o755")).toBe(0o755);
        expect(parseIniScalar("0x1f")).toBe(31);
        // Versi bertitik bukan angka (kalau dipaksa jadi Number, hilang presisi)
        expect(parseIniScalar("0.3.2.20260923.1")).toBe("0.3.2.20260923.1");
        // `0755` tetap STRING — memaksa jadi 755 desimal menghapus niat oktalnya
        expect(parseIniScalar("0755")).toBe("0755");
        expect(parseIniScalar('"&username@&hostname "')).toBe("&username@&hostname ");
        expect(parseIniScalar("")).toBe("");
    });

    // D9.02
    it("D9.02 array: koma di luar kutip, kutip di dalam tetap utuh", () => {
        expect(parseIniScalar("smqtnl0, smqtnl1")).toEqual(["smqtnl0", "smqtnl1"]);
        expect(parseIniScalar('"a, b", c')).toEqual(["a, b", "c"]);
    });

    // D9.03
    it("D9.03 komentar ekor hanya dipotong di luar kutip", () => {
        expect(stripInlineComment("value  # catatan")).toBe("value");
        expect(stripInlineComment("mqtt://host/kanal#1")).toBe("mqtt://host/kanal#1");
        expect(stripInlineComment('"nilai # penting"')).toBe('"nilai # penting"');
        expect(parseIniScalar("1883  ; port MQTT")).toBe(1883);
    });

    // D9.04
    it("D9.04 parseIni: section, urutan, dan peringatan baris rusak", () => {
        const { sections, order, warnings } = parseIni(
            [
                "# konfigurasi",
                "[kernel]",
                "database = system.db",
                "",
                "[network]",
                "defaultDevice = smqtnl0 ; utama",
                "baris-tanpa-sama-dengan",
            ].join("\n"),
        );

        expect(order).toEqual(["kernel", "network"]);
        expect(sections.kernel.database).toBe("system.db");
        expect(sections.network.defaultDevice).toBe("smqtnl0");
        expect(warnings.join(" ")).toContain("no '='");
    });

    // D9.05
    it("D9.05 key di luar section → dilaporkan, tidak dibuang diam-diam", () => {
        const { sections, warnings } = parseIni("nyasar = 1\n[kernel]\ndatabase = db\n");
        expect(sections[""].nyasar).toBe(1);
        expect(warnings.join(" ")).toContain("outside any [section]");
    });
});

describe("SysConfigIni (D9)", () => {
    // D9.10
    it("D9.10 berkas ringkas tetap menghasilkan konfigurasi LENGKAP (default terisi)", () => {
        const { config, warnings } = parseSysConfigIni("[kernel]\ndatabase = node.db\n");

        expect(warnings).toEqual([]);
        expect(config.kernel.database).toBe("node.db");
        // Key yang tidak ada memakai default — kernel tidak boleh crash karena itu
        expect(config.kernel.rootHostPath).toBe("../mirror");
        expect(config.shell.defaultRows).toBe(24);
        expect(config.network.interfaces.length).toBeGreaterThan(0);
    });

    // D9.11
    it("D9.11 [network] + [iface.*]: urutan mengikuti daftar `interfaces`", () => {
        const { config, warnings } = parseSysConfigIni(
            [
                "[network]",
                "defaultDevice = smqtnl1",
                "interfaces = smqtnl1, smqtnl0",
                "",
                "[iface.smqtnl0]",
                "broker = mqtt://a",
                "address = tsix",
                "defaultPort = 1883",
                "",
                "[iface.smqtnl1]",
                "broker = mqtt://b",
                'address = "tsix dua"',
                "defaultPort = 8883",
            ].join("\n"),
        );

        expect(warnings).toEqual([]);
        expect(config.network.defaultDevice).toBe("smqtnl1");
        expect(config.network.interfaces.map((i) => i.deviceName)).toEqual([
            "smqtnl1",
            "smqtnl0",
        ]);
        expect(config.network.interfaces[0].broker).toBe("mqtt://b");
        expect(config.network.interfaces[0].address).toBe("tsix dua");
        expect(config.network.interfaces[0].defaultPort).toBe(8883);
    });

    // D9.12
    it("D9.12 interface didaftarkan tanpa section / section tanpa daftar → diberi peringatan", () => {
        const missing = parseSysConfigIni(
            "[network]\ninterfaces = smqtnl0, smqtnl9\n\n[iface.smqtnl0]\nbroker = mqtt://a\n",
        );
        expect(missing.warnings.join(" ")).toContain("[iface.smqtnl9] is missing");
        expect(missing.config.network.interfaces.map((i) => i.deviceName)).toEqual(["smqtnl0"]);

        const unlisted = parseSysConfigIni(
            "[network]\ninterfaces = smqtnl0\n\n[iface.smqtnl0]\nbroker = mqtt://a\n\n[iface.lain]\nbroker = mqtt://b\n",
        );
        expect(unlisted.warnings.join(" ")).toContain("not listed in [network] interfaces");
        expect(unlisted.config.network.interfaces.map((i) => i.deviceName)).toEqual([
            "smqtnl0",
            "lain",
        ]);
    });

    // D9.13
    it("D9.13 [device.*]: mode oktal & uid/gid jadi angka", () => {
        const { config, warnings } = parseSysConfigIni(
            "[device.tft]\nmode = 0o666\nuid = 0\ngid = 100\n",
        );

        expect(warnings).toEqual([]);
        expect(config.devices).toEqual({ tft: { mode: 0o666, uid: 0, gid: 100 } });
    });

    // D9.14
    it("D9.14 key/section tak dikenal & nilai salah tipe → peringatan, sisanya tetap jalan", () => {
        const { config, warnings } = parseSysConfigIni(
            [
                "[kernel]",
                "database = system.db",
                "databse = typo.db", // typo: key tak dikenal
                "verbose = kadang-kadang", // bukan boolean
                "",
                "[section_aneh]",
                "x = 1",
            ].join("\n"),
        );

        const joined = warnings.join(" ");
        expect(joined).toContain("unknown key 'databse'");
        expect(joined).toContain("is not a boolean");
        expect(joined).toContain("unknown section [section_aneh]");
        // Nilai yang sah tetap terpakai — satu baris salah tidak mematikan semua
        expect(config.kernel.database).toBe("system.db");
        expect(config.kernel.verbose).toBe(true); // default
    });

    // D9.15
    it("D9.15 round-trip: format → parse menghasilkan konfigurasi yang sama", () => {
        const original = createDefaultSysConfig();
        original.kernel.rootType = "host";
        original.kernel.rootHostPath = "../rootfs";
        original.kernel.version = "0.3.2.20260923.1"; // string bertitik
        original.shell.promptFormat = "&username@&hostname&usertype ";
        original.network.interfaces[1].broker = "mqtt://192.168.1.204";
        original.devices = { tft: { mode: 0o666, uid: 0, gid: 0 } };

        const { config, warnings } = parseSysConfigIni(formatSysConfigIni(original));

        expect(warnings).toEqual([]);
        expect(config).toEqual(original);
    });

    // D9.16
    it("D9.16 formatter mengutip nilai yang bisa berubah arti, dan menulis mode oktal", () => {
        const cfg: SysConfig = createDefaultSysConfig();
        cfg.kernel.version = "1883"; // tanpa kutip akan jadi ANGKA 1883
        cfg.kernel.rootType = "host";
        cfg.shell.defaultHostname = "tsix dua"; // nilai dengan spasi di dalam
        cfg.devices = { lcd: { mode: 0o4755 } };

        const text = formatSysConfigIni(cfg);

        expect(text).toContain('version = "1883"');
        expect(text).toContain("mode = 0o4755");
        expect(text).toContain("rootType = host");

        // Dibaca ulang: string yang "kelihatan angka" tetap string, mode tetap oktal
        const back = parseSysConfigIni(text).config;
        expect(back.kernel.version).toBe("1883");
        expect(back.shell.defaultHostname).toBe("tsix dua");
        expect(back.devices?.lcd.mode).toBe(0o4755);

        // Sebaliknya, `1.0` AMAN tanpa kutip: `String(Number(x)) === x` gagal,
        // jadi parser tidak akan pernah mengubahnya jadi angka (1).
        cfg.kernel.version = "1.0";
        const dotted = parseSysConfigIni(formatSysConfigIni(cfg)).config;
        expect(dotted.kernel.version).toBe("1.0");
    });
});
