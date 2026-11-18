/**
 * lantana-dashboard.ts — Lantana Consumer: Dashboard (GUI) — port Cashew
 *
 * Dashboard multi-device untuk Lantana (di-porting dari Emerald ke Cashew).
 * Menampilkan:
 *  - Daftar device (multi-device) dengan kategori, akun, grup, dan status
 *    heartbeat (ONLINE/STALE/OFFLINE dari umur data / dataAgeMs)
 *  - Kartu sensor per device (kategori statis dari config)
 *  - Memo status + auto scroll ke bawah
 *  - Filter akun (accountId)
 *
 * Usage (dari Asteracea/CLI):
 *   lantana-dashboard                        (auto-detect daemon via UUID)
 *   lantana-dashboard <lantanaPid>           (target eksplisit)
 *   lantana-dashboard <target> <accountId>   (filter akun)
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
import {
    DeviceStatusInfo,
    EVT_DEVICE_STATUS,
    EVT_READING,
    EVT_SNAPSHOT_REPLY,
    LANTANA_UUID,
    resolveDaemonTarget,
} from "@tsix/lantana/lantana-core";

export const appMode = "gui";

/** Key internal dashboard: accountId + deviceId. */
const dkey = (accountId: string, deviceId: string) => `${accountId}::${deviceId}`;

