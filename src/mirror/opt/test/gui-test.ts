import { Program, std, shell } from "@tsix/Application";
import {
    Screen, div, span, h1, h2, paragraph, button,
    sensorCard, relayCard, lineChart, radialGauge,
    sevenSegment, indicatorLamp, toggleSwitch, slider,
    badge, ConnectedToggle, ConnectedRelayCard,
    ConnectedSensorCard, ConnectedLineChart, ConnectedRadialGauge,
    ConnectedSevenSegment, ConnectedIndicatorLamp,
    verticalGauge, ConnectedVerticalGauge,
} from "@tsix/emerald";
import { theme } from "@tsix/theme";

// ============================================================
// DATA DEFINISI — semua sensor & relay untuk demo
// ============================================================
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

// ============================================================
// SIMULASI DATA — data fiktif yang berubah-ubah tiap detik
// ============================================================
function simulateSensors(): Record<string, number> {
    const t = Date.now() / 1000;
    return {
        "01": 50 + 15 * Math.sin(t * 0.5),                       // Temp:  35–65 °C (sinus)
        "02": 40 + 30 * Math.sin(t * 0.3 + 2),                   // Hum:   10–70 %
        "03": 950 + 80 * Math.sin(t * 0.2),                       // Press: 870–1030 hPa
        "04": Math.max(0, Math.min(100, 50 + 45 * Math.sin(t * 0.7 + 1))), // Light: 5–95 lx
    };
}

