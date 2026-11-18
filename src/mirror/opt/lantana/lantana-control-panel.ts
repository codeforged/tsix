/**
 * Lantana Control Panel — GUI Cashew untuk mengelola Lantana lewat lantana-ctl.
 */

import { Program } from "@tsix/Application";
import {
    HStack,
    TButton,
    TComboBox,
    TEdit,
    TForm,
    TLabel,
    TListBox,
    TPanel,
    VStack,
} from "@tsix/cashew";
import { runLantanaCtl } from "@tsix/lantana/lantana-ctl-client";

export const appMode = "gui";

type SchemeRange = number | { from: number; to: number };
type Section = "accounts" | "devices" | "schemes" | "dashboards" | "server";
type RecordKind =
    | "account"
    | "device"
    | "scheme"
    | "dashboard"
    | "dashboardItem"
    | "server";
type EditableKind = Exclude<RecordKind, "server">;
type EditorMode = "view" | "edit" | "create";

interface AccountView {
    accountId: string;
    parentId: string | null;
    permissions: {
        allowedInjectSchemes: SchemeRange[];
        allowedQuerySchemes: SchemeRange[];
        allowedCommandDevices: string[];
    };
    hasAccessKey: boolean;
    children: number;
    dashboards: Array<{ dashboardId: number; title: string; hasAccessKey: boolean }>;
}

interface DeviceView {
    accountId: string;
    deviceId: string;
    meta: {
        name?: string;
        city?: string;
        category?: string;
        group?: string;
    };
}

interface SchemeView {
    schemeId: number;
    ownerAccountId: string;
    label: string;
    unit?: string;
    type: "number" | "boolean" | "string";
    min?: number;
    max?: number;
}

interface DashboardItemView {
    id?: number | string;
    type: "text" | "radialGauge" | "lineChart" | "switchIndicator";
    title: string;
    icon: string;
    updateInterval: number;
    scrollAfter?: number;
    deviceId: string;
    schemeId: number;
}

interface DashboardView {
    dashboardId: number;
    title: string;
    hasAccessKey: boolean;
    dashboardItems: DashboardItemView[];
    accountId: string;
}

interface ServerView {
    fingerprint: string;
    ports: Record<string, { enabled: boolean }>;
    deviceCategories: Record<
        string,
        { label: string; icon?: string; description?: string }
    >;
}

type TreeEntry =
    | { kind: "account"; label: string; record: AccountView }
    | { kind: "device"; label: string; record: DeviceView }
    | { kind: "scheme"; label: string; record: SchemeView }
    | { kind: "dashboard"; label: string; record: DashboardView }
    | {
          kind: "dashboardItem";
          label: string;
          record: DashboardItemView;
          dashboard: DashboardView;
          itemIndex: number;
      }
    | { kind: "server"; label: string; record: ServerView };

type Field = TEdit | TComboBox;

const SECTIONS: Array<{ key: Section; title: string; icon: string }> = [
    { key: "accounts", title: "Akun", icon: "◉" },
    { key: "devices", title: "Device", icon: "▣" },
    { key: "schemes", title: "Scheme", icon: "◇" },
    { key: "dashboards", title: "Portable Dashboard", icon: "▤" },
    { key: "server", title: "Server", icon: "⌁" },
];

