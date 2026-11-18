/**
 * Lantana Control Panel — GUI Pistachio untuk mengelola Lantana lewat lantana-ctl.
 *
 * Navigasi kiri berupa pohon: akun → Device/Scheme/Portable Dashboard → entri.
 * Memilih entri menampilkan editornya di kanan; field bisa langsung disunting
 * lalu disimpan dengan tombol Simpan.
 *
 * (c) 2026 TSIX Project
 */

import { Program } from "@tsix/Application";
import {
    TButton,
    TComboBox,
    TDialogs,
    TEdit,
    TForm,
    TGridPanel,
    THStack,
    TLabel,
    TScrollBox,
    TTreeView,
    TVStack,
    type TComponent,
    type TTreeNode,
} from "@tsix/pistachio";
import {
    buildControlTree,
    deviceTitle,
    findPayload as findPayloadIn,
    nodeIdOf,
    type AccountView,
    type DashboardView,
    type DeviceView,
    type NavKind,
    type NavPayload,
    type SchemeRange,
    type SchemeView,
    type ServerView,
} from "@tsix/lantana/control-panel-tree";
import { runLantanaCtl } from "@tsix/lantana/lantana-ctl-client";

export const appMode = "gui";

/** Rancangan entri baru yang belum disimpan. */
interface Draft {
    kind: Exclude<NavKind, "server" | "group">;
    accountId: string;
    parentId?: string | null;
    dashboard?: DashboardView;
}

const ITEM_TYPES = ["text", "radialGauge", "lineChart", "switchIndicator"];
const SCHEME_TYPES = ["number", "boolean", "string"];

const FIELD_LABEL_STYLE = {
    fontSize: "11px",
    fontWeight: "600",
    color: "var(--text-dim, #ccc)",
} as const;

interface Field {
    label: string;
    input: TEdit | TComboBox;
}

