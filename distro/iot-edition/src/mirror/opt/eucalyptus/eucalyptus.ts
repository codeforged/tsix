import { Program, std, fs, shell } from "@tsix/Application";
import { Screen, div, button, text, span, h2, h3, input } from "@tsix/emerald";
import { theme } from "@tsix/theme";
// TS syntax checker — esbuild pasti tersedia di runtime (dipakai loader OS).
import { transformSync as esbuildTransform } from "esbuild";

/**
 * EUCALYPTUS 1.0 — TSIX Text Editor (CodeMirror-powered)
 *
 * - Left panel: unified tree (directories + files like Windows Explorer)
 * - Right panel: CodeMirror editor
 * - Double-click file → open in editor. Click dir → expand/collapse.
 * - Toolbar: New, Save, Save As, Close
 */
export const appMode = "gui";

export const main = Program(async (args: string[]) => {
  await std.log("=== Eucalyptus v1 ===");
  await theme.loadCurrent();
  theme.watch();
  const version = "V1.3";
  const ps = await shell.ps();
  const domePid = (ps.find((p: any) => p.name.includes("dome")) || {}).pid || 0;
  const app = new Screen({
    title: "Eucalyptus",
    icon: "✏️",
    width: 900,
    height: 600,
    resizable: true,
    maximizable: true,
  });
  const cmId = "cm-editor";
  let currentFile: string | null = null;
  let expandedDirs: Set<string> = new Set(["/"]);

  // ---- Determine CodeMirror theme from system theme ----
  function getCMTheme(): string {
    const name = theme.raw.name || "";
    if (
      name.toLowerCase().includes("solarized") ||
      name.toLowerCase().includes("light")
    ) {
      return "solarized";
    }
    return "dracula";
  }

  let cmTheme = getCMTheme();

  // ---- DOME relay for CodeMirror ----
  const dome = ps.find((p: any) => p.name.includes("dome"));
  let editorContent = "";
  let modified = false;
  let savedContent = ""; // baseline konten bersih (isi di disk / saat terakhir disimpan)
  // ── RUN / RE-RUN — tracking instance yang berjalan ──
  // PID disimpan ke file di /tmp supaya bisa dijadikan referensi kill
  // (pola sama seperti telechatd.pid). Berguna juga kalau editor ditutup
  // lalu dibuka lagi — PID instance lama masih bisa dibunuh.
  const RUN_PID_FILE = "/tmp/eucalyptus-run.pid";
  let runPid: number | null = null; // PID instance yang sedang berjalan

  // Normalisasi line ending supaya perbandingan isi tidak terganggu
  // (CodeMirror selalu memakai "\n" di dalam editor).
  function normalize(s: string): string {
    return s.replace(/\r\n?/g, "\n");
  }

  async function cmSetValue(value: string) {
    editorContent = value;
    modified = false;
    if (domePid)
      await shell.send(domePid, {
        type: "CM_SET_VALUE",
        wid: app.wid,
        targetId: cmId,
        value,
      });
  }

  const lib = (global as any)._tsixLib;
  lib.onEvent("ipc_message", (msg: any) => {
    const ev = msg?.data || msg;

    // Handle system-wide events (not GUI_EVENT)
    if (ev?.type === "THEME_CHANGED") {
      cmTheme = getCMTheme();
      if (domePid) {
        shell
          .send(domePid, {
            type: "CM_SET_THEME",
            wid: app.wid,
            targetId: cmId,
            theme: cmTheme,
          })
          .catch(() => {});
      }
      return;
    }

    // Handle GUI events from CodeMirror only
    if (ev?.type !== "GUI_EVENT" || ev?.targetId !== cmId) return;
    if (ev?.eventType === "cm_change") {
      // Selalu adopsi nilai aktual editor, lalu hitung ulang status modified
      // dengan membandingkan ke baseline savedContent. Bebas race: echo dari
      // cmSetValue otomatis dianggap bersih, perubahan user terdeteksi.
      const newVal = ev.value || "";
      editorContent = newVal;
      const isDirty = normalize(newVal) !== normalize(savedContent);
      if (isDirty !== modified) {
        modified = isDirty;
        updateModifiedStatus();
      }
      // Cek sintaks TS ringan (debounce) — hanya untuk file .ts/.tsx/.js
      scheduleSyntaxCheck();
    }
    // Ctrl+S from browser
    if (ev?.eventType === "cm_save") {
      saveFile();
    }
  });

  async function updateModifiedStatus() {
    const label = currentFile ? currentFile : "No file open";
    const dot = modified ? " ●" : "";
    await app.update("file-path", { text: label + dot });
    await updateRunButtons();
  }

  // ── RUN / RE-RUN — jalankan file .ts/.js dari buffer editor ──
  // Pola PID file + kill (SIGTERM → SIGKILL) ditiru dari telechatd --restart.
  function isRunnableFile(): boolean {
    if (!currentFile) return false;
    const ext = currentFile.split(".").pop()?.toLowerCase() || "";
    return ext === "ts" || ext === "js";
  }

  // ── TS SYNTAX CHECK ──
  // Ringan (esbuild, tiap ketikan, debounce) + Lengkap (TypeScript, tombol).
  const TS_CHECK_EXTS = ["ts", "tsx", "js", "jsx", "mjs", "cjs"];
  function isCheckableFile(): boolean {
    if (!currentFile) return false;
    const ext = currentFile.split(".").pop()?.toLowerCase() || "";
    return TS_CHECK_EXTS.includes(ext);
  }
  function tsLoaderForFile(): "ts" | "tsx" | "js" | "jsx" {
    const ext = currentFile?.split(".").pop()?.toLowerCase() || "ts";
    if (ext === "tsx") return "tsx";
    if (ext === "jsx") return "jsx";
    if (ext === "js" || ext === "mjs" || ext === "cjs") return "js";
    return "ts";
  }
  /** Kirim marker error ke CodeMirror via DOME. */
  async function applyDiagnostics(
    diags: { line: number; message: string; severity?: string }[],
  ) {
    if (!domePid) return;
    try {
      await shell.send(domePid, {
        type: "CM_SET_DIAGNOSTICS",
        wid: app.wid,
        targetId: cmId,
        diagnostics: diags,
      });
    } catch (_) {}
  }
  async function clearDiagnostics() {
    await applyDiagnostics([]);
  }
  /** Error sintaks pertama via esbuild (cek ringan). */
  function esbuildFirstError(
    code: string,
  ): { line: number; message: string } | null {
    try {
      esbuildTransform(code, { loader: tsLoaderForFile() });
      return null;
    } catch (err: any) {
      const e = err || {};
      const d = (Array.isArray(e.errors) && e.errors[0]) || {};
      const text = d.text || e.message || "Syntax error";
      const loc = d.location || e.location || {};
      return {
        line: Math.max(0, (loc.line || 1) - 1), // 0-based utk CodeMirror
        message: String(text),
      };
    }
  }
  // ── Cek ringan (debounce) — di-trigger tiap ketikan ──
  let syntaxTimer: any = null;
  function scheduleSyntaxCheck(delay = 350) {
    if (!isCheckableFile()) return;
    if (syntaxTimer) clearTimeout(syntaxTimer);
    syntaxTimer = setTimeout(() => {
      syntaxTimer = null;
      const err = esbuildFirstError(editorContent);
      if (err) {
        applyDiagnostics([{ ...err, severity: "error" }]);
        app.update("status-bar", {
          text: `⚠️ L${err.line + 1}: ${err.message}`,
        });
      } else {
        clearDiagnostics();
        app.update("status-bar", { text: "✅ Syntax OK" });
      }
    }, delay);
  }
  // ── Cek lengkap (tombol) — TypeScript compiler: sintaks + tipe ──
  let _tsModule: any = null;
  async function checkSyntaxFull() {
    if (!currentFile || !isCheckableFile()) return;
    try {
      // Lazy-load TypeScript compiler (berat) — hanya saat tombol ditekan.
      if (!_tsModule) _tsModule = require("typescript");
      const ts = _tsModule;
      // ── Type + syntax check via ts.createProgram ──
      // File virtual = buffer editor (bisa beda dari isi disk). Import
      // eksternal (@tsix/*, dll) di-skip (noResolve → dianggap `any`),
      // sehingga tidak ada noise "cannot find module" — tipe di dalam file
      // itu sendiri tetap diperiksa penuh (mis. `let a: string = 123`).
      const fileName = currentFile;
      const sourceText = editorContent;
      // Global umum (console, require, dll) di-stub jadi `any` supaya file
      // TSIX biasa tidak banjir error "cannot find name".
      const globalsPath = "tsix-globals.d.ts";
      const globalsText = [
        "declare var console: any;",
        "declare var require: any;",
        "declare var process: any;",
        "declare var global: any;",
        "declare var Buffer: any;",
        "declare var module: any;",
      ].join("\n");

      const options: any = {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.Preserve,
        esModuleInterop: true,
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        noResolve: true, // import eksternal → any (tanpa noise "cannot find module")
        types: [], // jangan auto-load @types — cepat, globals dari tsix-globals
      };

      const host = ts.createCompilerHost(options);
      const origGetSourceFile = host.getSourceFile.bind(host);
      const origFileExists = host.fileExists.bind(host);
      const origReadFile = host.readFile.bind(host);
      host.fileExists = (f: string) =>
        f === fileName || f === globalsPath ? true : origFileExists(f);
      host.readFile = (f: string) =>
        f === fileName
          ? sourceText
          : f === globalsPath
            ? globalsText
            : origReadFile(f);
      host.getSourceFile = (
        f: string,
        langVer: any,
        onError?: any,
        shouldCreate?: boolean,
      ) => {
        if (f === fileName)
          return ts.createSourceFile(f, sourceText, langVer, true);
        if (f === globalsPath)
          return ts.createSourceFile(f, globalsText, langVer, true);
        return origGetSourceFile(f, langVer, onError, shouldCreate);
      };

      const program = ts.createProgram([fileName, globalsPath], options, host);
      const diags: any[] = ts
        .getPreEmitDiagnostics(program)
        .filter(
          (d: any) =>
            d.file && d.file.fileName === fileName && d.start != null,
        );
      if (!diags.length) {
        await clearDiagnostics();
        await app.update("status-bar", {
          text: "✅ No errors (syntax & types)",
        });
        await app.alert(
          "🔍 Check TS",
          `${currentFile}\n\n✅ No errors (syntax & types).`,
        );
        return;
      }
      const mapped = diags.map((d: any) => {
        const pos = d.file.getLineAndCharacterOfPosition(d.start);
        const raw =
          typeof d.messageText === "string"
            ? d.messageText
            : d.messageText?.messageText || "?";
        const cat = d.category; // 1 = error, 2 = warning
        return {
          line: pos.line, // 0-based utk CodeMirror
          message: String(raw).replace(/\s+/g, " ").trim(),
          severity: cat === 2 ? "warning" : "error",
        };
      });
      await applyDiagnostics(mapped);
      const errs = mapped.filter((d: any) => d.severity === "error").length;
      const warns = mapped.length - errs;
      const first = mapped[0];
      await app.update("status-bar", {
        text: `🔍 ${errs} error${errs === 1 ? "" : "s"}${
          warns ? " · " + warns + " warning(s)" : ""
        } · first L${first.line + 1}`,
      });
      const lines = mapped
        .slice(0, 12)
        .map((d: any) => `L${d.line + 1}: ${d.message}`)
        .join("\n");
      await app.alert(
        "🔍 Check TS",
        `${currentFile}\n${errs} error(s)${
          warns ? ", " + warns + " warning(s)" : ""
        }:\n\n${lines}${
          mapped.length > 12 ? `\n… +${mapped.length - 12} lagi` : ""
        }`,
      );
    } catch (e: any) {
      // Fallback: TypeScript tidak tersedia → esbuild (error pertama saja).
      const err = esbuildFirstError(editorContent);
      if (err) {
        await applyDiagnostics([{ ...err, severity: "error" }]);
        await app.update("status-bar", {
          text: `⚠️ L${err.line + 1}: ${err.message}`,
        });
        await app.alert(
          "🔍 Check TS",
          `${currentFile}\n\n⚠️ L${err.line + 1}: ${err.message}`,
        );
      } else {
        await clearDiagnostics();
        await app.update("status-bar", { text: "✅ Syntax OK" });
      }
    }
  }

  async function readRunPid(): Promise<number | null> {
    try {
      const raw = await fs.readFile(RUN_PID_FILE);
      if (!raw) return null;
      const n = parseInt(String(raw).trim(), 10);
      return isNaN(n) ? null : n;
    } catch {
      return null;
    }
  }
  async function writeRunPid(pid: number) {
    try {
      await fs.writeFile(RUN_PID_FILE, String(pid));
    } catch (_) {}
  }
  async function removeRunPid() {
    try {
      await fs.unlink(RUN_PID_FILE);
    } catch (_) {}
  }
  async function isRunAlive(pid: number): Promise<boolean> {
    try {
      const procs = await shell.ps();
      return (
        Array.isArray(procs) &&
        procs.some((p: any) => p.pid === pid && p.state !== "EXITED")
      );
    } catch {
      return false;
    }
  }

  /** Bunuh instance yang berjalan (dari memory & pidfile). */
  async function killRunning(): Promise<void> {
    const candidates: number[] = [];
    if (runPid) candidates.push(runPid);
    const fp = await readRunPid();
    if (fp && !candidates.includes(fp)) candidates.push(fp);

    for (const pid of candidates) {
      if (!(await isRunAlive(pid))) continue;
      try {
        await shell.kill(pid, 15);
      } catch (_) {} // SIGTERM
      await std.sleep(300);
      if (await isRunAlive(pid)) {
        try {
          await shell.kill(pid, 9);
        } catch (_) {} // SIGKILL
      }
    }
    runPid = null;
    await removeRunPid();
    await updateRunButtons();
  }

  /** Jalankan file aktif dari state editor (buffer terbaru). */
  async function runCurrent() {
    if (!currentFile || !isRunnableFile()) return;
    try {
      // Tulis buffer editor ke /tmp supaya yang dijalankan = state terbaru
      // (file di disk bisa beda kalau belum di-save).
      const base = currentFile.split("/").pop() || "script";
      const tmpPath = "/tmp/eucalyptus-run-" + base;
      await fs.writeFile(tmpPath, editorContent);
      const success = await fs.chmod(tmpPath, 0o755);
      // GUI app → jalankan langsung; console app → tampilkan di pixelterm.
      const isGUI = /appMode\s*=\s*["']gui["']/.test(editorContent);
      const result = isGUI
        ? await shell.exec(tmpPath, [])
        : await shell.exec("/opt/pixelterm/pixelterm.js", [tmpPath, "-hue"]);

      runPid = result?.pid ?? null;
      if (runPid) await writeRunPid(runPid);
      await app.update("status-bar", {
        text:
          (isGUI ? "▶️ Run " : "▶️ Run (console) ") +
          base +
          (runPid ? " · PID " + runPid : ""),
      });
      await updateRunButtons();
    } catch (e: any) {
      await app.update("status-bar", { text: "❌ " + e.message });
    }
  }

  /** Re-run: bunuh instance yang berjalan, lalu jalankan ulang dari buffer. */
  async function rerunCurrent() {
    await killRunning();
    await runCurrent();
  }

  /** Sinkronkan enable/disable tombol Run, Re-run & Check Syntax. */
  async function updateRunButtons() {
    const canRun = isRunnableFile();
    await app.update("tb-run", { disabled: canRun ? "" : "1" });
    await app.update("tb-rerun", { disabled: runPid ? "" : "1" });
    await app.update("tb-check", { disabled: isCheckableFile() ? "" : "1" });
    await (app as any).win.flush();
  }

  /** Prompt user if there are unsaved changes. Returns true if caller should proceed, false if cancelled. */
  async function checkDirty(): Promise<boolean> {
    if (!modified) return true;
    const ans = await app.confirm(
      "Unsaved Changes",
      (currentFile || "untitled") + " has unsaved changes.",
      ["Save", "Discard", "Cancel"],
    );
    if (ans === "Save") {
      await saveFile();
      return true;
    }
    if (ans === "Discard") {
      modified = false;
      return true;
    }
    return false; // Cancel
  }

  // ---- FILE OPERATIONS ----
  async function openFile(filePath: string) {
    // Dirty check sebelum ganti file
    if (!(await checkDirty())) return;
    try {
      const raw = await fs.readFile(filePath);
      const c = raw ? String(raw) : "";
      currentFile = filePath;
      savedContent = c; // baseline bersih = isi file saat dibuka
      await clearDiagnostics();
      await cmSetValue(c);
      await app.update("status-bar", {
        text: "📄 " + filePath + " (" + c.length + " chars)",
      });
      await updateModifiedStatus();
    } catch (e: any) {
      await app.update("status-bar", { text: "❌ " + e.message });
    }
  }
  async function saveFile() {
    if (!currentFile) {
      await app.alert("Save", "No file open. Use Save As.");
      return;
    }
    try {
      await fs.writeFile(currentFile, editorContent);
      savedContent = editorContent;
      modified = false;
      await app.update("status-bar", { text: "✅ Saved: " + currentFile });
      await updateModifiedStatus();
    } catch (e: any) {
      await app.update("status-bar", { text: "❌ " + e.message });
    }
  }
  async function saveFileAs(path: string) {
    try {
      await fs.writeFile(path, editorContent);
      savedContent = editorContent;
      currentFile = path;
      modified = false;
      await app.update("status-bar", { text: "✅ Saved as: " + path });
      await app.update("file-path", { text: path });
      await refreshExplorer();
    } catch (e: any) {
      await app.update("status-bar", { text: "❌ " + e.message });
    }
  }

  async function goHome() {
    let homeDir = "/";
    try {
      const e = await shell.getenv("HOME");
      if (e) homeDir = e;
    } catch (_) {}

    if (expandedDirs.has(homeDir)) expandedDirs.delete(homeDir);
    else expandedDirs.add(homeDir);
    refreshExplorer();
  }

  async function closeFile() {
    if (!(await checkDirty())) return;
    currentFile = null;
    modified = false;
    savedContent = "";
    await clearDiagnostics();
    await cmSetValue("");
    await app.update("status-bar", { text: "Editor cleared" });
    await updateModifiedStatus();
  }

  function icon(e: any) {
    return e.type === "DIRECTORY" ? "📁" : "📄";
  }

  // ---- UNIFIED EXPLORER (dirs + files in one tree) ----
  async function refreshExplorer() {
    const rows: any[] = [];
    let clickHandlers: { id: string; handler: () => void }[] = [];
    let lastClick = { id: "", time: 0 };

    async function walk(dir: string, depth: number) {
      try {
        const l = (await fs.ls(dir)) || [];
        // Sort: directories first, then files
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
                  color: isDir ? theme.colors.accent : theme.colors.textDim,
                  fontFamily: "monospace",
                  borderRadius: "3px",
                  marginBottom: "1px",
                },
              },
              text((isDir ? (expanded ? "📂" : "📁") : "📄") + " " + e.name),
            ),
          );

          clickHandlers.push({
            id: eid,
            handler: () => {
              const now = Date.now();
              if (lastClick.id === eid && now - lastClick.time < 400) {
                lastClick = { id: "", time: 0 };
                if (isDir) {
                  // Toggle expand/collapse
                  if (expandedDirs.has(fp)) expandedDirs.delete(fp);
                  else expandedDirs.add(fp);
                  refreshExplorer();
                } else {
                  openFile(fp);
                }
              } else {
                lastClick = { id: eid, time: now };
                if (isDir) {
                  if (expandedDirs.has(fp)) expandedDirs.delete(fp);
                  else expandedDirs.add(fp);
                  refreshExplorer();
                }
              }
            },
          });

          // Recurse into expanded directories
          if (isDir && expanded && depth < 8) {
            await walk(fp, depth + 1);
          }
        }
      } catch (e) {
        /* skip */
      }
    }

    await walk("/", 0);
    await app.setContent(
      "explorer-container",
      div({ id: "explorer-list" }, ...rows),
    );

    const w = (app as any).win;
    for (const ch of clickHandlers) {
      w.onClick(ch.id, ch.handler);
    }
    await w.flush();
    await app.update("status-bar", {
      text:
        "Ready" +
        (currentFile ? " | 📄 " + currentFile + (modified ? " ●" : "") : ""),
    });
  }

  const tb = () => ({
    background: theme.colors.buttonBg,
    color: theme.colors.textDim,
    border: `1px solid ${theme.colors.border}`,
    padding: "3px 10px",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "11px",
    marginRight: "4px",
  });

  // ---- BUILD UI ----
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
      h2({
        text: `🌿 Eucalyptus ${version}`,
        style: { margin: "0 0 6px 0", fontSize: "15px" },
      }),
      div(
        {
          id: "toolbar",
          style: {
            display: "flex",
            gap: "4px",
            padding: "4px 0",
            borderBottom: "1px solid #333",
            marginBottom: "4px",
          },
        },
        button({
          id: "tb-home",
          text: "🏠",
          title: "Home",
          style: tb(),
          onClickId: "tb-home",
        }),
        button({
          id: "tb-new",
          text: "📄 New",
          style: tb(),
          onClickId: "tb-new",
        }),
        button({
          id: "tb-save",
          text: "💾 Save",
          style: tb(),
          onClickId: "tb-save",
        }),
        button({
          id: "tb-saveas",
          text: "📁 Save As",
          style: tb(),
          onClickId: "tb-saveas",
        }),
        button({
          id: "tb-run",
          text: "▶️ Run",
          title: "Run .ts/.js (from editor buffer)",
          style: {
            ...tb(),
            color: theme.colors.accent,
            borderColor: theme.colors.accent,
          },
          onClickId: "tb-run",
          disabled: "1",
        }),
        button({
          id: "tb-rerun",
          text: "🔄 Re-run",
          title: "Kill running instance & re-run",
          style: {
            ...tb(),
            color: theme.colors.accent,
            borderColor: theme.colors.accent,
          },
          onClickId: "tb-rerun",
          disabled: "1",
        }),
        button({
          id: "tb-check",
          text: "🔍 Check TS",
          title: "Check TS syntax & types (TypeScript compiler)",
          style: {
            ...tb(),
            color: theme.colors.warning,
            borderColor: theme.colors.warning + "66",
          },
          onClickId: "tb-check",
          disabled: "1",
        }),
        button({
          id: "tb-close",
          text: "✕ Close",
          style: {
            ...tb(),
            color: theme.colors.danger,
            borderColor: theme.colors.dangerBorder,
          },
          onClickId: "tb-close",
        }),
        span({
          id: "file-path",
          text: "No file open",
          style: {
            marginLeft: "8px",
            color: theme.colors.textMuted,
            fontSize: "11px",
            fontFamily: "monospace",
            padding: "3px 0",
          },
        }),
      ),
    ),
    "content-root",
  );

  await app.mount(
    div(
      {
        id: "split-panel",
        style: { display: "flex", gap: "0", flex: "1", overflow: "hidden" },
      },
      // Left: unified explorer (dirs + files)
      div(
        {
          id: "explorer-panel",
          style: {
            width: "200px",
            minWidth: "150px",
            overflowY: "auto",
            flexShrink: "0",
          },
        },
        h3({
          text: "📂 Explorer",
          style: { margin: "0 0 6px 0", fontSize: "12px" },
        }),
        div({ id: "explorer-container" }),
      ),
      // Draggable splitter
      div({
        id: "__euc_splitter__",
        "data-splitter": "h",
        style: {
          width: "5px",
          cursor: "col-resize",
          background: "rgba(77, 74, 64, 0.2)",
          flexShrink: "0",
        },
      }),
      // Right: CodeMirror editor
      div(
        {
          id: "editor-panel",
          style: {
            flex: "1",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          },
        },
        div(
          {
            style: {
              flex: "1",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            },
          },
          {
            id: cmId,
            tag: "codemirror" as any,
            props: { mode: "javascript", theme: cmTheme, value: "" },
            children: [],
          },
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
      span({ id: "status-bar", text: "Ready" }),
    ),
    "content-root",
  );

  await app.on("tb-home", "click", goHome);
  await app.on("tb-new", "click", closeFile);
  await app.on("tb-save", "click", saveFile);
  await app.on("tb-saveas", "click", async () => {
    const file = await app.saveFileDialog(fs, {
      title: "💾 Save As",
      startDir: currentFile
        ? currentFile.substring(0, currentFile.lastIndexOf("/"))
        : "/tmp",
      defaultName: currentFile ? currentFile.split("/").pop() : "untitled.txt",
    });
    if (file) await saveFileAs(file.path);
  });
  await app.on("tb-close", "click", closeFile);
  await app.on("tb-run", "click", runCurrent);
  await app.on("tb-rerun", "click", rerunCurrent);
  await app.on("tb-check", "click", checkSyntaxFull);

  // Pulihkan referensi PID instance yang mungkin masih berjalan dari sesi
  // sebelumnya (baca dari pidfile) — supaya Re-run bisa langsung dipakai.
  const savedPid = await readRunPid();
  if (savedPid && (await isRunAlive(savedPid))) runPid = savedPid;
  await updateRunButtons();

  await refreshExplorer();

  // Jika ada argumen file path, buka langsung
  if (args.length > 0 && args[0]) {
    setTimeout(() => openFile(args[0]), 300);
  }

  await app.loopUntilClose();
});
