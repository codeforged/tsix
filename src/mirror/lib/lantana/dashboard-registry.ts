/**
 * dashboard-registry.ts — Portable dashboard per akun (`/etc/lantana/dashboard.json`).
 *
 * Konfigurasi dashboard dan verifier key-nya dipisah dari accounts.json supaya
 * accounts.json murni berisi identitas, izin, dan kredensial akun. Key dashboard
 * mentah tidak pernah disimpan; yang disimpan hanya SHA-256 verifier.
 *
 * (c) 2026 TSIX Project — Lantana
 */

import * as crypto from "crypto";
import {
    DashboardRecord,
    PortableDashboard,
    PortableDashboardItem,
    PortableDashboardItemType,
} from "@tsix/lantana/lantana-core";

/** Panjang key dashboard (angka). 6 digit memudahkan input di perangkat non-programmer. */
const DASHBOARD_KEY_MIN = 100_000;
const DASHBOARD_KEY_MAX = 1_000_000;

export class DashboardRegistryError extends Error {}

/**
 * Key dashboard berupa 6 digit angka (100000–999999). Ruang kuncinya sengaja
 * kecil demi kemudahan pemakaian, jadi hanya cocok untuk jaringan tepercaya.
 */
function generateDashboardKey(): string {
    return String(crypto.randomInt(DASHBOARD_KEY_MIN, DASHBOARD_KEY_MAX));
}

/** Cetakan dashboard beserta pemiliknya. */
export interface DashboardMatch {
    accountId: string;
    dashboard: PortableDashboard;
}

const DASHBOARD_ITEM_TYPES = new Set<PortableDashboardItemType>([
    "text",
    "radialGauge",
    "lineChart",
    "switchIndicator",
]);

