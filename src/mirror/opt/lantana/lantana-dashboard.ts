/**
 * lantana-dashboard.ts — Lantana Consumer: Dashboard (GUI) — port Cashew
 *
 * Dashboard multi-device untuk Lantana (di-porting dari Emerald ke Cashew).
 * Menampilkan:
 *  - Daftar device (multi-device) dengan kategori, tenant, grup, dan status
 *    heartbeat (ONLINE/STALE/OFFLINE dari umur data / dataAgeMs)
 *  - Kartu sensor per device (kategori statis dari config)
 *  - Memo status + auto scroll ke bawah
 *  - Filter tenant
 *
 * Usage (dari Asteracea/CLI):
 *   lantana-dashboard                (auto-detect daemon Lantana via UUID)
 *   lantana-dashboard <lantanaPid>   (target eksplisit)
 *   lantana-dashboard <target> <tenantFilter>
 *
 * (c) 2026 TSIX Project — Lantana
 */

import { Program, shell } from "@tsix/Application";
import {
    TForm,
    TPanel,
    TLabel,
    TMemo,
    TStatusBar,
    TTimer,
} from "@tsix/cashew";
import { LANTANA_UUID, DeviceStatusInfo } from "@tsix/lantana/lantana-core";

export const appMode = "gui";

/** Key gabungan tenant + nodeId (nodeId boleh sama antar tenant). */
const dkey = (tenant: string, nodeId: string) => `${tenant}::${nodeId}`;

