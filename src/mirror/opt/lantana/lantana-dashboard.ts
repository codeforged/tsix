/**
 * lantana-dashboard.ts — Lantana Consumer: Dashboard (GUI)
 *
 * Dashboard multi-device untuk Lantana. Menampilkan:
 *  - Daftar device (multi-device) dengan kategori, tenant, dan status
 *    heartbeat (ONLINE/STALE/OFFLINE dari umur data / dataAgeMs)
 *  - Kartu sensor per device (kategori statis dari config)
 *  - Filter tenant
 *
 * Usage (dari Asteracea/CLI):
 *   lantana-dashboard                (auto-detect daemon Lantana via UUID)
 *   lantana-dashboard <lantanaPid>   (target eksplisit)
 *   lantana-dashboard <target> <tenantFilter>
 *
 * (c) 2026 TSIX Project — Lantana
 */

import { Program, std, shell } from "@tsix/Application";
import { Screen, div, span, h1, h2, sensorCard, lineChart } from "@tsix/emerald";
import { theme } from "@tsix/theme";
import { LANTANA_UUID, DEVICE_STALE_MS, DEVICE_OFFLINE_MS, NormalizedSensorData, DeviceStatusInfo } from "@tsix/lantana/lantana-core";

export const appMode = "gui";

export const main = Program(async (args: string[]) => {
    await theme.loadCurrent();
    theme.watch();

    const target = args[0] || LANTANA_UUID;
    const tenantFilter = args[1] && !args[1].startsWith("--") ? args[1] : undefined;

    const app = new Screen({ title: "🌺 Lantana IoT Dashboard", width: 980, height: 680 });

    // State
    const devices = new Map<string, DeviceStatusInfo>();
    const sensorMap = new Map<string, any>(); // nodeId → { id: reading }
    const history: Record<string, number[]> = {};
    let pktCnt = 0;
    let statusBuf = "";
    let autoScroll = true;

    await app.mount(
        div({ id: "root", style: { padding: "14px", height: "100%", display: "flex", flexDirection: "column", gap: "10px", overflowY: "auto", background: theme.colors.bg, color: theme.colors.text } },
            // HEADER
            div({ style: { display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: "0" } },
                h1({ text: "🌺 Lantana IoT Dashboard", style: { fontSize: "22px", color: theme.colors.accent, margin: "0" } }),
                span({ id: "header-info", text: `Target: ${target} | 🔴 Disconnected`, style: { fontSize: "12px", color: theme.colors.textMuted } }),
            ),
            // DEVICE LIST
            div({ id: "devices-header", style: { flexShrink: "0" } },
                h2({ text: "📡 Devices", style: { fontSize: "15px", color: theme.colors.accent, margin: "4px 0 6px" } }),
            ),
            div({ id: "device-list", style: { display: "flex", flexDirection: "column", gap: "8px", flexShrink: "0" } },
                span({ id: "device-empty", text: "⏳ Menunggu data dari daemon Lantana...", style: { fontSize: "12px", color: theme.colors.textDim } }),
            ),
            // STATUS LOG
            div({ id: "status-header", style: { flexShrink: "0" } },
                h2({ text: "📋 Status", style: { fontSize: "15px", color: theme.colors.accent, margin: "4px 0 6px" } }),
            ),
            div({ id: "status-scroll", style: { flex: "1", background: theme.colors.bgAlt, borderRadius: "8px", padding: "10px", overflowY: "auto", fontSize: "11px", fontFamily: "monospace", color: theme.colors.textDim, minHeight: "60px" } },
                span({ id: "status-txt", text: "⏳ Starting...\n" }),
            ),
        ),
    );

    const log = async (m: string) => {
        if (!app.running) return;
        statusBuf += m + "\r\n";
        if (statusBuf.length > 3000) statusBuf = statusBuf.slice(-3000);
        try {
            await app.update("status-txt", { text: statusBuf });
            if (autoScroll) await app.update("status-scroll", { scrollTop: 999999 });
        } catch (_) { /* window destroyed */ }
    };

    const statusColor = (s: string) => (s === "ONLINE" ? "#4caf50" : s === "STALE" ? "#ff9800" : "#f44336");

    const renderDeviceList = async () => {
        if (!app.running) return;
        const visible = Array.from(devices.values())
            .filter((d) => !tenantFilter || d.tenant === tenantFilter);

        if (visible.length === 0) {
            await app.setContent("device-list",
                span({ id: "device-empty", text: "⏳ Menunggu data dari daemon Lantana...", style: { fontSize: "12px", color: theme.colors.textDim } }),
            );
            return;
        }

        const cards: any[] = [];
        for (const d of visible) {
            const ageStr = d.dataAgeMs >= 0 ? `${(d.dataAgeMs / 1000).toFixed(1)}s` : "—";
            cards.push(div({ id: `dev-${d.nodeId}`, style: { display: "flex", justifyContent: "space-between", alignItems: "center", background: theme.colors.card, borderRadius: "8px", padding: "10px 14px", border: `1px solid ${statusColor(d.status)}44` } },
                div({ style: { display: "flex", flexDirection: "column", gap: "2px" } },
                    span({ text: `${d.label} (${d.nodeId})`, style: { fontWeight: "600", fontSize: "13px" } }),
                    span({ text: `tenant: ${d.tenant} · cat: ${d.category}`, style: { fontSize: "11px", color: theme.colors.textDim } }),
                    span({ id: `dev-sensors-${d.nodeId}`, text: `sensors: ${d.sensorIds.join(", ") || "—"}`, style: { fontSize: "11px", color: theme.colors.textDim } }),
                ),
                div({ style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "2px" } },
                    span({ id: `dev-status-${d.nodeId}`, text: d.status, style: { color: statusColor(d.status), fontWeight: "700", fontSize: "12px" } }),
                    span({ id: `dev-age-${d.nodeId}`, text: `${ageStr} ago`, style: { fontSize: "11px", color: theme.colors.textMuted } }),
                ),
            ));
        }
        await app.setContent("device-list", ...cards);
    };

    /** Render nilai sensor per device sebagai teks (di span dev-sensors-*). */
    const renderAllSensors = async () => {
        if (!app.running) return;
        for (const nodeId of sensorMap.keys()) {
            const sensors = sensorMap.get(nodeId);
            if (!sensors) continue;
            const parts: string[] = [];
            for (const key of Object.keys(sensors)) {
                const s = sensors[key];
                parts.push(`${s.id}=${s.value}${s.unit ? " " + s.unit : ""}`);
            }
            try {
                await app.update(`dev-sensors-${nodeId}`, { text: parts.join("  ") || "—" });
            } catch (_) { /* window destroyed / belum ada */ }
        }
    };

    // Tangani data sensor masuk
    const handleSensorData = (data: any) => {
        if (!app.running) return;
        pktCnt++;
        const nodeId = data.nodeId;
        const sensors: any = {};
        for (const s of data.sensors || []) {
            sensors[s.id] = {
                id: s.id,
                label: s.label,
                unit: s.unit,
                icon: undefined,
                color: undefined,
                value: s.value,
                category: s.category,
            };
            // History per sensor (node+sensor)
            const hk = `${nodeId}:${s.id}`;
            if (!history[hk]) history[hk] = [];
            history[hk].push(s.value);
            if (history[hk].length > 30) history[hk].shift();
        }
        sensorMap.set(nodeId, { ...(sensorMap.get(nodeId) || {}), ...sensors });
    };

    const handleDeviceStatus = (data: any) => {
        if (!app.running) return;
        for (const d of data || []) {
            devices.set(d.nodeId, d);
        }
        renderDeviceList().catch(() => { });
        renderAllSensors().catch(() => { });
    };

    await log(`🔌 Target: ${target}`);
    await log("⏳ Registering ke distributor...\n");

    const lib = (global as any)._tsixLib;
    if (lib?.onEvent) {
        lib.onEvent("ipc_message", (msg: any) => {
            if (!app.running) return;
            const payload = msg?.data || msg;
            if (!payload || typeof payload !== "object") return;
            if (payload.type === "LANTANA_SENSOR_DATA") {
                const data = payload.data;
                if (tenantFilter && data.tenant !== tenantFilter) return;
                log(`📥 [${new Date(data.receivedAt || Date.now()).toLocaleTimeString()}] ${data.tenant}/${data.nodeId} (${data.format}) → ${data.sensors.length} sensor, age ${data.dataAgeMs}ms`);
                handleSensorData(data);
                // update device status via data
                const dev = devices.get(data.nodeId);
                if (dev) {
                    dev.lastDataAt = data.receivedAt;
                    dev.dataAgeMs = data.dataAgeMs;
                    dev.status = data.deviceStatus;
                    devices.set(data.nodeId, dev);
                }
                renderDeviceList().catch(() => { });
                renderAllSensors().catch(() => { });
            } else if (payload.type === "LANTANA_DEVICE_STATUS") {
                handleDeviceStatus(payload.data);
            } else if (payload.type === "LANTANA_SNAPSHOT_REPLY") {
                log(`📦 Snapshot diterima: ${payload.data.devices.length} device`);
                for (const dev of payload.data.devices || []) {
                    devices.set(dev.nodeId, dev);
                    const sd = (payload.data.sensorData || []).find((x: any) => x.nodeId === dev.nodeId);
                    if (sd) {
                        const sensors: any = {};
                        for (const s of sd.sensors || []) {
                            sensors[s.id] = { id: s.id, label: s.label, unit: s.unit, value: s.value, category: s.category };
                        }
                        sensorMap.set(dev.nodeId, sensors);
                    }
                }
                renderDeviceList().catch(() => { });
                renderAllSensors().catch(() => { });
            }
        });
    }

    app.win.bindHandler("status-scroll", "scroll", (ev: any) => {
        const st = ev?.scrollTop ?? 0, sh = ev?.scrollHeight ?? 1, ch = ev?.clientHeight ?? 1;
        autoScroll = (sh - st - ch) < 20;
    });

    app.win.onClose(() => { app.running = false; });

    // Register ke distributor
    await shell.send(target, { type: "LANTANA_REGISTER", name: "dashboard", tenant: tenantFilter, fromPid: lib?.getPid?.() }).catch(() => { });
    await shell.send(target, { type: "LANTANA_SNAPSHOT", fromPid: lib?.getPid?.() }).catch(() => { });

    await app.win.flush();

    while (app.running) {
        try {
            await shell.send(target, { type: "LANTANA_SNAPSHOT", fromPid: lib?.getPid?.() });
        } catch (_) { }
        await new Promise((r) => setTimeout(r, 3000));
    }
    await app.close();
});
