/**
 * account-manager.ts — Akun berjenjang (parent-child) + AccessKey.
 *
 * Aturan V2:
 *  - `accountId` adalah identitas otorisasi.
 *  - AccessKey diterbitkan per akun, dipakai banyak device milik akun itu.
 *  - Key mentah TIDAK disimpan: hanya salt + hash scrypt (verifier).
 *  - Tidak ada inheritance izin: child hanya punya izin yang diberikan.
 *
 * (c) 2026 TSIX Project — Lantana
 */

import * as crypto from "crypto";
import { derivePsk } from "@tsix/lantana/lantana-psk";
import {
    AccountRecord,
    EMPTY_PERMISSIONS,
    Permissions,
    PortableDashboard,
    PortableDashboardItem,
    PortableDashboardItemType,
    StoredCredential,
} from "@tsix/lantana/lantana-core";

const KEY_BYTES = 32;
const SCRYPT_KEYLEN = 32;

export class AccountError extends Error {}

function hashAccessKey(accessKey: string, saltHex: string): string {
    return crypto
        .scryptSync(accessKey, Buffer.from(saltHex, "hex"), SCRYPT_KEYLEN)
        .toString("hex");
}

const DASHBOARD_ITEM_TYPES = new Set<PortableDashboardItemType>([
    "text",
    "radialGauge",
    "lineChart",
    "switchIndicator",
]);

function normalizePortableDashboards(value: unknown): PortableDashboard[] | undefined {
    if (value === undefined || value === null) return undefined;
    const rawDashboards = Array.isArray(value) ? value : [value];
    const dashboardIds = new Set<number>();

    return rawDashboards.map((value, dashboardIndex) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new AccountError(`portableDashboard[${dashboardIndex}] harus berupa object`);
        }

        const raw = value as Record<string, any>;
        if (!Number.isSafeInteger(raw.dashboardId) || raw.dashboardId <= 0) {
            throw new AccountError(`portableDashboard[${dashboardIndex}].dashboardId harus integer positif`);
        }
        if (dashboardIds.has(raw.dashboardId)) {
            throw new AccountError(`dashboardId duplikat: ${raw.dashboardId}`);
        }
        dashboardIds.add(raw.dashboardId);
        if (Object.prototype.hasOwnProperty.call(raw, "accessKey")) {
            throw new AccountError(
                `portableDashboard[${dashboardIndex}].accessKey mentah tidak boleh disimpan; gunakan accessKeyHash`,
            );
        }
        if (raw.title !== undefined && (typeof raw.title !== "string" || !raw.title.trim())) {
            throw new AccountError(`portableDashboard[${dashboardIndex}].title harus berupa teks non-kosong`);
        }
        if (
            raw.accessKeyHash !== undefined &&
            (typeof raw.accessKeyHash !== "string" || !/^[0-9a-f]{64}$/i.test(raw.accessKeyHash))
        ) {
            throw new AccountError(`portableDashboard[${dashboardIndex}].accessKeyHash harus SHA-256 hex`);
        }
        if (raw.dashboardItems !== undefined && !Array.isArray(raw.dashboardItems)) {
            throw new AccountError(`portableDashboard[${dashboardIndex}].dashboardItems harus berupa array`);
        }

        const dashboardItems = (raw.dashboardItems || []).map((item: any, index: number) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
                throw new AccountError(`dashboardItems[${index}] harus berupa object`);
            }
            if (!DASHBOARD_ITEM_TYPES.has(item.type)) {
                throw new AccountError(`dashboardItems[${index}].type tidak dikenal`);
            }
            if (typeof item.title !== "string" || !item.title.trim()) {
                throw new AccountError(`dashboardItems[${index}].title wajib diisi`);
            }
            if (typeof item.icon !== "string" || !item.icon.trim()) {
                throw new AccountError(`dashboardItems[${index}].icon wajib diisi`);
            }
            if (
                !Number.isInteger(item.updateInterval) ||
                item.updateInterval < 1 ||
                item.updateInterval > 86400
            ) {
                throw new AccountError(`dashboardItems[${index}].updateInterval harus 1..86400 detik`);
            }
            if (
                item.scrollAfter !== undefined &&
                (!Number.isInteger(item.scrollAfter) || item.scrollAfter < 1 || item.scrollAfter > 500)
            ) {
                throw new AccountError(`dashboardItems[${index}].scrollAfter harus 1..500`);
            }
            if (typeof item.deviceId !== "string" || !item.deviceId.trim()) {
                throw new AccountError(`dashboardItems[${index}].deviceId wajib diisi`);
            }
            if (!Number.isInteger(item.schemeId) || item.schemeId < 1 || item.schemeId > 0xffff) {
                throw new AccountError(`dashboardItems[${index}].schemeId harus 1..65535`);
            }
            if (
                item.id !== undefined &&
                typeof item.id !== "string" &&
                !(typeof item.id === "number" && Number.isSafeInteger(item.id))
            ) {
                throw new AccountError(`dashboardItems[${index}].id harus string atau integer`);
            }

            return {
                ...(item.id !== undefined ? { id: item.id } : {}),
                type: item.type as PortableDashboardItemType,
                title: item.title.trim(),
                icon: item.icon.trim(),
                updateInterval: item.updateInterval,
                ...(item.scrollAfter !== undefined ? { scrollAfter: item.scrollAfter } : {}),
                deviceId: item.deviceId.trim(),
                schemeId: item.schemeId,
            } satisfies PortableDashboardItem;
        });

        return {
            dashboardId: raw.dashboardId,
            title: typeof raw.title === "string" ? raw.title.trim() : `Dashboard ${raw.dashboardId}`,
            ...(raw.accessKeyHash ? { accessKeyHash: raw.accessKeyHash.toLowerCase() } : {}),
            dashboardItems,
        };
    });
}

