/**
 * azalea-dashboard.ts ÃÂ¢ÃÂÃÂ Remote Lantana dashboard client berbasis Pistachio.
 *
 * Azalea berkomunikasi dengan lantana-dashboard-server lewat NetSocket.
 * Usage: azalea-dashboard
 */

import * as crypto from "crypto";
import { Program, std } from "@tsix/Application";
import {
  TButton,
  TEdit,
  TForm,
  TGridPanel,
  TGroupBox,
  TIndicatorLamp,
  TLabel,
  TLineChart,
  TPanel,
  TRadialGauge,
  TScrollBox,
  TSensorCard,
  THStack,
  TToggleSwitch,
} from "@tsix/pistachio";
import {
  MSG_DASH_SWITCH_STATUS,
} from "@tsix/lantana/lantana-core";
import type {
  PortableDashboardItemType,
  ReadingValue,
} from "@tsix/lantana/lantana-core";
import type { DashboardSwitchStatusUpdate } from "@tsix/lantana/dashboard-switch-status";
import { DashboardCommunication } from "@tsix/lantana/azalea-dashboard-communication";

interface RemoteDashboardItem {
  id: string;
  itemIndex: number;
  type: PortableDashboardItemType;
  title: string;
  icon: string;
  updateInterval: number;
  scrollAfter?: number;
  deviceId: string;
  schemeId?: number;
  commandPrefix?: string;
  value: ReadingValue | null;
  label: string;
  unit: string;
  updatedAt: number | null;
  deviceStatus: string;
  min: number | null;
  max: number | null;
}

interface CardBinding {
  item: RemoteDashboardItem;
  kind: "text" | "number" | "gauge" | "chart" | "indicator" | "switch";
  valueLabel?: TLabel;
  sensor?: TSensorCard;
  gauge?: TRadialGauge;
  chart?: TLineChart;
  lamp?: TIndicatorLamp;
  toggle?: TToggleSwitch;
  chartValues?: number[];
  lastChartSampleAt?: number;
}

interface PendingCommand {
  itemIndex: number;
  timer: ReturnType<typeof setTimeout>;
}

function isReadingValue(value: unknown): value is ReadingValue {
  return (
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function parseRemoteItem(value: any): RemoteDashboardItem {
  const allowedTypes: PortableDashboardItemType[] = [
    "text",
    "radialGauge",
    "lineChart",
    "switchIndicator",
    "switch",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.id !== "string" ||
    !Number.isInteger(value.itemIndex) ||
    !allowedTypes.includes(value.type) ||
    typeof value.title !== "string" ||
    typeof value.deviceId !== "string" ||
    !Number.isFinite(value.updateInterval) ||
    (value.scrollAfter !== undefined &&
      (!Number.isInteger(value.scrollAfter) ||
        value.scrollAfter < 1 ||
        value.scrollAfter > 500)) ||
    (value.value !== null &&
      value.value !== undefined &&
      !isReadingValue(value.value))
  ) {
    throw new Error("Data item dashboard dari server tidak valid.");
  }
  return {
    id: value.id,
    itemIndex: value.itemIndex,
    type: value.type,
    title: value.title,
    icon: typeof value.icon === "string" ? "" : "",
    updateInterval: value.updateInterval,
    ...(value.scrollAfter !== undefined
      ? { scrollAfter: value.scrollAfter }
      : {}),
    deviceId: value.deviceId,
    ...(Number.isInteger(value.schemeId) ? { schemeId: value.schemeId } : {}),
    ...(typeof value.commandPrefix === "string"
      ? { commandPrefix: value.commandPrefix }
      : {}),
    value: value.value ?? null,
    label: typeof value.label === "string" ? value.label : value.title,
    unit: typeof value.unit === "string" ? value.unit : "",
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : null,
    deviceStatus:
      typeof value.deviceStatus === "string" ? value.deviceStatus : "UNKNOWN",
    min: Number.isFinite(value.min) ? value.min : null,
    max: Number.isFinite(value.max) ? value.max : null,
  };
}

function formatValue(value: ReadingValue | null): string {
  if (value === null) return "ÃÂ¢ÃÂÃÂ";
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
}

function asNumber(value: ReadingValue | null): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asBoolean(value: ReadingValue | null): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "on"].includes(normalized)) return true;
  if (["0", "false", "off"].includes(normalized)) return false;
  return undefined;
}

