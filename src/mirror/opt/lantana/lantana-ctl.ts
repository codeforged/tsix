/**
 * lantana-ctl.ts — Manajemen akun, device, scheme, dan AccessKey.
 *
 * Usage:
 *   lantana-ctl account create-root <accountId>
 *   lantana-ctl account create-child <parentId> <accountId>
 *   lantana-ctl account list
 *   lantana-ctl account key-issue <accountId>
 *   lantana-ctl account key-rotate <accountId>
 *   lantana-ctl account key-revoke <accountId>
 *   lantana-ctl account permissions <accountId> [--inject 100,201-205]
 *                                   [--query 100-103] [--command dev1,dev2]
 *   lantana-ctl dashboard key-issue <accountId>
 *   lantana-ctl dashboard key-rotate <accountId> <dashboardId>
 *   lantana-ctl dashboard key-revoke <accountId> <dashboardId>
 *   lantana-ctl dashboard show <accountId> [dashboardId]
 *   lantana-ctl device add <accountId> [--name N] [--city C]
 *                                      [--category C] [--group G]
 *   lantana-ctl device list <accountId>
 *   lantana-ctl device remove <accountId> <deviceId>
 *   lantana-ctl scheme add <accountId> <schemeId> --label L [--unit U]
 *                               [--type number|boolean|string] [--min N] [--max N]
 *   lantana-ctl scheme list [accountId]
 *   lantana-ctl scheme remove <accountId> <schemeId>
 *
 * AccessKey hanya dicetak sekali saat diterbitkan/dirotasi; yang tersimpan
 * hanyalah verifier.
 *
 * (c) 2026 TSIX Project — Lantana
 */

import { Program, std, shell } from "@tsix/Application";
import { loadState, saveState } from "@tsix/lantana/lantana-store";
import { loadOrCreateServerKey } from "@tsix/lantana/lantana-keys";
import {
    AccountRecord,
    LANTANA_UUID,
    DeviceMeta,
    PortableDashboard,
    PortableDashboardItem,
    PortableDashboardItemType,
    SchemeRange,
    SchemeDef,
    SchemeType,
} from "@tsix/lantana/lantana-core";
import { loadConfig } from "@tsix/lantana/lantana-config";

const TAG = "lantana-ctl";

