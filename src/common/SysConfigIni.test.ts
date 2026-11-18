import { describe, it, expect } from "vitest";
import { parseSysConfigIni, formatSysConfigIni } from "./SysConfigIni";

/**
 * SysConfigIni — section `[tunnel.*]` (interface tunnel MQTNL).
 *
 * Section ini OPSIONAL dan baru: berkas konfigurasi lama (tanpa `[tunnel.*]`)
 * wajib tetap menghasilkan konfigurasi yang sama persis, tanpa warning baru.
 * Test di bawah menjaga dua hal itu sekaligus.
 */

const BASE = `
[kernel]
version = 0.2.5
database = system.db
rootType = bkfs
rootHostPath = ../mirror
bootLogPath = /logs/boot.log
verbose = true
distroName = Test
engineName = TSIX

[logger]
defaultLevel = INFO
logFile = jsix.log
enableConsole = false

[scheduler]
workerEntryPath = ../userland/WorkerEntry.js
defaultPath = /bin
defaultCwd = /
bootEntry = init.js
defaultShell = tsh.ts
workerMaxOldGenMb = 192
workerMaxYoungGenMb = 32

[shell]
defaultUser = root
defaultHostname = tsix
promptFormat = "&username@&hostname&usertype "
defaultRows = 24
defaultColumns = 80
historyPath = /.sh_history
ttyCount = 3
loginCount = 1

[network]
defaultDevice = smqtnl0
interfaces = smqtnl0

[iface.smqtnl0]
broker = mqtt://localhost
address = tsix
defaultPort = 1883
`;

const TUNNEL_BLOCK = `
[tunnel.smqtnltun0]
broker = mqtt://localhost
address = tsix-tun
peer = relay-z:9360
psk = 81ff71ed574e54597690ae7b04e4ef5fc87497fe10b6b037cb031af7c7d67619
exclude = tsix-node-2, tsix-node-3
maxHops = 2
`;

describe("SysConfigIni — [tunnel.*]", () => {
    it("S1.01 tanpa section tunnel → tidak ada device tunnel & tanpa warning", () => {
        const { config, warnings } = parseSysConfigIni(BASE);

        expect(config.network.tunnels).toBeUndefined();
        expect(warnings).toEqual([]);
    });

    it("S1.02 section tunnel terbaca lengkap", () => {
        const { config, warnings } = parseSysConfigIni(BASE + TUNNEL_BLOCK);

        expect(warnings).toEqual([]);
        const tunnels = config.network.tunnels;
        expect(tunnels).toHaveLength(1);

        const t = tunnels![0];
        expect(t.deviceName).toBe("smqtnltun0");
        expect(t.broker).toBe("mqtt://localhost");
        expect(t.address).toBe("tsix-tun");
        expect(t.peer).toBe("relay-z:9360");
        expect(t.port).toBeUndefined(); // port diturunkan dari `peer`
        expect(t.psk).toBe("81ff71ed574e54597690ae7b04e4ef5fc87497fe10b6b037cb031af7c7d67619");
        expect(t.exclude).toEqual(["tsix-node-2", "tsix-node-3"]);
        expect(t.maxHops).toBe(2);
    });

    it("S1.03 interface biasa tidak terpengaruh oleh section tunnel", () => {
        const { config } = parseSysConfigIni(BASE + TUNNEL_BLOCK);

        expect(config.network.interfaces).toHaveLength(1);
        expect(config.network.interfaces[0].deviceName).toBe("smqtnl0");
        expect(config.network.defaultDevice).toBe("smqtnl0");
    });

    it("S1.04 tunnel tanpa peer dilewati dengan peringatan (tidak membuat device rusak)", () => {
        const { config, warnings } = parseSysConfigIni(
            BASE +
                `
[tunnel.broken]
broker = mqtt://localhost
address = x
`,
        );

        expect(config.network.tunnels).toBeUndefined();
        expect(warnings.join("\n")).toMatch(/peer/);
    });

    it("S1.05 tunnel tanpa broker dilewati dengan peringatan", () => {
        const { config, warnings } = parseSysConfigIni(
            BASE +
                `
[tunnel.nobroker]
address = x
peer = relay:9360
`,
        );

        expect(config.network.tunnels).toBeUndefined();
        expect(warnings.join("\n")).toMatch(/broker/);
    });

    it("S1.06 key tak dikenal di [tunnel.*] diperingatkan, bukan crash", () => {
        const { warnings } = parseSysConfigIni(
            BASE +
                TUNNEL_BLOCK +
                `
[tunnel.extra]
broker = mqtt://localhost
peer = relay:1
warna = biru
`,
        );

        expect(warnings.join("\n")).toMatch(/warna/);
    });

    it("S1.07 format ulang menulis kembali section tunnel & tetap bisa dibaca", () => {
        const { config } = parseSysConfigIni(BASE + TUNNEL_BLOCK);
        const text = formatSysConfigIni(config);
        const again = parseSysConfigIni(text);

        expect(again.warnings).toEqual([]);
        const t = again.config.network.tunnels![0];
        expect(t.deviceName).toBe("smqtnltun0");
        expect(t.address).toBe("tsix-tun");
        expect(t.peer).toBe("relay-z:9360");
        expect(t.exclude).toEqual(["tsix-node-2", "tsix-node-3"]);
        expect(t.maxHops).toBe(2);
    });

    it("S1.08 format ulang konfigurasi lama tidak menambah section tunnel", () => {
        const { config } = parseSysConfigIni(BASE);
        const text = formatSysConfigIni(config);

        expect(text).not.toMatch(/\[tunnel\./);
    });

    it("S1.09 key handshake (tanpa PSK) terbaca & bolak-balik utuh", () => {
        const { config, warnings } = parseSysConfigIni(
            BASE +
                `
[tunnel.tunhs]
broker = mqtt://localhost
address = tsix-tun
peer = relay-z
handshake = true
trustedFingerprint = "A1B2C3D4E5F60718"
rekey = 300
controlPort = 9361
`,
        );

        expect(warnings).toEqual([]);
        const t = config.network.tunnels![0];
        expect(t.psk).toBeUndefined();
        expect(t.handshake).toBe(true);
        expect(t.trustedFingerprint).toBe("A1B2C3D4E5F60718");
        expect(t.rekey).toBe(300);
        expect(t.controlPort).toBe(9361);

        const again = parseSysConfigIni(formatSysConfigIni(config));
        const t2 = again.config.network.tunnels![0];
        expect(again.warnings).toEqual([]);
        expect(t2.handshake).toBe(true);
        expect(t2.trustedFingerprint).toBe("A1B2C3D4E5F60718");
        expect(t2.rekey).toBe(300);
        expect(t2.controlPort).toBe(9361);
    });

    it("S1.10 handshake = false terbaca sebagai boolean", () => {
        const { config } = parseSysConfigIni(
            BASE +
                `
[tunnel.tunplain]
broker = mqtt://localhost
peer = relay-z
handshake = false
`,
        );
        expect(config.network.tunnels![0].handshake).toBe(false);
    });
});
