import { Program, std, shell } from "@tsix/Application";
import { Screen, div, span, h1, h2, sensorCard, relayCard, lineChart, radialGauge, sevenSegment, indicatorLamp, toggleSwitch, slider, buildLineChartSvg, buildRadialGaugeSvg, buildSevenSegmentHtml, buildIndicatorLampImg, buildToggleSwitchImg } from "@tsix/emerald";
import { theme } from "@tsix/theme";

interface SensorDef {
    id: string; label: string; unit: string; icon: string; color: string; min: number; max: number;
}
const SENSORS: SensorDef[] = [
    { id: "01", label: "Temperature", unit: "°C", icon: "🌡️", color: "#f44336", min: 0, max: 100 },
    { id: "02", label: "Humidity", unit: "%", icon: "💧", color: "#2196f3", min: 0, max: 100 },
    { id: "03", label: "Pressure", unit: "hPa", icon: "🌀", color: "#9c27b0", min: 800, max: 1100 },
    { id: "04", label: "Light", unit: "lx", icon: "☀️", color: "#ff9800", min: 0, max: 100 },
];

const RELAYS = [
    { id: "RELAY_1", label: "FAN", icon: "🌀", color: "#4caf50" },
    { id: "RELAY_2", label: "LAMP", icon: "💡", color: "#ff9800" },
];

export const appMode = "gui";