export const main = Program(async (args: string[]) => {
    // Argumen fleksibel:
    //   lantana-dashboard                       → daemon via UUID, tanpa filter akun
    //   lantana-dashboard juragan               → daemon via UUID, filter akun
    //   lantana-dashboard 7 juragan             → daemon PID 7, filter akun
    //   lantana-dashboard <uuid> juragan        → daemon identity UUID
    const looksLikeTarget = (v?: string) =>
        !!v && (/^\d+$/.test(v) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v));

    let target: number | string = resolveDaemonTarget();
    let accountId: string | undefined;
    if (looksLikeTarget(args[0])) {
        target = resolveDaemonTarget(args[0]);
        accountId = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
    } else {
        accountId = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
    }

    const lib = (global as any)._tsixLib;

    // ── State ──
    const devices = new Map<string, DeviceStatusInfo>(); // accountId::deviceId → info
    const sensorMap = new Map<string, any>();            // accountId::deviceId → { schemeId: reading }
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
        caption: `Target: ${target}${accountId ? ` | Akun: ${accountId}` : ""} | 🔴 Disconnected`,
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
        rightText: accountId ? `Akun: ${accountId}` : "Pilih akun",
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

    // ── Serializer render: pastikan setContent tidak pernah tumpang tindih ──
    // (dua event IPC bisa datang hampir bersamaan; dua setContent paralel
    //  bisa interleave clear+mount → menghasilkan duplikasi di DOM).
    let renderChain: Promise<void> = Promise.resolve();
    const renderDeviceList = async () => {
        // Antar render berikutnya di belakang render yang sedang berjalan.
        const run = renderChain.then(async () => {
            const screen = form.screen;
            if (!screen) return;

            const visible = Array.from(devices.values())
                .filter((d) => !accountId || d.accountId === accountId);

            if (visible.length === 0) {
                await screen.setContent("device-list",
                    node("device-empty", "span", {
                        text: "⏳ Menunggu data dari daemon Lantana...",
                        style: { fontSize: "12px", color: "var(--text-dim, #999)" },
                    }),
                );
                return;
            }

            // Kelompokkan per grup dari konfigurasi device, fallback "Ungrouped"
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
                    const k = dkey(d.accountId, d.deviceId);
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
                        : `scheme: ${d.schemeIds.join(", ") || "—"}`;

                    rows.push(node(`dev-${k}`, "div", {
                        style: {
                            display: "flex", justifyContent: "space-between", alignItems: "center",
                            background: "var(--surface, #16213e)", borderRadius: "8px", padding: "10px 14px",
                            border: `1px solid ${statusColor(d.status)}44`,
                        },
                    }, [
                        node(`devl-${k}`, "div", { style: { display: "flex", flexDirection: "column", gap: "2px" } }, [
                            node(`devt-${k}`, "span", { text: `${d.name} (${d.deviceId})`, style: { fontWeight: "600", fontSize: "13px" } }),
                            node(`devm-${k}`, "span", { text: `akun: ${d.accountId} · cat: ${d.category}${d.city ? " · " + d.city : ""}${d.group ? " · grp: " + d.group : ""}`, style: { fontSize: "11px", color: "var(--text-dim, #999)" } }),
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
        });
        renderChain = run;
        return run;
    };

    // ── Handler IPC ──
    let connected = false;
    const markConnected = () => {
        if (connected) return;
        connected = true;
        headerLabel.caption = `Target: ${target}${accountId ? ` | Akun: ${accountId}` : ""} | 🟢 Connected`;
        statusBar.leftText = `🌺 Lantana | ${target}`;
        statusBar.rightText = accountId ? `Akun: ${accountId}` : "Pilih akun";
    };

    form.onSetup = async () => {
        headerLabel.caption = `Target: ${target}${accountId ? ` | Akun: ${accountId}` : ""} | 🟢 Connected`;
        statusBar.leftText = `🌺 Lantana | ${target}`;
        statusBar.rightText = accountId ? `Akun: ${accountId}` : "Pilih akun";

        if (lib?.onEvent) {
            lib.onEvent("ipc_message", async (msg: any) => {
                const payload = msg?.data || msg;
                if (!payload || typeof payload !== "object") return;

                if (payload.type === EVT_READING) {
                    const data = payload.data;
                    if (accountId && data.accountId !== accountId) return;
                    markConnected();
                    const k = dkey(data.accountId, data.deviceId);

                    log(`📥 [${new Date(data.receivedAt || Date.now()).toLocaleTimeString()}] ${data.accountId}/${data.deviceId} → ${data.readings.length} bacaan`);

                    const sensors: any = { ...(sensorMap.get(k) || {}) };
                    for (const s of data.readings || []) {
                        sensors[String(s.schemeId)] = {
                            id: s.schemeId,
                            label: s.label,
                            unit: s.unit,
                            value: s.value,
                            category: s.label,
                        };
                    }
                    sensorMap.set(k, sensors);

                    // Device bisa muncul lewat bacaan sebelum status berkala tiba.
                    let dev = devices.get(k);
                    const schemeIds = (data.readings || []).map((r: any) => r.schemeId);
                    if (!dev) {
                        dev = {
                            accountId: data.accountId,
                            deviceId: data.deviceId,
                            name: data.name || data.deviceId,
                            category: data.category || "generic",
                            group: data.group,
                            city: data.city,
                            lastDataAt: data.receivedAt,
                            dataAgeMs: 0,
                            status: data.deviceStatus || "ONLINE",
                            schemeIds,
                        };
                    } else {
                        dev.lastDataAt = data.receivedAt;
                        dev.dataAgeMs = Date.now() - data.receivedAt;
                        dev.status = data.deviceStatus || dev.status;
                        dev.schemeIds = Array.from(new Set([...(dev.schemeIds || []), ...schemeIds]));
                    }
                    devices.set(k, dev);

                    await renderDeviceList();
                } else if (payload.type === EVT_DEVICE_STATUS) {
                    for (const d of payload.data || []) {
                        devices.set(dkey(d.accountId, d.deviceId), d);
                    }
                    await renderDeviceList();
                } else if (payload.type === EVT_SNAPSHOT_REPLY) {
                    markConnected();
                    const entries = payload.data.devices || [];
                    log(`📦 Snapshot diterima: ${entries.length} device`);
                    for (const entry of entries) {
                        const dev = entry.device;
                        if (!dev) continue;
                        const k = dkey(dev.accountId, dev.deviceId);
                        devices.set(k, dev);
                        const sensors: any = {};
                        for (const s of entry.readings || []) {
                            sensors[String(s.schemeId)] = {
                                id: s.schemeId,
                                label: s.label,
                                unit: s.unit,
                                value: s.value,
                                category: s.label,
                            };
                        }
                        sensorMap.set(k, sensors);
                    }
                    await renderDeviceList();
                }
            });
        }

        await shell.send(target, { type: "LANTANA_REGISTER", name: "dashboard", accountId, fromPid: lib?.getPid?.() }).catch(() => { });
        await shell.send(target, { type: "LANTANA_SNAPSHOT", accountId, fromPid: lib?.getPid?.() }).catch(() => { });
    };

    // Polling snapshot tiap 3 detik (menggantikan while loop)
    const timer = new TTimer({ interval: 3000, enabled: true });
    timer.onTimer = async () => {
        try {
            await shell.send(target, { type: "LANTANA_SNAPSHOT", accountId, fromPid: lib?.getPid?.() });
        } catch (_) { }
    };
    form.add(timer);

    await form.run();
});
