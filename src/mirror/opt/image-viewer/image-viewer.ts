/**
 * image-viewer.ts — TSIX Image Viewer (Demo TImage Cashew)
 *
 * Panel kiri: explorer tree (direktori + file, contek Eucalyptus).
 * Panel kanan: preview gambar via TImage (load dari path file VFS → base64).
 *
 * Fitur:
 *  - Klik direktori → expand/collapse
 *  - Klik file gambar (.png/.jpg/.jpeg/.gif/.bmp/.webp/.svg/.ico) → preview
 *  - Klik file non-gambar → info ukuran/tipe, bukan preview
 *  - Status bar: nama file, ukuran, resolusi info dasar
 *
 * Cara pakai:
 *   image-viewer              → mulai dari /
 *   image-viewer <path>       → mulai dari direktori tertentu
 *
 * Jalankan: image-viewer
 * (Pastikan DOME running)
 *
 * (c) 2026 TSIX Project
 */

import { Program, std, fs } from "@tsix/Application";
import { Screen, div, text, span, h2, h3 } from "@tsix/emerald";
import { theme } from "@tsix/theme";
import { TImage } from "@tsix/cashew";

export const appMode = "gui";

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".ico"];

export const main = Program(async (args: string[]) => {
    await std.log("=== Image Viewer (TImage Demo) ===");
    await theme.loadCurrent();
    theme.watch();

    const app = new Screen({
        title: "🖼️ Image Viewer",
        icon: "🖼️",
        width: 920,
        height: 620,
        resizable: true,
        maximizable: true,
    });

    let startDir = "/";
    if (args.length > 0 && args[0]) startDir = args[0];
    const expandedDirs: Set<string> = new Set([startDir]);
    let currentFile: string | null = null;

    const isImage = (name: string) =>
        IMAGE_EXTS.some((e) => name.toLowerCase().endsWith(e));

    // TImage — komponen preview. Auto-load dari file saat di-bind.
    const preview = new TImage("img-preview", {
        alt: "Preview",
        fit: "contain",
        width: "100%",
        style: { flex: "1", minHeight: "0", objectFit: "contain" as any },
    });

    // ================================================================
    // BUILD UI
    // ================================================================
    await app.mount(
        div(
            { id: "root", style: { padding: "8px", height: "100%", display: "flex", flexDirection: "column", background: theme.colors.bg, color: theme.colors.text } },
            // ── Header ──
            div({ style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" } },
                h2({ text: "🖼️ Image Viewer", style: { margin: "0", fontSize: "16px" } }),
                span({ id: "file-path", text: "No image selected", style: { fontSize: "12px", color: theme.colors.textMuted, fontFamily: "monospace" } }),
            ),
            // ── Split: explorer kiri | preview kanan ──
            div(
                { id: "split-panel", style: { display: "flex", gap: "0", flex: "1", overflow: "hidden" } },
                // Left: explorer
                div(
                    { id: "explorer-panel", style: { width: "230px", minWidth: "160px", overflowY: "auto", flexShrink: "0", borderRight: `1px solid ${theme.colors.border}`, padding: "4px 6px" } },
                    h3({ text: "📂 Files", style: { margin: "0 0 6px 0", fontSize: "12px" } }),
                    div({ id: "explorer-container" }),
                ),
                // Splitter
                div({
                    "data-splitter": "h",
                    style: { width: "5px", cursor: "col-resize", background: "rgba(128,128,128,0.2)", flexShrink: "0" },
                }),
                // Right: preview
                div(
                    { id: "preview-panel", style: { flex: "1", display: "flex", flexDirection: "column", overflow: "hidden", padding: "8px" } },
                    div(
                        { id: "preview-stage", style: { flex: "1", minHeight: "0", display: "flex", alignItems: "center", justifyContent: "center", background: theme.colors.bgAlt, borderRadius: "8px", overflow: "hidden" } },
                        preview.build(),
                    ),
                    div(
                        { id: "info-bar", style: { marginTop: "6px", padding: "4px 8px", borderTop: `1px solid ${theme.colors.border}`, fontSize: "11px", color: theme.colors.textMuted, fontFamily: "monospace" } },
                        span({ id: "status-bar", text: "Klik file gambar di kiri untuk preview." }),
                    ),
                ),
            ),
        ),
    );

    // ================================================================
    // EXPLORER — tree rekursif (contek Eucalyptus)
    // ================================================================
    async function refreshExplorer() {
        const rows: any[] = [];
        const clickHandlers: { id: string; handler: () => void }[] = [];
        let lastClick = { id: "", time: 0 };

        async function walk(dir: string, depth: number) {
            try {
                const l = (await fs.ls(dir)) || [];
                l.sort((a: any, b: any) => {
                    if (a.type !== b.type) return a.type === "DIRECTORY" ? -1 : 1;
                    return (a.name || "").localeCompare(b.name || "");
                });
                for (const e of l) {
                    const fp = dir.replace(/\/$/, "") + "/" + e.name;
                    const eid = "exp-" + fp.replace(/\//g, "_");
                    const isDir = e.type === "DIRECTORY";
                    const expanded = expandedDirs.has(fp);
                    const indent = depth * 14 + 6;

                    rows.push(
                        div(
                            {
                                id: eid,
                                onClickId: eid,
                                style: {
                                    display: "flex",
                                    alignItems: "center",
                                    padding: "2px 4px 2px " + indent + "px",
                                    cursor: "pointer",
                                    fontSize: "12px",
                                    color: isDir ? theme.colors.accent : isImage(e.name) ? theme.colors.text : theme.colors.textDim,
                                    fontFamily: "monospace",
                                    borderRadius: "3px",
                                    marginBottom: "1px",
                                    whiteSpace: "nowrap" as any,
                                    overflow: "hidden" as any,
                                    textOverflow: "ellipsis" as any,
                                },
                            },
                            text(
                                (isDir ? (expanded ? "📂 " : "📁 ") : isImage(e.name) ? "🖼️ " : "📄 ") + e.name,
                            ),
                        ),
                    );

                    clickHandlers.push({
                        id: eid,
                        handler: () => {
                            const now = Date.now();
                            const isDbl = lastClick.id === eid && now - lastClick.time < 400;
                            lastClick = { id: eid, time: now };
                            if (isDir) {
                                // Single click dir → toggle expand
                                if (expandedDirs.has(fp)) expandedDirs.delete(fp);
                                else expandedDirs.add(fp);
                                void refreshExplorer();
                            } else {
                                // Klik file → open
                                void openFile(fp);
                            }
                        },
                    });

                    if (isDir && expanded && depth < 8) {
                        await walk(fp, depth + 1);
                    }
                }
            } catch (_) {
                /* skip */
            }
        }

        await walk(startDir, 0);
        await app.setContent("explorer-container", div({ id: "explorer-list" }, ...rows));

        const w = (app as any).win;
        for (const ch of clickHandlers) {
            w.onClick(ch.id, ch.handler);
        }
        await w.flush();
    }

    // ================================================================
    // OPEN FILE — preview gambar
    // ================================================================
    async function openFile(fp: string) {
        currentFile = fp;
        const name = fp.split("/").pop() || fp;

        if (!isImage(name)) {
            // Bukan gambar — tampilkan info ukuran/tipe
            await app.update("status-bar", { text: `📄 ${name} — bukan file gambar` });
            await app.update("file-path", { text: name + " (non-image)" });
            preview.src = "";
            return;
        }

        try {
            // TImage menangani baca file → base64 → update <img> (MIME dari ekstensi)
            await preview.loadFromFile(fs, fp);
            await app.update("status-bar", { text: `✅ ${name} — dimuat via TImage (data URI)` });
            await app.update("file-path", { text: name });
        } catch (e: any) {
            await app.update("status-bar", { text: `❌ ${name}: ${e?.message || e}` });
        }
    }

    // ================================================================
    // INIT
    // ================================================================
    // Bind TImage ke screen (biar setBase64/loadFromFile bisa update live)
    preview.bindEventHandler(app);
    await refreshExplorer();

    await app.loopUntilClose();
});
