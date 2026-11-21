/**
 * tab-demo-csh.ts — Tabulator DataGrid Demo (Cashew — TTabulatorGrid)
 *
 * API 100% sama dengan TDataGrid — tinggal ganti class-nya.
 *   - Sort asc/desc (klik header) — ditangani Tabulator di browser
 *   - Resize kolom (drag tepi header) — ditangani Tabulator
 *   - Select baris (single) + onRowClick + selectedIndex/getRecord
 *   - appendData() inkremental
 *
 * Jalankan:  tab-demo-csh
 * (Pastikan DOME running)
 *
 * (c) 2026 TSIX Project
 */

import { Program } from "@tsix/Application";
import { TForm, TButton, TLabel, TTabulatorGrid, HStack } from "@tsix/cashew";

export const appMode = "gui";

export const main = Program(async (args: string[]) => {
  const form = new TForm({
    title: "Tabulator Grid Demo (Cashew)",
    width: 720,
    height: 480,
    maximizable: false,
  });

  // ── Judul ──
  const lblTitle = new TLabel("title", {
    fontSize: "16px", fontWeight: "700",
    color: "var(--accent, #4caf50)", margin: "0",
  });
  lblTitle.caption = "📊 Tabulator Grid (Cashew)";
  form.add(lblTitle);

  // ── Toolbar ──
  const status = new TLabel("status", {
    fontSize: "12px", color: "var(--text-muted, #888)",
  });
  status.caption = "🖱️ klik baris → detail; klik header → sort; drag tepi header → resize";

  const btnAppend = new TButton("btn-append", { fontSize: "12px" });
  btnAppend.caption = "➕ Append 3 baris";
  const btnSort = new TButton("btn-sort", { fontSize: "12px" });
  btnSort.caption = "⇅ Sort Nilai";

  form.add(HStack({ padding: "4px 0" }, btnAppend, btnSort, status));

  // ── DataGrid (Tabulator) ──
  const grid = new TTabulatorGrid("sensor", [
    { key: "node_id", label: "Node", width: 150 },
    { key: "sensor_id", label: "Sensor", width: 90 },
    { key: "value", label: "Nilai", width: 80, align: "right" },
    { key: "timestamp", label: "Waktu", width: "40%" },
  ], [], { height: 340 });
  form.add(grid);

  // ── Detail baris terpilih (showcase selectedIndex + getRecord) ──
  const detail = new TLabel("detail", {
    fontSize: "12px", color: "var(--text-dim, #ccc)",
    margin: "8px 0 0 0", whiteSpace: "pre-wrap" as any,
  });
  detail.caption = "🖱️ klik salah satu baris — index stabil (tahan sort)";
  form.add(detail);

  // ── Data awal — di-set via onSetup (dipanggil TForm.run setelah mount) ──
  form.onSetup = async (screen) => {
    await grid.setData([
      { node_id: "espMultiSensor", sensor_id: "R2", value: 12, timestamp: "2026-02-24 07:29:37" },
      { node_id: "espMultiSensor", sensor_id: "R1", value: 7, timestamp: "2026-02-24 07:29:37" },
      { node_id: "espMultiSensor", sensor_id: "04", value: 61, timestamp: "2026-02-24 07:29:37" },
      { node_id: "espMultiSensor", sensor_id: "03", value: 83, timestamp: "2026-02-24 07:29:37" },
      { node_id: "espMultiSensor", sensor_id: "02", value: 29, timestamp: "2026-02-24 07:29:37" },
      { node_id: "espMultiSensor", sensor_id: "01", value: 42, timestamp: "2026-02-24 07:29:37" },
    ]);
  };

  // ── Event: klik row → select + tampilkan getRecord() ──
  grid.onRowClick = (idx, rec) => {
    const r = grid.getRecord(idx); // ambil ulang via row-key stabil
    const sel = grid.selectedIndex;
    detail.caption =
      `▶ rowKey=${sel} | selected=${r?.value} (${r?.node_id}/${r?.sensor_id})`;
  };

  // ── Tombol append ──
  btnAppend.onClick = async () => {
    const n = grid.data.length + 1;
    await grid.appendData([
      { node_id: "espDemo", sensor_id: "A1", value: n * 10, timestamp: new Date().toISOString().slice(0, 19).replace("T", " ") },
      { node_id: "espDemo", sensor_id: "A2", value: n * 10 + 5, timestamp: new Date().toISOString().slice(0, 19).replace("T", " ") },
      { node_id: "espDemo", sensor_id: "A3", value: n * 10 + 7, timestamp: new Date().toISOString().slice(0, 19).replace("T", " ") },
    ]);
    status.caption = `➕ appended — total ${grid.data.length} baris`;
  };

  // ── Tombol sort programmatic ──
  btnSort.onClick = async () => {
    await grid.setSelectedIndex(-1); // demo clear selection, lalu sort
    await grid.toggleSort("value");
    status.caption = `⇅ sort → ${grid.sort?.key} ${grid.sort?.dir}`;
  };

  await form.run();
});
