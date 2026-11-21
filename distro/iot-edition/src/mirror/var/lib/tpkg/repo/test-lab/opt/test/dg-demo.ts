/**
 * dg-demo.ts — DataGrid Demo (ConnectedDataGrid)
 *
 * Menunjukkan tabel data Emerald dengan:
 *   - Variable column width (px & %)
 *   - Sort asc/desc (klik header kolom)
 *
 * Jalankan:  dg-demo
 * (Pastikan DOME running)
 *
 * (c) 2026 TSIX Project
 */

import { Program } from "@tsix/Application";
import { Screen, ConnectedDataGrid } from "@tsix/emerald";

export const appMode = "gui";

export const main = Program(async (args: string[]) => {
    const app = new Screen({
        title: "DataGrid Demo",
        width: 640,
        height: 420,
        maximizable: false,
    });

    const grid = new ConnectedDataGrid({
        id: "sensor",
        columns: [
            { key: "node_id", label: "Node", width: 150 },
            { key: "sensor_id", label: "Sensor", width: 90 },
            { key: "value", label: "Nilai", width: 80, align: "right" },
            { key: "timestamp", label: "Waktu", width: "40%" },
        ],
    });

    await app.mount(grid.build());
    await grid.mount(app);

    await grid.setData([
        { node_id: "espMultiSensor", sensor_id: "R2", value: 0, timestamp: "2026-02-24 07:29:37" },
        { node_id: "espMultiSensor", sensor_id: "R1", value: 1, timestamp: "2026-02-24 07:29:37" },
        { node_id: "espMultiSensor", sensor_id: "04", value: 61, timestamp: "2026-02-24 07:29:37" },
        { node_id: "espMultiSensor", sensor_id: "03", value: 83, timestamp: "2026-02-24 07:29:37" },
        { node_id: "espMultiSensor", sensor_id: "02", value: 29, timestamp: "2026-02-24 07:29:37" },
        { node_id: "espMultiSensor", sensor_id: "01", value: 42, timestamp: "2026-02-24 07:29:37" },
    ]);

    // Contoh: ambil state sort saat ini
    // console.log(grid.sort);  // → { key: "value", dir: "desc" }

    await app.loopUntilClose();
});