export const appMode = "gui";

const CARD_STYLE = {
  width: "100%",
  minWidth: "0",
  height: "200px",
  flex: "1 1 auto",
};

export const main = Program(async () => {
  const form = new TForm({
    title: "Azalea Dashboard",
    icon: "",
    width: 800,
    height: 680,
    style: { padding: "14px", gap: "12px" },
  });
  const hostEdit = new TEdit({
    id: "azalea-host",
    placeholder: "Alamat node TSIX",
    text: "jatitsix_3",
    style: { minWidth: "190px" },
  });
  const portEdit = new TEdit({
    id: "azalea-port",
    placeholder: "Port",
    text: "1515",
    style: { width: "78px" },
  });
  const pinEdit = new TEdit({
    id: "azalea-pin",
    placeholder: "PIN dashboard (6 digit)",
    text: "335773",
    style: { width: "170px" },
  });
  const connectButton = new TButton({
    id: "azalea-connect",
    caption: "Connect",
  });
  const refreshButton = new TButton({
    id: "azalea-refresh",
    caption: "Refresh",
    enabled: false,
  });
  const statusLabel = new TLabel({
    id: "azalea-status",
    text: "Masukkan alamat server dan PIN dashboard.",
    style: {
      color: "var(--text-dim, #999)",
      display: "block",
      flex: "1",
      minWidth: "0",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
    },
  });
  const titleLabel = new TLabel({
    id: "azalea-title",
    text: "Azalea Dashboard",
    style: { fontSize: "20px", fontWeight: "700" },
  });
  const connectionRow = new THStack({
    id: "azalea-connection-row",
    children: [
      hostEdit,
      portEdit,
      pinEdit,
      connectButton,
      refreshButton,
    ],
    style: { flexWrap: "wrap" },
  });
  const statusRow = new THStack({
    id: "azalea-status-row",
    children: [statusLabel],
    style: { width: "100%", minHeight: "20px" },
  });
  const groupsContainer = new THStack({
    id: "azalea-groups",
    style: { alignItems: "stretch", flexDirection: "column", gap: "12px" },
  });
  const scroll = new TScrollBox({
    id: "azalea-scroll",
    children: [groupsContainer],
    style: { flex: "1", minHeight: "0" },
  });
  form.add(titleLabel);
  form.add(connectionRow);
  form.add(statusRow);
  form.add(scroll);

  let dashboardId = "";
  let dashboardTitle = "";
  let snapshotPending = false;
  let snapshotTimeout: ReturnType<typeof setTimeout> | null = null;
  let snapshotTimer: ReturnType<typeof setInterval> | null = null;
  let remoteItems: RemoteDashboardItem[] = [];
  let dashboardRendered = false;
  const bindings = new Map<number, CardBinding>();
  const pendingCommands = new Map<string, PendingCommand>();

  const setStatus = (message: string, color = "var(--text-dim, #999)") => {
    statusLabel.text = message;
    statusLabel.style = { ...statusLabel.style, color };
  };

  const clearCards = () => {
    for (const child of [...groupsContainer.children]) {
      groupsContainer.remove(child);
      child.dispose();
    }
    bindings.clear();
    dashboardRendered = false;
  };

  const stopTimers = () => {
    if (snapshotTimer) clearInterval(snapshotTimer);
    if (snapshotTimeout) clearTimeout(snapshotTimeout);
    snapshotTimer = null;
    snapshotTimeout = null;
  };

  const closeConnection = async () => {
    stopTimers();
    for (const pending of pendingCommands.values()) clearTimeout(pending.timer);
    pendingCommands.clear();
    snapshotPending = false;
    remoteItems = [];
    dashboardId = "";
    dashboardTitle = "";
    clearCards();
    refreshButton.enabled = false;
    await communication.close("Azalea disconnected");
  };

  const applyValue = (binding: CardBinding, appendChart = false) => {
    const value = binding.item.value;
    switch (binding.kind) {
      case "text":
        if (binding.valueLabel) binding.valueLabel.text = formatValue(value);
        break;
      case "number":
        if (binding.sensor) binding.sensor.value = asNumber(value) ?? 0;
        break;
      case "gauge":
        if (binding.gauge) binding.gauge.value = asNumber(value) ?? 0;
        break;
      case "chart": {
        if (!binding.chart) break;
        const numeric = asNumber(value);
        if (binding.valueLabel) {
          binding.valueLabel.text =
            numeric === undefined
              ? binding.chartValues?.length
                ? `Data terakhir: ${binding.chartValues[binding.chartValues.length - 1]}${binding.item.unit ? ` ${binding.item.unit}` : ""}`
                : "Menunggu data"
              : `${formatValue(value)}${binding.item.unit ? ` ${binding.item.unit}` : ""}`;
        }
        let changed = false;
        const maxPoints = binding.item.scrollAfter ?? 7;
        if (appendChart && numeric !== undefined) {
          if (!binding.chartValues?.length) {
            binding.chartValues = [numeric, numeric];
          } else {
            binding.chartValues.push(numeric);
          }
          if (binding.chartValues.length > maxPoints) {
            binding.chartValues.splice(
              0,
              binding.chartValues.length - maxPoints,
            );
          }
          changed = true;
        } else if (!appendChart && numeric !== undefined && !binding.chartValues?.length) {
          binding.chartValues = [numeric, numeric].slice(-maxPoints);
          changed = true;
        }
        if (
          binding.chartValues &&
          binding.chartValues.length > maxPoints
        ) {
          binding.chartValues.splice(
            0,
            binding.chartValues.length - maxPoints,
          );
          changed = true;
        }
        if (changed) binding.chart.data = [...(binding.chartValues ?? [])];
        break;
      }
      case "indicator": {
        const on = asBoolean(value);
        if (binding.lamp) binding.lamp.on = on ?? false;
        if (binding.valueLabel) binding.valueLabel.text = formatValue(value);
        break;
      }
      case "switch": {
        const on = asBoolean(value);
        if (binding.toggle) binding.toggle.on = on ?? false;
        if (binding.valueLabel) binding.valueLabel.text = formatValue(value);
        break;
      }
    }
  };

  const sendSwitchCommand = async (
    binding: CardBinding,
    requestedState: boolean,
  ) => {
    const requestId = crypto.randomBytes(16).toString("hex");
    const timer = setTimeout(() => {
      pendingCommands.delete(requestId);
      setStatus(`Belum ada balasan untuk switch "${binding.item.title}".`, "#ff9800");
    }, 7000);
    pendingCommands.set(requestId, {
      itemIndex: binding.item.itemIndex,
      timer,
    });
    setStatus(
      `Mengirim command ke ${binding.item.deviceId}ÃÂ¢ÃÂÃÂ¦`,
      "var(--text-dim, #999)",
    );
    try {
      await communication.sendEncrypted({
        type: "LANTANA_DASH_SWITCH_REQ",
        requestId,
        itemId: binding.item.id,
        itemIndex: binding.item.itemIndex,
        value: requestedState,
      });
    } catch (error) {
      clearTimeout(timer);
      pendingCommands.delete(requestId);
      setStatus(
        `Gagal mengirim command: ${error instanceof Error ? error.message : String(error)}`,
        "#f44336",
      );
    }
  };

  const createCard = (grid: TGridPanel, item: RemoteDashboardItem) => {
    const index = item.itemIndex;
    const id = `azalea-card-${index}`;
    if (item.type === "text" && typeof item.value === "number") {
      const sensor = new TSensorCard({
        id,
        caption: item.title,
        icon: item.icon,
        value: item.value,
        unit: item.unit,
        min: item.min ?? 0,
        max: item.max ?? 100,
        style: CARD_STYLE,
      });
      grid.add(sensor);
      bindings.set(index, { item, kind: "number", sensor });
      return;
    }

    if (item.type === "text") {
      const valueLabel = new TLabel({
        id: `${id}-value`,
        text: formatValue(item.value),
        style: { fontSize: "24px", fontWeight: "700", paddingTop: "10px" },
      });
      grid.add(
        new TPanel({
          id,
          children: [
            new TLabel({ id: `${id}-title`, text: item.title }),
            valueLabel,
          ],
          style: {
            width: "100%",
            minWidth: "0",
            minHeight: "200px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            boxSizing: "border-box",
          },
        }),
      );
      bindings.set(index, { item, kind: "text", valueLabel });
      return;
    }

    if (item.type === "radialGauge") {
      const gauge = new TRadialGauge({
        id,
        caption: item.title,
        value: asNumber(item.value) ?? 0,
        min: item.min ?? 0,
        max: item.max ?? 100,
        unit: item.unit,
        style: CARD_STYLE,
      });
      grid.add(gauge);
      bindings.set(index, { item, kind: "gauge", gauge });
      return;
    }

    if (item.type === "lineChart") {
      const initialValue = asNumber(item.value);
      const maxPoints = item.scrollAfter ?? 7;
      const initialChartValues =
        initialValue === undefined
          ? []
          : [initialValue, initialValue].slice(-maxPoints);
      const chart = new TLineChart({
        id: `${id}-chart`,
        data: initialChartValues,
        width: 240,
        height: 135,
        fill: true,
        spline: false,
        color: "#218c55",
        viewStyle: { padding: "6px", minWidth: "0" },
        showXAxisLabels: false,
        showYAxisLabels: false,
      });
      const chartStatus = new TLabel({
        id: `${id}-status`,
        text: initialValue === undefined ? "Menunggu data" : formatValue(item.value),
        style: {
          display: "block",
          fontSize: "11px",
          color: "var(--text-dim, #999)",
        },
      });
      grid.add(
        new TPanel({
          id,
          children: [
            new TLabel({
              id: `${id}-title`,
              text: item.title,
              style: { fontWeight: "600", paddingBottom: "0" },
            }),
            chart,
            chartStatus,
          ],
          style: {
            width: "100%",
            minWidth: "0",
            height: "200px",
            minHeight: "200px",
            maxHeight: "200px",
            padding: "6px",
            background: "#ffffff",
            display: "flex",
            flexDirection: "column",
            gap: "4px",
            boxSizing: "border-box",
            overflow: "hidden",
          },
        }),
      );
      bindings.set(index, {
        item,
        kind: "chart",
        chart,
        valueLabel: chartStatus,
        chartValues: initialChartValues,
        lastChartSampleAt:
          initialValue === undefined ? undefined : Date.now(),
      });
      return;
    }

    if (item.type === "switchIndicator") {
      const lamp = new TIndicatorLamp({
        id: `${id}-lamp`,
        caption: item.title,
        on: asBoolean(item.value) ?? false,
        style: CARD_STYLE,
      });
      grid.add(lamp);
      bindings.set(index, { item, kind: "indicator", lamp });
      return;
    }

    const toggle = new TToggleSwitch({
      id: `${id}-toggle`,
      caption: item.title,
      on: asBoolean(item.value) ?? false,
      controlled: true,
      style: CARD_STYLE,
    });
    const binding: CardBinding = {
      item,
      kind: "switch",
      toggle,
    };
    toggle.onChange = (requestedState) => {
      void sendSwitchCommand(binding, requestedState);
    };
    grid.add(toggle);
    bindings.set(index, binding);
  };

  const renderItemGroups = (items: RemoteDashboardItem[]) => {
    const grids = new Map<string, TGridPanel>();
    const groups: TGroupBox[] = [];
    let groupIndex = 0;
    for (const item of items) {
      let grid = grids.get(item.deviceId);
      if (!grid) {
        grid = new TGridPanel({
          id: `azalea-device-grid-${groupIndex}`,
          columns: 3,
          style: {
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: "12px",
            alignContent: "start",
            width: "100%",
          },
        });
        groups.push(
          new TGroupBox({
            id: `azalea-device-group-${groupIndex}`,
            caption: "",//item.deviceId,
            children: [grid],
            style: { width: "100%", boxSizing: "border-box" },
          }),
        );
        grids.set(item.deviceId, grid);
        groupIndex++;
      }
      createCard(grid, item);
    }
    for (const group of groups) groupsContainer.add(group);
  };

  const renderSnapshot = (data: any) => {
    if (typeof data.dashboardId !== "string" || !Array.isArray(data.items)) {
      throw new Error("Snapshot dashboard dari server tidak valid.");
    }
    const items: RemoteDashboardItem[] = (data.items as unknown[]).map(
      parseRemoteItem,
    );
    const rebuild =
      !dashboardRendered ||
      data.dashboardId !== dashboardId ||
      items.length !== remoteItems.length ||
      items.some((item: RemoteDashboardItem, index: number) => {
        const previous = remoteItems[index];
        return (
          !previous ||
          previous.itemIndex !== item.itemIndex ||
          previous.id !== item.id ||
          previous.type !== item.type
        );
      });

    dashboardId = data.dashboardId;
    if (typeof data.title === "string") dashboardTitle = data.title;
    titleLabel.text = dashboardTitle || "Azalea Dashboard";
    remoteItems = items;

    if (rebuild) {
      clearCards();
      renderItemGroups(items);
      dashboardRendered = true;
    } else {
      const now = Date.now();
      for (const item of items) {
        const binding = bindings.get(item.itemIndex);
        if (!binding) continue;
        const appendChart =
          binding.kind === "chart" &&
          asNumber(item.value) !== undefined &&
          (binding.lastChartSampleAt === undefined ||
            now - binding.lastChartSampleAt >= item.updateInterval * 1000);
        if (appendChart) binding.lastChartSampleAt = now;
        binding.item = item;
        applyValue(binding, appendChart);
      }
    }
    if (rebuild && items.length === 0) {
      groupsContainer.add(
        new TLabel({
          id: "azalea-empty",
          text: "Dashboard ini belum memiliki widget.",
          style: { color: "var(--text-dim, #999)", padding: "16px" },
        }),
      );
    }
    snapshotPending = false;
    if (snapshotTimeout) clearTimeout(snapshotTimeout);
    snapshotTimeout = null;
    setStatus(
      `Terhubung ÃÂÃÂ· ${items.length} widget ÃÂÃÂ· ${dashboardTitle || dashboardId}`,
      "#4caf50",
    );

    if (snapshotTimer) clearInterval(snapshotTimer);
    const intervals = items
      .filter((item) => item.type !== "switch")
      .map((item) => item.updateInterval)
      .filter((interval) => Number.isFinite(interval) && interval > 0);
    if (intervals.length) {
      const intervalMs = Math.max(1000, Math.min(...intervals) * 1000) + 300;
      snapshotTimer = setInterval(() => {
        void requestSnapshot();
      }, intervalMs);
    }
  };

  const requestSnapshot = async () => {
    if (!communication.isAuthenticated || snapshotPending) return;
    snapshotPending = true;
    snapshotTimeout = setTimeout(() => {
      snapshotPending = false;
      snapshotTimeout = null;
      setStatus("Timeout menunggu snapshot dashboard.", "#ff9800");
    }, 17_000);
    try {
      await communication.sendEncrypted({ type: "LANTANA_DASH_SNAPSHOT_REQ" });
    } catch (error) {
      snapshotPending = false;
      if (snapshotTimeout) clearTimeout(snapshotTimeout);
      snapshotTimeout = null;
      setStatus(
        `Gagal meminta snapshot: ${error instanceof Error ? error.message : String(error)}`,
        "#f44336",
      );
    }
  };

  const processSwitchStatus = (updates: DashboardSwitchStatusUpdate[]) => {
    for (const update of updates) {
      const binding = bindings.get(update.itemIndex);
      if (
        !binding ||
        binding.kind !== "switch" ||
        binding.item.id !== update.itemId ||
        typeof update.value !== "boolean"
      ) continue;
      binding.item.value = update.value;
      binding.item.updatedAt = update.updatedAt;
      applyValue(binding);
    }
  };

  const handleSecureMessage = (message: any) => {
    if (!message || typeof message.type !== "string") {
      throw new Error("Pesan terenkripsi dari server tidak valid.");
    }
    if (message.type === "LANTANA_DASH_AUTH_OK") {
      dashboardId = String(message.dashboardId ?? "");
      dashboardTitle =
        typeof message.title === "string" ? message.title : "Lantana Dashboard";
      titleLabel.text = dashboardTitle;
      refreshButton.enabled = true;
      setStatus(`Terautentikasi ÃÂÃÂ· ${dashboardTitle}`, "#4caf50");
      void requestSnapshot();
      return;
    }
    if (message.type === "LANTANA_DASH_SNAPSHOT") {
      renderSnapshot(message);
      return;
    }
    if (message.type === MSG_DASH_SWITCH_STATUS) {
      if (Array.isArray(message.updates)) processSwitchStatus(message.updates);
      return;
    }
    if (message.type === "LANTANA_DASH_SWITCH_RESULT") {
      const pending = pendingCommands.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingCommands.delete(message.requestId);
      setStatus(
        message.ok === true
          ? `Command diterima; menunggu status switch #${pending.itemIndex + 1}.`
          : `Command switch gagal: ${message.message || "kesalahan tidak diketahui"}`,
        message.ok === true ? "#4caf50" : "#f44336",
      );
      return;
    }
    if (message.type === "LANTANA_DASH_AUTH_REVOKED") {
      void closeConnection().finally(() => {
        setStatus(message.message || "Akses dashboard telah dicabut.", "#f44336");
      });
      return;
    }
    if (message.type === "LANTANA_DASH_ERROR") {
      snapshotPending = false;
      if (snapshotTimeout) clearTimeout(snapshotTimeout);
      snapshotTimeout = null;
      setStatus(message.message || "Server dashboard melaporkan kesalahan.", "#ff9800");
    }
  };

  const communication = new DashboardCommunication({
    onStatus: setStatus,
    onSecureMessage: (message) => handleSecureMessage(message),
    onClose: (reason) => {
      refreshButton.enabled = false;
      setStatus(
        `Koneksi NetSocket ditutup${reason ? `: ${reason}` : ""}.`,
        "#f44336",
      );
    },
  });

  const connect = async () => {
    await closeConnection();
    const host = hostEdit.text.trim();
    const port = Number.parseInt(portEdit.text.trim(), 10);
    const pin = pinEdit.text.trim();
    await communication.connect(host, port, pin);
  };

  connectButton.onClick = () => {
    connectButton.enabled = false;
    void connect()
      .catch((error) => {
        setStatus(
          error instanceof Error ? error.message : String(error),
          "#f44336",
        );
      })
      .finally(() => {
        connectButton.enabled = true;
      });
  };
  refreshButton.onClick = () => {
    void requestSnapshot();
  };
  form.onClose = () => {
    void closeConnection().catch((error) => {
      void std.print(`[azalea-dashboard] Gagal menutup NetSocket: ${String(error)}\n`);
    });
  };

  await form.run();
});
