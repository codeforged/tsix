import type { SysConfig } from "./Config";
import { IniValue, parseIni } from "./IniParser";

/**
 * SYS CONFIG ⇄ INI
 *
 * `src/sysconfig.conf` adalah konfigurasi node TSIX dalam format **key-value
 * bergaya `/etc/fstab.conf`** (sebelumnya JSON). Alasannya sama seperti fstab:
 * berkas yang dibaca/ditulis admin lebih enak sebagai teks berkomentar, satu
 * baris satu setelan, dan bisa dikomentari per baris (`#`/`;`).
 *
 * BENTUK BERKAS:
 *
 *     [kernel]
 *     database   = system.db
 *     rootType   = bkfs
 *     verbose    = true
 *
 *     [network]
 *     defaultDevice = smqtnl0
 *     interfaces    = smqtnl0, smqtnl1
 *
 *     [iface.smqtnl0]
 *     broker      = mqtt://localhost
 *     address     = tsix
 *     defaultPort = 1883
 *
 *     [device.tft]
 *     mode = 0o666
 *     uid  = 0
 *     gid  = 0
 *
 * CATATAN DESAIN:
 *   - `[iface.<deviceName>]` = satu interface MQTNL. Daftarnya ada di
 *     `[network] interfaces` supaya URUTANNYA eksplisit (kernel mendaftarkan
 *     driver berurutan) dan nama device tidak tertukar dengan nama section.
 *   - `[device.<nama>]` = konfigurasi udev-style per device (`applyDeviceConfigs`).
 *   - Aturan nilai (kutip, array, boolean, angka, komentar) ada di
 *     `IniParser.ts` — sengaja sama dengan fstab & ConfigParser userland.
 *   - Key/section yang TIDAK dikenal hanya diberi PERINGATAN, tidak menggagalkan
 *     boot: salah tulis satu baris tidak boleh membuat node mati semua.
 */

type Kind = "string" | "number" | "boolean";

/** Schema per section: menentukan konversi tipe tiap key. */
const SECTION_SCHEMA: Record<string, Record<string, Kind>> = {
    kernel: {
        version: "string",
        database: "string",
        rootType: "string",
        rootHostPath: "string",
        bootLogPath: "string",
        verbose: "boolean",
        distroName: "string",
        engineName: "string",
    },
    logger: {
        defaultLevel: "string",
        logFile: "string",
        enableConsole: "boolean",
    },
    scheduler: {
        workerEntryPath: "string",
        defaultPath: "string",
        defaultCwd: "string",
        bootEntry: "string",
        defaultShell: "string",
        workerMaxOldGenMb: "number",
        workerMaxYoungGenMb: "number",
    },
    shell: {
        defaultUser: "string",
        defaultHostname: "string",
        promptFormat: "string",
        defaultRows: "number",
        defaultColumns: "number",
        historyPath: "string",
        ttyCount: "number",
        loginCount: "number",
    },
    network: {
        defaultDevice: "string",
        // Daftar nama interface; isi tiap interface ada di `[iface.<nama>]`.
        interfaces: "string",
    },
};

const IFACE_PREFIX = "iface.";
const DEVICE_PREFIX = "device.";
const TUNNEL_PREFIX = "tunnel.";

/** Key yang dikenali di `[iface.*]`. */
const IFACE_SCHEMA: Record<string, Kind> = {
    broker: "string",
    address: "string",
    defaultPort: "number",
};

/**
 * Key yang dikenali di `[tunnel.*]`.
 *
 * Interface tunnel = device `SimpleMQTNLDriverTunnel`: membungkus paket ke
 * node relay di broker lain. Section ini OPSIONAL — berkas konfigurasi lama
 * tanpa `[tunnel.*]` tetap menghasilkan perilaku yang sama persis.
 */
const TUNNEL_SCHEMA: Record<string, Kind> = {
    broker: "string",
    address: "string",
    defaultPort: "number",
    peer: "string",
    port: "number",
    controlPort: "number",
    psk: "string",
    // Handshake RSA otomatis; `false` memaksa plain (tidak disarankan).
    handshake: "boolean",
    trustedFingerprint: "string",
    rekey: "number",
    agent: "string",
    exclude: "string", // array (dipisah koma) maupun satu nilai
    maxHops: "number",
};

/** Key yang dikenali di `[device.*]`. */
const DEVICE_SCHEMA: Record<string, Kind> = {
    mode: "string", // oktal — dikonversi lewat `toMode`
    uid: "number",
    gid: "number",
};

