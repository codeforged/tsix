/**
 * pixelspace-traffic.ts — 📡 PixelSpace WebSocket Traffic Monitor
 *
 * Memonitor traffic WebSocket DOME Engine secara real-time:
 * - RX/TX bytes per second
 * - RX/TX packets per second
 * - Grafik history 60 detik
 *
 * (c) 2026 TSIX Project
 */

import { Program, std, shell, os } from "@tsix/Application";
import {
  TForm,
  TLabel,
  TStatusBar,
  TFlowPanel,
  TGroupBox,
  TChart,
  TTimer,
} from "@tsix/cashew";

export const appMode = "gui";

export const main = Program(async (_args: string[]) => {
  await std.log("=== PixelSpace Traffic Monitor ===");

  const form = new TForm("📡 PixelSpace Traffic", 560, 700);
  form.style = {
    ...form.style,
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "8px",
    alignContent: "start",
  };

  const status = new TStatusBar("status");
  status.text = "🔍 Connecting to DOME...";
  form.add(status);

  // ================================================================
  // HEADER
  // ================================================================
  const lblTitle = new TLabel("lbl-title");
  lblTitle.caption = "📡 PixelSpace WebSocket Traffic Monitor";
  lblTitle.style = {
    gridColumn: "1 / -1",
    fontSize: "15px",
    color: "var(--accent, #4caf50)",
    fontWeight: "700",
  };
  form.add(lblTitle);

  // ================================================================
  // RX / TX RATE CARDS
  // ================================================================
  const rxGroup = TGroupBox("grp-rx", "⬇️ RX Rate", {
    gridColumn: "1 / 2",
  });
  const lblRxBytes = new TLabel("lbl-rx-bytes", { fontSize: "22px", fontWeight: "700", color: "#2196f3", display: "block", textAlign: "center" });
  lblRxBytes.caption = "0 B/s";
  rxGroup.add(lblRxBytes);
  const lblRxPkts = new TLabel("lbl-rx-pkts", { fontSize: "13px", display: "block", textAlign: "center" });
  lblRxPkts.caption = "0 pkts/s";
  rxGroup.add(lblRxPkts);
  form.add(rxGroup);

  const txGroup = TGroupBox("grp-tx", "⬆️ TX Rate", {
    gridColumn: "2 / 3",
  });
  const lblTxBytes = new TLabel("lbl-tx-bytes", { fontSize: "22px", fontWeight: "700", color: "#ff9800", display: "block", textAlign: "center" });
  lblTxBytes.caption = "0 B/s";
  txGroup.add(lblTxBytes);
  const lblTxPkts = new TLabel("lbl-tx-pkts", { fontSize: "13px", display: "block", textAlign: "center" });
  lblTxPkts.caption = "0 pkts/s";
  txGroup.add(lblTxPkts);
  form.add(txGroup);

  // ================================================================
  // SPLIT TX: dari browser vs dari app (observer effect fix)
  // ================================================================
  const txSplitGroup = TGroupBox("grp-tx-split", "🔀 TX Source Breakdown", {
    gridColumn: "1 / -1",
  });
  const txSplitRow = TFlowPanel("tx-split-row");
  const lblAppTx = new TLabel("lbl-app-tx", { fontSize: "12px", display: "block", textAlign: "center", color: "#888" });
  lblAppTx.caption = "🖥️ App (GUI render): 0 B/s";
  txSplitRow.add(lblAppTx);
  const lblBrowserTx = new TLabel("lbl-browser-tx", { fontSize: "12px", display: "block", textAlign: "center", color: "#888" });
  lblBrowserTx.caption = "🌐 Browser (events): 0 B/s";
  txSplitRow.add(lblBrowserTx);
  txSplitGroup.add(txSplitRow);
  form.add(txSplitGroup);

  // ================================================================
  // CHARTS
  // ================================================================
  const chartGroup = TGroupBox("grp-chart", "📈 Traffic History (bytes/s)", {
    gridColumn: "1 / -1",
  });
  const byteChart = new TChart("byte-chart", {
    width: 510, height: 150, maxPoints: 60,
    minValue: 0, color: "#4caf50", label: "bytes/s",
  });
  chartGroup.add(byteChart);
  form.add(chartGroup);

  const pktGroup = TGroupBox("grp-pkt", "📊 Packet Rate (packets/s)", {
    gridColumn: "1 / -1",
  });
  const pktChart = new TChart("pkt-chart", {
    width: 510, height: 130, maxPoints: 60,
    minValue: 0, color: "#2196f3", label: "pkts/s",
  });
  pktGroup.add(pktChart);
  form.add(pktGroup);

  // ================================================================
  // TRAFFIC DATA
  // ================================================================
  let domePid = 0;
  let totalRx = 0;
  let totalTx = 0;

  // Cari DOME PID
  const findDome = async () => {
    try {
      const ps = await shell.ps();
      const dome = (ps || []).find((p: any) => p.name?.includes("dome"));
      domePid = dome ? dome.pid : 0;
      if (domePid) {
        status.text = `✅ Connected to DOME (PID ${domePid})`;
        await std.log(`[traffic] DOME found: PID ${domePid}`);
      } else {
        status.text = "❌ DOME not found!";
      }
    } catch (e) {
      status.text = "❌ Failed to find DOME";
    }
  };

  // Listen for TRAFFIC_STATS response from DOME
  const lib = (global as any)._tsixLib;
  if (lib?.onEvent) {
    lib.onEvent("ipc_message", (msg: any) => {
      const payload = msg?.data;
      if (payload?.type === "TRAFFIC_STATS" && payload?.stats) {
        const s = payload.stats;
        const rxBytes = s.rxBytes || 0;
        const txBytes = s.txBytes || 0;
        const rxPkts = s.rxPkts || 0;
        const txPkts = s.txPkts || 0;
        const appTxB = s.appTxBytes ?? txBytes;
        const browserTxB = s.browserTxBytes ?? 0;

        // Update labels
        lblRxBytes.caption = formatBytes(rxBytes) + "/s";
        lblRxPkts.caption = `${rxPkts} pkts/s`;
        lblTxBytes.caption = formatBytes(txBytes) + "/s";
        lblTxPkts.caption = `${txPkts} pkts/s`;

        // TX source breakdown
        lblAppTx.caption = `🖥️ App (GUI render): ${formatBytes(appTxB)}/s · ${s.appTxPkts ?? 0} pkts/s`;
        lblBrowserTx.caption = `🌐 Browser (events): ${formatBytes(browserTxB)}/s · ${s.browserTxPkts ?? 0} pkts/s`;

        // Total accumulated (tx/rx dari DOME sudah EXCLUDE traffic app sendiri)
        const selfTxB = s.selfTxBytes || 0;
        totalRx += rxBytes;
        totalTx += txBytes;
        status.text = `⬇️ ${formatBytes(totalRx)} total · ⬆️ ${formatBytes(totalTx)} total | 🧿 self-excluded ${formatBytes(selfTxB)}/s | ${domePid ? `DOME PID ${domePid}` : "disconnected"}`;

        // Chart history — pushData otomatis shift via maxPoints
        const totalBytes = rxBytes + txBytes;
        const totalPkts = rxPkts + txPkts;
        const ts = Date.now() / 1000;
        byteChart.pushData(ts, totalBytes);
        pktChart.pushData(ts, totalPkts);
      }
    });
  }

  // Timer: query DOME every 1 second
  const queryTimer = new TTimer("tmr-query", 1000, true);
  queryTimer.onTimer = async () => {
    if (!domePid) {
      await findDome();
      return;
    }
    try {
      await shell.send(domePid, { type: "TRAFFIC_QUERY", pid: os.pid });
    } catch (_) {
      // DOME might have restarted
      domePid = 0;
      status.text = "⚠️ DOME disconnected, reconnecting...";
    }
  };
  form.add(queryTimer);

  // ================================================================
  // HELPERS
  // ================================================================
  function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const val = bytes / Math.pow(1024, i);
    return (i === 0 ? Math.round(val) : val.toFixed(1)) + " " + units[i];
  }

  // ================================================================
  // RUN
  // ================================================================
  form.onSetup = async () => {
    await byteChart.initChart();
    await pktChart.initChart();
  };
  await findDome();
  status.style = { ...status.style, gridColumn: "1 / -1" };
  await form.run();
});
