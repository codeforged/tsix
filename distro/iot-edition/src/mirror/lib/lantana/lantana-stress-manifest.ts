import { DeviceRegistry } from "@tsix/lantana/device-registry";
import { SchemeRegistry } from "@tsix/lantana/scheme-registry";

export const LANTANA_STRESS_MANIFEST_PREFIX = "/etc/lantana/stress-run-";
export const LANTANA_STRESS_MAX_DEVICES = 1000;
export const LANTANA_STRESS_MAX_GROUPS = 10;
export const LANTANA_STRESS_MAX_SCHEMES = 32;

export interface StressManifestDevice {
    deviceId: string;
    name: string;
    group: string;
}

export interface StressManifestScheme {
    schemeId: number;
    label: string;
    type: "number";
    unit: "unit";
    min: 0;
    max: 100;
}

export interface StressManifest {
    version: 1;
    runId: string;
    accountId: string;
    createdAt: number;
    count: number;
    groups: number;
    devices: StressManifestDevice[];
    schemes: StressManifestScheme[];
}

export function stressManifestPath(runId: string): string {
    return `${LANTANA_STRESS_MANIFEST_PREFIX}${runId}.json`;
}

export function stressDeviceName(runId: string, index: number): string {
    return `stress-${runId}-device-${String(index + 1).padStart(4, "0")}`;
}

export function stressGroupName(runId: string, index: number, groups: number): string {
    return `stress-${runId}-group-${String((index % groups) + 1).padStart(2, "0")}`;
}

export function stressSchemeLabel(runId: string, index: number): string {
    return `stress-${runId}-scheme-${String(index + 1).padStart(2, "0")}`;
}

export function parseStressManifest(raw: string, path: string): StressManifest {
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        throw new Error("Manifest stress bukan JSON yang valid.");
    }

    if (!isRecord(value)) {
        throw new Error("Isi atau lokasi manifest stress tidak valid.");
    }

    const {
        version,
        runId,
        accountId,
        createdAt,
        count,
        groups,
        devices: entries,
        schemes: schemeEntries = [],
    } = value;
    if (version !== 1 ||
        typeof runId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId) ||
        path !== stressManifestPath(runId) ||
        typeof accountId !== "string" || !accountId ||
        typeof createdAt !== "number" || !Number.isFinite(createdAt) ||
        !isSafeInteger(count) || count < 1 || count > LANTANA_STRESS_MAX_DEVICES ||
        !isSafeInteger(groups) || groups < 1 || groups > LANTANA_STRESS_MAX_GROUPS ||
        !Array.isArray(entries) || entries.length !== count ||
        !Array.isArray(schemeEntries) || schemeEntries.length > LANTANA_STRESS_MAX_SCHEMES) {
        throw new Error("Isi atau lokasi manifest stress tidak valid.");
    }

    const devices: StressManifestDevice[] = [];
    const seenIds = new Set<string>();
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (!isRecord(entry) ||
            typeof entry.deviceId !== "string" || !entry.deviceId ||
            typeof entry.name !== "string" ||
            typeof entry.group !== "string" ||
            entry.name !== stressDeviceName(runId, index) ||
            entry.group !== stressGroupName(runId, index, groups) ||
            seenIds.has(entry.deviceId)) {
            throw new Error(`Device pada manifest stress tidak valid (index ${index}).`);
        }
        seenIds.add(entry.deviceId);
        devices.push({
            deviceId: entry.deviceId,
            name: entry.name,
            group: entry.group,
        });
    }

    const schemes: StressManifestScheme[] = [];
    const seenSchemeIds = new Set<number>();
    for (let index = 0; index < schemeEntries.length; index++) {
        const entry = schemeEntries[index];
        if (
            !isRecord(entry) ||
            !isSafeInteger(entry.schemeId) ||
            entry.schemeId < 1 ||
            entry.schemeId > 0xffff ||
            typeof entry.label !== "string" ||
            entry.label !== stressSchemeLabel(runId, index) ||
            entry.type !== "number" ||
            entry.unit !== "unit" ||
            entry.min !== 0 ||
            entry.max !== 100 ||
            seenSchemeIds.has(entry.schemeId)
        ) {
            throw new Error(`Scheme pada manifest stress tidak valid (index ${index}).`);
        }
        seenSchemeIds.add(entry.schemeId);
        schemes.push({
            schemeId: entry.schemeId,
            label: entry.label,
            type: "number",
            unit: "unit",
            min: 0,
            max: 100,
        });
    }

    return {
        version: 1,
        runId,
        accountId,
        createdAt,
        count,
        groups,
        devices,
        schemes,
    };
}

export function assertStressSchemes(
    registry: SchemeRegistry,
    manifest: StressManifest,
): void {
    for (const expected of manifest.schemes) {
        const scheme = registry.get(expected.schemeId);
        if (!scheme || !matchesStressScheme(scheme, manifest.accountId, expected)) {
            throw new Error(`Metadata scheme stress berubah atau scheme tidak ditemukan: ${expected.schemeId}`);
        }
    }
}

export function removeStressSchemes(
    registry: SchemeRegistry,
    manifest: StressManifest,
): number {
    const found: StressManifestScheme[] = [];
    for (const expected of manifest.schemes) {
        const scheme = registry.get(expected.schemeId);
        if (!scheme) continue;
        if (!matchesStressScheme(scheme, manifest.accountId, expected)) {
            throw new Error(`Metadata scheme berubah; cleanup dihentikan: ${expected.schemeId}`);
        }
        found.push(expected);
    }

    for (const scheme of found) {
        registry.remove(manifest.accountId, scheme.schemeId);
    }
    return found.length;
}

function matchesStressScheme(
    scheme: NonNullable<ReturnType<SchemeRegistry["get"]>>,
    accountId: string,
    expected: StressManifestScheme,
): boolean {
    return scheme.ownerAccountId === accountId &&
        scheme.label === expected.label &&
        scheme.type === expected.type &&
        scheme.unit === expected.unit &&
        scheme.min === expected.min &&
        scheme.max === expected.max;
}

export function assertStressDevices(
    registry: DeviceRegistry,
    manifest: StressManifest,
): void {
    for (const expected of manifest.devices) {
        const record = registry.get(manifest.accountId, expected.deviceId);
        if (!record) throw new Error(`Device stress tidak ditemukan: ${expected.deviceId}`);
        if (
            record.meta.name !== expected.name ||
            record.meta.group !== expected.group ||
            record.meta.category !== "stress-test"
        ) {
            throw new Error(`Metadata device berubah; operasi dihentikan: ${expected.deviceId}`);
        }
    }
}

export function removeStressDevices(
    registry: DeviceRegistry,
    manifest: StressManifest,
): number {
    const found: StressManifestDevice[] = [];
    for (const expected of manifest.devices) {
        const record = registry.get(manifest.accountId, expected.deviceId);
        if (!record) continue;
        if (
            record.meta.name !== expected.name ||
            record.meta.group !== expected.group ||
            record.meta.category !== "stress-test"
        ) {
            throw new Error(`Metadata device berubah; cleanup dihentikan: ${expected.deviceId}`);
        }
        found.push(expected);
    }

    for (const device of found) {
        registry.remove(manifest.accountId, device.deviceId);
    }
    return found.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value);
}