/**
 * createDefaultSysConfig(): Konfigurasi awal yang lengkap.
 *
 * Dipakai parser (untuk key yang tidak ada) DAN `scripts/install.ts` (untuk
 * instalasi baru) — satu sumber, supaya default installer dan default kernel
 * tidak pernah berbeda. Nilai network memakai localhost; installer menimpanya
 * lewat pertanyaan interaktif.
 */
export function createDefaultSysConfig(): SysConfig {
    return {
        kernel: {
            version: "0.0.1-alpha",
            database: "system.db",
            rootType: "bkfs",
            rootHostPath: "../mirror",
            bootLogPath: "/logs/boot.log",
            verbose: true,
            distroName: "Antigonon leptopus",
            engineName: "TSIX-Dinawari",
        },
        logger: {
            defaultLevel: "INFO",
            logFile: "jsix.log",
            enableConsole: false,
        },
        scheduler: {
            workerEntryPath: "../userland/WorkerEntry.js",
            defaultPath: "/bin",
            defaultCwd: "/",
            bootEntry: "init.js",
            defaultShell: "tsh.ts",
            workerMaxOldGenMb: 192,
            workerMaxYoungGenMb: 32,
        },
        shell: {
            defaultUser: "root",
            defaultHostname: "tsix",
            promptFormat: "&username@&hostname&usertype ",
            defaultRows: 24,
            defaultColumns: 80,
            historyPath: "/.sh_history",
            ttyCount: 3,
            loginCount: 1,
        },
        network: {
            interfaces: [
                {
                    broker: "mqtt://localhost",
                    deviceName: "smqtnl0",
                    address: "tsix",
                    defaultPort: 1883,
                },
                {
                    broker: "mqtt://localhost",
                    deviceName: "smqtnl1",
                    address: "tsix-node-2",
                    defaultPort: 1883,
                },
            ],
            defaultDevice: "smqtnl0",
        },
        devices: {},
    };
}

export interface SysConfigParseResult {
    config: SysConfig;
    /** Masalah yang ditemukan — pemanggil yang memutuskan cara melaporkannya. */
    warnings: string[];
}

// ============================================================
// Konversi nilai
// ============================================================

function toNumber(raw: IniValue, label: string, warn: (m: string) => void): number | undefined {
    if (typeof raw === "number") return raw;
    const s = String(raw).trim();
    const n = Number(s);
    if (s !== "" && Number.isFinite(n)) return n;
    warn(`${label}='${s}' is not a number → ignored`);
    return undefined;
}

function toBoolean(raw: IniValue, label: string, warn: (m: string) => void): boolean | undefined {
    if (typeof raw === "boolean") return raw;
    const s = String(raw).trim().toLowerCase();
    if (["true", "yes", "on", "1"].includes(s)) return true;
    if (["false", "no", "off", "0"].includes(s)) return false;
    warn(`${label}='${s}' is not a boolean (true/false, yes/no, on/off, 1/0) → ignored`);
    return undefined;
}

/**
 * toMode(): Mode oktal — satu-satunya nilai yang tafsirnya ambigu.
 * `0o666`/`0666` = oktal eksplisit; angka telanjang = desimal (dengan
 * peringatan kalau > 0o777, karena hampir selalu itu maksudnya oktal).
 */
function toMode(raw: IniValue, label: string, warn: (m: string) => void): number | undefined {
    if (typeof raw === "number" && raw > 0o777) {
        warn(
            `${label}=${raw} (> 0o777) — if you meant octal, write '0o${raw.toString(8)}'; ` +
                `as decimal it becomes 0o${raw.toString(8)}`,
        );
    }
    const s = typeof raw === "number" ? String(raw) : String(raw).trim();
    const octal = /^0o([0-7]+)$/i.exec(s) ?? /^0([0-7]+)$/.exec(s);
    const value = octal ? parseInt(octal[1], 8) : Number(s);

    if (!Number.isInteger(value) || value < 0 || value > 0o7777) {
        warn(`${label}='${s}' is out of range 0..0o7777 → ignored`);
        return undefined;
    }
    if (typeof raw === "boolean") return undefined;
    return value;
}

function coerce(
    raw: IniValue,
    kind: Kind,
    label: string,
    warn: (m: string) => void,
): string | number | boolean | undefined {
    if (kind === "number") return toNumber(raw, label, warn);
    if (kind === "boolean") return toBoolean(raw, label, warn);
    if (Array.isArray(raw)) return raw.join(", ");
    return typeof raw === "string" ? raw : String(raw);
}

