/**
 * lantana-core.ts — Lantana IoT Stack (shared core)
 *
 * Modul bersama untuk seluruh layer Lantana: tipe data, konstanta, parsing
 * payload (biner/plaintext), dan loading config /etc/lantana/config.json.
 *
 * (c) 2026 TSIX Project — Lantana
 */

import { fs } from "@tsix/Application";

// ─── Konstanta ────────────────────────────────────────────────────────────
export const LANTANA_CONFIG_PATH = "/etc/lantana/config.json";
export const LANTANA_LOG_DIR = "/var/log/lantana";
export const LANTANA_DEFAULT_PORT = 1000;
export const LANTANA_UUID = "5f4e2a91-4b0f-4c9a-b1c3-0a1b2c3d4e5f"; // identity daemon Lantana

// Tipe event IPC antar layer & ke consumer
export const EVT_RAW_DATA = "LANTANA_RAW_DATA";          // listener → device-bank/distributor
export const EVT_SENSOR_DATA = "LANTANA_SENSOR_DATA";    // distributor → consumer
export const EVT_DEVICE_STATUS = "LANTANA_DEVICE_STATUS";// distributor → consumer (heartbeat update)
export const EVT_SNAPSHOT = "LANTANA_SNAPSHOT";          // consumer → distributor (request data)
export const EVT_COMMAND = "LANTANA_COMMAND";            // consumer → distributor (kirim command ke device)

// Status heartbeat device
export type DeviceStatus = "ONLINE" | "STALE" | "OFFLINE";
export const DEVICE_STALE_MS = 15000;   // >15s tanpa data → STALE
export const DEVICE_OFFLINE_MS = 60000; // >60s tanpa data → OFFLINE

// ─── Tipe data ────────────────────────────────────────────────────────────

export interface LantanaConfig {
    ports: Record<string, LantanaPortConfig>;
    deviceCategories: Record<string, LantanaDeviceCategory>;
    sensorCategories: Record<string, LantanaSensorCategory>;
    /** Peta grup tenant: { tenant: { nodeId: group } } — pengelompokan device di
     *  sisi tenant/dashboard. nodeId boleh sama antar tenant (key per tenant).
     *  Bentuk flat legacy { nodeId: group } tetap didukung (backward compat). */
    deviceGroupMap?: Record<string, Record<string, string>>;
}

export interface LantanaPortConfig {
    tenant: string;
    /** API key tenant (hex) — kredensial akses ke layanan Lantana, sekaligus
     *  kunci enkripsi ChaCha20 (diterbitkan portal saat registrasi). */
    apiKeyHex: string;
    enabled: boolean;
    /** Opsional: mode default untuk port ini ("auto" | "binary" | "plain") */
    mode?: "auto" | "binary" | "plain";
}

export interface LantanaDeviceCategory {
    label: string;
    icon?: string;
    description?: string;
}

export interface LantanaSensorCategory {
    label: string;
    unit: string;
    icon?: string;
    /** Rentang normal utk display/health (opsional) */
    min?: number;
    max?: number;
}

/** Satu bacaan sensor (nilai sudah dinormalisasi) */
export interface SensorReading {
    id: string;
    value: number;
    /** Kategori sensor (mis. "temp", "hum") — di-resolve dari config */
    category: string;
    label: string;
    unit: string;
    ts: number;
}

/** Satu paket data mentah dari device (hasil parse listener) */
export interface RawSensorData {
    nodeId: string;
    /** Port tujuan paket → menentukan tenant */
    port: number;
    /** Alamat sumber device (untuk kirim command balik / dua arah) */
    srcAddress: string;
    /** Port sumber device (untuk kirim command balik / dua arah) */
    srcPort: number;
    tenant: string;
    format: "binary" | "plain";
    receivedAt: number;
    sensors: { id: string; value: number }[];
}

/** Perintah dua arah dari consumer ke device tertentu (mis. "RELAY_1:ON"). */
export interface LantanaCommand {
    type: typeof EVT_COMMAND;
    /** nodeId tujuan (device di Device Bank) */
    nodeId: string;
    /** Isi perintah yang dikirim ke device, mis. "RELAY_1:ON" */
    command: string;
    /** Opsional: tenant tujuan — dipakai saat nodeId sama di beberapa tenant */
    tenant?: string;
    /** Opsional: siapa yang meminta (untuk log) */
    from?: string;
}

