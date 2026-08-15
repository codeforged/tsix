/**
 * gui-db-test-csh.ts — GUI DB Browser (Cashew)
 *
 * Aplikasi GUI untuk browse isi tabel `sensor_data` dari antigonon_iot,
 * dibangun dengan Cashew (Delphi-style): TForm + TDataGrid + TButton + TStatusBar.
 *
 * Kombinasi: DbLib (akses DB) + TDataGrid (tampil + sort).
 *
 * Fitur:
 *   - Load data dari MySQL via DbLib
 *   - Tampil di TDataGrid (variable column width + sort asc/desc)
 *   - Hover row + klik row → selectedIndex & getRecord()
 *     (index = kunci stabil per datarow, BUKAN nomor baris → tahan sorting)
 *   - Tombol Refresh + status bar
 *
 * Jalankan:  gui-db-test-csh
 * (Pastikan DOME running)
 *
 * (c) 2026 TSIX Project
 */

import { Program, std, db } from "@tsix/Application";
import { TForm, TButton, TLabel, TDataGrid, HStack, TTabulatorGrid } from "@tsix/cashew";

export const appMode = "gui";

const DB_CFG = {
    host: "192.168.1.204",
    user: "tsix_admin",
    password: "thequickbrownfox",
    database: "antigonon_iot",
};

export const main = Program(async (args: string[]) => {
    const form = new TForm("DB Browser — sensor_data (Cashew)", 720, 520);

    // ── Header (samakan dengan versi Emerald) ──
    const lblTitle = new TLabel("title", {
        fontSize: "18px", fontWeight: "bold",
        color: "var(--accent, #4caf50)", margin: "0",
    });
    lblTitle.caption = "🗄️ DB Browser — sensor_data (Cashew)";
    form.add(lblTitle);

    // ── Toolbar: tombol refresh + status ──
    const status = new TLabel("status", {
        fontSize: "12px", color: "var(--text-muted, #888)",
    });
    status.caption = "⏳ belum dimuat";

    const btnRefresh = new TButton("btn-refresh", {
        // background: "var(--accent, #4caf50)", color: "#fff", border: "none",
        margin: "8px 0", borderRadius: "6px", cursor: "pointer",
        fontSize: "13px", fontWeight: "600",
    });
    btnRefresh.caption = "🔄 Refresh";

    const toolbar = HStack(btnRefresh, status);
    form.add(toolbar);

    // ── DataGrid ──
    const grid = new TTabulatorGrid("sensor", [
        { key: "id", label: "ID", width: 60, align: "right" },
        { key: "node_id", label: "Node", width: 140 },
        { key: "sensor_id", label: "Sensor", width: 90 },
        { key: "value", label: "Nilai", width: 80, align: "right" },
        { key: "timestamp", label: "Waktu", width: "40%" },
    ], [], { height: 340});
    form.add(grid);

    // ── Detail baris yang dipilih (showcase selectedIndex + getRecord) ──
    const detail = new TLabel("detail", {
        fontSize: "12px", color: "var(--text-dim, #ccc)",
        margin: "8px 0 0 0", whiteSpace: "pre-wrap" as any,
    });
    detail.caption = "🖱️ klik salah satu baris — index stabil (tahan sort)";
    form.add(detail);

    // ── Load data dari MySQL via DbLib ──
    async function loadData(): Promise<void> {
        try {
            status.caption = "⏳ connect...";
            const ok = await db.connect(DB_CFG);
            if (!ok) {
                status.caption = "❌ connect gagal";
                return;
            }

            status.caption = "⏳ query...";
            const rows = await db.query(
                "SELECT id, node_id, sensor_id, value, timestamp FROM sensor_data ORDER BY id DESC LIMIT 100",
            );

            if (rows && rows.error) {
                status.caption = "❌ " + rows.error;
                return;
            }

            const arr = Array.isArray(rows) ? rows : [];
            await grid.setData(arr);   // ← async method, bisa di-await
            detail.caption = "🖱️ klik salah satu baris — index stabil (tahan sort)";
            status.caption = `✅ ${arr.length} baris (klik header utk sort / row utk pilih)`;
        } catch (e: any) {
            status.caption = "❌ " + (e?.message || String(e));
        }
    }

    // ── Event: klik row → select + tampilkan getRecord() ──
    // idx = row-key STABIL (bukan nomor baris) → getRecord(idx) & selectedIndex
    // tetap benar walau user sort berulang kali.
    grid.onRowClick = (idx, rec) => {
        const r = grid.getRecord(idx);           // ← ambil ulang via row-key
        const sel = grid.selectedIndex;          // ← cursor (kunci stabil, tahan sort)
        detail.caption =
            `▶ rowKey=${sel}\n` +
            `  id=${r?.id} | node=${r?.node_id} | sensor=${r?.sensor_id} | ` +
            `value=${r?.value} | ${r?.timestamp}`;
    };

    // ── Event: tombol refresh ──
    btnRefresh.onClick = () => { void loadData(); };

    // ── Load awal setelah form siap (bind selesai) ──
    form.onSetup = async () => {
        await loadData();
    };

    await form.run();
    try { await db.disconnect(); } catch (_) { /* ignore */ }
});