export const main = Program(async (args: string[]) => {
    const jsonMode = args.includes("--json");
    const commandArgs = args.filter((arg) => arg !== "--json");
    const [scope, action, ...rest] = commandArgs;
    let jsonData: unknown = null;
    let jsonError: string | null = null;
    const print = async (text: string): Promise<void> => {
        if (!jsonMode) await std.print(text);
    };

    if (!scope || commandArgs.includes("--help") || commandArgs.includes("-h")) {
        if (jsonMode) {
            await std.print(JSON.stringify({ version: 1, ok: true, data: { usage: usage() } }) + "\n");
        } else {
            await std.print(usage());
        }
        return;
    }

    try {
        const state = await loadState();

        switch (`${scope} ${action}`) {
            case "account create-root": {
                const id = requireArg(rest[0], "accountId");
                const account = state.accounts.createRoot(id, parsePermissions(rest));
                jsonData = publicAccount(account);
                await commit(state);
                await print(`Akun root dibuat: ${id}\n`);
                await print(`Terbitkan AccessKey: lantana-ctl account key-issue ${id}\n`);
                return;
            }

            case "account create-child": {
                const parentId = requireArg(rest[0], "parentId");
                const id = requireArg(rest[1], "accountId");
                const account = state.accounts.createChild(parentId, id, parsePermissions(rest));
                jsonData = publicAccount(account);
                await commit(state);
                await print(`Akun child dibuat: ${id} (parent ${parentId})\n`);
                await print(`Terbitkan AccessKey: lantana-ctl account key-issue ${id}\n`);
                return;
            }

            case "account list": {
                const accounts = state.accounts.list();
                jsonData = accounts.map((acc) => ({
                    ...publicAccount(acc),
                    children: state.accounts.listChildren(acc.accountId).length,
                    dashboards: state.dashboards
                        .listByAccount(acc.accountId)
                        .map(publicDashboard),
                }));
                if (accounts.length === 0) {
                    await print("Belum ada akun.\n");
                    return;
                }
                for (const acc of accounts) {
                    const perms = acc.permissions;
                    const dashboards = state.dashboards.listByAccount(acc.accountId);
                    await print(
                        `${acc.accountId}  parent=${acc.parentId ?? "-"}  key=${acc.credential ? "ada" : "tidak"}\n` +
                            `  inject=${formatRanges(perms.allowedInjectSchemes)}  ` +
                            `query=${formatRanges(perms.allowedQuerySchemes)}  ` +
                            `command=${perms.allowedCommandDevices.join(",") || "-"}\n` +
                            `  dashboard=${dashboards
                                .map(
                                    (dashboard) =>
                                        `${dashboard.dashboardId}:"${dashboard.title}":${dashboard.accessKeyHash ? "key" : "tanpa-key"}`,
                                )
                                .join(",") || "-"}\n`,
                    );
                }
                return;
            }

            case "account key-issue":
            case "account key-rotate": {
                const id = requireArg(rest[0], "accountId");
                const key =
                    action === "key-issue"
                        ? state.accounts.issueAccessKey(id)
                        : state.accounts.rotateAccessKey(id);
                jsonData = { accountId: id, accessKey: key, oneTime: true };
                await commit(state);
                await print(`AccessKey untuk ${id} (simpan di firmware, tidak ditampilkan lagi):\n`);
                await print(`  ${key}\n`);
                return;
            }

            case "account key-revoke": {
                const id = requireArg(rest[0], "accountId");
                state.accounts.revokeAccessKey(id);
                jsonData = { accountId: id, hasAccessKey: false };
                await commit(state);
                await print(`AccessKey ${id} dicabut. Semua device akun ini tidak bisa autentikasi.\n`);
                return;
            }

            case "account permissions": {
                const id = requireArg(rest[0], "accountId");
                const permissions = state.accounts.setPermissions(id, parsePermissions(rest));
                jsonData = { accountId: id, permissions };
                await commit(state);
                await print(`Izin ${id} diperbarui.\n`);
                return;
            }

            case "account remove": {
                const id = requireArg(rest[0], "accountId");
                if (state.devices.listByAccount(id).length > 0) {
                    throw new Error(`akun masih memiliki device: ${id}`);
                }
                if (state.schemes.list(id).length > 0) {
                    throw new Error(`akun masih memiliki scheme: ${id}`);
                }
                if (state.dashboards.listByAccount(id).length > 0) {
                    throw new Error(`akun masih memiliki dashboard: ${id}`);
                }
                state.accounts.remove(id);
                jsonData = { accountId: id, removed: true };
                await commit(state);
                await print(`Akun ${id} dihapus.\n`);
                return;
            }

            case "server fingerprint": {
                const key = await loadOrCreateServerKey();
                jsonData = { fingerprint: key.fingerprint };
                await print(`Fingerprint public key server:\n  ${key.fingerprint}\n`);
                return;
            }

            case "server status": {
                const [key, config] = await Promise.all([
                    loadOrCreateServerKey(),
                    loadConfig(),
                ]);
                jsonData = {
                    fingerprint: key.fingerprint,
                    ports: config.ports,
                    deviceCategories: config.deviceCategories,
                };
                await print(`Fingerprint public key server:\n  ${key.fingerprint}\n`);
                await print(`Port layanan: ${Object.keys(config.ports).join(", ") || "-"}\n`);
                return;
            }

            case "dashboard key-issue":
            case "dashboard key-rotate": {
                const id = requireArg(rest[0], "accountId");
                if (!state.accounts.has(id)) throw new Error(`akun tidak ditemukan: ${id}`);
                const issued =
                    action === "key-issue"
                        ? state.dashboards.issueAccessKey(id)
                        : state.dashboards.rotateAccessKey(
                              id,
                              requireArg(rest[1], "dashboardId"),
                          );
                const title = flag(rest, "--title");
                if (title) state.dashboards.update(id, issued.dashboardId, { title });
                const dashboard = state.dashboards.get(id, issued.dashboardId);
                jsonData = {
                    accountId: id,
                    dashboardId: issued.dashboardId,
                    title: dashboard?.title,
                    dashboardAccessKey: issued.accessKey,
                    oneTime: true,
                };
                await commit(state);
                await print(`Dashboard untuk akun ${id}:\n`);
                await print(`  dashboardId: ${issued.dashboardId}\n`);
                await print(`  title: ${dashboard?.title ?? `Dashboard ${issued.dashboardId}`}\n`);
                await print("  dashboardAccessKey (simpan; hanya ditampilkan sekali):\n");
                await print(`  ${issued.accessKey}\n`);
                await print("  alamat server MQTNL: tsix:1001 (default)\n");
                return;
            }

            case "dashboard key-revoke": {
                const id = requireArg(rest[0], "accountId");
                if (!state.accounts.has(id)) throw new Error(`akun tidak ditemukan: ${id}`);
                const dashboardId = requireArg(rest[1], "dashboardId");
                state.dashboards.revokeAccessKey(id, dashboardId);
                jsonData = { accountId: id, dashboardId: Number(dashboardId), hasAccessKey: false };
                await commit(state);
                await print(`Dashboard key ${dashboardId} akun ${id} dicabut.\n`);
                return;
            }

            case "dashboard show": {
                const id = requireArg(rest[0], "accountId");
                if (!state.accounts.has(id)) throw new Error(`akun tidak ditemukan: ${id}`);
                const dashboards = state.dashboards.listByAccount(id);
                const selected = rest[1]
                    ? dashboards.filter((dashboard) => String(dashboard.dashboardId) === rest[1])
                    : dashboards;
                jsonData = selected.map(publicDashboard);
                if (selected.length === 0) {
                    await print(`Portable dashboard belum dikonfigurasi untuk ${id}.\n`);
                    return;
                }
                for (const dashboard of selected) {
                    await print(
                        `dashboardId=${dashboard.dashboardId}  title="${dashboard.title}"  ` +
                            `key=${dashboard.accessKeyHash ? "ada" : "tidak"}  ` +
                            `items=${dashboard.dashboardItems.length}\n`,
                    );
                }
                return;
            }

            case "dashboard update": {
                const accountId = requireArg(rest[0], "accountId");
                const dashboardId = requireArg(rest[1], "dashboardId");
                const title = requireArg(flag(rest, "--title"), "--title");
                const dashboard = state.dashboards.update(accountId, dashboardId, { title });
                jsonData = publicDashboard(dashboard);
                await commit(state);
                await print(`Dashboard ${dashboardId} diperbarui.\n`);
                return;
            }

            case "dashboard delete": {
                const accountId = requireArg(rest[0], "accountId");
                const dashboardId = requireArg(rest[1], "dashboardId");
                state.dashboards.remove(accountId, dashboardId);
                jsonData = { accountId, dashboardId: Number(dashboardId), removed: true };
                await commit(state);
                await print(`Dashboard ${dashboardId} dihapus dari ${accountId}.\n`);
                return;
            }

            case "dashboard item-set": {
                const accountId = requireArg(rest[0], "accountId");
                const dashboardId = requireArg(rest[1], "dashboardId");
                const indexArg = requireArg(rest[2], "itemIndex");
                const dashboard = state.dashboards.require(accountId, dashboardId);
                const items = [...dashboard.dashboardItems];
                if (indexArg === "new") {
                    const item = parseDashboardItem(rest);
                    validateDashboardItemReferences(state, accountId, item);
                    items.push(item);
                } else {
                    const index = parseNonNegativeInteger(indexArg, "itemIndex");
                    if (index >= items.length) throw new Error(`item tidak ditemukan: ${index}`);
                    const item = parseDashboardItem(rest);
                    validateDashboardItemReferences(state, accountId, item);
                    items[index] = { ...item, id: items[index].id };
                }
                const updated = state.dashboards.update(accountId, dashboardId, {
                    dashboardItems: items,
                });
                jsonData = publicDashboard(updated);
                await commit(state);
                await print(`Item dashboard ${dashboardId} diperbarui.\n`);
                return;
            }

            case "dashboard item-remove": {
                const accountId = requireArg(rest[0], "accountId");
                const dashboardId = requireArg(rest[1], "dashboardId");
                const index = parseNonNegativeInteger(
                    requireArg(rest[2], "itemIndex"),
                    "itemIndex",
                );
                const dashboard = state.dashboards.require(accountId, dashboardId);
                if (index >= dashboard.dashboardItems.length) {
                    throw new Error(`item tidak ditemukan: ${index}`);
                }
                const items = dashboard.dashboardItems.filter((_, itemIndex) => itemIndex !== index);
                const updated = state.dashboards.update(accountId, dashboardId, {
                    dashboardItems: items,
                });
                jsonData = publicDashboard(updated);
                await commit(state);
                await print(`Item ${index} dihapus dari dashboard ${dashboardId}.\n`);
                return;
            }

            case "device add": {
                const accountId = requireArg(rest[0], "accountId");
                if (!state.accounts.has(accountId)) throw new Error(`akun tidak ditemukan: ${accountId}`);
                const rec = state.devices.register(accountId, {
                    name: flag(rest, "--name"),
                    city: flag(rest, "--city"),
                    category: flag(rest, "--category"),
                    group: flag(rest, "--group"),
                });
                jsonData = rec;
                await commit(state);
                await print(`Device terdaftar untuk ${accountId}:\n`);
                await print(`  deviceId: ${rec.deviceId}\n`);
                await print("Tempelkan deviceId ini di firmware bersama AccessKey akun.\n");
                return;
            }

            case "device list": {
                const accountId = requireArg(rest[0], "accountId");
                const devices = state.devices.listByAccount(accountId);
                jsonData = devices;
                if (devices.length === 0) {
                    await print(`Belum ada device untuk ${accountId}.\n`);
                    return;
                }
                for (const d of devices) {
                    const meta = [
                        d.meta.name,
                        d.meta.city,
                        d.meta.category,
                        d.meta.group ? `grup=${d.meta.group}` : undefined,
                    ]
                        .filter(Boolean)
                        .join(" · ");
                    await print(`${d.deviceId}${meta ? `  (${meta})` : ""}\n`);
                }
                return;
            }

            case "device update": {
                const accountId = requireArg(rest[0], "accountId");
                const deviceId = requireArg(rest[1], "deviceId");
                const patch = parseDeviceMeta(rest);
                if (Object.keys(patch).length === 0) {
                    throw new Error("minimal satu field metadata harus diubah");
                }
                const device = state.devices.updateMeta(accountId, deviceId, patch);
                jsonData = device;
                await commit(state);
                await print(`Metadata device ${deviceId} diperbarui.\n`);
                return;
            }

            case "device remove": {
                const accountId = requireArg(rest[0], "accountId");
                const deviceId = requireArg(rest[1], "deviceId");
                const referencedDashboard = state.dashboards.list().find(
                    (record) =>
                        record.accountId === accountId &&
                        record.portableDashboard.some((dashboard) =>
                            dashboard.dashboardItems.some((item) => item.deviceId === deviceId),
                        ),
                );
                if (referencedDashboard) {
                    throw new Error(`device ${deviceId} masih digunakan portable dashboard akun ${accountId}`);
                }
                state.devices.remove(accountId, deviceId);
                jsonData = { accountId, deviceId, removed: true };
                await commit(state);
                await print(`Device ${deviceId} dihapus dari ${accountId}.\n`);
                return;
            }

            case "scheme add": {
                const accountId = requireArg(rest[0], "accountId");
                if (!state.accounts.has(accountId)) throw new Error(`akun tidak ditemukan: ${accountId}`);
                const schemeId = parsePositiveInteger(
                    requireArg(rest[1], "schemeId"),
                    "schemeId",
                );
                const type = (flag(rest, "--type") || "number") as SchemeType;
                const scheme = state.schemes.add({
                    schemeId,
                    ownerAccountId: accountId,
                    label: requireArg(flag(rest, "--label"), "--label"),
                    unit: flag(rest, "--unit"),
                    type,
                    min: numberFlag(rest, "--min"),
                    max: numberFlag(rest, "--max"),
                });
                jsonData = scheme;
                await commit(state);
                await print(`Scheme ${schemeId} dibuat (owner ${accountId}).\n`);
                return;
            }

            case "scheme list": {
                const schemes = state.schemes.list(rest[0]);
                jsonData = schemes;
                if (schemes.length === 0) {
                    await print("Belum ada scheme.\n");
                    return;
                }
                for (const s of schemes) {
                    const range =
                        s.min !== undefined || s.max !== undefined
                            ? ` rentang=${s.min ?? "-"}..${s.max ?? "-"}`
                            : "";
                    await print(
                        `${s.schemeId}  ${s.label}${s.unit ? ` (${s.unit})` : ""}  ` +
                            `tipe=${s.type}${range}  owner=${s.ownerAccountId}\n`,
                    );
                }
                return;
            }

            case "scheme update": {
                const accountId = requireArg(rest[0], "accountId");
                const schemeId = parsePositiveInteger(requireArg(rest[1], "schemeId"), "schemeId");
                const patch = parseSchemePatch(rest);
                const scheme = state.schemes.update(accountId, schemeId, patch);
                jsonData = scheme;
                await commit(state);
                await print(`Scheme ${schemeId} diperbarui.\n`);
                return;
            }

            case "scheme remove": {
                const accountId = requireArg(rest[0], "accountId");
                const schemeId = parsePositiveInteger(
                    requireArg(rest[1], "schemeId"),
                    "schemeId",
                );
                const referencedDashboard = state.dashboards.list().find((record) =>
                    record.portableDashboard.some((dashboard) =>
                        dashboard.dashboardItems.some((item) => item.schemeId === schemeId),
                    ),
                );
                if (referencedDashboard) {
                    throw new Error(`scheme ${schemeId} masih digunakan portable dashboard akun ${referencedDashboard.accountId}`);
                }
                state.schemes.remove(accountId, schemeId);
                jsonData = { accountId, schemeId, removed: true };
                await commit(state);
                await print(`Scheme ${schemeId} dihapus.\n`);
                return;
            }

            default:
                if (jsonMode) jsonError = `perintah tidak dikenal: ${scope} ${action}`;
                await print(usage());
                return;
        }
    } catch (e: any) {
        const message = e instanceof Error ? e.message : String(e);
        if (jsonMode) jsonError = message;
        else await std.print(`[${TAG}] ${message}\n`);
    } finally {
        if (jsonMode) {
            const response = jsonError
                ? { version: 1, ok: false, error: { message: jsonError } }
                : { version: 1, ok: true, data: jsonData };
            await std.print(JSON.stringify(response) + "\n");
        }
    }
});