/** Normalisasi izin: buang duplikat & entri tidak valid. */
export function normalizePermissions(input?: Partial<Permissions> | null): Permissions {
    const ranges = (list: any): Permissions["allowedInjectSchemes"] => {
        if (!Array.isArray(list)) return [];
        const out: Permissions["allowedInjectSchemes"] = [];
        for (const entry of list) {
            if (typeof entry === "number" && Number.isInteger(entry) && entry > 0) {
                out.push(entry);
            } else if (
                entry &&
                typeof entry === "object" &&
                Number.isInteger(entry.from) &&
                Number.isInteger(entry.to) &&
                entry.from > 0 &&
                entry.to >= entry.from
            ) {
                out.push({ from: entry.from, to: entry.to });
            }
        }
        return out;
    };

    const devices = Array.isArray(input?.allowedCommandDevices)
        ? Array.from(
              new Set(
                  input!.allowedCommandDevices
                      .filter((d): d is string => typeof d === "string")
                      .map((d) => d.trim())
                      .filter(Boolean),
              ),
          )
        : [];

    return {
        allowedInjectSchemes: ranges(input?.allowedInjectSchemes),
        allowedQuerySchemes: ranges(input?.allowedQuerySchemes),
        allowedCommandDevices: devices,
    };
}

export class AccountManager {
    private accounts: Map<string, AccountRecord> = new Map();

    /** Buat akun root (parentId = null). */
    createRoot(accountId: string, permissions?: Partial<Permissions>): AccountRecord {
        return this.create(accountId, null, permissions);
    }

    /** Buat akun child di bawah parent yang sudah ada. */
    createChild(
        parentId: string,
        accountId: string,
        permissions?: Partial<Permissions>,
    ): AccountRecord {
        if (!parentId) throw new AccountError("parentId wajib diisi");
        return this.create(accountId, parentId, permissions);
    }

    private create(
        accountId: string,
        parentId: string | null,
        permissions?: Partial<Permissions>,
    ): AccountRecord {
        const id = (accountId || "").trim();
        if (!id) throw new AccountError("accountId wajib diisi");
        if (this.accounts.has(id)) throw new AccountError(`akun sudah ada: ${id}`);
        if (parentId !== null && !this.accounts.has(parentId)) {
            throw new AccountError(`parent tidak ditemukan: ${parentId}`);
        }

        const record: AccountRecord = {
            accountId: id,
            parentId,
            permissions: normalizePermissions(permissions),
            credential: null,
            portableDashboard: undefined,
            createdAt: Date.now(),
        };
        this.accounts.set(id, record);
        return record;
    }

