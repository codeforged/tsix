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
 *   image-viewer <dir>        → mulai dari direktori tertentu
 *   image-viewer <file>       → langsung buka file gambar tsb (parent dir jadi startDir)
 *
 * Jalankan: image-viewer
 * (Pastikan DOME running)
 *
 * (c) 2026 TSIX Project
 */

import { Program, std, fs } from "@tsix/Application";
import { Screen, div, text, span, h2, h3, Keyboard } from "@tsix/emerald";
import { theme } from "@tsix/theme";
import { TImage } from "@tsix/cashew";

export const appMode = "gui";

const IMAGE_EXTS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".webp",
  ".svg",
  ".ico",
];

export const main = Program(async (args: string[]) => {
  await std.log("=== Image Viewer (TImage Demo) ===");
  await theme.loadCurrent();
  theme.watch();

  const app = new Screen({
    title: "Image Viewer",
    icon: "🖼️",
    width: 920,
    height: 620,
    resizable: true,
    maximizable: true,
  });

  let startDir = "/";
  let initialFile: string | null = null;
  if (args.length > 0 && args[0]) {
    try {
      const st = await fs.stat(args[0]);
      if (st && st.type === "DIRECTORY") {
        // Parameter berupa direktori — pakai sebagai startDir
        startDir = args[0];
      } else {
        // Parameter berupa file — langsung buka, parent dir jadi startDir
        const idx = args[0].lastIndexOf("/");
        startDir = idx > 0 ? args[0].substring(0, idx) : "/";
        initialFile = args[0];
      }
    } catch (_) {
      // Stat gagal — anggap sebagai direktori
      startDir = args[0];
    }
  }
  const expandedDirs: Set<string> = new Set([startDir]);
  let currentFile: string | null = null;

  // ── Navigasi keyboard — mengikuti tree terlihat (flattened), termasuk
  //    file di subdirektori yang di-expand. Bukan cuma level-1 startDir.
  let selected: string | null = null; // fp entry yang sedang ter-select
  let navList: { name: string; fp: string; type: string }[] = [];
  let lastSelFp: string | null = null; // fp entry yang di-highlight sebelumnya
  const SEL_BG = "rgba(98, 145, 220, 0.35)";

  const isImage = (name: string) =>
    IMAGE_EXTS.some((e) => name.toLowerCase().endsWith(e));

  const expId = (fp: string) => "exp-" + fp.replace(/\//g, "_");

  // TImage — komponen preview. Auto-load dari file saat di-bind.
  const preview = new TImage("img-preview", {
    alt: "",
    fit: "contain",
    width: "100%",
    style: { flex: "1", minHeight: "0", objectFit: "contain" as any },
  });

  // ================================================================
  // BUILD UI
  // ================================================================
  await app.mount(
    div(
      {
        id: "root",
        style: {
          padding: "8px",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: theme.colors.bg,
          color: theme.colors.text,
        },
      },
      // ── Split: explorer kiri | preview kanan ──
      div(
        {
          id: "split-panel",
          style: { display: "flex", gap: "0", flex: "1", overflow: "hidden" },
        },
        // Left: explorer
        div(
          {
            id: "explorer-panel",
            style: {
              width: "230px",
              minWidth: "160px",
              overflowY: "auto",
              flexShrink: "0",
              borderRight: `1px solid ${theme.colors.border}`,
              padding: "4px 6px",
            },
          },
          h3({
            text: "📂 " + startDir,
            style: { margin: "0 0 6px 0", fontSize: "12px" },
          }),
          div({ id: "explorer-container" }),
        ),
        // Splitter
        div({
          "data-splitter": "h",
          style: {
            width: "5px",
            cursor: "col-resize",
            background: "rgba(128,128,128,0.2)",
            flexShrink: "0",
          },
        }),
        // Right: preview
        div(
          {
            id: "preview-panel",
            style: {
              flex: "1",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              padding: "8px",
            },
          },
          div(
            {
              id: "preview-stage",
              style: {
                flex: "1",
                minHeight: "0",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: theme.colors.bgAlt,
                borderRadius: "8px",
                overflow: "hidden",
              },
            },
            preview.build(),
          ),
          div(
            {
              id: "info-bar",
              style: {
                marginTop: "6px",
                padding: "4px 8px",
                borderTop: `1px solid ${theme.colors.border}`,
                fontSize: "11px",
                color: theme.colors.textMuted,
                fontFamily: "monospace",
              },
            },
            span({
              id: "status-bar",
              text: "Klik file gambar di kiri untuk preview.",
            }),
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
          const isSel = selected !== null && fp === selected;

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
                  color: isSel
                    ? theme.colors.text
                    : isDir
                      ? theme.colors.accent
                      : isImage(e.name)
                        ? theme.colors.text
                        : theme.colors.textDim,
                  background: isSel ? SEL_BG : "transparent",
                  fontFamily: "monospace",
                  borderRadius: "3px",
                  marginBottom: "1px",
                  whiteSpace: "nowrap" as any,
                  overflow: "hidden" as any,
                  textOverflow: "ellipsis" as any,
                },
              },
              text(
                (isDir
                  ? expanded
                    ? "📂 "
                    : "📁 "
                  : isImage(e.name)
                    ? "🖼️ "
                    : "📄 ") + e.name,
              ),
            ),
          );

          clickHandlers.push({
            id: eid,
            handler: () => {
              const now = Date.now();
              const isDbl = lastClick.id === eid && now - lastClick.time < 400;
              lastClick = { id: eid, time: now };
              // Klik entry → sinkronkan selected (navigasi keyboard)
              selected = fp;
              void refreshSelectionHighlight(fp);
              if (isDir) {
                // Single click dir → toggle expand, lalu jaga highlight tetap
                if (expandedDirs.has(fp)) expandedDirs.delete(fp);
                else expandedDirs.add(fp);
                void (async () => {
                  await refreshExplorer();
                  await buildNavList();
                  await refreshSelectionHighlight(selected || fp);
                })();
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
    await app.setContent(
      "explorer-container",
      div({ id: "explorer-list" }, ...rows),
    );

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
      await app.update("status-bar", {
        text: `📄 ${name} — bukan file gambar`,
      });
      preview.src = "";
      return;
    }

    try {
      // TImage menangani baca file → base64 → update <img> (MIME dari ekstensi)
      await preview.loadFromFile(fs, fp);
      await app.update("status-bar", {
        text: `✅ ${name} — dimuat via TImage (data URI)`,
      });
    } catch (e: any) {
      await app.update("status-bar", {
        text: `❌ ${name}: ${e?.message || e}`,
      });
    }
  }

  // ================================================================
  // NAVIGASI KEYBOARD — mengikuti tree terlihat (flattened)
  // (baca keyboard ala DDC: fokus elemen di browser → keydown → app)
  // ================================================================
  async function buildNavList() {
    navList = [];
    async function walk(dir: string, depth: number) {
      if (depth > 8) return;
      try {
        const l = (await fs.ls(dir)) || [];
        l.sort((a: any, b: any) => {
          if (a.type !== b.type) return a.type === "DIRECTORY" ? -1 : 1;
          return (a.name || "").localeCompare(b.name || "");
        });
        for (const e of l) {
          const fp = dir.replace(/\/$/, "") + "/" + e.name;
          navList.push({ name: e.name, fp, type: e.type });
          if (e.type === "DIRECTORY" && expandedDirs.has(fp)) {
            await walk(fp, depth + 1);
          }
        }
      } catch (_) {
        /* skip */
      }
    }
    await walk(startDir, 0);
  }

  /** Pindahkan highlight baris explorer ke entry baru (tanpa rebuild penuh). */
  async function refreshSelectionHighlight(nextFp: string) {
    if (lastSelFp && lastSelFp !== nextFp) {
      await app.update(expId(lastSelFp), {
        style: { background: "transparent" },
      });
    }
    lastSelFp = nextFp;
    await app.update(expId(nextFp), {
      style: { background: SEL_BG, color: theme.colors.text },
    });
    await app.win.flush();
  }

  /** Set selected ke entry (fp) + update highlight + preview (jika gambar). */
  async function selectEntry(fp: string) {
    selected = fp;
    const e = navList.find((x) => x.fp === fp);
    await refreshSelectionHighlight(fp);
    if (!e) return;
    if (e.type === "DIRECTORY") {
      await app.update("status-bar", {
        text: `📂 ${e.name}/ — direktori (Enter untuk expand)`,
      });
      return;
    }
    await openFile(fp);
  }

  /** Geser selected maju/mundur (ArrowDown/ArrowUp), wrap di ujung. */
  async function navSelection(delta: number) {
    if (navList.length === 0) return;
    const idx = selected ? navList.findIndex((x) => x.fp === selected) : -1;
    let ni = idx === -1 ? 0 : idx + delta;
    if (ni < 0) ni = navList.length - 1;
    if (ni >= navList.length) ni = 0;
    await selectEntry(navList[ni].fp);
  }

  /** Aktifkan entry ter-select: Enter → expand/tutup direktori / buka file. */
  async function activateSelected() {
    if (!selected) return;
    const e = navList.find((x) => x.fp === selected);
    if (!e) return;
    if (e.type === "DIRECTORY") {
      if (expandedDirs.has(selected)) expandedDirs.delete(selected);
      else expandedDirs.add(selected);
      await buildNavList();
      await refreshExplorer();
      await refreshSelectionHighlight(selected);
    } else {
      await openFile(selected);
    }
  }

  // ================================================================
  // INIT
  // ================================================================
  // Bind TImage ke screen (biar setBase64/loadFromFile bisa update live)
  preview.bindEventHandler(app);
  await buildNavList();
  await refreshExplorer();

  // Selected awal: file param (jika ada), selain itu entry pertama.
  if (initialFile) {
    await selectEntry(initialFile);
  } else if (navList.length > 0) {
    await selectEntry(navList[0].fp);
  }

  // Navigasi keyboard — komponen Keyboard (fokus otomatis saat window aktif)
  const kb = new Keyboard(app.win);
  kb.on((e) => {
    if (!e.down || e.repeat) return; // sekali per tekan, abaikan auto-repeat
    if (e.key === "ArrowDown") void navSelection(1);
    else if (e.key === "ArrowUp") void navSelection(-1);
    else if (e.key === "Enter") void activateSelected();
  });
  await kb.attach();

  await app.loopUntilClose();
  await kb.detach();
});
