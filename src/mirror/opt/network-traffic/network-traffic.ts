/**
 * network-traffic.ts — MQTNL Network Traffic Monitor (GUI)
 *
 * Versi GUI dari utilitas CLI `nettop` (src/mirror/usr/bin/nettop.ts).
 * Menampilkan statistik lalu lintas jaringan MQTNL secara real-time dalam
 * sebuah Tabulator DataGrid (Cashew):
 *   - Interface (nama device) + address + broker
 *   - Status koneksi (connected / disconnected)
 *   - Total Rx / Tx (kumulatif, dari netstat)
 *   - Rate Rx/s / Tx/s (dihitung dari delta antar polling)
 *   - Uptime (lama interface berjalan)
 *
 * Data bersumber dari syscall NETSTAT (SimpleMQTNLDriver.getStats()), sama
 * seperti `nettop` CLI. Polling tiap 1 detik via TTimer (managed oleh Screen,
 * auto-cleanup saat form ditutup).
 *
 * Jalankan: network-traffic
 * (Pastikan DOME running)
 *
 * (c) 2026 TSIX Project
 */

import { Program, std, NetworkLib } from "@tsix/Application";
import { TForm, TLabel, TButton, TTabulatorGrid, HStack, TStatusBar, TTimer, TRadialGauge } from "@tsix/cashew";
import { div, span } from "@tsix/emerald";

// Konstanta gauge rate — batas atas skala (KB/s). Nilai > ini di-clamp penuh.
const GAUGE_MAX_KBPS = 200; // 200 KB/s ≈ 1.6 Mbps per arah

export const appMode = "gui";

interface IfaceStats {
    deviceName: string;
    params: {
        connected: boolean;
        rxBytes: number;
        txBytes: number;
        uptime: number; // ms
        binds: number;
    };
}

