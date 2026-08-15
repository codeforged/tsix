/**
 * tab-demo.ts — Tabulator DataGrid Demo (Emerald — ConnectedTabulator)
 *
 * Menunjukkan tabel data berbasis Tabulator v6 (browser-side):
 *   - Sort asc/desc (klik header)  — ditangani Tabulator
 *   - Resize kolom (drag tepi header) — ditangani Tabulator
 *   - Select baris (single, highlight) + onRowClick
 *   - appendData() inkremental (hanya baris baru yang dikirim)
 *
 * Jalankan:  tab-demo
 * (Pastikan DOME running)
 *
 * (c) 2026 TSIX Project
 */

import { Program } from "@tsix/Application";
import { Screen, div, span, button, ConnectedTabulator } from "@tsix/emerald";

export const appMode = "gui";

export const main = Program(async (args: string[]) => {
  const app = new Screen({
    title: "Tabulator Grid Demo",
    width: 720,
    height: 480,
    maximizable: false,
  });

  const grid = new ConnectedTabulator({
    id: "sensor",
    columns: [
      { key: "node_id", label: "Node", width: 150 },
      { key: "sensor_id", label: "Sensor", width: 90 },
      { key: "value", label: "Nilai", width: 80, align: "right" },
      { key: "timestamp", label: "Waktu", width: "40%" },
    ],
    height: "100%",
  });

  // Status bar buat feedback event
  const statusId = "tab-demo-status";

  await app.mount(
    div(
      {
        id: "root",
        style: {
          padding: "12px",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
          boxSizing: "border-box",
        },
      },
      div(
        {
          style: {
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          },
        },
        span({
          text: "📊 Tabulator Grid (Emerald)",
          style: { fontSize: "16px", fontWeight: "700", color: "var(--accent, #4caf50)" },
        }),
        div({ style: { display: "flex", gap: "6px" } },
          button({
            id: "btn-append",
            text: "➕ Append 3 baris",
            onClickId: "btn-append",
            style: {
              background: "var(--button-bg, #0f3460)",
              color: "var(--accent, #4caf50)",
              border: "1px solid var(--accent, #4caf50)",
              borderRadius: "6px",
              padding: "4px 12px",
              fontSize: "11px",
              cursor: "pointer",
            },
          }),
          button({
            id: "btn-sort",
            text: "⇅ Sort Nilai",
            onClickId: "btn-sort",
            style: {
              background: "var(--button-bg, #0f3460)",
              color: "var(--accent, #4caf50)",
              border: "1px solid var(--accent, #4caf50)",
              borderRadius: "6px",
              padding: "4px 12px",
              fontSize: "11px",
              cursor: "pointer",
            },
          }),
        ),
      ),
      div({ id: "grid-wrap", style: { flex: "1", minHeight: "0" } }, grid.build()),
      span({
        id: statusId,
        text: "🖱️ klik baris → detail; klik header → sort; drag tepi header → resize",
        style: { fontSize: "11px", color: "var(--text-muted, #888)" },
      }),
    ),
  );

  await grid.mount(app);

  app.win.bindHandler("btn-append", "click", () => {
    const n = grid.data.length + 1;
    void grid.appendData([
      { node_id: "espDemo", sensor_id: "A1", value: n * 10, timestamp: new Date().toISOString().slice(0, 19).replace("T", " ") },
      { node_id: "espDemo", sensor_id: "A2", value: n * 10 + 5, timestamp: new Date().toISOString().slice(0, 19).replace("T", " ") },
      { node_id: "espDemo", sensor_id: "A3", value: n * 10 + 7, timestamp: new Date().toISOString().slice(0, 19).replace("T", " ") },
    ]);
    void app.update(statusId, { text: `➕ appended — total ${grid.data.length} baris` });
  });

  app.win.bindHandler("btn-sort", "click", () => {
    void grid.toggleSort("value");
  });

  await grid.setData([
    { node_id: "espMultiSensor", sensor_id: "R2", value: 12, timestamp: "2026-02-24 07:29:37" },
    { node_id: "espMultiSensor", sensor_id: "R1", value: 7, timestamp: "2026-02-24 07:29:37" },
    { node_id: "espMultiSensor", sensor_id: "04", value: 61, timestamp: "2026-02-24 07:29:37" },
    { node_id: "espMultiSensor", sensor_id: "03", value: 83, timestamp: "2026-02-24 07:29:37" },
    { node_id: "espMultiSensor", sensor_id: "02", value: 29, timestamp: "2026-02-24 07:29:37" },
    { node_id: "espMultiSensor", sensor_id: "01", value: 42, timestamp: "2026-02-24 07:29:37" },
  ]);

  await app.loopUntilClose();
});
