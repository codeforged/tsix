/**
 * permission-policy.ts — Satu tempat pemeriksaan hak akses Lantana V2.
 *
 * Dipakai bersama oleh jalur ingest MQTNL, query IPC/HTTP, dan command ke
 * device supaya aturannya tidak bercabang antar komponen.
 *
 * Aturan:
 *  - Pemilik scheme selalu boleh memakai scheme-nya.
 *  - Akun lain hanya boleh jika scheme ada di daftar/rentang izin.
 *  - Tidak ada inheritance izin dari parent ke child.
 *
 * (c) 2026 TSIX Project — Lantana
 */

import { AccountManager } from "@tsix/lantana/account-manager";
import { SchemeRegistry } from "@tsix/lantana/scheme-registry";
import {
    AccountRecord,
    LantanaError,
    schemeInList,
} from "@tsix/lantana/lantana-core";

export interface PolicyResult {
    ok: boolean;
    error?: LantanaError;
    message?: string;
}

const ALLOW: PolicyResult = { ok: true };

export class PermissionPolicy {
    constructor(
        private accounts: AccountManager,
        private schemes: SchemeRegistry,
    ) {}

    private resolve(accountId: string): AccountRecord | null {
        return this.accounts.get(accountId) || null;
    }

    private ownsScheme(accountId: string, schemeId: number): boolean {
        return this.schemes.get(schemeId)?.ownerAccountId === accountId;
    }

    canInject(accountId: string, schemeId: number): PolicyResult {
        const acc = this.resolve(accountId);
        if (!acc) {
            return {
                ok: false,
                error: LantanaError.UNKNOWN_ACCOUNT,
                message: `akun tidak dikenal: ${accountId}`,
            };
        }
        if (this.ownsScheme(accountId, schemeId)) return ALLOW;
        if (schemeInList(acc.permissions.allowedInjectSchemes, schemeId)) return ALLOW;
        return {
            ok: false,
            error: LantanaError.UNAUTHORIZED_INJECT,
            message: `akun ${accountId} tidak berhak inject scheme ${schemeId}`,
        };
    }

    canQuery(accountId: string, schemeId: number): PolicyResult {
        const acc = this.resolve(accountId);
        if (!acc) {
            return {
                ok: false,
                error: LantanaError.UNKNOWN_ACCOUNT,
                message: `akun tidak dikenal: ${accountId}`,
            };
        }
        if (this.ownsScheme(accountId, schemeId)) return ALLOW;
        if (schemeInList(acc.permissions.allowedQuerySchemes, schemeId)) return ALLOW;
        return {
            ok: false,
            error: LantanaError.UNAUTHORIZED_QUERY,
            message: `akun ${accountId} tidak berhak query scheme ${schemeId}`,
        };
    }

    canCommand(accountId: string, deviceId: string): PolicyResult {
        const acc = this.resolve(accountId);
        if (!acc) {
            return {
                ok: false,
                error: LantanaError.UNKNOWN_ACCOUNT,
                message: `akun tidak dikenal: ${accountId}`,
            };
        }
        if (acc.permissions.allowedCommandDevices.includes(deviceId)) return ALLOW;
        return {
            ok: false,
            error: LantanaError.UNAUTHORIZED_COMMAND,
            message: `akun ${accountId} tidak berhak memberi command ke ${deviceId}`,
        };
    }

    /** Filter daftar scheme agar hanya yang boleh dibaca akun. */
    filterQueryable(accountId: string, schemeIds: number[]): number[] {
        return schemeIds.filter((id) => this.canQuery(accountId, id).ok);
    }
}
