import { describe, expect, it } from "vitest";
import { DeviceRegistry } from "./device-registry";
import { SchemeRegistry } from "./scheme-registry";
import {
    assertStressDevices,
    assertStressSchemes,
    parseStressManifest,
    removeStressDevices,
    removeStressSchemes,
    stressDeviceName,
    stressGroupName,
    stressManifestPath,
    stressSchemeLabel,
    type StressManifest,
} from "./lantana-stress-manifest";

const runId = "11111111-1111-4111-8111-111111111111";

function makeManifest(deviceIds: string[] = ["device-1", "device-2"]): StressManifest {
    return {
        version: 1,
        runId,
        accountId: "stress-account",
        createdAt: 123,
        count: deviceIds.length,
        groups: 2,
        devices: deviceIds.map((deviceId, index) => ({
            deviceId,
            name: stressDeviceName(runId, index),
            group: stressGroupName(runId, index, 2),
        })),
        schemes: [0, 1].map((index) => ({
            schemeId: 60000 + index,
            label: stressSchemeLabel(runId, index),
            type: "number" as const,
            unit: "unit" as const,
            min: 0 as const,
            max: 100 as const,
        })),
    };
}

describe("Lantana stress manifest", () => {
    it("validates the generated manifest path, shape, and device ownership tags", () => {
        const manifest = makeManifest();
        const parsed = parseStressManifest(
            JSON.stringify(manifest),
            stressManifestPath(runId),
        );
        expect(parsed).toEqual(manifest);
        expect(() => parseStressManifest(
            JSON.stringify(manifest),
            "/etc/lantana/devices.json",
        )).toThrow("lokasi manifest");
    });

    it("removes only manifest devices and keeps unrelated account devices", () => {
        const manifest = makeManifest();
        const registry = DeviceRegistry.fromJSON([
            ...manifest.devices.map((expected) => ({
                deviceId: expected.deviceId,
                accountId: manifest.accountId,
                meta: { name: expected.name, group: expected.group, category: "stress-test" },
                createdAt: 123,
            })),
            {
                deviceId: "production-device-id",
                accountId: manifest.accountId,
                meta: { name: "production-device", group: "production", category: "production" },
                createdAt: 123,
            },
        ]);
        const unrelatedDeviceId = "production-device-id";

        assertStressDevices(registry, manifest);
        expect(removeStressDevices(registry, manifest)).toBe(2);
        expect(registry.get(manifest.accountId, unrelatedDeviceId)).toBeDefined();
        expect(removeStressDevices(registry, manifest)).toBe(0);
    });

    it("aborts cleanup before deleting anything if a manifest device was repurposed", () => {
        const manifest = makeManifest();
        const registry = DeviceRegistry.fromJSON(manifest.devices.map((expected, index) => ({
            deviceId: expected.deviceId,
            accountId: manifest.accountId,
            meta: {
                name: index === 0 ? "not-the-test-name" : expected.name,
                group: expected.group,
                category: "stress-test",
            },
            createdAt: 123,
        })));

        expect(() => removeStressDevices(registry, manifest)).toThrow("cleanup dihentikan");
        expect(registry.size).toBe(2);
    });

    it("removes only manifest schemes, preserving unrelated schemes", () => {
        const manifest = makeManifest();
        const schemes = SchemeRegistry.fromJSON([
            ...manifest.schemes.map((scheme) => ({
                ...scheme,
                ownerAccountId: manifest.accountId,
            })),
            {
                schemeId: 42,
                ownerAccountId: manifest.accountId,
                label: "production",
                type: "number" as const,
            },
        ]);

        assertStressSchemes(schemes, manifest);
        expect(removeStressSchemes(schemes, manifest)).toBe(2);
        expect(schemes.get(42)).toBeDefined();
        expect(removeStressSchemes(schemes, manifest)).toBe(0);
    });

    it("aborts scheme cleanup if a generated scheme was changed or reused", () => {
        const manifest = makeManifest();
        const schemes = SchemeRegistry.fromJSON(manifest.schemes.map((scheme, index) => ({
            ...scheme,
            ownerAccountId: manifest.accountId,
            label: index === 0 ? "repurposed-scheme" : scheme.label,
        })));

        expect(() => removeStressSchemes(schemes, manifest)).toThrow("cleanup dihentikan");
        expect(schemes.list()).toHaveLength(2);
    });

    it("accepts existing manifests without generated schemes", () => {
        const manifest = makeManifest();
        const { schemes: _schemes, ...previousManifest } = manifest;

        expect(parseStressManifest(
            JSON.stringify(previousManifest),
            stressManifestPath(runId),
        ).schemes).toEqual([]);
    });
});