export const main = Program(async (_args: string[]) => {
    await std.log("=== Network Traffic Monitor (GUI) ===");

    // ── Form ──
    const form = new TForm({
        title: "📡 MQTNL Network Traffic",
        icon: "📡",
        width: 750,
        height: 600,
        maximizable: true,
        resizable: true,
    });

    const lblTitle = new TLabel("title", {
        fontSize: "16px",
        fontWeight: "700",
        color: "var(--accent, #4caf50)",
        margin: "0",
    });
    lblTitle.caption = "📡 MQTNL Network Traffic (real-time)";
    form.add(lblTitle);

    const status = new TLabel("status", {
        fontSize: "12px",
        color: "var(--text-muted, #888)",
    });
    status.caption = "⏳ memuat...";

    const btnRefresh = new TButton("btn-refresh", {
        fontSize: "12px",
        borderRadius: "6px",
        cursor: "pointer",
        fontWeight: "600",
    });
    btnRefresh.caption = "🔄 Refresh";

    form.add(HStack({ padding: "4px" }, btnRefresh, status));

    // ── Grid ──
    const grid = new TTabulatorGrid(
        "net",
        [
            { key: "device", label: "Interface", width: 150 },
            { key: "status", label: "Status", width: 100, align: "center" },
            { key: "rx", label: "Rx", width: 90, align: "right" },
            { key: "rxRate", label: "Rx/s", width: 90, align: "right" },
            { key: "tx", label: "Tx", width: 90, align: "right" },
            { key: "txRate", label: "Tx/s", width: 90, align: "right" },
            { key: "uptime", label: "Uptime", width: 100, align: "right" },
        ],
        [],
        { height: 380 },
    );
    form.add(grid);

    // ── Gauge container — diisi dinamis per interface (Rx/s + Tx/s) ──
    const gaugeBox = new TLabel("gauge-box", {
        margin: "10px 0 0 0",
        display: "flex",
        flexDirection: "column" as any,
        gap: "10px",
        flexShrink: "0",
        paddingBottom: "10px"
    });
    gaugeBox.caption = "";
    form.add(gaugeBox);

    const bar = new TStatusBar("bar");
    bar.leftText = "📡 MQTNL Network Traffic";
    bar.rightText = "refresh 1s";
    form.add(bar);

    // ── State ──
    const net = new NetworkLib((global as any)._tsixOsc);
    const prevStats: Record<string, { rx: number; tx: number; time: number }> = {};
    // Referensi gauge per interface: name → { rx: TRadialGauge, tx: TRadialGauge }
    const gauges: Record<string, { rx: TRadialGauge; tx: TRadialGauge }> = {};
    let running = true;
    let lastErr = "";

    const formatBytes = (bytes: number): string => {
        if (!bytes || isNaN(bytes) || bytes <= 0) return "0 B";
        const k = 1024;
        const sizes = ["B", "KB", "MB", "GB", "TB"];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        if (i >= sizes.length) return bytes + " B";
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
    };

    const formatRate = (bytesPerSec: number): string => {
        return formatBytes(bytesPerSec) + "/s";
    };

    const formatUptime = (ms: number): string => {
        if (!ms || ms < 0) return "—";
        const s = Math.floor(ms / 1000);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        if (h > 0) return `${h}h ${m}m`;
        if (m > 0) return `${m}m ${sec}s`;
        return `${sec}s`;
    };

    const tick = async () => {
        if (!running) return;
        try {
            const data: any = await net.netstat();
            if (!data || !Array.isArray(data.interfaces)) {
                lastErr = "tidak ada interface";
                status.caption = "⚠️ netstat kosong";
                return;
            }

            const now = Date.now();

            // Hitung rate SEKALI per interface, lalu pakai untuk gauge & grid
            const ifaces: {
                name: string; rxRate: number; txRate: number;
                iface: IfaceStats;
            }[] = [];
            for (const iface of data.interfaces as IfaceStats[]) {
                const name = iface.deviceName || "?";
                const curRx = iface.params?.rxBytes || 0;
                const curTx = iface.params?.txBytes || 0;

                let rxRate = 0;
                let txRate = 0;
                const prev = prevStats[name];
                if (prev) {
                    const dt = (now - prev.time) / 1000; // detik
                    if (dt > 0) {
                        rxRate = (curRx - prev.rx) / dt;
                        txRate = (curTx - prev.tx) / dt;
                    }
                }
                prevStats[name] = { rx: curRx, tx: curTx, time: now };
                ifaces.push({ name, rxRate, txRate, iface });
            }

            // ── Gauge per interface (Rx/s + Tx/s) ──
            const gaugeChildren: any[] = [];
            for (const { name, rxRate, txRate } of ifaces) {
                const rxKbps = rxRate / 1024;
                const txKbps = txRate / 1024;

                // Buat gauge baru jika belum ada
                if (!gauges[name]) {
                    const rxG = new TRadialGauge(`rg-rx-${name}`, {
                        value: 0, min: 0, max: GAUGE_MAX_KBPS,
                        color: "#2196f3", unit: "KB/s", label: "Rx", size: 90,
                    });
                    const txG = new TRadialGauge(`rg-tx-${name}`, {
                        value: 0, min: 0, max: GAUGE_MAX_KBPS,
                        color: "#ff9800", unit: "KB/s", label: "Tx", size: 90,
                    });
                    // Bind ke screen supaya setValue() bisa update target elemen
                    if (form.screen) {
                        rxG.bindEventHandler(form.screen);
                        txG.bindEventHandler(form.screen);
                    }
                    gauges[name] = { rx: rxG, tx: txG };
                }

                // Update nilai gauge (targeted, halus — tanpa rebuild)
                await gauges[name].rx.setValue(rxKbps);
                await gauges[name].tx.setValue(txKbps);

                // Susun baris gauge: label interface + pasangan [Rx][Tx]
                gaugeChildren.push(
                    div({
                        style: { display: "flex", alignItems: "center", gap: "14px" },
                    },
                        span({ text: name, style: { minWidth: "110px", fontWeight: "700", fontSize: "13px", color: "var(--accent, #4caf50)" } }),
                        gauges[name].rx.build(),
                        gauges[name].tx.build(),
                    )
                );
            }

            // Rebuild gauge container tiap tick (ada interface baru) —
            // setContent clear + mount ulang. Nilai di-set via setValue di atas.
            if (form.screen) await form.screen.setContent("gauge-box", ...gaugeChildren);

            const rows: Record<string, any>[] = ifaces.map(({ name, rxRate, txRate, iface }) => ({
                device: name,
                status: iface.params?.connected ? "🟢 connected" : "🔴 disconnected",
                rx: formatBytes(iface.params?.rxBytes || 0),
                rxRate: formatRate(rxRate),
                tx: formatBytes(iface.params?.txBytes || 0),
                txRate: formatRate(txRate),
                uptime: formatUptime(iface.params?.uptime),
            }));

            await grid.setData(rows);
            status.caption = `✅ ${rows.length} interface — ${new Date().toLocaleTimeString()}`;
            bar.rightText = `refresh 1s · ${rows.length} iface`;
        } catch (e: any) {
            lastErr = e?.message || String(e);
            status.caption = "❌ " + lastErr;
        }
    };

    btnRefresh.onClick = () => {
        void tick();
    };

    // ── Timer refresh 1 detik (managed oleh Screen — auto-cleanup saat tutup) ──
    const timer = new TTimer("tmr-net", 1000, false);
    timer.onTimer = () => {
        void tick();
    };
    form.add(timer);

    form.onSetup = async () => {
        // Set data awal — langsung tick pertama, lalu mulai timer
        await tick();
        timer.enabled = true;
    };

    form.onClose = () => {
        running = false;
    };

    await form.run();
});