async function commit(state: Awaited<ReturnType<typeof loadState>>): Promise<void> {
    await saveState(state);
    // Beri tahu daemon agar memuat ulang registry tanpa restart.
    await shell.send(LANTANA_UUID, { type: "LANTANA_RELOAD", from: TAG }).catch(() => false);
}

function publicAccount(account: AccountRecord) {
    const { credential, ...record } = account;
    return { ...record, hasAccessKey: credential !== null };
}

function publicDashboard(dashboard: PortableDashboard) {
    return {
        dashboardId: dashboard.dashboardId,
        title: dashboard.title,
        hasAccessKey: !!dashboard.accessKeyHash,
        dashboardItems: dashboard.dashboardItems,
    };
}

function validateDashboardItemReferences(
    state: Awaited<ReturnType<typeof loadState>>,
    accountId: string,
    item: PortableDashboardItem,
): void {
    if (!state.devices.belongsTo(accountId, item.deviceId)) {
        throw new Error(`device ${item.deviceId} tidak terdaftar pada akun ${accountId}`);
    }
    if (!state.schemes.has(item.schemeId)) {
        throw new Error(`scheme tidak ditemukan: ${item.schemeId}`);
    }
}

function requireArg(value: string | undefined, name: string): string {
    if (!value || value.startsWith("--")) throw new Error(`${name} wajib diisi`);
    return value;
}

