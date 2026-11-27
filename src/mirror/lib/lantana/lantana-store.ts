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
    LANTANA_KEYS_DIR,
    LANTANA_PSK_PATH,
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

/**
 * Semua file state 0600 root (SEC-15): berisi verifier key, PSK device, dan
 * data client. Yang membacanya (daemon `lantana`, `lantana-dashboard-server`,
 * `lantana-ctl` SetUID) berjalan sebagai root; Control Panel lewat `lantana-ctl`.
 */
const STATE_FILE_MODE = 0o600;
const KEYS_DIR_MODE = 0o700;

async function ensureDir(dir: string = STATE_DIR): Promise<void> {
    try {
        await fs.mkdir(STATE_DIR);
    } catch {
        /* sudah ada */
    }
    if (dir !== STATE_DIR) {
        try {
            await fs.mkdir(dir);
        } catch {
            /* sudah ada */
        }
        await fs.chmod(dir, KEYS_DIR_MODE);
    }
}

function dirOf(path: string): string {
    return path.substring(0, path.lastIndexOf("/")) || "/";
}

async function restrict(path: string): Promise<void> {
    if (!(await fs.chmod(path, STATE_FILE_MODE))) {
        throw new LantanaStoreError(`gagal mengamankan ${path} (chmod 0600)`);
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
async function ensureFile(path: string, empty: string = "[]\n"): Promise<string> {
    const existing = await readRaw(path);
    if (existing !== null) {
        // File dari instalasi lama bisa bermode default; kunci setiap kali dibaca.
        await restrict(path);
        return existing;
    }

    await ensureDir(dirOf(path));
    if (!(await fs.writeFile(path, empty))) {
        throw new LantanaStoreError(`tidak bisa membuat ${path}`);
    }
    await restrict(path);
    return empty;
}

async function readJson<T>(path: string, kind: string, empty?: string): Promise<T> {
    const raw = await ensureFile(path, empty);
    try {
        return JSON.parse(raw) as T;
    } catch {
        throw new LantanaStoreError(`${path} bukan JSON ${kind} yang valid`);
    }
}

async function writeJson(path: string, value: unknown): Promise<void> {
    await ensureDir(dirOf(path));
    if (!(await fs.writeFile(path, JSON.stringify(value, null, 2) + "\n"))) {
        throw new LantanaStoreError(`gagal menulis ${path}`);
    }
    await restrict(path);
}

/** Tulis akun: accounts.json (tanpa PSK) + keys/psk.json. PSK ditulis dulu. */
async function saveAccounts(accounts: AccountManager): Promise<void> {
    await writeJson(LANTANA_PSK_PATH, accounts.pskTable());
    await writeJson(LANTANA_ACCOUNTS_PATH, accounts.toJSON());
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
    const pskTable = await readJson<Record<string, string>>(LANTANA_PSK_PATH, "PSK (psk.json)", "{}\n");
    const accounts = AccountManager.fromJSON(accountRecords, pskTable);
    const dashboards = DashboardRegistry.fromJSON(
        await readJson<DashboardRecord[]>(LANTANA_DASHBOARDS_PATH, "dashboard"),
    );
    if (migrateLegacyDashboards(accountRecords, dashboards)) {
        await saveAccounts(accounts);
        await writeJson(LANTANA_DASHBOARDS_PATH, dashboards.toJSON());
    } else if (accounts.hasLegacyPsk) {
        // Format lama: PSK masih di accounts.json → pindahkan (SEC-15).
        await saveAccounts(accounts);
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
    await saveAccounts(state.accounts);
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
