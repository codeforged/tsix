import { Program, std } from "@tsix/Application";
import { Screen, div, button, span, h2, h3, paragraph, input, text } from "@tsix/emerald";

export const appMode = "gui";

export const main = Program(async (args: string[]) => {
    await std.log("=== Emerald Layout Demo ===", "layout-demo");
    const app = new Screen("Layout Demo", undefined, false, 800, 600);

    await app.mount(div({ id: "root", style: { display: "flex", flexDirection: "column", height: "100%", fontSize: "13px" } },

        // ================================================================
        // HEADER
        // ================================================================
        div({ id: "header", style: { padding: "12px 16px", background: "#0f3460", borderBottom: "1px solid #333" } },
            h2({ text: "🎨 Emerald Layout Demo", style: { margin: 0, fontSize: "16px", color: "#4caf50" } }),
            paragraph({ text: "Grid, Flexbox, Sidebar, Cards — semua powered by CSS via Emerald", style: { margin: "4px 0 0 0", color: "#888", fontSize: "11px" } }),
        ),

        // ================================================================
        // BODY: Sidebar + Main
        // ================================================================
        div({ id: "body", style: { display: "flex", flex: "1", overflow: "hidden" } },

            // --- SIDEBAR ---
            div({ id: "sidebar", style: { width: "200px", background: "#16213e", padding: "12px", borderRight: "1px solid #333", overflowY: "auto" } },
                h3({ text: "📋 Menu", style: { color: "#4caf50", margin: "0 0 12px 0", fontSize: "14px" } }),
                sidebarItem("🏠", "Dashboard", "active"),
                sidebarItem("📊", "Analytics"),
                sidebarItem("📁", "Files"),
                sidebarItem("⚙️", "Settings"),
                sidebarItem("❓", "Help"),
            ),

            // --- MAIN CONTENT ---
            div({ id: "main", style: { flex: "1", padding: "16px", overflowY: "auto", background: "#1a1a2e" } },

                // Row 1: Stats Cards (2 cols)
                div({ id: "stats-row", style: { display: "flex", gap: "12px", marginBottom: "16px" } },
                    statCard("📦", "Projects", "12", "#4caf50"),
                    statCard("👥", "Users", "48", "#2196f3"),
                ),

                // Row 2: Stats Cards (2 cols)
                div({ id: "stats-row2", style: { display: "flex", gap: "12px", marginBottom: "16px" } },
                    statCard("💾", "Storage", "2.4 GB", "#ff9800"),
                    statCard("⚡", "Uptime", "3d 7h", "#9c27b0"),
                ),

                // Section: Recent Items
                h3({ text: "📋 Recent Items", style: { color: "#4caf50", margin: "0 0 8px 0", fontSize: "14px" } }),
                div({ id: "list-section", style: { marginBottom: "16px" } },
                    listItem("PixelTerm", "Terminal Emulator", "5 min ago"),
                    listItem("File Cruiser", "File Explorer", "12 min ago"),
                    listItem("guied", "GUI Daemon", "1 hour ago"),
                ),

                // Section: Buttons Row
                h3({ text: "🎮 Actions", style: { color: "#4caf50", margin: "0 0 8px 0", fontSize: "14px" } }),
                div({ id: "actions-row", style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
                    button({ id: "btn-save", text: "💾 Save", style: { background: "#4caf50", color: "white", padding: "8px 16px" } }),
                    button({ id: "btn-cancel", text: "❌ Cancel", style: { background: "#f44336", color: "white", padding: "8px 16px" } }),
                    button({ id: "btn-info", text: "ℹ️ Info", style: { background: "#2196f3", color: "white", padding: "8px 16px" } }),
                ),
            ),
        ),

        // ================================================================
        // FOOTER
        // ================================================================
        div({ id: "footer", style: { padding: "8px 16px", background: "#0f3460", borderTop: "1px solid #333", display: "flex", justifyContent: "space-between" } },
            span({ text: "© 2026 PixelSpace Layout Demo", style: { color: "#888", fontSize: "11px" } }),
            span({ text: "v1.0", style: { color: "#4caf50", fontSize: "11px" } }),
        ),
    ));

    // ================================================================
    // EVENT HANDLERS
    // ================================================================
    await app.on("btn-save", "click", async () => {
        const ans = await app.confirm("Simpan perubahan?", "Data dashboard akan diperbarui.", ["Yes", "No", "Cancel"]);
        if (ans === "Yes") {
            await app.alert("Tersimpan!", "Perubahan berhasil disimpan ke sistem.");
            await app.update("btn-save", { text: "✅ Saved!" });
        } else if (ans === "Cancel") {
            await app.alert("Dibatalkan", "Tidak ada perubahan yang disimpan.");
        }
    });
    await app.on("btn-cancel", "click", () => app.update("btn-cancel", { text: "🚫 Cancelled" }));
    await app.on("btn-info", "click", async () => {
        await app.alert("PixelSpace Layout Demo", "Demo grid, sidebar, cards — semua pakai CSS via PixelSpace DOM Engine.");
        await app.update("btn-info", { text: "📚 Info shown" });
    });

    await std.log("Layout Demo ready!", "layout-demo");
    await app.loopUntilClose();
});

// ================================================================
// HELPER COMPONENTS
// ================================================================
function sidebarItem(icon: string, label: string, state = "") {
    return div({
        style: {
            display: "flex", alignItems: "center", padding: "8px 10px",
            borderRadius: "4px", cursor: "pointer", marginBottom: "4px",
            background: state === "active" ? "#0f3460" : "transparent",
            color: state === "active" ? "#4caf50" : "#ccc",
            fontSize: "13px",
        },
    },
        span({ text: icon, style: { marginRight: "8px" } }),
        span({ text: label }),
    );
}

function statCard(icon: string, label: string, value: string, color: string) {
    return div({
        style: {
            flex: "1", padding: "16px", background: "#16213e",
            borderRadius: "8px", border: "1px solid #333",
        },
    },
        div({ style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" } },
            span({ text: icon, style: { fontSize: "24px" } }),
            span({ text: value, style: { fontSize: "24px", fontWeight: "700", color } }),
        ),
        span({ text: label, style: { color: "#888", fontSize: "12px" } }),
    );
}

function listItem(name: string, desc: string, time: string) {
    return div({
        style: {
            display: "flex", alignItems: "center", padding: "10px 12px",
            background: "#16213e", borderRadius: "6px", marginBottom: "4px",
        },
    },
        div({ style: { flex: "1" } },
            span({ text: name, style: { color: "#e0e0e0", fontWeight: "600", fontSize: "13px", display: "block" } }),
            span({ text: desc, style: { color: "#888", fontSize: "11px" } }),
        ),
        span({ text: time, style: { color: "#666", fontSize: "11px" } }),
    );
}