function parsePositiveInteger(value: string, name: string): number {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) {
        throw new Error(`${name} harus integer positif`);
    }
    return number;
}

function parseNonNegativeInteger(value: string, name: string): number {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) {
        throw new Error(`${name} harus integer nol atau lebih`);
    }
    return number;
}

function flag(args: string[], name: string): string | undefined {
    const idx = args.indexOf(name);
    if (idx < 0) return undefined;
    const value = args[idx + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} butuh nilai`);
    return value;
}

function numberFlag(args: string[], name: string): number | undefined {
    const raw = flag(args, name);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${name} harus angka`);
    return n;
}

function parseDashboardItem(args: string[]): PortableDashboardItem {
    const rawType = requireArg(flag(args, "--type"), "--type");
    const itemTypes: PortableDashboardItemType[] = [
        "text",
        "radialGauge",
        "lineChart",
        "switchIndicator",
    ];
    if (!itemTypes.includes(rawType as PortableDashboardItemType)) {
        throw new Error(`type dashboard tidak valid: ${rawType}`);
    }

    const scrollAfter = numberFlag(args, "--scroll-after");
    return {
        type: rawType as PortableDashboardItemType,
        title: requireArg(flag(args, "--title"), "--title"),
        icon: requireArg(flag(args, "--icon"), "--icon"),
        updateInterval: parsePositiveInteger(flag(args, "--interval") ?? "5", "--interval"),
        ...(scrollAfter !== undefined ? { scrollAfter } : {}),
        deviceId: requireArg(flag(args, "--device-id"), "--device-id"),
        schemeId: parsePositiveInteger(
            requireArg(flag(args, "--scheme-id"), "--scheme-id"),
            "--scheme-id",
        ),
    };
}