    get(accountId: string): AccountRecord | undefined {
        return this.accounts.get(accountId);
    }

    require(accountId: string): AccountRecord {
        const acc = this.accounts.get(accountId);
        if (!acc) throw new AccountError(`akun tidak ditemukan: ${accountId}`);
        return acc;
    }

    has(accountId: string): boolean {
        return this.accounts.has(accountId);
    }

    list(): AccountRecord[] {
        return Array.from(this.accounts.values());
    }

    listChildren(parentId: string): AccountRecord[] {
        return this.list().filter((a) => a.parentId === parentId);
    }

    /**
     * Terbitkan AccessKey baru (32 byte hex 64 karakter) dan simpan verifier-nya.
     * Key mentah hanya dikembalikan sekali di sini; tidak bisa dibaca lagi.
     */
    issueAccessKey(accountId: string): string {
        const acc = this.require(accountId);
        const accessKey = crypto.randomBytes(KEY_BYTES).toString("hex");
        acc.credential = this.buildCredential(accessKey);
        return accessKey;
    }

    /** Rotasi = terbitkan key baru, key lama langsung tidak berlaku. */
    rotateAccessKey(accountId: string): string {
        return this.issueAccessKey(accountId);
    }

    /** Cabut kredensial; akun tetap ada tetapi tidak bisa autentikasi. */
    revokeAccessKey(accountId: string): void {
        this.require(accountId).credential = null;
    }

    issuePortableDashboardAccessKey(accountId: string): {
        dashboardId: number;
        accessKey: string;
    } {
        const account = this.require(accountId);
        const dashboardId = this.newDashboardId();
        const dashboard: PortableDashboard = {
            dashboardId,
            title: `Dashboard ${dashboardId}`,
            dashboardItems: [],
        };
        const accessKey = crypto.randomBytes(KEY_BYTES).toString("hex");
        dashboard.accessKeyHash = crypto.createHash("sha256").update(accessKey, "utf8").digest("hex");
        account.portableDashboard ??= [];
        account.portableDashboard.push(dashboard);
        return { dashboardId: dashboard.dashboardId, accessKey };
    }

    rotatePortableDashboardAccessKey(accountId: string, dashboardId: number | string): {
        dashboardId: number;
        accessKey: string;
    } {
        const dashboard = this.requirePortableDashboard(accountId, dashboardId);
        const accessKey = crypto.randomBytes(KEY_BYTES).toString("hex");
        dashboard.accessKeyHash = crypto.createHash("sha256").update(accessKey, "utf8").digest("hex");
        return { dashboardId: dashboard.dashboardId, accessKey };
    }

    revokePortableDashboardAccessKey(accountId: string, dashboardId: number | string): void {
        const dashboard = this.requirePortableDashboard(accountId, dashboardId);
        delete dashboard.accessKeyHash;
    }

    private requirePortableDashboard(
        accountId: string,
        dashboardId: number | string,
    ): PortableDashboard {
        const dashboard = this.getPortableDashboard(accountId, dashboardId);
        if (!dashboard) {
            throw new AccountError(`dashboard tidak ditemukan: ${dashboardId} (akun ${accountId})`);
        }
        return dashboard;
    }

    findPortableDashboard(dashboardId: number | string): AccountRecord | undefined {
        const id = String(dashboardId);
        return this.list().find((account) =>
            account.portableDashboard?.some((dashboard) => String(dashboard.dashboardId) === id),
        );
    }

    getPortableDashboard(accountId: string, dashboardId: number | string): PortableDashboard | undefined {
        return this.require(accountId).portableDashboard?.find(
            (dashboard) => String(dashboard.dashboardId) === String(dashboardId),
        );
    }

    verifyPortableDashboardProof(
        dashboardId: number | string,
        nonce: string,
        proofHex: string,
    ): AccountRecord | null {
        const account = this.findPortableDashboard(dashboardId);
        const dashboard = account?.portableDashboard?.find(
            (candidate) => String(candidate.dashboardId) === String(dashboardId),
        );
        const hash = dashboard?.accessKeyHash;
        if (!account || !dashboard || !hash || !nonce || !/^[0-9a-f]{64}$/i.test(proofHex)) {
            return null;
        }
        const expected = crypto
            .createHmac("sha256", Buffer.from(hash, "hex"))
            .update(`lantana-dashboard-v1\0${dashboardId}\0${nonce}`, "utf8")
            .digest();
        const actual = Buffer.from(proofHex, "hex");
        if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
        return account;
    }

