import { Program, std, shell } from "@tsix/Application";
import { Screen, div, button, span, h1, ConnectedDataGrid, DataGridColumn } from "@tsix/emerald";
import { theme } from "@tsix/theme";

/**
 * TASK MANAGER — TSIX process manager with context menu actions.
 *
 * Features:
 * - Right-click context menu: Close (SIGTERM), Kill Force (SIGKILL)
 * - CSS hover on rows (survives refresh)
 * - Scroll position preserved on refresh
 */

export const appMode = "gui";

export const main = Program(async (args: string[]) => {
    const app = new Screen({ title: "📊 Task Manager", width: 720, height: 520 });

    // Load & apply theme
    await theme.loadCurrent();
    theme.watch();
    const ps = await shell.ps();
    const domePid = (ps.find((p: any) => p.name?.includes("dome")) || {}).pid || 0;

    // DataGrid untuk tabel task (sortable, selectable, resizable columns)
    const columns: DataGridColumn[] = [
        { key: "icon", label: "", width: 32, sortable: false, resizable: false, align: "center" },
        { key: "pid", label: "PID", width: 50, align: "right" },
        { key: "name", label: "Name", width: "40%" },
        { key: "state", label: "State", width: 80 },
        { key: "user", label: "User", width: 60 },
    ];
    const grid = new ConnectedDataGrid({
        id: "taskgrid",
        columns,
        height: "100%",
    });

    await app.mount(
        div({ id: "root", style: { padding: "12px", height: "100%", display: "flex", flexDirection: "column", gap: "8px" } },
            div({ style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
                h1({ text: "📊 Task Manager", style: { fontSize: "18px", color: "var(--accent, #4caf50)", margin: "0" } }),
                div({ style: { display: "flex", gap: "4px" } },
                    button({
                        id: "btn-refresh", text: "🔄 Refresh", onClickId: "btn-refresh",
                        style: { background: "var(--button-bg, #0f3460)", color: "var(--accent, #4caf50)", border: "1px solid var(--accent, #4caf50)", borderRadius: "6px", padding: "4px 14px", fontSize: "11px", cursor: "pointer" }
                    }),
                ),
            ),
            div({
                id: "legend", style: { fontSize: "10px", color: "var(--text-muted, #888)", padding: "4px 8px", background: "var(--bg, #0a0a1a)", borderRadius: "6px" },
            }, span({ id: "legend-text" })),
            div({ id: "grid-wrap", style: { flex: "1", minHeight: "0" } }, grid.build()),
        ),
    );
    await theme.applyToDome(domePid, app.wid);

    let activeRefresh = true;
    let _prevSnapshot = ""; // untuk deteksi perubahan

    // Context menu overlay (fixed position di window)
    let _ctxActive = false;
    const ctxId = "tm-ctx-menu";

    function showContextMenu(clientX: number, clientY: number, proc: any) {
        if (_ctxActive) return;
        _ctxActive = true;

        const menuW = 180, menuH = 90;
        let left = clientX, top = clientY;
        if (top + menuH > 520) top = clientY - menuH;
        if (left + menuW > 720) left = clientX - menuW;
        if (top < 0) top = 0;

        const pid = proc.pid;
        const closeId = ctxId + "-close";
        const killId = ctxId + "-kill";

        // Backdrop + menu
        app.mount(
            div({
                id: ctxId, style: { position: "fixed", inset: "0", zIndex: "999999", pointerEvents: "auto" },
                onClickId: ctxId,
            },
                // Backdrop transparan — dismiss pas klik di luar menu
                div({ id: ctxId + "-bg", style: { position: "absolute", inset: "0" } }),
                // Panel menu
                div({ id: ctxId + "-panel", style: { position: "fixed", left: left + "px", top: top + "px", background: "var(--surface, #1e2a4a)", border: "1px solid var(--accent, #4caf50)", borderRadius: "8px", padding: "4px 0", minWidth: "160px", boxShadow: "0 8px 24px rgba(0,0,0,0.6)", pointerEvents: "auto" } },
                    // Header: info proses
                    div({ style: { padding: "6px 12px 4px", borderBottom: "1px solid var(--border, rgba(255,255,255,0.08))", marginBottom: "4px" } },
                        span({ text: `${proc.name || "?"} (PID ${pid})`, style: { color: "var(--accent, #4caf50)", fontSize: "11px", fontWeight: "700", display: "block" } }),
                        span({ text: `State: ${proc.state || "?"}  User: ${proc.user || "?"}`, style: { color: "var(--text-muted, #888)", fontSize: "9px" } }),
                    ),
                    // Close (SIGTERM)
                    div({ id: closeId, onClickId: closeId, style: { padding: "7px 14px", cursor: "pointer", fontSize: "12px", color: "var(--warning, #ff9800)", display: "flex", alignItems: "center", gap: "8px" } },
                        span({ text: "✕" }), span({ text: "Close (SIGTERM 15)" }),
                    ),
                    // Kill (SIGKILL)
                    div({ id: killId, onClickId: killId, style: { padding: "7px 14px", cursor: "pointer", fontSize: "12px", color: "var(--danger, #f44336)", display: "flex", alignItems: "center", gap: "8px" } },
                        span({ text: "💀" }), span({ text: "Kill Force (SIGKILL 9)" }),
                    ),
                ),
            ),
        ).catch(() => {});

        const dismiss = () => {
            _ctxActive = false;
            app.win.unmount(ctxId).catch(() => {});
        };

        app.on(ctxId, "click", dismiss);
        app.on(closeId, "click", async () => {
            dismiss();
            try {
                await shell.kill(pid, 15);
            } catch (_) {}
        });
        app.on(killId, "click", async () => {
            dismiss();
            try {
                await shell.kill(pid, 9);
            } catch (_) {}
        });
    }

    async function renderList() {
        if (!app.running) return;
        try {
            const processes = await shell.ps();

            // Filter: exclude system daemons, show GUI + user apps
            const filtered = processes.filter((p: any) =>
                p.state !== "EXITED" &&
                p.pid > 1 &&
                p.name !== "tsh.ts" &&
                !p.name.endsWith(".menu") &&
                !["ps.js", "awk.js", "xargs.js", "echo.js", "grep.js", "cat.js", "kill.js", "init", "login.ts"].includes(p.name)
            );
            // Snapshot untuk deteksi perubahan
            const snap = filtered.map((p: any) => `${p.pid}:${p.state}:${p.name}`).join("|");
            if (snap === _prevSnapshot) return; // gak ada perubahan — skip render
            _prevSnapshot = snap;

            await app.update("legend-text", { text: `📋 ${filtered.length} active processes (${processes.filter((p: any) => p.state !== "EXITED").length} total)` });

            // Map ke rows datagrid
            const rows = filtered.map((p: any) => ({
                icon: detectGuiByName(p.name) ? "🪟" : "⚙️",
                pid: p.pid,
                name: p.name || "",
                state: p.state || "",
                user: p.user || "",
            }));
            await grid.setData(rows);
        } catch (e) {
            await app.update("legend-text", { text: "⚠️ Error loading process list" });
        }
    }

    // Refresh button
    await app.on("btn-refresh", "click", async () => {
        await renderList();
    });

    // Mount DataGrid — bind sort + row click + context menu (klik kanan)
    await grid.mount(
        app,
        () => {},                    // onSort (sort internal grid)
        () => {},                    // onRowClick (tidak dipakai)
        (index, record, x, y) => {   // onRowContextMenu
            showContextMenu(x, y, record);
        },
    );

    // Auto-refresh every 2s
    let refreshTimer: any = null;
    const scheduleRefresh = () => {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(async () => {
            if (activeRefresh) {
                await renderList();
                scheduleRefresh();
            }
        }, 2000);
    };
    scheduleRefresh();

    // Initial render
    await renderList();
    await app.loopUntilClose();
    activeRefresh = false;
    if (refreshTimer) clearTimeout(refreshTimer);
});

function detectGuiByName(name: string): boolean {
    const guiPatterns = [
        "asteracea", "gui-", "pixelterm", "eucalyptus", "file-cruiser",
        "iot-dashboard", "taskmgr", "layout-demo", "gui-demo", "dome",
    ];
    for (const p of guiPatterns) {
        if (name.toLowerCase().includes(p)) return true;
    }
    return false;
}