function parseDeviceMeta(args: string[]): DeviceMeta {
    const patch: DeviceMeta = {};
    for (const key of ["name", "city", "category", "group"] as const) {
        const value = flag(args, `--${key}`);
        if (value !== undefined) patch[key] = value;
        if (args.includes(`--clear-${key}`)) patch[key] = "";
    }
    return patch;
}

function parseSchemePatch(args: string[]): Partial<Omit<SchemeDef, "schemeId" | "ownerAccountId">> {
    const patch: Partial<Omit<SchemeDef, "schemeId" | "ownerAccountId">> = {};
    const label = flag(args, "--label");
    const unit = flag(args, "--unit");
    const type = flag(args, "--type");
    const min = numberFlag(args, "--min");
    const max = numberFlag(args, "--max");
    if (label !== undefined) patch.label = label;
    if (unit !== undefined) patch.unit = unit;
    if (type !== undefined) patch.type = type as SchemeType;
    if (min !== undefined) patch.min = min;
    if (max !== undefined) patch.max = max;
    if (args.includes("--clear-unit")) patch.unit = undefined;
    if (args.includes("--clear-min")) patch.min = undefined;
    if (args.includes("--clear-max")) patch.max = undefined;
    if (Object.keys(patch).length === 0) throw new Error("minimal satu field scheme harus diubah");
    return patch;
}

