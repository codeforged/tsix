/**
 * lantana-core.ts — Lantana V2 shared core
 *
 * Tipe, konstanta, dan parser payload. Modul ini SENDIRI TANPA dependensi
 * runtime (tidak mengimpor @tsix/Application) supaya bisa diuji langsung
 * dengan vitest tanpa runtime VFS.
 *
 * Identitas V2: `accountId` + `deviceId`. Port hanya alamat routing.
 *
 * (c) 2026 TSIX Project — Lantana
 */

// ─── Path & identitas ─────────────────────────────────────────────────────
export const LANTANA_CONFIG_PATH = "/etc/lantana/config.json";
export const LANTANA_ACCOUNTS_PATH = "/etc/lantana/accounts.json";
export const LANTANA_DEVICES_PATH = "/etc/lantana/devices.json";
export const LANTANA_SCHEMES_PATH = "/etc/lantana/schemes.json";
export const LANTANA_LOG_DIR = "/var/log/lantana";
export const LANTANA_UUID = "5f4e2a91-4b0f-4c9a-b1c3-0a1b2c3d4e5f";

// ─── Event IPC ────────────────────────────────────────────────────────────
export const EVT_READING = "LANTANA_READING";
export const EVT_DEVICE_STATUS = "LANTANA_DEVICE_STATUS";
export const EVT_SNAPSHOT = "LANTANA_SNAPSHOT";
export const EVT_SNAPSHOT_REPLY = "LANTANA_SNAPSHOT_REPLY";
export const EVT_COMMAND = "LANTANA_COMMAND";
export const EVT_COMMAND_RESULT = "LANTANA_COMMAND_RESULT";

// ─── Pesan handshake sesi ─────────────────────────────────────────────────
export const MSG_HELLO = "LANTANA_HELLO";
export const MSG_CHALLENGE = "LANTANA_CHALLENGE";
export const MSG_KEYSET = "LANTANA_KEYSET";
export const MSG_AUTH = "LANTANA_AUTH";
/** Mode handshake yang dipilih device di LANTANA_HELLO. */
export type HandshakeMode = "rsa" | "psk";

// ─── Heartbeat ────────────────────────────────────────────────────────────
export type DeviceStatus = "ONLINE" | "STALE" | "OFFLINE";
export const DEVICE_STALE_MS = 15000;
export const DEVICE_OFFLINE_MS = 60000;

// ─── Kode error / NACK ────────────────────────────────────────────────────
export enum LantanaError {
    BAD_REQUEST = 0x01,
    UNAUTHENTICATED = 0x05,
    UNKNOWN_ACCOUNT = 0x06,
    UNAUTHORIZED_INJECT = 0x07,
    UNAUTHORIZED_QUERY = 0x08,
    UNAUTHORIZED_COMMAND = 0x09,
    UNKNOWN_DEVICE = 0x0a,
    UNKNOWN_SCHEME = 0x0b,
    INVALID_VALUE = 0x0c,
    DATABANK_UNAVAILABLE = 0x0d,
    PAYLOAD_INVALID = 0x0e,
}

export function errorName(code: LantanaError): string {
    return LantanaError[code] || `ERR_0x${code.toString(16)}`;
}

// ─── Akun & izin ──────────────────────────────────────────────────────────
/** Satu scheme ID, atau rentang inklusif `{ from, to }`. */
export type SchemeRange = number | { from: number; to: number };

export interface Permissions {
    /** Scheme yang boleh di-inject device milik akun. */
    allowedInjectSchemes: SchemeRange[];
    /** Scheme yang boleh dibaca lewat IPC/HTTP. */
    allowedQuerySchemes: SchemeRange[];
    /** deviceId yang boleh dikirimi command. */
    allowedCommandDevices: string[];
}

export interface StoredCredential {
    /** Salt hex + hash scrypt hex. Key mentah tidak pernah disimpan. */
    salt: string;
    hash: string;
    /** Verifier untuk handshake PSK: SHA-256(accessKey) hex. */
    psk?: string;
    issuedAt: number;
}

export interface AccountRecord {
    accountId: string;
    parentId: string | null;
    permissions: Permissions;
    credential: StoredCredential | null;
    portableDashboard?: PortableDashboard[];
    createdAt: number;
}

export type PortableDashboardItemType =
    | "text"
    | "radialGauge"
    | "lineChart"
    | "switchIndicator";

export interface PortableDashboardItem {
    id?: number | string;
    type: PortableDashboardItemType;
    title: string;
    icon: string;
    updateInterval: number;
    scrollAfter?: number;
    deviceId: string;
    schemeId: number;
}