function isKnownSection(name: string): boolean {
    return (
        Object.prototype.hasOwnProperty.call(SECTION_SCHEMA, name) ||
        name.startsWith(IFACE_PREFIX) ||
        name.startsWith(DEVICE_PREFIX) ||
        name.startsWith(TUNNEL_PREFIX)
    );
}

// ============================================================
// Parser
// ============================================================

/**
 * parseSysConfigIni(): Isi `sysconfig.conf` → `SysConfig`.
 *
 * Key yang tidak ada di berkas memakai default (`createDefaultSysConfig`), jadi
 * berkas ringkas (mis. hanya `[kernel]`) tetap menghasilkan konfigurasi lengkap.
 */
export function parseSysConfigIni(content: string): SysConfigParseResult {
    const { sections, order, warnings } = parseIni(content);
    const warn = (m: string) => warnings.push(m);
    const cfg = createDefaultSysConfig();

    // --- Section datar (kernel/logger/scheduler/shell) ---
    for (const [name, values] of Object.entries(sections)) {
        const schema = SECTION_SCHEMA[name];
        if (!schema || name === "network") continue;
        if (!isKnownSection(name)) continue; // ditangani di bawah (peringatan)

        const target = (cfg as any)[name] ?? {};
        for (const [key, raw] of Object.entries(values)) {
            const kind = schema[key];
            if (!kind) {
                warn(`[${name}] unknown key '${key}' → ignored`);
                continue;
            }
            const value = coerce(raw, kind, `[${name}] ${key}`, warn);
            if (value !== undefined) target[key] = value;
        }
        (cfg as any)[name] = target;
    }

    // --- [network] + [iface.*] ---
    const netSection = sections["network"] ?? {};
    for (const [key, raw] of Object.entries(netSection)) {
        if (key === "interfaces") continue; // dibaca bersama section iface
        if (key === "defaultDevice") {
            const value = coerce(raw, "string", "[network] defaultDevice", warn);
            if (value !== undefined) cfg.network.defaultDevice = String(value);
            continue;
        }
        warn(`[network] unknown key '${key}' → ignored`);
    }

    const listed = netSection["interfaces"];
    const listedNames: string[] = Array.isArray(listed)
        ? listed.map(String)
        : typeof listed === "string" && listed !== ""
          ? listed.split(",").map((s) => s.trim()).filter((s) => s !== "")
          : [];

    const ifaceSections = order.filter((name) => name.startsWith(IFACE_PREFIX));
    // Section yang ada tapi tidak didaftarkan tetap dipakai (dengan peringatan) —
    // lebih baik jalan dengan urutan wajar daripada interface-nya hilang diam-diam.
    const names: string[] = [...listedNames];
    for (const name of ifaceSections) {
        const devName = name.slice(IFACE_PREFIX.length);
        if (!names.includes(devName)) {
            warn(`[${name}] is not listed in [network] interfaces → appended`);
            names.push(devName);
        }
    }

    if (names.length > 0) {
        const interfaces: SysConfig["network"]["interfaces"] = [];
        for (const devName of names) {
            const values = sections[IFACE_PREFIX + devName];
            if (!values) {
                warn(`interface '${devName}' is listed but [${IFACE_PREFIX}${devName}] is missing → skipped`);
                continue;
            }
            const iface = {
                deviceName: devName,
                broker: "",
                address: "",
                defaultPort: 1883,
            };
            for (const [key, raw] of Object.entries(values)) {
                const kind = IFACE_SCHEMA[key];
                if (!kind) {
                    warn(`[${IFACE_PREFIX}${devName}] unknown key '${key}' → ignored`);
                    continue;
                }
                const value = coerce(raw, kind, `[${IFACE_PREFIX}${devName}] ${key}`, warn);
                if (value === undefined) continue;
                if (key === "defaultPort") iface.defaultPort = Number(value);
                else if (key === "address") iface.address = String(value);
                else iface.broker = String(value);
            }
            interfaces.push(iface);
        }
        cfg.network.interfaces = interfaces;
    }

    // --- [tunnel.*] ---
    // Interface tunnel: device yang membungkus paket ke relay di broker lain.
    // Tidak didaftarkan di `[network] interfaces` karena bukan interface
    // "biasa" — kernel membuatnya dari daftar ini.
    const tunnelSections = order.filter((name) => name.startsWith(TUNNEL_PREFIX));
    if (tunnelSections.length > 0) {
        const tunnels: NonNullable<SysConfig["network"]["tunnels"]> = [];
        for (const name of tunnelSections) {
            const deviceName = name.slice(TUNNEL_PREFIX.length);
            const values = sections[name] ?? {};
            const tun = {
                deviceName,
                broker: "",
                address: deviceName,
                defaultPort: 1883,
                peer: "",
                port: undefined as number | undefined,
                controlPort: undefined as number | undefined,
                psk: undefined as string | undefined,
                handshake: undefined as boolean | undefined,
                trustedFingerprint: undefined as string | undefined,
                rekey: undefined as number | undefined,
                agent: undefined as string | undefined,
                exclude: undefined as string[] | undefined,
                maxHops: undefined as number | undefined,
            };
            for (const [key, raw] of Object.entries(values)) {
                const kind = TUNNEL_SCHEMA[key];
                if (!kind) {
                    warn(`[${name}] unknown key '${key}' → ignored`);
                    continue;
                }
                const label = `[${name}] ${key}`;
                const value = coerce(raw, kind, label, warn);
                if (value === undefined) continue;
                switch (key) {
                    case "broker":
                        tun.broker = String(value);
                        break;
                    case "address":
                        tun.address = String(value);
                        break;
                    case "defaultPort":
                        tun.defaultPort = Number(value);
                        break;
                    case "peer":
                        tun.peer = String(value);
                        break;
                    case "port":
                        tun.port = Number(value);
                        break;
                    case "controlPort":
                        tun.controlPort = Number(value);
                        break;
                    case "psk":
                        tun.psk = String(value);
                        break;
                    case "handshake":
                        tun.handshake = !!value;
                        break;
                    case "trustedFingerprint":
                        tun.trustedFingerprint = String(value);
                        break;
                    case "rekey":
                        tun.rekey = Number(value);
                        break;
                    case "agent":
                        tun.agent = String(value);
                        break;
                    case "exclude":
                        tun.exclude = String(value)
                            .split(",")
                            .map((s) => s.trim())
                            .filter((s) => s !== "");
                        break;
                    case "maxHops":
                        tun.maxHops = Number(value);
                        break;
                }
            }
            if (!tun.broker) {
                warn(`[${name}] 'broker' wajib diisi → tunnel '${deviceName}' dilewati`);
                continue;
            }
            if (!tun.peer) {
                warn(`[${name}] 'peer' wajib diisi → tunnel '${deviceName}' dilewati`);
                continue;
            }
            tunnels.push(tun);
        }
        if (tunnels.length > 0) cfg.network.tunnels = tunnels;
    }

    // --- [device.*] ---
    const devices: NonNullable<SysConfig["devices"]> = {};
    for (const name of order.filter((n) => n.startsWith(DEVICE_PREFIX))) {
        const devName = name.slice(DEVICE_PREFIX.length);
        const values = sections[name] ?? {};
        const device: { mode?: number; uid?: number; gid?: number } = {};
        for (const [key, raw] of Object.entries(values)) {
            const kind = DEVICE_SCHEMA[key];
            if (!kind) {
                warn(`[${name}] unknown key '${key}' → ignored`);
                continue;
            }
            const label = `[${name}] ${key}`;
            if (key === "mode") {
                const mode = toMode(raw, label, warn);
                if (mode !== undefined) device.mode = mode;
            } else {
                const num = toNumber(raw, label, warn);
                if (num !== undefined) device[key as "uid" | "gid"] = num;
            }
        }
        devices[devName] = device;
    }
    if (Object.keys(devices).length > 0) cfg.devices = devices;

    // --- Section yang tidak dikenal ---
    for (const name of order) {
        if (!isKnownSection(name)) warn(`unknown section [${name}] → ignored`);
    }

    return { config: cfg, warnings };
}