export const main = Program(async (args: string[]) => {
    const target = args[0] || LANTANA_UUID;
    const tenantFilter = args[1] && !args[1].startsWith("--") ? args[1] : undefined;

    const lib = (global as any)._tsixLib;

    // ── State ──
    const devices = new Map<string, DeviceStatusInfo>(); // tenant::nodeId → info
    const sensorMap = new Map<string, any>();            // tenant::nodeId → { id: reading }
    let statusBuf = "";

    const statusColor = (s: string) =>
        s === "ONLINE" ? "#4caf50" : s === "STALE" ? "#ff9800" : "#f44336";

    // ── Form ──
    const form = new TForm({
        title: "🌺 Lantana IoT Dashboard",
        icon: "🌺",
        width: 980,
        height: 680,
        style: { display: "grid", gridTemplateColumns: "1fr", gap: "10px", padding: "12px" },
    });

    // Header info
    const headerLabel = new TLabel("dash-header", {
        caption: `Target: ${target}${tenantFilter ? ` | Tenant: ${tenantFilter}` : ""} | 🔴 Disconnected`,
        style: { fontWeight: "700", fontSize: "14px", color: "var(--accent, #4caf50)" },
    });
    form.add(headerLabel);

    // Daftar device (diisi dinamis)
    const deviceList = new TPanel("device-list", {
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        overflowY: "auto",
        maxHeight: "300px",
    });
    form.add(deviceList);

    // Memo status (auto scroll bottom)
    const statusMemo = new TMemo("status-memo", {
        rows: 12,
        text: "⏳ Starting...\n",
        style: { fontFamily: "monospace", fontSize: "11px", width: "100%", resize: "vertical" },
    });
    form.add(statusMemo);

    const statusBar = new TStatusBar("status-bar", {
        leftText: `🌺 Lantana | ${target}`,
        rightText: tenantFilter ? `Tenant: ${tenantFilter}` : "All tenants",
    });
    statusBar.style = { gridColumn: "1 / -1" };
    form.add(statusBar);

    // ── Helpers ──
    const log = async (m: string) => {
        statusBuf += m + "\n";
        if (statusBuf.length > 6000) statusBuf = statusBuf.slice(-6000);
        statusMemo.text = statusBuf;
        // Auto scroll ke bawah
        await statusMemo.scrollToBottom().catch(() => { });
    };

    /** Build DOM node sederhana untuk satu baris device. */
    const node = (id: string, tag: string, props: Record<string, any>, children: any[] = []): any =>
        ({ id, tag, props, children });

    /** Rebuild daftar device (dikelompokkan per grup tenant). */
    const renderDeviceList = async () => {
        const screen = form.screen;
        if (!screen) return;

        const visible = Array.from(devices.values())
            .filter((d) => !tenantFilter || d.tenant === tenantFilter);

        if (visible.length === 0) {
            await screen.setContent("device-list",
                node("device-empty", "span", {
                    text: "⏳ Menunggu data dari daemon Lantana...",
                    style: { fontSize: "12px", color: "var(--text-dim, #999)" },
                }),
            );
            return;
        }

        // Kelompokkan per grup (deviceGroupMap), fallback "Ungrouped"
        const grouped = new Map<string, DeviceStatusInfo[]>();
        for (const d of visible) {
            const g = d.group || "Ungrouped";
            if (!grouped.has(g)) grouped.set(g, []);
            grouped.get(g)!.push(d);
        }

        const rows: any[] = [];
        for (const [g, list] of grouped.entries()) {
            rows.push(node(`grp-${g}`, "div", {
                text: `▸ ${g}  (${list.length} device)`,
                style: { fontWeight: "700", fontSize: "12px", color: "var(--accent, #4caf50)", marginTop: "6px" },
            }));

            for (const d of list) {
                const k = dkey(d.tenant, d.nodeId);
                const ageStr = d.dataAgeMs >= 0 ? `${(d.dataAgeMs / 1000).toFixed(1)}s` : "—";

                // Nilai sensor diambil langsung dari sensorMap (bukan cuma daftar ID).
                // Format: 01=39 °C 02=14 % ... — fallback ke daftar ID bila belum ada data.
                const sensObj = sensorMap.get(k) || {};
                const sensKeys = Object.keys(sensObj);
                const sensorText = sensKeys.length > 0
                    ? sensKeys.map((sk) => {
                        const s = sensObj[sk];
                        return `${s.id}=${s.value}${s.unit ? " " + s.unit : ""}`;
                    }).join("  ")
                    : `sensors: ${d.sensorIds.join(", ") || "—"}`;

                rows.push(node(`dev-${k}`, "div", {
                    style: {
                        display: "flex", justifyContent: "space-between", alignItems: "center",
                        background: "var(--surface, #16213e)", borderRadius: "8px", padding: "10px 14px",
                        border: `1px solid ${statusColor(d.status)}44`,
                    },
                }, [
                    node(`devl-${k}`, "div", { style: { display: "flex", flexDirection: "column", gap: "2px" } }, [
                        node(`devt-${k}`, "span", { text: `${d.label} (${d.nodeId})`, style: { fontWeight: "600", fontSize: "13px" } }),
                        node(`devm-${k}`, "span", { text: `tenant: ${d.tenant} · cat: ${d.category}${d.group ? " · grp: " + d.group : ""}`, style: { fontSize: "11px", color: "var(--text-dim, #999)" } }),
                        node(`devs-${k}`, "span", { text: sensorText, style: { fontSize: "11px", color: "var(--text-dim, #999)" } }),
                    ]),
                    node(`devr-${k}`, "div", { style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "2px" } }, [
                        node(`devst-${k}`, "span", { text: d.status, style: { color: statusColor(d.status), fontWeight: "700", fontSize: "12px" } }),
                        node(`deva-${k}`, "span", { text: `${ageStr} ago`, style: { fontSize: "11px", color: "var(--text-muted, #777)" } }),
                    ]),
                ]));
            }
        }

        await screen.setContent("device-list", ...rows);
    };

    // ── Handler IPC ──
    form.onSetup = async () => {
        headerLabel.caption = `Target: ${target}${tenantFilter ? ` | Tenant: ${tenantFilter}` : ""} | 🟢 Connected`;
        statusBar.leftText = `🌺 Lantana | ${target}`;
        statusBar.rightText = tenantFilter ? `Tenant: ${tenantFilter}` : "All tenants";

        if (lib?.onEvent) {
            lib.onEvent("ipc_message", async (msg: any) => {
                const payload = msg?.data || msg;
                if (!payload || typeof payload !== "object") return;

                if (payload.type === "LANTANA_SENSOR_DATA") {
                    const data = payload.data;
                    if (tenantFilter && data.tenant !== tenantFilter) return;
                    const k = dkey(data.tenant, data.nodeId);

                    log(`📥 [${new Date(data.receivedAt || Date.now()).toLocaleTimeString()}] ${data.tenant}/${data.nodeId} (${data.format}) → ${data.sensors.length} sensor, age ${data.dataAgeMs}ms`);

                    const sensors: any = { ...(sensorMap.get(k) || {}) };
                    for (const s of data.sensors || []) {
                        sensors[s.id] = {
                            id: s.id,
                            label: s.label,
                            unit: s.unit,
                            value: s.value,
                            category: s.category,
                        };
                    }
                    sensorMap.set(k, sensors);

                    const dev = devices.get(k);
                    if (dev) {
                        dev.lastDataAt = data.receivedAt;
                        dev.dataAgeMs = data.dataAgeMs;
                        dev.status = data.deviceStatus;
                        devices.set(k, dev);
                    }

                    await renderDeviceList();
                } else if (payload.type === "LANTANA_DEVICE_STATUS") {
                    for (const d of payload.data || []) {
                        devices.set(dkey(d.tenant, d.nodeId), d);
                    }
                    await renderDeviceList();
                } else if (payload.type === "LANTANA_SNAPSHOT_REPLY") {
                    log(`📦 Snapshot diterima: ${payload.data.devices.length} device`);
                    for (const dev of payload.data.devices || []) {
                        const k = dkey(dev.tenant, dev.nodeId);
                        devices.set(k, dev);
                        const sd = (payload.data.sensorData || []).find(
                            (x: any) => x.nodeId === dev.nodeId && x.tenant === dev.tenant,
                        );
                        if (sd) {
                            const sensors: any = {};
                            for (const s of sd.sensors || []) {
                                sensors[s.id] = { id: s.id, label: s.label, unit: s.unit, value: s.value, category: s.category };
                            }
                            sensorMap.set(k, sensors);
                        }
                    }
                    await renderDeviceList();
                }
            });
        }

        await shell.send(target, { type: "LANTANA_REGISTER", name: "dashboard", tenant: tenantFilter, fromPid: lib?.getPid?.() }).catch(() => { });
        await shell.send(target, { type: "LANTANA_SNAPSHOT", fromPid: lib?.getPid?.() }).catch(() => { });
    };

    // Polling snapshot tiap 3 detik (menggantikan while loop)
    const timer = new TTimer({ interval: 3000, enabled: true });
    timer.onTimer = async () => {
        try {
            await shell.send(target, { type: "LANTANA_SNAPSHOT", fromPid: lib?.getPid?.() });
        } catch (_) { }
    };
    form.add(timer);

    await form.run();
});