export interface PortableDashboard {
    dashboardId: number;
    title: string;
    /** SHA-256 verifier for a random dashboard key; the raw key is never persisted. */
    accessKeyHash?: string;
    dashboardItems: PortableDashboardItem[];
}

// ─── Scheme ───────────────────────────────────────────────────────────────
export type SchemeType = "number" | "boolean" | "string";

export interface SchemeDef {
    schemeId: number;
    /** Pemilik scheme; akun lain butuh izin eksplisit untuk memakainya. */
    ownerAccountId: string;
    label: string;
    unit?: string;
    type: SchemeType;
    min?: number;
    max?: number;
}

// ─── Device ───────────────────────────────────────────────────────────────
export interface DeviceMeta {
    name?: string;
    city?: string;
    category?: string;
    group?: string;
}

export interface DeviceRecord {
    deviceId: string;
    accountId: string;
    meta: DeviceMeta;
    createdAt: number;
}

// ─── Data ─────────────────────────────────────────────────────────────────
export type ReadingValue = number | boolean | string;

/** Bacaan mentah hasil decode payload (belum divalidasi). */
export interface RawReading {
    schemeId: number;
    value: ReadingValue;
}

/** Bacaan yang sudah lolos autentikasi, otorisasi, dan validasi. */
export interface AcceptedReading {
    /** ID unik untuk idempotensi submit ke DataBank. */
    readingId: string;
    accountId: string;
    deviceId: string;
    schemeId: number;
    value: ReadingValue;
    label: string;
    unit: string;
    receivedAt: number;
}

/** Satu bacaan dalam bentuk yang dikirim ke consumer. */
export interface SensorReading {
    schemeId: number;
    value: ReadingValue;
    label: string;
    unit: string;
    ts: number;
}

export interface DeviceStatusInfo {
    accountId: string;
    deviceId: string;
    name: string;
    category: string;
    group?: string;
    city?: string;
    lastDataAt: number;
    dataAgeMs: number;
    status: DeviceStatus;
    schemeIds: number[];
}

export interface NormalizedReadingBatch {
    type: typeof EVT_READING;
    accountId: string;
    deviceId: string;
    name: string;
    category: string;
    group?: string;
    city?: string;
    receivedAt: number;
    dataAgeMs: number;
    deviceStatus: DeviceStatus;
    readings: SensorReading[];
}

export interface LantanaCommand {
    type: typeof EVT_COMMAND;
    deviceId: string;
    command: string;
    /** Akun yang meminta; dipakai untuk pemeriksaan izin command. */
    accountId: string;
    from?: string;
}

export interface Endpoint {
    address: string;
    port: number;
}

// ─── Payload ──────────────────────────────────────────────────────────────
export const LANTANA_BINARY_MAGIC = 0x4c;
export const LANTANA_BINARY_VERSION = 0x02;
export const LANTANA_PLAIN_PREFIX = "LANTANA";

export type ReadingTypeCode = 0x00 | 0x01 | 0x02; // f32 | bool | string
export const READING_TYPE_F32: ReadingTypeCode = 0x00;
export const READING_TYPE_BOOL: ReadingTypeCode = 0x01;
export const READING_TYPE_STRING: ReadingTypeCode = 0x02;

export type ParsedPayload =
    | { ok: true; format: "binary" | "plain"; deviceId: string; readings: RawReading[] }
    | { ok: false; error: LantanaError; message: string };

/**
 * Deteksi format payload.
 * - Buffer dengan magic 0x4C → biner V2
 * - string diawali "LANTANA|" → plain V2
 * Format lain ditolak (tidak ada mode kompatibilitas).
 */
export function detectFormat(data: any): "binary" | "plain" | "unknown" {
    if (Buffer.isBuffer(data)) {
        return data.length > 0 && data[0] === LANTANA_BINARY_MAGIC ? "binary" : "unknown";
    }
    if (typeof data === "string") {
        const s = data.trim();
        if (s.startsWith(`${LANTANA_PLAIN_PREFIX}|`)) return "plain";
        return "unknown";
    }
    return "unknown";
}