/** Data sensor ternormalisasi yang dikirim ke consumer */
export interface NormalizedSensorData {
    type: typeof EVT_SENSOR_DATA;
    tenant: string;
    nodeId: string;
    nodeCategory: string;
    nodeLabel: string;
    /** Grup tenant (dari deviceGroupMap) — opsional */
    group?: string;
    format: "binary" | "plain";
    receivedAt: number;
    dataAgeMs: number;
    deviceStatus: DeviceStatus;
    sensors: SensorReading[];
    meta: {
        port: number;
        count: number;
        source: string;
    };
}

/** Status device terkini (untuk EVT_DEVICE_STATUS / snapshot) */
export interface DeviceStatusInfo {
    nodeId: string;
    tenant: string;
    category: string;
    label: string;
    /** Grup tenant (dari deviceGroupMap) — opsional */
    group?: string;
    lastDataAt: number;
    dataAgeMs: number;
    status: DeviceStatus;
    sensorIds: string[];
}

/** Payload protokol Lantana untuk device (agar device tahu cara kirim) */
export const LANTANA_PROTOCOL = {
    /** Magic MQTNL binary protocol v1.1 (dari driver) */
    magicBinary: 0x42,
    /** Magic frame sensor Lantana (biner di atas payload MQTNL) */
    magicFrameBinary: 0x4c,
    magicPlain: "LANTANA",
};

// ─── Config loader ────────────────────────────────────────────────────────

/** Baca & parse /etc/lantana/config.json; kembalikan config default jika gagal. */
export async function loadConfig(): Promise<LantanaConfig> {
    const fallback: LantanaConfig = {
        ports: {
            "1000": {
                tenant: "default",
                apiKeyHex: "81ff71ed574e54597690ae7b04e4ef5fc87497fe10b6b037cb031af7c7d67619",
                enabled: true,
                mode: "auto",
            },
        },
        deviceCategories: {
            esp32: { label: "ESP32", icon: "🔧" },
            simulator: { label: "Simulator", icon: "💻" },
            generic: { label: "Generic Device", icon: "📡" },
        },
        sensorCategories: {
            temp: { label: "Temperature", unit: "°C", icon: "🌡️", min: -40, max: 125 },
            hum: { label: "Humidity", unit: "%", icon: "💧", min: 0, max: 100 },
            pres: { label: "Pressure", unit: "hPa", icon: "🌀", min: 800, max: 1100 },
            light: { label: "Light", unit: "lx", icon: "☀️", min: 0, max: 100 },
            generic: { label: "Sensor", unit: "", icon: "📊" },
        },
        deviceGroupMap: {},
    };

    try {
        const raw = await fs.readFile(LANTANA_CONFIG_PATH);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        // Merge shallow dengan fallback (agar config parsial tetap aman)
        return {
            ports: parsed.ports || fallback.ports,
            deviceCategories: parsed.deviceCategories || fallback.deviceCategories,
            sensorCategories: parsed.sensorCategories || fallback.sensorCategories,
            deviceGroupMap: parsed.deviceGroupMap || {},
        };
    } catch (e: any) {
        // Config tidak ada/rusak → gunakan default
        return fallback;
    }
}

/** Cari port config untuk tenant/apiKey; return null jika port tidak di-enable. */
export function getPortConfig(
    config: LantanaConfig,
    port: number,
): LantanaPortConfig | null {
    const p = config.ports[String(port)];
    return p && p.enabled !== false ? p : null;
}

// ─── Parsing payload ──────────────────────────────────────────────────────

/**
 * Deteksi format payload dari data mentah (string atau Buffer).
 * - diawali byte 0x42 (MQTNL binary) atau 0x4C (frame sensor Lantana) → "binary"
 * - diawali token "LANTANA" → "plain" (protokol teks ber-nodeId)
 * - selain itu → "plain" (fallback kompatibel `id:val;id:val`)
 */
export function detectFormat(data: any): "binary" | "plain" {
    if (Buffer.isBuffer(data)) {
        return data.length > 0 &&
            (data[0] === LANTANA_PROTOCOL.magicBinary ||
                data[0] === LANTANA_PROTOCOL.magicFrameBinary)
            ? "binary"
            : "plain";
    }
    if (typeof data === "string") {
        const s = data.trim();
        if (s.startsWith("{")) {
            // Mungkin payload JSON { type: "Buffer", data: [...] } — cek isinya
            try {
                const obj = JSON.parse(s);
                if (obj && obj.type === "Buffer" && Array.isArray(obj.data)) {
                    const arr = obj.data as number[];
                    if (arr.length > 0 &&
                        (arr[0] === LANTANA_PROTOCOL.magicBinary ||
                            arr[0] === LANTANA_PROTOCOL.magicFrameBinary)) {
                        return "binary";
                    }
                }
            } catch (_) {
                /* bukan JSON */
            }
        }
        return "plain";
    }
    return "plain";
}