    hasAccessKey(accountId: string): boolean {
        return !!this.accounts.get(accountId)?.credential;
    }

    /** Verifikasi AccessKey terhadap verifier tersimpan (timing-safe). */
    verifyAccessKey(accountId: string, accessKey: string): boolean {
        const acc = this.accounts.get(accountId);
        if (!acc || !acc.credential || !accessKey) return false;
        const candidate = hashAccessKey(accessKey, acc.credential.salt);
        const stored = Buffer.from(acc.credential.hash, "hex");
        const found = Buffer.from(candidate, "hex");
        if (stored.length !== found.length) return false;
        return crypto.timingSafeEqual(stored, found);
    }

    setPermissions(accountId: string, permissions: Partial<Permissions>): Permissions {
        const acc = this.require(accountId);
        acc.permissions = normalizePermissions(permissions);
        return acc.permissions;
    }

    /** Apakah `actorId` boleh mengelola `targetId` (dirinya sendiri atau keturunannya). */
    canManage(actorId: string, targetId: string): boolean {
        if (!this.accounts.has(actorId)) return false;
        let current = this.accounts.get(targetId);
        while (current && current.parentId !== null) {
            if (current.parentId === actorId) return true;
            current = this.accounts.get(current.parentId);
        }
        return false;
    }

    remove(accountId: string): void {
        if (this.listChildren(accountId).length > 0) {
            throw new AccountError(`akun masih punya child: ${accountId}`);
        }
        if (!this.accounts.delete(accountId)) {
            throw new AccountError(`akun tidak ditemukan: ${accountId}`);
        }
    }

    private buildCredential(accessKey: string): StoredCredential {
        const salt = crypto.randomBytes(16).toString("hex");
        return {
            salt,
            hash: hashAccessKey(accessKey, salt),
            // Dipakai handshake PSK (ESP8266): SHA-256 dari string key.
            psk: derivePsk(accessKey).toString("hex"),
            issuedAt: Date.now(),
        };
    }

    private newDashboardId(): number {
        const used = new Set(
            this.list().flatMap((account) => account.portableDashboard?.map((dashboard) => dashboard.dashboardId) ?? []),
        );
        let id: number;
        do {
            id = crypto.randomInt(1000, 0x7fffffff);
        } while (used.has(id));
        return id;
    }

    /** PSK untuk handshake mode "psk"; null bila akun belum punya kredensial. */
    getPsk(accountId: string): Buffer | null {
        const pskHex = this.accounts.get(accountId)?.credential?.psk;
        if (!pskHex) return null;
        return Buffer.from(pskHex, "hex");
    }

    toJSON(): AccountRecord[] {
        return this.list();
    }

    static fromJSON(records: AccountRecord[] | undefined | null): AccountManager {
        const mgr = new AccountManager();
        const dashboardIds = new Set<number>();
        for (const rec of records || []) {
            if (!rec || typeof rec.accountId !== "string") continue;
            const portableDashboards = normalizePortableDashboards(rec.portableDashboard);
            for (const dashboard of portableDashboards ?? []) {
                if (dashboardIds.has(dashboard.dashboardId)) {
                    throw new AccountError(`dashboardId duplikat: ${dashboard.dashboardId}`);
                }
                dashboardIds.add(dashboard.dashboardId);
            }
            mgr.accounts.set(rec.accountId, {
                accountId: rec.accountId,
                parentId: rec.parentId ?? null,
                permissions: normalizePermissions(rec.permissions),
                credential: rec.credential
                    ? {
                          salt: rec.credential.salt,
                          hash: rec.credential.hash,
                          psk: rec.credential.psk,
                          issuedAt: rec.credential.issuedAt,
                      }
                    : null,
                portableDashboard: portableDashboards,
                createdAt: rec.createdAt || Date.now(),
            });
        }
        return mgr;
    }
}

export { EMPTY_PERMISSIONS };
