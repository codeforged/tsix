/**
 * control-panel-tree.ts — Model pohon navigasi Lantana Control Panel.
 *
 * Akun → Device / Scheme / Portable Dashboard → item dashboard. Dipisah dari
 * GUI supaya susunannya bisa diuji tanpa menjalankan window.
 *
 * (c) 2026 TSIX Project
 */

import type { TTreeNode } from "@tsix/pistachio";

export type SchemeRange = number | { from: number; to: number };
export type GroupKind = "devices" | "schemes" | "dashboards" | "monitor";

export interface AccountView {
    accountId: string;
    parentId: string | null;
    permissions: {
        allowedInjectSchemes: SchemeRange[];
        allowedQuerySchemes: SchemeRange[];
        allowedCommandDevices: string[];
    };
    hasAccessKey: boolean;
    children: number;
    dashboards: Array<{
        dashboardId: number;
        title: string;
        hasAccessKey: boolean;
    }>;
}

export interface DeviceView {
    accountId: string;
    deviceId: string;
    meta: {
        name?: string;
        city?: string;
        category?: string;
        group?: string;
    };
}

export interface SchemeView {
    schemeId: number;
    ownerAccountId: string;
    label: string;
    unit?: string;
    type: "number" | "boolean" | "string";
    min?: number;
    max?: number;
}

export interface DashboardItemView {
    id?: number | string;
    type: "text" | "radialGauge" | "lineChart" | "switchIndicator";
    title: string;
    icon: string;
    updateInterval: number;
    scrollAfter?: number;
    deviceId: string;
    schemeId: number;
}

export interface DashboardView {
    dashboardId: number;
    title: string;
    hasAccessKey: boolean;
    dashboardItems: DashboardItemView[];
    accountId: string;
}

export interface ServerView {
    fingerprint: string;
    ports: Record<string, { enabled: boolean }>;
    deviceCategories: Record<
        string,
        { label: string; icon?: string; description?: string }
    >;
}

export type NavKind =
    | "server"
    | "account"
    | "group"
    | "device"
    | "scheme"
    | "dashboard"
    | "item";

/** Data yang dibawa setiap baris pohon ke editor. */
export interface NavPayload {
    kind: NavKind;
    account?: AccountView;
    group?: GroupKind;
    device?: DeviceView;
    scheme?: SchemeView;
    dashboard?: DashboardView;
    item?: DashboardItemView;
    itemIndex?: number;
}

export interface ControlTreeData {
    accounts: AccountView[];
    devices: DeviceView[];
    schemes: SchemeView[];
    dashboards: DashboardView[];
}

/** Nama tampilan device: metadata `name`, atau potongan device ID. */
export function deviceTitle(device: DeviceView): string {
    return device.meta.name?.trim() || device.deviceId.slice(0, 8);
}

/**
 * Susun pohon: akun root (dan akun orphan) → grup Device/Scheme/Portable
 * Dashboard → entri → item dashboard. Sub-akun ditempatkan setelah grup.
 */