// ============================================================
// Formatter
// ============================================================

const TRUE_WORDS = new Set(["true", "false", "yes", "no", "on", "off"]);

/**
 * formatValue(): Tulis nilai sehingga `parseIniScalar()` mengembalikannya utuh.
 * String yang "kelihatan angka/boolean" atau memuat pemisah (`#`, `;`, `,`)
 * WAJIB dikutip — kalau tidak, nilainya berubah arti saat dibaca kembali.
 */
function formatValue(value: string | number | boolean | undefined): string {
    if (value === undefined) return "";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") return String(value);

    const s = value;
    const needsQuote =
        s.trim() !== s ||
        s === "" ||
        /[#;,"']/.test(s) ||
        TRUE_WORDS.has(s.toLowerCase()) ||
        (Number.isFinite(Number(s)) && String(Number(s)) === s);
    return needsQuote ? `"${s.replace(/"/g, '\\"')}"` : s;
}

function pushSection(
    out: string[],
    name: string,
    values: Array<[string, string | number | boolean | undefined]>,
): void {
    out.push(`[${name}]`);
    for (const [key, value] of values) out.push(`${key} = ${formatValue(value)}`);
    out.push("");
}

/** formatSysConfigIni(): `SysConfig` → teks `sysconfig.conf`. */
export function formatSysConfigIni(cfg: SysConfig, header?: string): string {
    const out: string[] = [];
    if (header) {
        out.push(...header.split("\n").map((line) => (line.startsWith("#") ? line : `# ${line}`)));
        out.push("");
    }

    pushSection(out, "kernel", [
        ["version", cfg.kernel.version],
        ["database", cfg.kernel.database],
        ["rootType", cfg.kernel.rootType ?? "bkfs"],
        ["rootHostPath", cfg.kernel.rootHostPath],
        ["bootLogPath", cfg.kernel.bootLogPath],
        ["verbose", cfg.kernel.verbose],
        ["distroName", cfg.kernel.distroName],
        ["engineName", cfg.kernel.engineName],
    ]);

    pushSection(out, "logger", [
        ["defaultLevel", cfg.logger.defaultLevel],
        ["logFile", cfg.logger.logFile],
        ["enableConsole", cfg.logger.enableConsole ?? false],
    ]);

    pushSection(out, "scheduler", [
        ["workerEntryPath", cfg.scheduler.workerEntryPath],
        ["defaultPath", cfg.scheduler.defaultPath],
        ["defaultCwd", cfg.scheduler.defaultCwd],
        ["bootEntry", cfg.scheduler.bootEntry],
        ["defaultShell", cfg.scheduler.defaultShell],
        ["workerMaxOldGenMb", cfg.scheduler.workerMaxOldGenMb ?? 192],
        ["workerMaxYoungGenMb", cfg.scheduler.workerMaxYoungGenMb ?? 32],
    ]);

    pushSection(out, "shell", [
        ["defaultUser", cfg.shell.defaultUser],
        ["defaultHostname", cfg.shell.defaultHostname],
        ["promptFormat", cfg.shell.promptFormat],
        ["defaultRows", cfg.shell.defaultRows],
        ["defaultColumns", cfg.shell.defaultColumns],
        ["historyPath", cfg.shell.historyPath],
        ["ttyCount", cfg.shell.ttyCount],
        ["loginCount", cfg.shell.loginCount],
    ]);

    pushSection(out, "network", [
        ["defaultDevice", cfg.network.defaultDevice],
        ["interfaces", cfg.network.interfaces.map((i) => i.deviceName).join(", ")],
    ]);

    for (const iface of cfg.network.interfaces) {
        pushSection(out, `${IFACE_PREFIX}${iface.deviceName}`, [
            ["broker", iface.broker],
            ["address", iface.address],
            ["defaultPort", iface.defaultPort],
        ]);
    }

    // Section tunnel hanya ditulis kalau dipakai — konfigurasi lama tidak
    // berubah bentuk saat di-format ulang. Key yang tidak di-set TIDAK ditulis
    // sebagai baris kosong: `port = ` (kosong) akan diperingatkan parser
    // sebagai "bukan angka" saat berkas dibaca kembali.
    for (const tun of cfg.network.tunnels ?? []) {
        const rows: Array<[string, string | number | boolean | undefined]> = [
            ["broker", tun.broker],
            ["address", tun.address],
            ["peer", tun.peer],
        ];
        if (tun.port !== undefined) rows.push(["port", tun.port]);
        if (tun.controlPort !== undefined) rows.push(["controlPort", tun.controlPort]);
        if (tun.psk !== undefined) rows.push(["psk", tun.psk]);
        if (tun.handshake !== undefined) rows.push(["handshake", tun.handshake]);
        if (tun.trustedFingerprint !== undefined)
            rows.push(["trustedFingerprint", tun.trustedFingerprint]);
        if (tun.rekey !== undefined) rows.push(["rekey", tun.rekey]);
        if (tun.agent !== undefined) rows.push(["agent", tun.agent]);
        if (tun.maxHops !== undefined) rows.push(["maxHops", tun.maxHops]);
        if (tun.exclude !== undefined && tun.exclude.length > 0) {
            rows.push(["exclude", tun.exclude.join(", ")]);
        }
        pushSection(out, `${TUNNEL_PREFIX}${tun.deviceName}`, rows);
    }

    for (const [devName, device] of Object.entries(cfg.devices ?? {})) {
        pushSection(out, `${DEVICE_PREFIX}${devName}`, [
            ["mode", device.mode === undefined ? undefined : `0o${device.mode.toString(8)}`],
            ["uid", device.uid],
            ["gid", device.gid],
        ]);
    }

    return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