/**
 * Parse payload plaintext Lantana.
 * Mendukung 2 bentuk:
 *   1. "LANTANA|nodeId|sensorId:value;sensorId:value;..."  (ber-nodeId, protokol baru)
 *   2. "sensorId:value;sensorId:value;..."                  (kompatibel iot-listener lama)
 */
export function parsePlainPayload(
    data: string,
    defaultNodeId: string,
): { nodeId: string; sensors: { id: string; value: number }[] } {
    const s = (data || "").trim();
    const sensors: { id: string; value: number }[] = [];
    let nodeId = defaultNodeId;

    if (!s) return { nodeId, sensors };

    let body = s;
    if (s.startsWith(LANTANA_PROTOCOL.magicPlain + "|")) {
        // Format: LANTANA|<nodeId>|<payload>
        const parts = s.split("|");
        if (parts.length >= 3 && parts[1]) {
            nodeId = parts[1];
            body = parts.slice(2).join("|");
        }
    }

    for (const entry of body.split(";")) {
        if (!entry) continue;
        const idx = entry.indexOf(":");
        if (idx < 0) continue;
        const id = entry.substring(0, idx).trim();
        const val = parseFloat(entry.substring(idx + 1).trim());
        if (id && !isNaN(val)) sensors.push({ id, value: val });
    }

    return { nodeId, sensors };
}

/**
 * Parse payload biner MQTNL v1.1 (sudah di-unpack oleh driver menjadi
 * { header, payload: Buffer }) ATAU raw Buffer.
 *
 * Bentuk frame sensor Lantana (custom di atas MQTNL binary payload):
 *   [MAGIC 0x4C] [VER 0x01] [NODE_LEN 1] [NODE...] [CNT 1]
 *   per sensor: [SID_LEN 1][SID...][VAL 4 float32 LE]
 *
 * Jika payload tidak dikenali → fallback ke parsePlainPayload(payload.toString()).
 */
export function parseBinaryPayload(
    payload: Buffer | any,
    defaultNodeId: string,
): { nodeId: string; sensors: { id: string; value: number }[] } {
    let buf: Buffer;
    if (Buffer.isBuffer(payload)) {
        buf = payload;
    } else if (payload && payload.header && payload.payload) {
        buf = Buffer.isBuffer(payload.payload)
            ? payload.payload
            : Buffer.from(payload.payload);
    } else if (payload && payload.data) {
        buf = Buffer.isBuffer(payload.data) ? payload.data : Buffer.from(String(payload.data), "binary");
    } else {
        return { nodeId: defaultNodeId, sensors: [] };
    }

    // Frame sensor Lantana
    if (buf.length >= 2 && buf[0] === 0x4c && buf[1] === 0x01) {
        try {
            let off = 2;
            const nodeLen = buf.readUInt8(off++);
            const nodeId = buf.subarray(off, off + nodeLen).toString("utf8") || defaultNodeId;
            off += nodeLen;
            const cnt = buf.readUInt8(off++);
            const sensors: { id: string; value: number }[] = [];
            for (let i = 0; i < cnt; i++) {
                if (off + 1 > buf.length) break;
                const sidLen = buf.readUInt8(off++);
                if (off + sidLen > buf.length) break;
                const sid = buf.subarray(off, off + sidLen).toString("utf8");
                off += sidLen;
                if (off + 4 > buf.length) break;
                const val = buf.readFloatLE(off);
                off += 4;
                if (sid) sensors.push({ id: sid, value: val });
            }
            return { nodeId, sensors };
        } catch (_) {
            /* fallback di bawah */
        }
    }

    // Bukan frame Lantana → coba baca sebagai teks (device lama / OTA debug)
    const text = buf.toString("utf8").trim();
    if (text) {
        return parsePlainPayload(text, defaultNodeId);
    }
    return { nodeId: defaultNodeId, sensors: [] };
}

/**
 * Parse payload apa pun (string/buffer/objek) → RawSensorData.
 * Dipakai listener untuk menyeragamkan input dari device.
 */
export function parsePayload(
    data: any,
    defaultNodeId: string,
): { nodeId: string; sensors: { id: string; value: number }[]; format: "binary" | "plain" } {
    const format = detectFormat(data);
    if (format === "binary") {
        return { ...parseBinaryPayload(data, defaultNodeId), format };
    }
    const text = Buffer.isBuffer(data)
        ? data.toString("utf8")
        : String(data || "");
    return { ...parsePlainPayload(text, defaultNodeId), format };
}