/** "100,101,201-205" → [100, 101, {from:201,to:205}] */
export function parseRanges(raw: string | undefined): SchemeRange[] {
    if (!raw) return [];
    const out: SchemeRange[] = [];
    for (const part of raw.split(",")) {
        const item = part.trim();
        if (!item) continue;
        if (item.includes("-")) {
            const [fromStr, toStr] = item.split("-");
            const from = parseInt(fromStr, 10);
            const to = parseInt(toStr, 10);
            if (!Number.isInteger(from) || !Number.isInteger(to) || from <= 0 || to < from) {
                throw new Error(`rentang tidak valid: ${item}`);
            }
            out.push({ from, to });
        } else {
            const id = parseInt(item, 10);
            if (!Number.isInteger(id) || id <= 0) throw new Error(`scheme tidak valid: ${item}`);
            out.push(id);
        }
    }
    return out;
}

function parsePermissions(args: string[]) {
    const command = flag(args, "--command");
    return {
        allowedInjectSchemes: parseRanges(flag(args, "--inject")),
        allowedQuerySchemes: parseRanges(flag(args, "--query")),
        allowedCommandDevices: command
            ? command.split(",").map((d) => d.trim()).filter(Boolean)
            : [],
    };
}

function formatRanges(list: SchemeRange[]): string {
    if (list.length === 0) return "-";
    return list
        .map((r) => (typeof r === "number" ? String(r) : `${r.from}-${r.to}`))
        .join(",");
}

function usage(): string {
    return [
        "lantana-ctl — manajemen Lantana V2",
        "",
        "  account create-root <accountId>",
        "  account create-child <parentId> <accountId>",
        "  account list",
        "  account key-issue <accountId>",
        "  account key-rotate <accountId>",
        "  account key-revoke <accountId>",
        "  account remove <accountId>",
        "  account permissions <accountId> [--inject a,b-c] [--query a,b-c] [--command dev1,dev2]",
        "  dashboard key-issue <accountId> [--title T]",
        "  dashboard key-rotate <accountId> <dashboardId>",
        "  dashboard key-revoke <accountId> <dashboardId>",
        "  dashboard show <accountId> [dashboardId]",
        "  dashboard update <accountId> <dashboardId> --title T",
        "  dashboard delete <accountId> <dashboardId>",
        "  dashboard item-set <accountId> <dashboardId> <index|new> --type T --title T --icon I --device-id D --scheme-id N [--interval N] [--scroll-after N]",
        "  dashboard item-remove <accountId> <dashboardId> <index>",
        "  server fingerprint",
        "  server status",
        "  device add <accountId> [--name N] [--city C] [--category C] [--group G]",
        "  device list <accountId>",
        "  device update <accountId> <deviceId> [--name N] [--city C] [--category C] [--group G] [--clear-name|--clear-city|--clear-category|--clear-group]",
        "  device remove <accountId> <deviceId>",
        "  scheme add <accountId> <schemeId> --label L [--unit U] [--type number|boolean|string] [--min N] [--max N]",
        "  scheme list [accountId]",
        "  scheme update <accountId> <schemeId> [--label L] [--unit U] [--type number|boolean|string] [--min N] [--max N] [--clear-unit|--clear-min|--clear-max]",
        "  scheme remove <accountId> <schemeId>",
        "",
        "Tambahkan --json untuk output JSON terstruktur (envelope versi 1).",
        "",
    ].join("\n");
}