/** Parse teks: `LANTANA|<deviceId>|<schemeId>:<value>;...` */
export function parsePlainPayload(data: string): ParsedPayload {
    const s = (data || "").trim();
    if (!s) {
        return { ok: false, error: LantanaError.PAYLOAD_INVALID, message: "payload kosong" };
    }

    const parts = s.split("|");
    if (parts.length < 3 || parts[0] !== LANTANA_PLAIN_PREFIX) {
        return {
            ok: false,
            error: LantanaError.PAYLOAD_INVALID,
            message: "format harus LANTANA|<deviceId>|scheme:value;...",
        };
    }

    const deviceId = parts[1].trim();
    if (!deviceId) {
        return { ok: false, error: LantanaError.PAYLOAD_INVALID, message: "deviceId kosong" };
    }

    const readings: RawReading[] = [];
    for (const entry of parts.slice(2).join("|").split(";")) {
        const item = entry.trim();
        if (!item) continue;
        const idx = item.indexOf(":");
        if (idx < 0) {
            return {
                ok: false,
                error: LantanaError.PAYLOAD_INVALID,
                message: `entri tidak valid: ${item}`,
            };
        }
        const schemeId = Number(item.substring(0, idx).trim());
        if (!Number.isInteger(schemeId) || schemeId < 0 || schemeId > 0xffff) {
            return {
                ok: false,
                error: LantanaError.PAYLOAD_INVALID,
                message: `schemeId tidak valid: ${item.substring(0, idx)}`,
            };
        }
        const parsed = parseTextValue(item.substring(idx + 1).trim());
        if (parsed === null) {
            return {
                ok: false,
                error: LantanaError.INVALID_VALUE,
                message: `nilai tidak valid untuk scheme ${schemeId}`,
            };
        }
        readings.push({ schemeId, value: parsed });
    }

    if (readings.length === 0) {
        return { ok: false, error: LantanaError.PAYLOAD_INVALID, message: "tidak ada bacaan" };
    }
    return { ok: true, format: "plain", deviceId, readings };
}

