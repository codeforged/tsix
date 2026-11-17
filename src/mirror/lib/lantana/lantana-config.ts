/**
 * lantana-config.ts — Loader konfigurasi layanan Lantana V2.
 *
 * Hanya berisi konfigurasi layanan dan katalog kategori. Kredensial TIDAK
 * disimpan di sini (lihat accounts.json / AccountManager).
 *
 * Dipisah dari lantana-core.ts supaya core tetap bisa diuji tanpa runtime VFS.
 *
 * (c) 2026 TSIX Project — Lantana
 */

import { fs } from "@tsix/Application";
import { LANTANA_CONFIG_PATH } from "@tsix/lantana/lantana-core";

export interface LantanaPortConfig {
    enabled: boolean;
}

export interface LantanaCategory {
    label: string;
    icon?: string;
    description?: string;
}

export interface LantanaConfig {
    /** Port layanan MQTNL tempat listener menerima data device. */
    ports: Record<string, LantanaPortConfig>;
    deviceCategories: Record<string, LantanaCategory>;
}

export function defaultConfig(): LantanaConfig {
    return {
        ports: { "1000": { enabled: true } },
        deviceCategories: {
            esp: { label: "ESP", icon: "🔧" },
            simulator: { label: "Simulator", icon: "💻" },
            generic: { label: "Generic Device", icon: "📡" },
        },
    };
}

/** Baca /etc/lantana/config.json; fallback ke default bila tidak ada/rusak. */
export async function loadConfig(): Promise<LantanaConfig> {
    const fallback = defaultConfig();
    try {
        const raw = await fs.readFile(LANTANA_CONFIG_PATH);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return {
            ports: parsed.ports || fallback.ports,
            deviceCategories: parsed.deviceCategories || fallback.deviceCategories,
        };
    } catch {
        return fallback;
    }
}

/** Daftar port yang aktif. */
export function enabledPorts(config: LantanaConfig): number[] {
    const out: number[] = [];
    for (const [portStr, cfg] of Object.entries(config.ports)) {
        if (cfg && cfg.enabled === false) continue;
        const port = parseInt(portStr, 10);
        if (!isNaN(port)) out.push(port);
    }
    return out;
}

/** Tulis konfigurasi (dipakai CLI). */
export async function saveConfig(config: LantanaConfig): Promise<void> {
    await fs.writeFile(LANTANA_CONFIG_PATH, JSON.stringify(config, null, 4) + "\n");
}
