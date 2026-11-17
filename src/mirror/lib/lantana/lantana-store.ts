/**
 * lantana-store.ts — Persistensi akun, device, dan scheme ke VFS.
 *
 * Tidak ada kompatibilitas dengan konfigurasi V1: file dibaca apa adanya
 * sebagai kontrak V2. File yang belum ada dibuat otomatis dengan isi kosong
 * agar daemon bisa start di instalasi baru; file yang rusak dilaporkan.
 *
 * (c) 2026 TSIX Project — Lantana
 */

import { fs } from "@tsix/Application";
import { AccountManager } from "@tsix/lantana/account-manager";
import { DeviceRegistry } from "@tsix/lantana/device-registry";
import { SchemeRegistry } from "@tsix/lantana/scheme-registry";
import {
    AccountRecord,
    DeviceRecord,
    LANTANA_ACCOUNTS_PATH,
    LANTANA_DEVICES_PATH,
    LANTANA_SCHEMES_PATH,
    SchemeDef,
} from "@tsix/lantana/lantana-core";

export interface LantanaState {
    accounts: AccountManager;
    devices: DeviceRegistry;
    schemes: SchemeRegistry;
}

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

export async function loadState(): Promise<LantanaState> {
    const accountRecords = await readJson<AccountRecord[]>(LANTANA_ACCOUNTS_PATH, "akun");
    const accounts = AccountManager.fromJSON(accountRecords);
    if (
        accountRecords.some(
            (account) =>
                account?.portableDashboard !== undefined &&
                account.portableDashboard !== null &&
                !Array.isArray(account.portableDashboard),
        )
    ) {
        await writeJson(LANTANA_ACCOUNTS_PATH, accounts.toJSON());
    }
    const devices = DeviceRegistry.fromJSON(
        await readJson<DeviceRecord[]>(LANTANA_DEVICES_PATH, "device"),
    );
    const schemes = SchemeRegistry.fromJSON(
        await readJson<SchemeDef[]>(LANTANA_SCHEMES_PATH, "scheme"),
    );
    return { accounts, devices, schemes };
}

export async function saveState(state: LantanaState): Promise<void> {
    await writeJson(LANTANA_ACCOUNTS_PATH, state.accounts.toJSON());
    await writeJson(LANTANA_DEVICES_PATH, state.devices.toJSON());
    await writeJson(LANTANA_SCHEMES_PATH, state.schemes.toJSON());
}