function normalizePortableDashboards(value: unknown): PortableDashboard[] {
    if (value === undefined || value === null) return [];
    const rawDashboards = Array.isArray(value) ? value : [value];
    const dashboardIds = new Set<number>();

    return rawDashboards.map((value, dashboardIndex) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new DashboardRegistryError(`portableDashboard[${dashboardIndex}] harus berupa object`);
        }

        const raw = value as Record<string, any>;
        if (!Number.isSafeInteger(raw.dashboardId) || raw.dashboardId <= 0) {
            throw new DashboardRegistryError(
                `portableDashboard[${dashboardIndex}].dashboardId harus integer positif`,
            );
        }
        if (dashboardIds.has(raw.dashboardId)) {
            throw new DashboardRegistryError(`dashboardId duplikat: ${raw.dashboardId}`);
        }
        dashboardIds.add(raw.dashboardId);
        if (Object.prototype.hasOwnProperty.call(raw, "accessKey")) {
            throw new DashboardRegistryError(
                `portableDashboard[${dashboardIndex}].accessKey mentah tidak boleh disimpan; gunakan accessKeyHash`,
            );
        }
        if (raw.title !== undefined && (typeof raw.title !== "string" || !raw.title.trim())) {
            throw new DashboardRegistryError(
                `portableDashboard[${dashboardIndex}].title harus berupa teks non-kosong`,
            );
        }
        if (
            raw.accessKeyHash !== undefined &&
            (typeof raw.accessKeyHash !== "string" || !/^[0-9a-f]{64}$/i.test(raw.accessKeyHash))
        ) {
            throw new DashboardRegistryError(
                `portableDashboard[${dashboardIndex}].accessKeyHash harus SHA-256 hex`,
            );
        }
        if (raw.dashboardItems !== undefined && !Array.isArray(raw.dashboardItems)) {
            throw new DashboardRegistryError(
                `portableDashboard[${dashboardIndex}].dashboardItems harus berupa array`,
            );
        }

        const dashboardItems = (raw.dashboardItems || []).map((item: any, index: number) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
                throw new DashboardRegistryError(`dashboardItems[${index}] harus berupa object`);
            }
            if (!DASHBOARD_ITEM_TYPES.has(item.type)) {
                throw new DashboardRegistryError(`dashboardItems[${index}].type tidak dikenal`);
            }
            if (typeof item.title !== "string" || !item.title.trim()) {
                throw new DashboardRegistryError(`dashboardItems[${index}].title wajib diisi`);
            }
            if (typeof item.icon !== "string" || !item.icon.trim()) {
                throw new DashboardRegistryError(`dashboardItems[${index}].icon wajib diisi`);
            }
            if (
                !Number.isInteger(item.updateInterval) ||
                item.updateInterval < 1 ||
                item.updateInterval > 86400
            ) {
                throw new DashboardRegistryError(
                    `dashboardItems[${index}].updateInterval harus 1..86400 detik`,
                );
            }
            if (
                item.scrollAfter !== undefined &&
                (!Number.isInteger(item.scrollAfter) || item.scrollAfter < 1 || item.scrollAfter > 500)
            ) {
                throw new DashboardRegistryError(`dashboardItems[${index}].scrollAfter harus 1..500`);
            }
            if (typeof item.deviceId !== "string" || !item.deviceId.trim()) {
                throw new DashboardRegistryError(`dashboardItems[${index}].deviceId wajib diisi`);
            }
            if (!Number.isInteger(item.schemeId) || item.schemeId < 1 || item.schemeId > 0xffff) {
                throw new DashboardRegistryError(`dashboardItems[${index}].schemeId harus 1..65535`);
            }
            if (
                item.id !== undefined &&
                typeof item.id !== "string" &&
                !(typeof item.id === "number" && Number.isSafeInteger(item.id))
            ) {
                throw new DashboardRegistryError(`dashboardItems[${index}].id harus string atau integer`);
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

function hashAccessKey(accessKey: string): string {
    return crypto.createHash("sha256").update(accessKey, "utf8").digest("hex");
}

export class DashboardRegistry {
    private records: Map<string, DashboardRecord> = new Map();

    hasAccount(accountId: string): boolean {
        return this.records.has(accountId);
    }

    listByAccount(accountId: string): PortableDashboard[] {
        return this.records.get(accountId)?.portableDashboard ?? [];
    }

    list(): DashboardRecord[] {
        return Array.from(this.records.values());
    }

    get(accountId: string, dashboardId: number | string): PortableDashboard | undefined {
        return this.listByAccount(accountId).find(
            (dashboard) => String(dashboard.dashboardId) === String(dashboardId),
        );
    }

    require(accountId: string, dashboardId: number | string): PortableDashboard {
        const dashboard = this.get(accountId, dashboardId);
        if (!dashboard) {
            throw new DashboardRegistryError(
                `dashboard tidak ditemukan: ${dashboardId} (akun ${accountId})`,
            );
        }
        return dashboard;
    }

    update(
        accountId: string,
        dashboardId: number | string,
        patch: Partial<Pick<PortableDashboard, "title" | "dashboardItems">>,
    ): PortableDashboard {
        const current = this.require(accountId, dashboardId);
        const [updated] = normalizePortableDashboards({ ...current, ...patch });
        Object.assign(current, updated);
        return current;
    }

    remove(accountId: string, dashboardId: number | string): void {
        const record = this.records.get(accountId);
        const index = record?.portableDashboard.findIndex(
            (dashboard) => String(dashboard.dashboardId) === String(dashboardId),
        );
        if (!record || index === undefined || index < 0) {
            throw new DashboardRegistryError(
                `dashboard tidak ditemukan: ${dashboardId} (akun ${accountId})`,
            );
        }
        record.portableDashboard.splice(index, 1);
        if (record.portableDashboard.length === 0) this.records.delete(accountId);
    }

    find(dashboardId: number | string): DashboardMatch | undefined {
        const id = String(dashboardId);
        for (const record of this.records.values()) {
            const dashboard = record.portableDashboard.find(
                (candidate) => String(candidate.dashboardId) === id,
            );
            if (dashboard) return { accountId: record.accountId, dashboard };
        }
        return undefined;
    }

    /**
     * Cari dashboard hanya dari access key (mode key-only tanpa dashboardId).
     * Key selalu dipilih unik global saat diterbitkan/dirotasi, jadi hasilnya
     * deterministik.
     */
    findByAccessKey(accessKey: string): DashboardMatch | undefined {
        if (!accessKey) return undefined;
        return this.findByHash(hashAccessKey(accessKey));
    }

    /** Cari dashboard dari prefix accessKeyHash (keyTag handshake PSK). */
    findByKeyTag(tag: string): DashboardMatch | undefined {
        const needle = tag.trim().toLowerCase();
        if (!needle) return undefined;
        for (const record of this.records.values()) {
            for (const dashboard of record.portableDashboard) {
                if (dashboard.accessKeyHash?.toLowerCase().startsWith(needle)) {
                    return { accountId: record.accountId, dashboard };
                }
            }
        }
        return undefined;
    }

    private findByHash(
        hash: string,
        exclude?: { accountId: string; dashboardId: number },
    ): DashboardMatch | undefined {
        const needle = hash.toLowerCase();
        for (const record of this.records.values()) {
            for (const dashboard of record.portableDashboard) {
                if (dashboard.accessKeyHash?.toLowerCase() !== needle) continue;
                const sameAsExcluded =
                    exclude !== undefined &&
                    record.accountId === exclude.accountId &&
                    dashboard.dashboardId === exclude.dashboardId;
                if (!sameAsExcluded) return { accountId: record.accountId, dashboard };
            }
        }
        return undefined;
    }

    /** Buat key 6 digit yang belum dipakai dashboard mana pun. */
    private uniqueDashboardKey(exclude?: {
        accountId: string;
        dashboardId: number;
    }): { accessKey: string; hash: string } {
        for (let attempt = 0; attempt < 100; attempt++) {
            const accessKey = generateDashboardKey();
            const hash = hashAccessKey(accessKey);
            if (!this.findByHash(hash, exclude)) return { accessKey, hash };
        }
        throw new DashboardRegistryError("gagal membuat key dashboard yang unik");
    }

    issueAccessKey(
        accountId: string,
        dashboardId?: number | string,
    ): { dashboardId: number; accessKey: string } {
        if (!accountId) throw new DashboardRegistryError("accountId wajib diisi");
        const id =
            dashboardId === undefined
                ? this.newDashboardId()
                : this.explicitDashboardId(dashboardId);
        const record = this.recordFor(accountId);
        const dashboard: PortableDashboard = {
            dashboardId: id,
            title: `Dashboard ${id}`,
            dashboardItems: [],
        };
        const { accessKey, hash } = this.uniqueDashboardKey();
        dashboard.accessKeyHash = hash;
        record.portableDashboard.push(dashboard);
        return { dashboardId: dashboard.dashboardId, accessKey };
    }

    rotateAccessKey(
        accountId: string,
        dashboardId: number | string,
    ): { dashboardId: number; accessKey: string } {
        const dashboard = this.require(accountId, dashboardId);
        const { accessKey, hash } = this.uniqueDashboardKey({
            accountId: accountId,
            dashboardId: dashboard.dashboardId,
        });
        dashboard.accessKeyHash = hash;
        return { dashboardId: dashboard.dashboardId, accessKey };
    }

    revokeAccessKey(accountId: string, dashboardId: number | string): void {
        delete this.require(accountId, dashboardId).accessKeyHash;
    }

    /**
     * HMAC proof yang terikat nonce challenge. Mengembalikan dashboard beserta
     * pemiliknya hanya bila verifier cocok.
     */
    verifyProof(
        dashboardId: number | string,
        nonce: string,
        proofHex: string,
    ): DashboardMatch | null {
        const match = this.find(dashboardId);
        const hash = match?.dashboard.accessKeyHash;
        if (!match || !hash || !nonce || !/^[0-9a-f]{64}$/i.test(proofHex)) return null;

        const expected = crypto
            .createHmac("sha256", Buffer.from(hash, "hex"))
            .update(`lantana-dashboard-v1\0${dashboardId}\0${nonce}`, "utf8")
            .digest();
        const actual = Buffer.from(proofHex, "hex");
        if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
            return null;
        }
        return match;
    }

    /**
     * Impor dashboard dari accounts.json versi lama. Entri dengan dashboardId
     * yang sudah terdaftar diabaikan agar migrasi aman dijalankan berulang.
     */
    importLegacy(accountId: string, value: unknown): void {
        const dashboards = normalizePortableDashboards(value);
        if (dashboards.length === 0) return;

        let record: DashboardRecord | undefined;
        for (const dashboard of dashboards) {
            if (this.find(dashboard.dashboardId)) continue;
            record ??= this.recordFor(accountId);
            record.portableDashboard.push(dashboard);
        }
    }

    private recordFor(accountId: string): DashboardRecord {
        let record = this.records.get(accountId);
        if (!record) {
            record = { accountId, portableDashboard: [], createdAt: Date.now() };
            this.records.set(accountId, record);
        }
        return record;
    }

    /** Validasi dashboardId pilihan pemanggil: positif dan belum dipakai akun mana pun. */
    private explicitDashboardId(value: number | string): number {
        const id = Number(value);
        if (!Number.isSafeInteger(id) || id <= 0) {
            throw new DashboardRegistryError("dashboardId harus integer positif");
        }
        if (this.find(id)) {
            throw new DashboardRegistryError(`dashboardId sudah dipakai: ${id}`);
        }
        return id;
    }

    private newDashboardId(): number {
        const used = new Set(
            this.list().flatMap((record) =>
                record.portableDashboard.map((dashboard) => dashboard.dashboardId),
            ),
        );
        let id: number;
        do {
            id = crypto.randomInt(1000, 0x7fffffff);
        } while (used.has(id));
        return id;
    }

    toJSON(): DashboardRecord[] {
        return this.list();
    }

    static fromJSON(records: DashboardRecord[] | undefined | null): DashboardRegistry {
        const reg = new DashboardRegistry();
        for (const rec of records || []) {
            if (!rec || typeof rec.accountId !== "string" || !rec.accountId.trim()) continue;
            const accountId = rec.accountId.trim();
            const dashboards = normalizePortableDashboards(rec.portableDashboard);
            const record = reg.recordFor(accountId);
            if (
                typeof rec.createdAt === "number" &&
                Number.isSafeInteger(rec.createdAt) &&
                rec.createdAt > 0
            ) {
                record.createdAt = rec.createdAt;
            }
            for (const dashboard of dashboards) {
                if (reg.find(dashboard.dashboardId)) {
                    throw new DashboardRegistryError(`dashboardId duplikat: ${dashboard.dashboardId}`);
                }
                record.portableDashboard.push(dashboard);
            }
        }
        return reg;
    }
}