export const main = Program(async () => {
    const form = new TForm({
        title: "Lantana Control Panel",
        icon: "🌿",
        width: 1120,
        height: 760,
        maximizable: true,
        resizable: true,
        desktopCentered: true,
    });
    form.style = {
        display: "flex",
        flexDirection: "column",
        gap: "0",
        width: "100%",
        height: "100%",
        padding: "0 14px 0",
        background: "var(--bg, #101820)",
        color: "var(--text, #e0e0e0)",
        fontFamily: "sans-serif",
        overflow: "hidden",
        boxSizing: "border-box",
    };

    let activeSection: Section = "accounts";
    let editorMode: EditorMode = "view";
    let selectedEntry: TreeEntry | null = null;
    let createKind: EditableKind | null = null;
    let createDashboard: DashboardView | null = null;
    let screenReady = false;
    let accounts: AccountView[] = [];
    let devices: DeviceView[] = [];
    let schemes: SchemeView[] = [];
    let dashboards: DashboardView[] = [];
    let server: ServerView | null = null;
    let treeEntries: TreeEntry[] = [];

    const pageTitle = new TLabel({
        caption: "Lantana Control Panel",
        style: {
            color: "var(--text, #f1f5f9)",
            fontSize: "19px",
            fontWeight: "700",
            padding: "14px 0 8px",
        },
    });
    const connectionStatus = new TLabel({
        caption: "Siap",
        style: {
            color: "var(--text-muted, #94a3b8)",
            fontSize: "11px",
            padding: "4px 8px",
            border: "1px solid var(--border, #334155)",
            borderRadius: "12px",
        },
    });
    const header = HStack(
        {
            justifyContent: "space-between",
            minHeight: "46px",
            borderBottom: "1px solid var(--border, #293642)",
        },
        pageTitle,
        connectionStatus,
    );

    const toolbar = HStack({
        minHeight: "48px",
        padding: "7px 0",
        borderBottom: "1px solid var(--border, #293642)",
        gap: "7px",
        flexWrap: "nowrap",
        overflowX: "auto",
    });

    const workArea = new TPanel("lcp-work-area");
    workArea.style = {
        display: "flex",
        flex: "1",
        minHeight: "0",
        overflow: "hidden",
        background: "var(--bg, #101820)",
        border: "none",
        borderRadius: "0",
        padding: "0",
        gap: "0",
    };

    const sidebar = new TPanel("lcp-sidebar");
    sidebar.style = {
        display: "flex",
        flexDirection: "column",
        width: "244px",
        minWidth: "205px",
        maxWidth: "300px",
        padding: "12px 10px 10px 0",
        gap: "9px",
        border: "none",
        borderRight: "1px solid var(--border, #293642)",
        borderRadius: "0",
        background: "transparent",
        overflow: "hidden",
        boxSizing: "border-box",
    };
    const sidebarHeading = new TLabel({
        caption: "NAVIGASI",
        style: {
            color: "var(--text-muted, #94a3b8)",
            fontSize: "10px",
            fontWeight: "700",
            letterSpacing: "1px",
            padding: "2px 6px",
        },
    });
    const sectionButtons = new Map<Section, TButton>();
    const sectionNav = VStack({ gap: "3px" });
    for (const section of SECTIONS) {
        const button = new TButton({
            caption: `${section.icon}   ${section.title}`,
            style: {
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "8px 10px",
                border: "1px solid transparent",
                background: "transparent",
                color: "var(--text-dim, #cbd5e1)",
                fontSize: "12px",
                fontWeight: "500",
            },
        });
        button.onClick = () => {
            void runAction(async () => {
                activeSection = section.key;
                selectedEntry = null;
                editorMode = "view";
                createKind = null;
                createDashboard = null;
                updateSectionStyles();
                await renderTree();
                await renderEditor();
                updateToolbar();
            });
        };
        sectionButtons.set(section.key, button);
        sectionNav.add(button);
    }

    const treeHeading = new TLabel({
        caption: "ENTRI",
        style: {
            color: "var(--text-muted, #94a3b8)",
            fontSize: "10px",
            fontWeight: "700",
            letterSpacing: "1px",
            padding: "7px 6px 1px",
        },
    });
    const treeList = new TListBox("lcp-tree-list");
    treeList.style = {
        flex: "1",
        minHeight: "80px",
        background: "transparent",
        border: "none",
        borderRadius: "4px",
        padding: "2px",
    };
    treeList.onClick = (index) => {
        const entry = treeEntries[index];
        if (!entry) return;
        void runAction(async () => {
            selectedEntry = entry;
            editorMode = "view";
            createKind = null;
            createDashboard = null;
            await renderEditor();
            updateToolbar();
        });
    };
    sidebar.add(sidebarHeading);
    sidebar.add(sectionNav);
    sidebar.add(treeHeading);
    sidebar.add(treeList);

    const splitter = new TPanel("lcp-splitter");
    splitter.style = {
        width: "1px",
        minWidth: "1px",
        padding: "0",
        border: "none",
        borderRadius: "0",
        background: "var(--border, #293642)",
    };

    const editor = new TPanel("lcp-editor");
    editor.style = {
        display: "flex",
        flexDirection: "column",
        flex: "1",
        minWidth: "0",
        padding: "15px 4px 12px 18px",
        gap: "11px",
        border: "none",
        borderRadius: "0",
        background: "transparent",
        overflow: "hidden",
        boxSizing: "border-box",
    };
    const editorHeading = new TLabel({
        caption: "Pilih entri",
        style: {
            color: "var(--text, #f1f5f9)",
            fontSize: "16px",
            fontWeight: "700",
        },
    });
    const editorDescription = new TLabel({
        caption: "Pilih data di panel navigasi untuk melihat atau mengubah detailnya.",
        style: {
            color: "var(--text-muted, #94a3b8)",
            fontSize: "11px",
        },
    });
    const editorHeader = VStack({ gap: "4px" }, editorHeading, editorDescription);
    const editorBody = new TPanel("lcp-editor-body");
    editorBody.style = {
        display: "flex",
        flexDirection: "column",
        flex: "1",
        minHeight: "0",
        overflowY: "auto",
        padding: "14px",
        gap: "12px",
        border: "1px solid var(--border, #293642)",
        borderRadius: "8px",
        background: "var(--surface, #16212b)",
        boxSizing: "border-box",
    };
    const emptyState = new TLabel({
        caption: "Pilih entri di sebelah kiri, atau gunakan tombol Tambah untuk membuat data baru.",
        style: {
            display: "block",
            padding: "16px 4px",
            color: "var(--text-muted, #94a3b8)",
            fontSize: "13px",
        },
    });

    function addTextField(
        parent: TPanel,
        id: string,
        caption: string,
        placeholder = "",
    ): TEdit {
        const label = new TLabel({
            caption,
            style: {
                color: "var(--text-dim, #cbd5e1)",
                fontSize: "11px",
                fontWeight: "600",
            },
        });
        const input = new TEdit(id);
        input.placeholder = placeholder;
        input.style = {
            ...input.style,
            height: "36px",
            padding: "8px 10px",
            fontSize: "12px",
        };
        const fieldBox = VStack({ gap: "5px", minWidth: "0" }, label, input);
        parent.add(fieldBox);
        return input;
    }
    function addComboField(
        parent: TPanel,
        id: string,
        caption: string,
        items: string[],
    ): TComboBox {
        const label = new TLabel({
            caption,
            style: {
                color: "var(--text-dim, #cbd5e1)",
                fontSize: "11px",
                fontWeight: "600",
            },
        });
        const combo = new TComboBox(id);
        combo.items = items;
        combo.style = {
            ...combo.style,
            height: "36px",
            padding: "8px 10px",
            fontSize: "12px",
        };
        const fieldBox = VStack({ gap: "5px", minWidth: "0" }, label, combo);
        parent.add(fieldBox);
        return combo;
    }
    function createGroup(id: string, title: string): TPanel {
        const group = new TPanel(id);
        group.style = {
            display: "none",
            flexDirection: "column",
            gap: "13px",
            padding: "0",
            border: "none",
            borderRadius: "0",
            background: "transparent",
        };
        group.add(
            new TLabel({
                caption: title,
                style: {
                    color: "var(--accent, #8bd49c)",
                    fontSize: "12px",
                    fontWeight: "700",
                },
            }),
        );
        return group;
    }
    function createGrid(id: string): TPanel {
        const grid = new TPanel(id);
        grid.style = {
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: "12px",
            border: "none",
            borderRadius: "0",
            padding: "0",
            background: "transparent",
        };
        return grid;
    }

    const accountGroup = createGroup("lcp-account-fields", "Identitas dan izin akun");
    const accountGrid = createGrid("lcp-account-grid");
    const accountIdField = addTextField(accountGrid, "lcp-account-id", "Account ID", "contoh: juragan");
    const accountParentField = addTextField(accountGrid, "lcp-account-parent", "Parent account ID", "kosongkan untuk akun root");
    const accountInjectField = addTextField(accountGrid, "lcp-account-inject", "Scheme yang boleh di-inject", "contoh: 101,201-205");
    const accountQueryField = addTextField(accountGrid, "lcp-account-query", "Scheme yang boleh di-query", "contoh: 101,201-205");
    const accountCommandField = addTextField(accountGrid, "lcp-account-command", "Device yang boleh di-command", "pisahkan dengan koma");
    accountGroup.add(accountGrid);

    const deviceGroup = createGroup("lcp-device-fields", "Metadata device");
    const deviceGrid = createGrid("lcp-device-grid");
    const deviceAccountField = addTextField(deviceGrid, "lcp-device-account", "Account ID");
    const deviceIdField = addTextField(deviceGrid, "lcp-device-id", "Device ID");
    const deviceNameField = addTextField(deviceGrid, "lcp-device-name", "Nama");
    const deviceCityField = addTextField(deviceGrid, "lcp-device-city", "Kota");
    const deviceCategoryField = addTextField(deviceGrid, "lcp-device-category", "Kategori");
    const deviceGroupField = addTextField(deviceGrid, "lcp-device-group", "Grup");
    deviceGroup.add(deviceGrid);

    const schemeGroup = createGroup("lcp-scheme-fields", "Definisi scheme");
    const schemeGrid = createGrid("lcp-scheme-grid");
    const schemeIdField = addTextField(schemeGrid, "lcp-scheme-id", "Scheme ID");
    const schemeOwnerField = addTextField(schemeGrid, "lcp-scheme-owner", "Owner account ID");
    const schemeLabelField = addTextField(schemeGrid, "lcp-scheme-label", "Label");
    const schemeUnitField = addTextField(schemeGrid, "lcp-scheme-unit", "Unit");
    const schemeTypeField = addComboField(schemeGrid, "lcp-scheme-type", "Tipe data", [
        "number",
        "boolean",
        "string",
    ]);
    const schemeMinField = addTextField(schemeGrid, "lcp-scheme-min", "Nilai minimum", "opsional");
    const schemeMaxField = addTextField(schemeGrid, "lcp-scheme-max", "Nilai maksimum", "opsional");
    schemeGroup.add(schemeGrid);

    const dashboardGroup = createGroup("lcp-dashboard-fields", "Portable dashboard");
    const dashboardGrid = createGrid("lcp-dashboard-grid");
    const dashboardAccountField = addTextField(dashboardGrid, "lcp-dashboard-account", "Account ID");
    const dashboardIdField = addTextField(dashboardGrid, "lcp-dashboard-id", "Dashboard ID");
    const dashboardTitleField = addTextField(dashboardGrid, "lcp-dashboard-title", "Judul");
    const dashboardKeyField = addTextField(dashboardGrid, "lcp-dashboard-key", "AccessKey");
    dashboardGroup.add(dashboardGrid);

    const itemGroup = createGroup("lcp-dashboard-item-fields", "Item dashboard");
    const itemGrid = createGrid("lcp-dashboard-item-grid");
    const itemAccountField = addTextField(itemGrid, "lcp-item-account", "Account ID");
    const itemDashboardIdField = addTextField(itemGrid, "lcp-item-dashboard-id", "Dashboard ID");
    const itemIndexField = addTextField(itemGrid, "lcp-item-index", "Nomor item");
    const itemTypeField = addComboField(itemGrid, "lcp-item-type", "Tipe", [
        "text",
        "radialGauge",
        "lineChart",
        "switchIndicator",
    ]);
    const itemTitleField = addTextField(itemGrid, "lcp-item-title", "Judul kartu");
    const itemIconField = addTextField(itemGrid, "lcp-item-icon", "Icon", "contoh: thermostat");
    const itemIntervalField = addTextField(itemGrid, "lcp-item-interval", "Update interval (detik)");
    const itemScrollField = addTextField(itemGrid, "lcp-item-scroll", "Scroll after", "opsional");
    const itemDeviceField = addTextField(itemGrid, "lcp-item-device", "Device ID");
    const itemSchemeField = addTextField(itemGrid, "lcp-item-scheme", "Scheme ID");
    itemGroup.add(itemGrid);

    const serverGroup = createGroup("lcp-server-fields", "Status layanan Lantana");
    const serverDetails = new TLabel({
        caption: "",
        style: {
            whiteSpace: "pre-wrap",
            color: "var(--text-dim, #cbd5e1)",
            fontSize: "12px",
            lineHeight: "1.7",
        },
    });
    serverGroup.add(serverDetails);

    const footer = new TLabel({
        caption: "Operasi data dijalankan melalui lantana-ctl · perubahan disimpan langsung ke registry Lantana",
        style: {
            display: "block",
            padding: "8px 0 10px",
            borderTop: "1px solid var(--border, #293642)",
            color: "var(--text-muted, #94a3b8)",
            fontSize: "10px",
        },
    });

    editorBody.add(emptyState);
    editorBody.add(accountGroup);
    editorBody.add(deviceGroup);
    editorBody.add(schemeGroup);
    editorBody.add(dashboardGroup);
    editorBody.add(itemGroup);
    editorBody.add(serverGroup);
    editor.add(editorHeader);
    editor.add(editorBody);
    workArea.add(sidebar);
    workArea.add(splitter);
    workArea.add(editor);

    const buttons = {
        add: toolbarButton("lcp-add", "+ Tambah"),
        edit: toolbarButton("lcp-edit", "Edit"),
        save: toolbarButton("lcp-save", "Simpan"),
        cancel: toolbarButton("lcp-cancel", "Batal"),
        remove: toolbarButton("lcp-remove", "Hapus"),
        key: toolbarButton("lcp-key", "Terbitkan key"),
        revoke: toolbarButton("lcp-revoke", "Cabut key"),
        addItem: toolbarButton("lcp-add-item", "+ Item"),
        refresh: toolbarButton("lcp-refresh", "Muat ulang"),
    };
    function toolbarButton(id: string, caption: string): TButton {
        const button = new TButton(id);
        button.caption = caption;
        button.style = {
            ...button.style,
            padding: "7px 11px",
            borderRadius: "5px",
            whiteSpace: "nowrap",
            fontSize: "11px",
        };
        toolbar.add(button);
        return button;
    }

    buttons.add.onClick = () => void runAction(startCreate);
    buttons.edit.onClick = () => void runAction(startEdit);
    buttons.save.onClick = () => void runAction(saveEditor);
    buttons.cancel.onClick = () => void runAction(cancelEditor);
    buttons.remove.onClick = () => void runAction(deleteRecord);
    buttons.key.onClick = () => void runAction(manageKey);
    buttons.revoke.onClick = () => void runAction(revokeKey);
    buttons.addItem.onClick = () => void runAction(startCreateItem);
    buttons.refresh.onClick = () => void runAction(refresh);

    form.add(header);
    form.add(toolbar);
    form.add(workArea);
    form.add(footer);
    form.onSetup = async () => {
        screenReady = true;
        await form.maximize();
        updateSectionStyles();
        updateToolbar();
        await refresh();
    };

    await form.run();

    function updateSectionStyles(): void {
        for (const section of SECTIONS) {
            const button = sectionButtons.get(section.key);
            if (!button) continue;
            const active = section.key === activeSection;
            button.style = {
                ...button.style,
                background: active ? "var(--accent-bg, rgba(76,175,80,0.14))" : "transparent",
                color: active ? "var(--accent, #8bd49c)" : "var(--text-dim, #cbd5e1)",
                borderColor: active ? "var(--border, #42624a)" : "transparent",
                fontWeight: active ? "700" : "500",
            };
        }
    }

    function showButton(button: TButton, visible: boolean): void {
        button.style = { ...button.style, display: visible ? "inline-block" : "none" };
    }

    function updateToolbar(): void {
        const isCreating = editorMode === "create";
        const isEditing = editorMode === "edit";
        const entry = selectedEntry;
        const isServer = entry?.kind === "server" || activeSection === "server";
        const isDashboard = entry?.kind === "dashboard";
        const isDashboardItem = entry?.kind === "dashboardItem";
        const keyRecord =
            entry?.kind === "account" || entry?.kind === "dashboard";
        const dashboardAccess = isDashboard ? entry.record.hasAccessKey : false;
        const accountAccess = entry?.kind === "account" ? entry.record.hasAccessKey : false;

        showButton(buttons.add, !isServer && !isCreating && !isEditing);
        showButton(buttons.edit, !!entry && !isServer && editorMode === "view");
        showButton(buttons.save, isCreating || isEditing);
        showButton(buttons.cancel, isCreating || isEditing);
        showButton(buttons.remove, !!entry && !isServer && !isCreating && !isEditing);
        showButton(buttons.key, !!keyRecord && !isServer && !isCreating && !isEditing);
        buttons.key.caption = accountAccess || dashboardAccess ? "Rotasi key" : "Terbitkan key";
        showButton(
            buttons.revoke,
            !!keyRecord && (accountAccess || dashboardAccess) && !isCreating && !isEditing,
        );
        showButton(
            buttons.addItem,
            activeSection === "dashboards" &&
                !!entry &&
                (isDashboard || isDashboardItem) &&
                !isCreating &&
                !isEditing,
        );
        showButton(buttons.refresh, !isCreating && !isEditing);
        buttons.remove.caption = isDashboardItem ? "Hapus item" : "Hapus";
        buttons.add.caption =
            activeSection === "dashboards" ? "+ Dashboard" : "+ Tambah";
    }

    async function runAction(action: () => void | Promise<void>): Promise<void> {
        try {
            await action();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            connectionStatus.caption = "Gagal";
            await form.alert("Lantana Control Panel", message);
        }
    }

    function formatRanges(ranges: SchemeRange[]): string {
        if (!ranges.length) return "";
        return ranges
            .map((range) =>
                typeof range === "number" ? String(range) : `${range.from}-${range.to}`,
            )
            .join(",");
    }

    function getSelectedDashboard(): DashboardView | null {
        if (selectedEntry?.kind === "dashboard") return selectedEntry.record;
        if (selectedEntry?.kind === "dashboardItem") return selectedEntry.dashboard;
        return null;
    }

    async function refresh(): Promise<void> {
        connectionStatus.caption = "Memuat...";
        const accountData = await runLantanaCtl<AccountView[]>("account", "list");
        accounts = accountData;
        const [deviceLists, schemeData, serverData] = await Promise.all([
            Promise.all(
                accounts.map(async (account) => {
                    const records = await runLantanaCtl<Array<Omit<DeviceView, "accountId">>>(
                        "device",
                        "list",
                        account.accountId,
                    );
                    return records.map((record) => ({ ...record, accountId: account.accountId }));
                }),
            ),
            runLantanaCtl<SchemeView[]>("scheme", "list"),
            runLantanaCtl<ServerView>("server", "status"),
        ]);
        devices = deviceLists.flat();
        schemes = schemeData;
        server = serverData;
        dashboards = (
            await Promise.all(
                accounts.map(async (account) => {
                    const records = await runLantanaCtl<
                        Array<Omit<DashboardView, "accountId">>
                    >("dashboard", "show", account.accountId);
                    return records.map((record) => ({
                        ...record,
                        accountId: account.accountId,
                    }));
                }),
            )
        ).flat();
        selectedEntry = null;
        createKind = null;
        createDashboard = null;
        editorMode = "view";
        await renderTree();
        await renderEditor();
        updateToolbar();
        connectionStatus.caption = `${accounts.length} akun · ${devices.length} device`;
    }

    async function renderTree(): Promise<void> {
        treeEntries = [];
        if (activeSection === "accounts") {
            const visited = new Set<string>();
            const append = (account: AccountView, depth: number) => {
                if (visited.has(account.accountId)) return;
                visited.add(account.accountId);
                treeEntries.push({
                    kind: "account",
                    record: account,
                    label: `${"  ".repeat(depth)}◉  ${account.accountId}`,
                });
                accounts
                    .filter((child) => child.parentId === account.accountId)
                    .sort((a, b) => a.accountId.localeCompare(b.accountId))
                    .forEach((child) => append(child, depth + 1));
            };
            accounts
                .filter((account) => !account.parentId)
                .sort((a, b) => a.accountId.localeCompare(b.accountId))
                .forEach((account) => append(account, 0));
            accounts.forEach((account) => append(account, 0));
        } else if (activeSection === "devices") {
            treeEntries = devices
                .slice()
                .sort((a, b) => a.accountId.localeCompare(b.accountId) || a.deviceId.localeCompare(b.deviceId))
                .map((record) => ({
                    kind: "device",
                    record,
                    label: `▣  ${record.meta.name || record.deviceId}  ·  ${record.accountId}`,
                }));
        } else if (activeSection === "schemes") {
            treeEntries = schemes
                .slice()
                .sort((a, b) => a.schemeId - b.schemeId)
                .map((record) => ({
                    kind: "scheme",
                    record,
                    label: `◇  ${record.schemeId}  ·  ${record.label}`,
                }));
        } else if (activeSection === "dashboards") {
            for (const dashboard of dashboards) {
                treeEntries.push({
                    kind: "dashboard",
                    record: dashboard,
                    label: `▤  ${dashboard.title}  ·  ${dashboard.accountId}`,
                });
                dashboard.dashboardItems.forEach((item, itemIndex) => {
                    treeEntries.push({
                        kind: "dashboardItem",
                        record: item,
                        dashboard,
                        itemIndex,
                        label: `    •  ${item.title}  (${item.type})`,
                    });
                });
            }
        } else if (server) {
            treeEntries.push({
                kind: "server",
                record: server,
                label: "⌁  Status layanan",
            });
        }

        treeList.items = treeEntries.map((entry) => entry.label);
        treeList.selectedIndex = -1;
        await treeList.refresh(form.screen);
        const section = SECTIONS.find((item) => item.key === activeSection);
        treeHeading.caption = section ? section.title.toUpperCase() : "ENTRI";
    }

    async function setFieldValue(
        field: Field,
        value: string,
        disabled: boolean,
    ): Promise<void> {
        if (field instanceof TEdit) {
            field.text = value;
            field.readOnly = disabled;
            if (screenReady) {
                await form.screen.update(field.id, { value });
            }
        } else {
            const index = field.items.indexOf(value);
            field.selectedIndex = index >= 0 ? index : 0;
            field.props.disabled = disabled;
            if (screenReady) {
                await form.screen.update(field.id, {
                    value: String(field.selectedIndex),
                    disabled,
                });
            }
        }
    }

    function setGroupVisible(group: TPanel, visible: boolean): void {
        group.style = { ...group.style, display: visible ? "flex" : "none" };
    }

    async function renderEditor(): Promise<void> {
        const kind = createKind || selectedEntry?.kind || null;
        const isCreating = editorMode === "create";
        const isReadOnly = editorMode === "view";
        setGroupVisible(accountGroup, kind === "account");
        setGroupVisible(deviceGroup, kind === "device");
        setGroupVisible(schemeGroup, kind === "scheme");
        setGroupVisible(dashboardGroup, kind === "dashboard");
        setGroupVisible(itemGroup, kind === "dashboardItem");
        setGroupVisible(serverGroup, kind === "server");
        emptyState.style = {
            ...emptyState.style,
            display: kind ? "none" : "block",
        };

        if (!kind) {
            editorHeading.caption = "Pilih entri";
            editorDescription.caption =
                "Pilih data di panel navigasi untuk melihat atau mengubah detailnya.";
            return;
        }

        const modeText = isCreating ? "Tambah" : editorMode === "edit" ? "Edit" : "Detail";
        if (kind === "account") {
            const account = selectedEntry?.kind === "account" ? selectedEntry.record : null;
            const name = isCreating ? "Akun baru" : account?.accountId || "Akun";
            editorHeading.caption = `${modeText} akun · ${name}`;
            editorDescription.caption = isCreating
                ? "Isi identitas akun dan izin. Parent ID kosong akan membuat akun root."
                : `${account?.parentId ? `Child dari ${account.parentId}` : "Akun root"} · ${account?.hasAccessKey ? "AccessKey tersedia" : "Belum ada AccessKey"}`;
            await setFieldValue(accountIdField, account?.accountId || "", isReadOnly || (!isCreating));
            await setFieldValue(accountParentField, account?.parentId || "", isReadOnly || !isCreating);
            await setFieldValue(
                accountInjectField,
                formatRanges(account?.permissions.allowedInjectSchemes || []),
                isReadOnly,
            );
            await setFieldValue(
                accountQueryField,
                formatRanges(account?.permissions.allowedQuerySchemes || []),
                isReadOnly,
            );
            await setFieldValue(
                accountCommandField,
                account?.permissions.allowedCommandDevices.join(",") || "",
                isReadOnly,
            );
        } else if (kind === "device") {
            const device = selectedEntry?.kind === "device" ? selectedEntry.record : null;
            editorHeading.caption = `${modeText} device · ${device?.meta.name || device?.deviceId || "Device baru"}`;
            editorDescription.caption = device
                ? `Terdaftar pada akun ${device.accountId}`
                : "Pilih akun pemilik device dan isi metadata awal.";
            await setFieldValue(deviceAccountField, device?.accountId || accounts[0]?.accountId || "", isReadOnly || !isCreating);
            await setFieldValue(deviceIdField, device?.deviceId || "Dibuat otomatis saat disimpan", true);
            await setFieldValue(deviceNameField, device?.meta.name || "", isReadOnly);
            await setFieldValue(deviceCityField, device?.meta.city || "", isReadOnly);
            await setFieldValue(deviceCategoryField, device?.meta.category || "", isReadOnly);
            await setFieldValue(deviceGroupField, device?.meta.group || "", isReadOnly);
        } else if (kind === "scheme") {
            const scheme = selectedEntry?.kind === "scheme" ? selectedEntry.record : null;
            editorHeading.caption = `${modeText} scheme · ${scheme?.schemeId ?? "Scheme baru"}`;
            editorDescription.caption = scheme
                ? `Dimiliki akun ${scheme.ownerAccountId}`
                : "Scheme ID harus unik dan bernilai integer positif.";
            await setFieldValue(schemeIdField, scheme ? String(scheme.schemeId) : "", isReadOnly || !isCreating);
            await setFieldValue(schemeOwnerField, scheme?.ownerAccountId || accounts[0]?.accountId || "", isReadOnly || !isCreating);
            await setFieldValue(schemeLabelField, scheme?.label || "", isReadOnly);
            await setFieldValue(schemeUnitField, scheme?.unit || "", isReadOnly);
            await setFieldValue(schemeTypeField, scheme?.type || "number", isReadOnly);
            await setFieldValue(schemeMinField, scheme?.min === undefined ? "" : String(scheme.min), isReadOnly);
            await setFieldValue(schemeMaxField, scheme?.max === undefined ? "" : String(scheme.max), isReadOnly);
        } else if (kind === "dashboard") {
            const dashboard =
                selectedEntry?.kind === "dashboard" ? selectedEntry.record : null;
            editorHeading.caption = `${modeText} dashboard · ${dashboard?.title || "Dashboard baru"}`;
            editorDescription.caption = dashboard
                ? `${dashboard.dashboardItems.length} item · ${dashboard.hasAccessKey ? "AccessKey tersedia" : "Belum ada AccessKey"}`
                : "Dashboard dibuat untuk akun yang dipilih; AccessKey ditampilkan sekali setelah dibuat.";
            await setFieldValue(dashboardAccountField, dashboard?.accountId || accounts[0]?.accountId || "", isReadOnly || !isCreating);
            await setFieldValue(dashboardIdField, dashboard ? String(dashboard.dashboardId) : "Dibuat otomatis", true);
            await setFieldValue(dashboardTitleField, dashboard?.title || "", isReadOnly);
            await setFieldValue(
                dashboardKeyField,
                dashboard ? (dashboard.hasAccessKey ? "Tersimpan (tidak dapat dibaca)" : "Belum diterbitkan") : "Diterbitkan saat membuat dashboard",
                true,
            );
        } else if (kind === "dashboardItem") {
            const entry = selectedEntry?.kind === "dashboardItem" ? selectedEntry : null;
            const dashboard = entry?.dashboard || createDashboard;
            const item = entry?.record || null;
            editorHeading.caption = `${modeText} item · ${item?.title || "Item baru"}`;
            editorDescription.caption = dashboard
                ? `Dashboard ${dashboard.title} · akun ${dashboard.accountId}`
                : "Item dashboard harus terkait pada dashboard yang tersedia.";
            await setFieldValue(itemAccountField, dashboard?.accountId || "", true);
            await setFieldValue(itemDashboardIdField, dashboard ? String(dashboard.dashboardId) : "", true);
            await setFieldValue(itemIndexField, entry ? String(entry.itemIndex) : "Item baru", true);
            await setFieldValue(itemTypeField, item?.type || "text", isReadOnly);
            await setFieldValue(itemTitleField, item?.title || "", isReadOnly);
            await setFieldValue(itemIconField, item?.icon || "", isReadOnly);
            await setFieldValue(itemIntervalField, String(item?.updateInterval ?? 5), isReadOnly);
            await setFieldValue(itemScrollField, item?.scrollAfter === undefined ? "" : String(item.scrollAfter), isReadOnly);
            await setFieldValue(itemDeviceField, item?.deviceId || "", isReadOnly);
            await setFieldValue(itemSchemeField, item ? String(item.schemeId) : "", isReadOnly);
        } else if (kind === "server") {
            const record = selectedEntry?.kind === "server" ? selectedEntry.record : server;
            editorHeading.caption = "Status layanan";
            editorDescription.caption = "Informasi runtime dibaca dari lantana-ctl.";
            serverDetails.caption = record
                ? `Fingerprint public key\n${record.fingerprint}\n\nPort layanan\n${Object.entries(record.ports)
                      .map(([port, config]) => `${port}: ${config.enabled === false ? "nonaktif" : "aktif"}`)
                      .join("\n") || "-"}\n\nKategori device\n${Object.entries(record.deviceCategories)
                      .map(
                          ([key, category]) =>
                              `${category.icon ? `${category.icon} ` : ""}${category.label || key}${category.description ? ` — ${category.description}` : ""}`,
                      )
                      .join("\n") || "-"}`
                : "Status server belum tersedia.";
        }

    }

    async function startCreate(): Promise<void> {
        if (activeSection === "server") return;
        selectedEntry = null;
        createDashboard = null;
        createKind =
            activeSection === "accounts"
                ? "account"
                : activeSection === "devices"
                  ? "device"
                  : activeSection === "schemes"
                    ? "scheme"
                    : "dashboard";
        editorMode = "create";
        treeList.selectedIndex = -1;
        await treeList.refresh(form.screen);
        await renderEditor();
        updateToolbar();
    }

    async function startCreateItem(): Promise<void> {
        const dashboard = getSelectedDashboard();
        if (!dashboard) throw new Error("Pilih dashboard terlebih dahulu.");
        createDashboard = dashboard;
        createKind = "dashboardItem";
        editorMode = "create";
        await renderEditor();
        updateToolbar();
    }

    async function startEdit(): Promise<void> {
        if (!selectedEntry || selectedEntry.kind === "server") return;
        createKind = null;
        createDashboard = null;
        editorMode = "edit";
        await renderEditor();
        updateToolbar();
    }

    async function cancelEditor(): Promise<void> {
        editorMode = "view";
        createKind = null;
        createDashboard = null;
        await renderEditor();
        updateToolbar();
    }

    function requiredValue(field: TEdit, name: string): string {
        const value = field.text.trim();
        if (!value) throw new Error(`${name} wajib diisi.`);
        return value;
    }

    function optionalFlag(args: string[], flag: string, field: TEdit): void {
        const value = field.text.trim();
        if (value) args.push(flag, value);
    }

    function numericValue(field: TEdit, name: string, optional = false): string | null {
        const value = field.text.trim();
        if (!value && optional) return null;
        if (!value || !Number.isFinite(Number(value))) {
            throw new Error(`${name} harus berupa angka${optional ? " atau dikosongkan" : ""}.`);
        }
        return value;
    }

    async function saveEditor(): Promise<void> {
        if (editorMode !== "create" && editorMode !== "edit") return;
        const kind = createKind || selectedEntry?.kind;
        if (!kind || kind === "server") throw new Error("Tidak ada editor yang aktif.");
        let oneTimeKey: string | null = null;
        let oneTimeDashboardId: number | null = null;

        if (editorMode === "create") {
            if (kind === "account") {
                const id = requiredValue(accountIdField, "Account ID");
                const parent = accountParentField.text.trim();
                const args = parent
                    ? ["account", "create-child", parent, id]
                    : ["account", "create-root", id];
                optionalFlag(args, "--inject", accountInjectField);
                optionalFlag(args, "--query", accountQueryField);
                optionalFlag(args, "--command", accountCommandField);
                await runLantanaCtl(...args);
            } else if (kind === "device") {
                const accountId = requiredValue(deviceAccountField, "Account ID");
                const args = ["device", "add", accountId];
                optionalFlag(args, "--name", deviceNameField);
                optionalFlag(args, "--city", deviceCityField);
                optionalFlag(args, "--category", deviceCategoryField);
                optionalFlag(args, "--group", deviceGroupField);
                const created = await runLantanaCtl<{ deviceId: string }>(...args);
                await form.alert("Device dibuat", `Device ID: ${created.deviceId}`);
            } else if (kind === "scheme") {
                const accountId = requiredValue(schemeOwnerField, "Owner account ID");
                const schemeId = requiredValue(schemeIdField, "Scheme ID");
                if (!/^[1-9]\d*$/.test(schemeId)) throw new Error("Scheme ID harus integer positif.");
                const args = [
                    "scheme",
                    "add",
                    accountId,
                    schemeId,
                    "--label",
                    requiredValue(schemeLabelField, "Label"),
                    "--type",
                    schemeTypeField.items[schemeTypeField.selectedIndex] || "number",
                ];
                optionalFlag(args, "--unit", schemeUnitField);
                const min = numericValue(schemeMinField, "Nilai minimum", true);
                const max = numericValue(schemeMaxField, "Nilai maksimum", true);
                if (min !== null) args.push("--min", min);
                if (max !== null) args.push("--max", max);
                await runLantanaCtl(...args);
            } else if (kind === "dashboard") {
                const accountId = requiredValue(dashboardAccountField, "Account ID");
                const title = requiredValue(dashboardTitleField, "Judul dashboard");
                const result = await runLantanaCtl<{ dashboardAccessKey: string; dashboardId: number }>(
                    "dashboard",
                    "key-issue",
                    accountId,
                    "--title",
                    title,
                );
                oneTimeKey = result.dashboardAccessKey;
                oneTimeDashboardId = result.dashboardId;
            } else if (kind === "dashboardItem") {
                const dashboard = createDashboard;
                if (!dashboard) throw new Error("Dashboard induk tidak ditemukan.");
                const args = dashboardItemArgs(dashboard.accountId, dashboard.dashboardId, "new");
                await runLantanaCtl(...args);
            }
        } else if (selectedEntry) {
            if (selectedEntry.kind === "account") {
                const args = [
                    "account",
                    "permissions",
                    selectedEntry.record.accountId,
                ];
                optionalFlag(args, "--inject", accountInjectField);
                optionalFlag(args, "--query", accountQueryField);
                optionalFlag(args, "--command", accountCommandField);
                await runLantanaCtl(...args);
            } else if (selectedEntry.kind === "device") {
                const device = selectedEntry.record;
                const args = [
                    "device",
                    "update",
                    device.accountId,
                    device.deviceId,
                ];
                addMetadataFlag(args, "--name", deviceNameField);
                addMetadataFlag(args, "--city", deviceCityField);
                addMetadataFlag(args, "--category", deviceCategoryField);
                addMetadataFlag(args, "--group", deviceGroupField);
                if (args.length === 4) throw new Error("Tidak ada metadata yang diubah.");
                await runLantanaCtl(...args);
            } else if (selectedEntry.kind === "scheme") {
                const scheme = selectedEntry.record;
                const args = [
                    "scheme",
                    "update",
                    scheme.ownerAccountId,
                    String(scheme.schemeId),
                    "--label",
                    requiredValue(schemeLabelField, "Label"),
                    "--type",
                    schemeTypeField.items[schemeTypeField.selectedIndex] || "number",
                ];
                const unit = schemeUnitField.text.trim();
                if (unit) args.push("--unit", unit);
                else args.push("--clear-unit");
                addOptionalNumber(args, "--min", "--clear-min", schemeMinField, "Nilai minimum");
                addOptionalNumber(args, "--max", "--clear-max", schemeMaxField, "Nilai maksimum");
                await runLantanaCtl(...args);
            } else if (selectedEntry.kind === "dashboard") {
                await runLantanaCtl(
                    "dashboard",
                    "update",
                    selectedEntry.record.accountId,
                    String(selectedEntry.record.dashboardId),
                    "--title",
                    requiredValue(dashboardTitleField, "Judul dashboard"),
                );
            } else if (selectedEntry.kind === "dashboardItem") {
                await runLantanaCtl(
                    ...dashboardItemArgs(
                        selectedEntry.dashboard.accountId,
                        selectedEntry.dashboard.dashboardId,
                        String(selectedEntry.itemIndex),
                    ),
                );
            }
        }

        await refresh();
        connectionStatus.caption = "Perubahan tersimpan";
        if (oneTimeKey) {
            await form.alert(
                "Dashboard dibuat",
                `Dashboard ID: ${oneTimeDashboardId}\nAccessKey (hanya ditampilkan sekali):\n${oneTimeKey}`,
            );
        }
    }

    function addMetadataFlag(args: string[], flag: string, field: TEdit): void {
        const value = field.text.trim();
        if (value) args.push(flag, value);
        else args.push(`--clear-${flag.slice(2)}`);
    }

    function addOptionalNumber(
        args: string[],
        flag: string,
        clearFlag: string,
        field: TEdit,
        name: string,
    ): void {
        const value = numericValue(field, name, true);
        if (value === null) args.push(clearFlag);
        else args.push(flag, value);
    }

    function dashboardItemArgs(accountId: string, dashboardId: number, index: string): string[] {
        const type = itemTypeField.items[itemTypeField.selectedIndex] || "text";
        const args = [
            "dashboard",
            "item-set",
            accountId,
            String(dashboardId),
            index,
            "--type",
            type,
            "--title",
            requiredValue(itemTitleField, "Judul item"),
            "--icon",
            requiredValue(itemIconField, "Icon"),
            "--interval",
            requiredValue(itemIntervalField, "Update interval"),
            "--device-id",
            requiredValue(itemDeviceField, "Device ID"),
            "--scheme-id",
            requiredValue(itemSchemeField, "Scheme ID"),
        ];
        if (!/^[1-9]\d*$/.test(args[args.indexOf("--interval") + 1])) {
            throw new Error("Update interval harus integer positif.");
        }
        if (!/^[1-9]\d*$/.test(args[args.indexOf("--scheme-id") + 1])) {
            throw new Error("Scheme ID harus integer positif.");
        }
        const scrollAfter = itemScrollField.text.trim();
        if (scrollAfter) {
            if (!Number.isFinite(Number(scrollAfter))) {
                throw new Error("Scroll after harus berupa angka.");
            }
            args.push("--scroll-after", scrollAfter);
        }
        return args;
    }

    async function deleteRecord(): Promise<void> {
        const entry = selectedEntry;
        if (!entry || entry.kind === "server") return;
        const title =
            entry.kind === "dashboardItem"
                ? `item "${entry.record.title}"`
                : entry.kind === "account"
                  ? `akun "${entry.record.accountId}"`
                  : entry.kind === "device"
                    ? `device "${entry.record.deviceId}"`
                    : entry.kind === "scheme"
                      ? `scheme ${entry.record.schemeId}`
                      : `dashboard "${entry.record.title}"`;
        const answer = await form.confirm(
            "Konfirmasi penghapusan",
            `Yakin ingin menghapus ${title}?`,
            ["Hapus", "Batal"],
        );
        if (answer !== "Hapus") return;

        if (entry.kind === "account") {
            await runLantanaCtl("account", "remove", entry.record.accountId);
        } else if (entry.kind === "device") {
            await runLantanaCtl("device", "remove", entry.record.accountId, entry.record.deviceId);
        } else if (entry.kind === "scheme") {
            await runLantanaCtl(
                "scheme",
                "remove",
                entry.record.ownerAccountId,
                String(entry.record.schemeId),
            );
        } else if (entry.kind === "dashboard") {
            await runLantanaCtl(
                "dashboard",
                "delete",
                entry.record.accountId,
                String(entry.record.dashboardId),
            );
        } else if (entry.kind === "dashboardItem") {
            await runLantanaCtl(
                "dashboard",
                "item-remove",
                entry.dashboard.accountId,
                String(entry.dashboard.dashboardId),
                String(entry.itemIndex),
            );
        }
        await refresh();
        connectionStatus.caption = "Data dihapus";
    }

    async function manageKey(): Promise<void> {
        const entry = selectedEntry;
        if (!entry) return;
        if (entry.kind === "account") {
            const action = entry.record.hasAccessKey ? "key-rotate" : "key-issue";
            const result = await runLantanaCtl<{ accessKey: string }>(
                "account",
                action,
                entry.record.accountId,
            );
            await form.alert(
                action === "key-issue" ? "AccessKey diterbitkan" : "AccessKey dirotasi",
                `Simpan key ini sekarang; setelah dialog ditutup, key tidak dapat dibaca lagi:\n${result.accessKey}`,
            );
        } else if (entry.kind === "dashboard") {
            const result = await runLantanaCtl<{ dashboardAccessKey: string }>(
                "dashboard",
                "key-rotate",
                entry.record.accountId,
                String(entry.record.dashboardId),
            );
            await form.alert(
                entry.record.hasAccessKey ? "Dashboard key dirotasi" : "Dashboard key diterbitkan",
                `Simpan key ini sekarang; setelah dialog ditutup, key tidak dapat dibaca lagi:\n${result.dashboardAccessKey}`,
            );
        }
        await refresh();
    }

    async function revokeKey(): Promise<void> {
        const entry = selectedEntry;
        if (!entry) return;
        const answer = await form.confirm(
            "Konfirmasi pencabutan key",
            "Key yang dicabut tidak bisa digunakan lagi untuk autentikasi. Lanjutkan?",
            ["Cabut", "Batal"],
        );
        if (answer !== "Cabut") return;
        if (entry.kind === "account") {
            await runLantanaCtl("account", "key-revoke", entry.record.accountId);
        } else if (entry.kind === "dashboard") {
            await runLantanaCtl(
                "dashboard",
                "key-revoke",
                entry.record.accountId,
                String(entry.record.dashboardId),
            );
        }
        await refresh();
    }
});