function parseTextValue(raw: string): ReadingValue | null {
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

/**
 * Parse frame biner V2:
 *   [0x4C][0x02][devLen:1][deviceId][count:1]
 *   per bacaan: [schemeId:u16 LE][type:1][value]
 *     type 0x00 → f32 LE (4 byte)
 *     type 0x01 → u8 (0/1)
 *     type 0x02 → len:u8 + utf8
 */
export function parseBinaryPayload(data: Buffer): ParsedPayload {
    const buf = data;
    if (!buf || buf.length < 4 || buf[0] !== LANTANA_BINARY_MAGIC) {
        return { ok: false, error: LantanaError.PAYLOAD_INVALID, message: "magic biner tidak dikenal" };
    }
    if (buf[1] !== LANTANA_BINARY_VERSION) {
        return {
            ok: false,
            error: LantanaError.PAYLOAD_INVALID,
            message: `versi frame tidak didukung: 0x${buf[1].toString(16)}`,
        };
    }

    try {
        let off = 2;
        const deviceLen = buf.readUInt8(off++);
        if (deviceLen === 0 || off + deviceLen > buf.length) {
            return { ok: false, error: LantanaError.PAYLOAD_INVALID, message: "deviceId rusak" };
        }
        const deviceId = buf.subarray(off, off + deviceLen).toString("utf8");
        off += deviceLen;
        if (off >= buf.length) {
            return { ok: false, error: LantanaError.PAYLOAD_INVALID, message: "jumlah bacaan hilang" };
        }
        const count = buf.readUInt8(off++);
        if (count === 0) {
            return { ok: false, error: LantanaError.PAYLOAD_INVALID, message: "tidak ada bacaan" };
        }

        const readings: RawReading[] = [];
        for (let i = 0; i < count; i++) {
            if (off + 3 > buf.length) {
                return { ok: false, error: LantanaError.PAYLOAD_INVALID, message: "frame terpotong" };
            }
            const schemeId = buf.readUInt16LE(off);
            off += 2;
            const type = buf.readUInt8(off++);

            if (type === READING_TYPE_F32) {
                if (off + 4 > buf.length) {
                    return { ok: false, error: LantanaError.PAYLOAD_INVALID, message: "frame terpotong" };
                }
                readings.push({ schemeId, value: buf.readFloatLE(off) });
                off += 4;
            } else if (type === READING_TYPE_BOOL) {
                if (off + 1 > buf.length) {
                    return { ok: false, error: LantanaError.PAYLOAD_INVALID, message: "frame terpotong" };
                }
                readings.push({ schemeId, value: buf.readUInt8(off) !== 0 });
                off += 1;
            } else if (type === READING_TYPE_STRING) {
                if (off + 1 > buf.length) {
                    return { ok: false, error: LantanaError.PAYLOAD_INVALID, message: "frame terpotong" };
                }
                const len = buf.readUInt8(off++);
                if (off + len > buf.length) {
                    return { ok: false, error: LantanaError.PAYLOAD_INVALID, message: "frame terpotong" };
                }
                readings.push({ schemeId, value: buf.subarray(off, off + len).toString("utf8") });
                off += len;
            } else {
                return {
                    ok: false,
                    error: LantanaError.PAYLOAD_INVALID,
                    message: `tipe bacaan tidak dikenal: 0x${type.toString(16)}`,
                };
            }
        }

        return { ok: true, format: "binary", deviceId, readings };
    } catch (e: any) {
        return {
            ok: false,
            error: LantanaError.PAYLOAD_INVALID,
            message: `frame tidak valid: ${e?.message || e}`,
        };
    }
}

/** Parse payload apa pun (Buffer biner atau string plain) → ParsedPayload. */
export function parsePayload(data: any): ParsedPayload {
    if (Buffer.isBuffer(data)) return parseBinaryPayload(data);
    if (typeof data === "string") return parsePlainPayload(data);
    return { ok: false, error: LantanaError.PAYLOAD_INVALID, message: "tipe payload tidak didukung" };
}

/** Encode frame biner V2 — dipakai device simulator dan test. */
export function encodeBinaryPayload(
    deviceId: string,
    readings: RawReading[],
): Buffer {
    const devBuf = Buffer.from(deviceId, "utf8");
    if (devBuf.length === 0 || devBuf.length > 255) throw new Error("deviceId harus 1..255 byte");
    if (readings.length === 0 || readings.length > 255) throw new Error("jumlah bacaan harus 1..255");

    const parts: Buffer[] = [Buffer.from([LANTANA_BINARY_MAGIC, LANTANA_BINARY_VERSION, devBuf.length])];
    parts.push(devBuf);
    parts.push(Buffer.from([readings.length]));

    for (const r of readings) {
        if (!Number.isInteger(r.schemeId) || r.schemeId < 0 || r.schemeId > 0xffff) {
            throw new Error(`schemeId tidak valid: ${r.schemeId}`);
        }
        const idBuf = Buffer.alloc(2);
        idBuf.writeUInt16LE(r.schemeId, 0);
        parts.push(idBuf);

        if (typeof r.value === "boolean") {
            parts.push(Buffer.from([READING_TYPE_BOOL, r.value ? 1 : 0]));
        } else if (typeof r.value === "number") {
            const v = Buffer.alloc(4);
            v.writeFloatLE(r.value, 0);
            parts.push(Buffer.from([READING_TYPE_F32]));
            parts.push(v);
        } else {
            const strBuf = Buffer.from(String(r.value), "utf8");
            if (strBuf.length > 255) throw new Error("nilai string maksimal 255 byte");
            parts.push(Buffer.from([READING_TYPE_STRING, strBuf.length]));
            parts.push(strBuf);
        }
    }

    return Buffer.concat(parts);
}

/** Encode payload teks V2. */
export function encodePlainPayload(deviceId: string, readings: RawReading[]): string {
    const body = readings.map((r) => `${r.schemeId}:${String(r.value)}`).join(";");
    return `${LANTANA_PLAIN_PREFIX}|${deviceId}|${body}`;
}

// ─── Helper target daemon ─────────────────────────────────────────────────
/**
 * Terjemahkan argumen target dari CLI menjadi target `shell.send`.
 *
 * Kernel memperlakukan string sebagai IDENTITY (UUID), bukan PID. Jadi "7"
 * harus dikirim sebagai angka 7, sedangkan UUID tetap string.
 */
export function resolveDaemonTarget(arg?: string | null): number | string {
    const raw = (arg || "").trim();
    if (!raw) return LANTANA_UUID;
    if (/^\d+$/.test(raw)) return parseInt(raw, 10);
    return raw;
}

// ─── Helper izin ──────────────────────────────────────────────────────────
/** Apakah schemeId termasuk dalam daftar scheme/rentang. */
export function schemeInList(list: SchemeRange[] | undefined, schemeId: number): boolean {
    if (!list || list.length === 0) return false;
    for (const entry of list) {
        if (typeof entry === "number") {
            if (entry === schemeId) return true;
        } else if (schemeId >= entry.from && schemeId <= entry.to) {
            return true;
        }
    }
    return false;
}

export const EMPTY_PERMISSIONS: Permissions = {
    allowedInjectSchemes: [],
    allowedQuerySchemes: [],
    allowedCommandDevices: [],
};
