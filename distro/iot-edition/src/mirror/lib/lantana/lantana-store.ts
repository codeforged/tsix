/**
 * lantana-store.ts — Persistensi akun, dashboard, device, dan scheme ke VFS.
 *
 * Tidak ada kompatibilitas dengan konfigurasi V1: file dibaca apa adanya
 * sebagai kontrak V2. File yang belum ada dibuat otomatis dengan isi kosong
 * agar daemon bisa start di instalasi baru; file yang rusak dilaporkan.
 *
 * (c) 2026 TSIX Project — Lantana
 */

import { fs } from "@tsix/Application";
import { AccountManager } from "@tsix/lantana/account-manager";
import { DashboardRegistry } from "@tsix/lantana/dashboard-registry";
import { DeviceRegistry } from "@tsix/lantana/device-registry";
import { SchemeRegistry } from "@tsix/lantana/scheme-registry";
import {
    AccountRecord,
    DashboardRecord,
    DeviceRecord,
    LANTANA_ACCOUNTS_PATH,
    LANTANA_DASHBOARDS_PATH,
    LANTANA_DEVICES_PATH,
    LANTANA_SCHEMES_PATH,
    SchemeDef,
} from "@tsix/lantana/lantana-core";

export interface LantanaState {
    accounts: AccountManager;
    dashboards: DashboardRegistry;
    devices: DeviceRegistry;
    schemes: SchemeRegistry;
}

/** accounts.json versi lama masih menyimpan dashboard di dalam akun. */
type LegacyAccountRecord = AccountRecord & { portableDashboard?: unknown };

export class LantanaStoreError extends Error {}

const STATE_DIR = "/etc/lantana";

async function ensureDir(): Promise<void> {
    try {
        await fs.mkdir(STATE_DIR);
    } catch {
        /* sudah ada */
    }
}

async function readRaw(path: string): Promise<string | null> {
    try {
        return await fs.readFile(path);
    } catch {
        // VFS melempar "File not found" bila path belum ada.
        return null;
    }
}

/** Buat file state kosong bila belum ada; kembalikan isinya. */
async function ensureFile(path: string): Promise<string> {
    const existing = await readRaw(path);
    if (existing !== null) return existing;

    await ensureDir();
    if (!(await fs.writeFile(path, "[]\n"))) {
        throw new LantanaStoreError(`tidak bisa membuat ${path}`);
    }
    return "[]\n";
}

async function readJson<T>(path: string, kind: string): Promise<T> {
    const raw = await ensureFile(path);
    try {
        return JSON.parse(raw) as T;
    } catch {
        throw new LantanaStoreError(`${path} bukan JSON ${kind} yang valid`);
    }
}

async function writeJson(path: string, value: unknown): Promise<void> {
    await ensureDir();
    if (!(await fs.writeFile(path, JSON.stringify(value, null, 2) + "\n"))) {
        throw new LantanaStoreError(`gagal menulis ${path}`);
    }
}

/**
 * Pindahkan `portableDashboard` yang tertinggal di accounts.json ke
 * dashboard.json. Mengembalikan true bila ada yang dimigrasikan.
 */
function migrateLegacyDashboards(
    records: LegacyAccountRecord[],
    dashboards: DashboardRegistry,
): boolean {
    let migrated = false;
    for (const record of records) {
        if (!record || typeof record.accountId !== "string") continue;
        if (record.portableDashboard === undefined || record.portableDashboard === null) continue;
        dashboards.importLegacy(record.accountId, record.portableDashboard);
        migrated = true;
    }
    return migrated;
}

export async function loadState(): Promise<LantanaState> {
    const accountRecords = await readJson<LegacyAccountRecord[]>(LANTANA_ACCOUNTS_PATH, "akun");
    const accounts = AccountManager.fromJSON(accountRecords);
    const dashboards = DashboardRegistry.fromJSON(
        await readJson<DashboardRecord[]>(LANTANA_DASHBOARDS_PATH, "dashboard"),
    );
    if (migrateLegacyDashboards(accountRecords, dashboards)) {
        await writeJson(LANTANA_ACCOUNTS_PATH, accounts.toJSON());
        await writeJson(LANTANA_DASHBOARDS_PATH, dashboards.toJSON());
    }
    const devices = DeviceRegistry.fromJSON(
        await readJson<DeviceRecord[]>(LANTANA_DEVICES_PATH, "device"),
    );
    const schemes = SchemeRegistry.fromJSON(
        await readJson<SchemeDef[]>(LANTANA_SCHEMES_PATH, "scheme"),
    );
    return { accounts, dashboards, devices, schemes };
}

export async function saveState(state: LantanaState): Promise<void> {
    await writeJson(LANTANA_ACCOUNTS_PATH, state.accounts.toJSON());
    await writeJson(LANTANA_DASHBOARDS_PATH, state.dashboards.toJSON());
    await saveDevices(state.devices);
    await saveSchemes(state.schemes);
}

/** Simpan registry device saja, tanpa menulis ulang file state Lantana lain. */
export async function saveDevices(devices: DeviceRegistry): Promise<void> {
    await writeJson(LANTANA_DEVICES_PATH, devices.toJSON());
}

/** Simpan registry scheme saja, tanpa menulis ulang file state Lantana lain. */
export async function saveSchemes(schemes: SchemeRegistry): Promise<void> {
    await writeJson(LANTANA_SCHEMES_PATH, schemes.toJSON());
}
