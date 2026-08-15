/**
 * gui-db-test-emr.ts — GUI DB Browser (Emerald)
 *
 * Aplikasi GUI untuk browse isi tabel `sensor_data` dari antigonon_iot.
 * Kombinasi: DbLib (akses DB) + ConnectedDataGrid (tampil + sort).
 *
 * Fitur:
 *   - Load data dari MySQL via DbLib
 *   - Tampil di DataGrid (variable column width + sort asc/desc)
 *   - Tombol Refresh
 *
 * Jalankan:  gui-db-test-emr
 * (Pastikan DOME running)
 *
 * (c) 2026 TSIX Project
 */

import { Program, std, db } from "@tsix/Application";
import {
    Screen, div, button, paragraph, span, ConnectedDataGrid, ConnectedTabulator,
} from "@tsix/emerald";
import { theme } from "@tsix/theme";

export const appMode = "gui";

const DB_CFG = {
    host: "192.168.1.204",
    user: "tsix_admin",
    password: "thequickbrownfox",
    database: "antigonon_iot",
};

export const main = Program(async (args: string[]) => {
    await theme.loadCurrent();
    theme.watch();

    const app = new Screen({
        title: "DB Browser — sensor_data (Emerald)",
        width: 720,
        height: 520,
        maximizable: false,
    });

    // ── DataGrid (tampil + sort) ──
    const grid = new ConnectedTabulator({
        id: "sensor",
        columns: [
            { key: "id", label: "ID", width: 60, align: "right" },
            { key: "node_id", label: "Node", width: 140 },
            { key: "sensor_id", label: "Sensor", width: 90 },
            { key: "value", label: "Nilai", width: 80, align: "right" },
            { key: "timestamp", label: "Waktu", width: "40%" },
        ],
    });

    // ── Mount UI ──
    await app.mount(
        div({
            id: "root",
            style: {
                padding: "16px", fontFamily: "sans-serif", height: "100%",
                boxSizing: "border-box", background: theme.colors.bg, color: theme.colors.text,
                display: "flex", flexDirection: "column", gap: "10px",
            },
        },
            paragraph({
                id: "title",
                text: "🗄️ DB Browser — sensor_data (Emerald)",
                style: { fontSize: "18px", fontWeight: "bold", margin: "0", color: theme.colors.accent },
            }),
            div({ id: "toolbar", style: { display: "flex", gap: "8px", alignItems: "center" } },
                button({
                    id: "btn-refresh",
                    text: "🔄 Refresh",
                    onClickId: "btn-refresh",  // ← mount-time listener (hindari bug cloneNode)
                    style: {
                        background: theme.colors.accent, color: "#fff", border: "none",
                        padding: "8px 18px", borderRadius: "6px", cursor: "pointer",
                        fontSize: "13px", fontWeight: "600",
                    },
                }),
                span({
                    id: "status",
                    text: "⏳ belum dimuat",
                    style: { fontSize: "12px", color: theme.colors.textMuted },
                }),
            ),
            grid.build(),
        ),
    );

    // ── Bind DataGrid + tombol Refresh ──
    await grid.mount(app);
    app.win.bindHandler("btn-refresh", "click", () => {
        void loadData();
    });

    // ── Load data dari MySQL via DbLib ──
    async function loadData(): Promise<void> {
        try {
            await app.setText("status", "⏳ connect...");
            const ok = await db.connect(DB_CFG);
            if (!ok) {
                await app.setText("status", "❌ connect gagal");
                return;
            }

            await app.setText("status", "⏳ query...");
            const rows = await db.query(
                "SELECT id, node_id, sensor_id, value, timestamp FROM sensor_data ORDER BY id DESC LIMIT 100",
            );

            if (rows && rows.error) {
                await app.setText("status", "❌ " + rows.error);
                return;
            }

            const arr = Array.isArray(rows) ? rows : [];
            await grid.setData(arr);
            await app.setText("status", `✅ ${arr.length} baris (klik header utk sort)`);
        } catch (e: any) {
            await app.setText("status", "❌ " + (e?.message || String(e)));
        }
    }

    await loadData();

    // ── Stay alive, tutup koneksi saat window ditutup ──
    await app.loopUntilClose();
    try { await db.disconnect(); } catch (_) { /* ignore */ }
});