export function buildControlTree(data: ControlTreeData): TTreeNode[] {
    const known = new Set(data.accounts.map((account) => account.accountId));
    const roots = data.accounts
        .filter((account) => !account.parentId || !known.has(account.parentId))
        .sort((a, b) => a.accountId.localeCompare(b.accountId));
    const visited = new Set<string>();
    const nodes: TTreeNode[] = [
        {
            id: "server",
            label: "Status layanan",
            icon: "⌁",
            hint: "server",
            data: { kind: "server" } satisfies NavPayload,
        },
    ];

    const accountNode = (account: AccountView, depth: number): TTreeNode => {
        visited.add(account.accountId);
        const ownDevices = data.devices.filter(
            (device) => device.accountId === account.accountId,
        );
        const ownSchemes = data.schemes.filter(
            (scheme) => scheme.ownerAccountId === account.accountId,
        );
        const ownDashboards = data.dashboards.filter(
            (dashboard) => dashboard.accountId === account.accountId,
        );

        const children: TTreeNode[] = [
            {
                id: `grp:${account.accountId}:devices`,
                label: `Device (${ownDevices.length})`,
                icon: "▣",
                data: {
                    kind: "group",
                    group: "devices",
                    account,
                } satisfies NavPayload,
                children: ownDevices.map((device) => ({
                    id: `dev:${account.accountId}:${device.deviceId}`,
                    label: deviceTitle(device),
                    hint: device.meta.city || device.deviceId.slice(0, 8),
                    data: {
                        kind: "device",
                        account,
                        device,
                    } satisfies NavPayload,
                })),
            },
            {
                id: `grp:${account.accountId}:schemes`,
                label: `Scheme (${ownSchemes.length})`,
                icon: "◇",
                data: {
                    kind: "group",
                    group: "schemes",
                    account,
                } satisfies NavPayload,
                children: ownSchemes
                    .slice()
                    .sort((a, b) => a.schemeId - b.schemeId)
                    .map((scheme) => ({
                        id: `sch:${account.accountId}:${scheme.schemeId}`,
                        label: `${scheme.schemeId} · ${scheme.label}`,
                        hint: scheme.unit ?? "",
                        data: {
                            kind: "scheme",
                            account,
                            scheme,
                        } satisfies NavPayload,
                    })),
            },
            {
                id: `grp:${account.accountId}:dashboards`,
                label: `Portable Dashboard (${ownDashboards.length})`,
                icon: "▤",
                data: {
                    kind: "group",
                    group: "dashboards",
                    account,
                } satisfies NavPayload,
                children: ownDashboards.map((dashboard) => ({
                    id: `dash:${account.accountId}:${dashboard.dashboardId}`,
                    label: dashboard.title,
                    hint: `${dashboard.dashboardItems.length} item`,
                    data: {
                        kind: "dashboard",
                        account,
                        dashboard,
                    } satisfies NavPayload,
                    children: dashboard.dashboardItems.map((item, index) => ({
                        id: `item:${account.accountId}:${dashboard.dashboardId}:${index}`,
                        label: item.title,
                        icon: "•",
                        hint: item.type,
                        data: {
                            kind: "item",
                            account,
                            dashboard,
                            item,
                            itemIndex: index,
                        } satisfies NavPayload,
                    })),
                })),
            },
            {
                // Monitor selalu paling bawah: tampilan live seperti
                // `lantana-dashboard`, bukan editor data.
                id: `grp:${account.accountId}:monitor`,
                label: "Monitor",
                icon: "◫",
                hint: `${ownDevices.length} device`,
                data: {
                    kind: "group",
                    group: "monitor",
                    account,
                } satisfies NavPayload,
            },
        ];

        for (const child of data.accounts
            .filter(
                (candidate) =>
                    candidate.parentId === account.accountId &&
                    !visited.has(candidate.accountId),
            )
            .sort((a, b) => a.accountId.localeCompare(b.accountId))) {
            children.push(accountNode(child, depth + 1));
        }

        return {
            id: `acc:${account.accountId}`,
            label: account.accountId,
            icon: "◉",
            hint: account.hasAccessKey ? "key" : "",
            data: { kind: "account", account } satisfies NavPayload,
            children,
            expanded: depth === 0,
        };
    };

    for (const root of roots) {
        if (!visited.has(root.accountId)) nodes.push(accountNode(root, 0));
    }
    // Akun yang parent-nya hilang atau membentuk siklus tetap ditampilkan.
    for (const account of data.accounts) {
        if (!visited.has(account.accountId)) nodes.push(accountNode(account, 0));
    }
    return nodes;
}

export function findPayload(
    nodes: readonly TTreeNode[],
    nodeId: string,
): NavPayload | null {
    for (const node of nodes) {
        if (node.id === nodeId) return (node.data as NavPayload) ?? null;
        const nested = findPayload(node.children ?? [], nodeId);
        if (nested) return nested;
    }
    return null;
}

/** Id pohon untuk sebuah entri (dipakai saat data dimuat ulang). */
export function nodeIdOf(payload: NavPayload): string | null {
    switch (payload.kind) {
        case "server":
            return "server";
        case "account":
            return payload.account ? `acc:${payload.account.accountId}` : null;
        case "group":
            return payload.account && payload.group
                ? `grp:${payload.account.accountId}:${payload.group}`
                : null;
        case "device":
            return payload.device
                ? `dev:${payload.device.accountId}:${payload.device.deviceId}`
                : null;
        case "scheme":
            return payload.scheme
                ? `sch:${payload.scheme.ownerAccountId}:${payload.scheme.schemeId}`
                : null;
        case "dashboard":
            return payload.dashboard
                ? `dash:${payload.dashboard.accountId}:${payload.dashboard.dashboardId}`
                : null;
        default:
            return payload.dashboard && payload.itemIndex !== undefined
                ? `item:${payload.dashboard.accountId}:${payload.dashboard.dashboardId}:${payload.itemIndex}`
                : null;
    }
}
