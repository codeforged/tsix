/**
 * cashew-demo3.ts — IoT Dashboard (Cashew Framework)
 *
 * Menunjukkan komponen IoT Cashew:
 * - TSensorCard, TRelayCard, TLineChart, TRadialGauge
 * - TSevenSegment, TIndicatorLamp, TToggleSwitch
 * - TVerticalGauge, TSlider
 *
 * (c) 2026 TSIX Project
 */

import { Program, std } from "@tsix/Application";
import {
  TForm,
  TPanel,
  TLabel,
  TStatusBar,
  TFlowPanel,
  TGroupBox,
  TChart,
  TRadialGauge,
  TSevenSegment,
  TIndicatorLamp,
  TToggleSwitch,
  TVerticalGauge,
  TSensorCard,
  TRelayCard,
  TSlider,
  TTimer,
} from "@tsix/cashew";

export const appMode = "gui";

export const main = Program(async (_args: string[]) => {
  await std.log("=== Cashew IoT Dashboard Demo ===");

  // ================================================================
  // FORM
  // ================================================================
  const form = new TForm("📊 IoT Dashboard", 850, 780);
  form.style = {
    ...form.style,
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "8px",
    alignContent: "start",
  };
  form.onClose = () => std.log("[iot] Dashboard closed");

  const status = new TStatusBar("status");
  status.text = "🌐 IoT Dashboard Ready";
  form.add(status);

  // ================================================================
  // HEADER
  // ================================================================
  const lblTitle = new TLabel("lbl-title");
  lblTitle.caption = "📊 IoT Dashboard — Cashew Framework";
  lblTitle.style = {
    gridColumn: "1 / -1",
    fontSize: "16px",
    color: "var(--accent, #4caf50)",
    fontWeight: "700",
  };
  form.add(lblTitle);

  // ================================================================
  // 1. SENSOR CARDS (row 1)
  // ================================================================
  const sensorRow = TFlowPanel("sensor-row", { gridColumn: "1 / -1" });

  const cardTemp = new TSensorCard("temp", {
    label: "Temperature", unit: "°C", icon: "🌡️",
    color: "#f44336", value: 32.4, min: -10, max: 50,
  });
  sensorRow.add(cardTemp);

  const cardHum = new TSensorCard("hum", {
    label: "Humidity", unit: "%", icon: "💧",
    color: "#2196f3", value: 68, min: 0, max: 100,
  });
  sensorRow.add(cardHum);

  const cardPress = new TSensorCard("press", {
    label: "Pressure", unit: "hPa", icon: "🌀",
    color: "#ff9800", value: 1013, min: 900, max: 1100,
  });
  sensorRow.add(cardPress);

  const cardLight = new TSensorCard("light", {
    label: "Light", unit: " lux", icon: "☀️",
    color: "#ffeb3b", value: 450, min: 0, max: 1000,
  });
  sensorRow.add(cardLight);

  form.add(sensorRow);

  // ================================================================
  // 2. LINE CHART + VERTICAL GAUGE
  // ================================================================
  const chartGroup = TGroupBox("grp-chart", "📈 System Trends", {
    gridColumn: "1 / 2",
  });

  const chart = new TChart("sys-chart", {
    width: 300,
    height: 250,
    series: [
      { key: "temp", color: "#f44336", label: "Temperature", minValue: 15, maxValue: 45 },
      { key: "cpu", color: "#4caf50", label: "CPU" },
      { key: "mem", color: "#2196f3", label: "Memory" },
      { key: "disk", color: "#ff9800", label: "Disk" },
    ],
    maxPoints: 60,
  });
  chartGroup.add(chart);
  form.add(chartGroup);

  const gaugeGroup = TGroupBox("grp-gauge", "💧 Water Level", {
    gridColumn: "2 / 3",
  });
  const gaugeRow = TFlowPanel("gauge-row", {border: "0px"});
  const waterGauge1 = new TVerticalGauge("water1", {
    value: 75, color: "#2196f3", label: "Water Tank 1", unit: "%",
    w: 60, h: 180,
  });
  gaugeRow.add(waterGauge1);

  const waterGauge2 = new TVerticalGauge("water2", {
    value: 75, color: "#9ad103", label: "Water Tank 2", unit: "%",
    w: 60, h: 180,
  });
  gaugeRow.add(waterGauge2);
  gaugeGroup.add(gaugeRow);
  form.add(gaugeGroup);

  // ================================================================
  // 3. RADIAL GAUGES + SEVEN SEGMENT
  // ================================================================
  const radialGroup = TGroupBox("grp-radial", "⏱ System Metrics", {
    gridColumn: "1 / 2"
  });

  const radialRow = TFlowPanel("radial-row");
  const cpuGauge = new TRadialGauge("cpu", {
    value: 72, min: 0, max: 100, color: "#4caf50",
    label: "CPU", unit: "%", size: 100,
  });
  radialRow.add(cpuGauge);

  const memGauge = new TRadialGauge("mem", {
    value: 45, min: 0, max: 100, color: "#2196f3",
    label: "Memory", unit: "%", size: 100,
  });
  radialRow.add(memGauge);

  const diskGauge = new TRadialGauge("disk", {
    value: 68, min: 0, max: 100, color: "#ff9800",
    label: "Disk", unit: "%", size: 100,
  });
  radialRow.add(diskGauge);

  radialGroup.add(radialRow);
  form.add(radialGroup);

  const segGroup = TGroupBox("grp-seg", "🔢 Counter Display", {
    gridColumn: "2 / 3",
  });
  const segment = new TSevenSegment("counter", {
    value: 2026, digits: 4, decimals: 0, color: "#4caf50",
    height: "100%",
    scale: 1
  });
  segGroup.add(segment);
  form.add(segGroup);

  // ================================================================
  // 4. RELAY CARDS + TOGGLE SWITCHES
  // ================================================================
  const relayGroup = TGroupBox("grp-relay", "⚡ Relay Control", {
    gridColumn: "1 / 2",
  });

  const relayRow = TFlowPanel("relay-row");

  const relayFan = new TRelayCard("fan", {
    label: "FAN", icon: "🌀", color: "#4caf50", active: true,
  });
  relayRow.add(relayFan);

  const relayLamp = new TRelayCard("lamp", {
    label: "LAMP", icon: "💡", color: "#ff9800", active: false,
  });
  relayRow.add(relayLamp);

  const relayPump = new TRelayCard("pump", {
    label: "PUMP", icon: "💧", color: "#2196f3", active: false,
  });
  relayRow.add(relayPump);

  relayGroup.add(relayRow);
  form.add(relayGroup);

  const tglGroup = TGroupBox("grp-tgl", "🔘 Toggle Switches", {
    gridColumn: "2 / 3",
  });

  const tglRow = TFlowPanel("tgl-row");
  const tglFan = new TToggleSwitch("tgl-fan", {
    color: "#4caf50", on: true, label: "FAN",
  });
  tglFan.onClick = async () => {
    await relayFan.setActive(tglFan.on);
    await lampPower.setOn(tglFan.on);
    status.text = `🌀 FAN is ${tglFan.on ? "ON" : "OFF"}`;
  };
  tglRow.add(tglFan);

  const tglLamp = new TToggleSwitch("tgl-lamp", {
    color: "#ff9800", on: false, label: "LAMP",
  });
  tglLamp.onClick = async () => {
    await relayLamp.setActive(tglLamp.on);
    await lampNet.setOn(tglLamp.on);
    status.text = `💡 LAMP is ${tglLamp.on ? "ON" : "OFF"}`;
  };
  tglRow.add(tglLamp);

  const tglPump = new TToggleSwitch("tgl-pump", {
    color: "#2196f3", on: false, label: "PUMP",
  });
  tglPump.onClick = async () => {
    await relayPump.setActive(tglPump.on);
    await lampAlarm.setOn(tglPump.on);
    status.text = `💧 PUMP is ${tglPump.on ? "ON" : "OFF"}`;
  };
  tglRow.add(tglPump);

  tglGroup.add(tglRow);
  form.add(tglGroup);

  // ================================================================
  // 5. INDICATOR LAMPS + SLIDER
  // ================================================================
  const lampGroup = TGroupBox("grp-lamp", "🟢 Status Indicators", {
    gridColumn: "1 / 2",
  });

  const lampRow = TFlowPanel("lamp-row");
  const lampPower = new TIndicatorLamp("power", {
    color: "#4caf50", on: true, label: "POWER",
  });
  lampRow.add(lampPower);

  const lampNet = new TIndicatorLamp("net", {
    color: "#2196f3", on: false, label: "NETWORK",
  });
  lampRow.add(lampNet);

  const lampAlarm = new TIndicatorLamp("alarm", {
    color: "#f44336", on: false, label: "ALARM",
  });
  lampRow.add(lampAlarm);

  lampGroup.add(lampRow);
  form.add(lampGroup);

  const sliderGroup = TGroupBox("grp-slider", "🎚 Brightness Control", {
    gridColumn: "2 / 3",
  });
  const brightnessSlider = new TSlider("brightness", {
    value: 70, min: 0, max: 100, color: "#ffeb3b",
    label: "Brightness", unit: "%",
  });
  brightnessSlider.onInput = (val) => {
    status.text = `☀️ Brightness: ${Math.round(val)}%`;
  };
  sliderGroup.add(brightnessSlider);
  form.add(sliderGroup);

  // ================================================================
  // ANIMASI — update data real-time
  // ================================================================
  let segCounter = 2026;
  let t = 32, h = 60, p = 1008, l = 450;
  let cpu = 55, mem = 50, disk = 65, water1 = 70; water2 = 70;

  // Timer: update UI + chart (real sensor 30-60 detik)
  const uiTimer = new TTimer("tmr-ui", 2000, true);
  let uiBusy = false;
  uiTimer.onTimer = async () => {
    if (uiBusy) return; // skip jika masih sibuk
    uiBusy = true;
    try {
      t = Math.max(18, Math.min(45, t + (Math.random() - 0.5) * 3));
      h = Math.max(30, Math.min(90, h + (Math.random() - 0.5) * 4));
      p = Math.max(970, Math.min(1040, p + (Math.random() - 0.5) * 6));
      l = Math.max(50, Math.min(950, l + (Math.random() - 0.5) * 60));
      await Promise.all([
        cardTemp.setValue(Math.round(t * 10) / 10),
        cardHum.setValue(Math.round(h * 10) / 10),
        cardPress.setValue(Math.round(p * 10) / 10),
        cardLight.setValue(Math.round(l * 10) / 10),
      ]);

      cpu = Math.max(10, Math.min(95, cpu + (Math.random() - 0.5) * 6));
      mem = Math.max(15, Math.min(85, mem + (Math.random() - 0.5) * 5));
      disk = Math.max(30, Math.min(90, disk + (Math.random() - 0.5) * 3));
      await Promise.all([
        cpuGauge.setValue(Math.round(cpu)),
        memGauge.setValue(Math.round(mem)),
        diskGauge.setValue(Math.round(disk)),
      ]);
      chart.pushData(Date.now() / 1000, {
        temp: Math.round(t * 10) / 10,
        cpu: Math.round(cpu),
        mem: Math.round(mem),
        disk: Math.round(disk),
      });

      segCounter++;
      await segment.setValue(segCounter);

      water1 = Math.max(20, Math.min(95, water1 + (Math.random() - 0.5) * 5));
      water2 = Math.max(20, Math.min(95, water2 + (Math.random() - 0.5) * 5));
      await Promise.all([
        waterGauge1.setValue(Math.round(water1)),
        waterGauge2.setValue(Math.round(water2)),
      ]);

      status.text = `📊 Live: ${t.toFixed(1)}°C | ${h.toFixed(0)}% | ${Math.round(p)}hPa`;
    } finally {
      uiBusy = false;
    }
  };
  form.add(uiTimer);

  // ================================================================
  // RUN
  // ================================================================
  status.style = { ...status.style, gridColumn: "1 / -1" };
  form.onSetup = async () => {
    await chart.initChart();
  };
  await form.run();
});
