import { Program, std, fs, shell } from "@tsix/Application";
import {
  Screen,
  div,
  button,
  span,
  h2,
  h3,
  input,
  text,
  paragraph,
  ConnectedTabulator,
} from "@tsix/emerald";
import { theme } from "@tsix/theme";

const MB = 1048576;
export const appMode = "gui";
export const main = Program(async (args: string[]) => {
  await std.log("=== File Cruiser v4 ===");
  await theme.loadCurrent();
  theme.watch();
  const ps = await shell.ps();
  const domePid = (ps.find((p: any) => p.name.includes("dome")) || {}).pid || 0;
  const app = new Screen({ title: "File Cruiser", icon: "📁", width: 860, height: 540 });
  //let currentPath = args[0] || "/";
  let homeDir = "/";
  try {
    const e = await shell.getenv("HOME");
    if (e) homeDir = e;
  } catch (_) { }
  let currentPath = args[0] || homeDir;

  let entries = [];
  let clipboard = null;
  let selected = null;
  let lastClick = { id: "", time: 0 };
  // Riwayat navigasi Back / Forward
  let historyBack: string[] = [];
  let historyForward: string[] = [];

  // ── DataGrid (Tabulator) — daftar file, dirender di browser ──
  // Sort kolom dimatikan (urutan tetap: direktori dulu, lalu nama — sama
  // seperti sebelumnya). Resize kolom aktif (drag tepi header).
  const grid = new ConnectedTabulator({
    id: "filelist",
    columns: [
      { key: "name", label: "Name", sortable: true },
      { key: "size", label: "Size", width: 100, align: "right", sortable: true },
      { key: "modified", label: "Modified", width: 130, align: "right", sortable: true },
    ],
    height: "100%",
  });

  const icon = (e) => (e.type === "DIRECTORY" ? "📁" : "📄");
  const isExe = (m) => !!(m & 1);
  const mStr = (m) =>
    (m & 4 ? "r" : "-") + (m & 2 ? "w" : "-") + (m & 1 ? "x" : "-");

  /** Format timestamp jadi "today HH:mm", "yesterday HH:mm", atau "DD MMM" */
  function fmtDate(ts) {
    if (!ts) return "-";
    const d = new Date(ts);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 86400000);
    const d2 = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const pad = (n) => String(n).padStart(2, "0");
    const time = pad(d.getHours()) + ":" + pad(d.getMinutes());
    if (d2.getTime() === today.getTime()) return "Today " + time;
    if (d2.getTime() === yesterday.getTime()) return "Yesterday " + time;
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return pad(d.getDate()) + " " + months[d.getMonth()];
  }

  function sz(e) {
    if (e.type === "DIRECTORY") return "<DIR>";
    const s = e.size || 0;
    return s < 1024
      ? s + " B"
      : s < MB
        ? (s / 1024).toFixed(1) + " KB"
        : (s / MB).toFixed(1) + " MB";
  }
  function sz2(bytes: number): string {
    if (bytes < 1024) return bytes + " B";
    if (bytes < MB) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / MB).toFixed(1) + " MB";
  }

  function selPath() {
    return selected ? currentPath.replace(/\/$/, "") + "/" + selected : null;
  }
  function isSelDir() {
    if (!selected) return false;
    const e = entries.find((x) => x.name === selected);
    return e ? e.type === "DIRECTORY" : false;
  }
  function selExe() {
    if (!selected) return false;
    const e = entries.find((x) => x.name === selected);
    return e ? e.type !== "DIRECTORY" && isExe(e.mode || 0) : false;
  }

  // ---- TAB AUTOCOMPLETE for path input ----
  function getCommonPrefix(strings) {
    if (!strings.length) return "";
    let p = strings[0];
    for (let i = 1; i < strings.length; i++) {
      while (strings[i].indexOf(p) !== 0) {
        p = p.substring(0, p.length - 1);
        if (!p) return "";
      }
    }
    return p;
  }

  async function tabCompletePath(typedPath) {
    const lastSlash = typedPath.lastIndexOf("/");
    const dirPart =
      lastSlash >= 0 ? typedPath.substring(0, lastSlash + 1) : "/";
    const filePart =
      lastSlash >= 0 ? typedPath.substring(lastSlash + 1) : typedPath;
    if (!filePart) return typedPath; // nothing to complete
    try {
      const list = (await fs.ls(dirPart)) || [];
      const matches = list
        .filter((e) => e.name.startsWith(filePart))
        .map((e) => e.name + (e.type === "DIRECTORY" ? "/" : ""));
      if (matches.length === 0) return typedPath;
      if (matches.length === 1) return dirPart + matches[0];
      const cp = getCommonPrefix(matches);
      if (cp.length > filePart.length) return dirPart + cp;
    } catch (e) {
      /* ignore */
    }
    return typedPath;
  }

  async function viewSel() {
    const p = selPath();
    if (!p) return;
    const name = p.split("/").pop() || "";
    try {
      const raw = await fs.readFile(p);
      const c = raw ? String(raw) : "(empty)";
      const viewerId = "__viewer_overlay__";
      const closeId = "__viewer_close__";

      await app.mount(
        div({
          id: viewerId,
          style: {
            position: "fixed", inset: "0", zIndex: "9999999",
            background: "rgba(0,0,0,0.8)",
            display: "flex", alignItems: "center", justifyContent: "center",
          },
        },
          div({
            style: {
              width: "70%", height: "70%",
              background: theme.colors.surface,
              border: `1px solid ${theme.colors.accent}`, borderRadius: "12px",
              display: "flex", flexDirection: "column",
              overflow: "hidden", boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
            },
          },
            div({
              style: {
                display: "flex", justifyContent: "space-between",
                alignItems: "center", marginBottom: "8px",
              },
            },
              span({
                text: "📄 " + name + " (" + c.length + " chars)",
                style: { color: theme.colors.accent, fontSize: "14px", fontWeight: "600" },
              }),
              button({
                id: closeId, text: "✕ Close",
                style: {
                  background: theme.colors.danger, color: "white",
                  border: "none", borderRadius: "4px",
                  padding: "4px 12px", cursor: "pointer", fontSize: "12px",
                },
              }),
            ),
            {
              id: "__viewer_text__",
              tag: "textarea",
              props: {
                value: c,
                style: {
                  width: "100%", flex: "1",
                  background: theme.colors.bgAlt, color: theme.colors.text,
                  border: `1px solid ${theme.colors.border}`, borderRadius: "6px",
                  padding: "12px", fontSize: "13px",
                  fontFamily: "'Courier New', monospace",
                  outline: "none", resize: "none",
                  tabSize: "2",
                },
                readonly: "",
              },
              children: [],
            },
          ),
        ));
      app.win.onClick(closeId, async () => {
        try { await app.win.unmount(viewerId); } catch (_) { }
      });
      await app.win.flush();
    } catch (e) {
      await app.alert("Error", e.message);
    }
  }
  async function infoSel() {
    const p = selPath();
    if (!p) return;
    try {
      const s = await fs.stat(p);
      if (!s) return;
      const sizeStr = s.type === "DIRECTORY" ? await (async () => {
        try {
          const items = await fs.ls(p);
          if (items && Array.isArray(items)) {
            const dirs = items.filter(i => i.type === "DIRECTORY").length;
            const files = items.filter(i => i.type === "FILE").length;
            return dirs + "d/" + files + "f";
          }
        } catch (_) {}
        return "-";
      })() : sz(s);
      const ts = s.modified_at || s.created_at;
      let dateStr = "-";
      if (ts) {
        const d = new Date(ts);
        const pad = (n) => String(n).padStart(2, "0");
        dateStr = pad(d.getDate()) + " " + ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()] + " " + d.getFullYear() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
      }
      const fname = p.split("/").pop() || "";
      const overlayId = "__info_overlay__";

      const row = (label, value) => div(
        { style: { display: "flex", padding: "3px 0", gap: "8px" } },
        span({ text: label, style: { width: "90px", color: theme.colors.textMuted, fontSize: "13px", fontWeight: "600" } }),
        span({ text: value || "-", style: { flex: "1", color: theme.colors.text, fontSize: "13px", fontFamily: "monospace" } }),
      );

      await app.mount(
        div({
          id: overlayId,
          style: {
            position: "fixed", inset: "0", zIndex: "9999999",
            background: "rgba(0,0,0,0.7)",
            display: "flex", alignItems: "center", justifyContent: "center",
          },
        },
          div({
            style: {
              background: theme.colors.surface,
              border: `1px solid ${theme.colors.accent}`, borderRadius: "12px",
              padding: "24px 28px", minWidth: "360px",
              boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
            },
          },
            span({
              text: "📄 " + fname,
              style: { color: theme.colors.accent, fontSize: "16px", fontWeight: "600", display: "block", marginBottom: "14px" },
            }),
            row("Path", p),
            row("Size", sizeStr),
            row("Modified", dateStr),
            row("Owner", (s.owner || "-") + " (UID " + (s.uid ?? "?") + ")"),
            row("Group", "GID " + (s.gid ?? "?")),
            row("Mode", mStr(s.mode || 0) + " (" + ((s.mode || 0).toString(8)) + ")"),
            row("Type", s.type || "-"),
            div({ style: { textAlign: "center", marginTop: "16px" } },
              button({
                id: "__info_close__", text: "OK",
                style: {
                  background: theme.colors.accent, color: "white",
                  border: "none", padding: "8px 36px", borderRadius: "8px",
                  cursor: "pointer", fontSize: "14px",
                },
              }),
            ),
          ),
        ),
      );
      await app.win.flush();
      app.win.onClick("__info_close__", async () => {
        try { await app.win.unmount(overlayId); } catch (_) {}
      });
    } catch (e) {
      await app.alert("Error", e.message);
    }
  }
  async function editSel() {
    const p = selPath();
    if (!p) return;
    const name = p.split("/").pop() || "";
    try {
      await shell.exec("/opt/eucalyptus/eucalyptus.js", [p]);
      await app.update("status-bar", { text: "✏️ Editing: " + name });
    } catch (e) {
      await app.update("status-bar", { text: "❌ " + e.message });
    }
  }
  async function execSel() {
    const p = selPath();
    if (!p) return;
    const name = p.split("/").pop() || "";
    const isDir = isSelDir();
    if (isDir) return;
    const ans = await app.confirm("▶️ Execute", "Run '" + name + "'?", ["Yes", "No"]);
    if (ans !== "Yes") return;
    try {
      const raw = await fs.readFile(p);
      const content = String(raw || "");
      const isGUI = /appMode\s*=\s*["']gui["']/.test(content);

      if (isGUI) {
        await shell.exec(p, []);
      } else {
        await shell.exec("/opt/pixelterm/pixelterm.js", [p, "-hue"]);
      }
    } catch (e) {
      await app.alert("Error", e.message);
    }
  }
  async function copySel() {
    const p = selPath();
    if (p) {
      clipboard = { path: p, action: "copy" };
      await app.update("status-bar", {
        text: "📋 Copied: " + (p.split("/").pop() || ""),
      });
      await refreshSelection();
    }
  }
  async function cutSel() {
    const p = selPath();
    if (p) {
      clipboard = { path: p, action: "move" };
      await app.update("status-bar", {
        text: "✂️ Cut: " + (p.split("/").pop() || ""),
      });
      await refreshSelection();
    }
  }

  async function pasteSel() {
    if (!clipboard) return;
    const src = clipboard.path;
    const name = src.split("/").pop() || "untitled";
    const dst = currentPath.replace(/\/$/, "") + "/" + name;
    const overlayId = "__copy_progress_overlay__";
    const barFillId = "__copy_progress_fill__";
    const barTextId = "__copy_progress_text__";
    const barPctId = "__copy_progress_pct__";
    const barStyle = { height: "100%", borderRadius: "8px", transition: "width 0.2s ease-out" };

    // --- Progress overlay ---
    await app.mount(
      div({
        id: overlayId,
        style: {
          position: "fixed", inset: "0", zIndex: "9999999",
          background: "rgba(0,0,0,0.7)",
          display: "flex", alignItems: "center", justifyContent: "center",
        },
      },
        div({
          style: {
            width: "440px", background: theme.colors.surface,
            border: `1px solid ${theme.colors.accent}`, borderRadius: "12px",
            padding: "24px", textAlign: "center",
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          },
        },
          span({
            id: barTextId, text: "📋 Copying: " + name,
            style: { color: theme.colors.textDim, fontSize: "14px", display: "block", marginBottom: "14px" }
          }),
          div({ style: { background: theme.colors.bgAlt, borderRadius: "8px", height: "18px", overflow: "hidden", marginBottom: "8px" } },
            div({ id: barFillId, style: { width: "0%", ...barStyle, background: "linear-gradient(90deg, #4caf50, #8bc34a)" } }),
          ),
          span({
            id: barPctId, text: "0%",
            style: { color: theme.colors.accent, fontSize: "14px", fontWeight: "700", fontFamily: "monospace" }
          }),
        ),
      ));
    await app.win.flush();

    const setBar = async (pct: number) => {
      await app.update(barFillId, { style: { width: pct + "%", ...barStyle, background: pct >= 100 ? theme.colors.accent : `linear-gradient(90deg, ${theme.colors.accent}, #8bc34a)` } });
      await app.update(barPctId, { text: pct + "%" });
      await app.win.flush();
    };

    try {
      // --- Tentukan totalSize untuk info progress ---
      let totalSize = 0;
      try { totalSize = await (fs as any).getSize(src); } catch (_) {
        try { const st = await fs.stat(src); totalSize = (st && st.size) ? st.size : 0; } catch (_) { }
      }

      // --- LEGACY PATH (read-all + write-all) — selalu reliable ---
      // Chunked I/O di-cross-VFS (BKFS→HostVFS) masih eksperimental.
      // Legacy method sudah terbukti jalan untuk semua ukuran file.
      const isLarge = totalSize > 1048576; // >1MB
      let anim = 0;
      const simSteps = isLarge
        ? [5, 12, 22, 34, 45, 55, 64, 72, 79, 85, 90, 94, 97]
        : [15, 40, 70, 90, 100];
      const interval = isLarge ? 250 : 120;

      const timer = setInterval(() => {
        if (anim < simSteps.length) { setBar(simSteps[anim]); anim++; }
      }, interval);

      const fd = await fs.open(src);
      const c = await fs.read(fd);
      await fs.close(fd);
      await fs.writeFile(dst, String(c || ""));

      clearInterval(timer);
      await setBar(100);

      if (clipboard.action === "move") {
        await new Promise(r => setTimeout(r, 120));
        try { await fs.unlink(src); } catch (_) { }
      }

      await new Promise(r => setTimeout(r, 450));
      try { await app.win.unmount(overlayId); } catch (_) { }

      await app.update("status-bar", { text: "✅ Done: " + name });
      clipboard = null; selected = null;
      await refreshList();
    } catch (e: any) {
      try { await app.win.unmount(overlayId); } catch (_) { }
      await app.update("status-bar", { text: "❌ " + e.message });
      await refreshSelection();
    }
  }
  async function renameSel() {
    const p = selPath();
    if (!p) return;
    const oldName = p.split("/").pop() || "";
    console.log("Start rename: " + oldName);
    const newName = await app.question("Rename", "Rename '" + oldName + "' to:", oldName);
    console.log(oldName + " -> " + newName);
    if (!newName || newName === oldName) return;
    try {
      const dir = p.substring(0, p.lastIndexOf("/")) || "/";
      const fd = await fs.open(p);
      const c = await fs.read(fd);
      await fs.close(fd);
      const dst = dir.replace(/\/$/, "") + "/" + newName;
      await fs.writeFile(dst, String(c));
      await fs.unlink(p);
      selected = null;
      clipboard = null;
      await app.update("status-bar", { text: "✅ Renamed: " + newName });
      await refreshList();
    } catch (e) {
      await app.update("status-bar", { text: "❌ " + e.message });
    }
  }
  async function deleteSel() {
    const p = selPath();
    if (!p) return;
    const n = p.split("/").pop() || "";
    const ans = await app.confirm("Delete?", "Delete '" + n + "'?", [
      "Yes",
      "No",
    ]);
    if (ans !== "Yes") return;
    try {
      const s = await fs.stat(p);
      if (s && s.type === "DIRECTORY") await fs.rmdir(p);
      else await fs.unlink(p);
      selected = null;
      await app.update("status-bar", { text: "🗑️ Deleted: " + n });
      await refreshList();
    } catch (e) {
      await app.update("status-bar", { text: "❌ " + e.message });
    }
  }

  // ── Navigasi + riwayat (Back / Forward) ──
  async function navigateTo(path: string) {
    const p = path === "/" ? "/" : path.replace(/\/+$/, "");
    if (p === currentPath) return; // path sama — skip (hindari riwayat dobel)
    if (historyBack[historyBack.length - 1] !== currentPath) {
      historyBack.push(currentPath);
    }
    historyForward = [];
    currentPath = p;
    await refreshList();
  }
  async function goBack() {
    if (historyBack.length === 0) return;
    historyForward.push(currentPath);
    currentPath = historyBack.pop()!;
    await refreshList();
  }
  async function goForward() {
    if (historyForward.length === 0) return;
    historyBack.push(currentPath);
    currentPath = historyForward.pop()!;
    await refreshList();
  }
  async function enterDir(name) {
    if (name === "..") {
      await goUp();
      return;
    }
    await navigateTo(currentPath.replace(/\/$/, "") + "/" + name);
  }
  async function goUp() {
    const p = currentPath.replace(/\/$/, "").split("/");
    p.pop();
    await navigateTo(p.join("/") || "/");
  }
  async function goHome() {
    await navigateTo(homeDir);
  }

  async function navigateToPath() {
    let path = currentPath;
    // Expand ~ ke home directory
    if (path.startsWith("~")) {
      path = homeDir + path.slice(1);
    }
    // Normalize: hapus trailing slash (kecuali root)
    if (path !== "/") path = path.replace(/\/$/, "");
    try {
      const s = await fs.stat(path);
      if (s && s.type === "DIRECTORY") {
        await navigateTo(path);
        await app.update("status-bar", { text: "📂 " + path });
      } else {
        await app.update("status-bar", { text: "⚠️ Not a directory: " + path });
      }
    } catch (e) {
      await app.update("status-bar", { text: "⚠️ Path not found: " + path });
      await app.update("error-msg", { text: "⚠️ " + (e.message || "Path not found") });
    }
  }

  async function refreshSelection() {
    const sel = selected;
    const hasSel = !!sel;
    const hasExe = selExe();
    const hasClip = !!clipboard;
    await app.update("tb-view", { disabled: hasSel ? "" : "1" });
    await app.update("tb-edit", { disabled: hasSel ? "" : "1" });
    await app.update("tb-info", { disabled: hasSel ? "" : "1" });
    await app.update("tb-copy", { disabled: hasSel ? "" : "1" });
    await app.update("tb-cut", { disabled: hasSel ? "" : "1" });
    await app.update("tb-rename", { disabled: hasSel ? "" : "1" });
    await app.update("tb-delete", { disabled: hasSel ? "" : "1" });
    await app.update("tb-exec", { disabled: hasExe ? "" : "1" });
    await app.update("tb-paste", { disabled: hasClip ? "" : "1" });
    await app.update("tb-back", { disabled: historyBack.length ? "" : "1" });
    await app.update("tb-forward", { disabled: historyForward.length ? "" : "1" });
    // Highlight baris terpilih ditangani Tabulator (native) — tidak perlu
    // update background manual per-baris lagi.
    const dc = entries.filter((e) => e.type === "DIRECTORY").length;
    const fc = entries.filter((e) => e.type === "FILE").length;
    let st = dc + " dirs · " + fc + " files";
    if (sel) {
      const e = entries.find((x) => x.name === sel);
      st += " | Selected: " + (e ? icon(e) + " " + sel : sel);
    }
    if (clipboard) st += " | 📋 " + (clipboard.path.split("/").pop() || "");
    await app.update("status-bar", { text: st });
    // Flush agar perubahan toolbar langsung dikirim ke browser
    await app.win.flush();
  }

  async function refreshList() {
    // await app.update("path-display", { text: "📂 " + (currentPath || "/") });
    await app.update("path-input", { value: currentPath });
    try {
      entries = (await fs.ls(currentPath)) || [];
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === "DIRECTORY" ? -1 : 1;
        return (a.name || "").localeCompare(b.name || "");
      });
    } catch (e) {
      await app.update("error-msg", { text: "⚠️ " + e.message });
      return;
    }
    await app.update("error-msg", { text: "" });

    // Bangun baris untuk Tabulator grid. Field tersembunyi `_name`, `_isDir`,
    // `_mode` dipakai logika app (path/exec) — tidak dirender Tabulator.
    const rows: Record<string, any>[] = [];
    // Virtual ".." — selalu di baris pertama
    if (currentPath !== "/") {
      rows.push({ name: "📂 ..", _name: "..", size: "", _isDir: true, modified: "" });
    }
    for (const e of entries) {
      let sizeText = "";
      if (e.type === "DIRECTORY") {
        try {
          const sub = await fs.ls(currentPath.replace(/\/$/, "") + "/" + e.name);
          if (sub && Array.isArray(sub)) {
            const dirs = sub.filter((i) => i.type === "DIRECTORY").length;
            const files = sub.filter((i) => i.type === "FILE").length;
            sizeText = dirs + "d/" + files + "f";
          }
        } catch (_) {
          sizeText = "<DIR>";
        }
      } else {
        sizeText = sz(e);
      }
      rows.push({
        name: icon(e) + " " + e.name,
        _name: e.name,
        size: sizeText,
        _isDir: e.type === "DIRECTORY",
        _mode: e.mode || 0,
        modified: fmtDate(e.modified_at),
      });
    }

    selected = null;
    await grid.setData(rows);
    await refreshSelection();
  }

  async function refreshTree() {
    const items = [];
    async function walk(dir, depth) {
      try {
        const l = (await fs.ls(dir)) || [];
        for (const d of l
          .filter((e) => e.type === "DIRECTORY")
          .sort((a, b) => (a.name || "").localeCompare(b.name || ""))) {
          const fp = dir.replace(/\/$/, "") + "/" + d.name;
          const tid = "tree-" + fp.replace(/\//g, "_");
          items.push(
            div(
              {
                id: tid,
                onClickId: tid,
                style: {
                  padding: "2px " + (depth * 12 + 4) + "px",
                  cursor: "pointer",
                  fontSize: "14px",
                  color: theme.colors.textDim,
                },
              },
              text("📁 " + d.name),
            ),
          );
        }
      } catch (e) { }
    }
    await walk("/", 0);
    await app.setContent("tree-container", div({ id: "tree-list" }, ...items));
    const w = app.win;
    async function rebind(dir) {
      try {
        const l = (await fs.ls(dir)) || [];
        for (const d of l.filter((e) => e.type === "DIRECTORY")) {
          const fp = dir.replace(/\/$/, "") + "/" + d.name;
          const tid = "tree-" + fp.replace(/\//g, "_");
          w.onClick(tid, () => {
            selected = null;
            void navigateTo(fp);
          });
        }
      } catch (e) { }
    }
    await rebind("/");
    await w.flush();
  }

  const tb = () => ({
    background: theme.colors.buttonBg,
    color: theme.colors.textDim,
    border: `1px solid ${theme.colors.border}`,
    padding: "3px 8px",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "13px",
    marginRight: "4px",
    lineHeight: "1",
  });

  await app.mount(
    div({
      id: "content-root",
      style: {
        padding: "4px",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: theme.colors.bg,
        color: theme.colors.text,
        fontFamily: "'Segoe UI', sans-serif",
        fontSize: theme.sizes.fontSize,
      },
    }),
  );
  await theme.applyToDome(domePid, app.wid);
  await app.mount(
    div(
      { id: "header", style: { marginBottom: "4px" } },
      div(
        {
          id: "nav-bar",
          style: { display: "flex", gap: "6px", alignItems: "center" },
        },
        input({
          id: "path-input",
          type: "text",
          value: currentPath,
          onInputId: "path-input",
          onKeydownId: "path-input",
          style: { flex: "1", padding: "4px 8px", fontSize: "12px", background: theme.colors.bg },
          placeholder: "Enter path...",
        }),
        button({ id: "btn-go", text: "Go", style: tb(), onClickId: "btn-go" }),
        button({
          id: "btn-refresh",
          text: "🔄",
          style: tb(),
          onClickId: "btn-refresh",
        }),
      ),
      // span({
      //   id: "path-display",
      //   text: "📂 /",
      //   style: {
      //     display: "block",
      //     marginTop: "4px",
      //     color: theme.colors.accent,
      //     fontFamily: "monospace",
      //     fontSize: "13px",
      //   },
      // }),
      span({
        id: "error-msg",
        text: "",
        style: {
          display: "block",
          color: theme.colors.danger,
          fontSize: "11px",
          marginTop: "2px",
        },
      }),
    ),
    "content-root",
  );
  await app.mount(
    div(
      {
        id: "toolbar",
        style: {
          display: "flex",
          gap: "4px",
          padding: "4px 0",
          borderBottom: `1px solid ${theme.colors.border}`,
          marginBottom: "4px",
        },
      },
      button({
        id: "tb-back",
        text: "⬅",
        title: "Back (history)",
        style: tb(),
        onClickId: "tb-back",
      }),
      button({
        id: "tb-forward",
        text: "➡",
        title: "Forward (history)",
        style: tb(),
        onClickId: "tb-forward",
      }),
      button({
        id: "tb-home",
        text: "🏠",
        title: "Home",
        style: tb(),
        onClickId: "tb-home",
      }),
      span({ style: { width: "8px" } }),
      button({
        id: "tb-view",
        text: "👁",
        title: "View",
        style: tb(),
        onClickId: "tb-view",
      }),
      button({
        id: "tb-edit",
        text: "✏️",
        title: "Edit",
        style: tb(),
        onClickId: "tb-edit",
      }),
      button({
        id: "tb-info",
        text: "ℹ",
        title: "Info",
        style: tb(),
        onClickId: "tb-info",
      }),
      button({
        id: "tb-exec",
        text: "▶️",
        title: "Run",
        style: tb(),
        onClickId: "tb-exec",
      }),
      span({ style: { width: "8px" } }),
      button({
        id: "tb-copy",
        text: "🗐",
        title: "Copy",
        style: tb(),
        onClickId: "tb-copy",
      }),
      button({ id: "tb-cut", text: "✂️", title: "Cut", style: tb(), onClickId: "tb-cut" }),
      button({
        id: "tb-paste",
        text: "📋",
        title: "Paste",
        style: tb(),
        onClickId: "tb-paste",
      }),
      span({ style: { width: "8px" } }),
      button({
        id: "tb-rename",
        text: "✏️",
        title: "Rename",
        style: tb(),
        onClickId: "tb-rename",
      }),
      button({
        id: "tb-delete",
        text: "🗑",
        title: "Delete",
        style: { ...tb(), color: theme.colors.danger, borderColor: theme.colors.dangerBorder },
        onClickId: "tb-delete",
      }),
    ),
    "content-root",
  );
  await app.mount(
    div(
      {
        id: "split-panel",
        style: { display: "flex", gap: "0", flex: "1", overflow: "hidden" },
      },
      div(
        {
          id: "tree-panel",
          style: {
            width: "190px",
            minWidth: "140px",
            overflowY: "auto",
            flexShrink: "0",
          },
        },
        h3({
          id: "tree-root",
          text: "📂 /",
          style: { margin: "0 0 6px 0", fontSize: "12px", cursor: "pointer" },
          onClickId: "tree-root",
        }),
        div({ id: "tree-container"}),
      ),
      // Draggable splitter
      div({
        id: "__tree_splitter__",
        "data-splitter": "h",
        style: {
          width: "5px",
          cursor: "col-resize",
          background: "rgba(77, 74, 64, 0.2)",
          flexShrink: "0",
        },
      }),
      div(
        {
          id: "file-panel",
          style: {
            flex: "1",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          },
        },
        // Header + body grid dirender Tabulator (sort/resize/select native)
        div(
          {
            id: "list-container",
            style: { flex: "1", minHeight: "0", display: "flex", flexDirection: "column" },
          },
          grid.build(),
        ),
      ),
    ),
    "content-root",
  );
  await app.mount(
    div(
      {
        id: "status-bar-container",
        style: {
          marginTop: "4px",
          padding: "4px 8px",
          borderTop: `1px solid ${theme.colors.border}`,
          fontFamily: "monospace",
          fontSize: theme.sizes.fontSizeSm,
          color: theme.colors.textMuted,
        },
      },
      span({ id: "status-bar", text: "Loading..." }),
    ),
    "content-root",
  );

  await app.on("btn-go", "click", navigateToPath);
  await app.on("btn-refresh", "click", () => {
    refreshList();
    refreshTree();
  });
  await app.on("tree-root", "click", () => {
    selected = null;
    void navigateTo("/");
  });
  app.win.bindHandler("path-input", "input", (ev) => {
    if (ev.value !== undefined) currentPath = String(ev.value);
  });
  app.win.bindHandler("path-input", "keydown", async (ev) => {
    if (ev.value === "Enter") {
      await navigateToPath();
    } else if (ev.value === "Tab") {
      const completed = await tabCompletePath(currentPath);
      currentPath = completed;
      await app.update("path-input", { value: currentPath });
    }
  });
  await app.on("tb-back", "click", goBack);
  await app.on("tb-forward", "click", goForward);
  await app.on("tb-home", "click", goHome);
  await app.on("tb-view", "click", viewSel);
  await app.on("tb-edit", "click", editSel);
  await app.on("tb-info", "click", infoSel);
  await app.on("tb-exec", "click", execSel);
  await app.on("tb-copy", "click", copySel);
  await app.on("tb-cut", "click", cutSel);
  await app.on("tb-paste", "click", pasteSel);
  await app.on("tb-rename", "click", renameSel);
  await app.on("tb-delete", "click", deleteSel);

  // ── Bind grid (Tabulator): single-click select, double-click aksi ──
  await grid.mount(
    app,
    undefined,
    (key, rec) => {
      const name = rec?._name;
      if (!name) return;
      const now = Date.now();
      if (lastClick.id === name && now - lastClick.time < 400) {
        lastClick = { id: "", time: 0 };
        selected = name;
        if (name === "..") { void goUp(); return; }
        if (rec._isDir) { void enterDir(name); return; }
        if (rec._mode !== undefined && isExe(rec._mode)) { void execSel(); return; }
        // File biasa — cukup ter-select
        void refreshSelection();
      } else {
        lastClick = { id: name, time: now };
        selected = name;
        void refreshSelection();
      }
    },
    undefined,
    (key, rec) => {
      // Seleksi berubah (termasuk deselect saat klik baris terpilih lagi)
      selected = rec ? rec._name : null;
      void refreshSelection();
    },
  );

  await refreshTree();
  await refreshList();
  await app.loopUntilClose();
});
