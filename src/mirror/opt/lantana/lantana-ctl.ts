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
    LANTANA_UUID,
    SchemeRange,
    SchemeType,
} from "@tsix/lantana/lantana-core";

const TAG = "lantana-ctl";

export const main = Program(async (args: string[]) => {
    const [scope, action, ...rest] = args;

    if (!scope || args.includes("--help") || args.includes("-h")) {
        await std.print(usage());
        return;
    }

    try {
        const state = await loadState();

        switch (`${scope} ${action}`) {
            case "account create-root": {
                const id = requireArg(rest[0], "accountId");
                state.accounts.createRoot(id, parsePermissions(rest));
                await commit(state);
                await std.print(`Akun root dibuat: ${id}\n`);
                await std.print(`Terbitkan AccessKey: lantana-ctl account key-issue ${id}\n`);
                return;
            }

            case "account create-child": {
                const parentId = requireArg(rest[0], "parentId");
                const id = requireArg(rest[1], "accountId");
                state.accounts.createChild(parentId, id, parsePermissions(rest));
                await commit(state);
                await std.print(`Akun child dibuat: ${id} (parent ${parentId})\n`);
                await std.print(`Terbitkan AccessKey: lantana-ctl account key-issue ${id}\n`);
                return;
            }

            case "account list": {
                const accounts = state.accounts.list();
                if (accounts.length === 0) {
                    await std.print("Belum ada akun.\n");
                    return;
                }
                for (const acc of accounts) {
                    const perms = acc.permissions;
                    await std.print(
                        `${acc.accountId}  parent=${acc.parentId ?? "-"}  key=${acc.credential ? "ada" : "tidak"}\n` +
                            `  inject=${formatRanges(perms.allowedInjectSchemes)}  ` +
                            `query=${formatRanges(perms.allowedQuerySchemes)}  ` +
                            `command=${perms.allowedCommandDevices.join(",") || "-"}\n` +
                            `  dashboard=${(acc.portableDashboard ?? [])
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
                await commit(state);
                await std.print(`AccessKey untuk ${id} (simpan di firmware, tidak ditampilkan lagi):\n`);
                await std.print(`  ${key}\n`);
                return;
            }

            case "account key-revoke": {
                const id = requireArg(rest[0], "accountId");
                state.accounts.revokeAccessKey(id);
                await commit(state);
                await std.print(`AccessKey ${id} dicabut. Semua device akun ini tidak bisa autentikasi.\n`);
                return;
            }

            case "account permissions": {
                const id = requireArg(rest[0], "accountId");
                state.accounts.setPermissions(id, parsePermissions(rest));
                await commit(state);
                await std.print(`Izin ${id} diperbarui.\n`);
                return;
            }

            case "server fingerprint": {
                const key = await loadOrCreateServerKey();
                await std.print(`Fingerprint public key server:\n  ${key.fingerprint}\n`);
                return;
            }

            case "dashboard key-issue":
            case "dashboard key-rotate": {
                const id = requireArg(rest[0], "accountId");
                const issued =
                    action === "key-issue"
                        ? state.accounts.issuePortableDashboardAccessKey(id)
                        : state.accounts.rotatePortableDashboardAccessKey(
                              id,
                              requireArg(rest[1], "dashboardId"),
                          );
                const title = state.accounts.getPortableDashboard(id, issued.dashboardId)?.title;
                await commit(state);
                await std.print(`Dashboard untuk akun ${id}:\n`);
                await std.print(`  dashboardId: ${issued.dashboardId}\n`);
                await std.print(`  title: ${title ?? `Dashboard ${issued.dashboardId}`}\n`);
                await std.print("  dashboardAccessKey (simpan; hanya ditampilkan sekali):\n");
                await std.print(`  ${issued.accessKey}\n`);
                await std.print("  alamat server MQTNL: tsix:1001 (default)\n");
                return;
            }

            case "dashboard key-revoke": {
                const id = requireArg(rest[0], "accountId");
                const dashboardId = requireArg(rest[1], "dashboardId");
                state.accounts.revokePortableDashboardAccessKey(id, dashboardId);
                await commit(state);
                await std.print(`Dashboard key ${dashboardId} akun ${id} dicabut.\n`);
                return;
            }

            case "dashboard show": {
                const id = requireArg(rest[0], "accountId");
                const dashboards = state.accounts.require(id).portableDashboard ?? [];
                const selected = rest[1]
                    ? dashboards.filter((dashboard) => String(dashboard.dashboardId) === rest[1])
                    : dashboards;
                if (selected.length === 0) {
                    await std.print(`Portable dashboard belum dikonfigurasi untuk ${id}.\n`);
                    return;
                }
                for (const dashboard of selected) {
                    await std.print(
                        `dashboardId=${dashboard.dashboardId}  title="${dashboard.title}"  ` +
                            `key=${dashboard.accessKeyHash ? "ada" : "tidak"}  ` +
                            `items=${dashboard.dashboardItems.length}\n`,
                    );
                }
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
                await commit(state);
                await std.print(`Device terdaftar untuk ${accountId}:\n`);
                await std.print(`  deviceId: ${rec.deviceId}\n`);
                await std.print("Tempelkan deviceId ini di firmware bersama AccessKey akun.\n");
                return;
            }

            case "device list": {
                const accountId = requireArg(rest[0], "accountId");
                const devices = state.devices.listByAccount(accountId);
                if (devices.length === 0) {
                    await std.print(`Belum ada device untuk ${accountId}.\n`);
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
                    await std.print(`${d.deviceId}${meta ? `  (${meta})` : ""}\n`);
                }
                return;
            }

            case "device remove": {
                const accountId = requireArg(rest[0], "accountId");
                const deviceId = requireArg(rest[1], "deviceId");
                state.devices.remove(accountId, deviceId);
                await commit(state);
                await std.print(`Device ${deviceId} dihapus dari ${accountId}.\n`);
                return;
            }

            case "scheme add": {
                const accountId = requireArg(rest[0], "accountId");
                if (!state.accounts.has(accountId)) throw new Error(`akun tidak ditemukan: ${accountId}`);
                const schemeId = parseInt(requireArg(rest[1], "schemeId"), 10);
                const type = (flag(rest, "--type") || "number") as SchemeType;
                state.schemes.add({
                    schemeId,
                    ownerAccountId: accountId,
                    label: requireArg(flag(rest, "--label"), "--label"),
                    unit: flag(rest, "--unit"),
                    type,
                    min: numberFlag(rest, "--min"),
                    max: numberFlag(rest, "--max"),
                });
                await commit(state);
                await std.print(`Scheme ${schemeId} dibuat (owner ${accountId}).\n`);
                return;
            }

            case "scheme list": {
                const schemes = state.schemes.list(rest[0]);
                if (schemes.length === 0) {
                    await std.print("Belum ada scheme.\n");
                    return;
                }
                for (const s of schemes) {
                    const range =
                        s.min !== undefined || s.max !== undefined
                            ? ` rentang=${s.min ?? "-"}..${s.max ?? "-"}`
                            : "";
                    await std.print(
                        `${s.schemeId}  ${s.label}${s.unit ? ` (${s.unit})` : ""}  ` +
                            `tipe=${s.type}${range}  owner=${s.ownerAccountId}\n`,
                    );
                }
                return;
            }

            case "scheme remove": {
                const accountId = requireArg(rest[0], "accountId");
                const schemeId = parseInt(requireArg(rest[1], "schemeId"), 10);
                state.schemes.remove(accountId, schemeId);
                await commit(state);
                await std.print(`Scheme ${schemeId} dihapus.\n`);
                return;
            }

            default:
                await std.print(usage());
                return;
        }
    } catch (e: any) {
        await std.print(`[${TAG}] ${e?.message || e}\n`);
    }
});

async function commit(state: Awaited<ReturnType<typeof loadState>>): Promise<void> {
    await saveState(state);
    // Beri tahu daemon agar memuat ulang registry tanpa restart.
    await shell.send(LANTANA_UUID, { type: "LANTANA_RELOAD", from: TAG }).catch(() => false);
}

function requireArg(value: string | undefined, name: string): string {
    if (!value || value.startsWith("--")) throw new Error(`${name} wajib diisi`);
    return value;
}

function flag(args: string[], name: string): string | undefined {
    const idx = args.indexOf(name);
    if (idx < 0) return undefined;
    const value = args[idx + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} butuh nilai`);
    return value;
}

function numberFlag(args: string[], name: string): number | undefined {
    const raw = flag(args, name);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${name} harus angka`);
    return n;
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
        "  account permissions <accountId> [--inject a,b-c] [--query a,b-c] [--command dev1,dev2]",
        "  dashboard key-issue <accountId>",
        "  dashboard key-rotate <accountId> <dashboardId>",
        "  dashboard key-revoke <accountId> <dashboardId>",
        "  dashboard show <accountId> [dashboardId]",
        "  server fingerprint",
        "  device add <accountId> [--name N] [--city C] [--category C] [--group G]",
        "  device list <accountId>",
        "  device remove <accountId> <deviceId>",
        "  scheme add <accountId> <schemeId> --label L [--unit U] [--type number|boolean|string] [--min N] [--max N]",
        "  scheme list [accountId]",
        "  scheme remove <accountId> <schemeId>",
        "",
    ].join("\n");
}
