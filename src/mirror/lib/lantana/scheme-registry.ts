/**
 * scheme-registry.ts — Definisi scheme dan validasi nilai bacaan.
 *
 * schemeId unik global dan dimiliki satu akun (`ownerAccountId`). Akun lain
 * hanya boleh memakai scheme jika diberi izin eksplisit lewat permission policy.
 *
 * (c) 2026 TSIX Project — Lantana
 */

import {
    LantanaError,
    ReadingValue,
    SchemeDef,
    SchemeType,
} from "@tsix/lantana/lantana-core";

export class SchemeRegistryError extends Error {}

export interface ValidationResult {
    ok: boolean;
    error?: LantanaError;
    message?: string;
}

function isSchemeType(value: any): value is SchemeType {
    return value === "number" || value === "boolean" || value === "string";
}

export class SchemeRegistry {
    private schemes: Map<number, SchemeDef> = new Map();

    add(def: SchemeDef): SchemeDef {
        if (!Number.isInteger(def.schemeId) || def.schemeId <= 0 || def.schemeId > 0xffff) {
            throw new SchemeRegistryError("schemeId harus 1..65535");
        }
        if (this.schemes.has(def.schemeId)) {
            throw new SchemeRegistryError(`scheme sudah ada: ${def.schemeId}`);
        }
        if (!def.ownerAccountId) throw new SchemeRegistryError("ownerAccountId wajib diisi");
        if (!isSchemeType(def.type)) throw new SchemeRegistryError(`tipe scheme tidak valid: ${def.type}`);
        if (!def.label || !def.label.trim()) throw new SchemeRegistryError("label wajib diisi");

        const record: SchemeDef = {
            schemeId: def.schemeId,
            ownerAccountId: def.ownerAccountId,
            label: def.label.trim(),
            unit: def.unit,
            type: def.type,
            min: def.min,
            max: def.max,
        };
        this.schemes.set(record.schemeId, record);
        return record;
    }

    get(schemeId: number): SchemeDef | undefined {
        return this.schemes.get(schemeId);
    }

    has(schemeId: number): boolean {
        return this.schemes.has(schemeId);
    }

    /** Hanya pemilik scheme yang boleh mengubahnya. */
    update(ownerAccountId: string, schemeId: number, patch: Partial<Omit<SchemeDef, "schemeId" | "ownerAccountId">>): SchemeDef {
        const rec = this.schemes.get(schemeId);
        if (!rec) throw new SchemeRegistryError(`scheme tidak ditemukan: ${schemeId}`);
        if (rec.ownerAccountId !== ownerAccountId) {
            throw new SchemeRegistryError(`akun bukan pemilik scheme ${schemeId}`);
        }
        if (patch.type !== undefined && !isSchemeType(patch.type)) {
            throw new SchemeRegistryError(`tipe scheme tidak valid: ${patch.type}`);
        }
        if (patch.label !== undefined && !patch.label.trim()) {
            throw new SchemeRegistryError("label tidak boleh kosong");
        }

        const next: SchemeDef = { ...rec, ...patch };
        if (next.min !== undefined && next.max !== undefined && next.min > next.max) {
            throw new SchemeRegistryError("min tidak boleh lebih besar dari max");
        }
        this.schemes.set(schemeId, next);
        return next;
    }

    remove(ownerAccountId: string, schemeId: number): void {
        const rec = this.schemes.get(schemeId);
        if (!rec) throw new SchemeRegistryError(`scheme tidak ditemukan: ${schemeId}`);
        if (rec.ownerAccountId !== ownerAccountId) {
            throw new SchemeRegistryError(`akun bukan pemilik scheme ${schemeId}`);
        }
        this.schemes.delete(schemeId);
    }

    list(ownerAccountId?: string): SchemeDef[] {
        const all = Array.from(this.schemes.values()).sort((a, b) => a.schemeId - b.schemeId);
        return ownerAccountId ? all.filter((s) => s.ownerAccountId === ownerAccountId) : all;
    }

    /**
     * Validasi tipe dan rentang nilai terhadap definisi scheme.
     * Otorisasi BUKAN tanggung jawab modul ini.
     */
    validate(schemeId: number, value: ReadingValue): ValidationResult {
        const def = this.schemes.get(schemeId);
        if (!def) {
            return { ok: false, error: LantanaError.UNKNOWN_SCHEME, message: `scheme ${schemeId} tidak dikenal` };
        }

        if (def.type === "number") {
            if (typeof value !== "number" || !Number.isFinite(value)) {
                return {
                    ok: false,
                    error: LantanaError.INVALID_VALUE,
                    message: `scheme ${schemeId} butuh angka`,
                };
            }
            if (def.min !== undefined && value < def.min) {
                return {
                    ok: false,
                    error: LantanaError.INVALID_VALUE,
                    message: `scheme ${schemeId} di bawah min (${def.min})`,
                };
            }
            if (def.max !== undefined && value > def.max) {
                return {
                    ok: false,
                    error: LantanaError.INVALID_VALUE,
                    message: `scheme ${schemeId} di atas max (${def.max})`,
                };
            }
            return { ok: true };
        }

        if (def.type === "boolean") {
            return typeof value === "boolean"
                ? { ok: true }
                : {
                      ok: false,
                      error: LantanaError.INVALID_VALUE,
                      message: `scheme ${schemeId} butuh boolean`,
                  };
        }

        return typeof value === "string" && value.length > 0
            ? { ok: true }
            : {
                  ok: false,
                  error: LantanaError.INVALID_VALUE,
                  message: `scheme ${schemeId} butuh string`,
              };
    }

    toJSON(): SchemeDef[] {
        return this.list();
    }

    static fromJSON(records: SchemeDef[] | undefined | null): SchemeRegistry {
        const reg = new SchemeRegistry();
        for (const rec of records || []) {
            if (!rec || !Number.isInteger(rec.schemeId) || !isSchemeType(rec.type)) continue;
            reg.schemes.set(rec.schemeId, {
                schemeId: rec.schemeId,
                ownerAccountId: rec.ownerAccountId,
                label: rec.label || `scheme-${rec.schemeId}`,
                unit: rec.unit,
                type: rec.type,
                min: rec.min,
                max: rec.max,
            });
        }
        return reg;
    }
}