export const main = Program(async (args: string[]) => {
    await theme.loadCurrent();
    theme.watch();

    const listenerPid = parseInt(args[0]);
    if (isNaN(listenerPid)) {
        await std.log("[iot-dashboard] Usage: iot-dashboard <listenerPid>\n");
        return;
    }

    const app = new Screen({ title: "🌐 IoT Dashboard", width: 880, height: 620 });
    const sv: Record<string, number> = {};
    const rl: Record<string, boolean> = { RELAY_1: false, RELAY_2: false };
    let nodeId = "—", pktCnt = 0, lastTs = 0;
    let statusBuf = "";
    let autoScroll = true;

    const history: Record<string, number[]> = {};
    for (const s of SENSORS) history[s.id] = [];

    // Apply theme to window chrome
    const ps = await shell.ps();
    const domePid = (ps.find((p: any) => p.name.includes("dome")) || {}).pid || 0;
    if (domePid) await theme.applyToDome(domePid, app.wid);

    await app.mount(
        div({ id: "root", style: { padding: "14px", height: "100%", display: "flex", flexDirection: "column", gap: "10px", overflowY: "auto", background: theme.colors.bg, color: theme.colors.text } },
            // HEADER
            div({ style: { display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: "0" } },
                h1({ text: "🌐 IoT Dashboard", style: { fontSize: "22px", color: theme.colors.accent, margin: "0" } }),
                span({ id: "header-info", text: "Node: — | 🔴 Disconnected", style: { fontSize: "12px", color: theme.colors.textMuted } }),
            ),
            // ROW 1 — Sensor Cards
            div({ style: { display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "stretch", flexShrink: "0" } },
                ...SENSORS.map(s => emeraldSensorCard(s)),
            ),
            // ROW 2 — Analytics
            div({ id: "analytics-header", style: { flexShrink: "0" } },
                h2({ text: "📈 Analytics", style: { fontSize: "15px", color: theme.colors.accent, margin: "4px 0 6px" } }),
            ),
            div({ id: "analytics-row", style: { display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "stretch", flexShrink: "0" } },
                div({ id: "chart-wrap", style: { flex: "2", minWidth: "220px" } }, lineChart({ id: "chart-temp", title: "🌡️ Temperature History", data: [25], color: "#f44336", spline: true, fill: true, width: 350, height: 170 })),
                div({ id: "gauge-wrap", style: { flex: "1", minWidth: "140px" } }, radialGauge({ id: "gauge-hum", value: 0, min: 0, max: 100, color: "#2196f3", label: "💧 Humidity", unit: "%", size: 125 })),
                div({ id: "seg-wrap", style: { flex: "1", minWidth: "140px" } }, sevenSegment({ id: "seg-pres", value: 0, digits: 4, decimals: 0, color: "#45ff0d", label: "Pressure" })),
                div({ id: "lamp-wrap", style: { flex: "1", minWidth: "110px" } }, indicatorLamp({ id: "lamp-light", color: "#ff9800", on: false, label: "☀️ LIGHT", size: 38 })),
            ),
            // ROW 3 — Controls
            div({ id: "controls-header", style: { flexShrink: "0" } },
                h2({ text: "🎛️ Controls", style: { fontSize: "15px", color: theme.colors.accent, margin: "4px 0 6px" } }),
            ),
            div({ id: "controls-row", style: { display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "stretch", flexShrink: "0" } },
                div({ id: "fan-wrap", style: { flex: "1", minWidth: "120px" } }, toggleSwitch({ id: "fan-sw", onClickId: "fan-click", color: "#4caf50", on: false, label: "🌀 FAN" })),
                div({ id: "lamp-swwrap", style: { flex: "1", minWidth: "120px" } }, toggleSwitch({ id: "lamp-sw", onClickId: "lamp-click", color: "#ff9800", on: false, label: "💡 LAMP" })),
                div({ id: "speed-wrap", style: { flex: "1.5", minWidth: "180px" } }, slider({ id: "fan-speed", value: 50, min: 10, max: 100, color: "#4caf50", label: "🌀 FAN SPEED", unit: "%" })),
            ),
            // ROW 4 — Relays
            div({ id: "relay-header", style: { flexShrink: "0" } },
                h2({ text: "⚡ Relays", style: { fontSize: "15px", color: theme.colors.accent, margin: "4px 0 6px" } }),
            ),
            div({ id: "relay-row", style: { display: "flex", gap: "10px", alignItems: "stretch", flexShrink: "0" } },
                ...RELAYS.map(r => emeraldRelayCard(r)),
            ),
            // ROW 5 — Status Log
            div({ id: "status-header", style: { flexShrink: "0" } },
                h2({ text: "📋 Status", style: { fontSize: "15px", color: theme.colors.accent, margin: "4px 0 6px" } }),
            ),
            div({ id: "status-scroll", style: { flex: "1", background: theme.colors.bgAlt, borderRadius: "8px", padding: "10px", overflowY: "auto", fontSize: "11px", fontFamily: "monospace", color: theme.colors.textDim, minHeight: "50px" } },
                span({ id: "status-txt", text: "⏳ Starting...\n" }),
            ),
        ),
    );

    const log = async (m: string) => {
        if (!app.running) return; // window sudah ditutup — berhenti
        statusBuf += m + "\n";
        if (statusBuf.length > 2000) statusBuf = statusBuf.slice(-2000);
        try {
            await app.update("status-txt", { text: statusBuf });
            if (autoScroll) { await app.update("status-scroll", { scrollTop: 999999 }); }
        } catch (_) {
            // Window sudah destroyed — jangan sampai jadi unhandled rejection
        }
    };

    const updateUI = async () => {
        if (!app.running) return; // window sudah ditutup — berhenti update
        // Sensor cards → targeted update (NO setContent)
        for (const s of SENSORS) {
            const v = sv[s.id];
            if (v === undefined) continue;
            await app.update(`sv-${s.id}`, { text: v.toFixed(1) });
            const pct = Math.min(100, Math.max(0, ((v - s.min) / (s.max - s.min)) * 100));
            await app.update(`bar-${s.id}`, { style: { width: `${pct}%`, background: s.color, height: "6px", borderRadius: "3px", transition: "width 0.3s" } });
            history[s.id].push(v);
            if (history[s.id].length > 20) history[s.id].shift();
        }

        // Temperature → lineChart (update SVG innerHTML only — NO flicker!)
        if (history["01"].length > 0) {
            const svgStr = buildLineChartSvg({ id: "chart-temp", data: history["01"], color: SENSORS[0].color, spline: true, fill: true, width: 260, height: 170, min: SENSORS[0].min, max: SENSORS[0].max });
            await app.update("lc-html-chart-temp", { innerHTML: svgStr });
        }

        // Humidity → radialGauge (update SVG innerHTML only)
        if (sv["02"] !== undefined) {
            const svgStr = buildRadialGaugeSvg({ id: "gauge-hum", value: sv["02"], min: 0, max: 100, color: "#2196f3", unit: "%", size: 125 });
            await app.update("rg-html-gauge-hum", { innerHTML: svgStr });
        }

        // Pressure → sevenSegment (update innerHTML only)
        if (sv["03"] !== undefined) {
            const htmlStr = buildSevenSegmentHtml({ value: Math.round(sv["03"]), digits: 4, decimals: 0, color: "#9c27b0" });
            await app.update("ss-html-seg-pres", { innerHTML: htmlStr });
        }

        // Light → indicatorLamp (update SVG + label + style — NO setContent!)
        if (sv["04"] !== undefined) {
            const lightOn = sv["04"] > 30;
            const color = "#ff9800";
            const { innerHTML } = buildIndicatorLampImg({ color, on: lightOn, size: 38 });
            await app.update("il-html-lamp-light", { innerHTML });
            await app.update("il-label-lamp-light", { text: "☀️ LIGHT", style: { fontSize: "11px", color: lightOn ? color : "#666", display: "block", textAlign: "center", marginTop: "6px", fontWeight: "600" as any } });
            await app.update("il-lamp-light", { style: { flex: "1", minWidth: "100px", background: "#16213e", borderRadius: "10px", padding: "14px", border: `1px solid ${lightOn ? color : "#333"}44`, textAlign: "center" as any } });
        }

        // Toggle switches (update SVG + label + style + onClickId — NO setContent!)
        const fanOn = rl["RELAY_1"], lampOn = rl["RELAY_2"];
        for (const { id, color, label, on, wrapId } of [
            { id: "fan-sw", color: "#4caf50", label: "🌀 FAN", on: fanOn, wrapId: "fan-wrap" },
            { id: "lamp-sw", color: "#ff9800", label: "💡 LAMP", on: lampOn, wrapId: "lamp-swwrap" },
        ]) {
            await app.update(`ts-html-${id}`, { innerHTML: buildToggleSwitchImg({ color, on, size: 48 }) });
            await app.update(`ts-label-${id}`, { text: label, style: { fontSize: "11px", color: on ? color : "#666", display: "block", textAlign: "center", marginTop: "4px", fontWeight: "600" as any } });
            await app.update(`ts-${id}`, { style: { flex: "1", minWidth: "110px", background: "#16213e", borderRadius: "10px", padding: "14px", border: `1px solid ${on ? color : "#333"}44`, textAlign: "center" as any, cursor: "pointer" } });
            // Re-apply onClickId setiap update karena toggleSwitch gak set otomatis
            await app.update(wrapId, { onClickId: id === "fan-sw" ? "fan-click" : "lamp-click" });
        }

        // Relays (backward compat — already using targeted update ✅)
        for (const r of RELAYS) {
            const on = rl[r.id];
            await app.update(`rc-${r.id}`, { style: { padding: "12px", borderRadius: "8px", border: `1px solid ${on ? r.color : theme.colors.border}`, background: on ? `${r.color}22` : theme.colors.card, flex: "1", textAlign: "center" as any } });
            await app.update(`rs-${r.id}`, { text: on ? "🟢 ON" : "⚫ OFF", style: { color: on ? r.color : "#888", fontWeight: "700" as any, fontSize: "14px" } });
        }

        const age = lastTs ? `${((Date.now() - lastTs) / 1000).toFixed(1)}s ago` : "—";
        const conn = pktCnt > 0 ? "🟢 Connected" : "🔴 Disconnected";
        await app.update("header-info", { text: `Node: ${nodeId} | ${conn} | ${age}` });
    };

    await log(`🔌 Listener PID: ${listenerPid}`);
    await log("⏳ Requesting sensor data every 1s...\n");

    const lib = (global as any)._tsixLib;
    if (lib?.onEvent) {
        lib.onEvent("ipc_message", (msg: any) => {
            if (!app.running) return; // window sudah ditutup — jangan proses lagi
            const payload = msg?.data || msg;
            if (!payload || payload.type !== "SENSOR_DATA") return;
            log(`📥 [${payload.timestamp}] Node ${payload.nodeId} | Sensors: ${JSON.stringify(payload.sensors)} | Relays: ${JSON.stringify(payload.relays)}`);
            nodeId = payload.nodeId || nodeId;
            pktCnt++;
            lastTs = payload.timestamp || Date.now();
            if (payload.sensors) Object.assign(sv, payload.sensors);
            if (payload.relays) Object.assign(rl, payload.relays);
            updateUI().catch(() => { });
        });
    }

    app.win.bindHandler("status-scroll", "scroll", (ev: any) => {
        const st = ev?.scrollTop ?? 0, sh = ev?.scrollHeight ?? 1, ch = ev?.clientHeight ?? 1;
        autoScroll = (sh - st - ch) < 20;
    });

    app.win.onClick("fan-click", () => { rl["RELAY_1"] = !rl["RELAY_1"]; updateUI().catch(() => { }); });
    app.win.onClick("lamp-click", () => { rl["RELAY_2"] = !rl["RELAY_2"]; updateUI().catch(() => { }); });

    // Slider input: update nilai fan speed via bindHandler (persists across setContent)
    app.win.bindHandler("sl-input-fan-speed", "input", (ev: any) => {
        if (!app.running) return;
        const val = parseInt(ev?.value) || 50;
        app.update("sl-val-fan-speed", { text: val + "%" }).catch(() => { });
    });

    // Saat window ditutup → running=false: hentikan while-loop & update UI,
    // supaya handler ipc_message tidak memanggil update pada window yang
    // sudah destroyed (dulu: unhandled rejection → Worker Fatal).
    app.win.onClose(() => { app.running = false; });

    await app.win.flush();

    while (app.running) {
        try { await shell.send(listenerPid, { type: "GET_DATA", fromPid: lib?.getPid?.() }); } catch (_) { }
        await new Promise(r => setTimeout(r, 1000));
    }
    await app.close();
});

function emeraldSensorCard(s: SensorDef) { return sensorCard({ id: s.id, label: s.label, unit: s.unit, icon: s.icon, color: s.color, value: undefined as any }); }
function emeraldRelayCard(r: typeof RELAYS[0]) { return relayCard({ id: r.id, label: r.label, icon: r.icon, color: r.color, active: false as any }); }