// ============================================================
// MAIN
// ============================================================export const appMode = "gui";
export const main = Program(async (_args: string[]) => {
    await theme.loadCurrent();
    theme.watch();
    const app = new Screen({ title: "🧪 Emerald IoT Widgets Demo", width: 960, height: 720, frameless: false });

    // --- state ---
    const sv: Record<string, number> = {};
    const history: Record<string, number[]> = {};
    for (const s of SENSORS) history[s.id] = [];

    // --- connected toggles (self-wiring, handle klik + setContent sendiri, juga sumber state relay) ---
    const fanToggle = new ConnectedToggle({ id: "fan-sw", label: "🌀 FAN", color: "#4caf50", on: false });
    const lampToggle = new ConnectedToggle({ id: "lamp-sw", label: "💡 LAMP", color: "#ff9800", on: false });

    // --- connected relay cards (self-wiring, cukup call setOn untuk render ulang) ---
    const fanRelay = new ConnectedRelayCard({ id: "RELAY_1", label: "FAN", icon: "🌀", color: "#4caf50", on: false });
    const lampRelay = new ConnectedRelayCard({ id: "RELAY_2", label: "LAMP", icon: "💡", color: "#ff9800", on: false });

    // --- connected sensor cards ---
    const sensorCards = SENSORS.map(s => new ConnectedSensorCard(s));

    // --- connected analytics widgets ---
    const tempChart = new ConnectedLineChart({ id: "chart-temp", title: "🌡️ Temperature History", color: "#f44336", min: 0, max: 100, width: 350, height: 150, data: [50] });
    const humGauge = new ConnectedRadialGauge({ id: "gauge-hum", min: 0, max: 100, color: "#2196f3", label: "💧 Humidity", unit: "%", size: 110, value: 50, height: 150 });
    const presSeg = new ConnectedSevenSegment({ id: "seg-pres", digits: 4, decimals: 0, color: "#7ffa73", value: 1013, label: "🌀 Pressure", height: 150 });
    const lightLamp = new ConnectedIndicatorLamp({ id: "lamp-light", color: "#ff9800", label: "☀️ LIGHT", size: 36, on: false, height: 150 });

    // --- connected vertical gauges ---
    const waterGauge = new ConnectedVerticalGauge({ id: "gauge-water", color: "#2196f3", label: "💧 Water Level", unit: "%", value: 50 });
    const fuelGauge = new ConnectedVerticalGauge({ id: "gauge-fuel", color: "#4caf50", label: "⛽ Fuel", unit: "%", value: 50 });

    // Apply theme to window chrome
    const ps = await shell.ps();
    const domePid = (ps.find((p: any) => p.name.includes("dome")) || {}).pid || 0;
    if (domePid) await theme.applyToDome(domePid, app.wid);

    // --- mount layout --- 
    await app.mount(
        div({ id: "root", style: { padding: "16px", height: "100%", display: "flex", flexDirection: "column", gap: "6px", overflowY: "auto", background: theme.colors.bg, color: theme.colors.text } },

            // HEADER
            div({ style: { display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: "0", marginBottom: "4px" } },
                h1({ text: "🧪 Emerald IoT Widgets Demo", style: { fontSize: "20px", color: theme.colors.accent, margin: "0" } }),
                div({ style: { display: "flex", gap: "8px", alignItems: "center" } },
                    span({ text: "Live", style: { fontSize: "11px", color: theme.colors.textMuted } }),
                    badge({ color: theme.colors.accent, pulse: true, size: 8 }),
                ),
            ),

            // ROW 1 — Sensor Cards
            div({ id: "sensors-header", style: { flexShrink: "0" } },
                h2({ text: "📡 Sensor Cards", style: { fontSize: "14px", color: theme.colors.accent, margin: "6px 0 4px" } }),
            ),
            div({ id: "sensors-row", style: { display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "stretch", flexShrink: "0" } },
                ...sensorCards.map(sc => sc.build()),
            ),

            // ROW 2 — Analytics
            div({ id: "analytics-header", style: { flexShrink: "0" } },
                h2({ text: "📈 Analytics", style: { fontSize: "14px", color: theme.colors.accent, margin: "6px 0 4px" } }),
            ),
            div({ id: "analytics-row", style: { display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "flex-start", flexShrink: "0" } },
                div({ style: { flex: "2", minWidth: "210px", height: "200px" } }, tempChart.build()),
                div({ style: { flex: "1", minWidth: "130px", height: "150px" } }, humGauge.build()),
                div({ style: { flex: "1", minWidth: "130px", height: "150px" } }, presSeg.build()),
                div({ style: { flex: "1", minWidth: "100px", height: "150px" } }, lightLamp.build()),
            ),

            // ROW 3 — Controls
            div({ id: "controls-header", style: { flexShrink: "0" } },
                h2({ text: "🎛️ Controls", style: { fontSize: "14px", color: theme.colors.accent, margin: "6px 0 4px" } }),
            ),
            div({ id: "controls-row", style: { display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "flex-start", flexShrink: "0" } },
                div({ style: { flex: "1", minWidth: "110px" } }, fanToggle.build()),
                div({ style: { flex: "1", minWidth: "110px" } }, lampToggle.build()),
                div({ id: "speed-wrap", style: { flex: "1.5", minWidth: "180px" } }, slider({ id: "fan-speed", value: 50, min: 10, max: 100, color: "#4caf50", label: "🌀 FAN SPEED", unit: "%" })),
                button({ id: "btn-kirim", text: "📤 Kirim", style: { background: theme.colors.accent, color: "#fff", border: "none", padding: "10px 20px", borderRadius: "8px", cursor: "pointer", fontSize: "13px", fontWeight: "700", alignSelf: "center" } }),
            ),

            // ROW 4 — Relay Cards
            div({ id: "relay-header", style: { flexShrink: "0" } },
                h2({ text: "⚡ Relay Cards", style: { fontSize: "14px", color: theme.colors.accent, margin: "6px 0 4px" } }),
            ),
            div({ id: "relay-row", style: { display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "flex-start", flexShrink: "0" } },
                div({ style: { flex: "1", minWidth: "140px" } }, fanRelay.build()),
                div({ style: { flex: "1", minWidth: "140px" } }, lampRelay.build()),
            ),

            // ROW 5 — Vertical Gauges
            div({ id: "gauge-header", style: { flexShrink: "0" } },
                h2({ text: "🧪 Vertical Gauges", style: { fontSize: "14px", color: theme.colors.accent, margin: "6px 0 4px" } }),
            ),
            div({ id: "gauge-row", style: { display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "flex-start", flexShrink: "0" } },
                div({ style: { flex: "1", minWidth: "90px" } }, waterGauge.build()),
                div({ style: { flex: "1", minWidth: "90px" } }, fuelGauge.build()),
            ),

            // ROW 6 — Status
            div({ id: "status-header", style: { flexShrink: "0" } },
                h2({ text: "💬 Status Log", style: { fontSize: "14px", color: theme.colors.accent, margin: "6px 0 4px" } }),
            ),
            div({ id: "status-scroll", style: { flex: "1", background: theme.colors.bgAlt, borderRadius: "8px", padding: "10px", fontSize: "11px", fontFamily: "monospace", color: theme.colors.textDim, minHeight: "60px", maxHeight: "180px", overflowY: "auto" } },
                span({ id: "status-txt", text: "⏳ Demo started...\n" }),
            ),
        ),
    );

    // --- helper: log ke status box ---
    let statusBuf = "";
    let autoScroll = true;
    const log = async (m: string) => {
        if (!app.running) return;
        statusBuf += m + "\n";
        if (statusBuf.length > 2000) statusBuf = statusBuf.slice(-2000);
        await app.update("status-txt", { text: statusBuf });
        if (autoScroll) {
            app.update("status-scroll", { scrollTop: 999999 }).catch(() => { });
        }
    };

    // --- helper: update seluruh UI ---
    const updateUI = async () => {
        if (!app.running) return;
        // Sensor cards — ConnectedSensorCard handle render sendiri
        for (const s of sensorCards) {
            const v = sv[s["sensorId"]];
            if (v === undefined) continue;
            await s.setValue(v);
        }
        // Temperature chart
        if (history["01"].length > 0) await tempChart.setData(history["01"]);
        // Humidity gauge
        if (sv["02"] !== undefined) await humGauge.setValue(sv["02"]);
        // Pressure 7-segment
        if (sv["03"] !== undefined) await presSeg.setValue(sv["03"]);
        // Light indicator lamp
        if (sv["04"] !== undefined) await lightLamp.setOn(sv["04"] > 30);
        // Vertical gauges — map sensor ke 0-100% biar full range
        if (sv["01"] !== undefined) await waterGauge.setValue(Math.round(50 + 45 * Math.sin(Date.now() / 1000 * 0.4))); // Water level naik-turun 5-95%
        if (sv["02"] !== undefined) await fuelGauge.setValue(Math.round(100 - sv["02"])); // Fuel makin turun saat humidity naik
        // Relay cards — ConnectedRelayCard handle render sendiri
        await fanRelay.setOn(fanToggle.on);
        await lampRelay.setOn(lampToggle.on);

        // Kirim notif ke Asteracea kalau temperature >= 60
        if (sv["01"] !== undefined && sv["01"] >= 64) {
            try {
                app.notifyDesktop("🌡️ Temperature Alert", `Sensor 01: ${sv["01"].toFixed(1)}°C — Above threshold (60°C)!`, { duration: 5000, position: "ne" });
            } catch (_) { /* Asteracea might not running */ }
        }
    };

    // --- wire connected toggles ---
    await fanToggle.mount(app, updateUI);
    await lampToggle.mount(app, updateUI);

    // --- wire connected relay cards ---
    await fanRelay.mount(app);
    await lampRelay.mount(app);

    // --- wire connected sensor cards ---
    for (const sc of sensorCards) await sc.mount(app);

    // --- wire connected analytics widgets ---
    await tempChart.mount(app);
    await humGauge.mount(app);
    await presSeg.mount(app);
    await lightLamp.mount(app);

    // --- wire connected vertical gauges ---
    await waterGauge.mount(app);
    await fuelGauge.mount(app);

    // Button Kirim: tampilkan alert status switch + slider
    let fanSpeedPct = 50;
    app.win.onClick("btn-kirim", async () => {
        const fanOn = fanToggle.on ? "ON" : "OFF";
        const lampOn = lampToggle.on ? "ON" : "OFF";
        await app.alert(
            "📤 Status Kontrol",
            `🌀 FAN      : ${fanOn}\n💡 LAMP   : ${lampOn}\n🌀 SPEED : ${fanSpeedPct}%`,
        );
    });

    app.win.bindHandler("sl-input-fan-speed", "input", (ev: any) => {
        fanSpeedPct = parseInt(ev?.value) || 50;
        app.update("sl-val-fan-speed", { text: fanSpeedPct + "%" }).catch(() => { });
    });

    // --- main loop: inject data setiap 1 detik ---
    let tick = 0;
    app.setInterval(async () => {
        tick++;
        const data = simulateSensors();
        Object.assign(sv, data);
        // Update history
        for (const s of SENSORS) {
            history[s.id].push(data[s.id]);
            if (history[s.id].length > 20) history[s.id].shift();
        }
        await log(`[t=${tick}s] ...  FAN=${fanToggle.on ? "ON" : "OFF"}  LAMP=${lampToggle.on ? "ON" : "OFF"}`);
        await updateUI();
    }, 1000);

    await app.win.flush();

    // --- auto-scroll: deteksi user scroll manual ---
    app.win.bindHandler("status-scroll", "scroll", (ev: any) => {
        const st = ev?.scrollTop ?? 0, sh = ev?.scrollHeight ?? 1, ch = ev?.clientHeight ?? 1;
        autoScroll = (sh - st - ch) < 20;
    });

    // --- loop until close ---
    await app.loopUntilClose();
});