export const main = Program(async () => {
    const form = new TForm({
        title: "Lantana Control Panel",
        icon: "🌿",
        width: 1180,
        height: 780,
        maximizable: true,
        resizable: true,
        desktopCentered: true,
        style: {
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            padding: "12px",
            height: "100%",
            boxSizing: "border-box",
        },
    });

    let accounts: AccountView[] = [];
    let devices: DeviceView[] = [];
    let schemes: SchemeView[] = [];
    let dashboards: DashboardView[] = [];
    let server: ServerView | null = null;
    let selection: NavPayload | null = null;
    let draft: Draft | null = null;
    let busy = false;

    const title = new TLabel({
        text: "Lantana Control Panel",
        style: { fontSize: "19px", fontWeight: "700" },
    });
    const status = new TLabel({
        text: "Siap",
        style: {
            fontSize: "11px",
            color: "var(--text-muted, #94a3b8)",
            border: "1px solid var(--border, rgba(255,255,255,0.12))",
            borderRadius: "12px",
            padding: "4px 10px",
        },
    });
    const header = new THStack({
        style: {
            justifyContent: "space-between",
            minHeight: "40px",
            borderBottom: "1px solid var(--border, rgba(255,255,255,0.12))",
            paddingBottom: "6px",
        },
        children: [title, status],
    });

    const tree = new TTreeView({ id: "lcp-tree", indent: 14 });
    const sidebar = new TVStack({
        style: {
            width: "320px",
            minWidth: "240px",
            maxWidth: "420px",
            minHeight: "0",
            gap: "6px",
            paddingRight: "10px",
            borderRight: "1px solid var(--border, rgba(255,255,255,0.12))",
        },
        children: [
            new TLabel({
                text: "NAVIGASI",
                style: {
                    fontSize: "10px",
                    fontWeight: "700",
                    letterSpacing: "1px",
                    color: "var(--text-muted, #94a3b8)",
                },
            }),
            tree,
        ],
    });

    const editorTitle = new TLabel({
        text: "Pilih entri",
        style: { fontSize: "16px", fontWeight: "700" },
    });
    const editorHint = new TLabel({
        text: "Klik akun, lalu Device / Scheme / Portable Dashboard untuk membuka isinya.",
        style: { fontSize: "11px", color: "var(--text-muted, #94a3b8)" },
    });

    function textInput(id: string, placeholder: string, label: string): Field {
        return {
            label,
            input: new TEdit({
                id,
                placeholder,
                style: { width: "100%", height: "34px", fontSize: "12px" },
            }),
        };
    }

    function comboInput(id: string, items: string[], label: string): Field {
        return {
            label,
            input: new TComboBox({
                id,
                items,
                style: { width: "100%", height: "34px", fontSize: "12px" },
            }),
        };
    }

    function fieldGrid(id: string, fields: Field[]): TGridPanel {
        const grid = new TGridPanel({
            id,
            columns: 2,
            style: { gap: "10px" },
        });
        for (const field of fields) {
            grid.add(
                new TVStack({
                    style: { gap: "4px", minWidth: "0" },
                    children: [
                        new TLabel({ text: field.label, style: FIELD_LABEL_STYLE }),
                        field.input,
                    ],
                }),
            );
        }
        return grid;
    }

    /** Grup field yang ditampilkan sesuai entri yang dipilih di pohon. */
    function group(id: string, caption: string, body: TComponent[]): TVStack {
        return new TVStack({
            id,
            style: { display: "none", gap: "10px" },
            children: [
                new TLabel({
                    text: caption,
                    style: {
                        fontSize: "12px",
                        fontWeight: "700",
                        color: "var(--accent, #4caf50)",
                    },
                }),
                ...body,
            ],
        });
    }

    const accountInfo = new TLabel({ text: "", style: { fontSize: "11px" } });
    const accountIdField = textInput("lcp-account-id", "contoh: juragan", "Account ID");
    const accountParentField = textInput(
        "lcp-account-parent",
        "kosongkan untuk akun root",
        "Parent account ID",
    );
    const accountInjectField = textInput(
        "lcp-account-inject",
        "contoh: 101,201-205",
        "Scheme yang boleh di-inject",
    );
    const accountQueryField = textInput(
        "lcp-account-query",
        "contoh: 101,201-205",
        "Scheme yang boleh di-query",
    );
    const accountCommandField = textInput(
        "lcp-account-command",
        "pisahkan dengan koma",
        "Device yang boleh di-command",
    );
    const accountGroup = group("lcp-group-account", "Akun", [
        accountInfo,
        fieldGrid("lcp-account-grid", [
            accountIdField,
            accountParentField,
            accountInjectField,
            accountQueryField,
            accountCommandField,
        ]),
    ]);

    const deviceInfo = new TLabel({ text: "", style: { fontSize: "11px" } });
    const deviceNameField = textInput("lcp-device-name", "Sensor Ruang Tamu", "Nama");
    const deviceCityField = textInput("lcp-device-city", "Bandung", "Kota");
    const deviceCategoryField = textInput("lcp-device-category", "sensor", "Kategori");
    const deviceGroupField = textInput("lcp-device-group", "lantai-1", "Grup");
    const deviceGroup = group("lcp-group-device", "Device", [
        deviceInfo,
        fieldGrid("lcp-device-grid", [
            deviceNameField,
            deviceCityField,
            deviceCategoryField,
            deviceGroupField,
        ]),
    ]);

    const schemeInfo = new TLabel({ text: "", style: { fontSize: "11px" } });
    const schemeIdField = textInput("lcp-scheme-id", "contoh: 101", "Scheme ID");
    const schemeLabelField = textInput("lcp-scheme-label", "Suhu Ruangan", "Label");
    const schemeUnitField = textInput("lcp-scheme-unit", "°C", "Unit");
    const schemeTypeField = comboInput("lcp-scheme-type", SCHEME_TYPES, "Tipe data");
    const schemeMinField = textInput("lcp-scheme-min", "opsional", "Nilai minimum");
    const schemeMaxField = textInput("lcp-scheme-max", "opsional", "Nilai maksimum");
    const schemeGroup = group("lcp-group-scheme", "Scheme", [
        schemeInfo,
        fieldGrid("lcp-scheme-grid", [
            schemeIdField,
            schemeTypeField,
            schemeLabelField,
            schemeUnitField,
            schemeMinField,
            schemeMaxField,
        ]),
    ]);

    const dashboardInfo = new TLabel({ text: "", style: { fontSize: "11px" } });
    const dashboardTitleField = textInput(
        "lcp-dashboard-title",
        "Sensor Rumah",
        "Judul",
    );
    const dashboardGroup = group("lcp-group-dashboard", "Portable dashboard", [
        dashboardInfo,
        fieldGrid("lcp-dashboard-grid", [dashboardTitleField]),
    ]);

    const itemInfo = new TLabel({ text: "", style: { fontSize: "11px" } });
    const itemTypeField = comboInput("lcp-item-type", ITEM_TYPES, "Tipe kartu");
    const itemTitleField = textInput("lcp-item-title", "Suhu Ruangan", "Judul kartu");
    const itemIconField = textInput("lcp-item-icon", "thermostat", "Icon");
    const itemIntervalField = textInput("lcp-item-interval", "5", "Update interval (detik)");
    const itemScrollField = textInput("lcp-item-scroll", "opsional", "Scroll after");
    const itemDeviceField = textInput("lcp-item-device", "device id", "Device ID");
    const itemSchemeField = textInput("lcp-item-scheme", "101", "Scheme ID");
    const itemGroup = group("lcp-group-item", "Item dashboard", [
        itemInfo,
        fieldGrid("lcp-item-grid", [
            itemTypeField,
            itemTitleField,
            itemIconField,
            itemIntervalField,
            itemScrollField,
            itemDeviceField,
            itemSchemeField,
        ]),
    ]);

    const serverInfo = new TLabel({
        text: "",
        style: {
            fontSize: "12px",
            lineHeight: "1.7",
            whiteSpace: "pre-wrap",
            fontFamily: "monospace",
        },
    });
    const serverGroup = group("lcp-group-server", "Status layanan", [serverInfo]);

    const groupInfo = new TLabel({
        text: "",
        style: { fontSize: "12px", color: "var(--text-muted, #94a3b8)" },
    });
    const groupSummary = group("lcp-group-summary", "Grup", [groupInfo]);

    const emptyState = new TLabel({
        text: "Pilih entri di pohon kiri untuk melihat datanya.",
        style: {
            display: "block",
            padding: "18px 2px",
            fontSize: "13px",
            color: "var(--text-muted, #94a3b8)",
        },
    });

    const editorBody = new TVStack({
        style: { gap: "12px" },
        children: [
            emptyState,
            accountGroup,
            deviceGroup,
            schemeGroup,
            dashboardGroup,
            itemGroup,
            serverGroup,
            groupSummary,
        ],
    });

    const workArea = new THStack({
        style: {
            flex: "1",
            minHeight: "0",
            alignItems: "stretch",
            flexWrap: "nowrap",
            gap: "14px",
        },
        children: [
            sidebar,
            new TVStack({
                style: { flex: "1", minWidth: "0", minHeight: "0", gap: "10px" },
                children: [
                    new TVStack({
                        style: { gap: "2px" },
                        children: [editorTitle, editorHint],
                    }),
                    new TScrollBox({
                        style: {
                            flex: "1",
                            minHeight: "0",
                            padding: "14px",
                            border:
                                "1px solid var(--border, rgba(255,255,255,0.12))",
                            borderRadius: "8px",
                            background: "var(--surface, #16212b)",
                            boxSizing: "border-box",
                        },
                        children: [editorBody],
                    }),
                ],
            }),
        ],
    });

    function toolbarButton(id: string, caption: string): TButton {
        return new TButton({
            id,
            caption,
            style: {
                padding: "7px 12px",
                fontSize: "11px",
                borderRadius: "5px",
                whiteSpace: "nowrap",
            },
        });
    }

    const addButton = toolbarButton("lcp-add", "+ Tambah");
    const saveButton = toolbarButton("lcp-save", "Simpan");
    const cancelButton = toolbarButton("lcp-cancel", "Batal");
    const removeButton = toolbarButton("lcp-remove", "Hapus");
    const keyButton = toolbarButton("lcp-key", "Terbitkan key");
    const revokeButton = toolbarButton("lcp-revoke", "Cabut key");
    const refreshButton = toolbarButton("lcp-refresh", "Muat ulang");

    const toolbar = new THStack({
        style: {
            minHeight: "44px",
            paddingBottom: "6px",
            borderBottom: "1px solid var(--border, rgba(255,255,255,0.12))",
            flexWrap: "nowrap",
            overflowX: "auto",
        },
        children: [
            addButton,
            saveButton,
            cancelButton,
            removeButton,
            keyButton,
            revokeButton,
            refreshButton,
        ],
    });

    const footer = new TLabel({
        text: "Perubahan disimpan langsung ke registry Lantana lewat lantana-ctl.",
        style: {
            fontSize: "10px",
            color: "var(--text-muted, #94a3b8)",
            paddingTop: "6px",
            borderTop: "1px solid var(--border, rgba(255,255,255,0.12))",
        },
    });

    form.add(
        new TVStack({
            style: { flex: "1", minHeight: "0", gap: "8px" },
            children: [header, toolbar, workArea, footer],
        }),
    );

    async function run(action: () => void | Promise<void>): Promise<void> {
        if (busy) return;
        busy = true;
        try {
            await action();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            status.text = "Gagal";
            await TDialogs.alert(form, "Lantana Control Panel", message);
        } finally {
            busy = false;
        }
    }

    function rangeText(ranges: SchemeRange[]): string {
        return ranges
            .map((range) =>
                typeof range === "number" ? String(range) : `${range.from}-${range.to}`,
            )
            .join(",");
    }

    function setValue(field: Field, text: string, readOnly = false): void {
        if (field.input instanceof TComboBox) {
            const index = field.input.items.indexOf(text);
            field.input.selectedIndex = index >= 0 ? index : 0;
            return;
        }
        field.input.text = text;
        field.input.readOnly = readOnly;
    }

    function readValue(field: Field): string {
        if (field.input instanceof TComboBox) {
            return field.input.items[field.input.selectedIndex] ?? "";
        }
        return field.input.text.trim();
    }

    function required(field: Field, name: string): string {
        const text = readValue(field);
        if (!text) throw new Error(`${name} wajib diisi.`);
        return text;
    }

    function optionalNumber(field: Field, name: string): string | null {
        const text = readValue(field);
        if (!text) return null;
        if (!Number.isFinite(Number(text))) {
            throw new Error(`${name} harus berupa angka atau dikosongkan.`);
        }
        return text;
    }

    function pushFlag(args: string[], flag: string, field: Field): void {
        const text = readValue(field);
        if (text) args.push(flag, text);
    }

    function pushMetadata(args: string[], flag: string, field: Field): void {
        const text = readValue(field);
        if (text) args.push(flag, text);
        else args.push(`--clear-${flag.slice(2)}`);
    }

    function pushOptionalNumber(
        args: string[],
        flag: string,
        clearFlag: string,
        field: Field,
        name: string,
    ): void {
        const text = optionalNumber(field, name);
        if (text === null) args.push(clearFlag);
        else args.push(flag, text);
    }

    function accountsOf(accountId: string): AccountView | null {
        return accounts.find((item) => item.accountId === accountId) ?? null;
    }

    function showGroup(active: TComponent | null): void {
        for (const item of [
            accountGroup,
            deviceGroup,
            schemeGroup,
            dashboardGroup,
            itemGroup,
            serverGroup,
            groupSummary,
        ]) {
            item.style = {
                ...item.style,
                display: item === active ? "flex" : "none",
            };
        }
        emptyState.style = {
            ...emptyState.style,
            display: active ? "none" : "block",
        };
    }

    async function loadAll(): Promise<void> {
        status.text = "Memuat...";
        accounts = await runLantanaCtl<AccountView[]>("account", "list");

        const [deviceLists, schemeData, serverData, dashboardLists] =
            await Promise.all([
                Promise.all(
                    accounts.map(async (account) => {
                        const rows = await runLantanaCtl<
                            Array<Omit<DeviceView, "accountId">>
                        >("device", "list", account.accountId);
                        return rows.map((row) => ({
                            ...row,
                            accountId: account.accountId,
                        }));
                    }),
                ),
                runLantanaCtl<SchemeView[]>("scheme", "list"),
                runLantanaCtl<ServerView>("server", "status"),
                Promise.all(
                    accounts.map(async (account) => {
                        const rows = await runLantanaCtl<
                            Array<Omit<DashboardView, "accountId">>
                        >("dashboard", "show", account.accountId);
                        return rows.map((row) => ({
                            ...row,
                            accountId: account.accountId,
                        }));
                    }),
                ),
            ]);

        devices = deviceLists.flat();
        schemes = schemeData;
        server = serverData;
        dashboards = dashboardLists.flat();
        await tree.setNodes(
            buildControlTree({ accounts, devices, schemes, dashboards }),
        );
        status.text = `${accounts.length} akun · ${devices.length} device · ${schemes.length} scheme`;
    }

    function findPayload(nodeId: string): NavPayload | null {
        return findPayloadIn(tree.nodes, nodeId);
    }

    /** Segarkan entri terpilih dari data baru setelah `loadAll()`. */
    async function syncSelection(preferredId?: string | null): Promise<void> {
        const id = preferredId ?? (selection ? nodeIdOf(selection) : null);
        const payload = id ? findPayload(id) : null;
        selection = payload;
        await tree.select(payload ? id : null, false);
        renderEditor();
        updateToolbar();
    }

    function renderEditor(): void {
        const kind = draft?.kind ?? selection?.kind ?? null;
        if (!kind) {
            showGroup(null);
            editorTitle.text = "Pilih entri";
            editorHint.text =
                "Klik akun, lalu Device / Scheme / Portable Dashboard untuk membuka isinya.";
            return;
        }

        if (kind === "server") {
            showGroup(serverGroup);
            editorTitle.text = "Status layanan";
            editorHint.text = "Informasi runtime Lantana.";
            serverInfo.text = server
                ? `Fingerprint public key\n${server.fingerprint}\n\nPort layanan\n${
                      Object.entries(server.ports)
                          .map(
                              ([port, config]) =>
                                  `${port}: ${config.enabled === false ? "nonaktif" : "aktif"}`,
                          )
                          .join("\n") || "-"
                  }\n\nKategori device\n${
                      Object.entries(server.deviceCategories)
                          .map(
                              ([key, category]) =>
                                  `${category.icon ? `${category.icon} ` : ""}${category.label || key}${category.description ? ` — ${category.description}` : ""}`,
                          )
                          .join("\n") || "-"
                  }`
                : "Status server belum tersedia.";
            return;
        }

        if (kind === "group") {
            const groupKind = selection?.group;
            const accountId = selection?.account?.accountId ?? "-";
            const count =
                groupKind === "devices"
                    ? devices.filter((device) => device.accountId === accountId).length
                    : groupKind === "schemes"
                      ? schemes.filter(
                            (scheme) => scheme.ownerAccountId === accountId,
                        ).length
                      : dashboards.filter(
                            (dashboard) => dashboard.accountId === accountId,
                        ).length;
            showGroup(groupSummary);
            editorTitle.text =
                groupKind === "devices"
                    ? `Device · ${accountId}`
                    : groupKind === "schemes"
                      ? `Scheme · ${accountId}`
                      : `Portable Dashboard · ${accountId}`;
            editorHint.text =
                "Klik salah satu entri di pohon untuk melihat dan menyunting datanya.";
            groupInfo.text = `${count} entri. Gunakan tombol ${addLabel()} untuk membuat entri baru.`;
            return;
        }

        if (kind === "account") {
            showGroup(accountGroup);
            const creating = draft !== null;
            const account = creating ? null : selection?.account;
            editorTitle.text = creating
                ? "Akun baru"
                : `Akun · ${account?.accountId ?? "-"}`;
            editorHint.text = creating
                ? "Isi Account ID dan (opsional) parent untuk membuat akun."
                : `${account?.parentId ? `Child dari ${account.parentId}` : "Akun root"} · ${account?.hasAccessKey ? "AccessKey aktif" : "Belum ada AccessKey"}`;
            accountInfo.text = creating
                ? "Permissions dapat diisi setelah akun dibuat."
                : `ID: ${account?.accountId ?? "-"} · Sub-akun: ${account?.children ?? 0} · Dashboard: ${account?.dashboards.length ?? 0}`;
            setValue(accountIdField, account?.accountId ?? "", !creating);
            setValue(
                accountParentField,
                account?.parentId ?? draft?.parentId ?? "",
                !creating,
            );
            setValue(
                accountInjectField,
                rangeText(account?.permissions.allowedInjectSchemes ?? []),
            );
            setValue(
                accountQueryField,
                rangeText(account?.permissions.allowedQuerySchemes ?? []),
            );
            setValue(
                accountCommandField,
                (account?.permissions.allowedCommandDevices ?? []).join(","),
            );
            return;
        }

        if (kind === "device") {
            showGroup(deviceGroup);
            const device = draft ? null : selection?.device;
            const accountId = draft?.accountId ?? selection?.account?.accountId ?? "-";
            editorTitle.text = draft
                ? "Device baru"
                : `Device · ${device ? deviceTitle(device) : "-"}`;
            editorHint.text = draft
                ? `Akan didaftarkan pada akun ${accountId}.`
                : `Akun ${accountId}`;
            deviceInfo.text = draft
                ? "Device ID dibuat otomatis saat disimpan."
                : `Device ID: ${device?.deviceId ?? "-"}`;
            setValue(deviceNameField, device?.meta.name ?? "");
            setValue(deviceCityField, device?.meta.city ?? "");
            setValue(deviceCategoryField, device?.meta.category ?? "");
            setValue(deviceGroupField, device?.meta.group ?? "");
            return;
        }

        if (kind === "scheme") {
            showGroup(schemeGroup);
            const creating = draft !== null;
            const scheme = creating ? null : selection?.scheme;
            const accountId = draft?.accountId ?? scheme?.ownerAccountId ?? "-";
            editorTitle.text = creating
                ? "Scheme baru"
                : `Scheme · ${scheme?.schemeId ?? "-"}`;
            editorHint.text = creating
                ? `Akan dimiliki akun ${accountId}. Scheme ID harus integer positif.`
                : `Dimiliki akun ${accountId}`;
            schemeInfo.text = creating
                ? "Scheme ID harus unik."
                : `Scheme ID: ${scheme?.schemeId ?? "-"}`;
            setValue(schemeIdField, scheme ? String(scheme.schemeId) : "", !creating);
            setValue(schemeLabelField, scheme?.label ?? "");
            setValue(schemeUnitField, scheme?.unit ?? "");
            setValue(schemeTypeField, scheme?.type ?? "number");
            setValue(
                schemeMinField,
                scheme?.min === undefined ? "" : String(scheme.min),
            );
            setValue(
                schemeMaxField,
                scheme?.max === undefined ? "" : String(scheme.max),
            );
            return;
        }

        if (kind === "dashboard") {
            showGroup(dashboardGroup);
            const dashboard = draft ? null : selection?.dashboard;
            const accountId = draft?.accountId ?? selection?.account?.accountId ?? "-";
            editorTitle.text = draft
                ? "Portable dashboard baru"
                : `Dashboard · ${dashboard?.title ?? "-"}`;
            editorHint.text = draft
                ? `Dibuat untuk akun ${accountId}. AccessKey ditampilkan sekali setelah disimpan.`
                : `Akun ${accountId} · ${dashboard?.dashboardItems.length ?? 0} item · ${dashboard?.hasAccessKey ? "AccessKey aktif" : "Belum ada AccessKey"}`;
            dashboardInfo.text = draft
                ? "Dashboard ID dibuat otomatis."
                : `Dashboard ID: ${dashboard?.dashboardId ?? "-"}`;
            setValue(dashboardTitleField, dashboard?.title ?? "");
            return;
        }

        showGroup(itemGroup);
        const dashboard = draft?.dashboard ?? selection?.dashboard ?? null;
        const item = draft ? null : selection?.item;
        editorTitle.text = draft
            ? "Item dashboard baru"
            : `Item · ${item?.title ?? "-"}`;
        editorHint.text = dashboard
            ? `Dashboard ${dashboard.title} · akun ${dashboard.accountId}`
            : "Item harus terkait pada sebuah dashboard.";
        itemInfo.text = draft
            ? "Item ditambahkan ke akhir daftar dashboard."
            : `Posisi: ${(selection?.itemIndex ?? 0) + 1} dari ${dashboard?.dashboardItems.length ?? 0}`;
        setValue(itemTypeField, item?.type ?? "text");
        setValue(itemTitleField, item?.title ?? "");
        setValue(itemIconField, item?.icon ?? "");
        setValue(itemIntervalField, String(item?.updateInterval ?? 5));
        setValue(
            itemScrollField,
            item?.scrollAfter === undefined ? "" : String(item.scrollAfter),
        );
        setValue(itemDeviceField, item?.deviceId ?? "");
        setValue(itemSchemeField, item?.schemeId === undefined ? "" : String(item.schemeId));
    }

    function addLabel(): string {
        if (draft) return "+ Tambah";
        const kind = selection?.kind;
        if (kind === "group") {
            return selection?.group === "devices"
                ? "+ Device"
                : selection?.group === "schemes"
                  ? "+ Scheme"
                  : "+ Dashboard";
        }
        if (kind === "item" || kind === "dashboard") return "+ Item";
        if (kind === "device") return "+ Device";
        if (kind === "scheme") return "+ Scheme";
        if (kind === "account") return "+ Sub-akun";
        return "+ Akun";
    }

    function updateToolbar(): void {
        const editable =
            selection !== null &&
            selection.kind !== "server" &&
            selection.kind !== "group";
        const keyTarget =
            selection?.kind === "account" || selection?.kind === "dashboard";
        const hasKey =
            selection?.kind === "account"
                ? Boolean(selection.account?.hasAccessKey)
                : selection?.kind === "dashboard"
                  ? Boolean(selection.dashboard?.hasAccessKey)
                  : false;

        saveButton.enabled = draft !== null || editable;
        cancelButton.enabled = draft !== null;
        removeButton.enabled = editable && draft === null;
        keyButton.enabled = keyTarget && draft === null;
        keyButton.caption = hasKey ? "Rotasi key" : "Terbitkan key";
        revokeButton.enabled = keyTarget && hasKey && draft === null;
        addButton.caption = addLabel();
    }

    async function selectPayload(payload: NavPayload | null): Promise<void> {
        selection = payload;
        draft = null;
        renderEditor();
        updateToolbar();
    }

    tree.onSelect = (node) => {
        const payload = findPayload(node.id);
        if (!payload) return;
        void run(() => selectPayload(payload));
    };

    function startCreate(): void {
        const kind = selection?.kind;
        const accountId = selection?.account?.accountId ?? accounts[0]?.accountId ?? "";
        if (!accountId && kind !== "server") {
            throw new Error("Belum ada akun. Buat akun root terlebih dahulu.");
        }

        if (kind === "group") {
            if (selection?.group === "devices") {
                draft = { kind: "device", accountId };
            } else if (selection?.group === "schemes") {
                draft = { kind: "scheme", accountId };
            } else {
                draft = { kind: "dashboard", accountId };
            }
        } else if (kind === "device") {
            draft = { kind: "device", accountId };
        } else if (kind === "scheme") {
            draft = { kind: "scheme", accountId };
        } else if (kind === "dashboard" || kind === "item") {
            const dashboard = selection?.dashboard;
            if (!dashboard) throw new Error("Pilih dashboard terlebih dahulu.");
            draft = { kind: "item", accountId: dashboard.accountId, dashboard };
        } else if (kind === "account") {
            draft = { kind: "account", accountId: "", parentId: accountId };
        } else {
            draft = { kind: "account", accountId: "", parentId: null };
        }

        renderEditor();
        updateToolbar();
        status.text = "Isi detail entri baru lalu tekan Simpan.";
    }

    async function saveAccount(): Promise<string> {
        if (draft) {
            const id = required(accountIdField, "Account ID");
            const parent = readValue(accountParentField);
            const args = parent
                ? ["account", "create-child", parent, id]
                : ["account", "create-root", id];
            pushFlag(args, "--inject", accountInjectField);
            pushFlag(args, "--query", accountQueryField);
            pushFlag(args, "--command", accountCommandField);
            await runLantanaCtl(...args);
            return `acc:${id}`;
        }
        const account = selection?.account;
        if (!account) throw new Error("Akun tidak dipilih.");
        const args = ["account", "permissions", account.accountId];
        pushFlag(args, "--inject", accountInjectField);
        pushFlag(args, "--query", accountQueryField);
        pushFlag(args, "--command", accountCommandField);
        await runLantanaCtl(...args);
        return `acc:${account.accountId}`;
    }

    async function saveDevice(): Promise<string> {
        if (draft) {
            const args = ["device", "add", draft.accountId];
            pushFlag(args, "--name", deviceNameField);
            pushFlag(args, "--city", deviceCityField);
            pushFlag(args, "--category", deviceCategoryField);
            pushFlag(args, "--group", deviceGroupField);
            const created = await runLantanaCtl<{ deviceId: string }>(...args);
            await TDialogs.alert(
                form,
                "Device dibuat",
                `Device ID: ${created.deviceId}`,
            );
            return `dev:${draft.accountId}:${created.deviceId}`;
        }
        const device = selection?.device;
        if (!device) throw new Error("Device tidak dipilih.");
        const args = ["device", "update", device.accountId, device.deviceId];
        pushMetadata(args, "--name", deviceNameField);
        pushMetadata(args, "--city", deviceCityField);
        pushMetadata(args, "--category", deviceCategoryField);
        pushMetadata(args, "--group", deviceGroupField);
        await runLantanaCtl(...args);
        return `dev:${device.accountId}:${device.deviceId}`;
    }

    async function saveScheme(): Promise<string> {
        const type = readValue(schemeTypeField) || "number";
        if (draft) {
            const schemeId = required(schemeIdField, "Scheme ID");
            if (!/^[1-9]\d*$/.test(schemeId)) {
                throw new Error("Scheme ID harus integer positif.");
            }
            const args = [
                "scheme",
                "add",
                draft.accountId,
                schemeId,
                "--label",
                required(schemeLabelField, "Label"),
                "--type",
                type,
            ];
            pushFlag(args, "--unit", schemeUnitField);
            const min = optionalNumber(schemeMinField, "Nilai minimum");
            const max = optionalNumber(schemeMaxField, "Nilai maksimum");
            if (min !== null) args.push("--min", min);
            if (max !== null) args.push("--max", max);
            await runLantanaCtl(...args);
            return `sch:${draft.accountId}:${schemeId}`;
        }
        const scheme = selection?.scheme;
        if (!scheme) throw new Error("Scheme tidak dipilih.");
        const args = [
            "scheme",
            "update",
            scheme.ownerAccountId,
            String(scheme.schemeId),
            "--label",
            required(schemeLabelField, "Label"),
            "--type",
            type,
        ];
        const unit = readValue(schemeUnitField);
        if (unit) args.push("--unit", unit);
        else args.push("--clear-unit");
        pushOptionalNumber(args, "--min", "--clear-min", schemeMinField, "Nilai minimum");
        pushOptionalNumber(args, "--max", "--clear-max", schemeMaxField, "Nilai maksimum");
        await runLantanaCtl(...args);
        return `sch:${scheme.ownerAccountId}:${scheme.schemeId}`;
    }

    async function saveDashboard(): Promise<string> {
        if (draft) {
            const result = await runLantanaCtl<{
                dashboardId: number;
                dashboardAccessKey: string;
            }>(
                "dashboard",
                "key-issue",
                draft.accountId,
                "--title",
                required(dashboardTitleField, "Judul dashboard"),
            );
            await TDialogs.alert(
                form,
                "Dashboard dibuat",
                `Dashboard ID: ${result.dashboardId}\nAccessKey (hanya tampil sekali):\n${result.dashboardAccessKey}`,
            );
            return `dash:${draft.accountId}:${result.dashboardId}`;
        }
        const dashboard = selection?.dashboard;
        if (!dashboard) throw new Error("Dashboard tidak dipilih.");
        await runLantanaCtl(
            "dashboard",
            "update",
            dashboard.accountId,
            String(dashboard.dashboardId),
            "--title",
            required(dashboardTitleField, "Judul dashboard"),
        );
        return `dash:${dashboard.accountId}:${dashboard.dashboardId}`;
    }

    function itemArgs(
        accountId: string,
        dashboardId: number,
        index: string,
    ): string[] {
        const interval = required(itemIntervalField, "Update interval");
        const schemeId = required(itemSchemeField, "Scheme ID");
        if (!/^[1-9]\d*$/.test(interval)) {
            throw new Error("Update interval harus integer positif.");
        }
        if (!/^[1-9]\d*$/.test(schemeId)) {
            throw new Error("Scheme ID harus integer positif.");
        }
        const args = [
            "dashboard",
            "item-set",
            accountId,
            String(dashboardId),
            index,
            "--type",
            readValue(itemTypeField) || "text",
            "--title",
            required(itemTitleField, "Judul item"),
            "--icon",
            required(itemIconField, "Icon"),
            "--interval",
            interval,
            "--device-id",
            required(itemDeviceField, "Device ID"),
            "--scheme-id",
            schemeId,
        ];
        const scrollAfter = optionalNumber(itemScrollField, "Scroll after");
        if (scrollAfter !== null) args.push("--scroll-after", scrollAfter);
        return args;
    }

    async function saveItem(): Promise<string> {
        const dashboard = draft?.dashboard ?? selection?.dashboard;
        if (!dashboard) throw new Error("Dashboard induk tidak ditemukan.");
        const index =
            draft !== null || selection?.itemIndex === undefined
                ? "new"
                : String(selection.itemIndex);
        await runLantanaCtl(
            ...itemArgs(dashboard.accountId, dashboard.dashboardId, index),
        );
        return `dash:${dashboard.accountId}:${dashboard.dashboardId}`;
    }

    async function save(): Promise<void> {
        const kind = draft?.kind ?? selection?.kind ?? null;
        if (!kind || kind === "server" || kind === "group") {
            throw new Error("Tidak ada entri yang bisa disimpan.");
        }
        const pending = draft;
        const target =
            kind === "account"
                ? await saveAccount()
                : kind === "device"
                  ? await saveDevice()
                  : kind === "scheme"
                    ? await saveScheme()
                    : kind === "dashboard"
                      ? await saveDashboard()
                      : await saveItem();

        await loadAll();
        draft = null;
        let resolved = target;
        // Item baru selalu ditambahkan di akhir daftar dashboard.
        if (pending?.kind === "item" && pending.dashboard) {
            const fresh = dashboards.find(
                (dashboard) =>
                    dashboard.accountId === pending.dashboard!.accountId &&
                    dashboard.dashboardId === pending.dashboard!.dashboardId,
            );
            if (fresh?.dashboardItems.length) {
                resolved = `item:${fresh.accountId}:${fresh.dashboardId}:${fresh.dashboardItems.length - 1}`;
            }
        }
        await syncSelection(resolved);
        status.text = pending ? "Data dibuat" : "Perubahan tersimpan";
    }

    async function cancel(): Promise<void> {
        draft = null;
        renderEditor();
        updateToolbar();
        status.text = "Perubahan dibatalkan";
    }

    async function remove(): Promise<void> {
        const entry = selection;
        if (!entry || entry.kind === "server" || entry.kind === "group") return;
        const label =
            entry.kind === "account"
                ? `akun "${entry.account?.accountId}"`
                : entry.kind === "device"
                  ? `device "${deviceTitle(entry.device!)}"`
                  : entry.kind === "scheme"
                    ? `scheme ${entry.scheme?.schemeId}`
                    : entry.kind === "dashboard"
                      ? `dashboard "${entry.dashboard?.title}"`
                      : `item "${entry.item?.title}"`;
        const answer = await TDialogs.confirm(
            form,
            "Konfirmasi penghapusan",
            `Yakin ingin menghapus ${label}?`,
            ["Hapus", "Batal"],
        );
        if (answer !== "Hapus") return;

        if (entry.kind === "account") {
            await runLantanaCtl("account", "remove", entry.account!.accountId);
        } else if (entry.kind === "device") {
            await runLantanaCtl(
                "device",
                "remove",
                entry.device!.accountId,
                entry.device!.deviceId,
            );
        } else if (entry.kind === "scheme") {
            await runLantanaCtl(
                "scheme",
                "remove",
                entry.scheme!.ownerAccountId,
                String(entry.scheme!.schemeId),
            );
        } else if (entry.kind === "dashboard") {
            await runLantanaCtl(
                "dashboard",
                "delete",
                entry.dashboard!.accountId,
                String(entry.dashboard!.dashboardId),
            );
        } else {
            await runLantanaCtl(
                "dashboard",
                "item-remove",
                entry.dashboard!.accountId,
                String(entry.dashboard!.dashboardId),
                String(entry.itemIndex ?? 0),
            );
        }
        selection = null;
        await loadAll();
        await syncSelection(null);
        status.text = "Data dihapus";
    }

    async function issueKey(): Promise<void> {
        const entry = selection;
        if (entry?.kind === "account") {
            const action = entry.account?.hasAccessKey ? "key-rotate" : "key-issue";
            const result = await runLantanaCtl<{ accessKey: string }>(
                "account",
                action,
                entry.account!.accountId,
            );
            await TDialogs.alert(
                form,
                action === "key-issue"
                    ? "AccessKey diterbitkan"
                    : "AccessKey dirotasi",
                `Simpan key ini sekarang; setelah dialog ditutup key tidak dapat dibaca lagi:\n${result.accessKey}`,
            );
        } else if (entry?.kind === "dashboard") {
            const result = await runLantanaCtl<{ dashboardAccessKey: string }>(
                "dashboard",
                "key-rotate",
                entry.dashboard!.accountId,
                String(entry.dashboard!.dashboardId),
            );
            await TDialogs.alert(
                form,
                entry.dashboard?.hasAccessKey
                    ? "Dashboard key dirotasi"
                    : "Dashboard key diterbitkan",
                `Simpan key ini sekarang; setelah dialog ditutup key tidak dapat dibaca lagi:\n${result.dashboardAccessKey}`,
            );
        }
        await loadAll();
        await syncSelection();
        status.text = "Key diperbarui";
    }

    async function revokeKey(): Promise<void> {
        const entry = selection;
        if (!entry) return;
        const answer = await TDialogs.confirm(
            form,
            "Konfirmasi pencabutan key",
            "Key yang dicabut tidak bisa dipakai lagi untuk autentikasi. Lanjutkan?",
            ["Cabut", "Batal"],
        );
        if (answer !== "Cabut") return;
        if (entry.kind === "account") {
            await runLantanaCtl("account", "key-revoke", entry.account!.accountId);
        } else if (entry.kind === "dashboard") {
            await runLantanaCtl(
                "dashboard",
                "key-revoke",
                entry.dashboard!.accountId,
                String(entry.dashboard!.dashboardId),
            );
        }
        await loadAll();
        await syncSelection();
        status.text = "Key dicabut";
    }

    addButton.onClick = () => void run(startCreate);
    saveButton.onClick = () => void run(save);
    cancelButton.onClick = () => void run(cancel);
    removeButton.onClick = () => void run(remove);
    keyButton.onClick = () => void run(issueKey);
    revokeButton.onClick = () => void run(revokeKey);
    refreshButton.onClick = () =>
        void run(async () => {
            await loadAll();
            await syncSelection();
            status.text = "Data dimuat ulang";
        });

    renderEditor();
    updateToolbar();

    form.onSetup = async () => {
        await form.maximize();
        await run(async () => {
            await loadAll();
            const first = tree.nodes.find((node) => node.id !== "server");
            const payload = first ? findPayload(first.id) : null;
            if (first) await tree.select(first.id, false);
            await selectPayload(payload);
        });
    };

    await form.run();
});
