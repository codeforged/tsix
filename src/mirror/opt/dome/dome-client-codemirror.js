/* ============================================================
 * DOME Client — CodeMirror
 * ============================================================
 * Modul penanganan widget <codemirror> di dome-client.
 * - Inbound: CM_SET_VALUE, CM_SET_THEME
 * - Pembuatan widget <codemirror> (dengan event cm_change, cm_save, dll)
 *   ada di buildDOM() pada dom module.
 */
(function () {
  "use strict";
  const TSIX = window.TSIX;

  function handleCMSetValue(msg) {
    const { wid, targetId, value } = msg;
    const el = TSIX.findElementById(wid, targetId);
    if (el && el._codemirror) {
      el._codemirror.setValue(value);
    }
  }

  function handleCMSetTheme(msg) {
    const { wid, targetId, theme } = msg;
    const el = TSIX.findElementById(wid, targetId);
    if (el && el._codemirror) {
      el._codemirror.setOption("theme", theme);
    }
  }

  // TS syntax check markers (Eucalyptus): gutter ✖/⚠ + background baris error.
  function handleCMSetDiagnostics(msg) {
    const { wid, targetId, diagnostics } = msg;
    const el = TSIX.findElementById(wid, targetId);
    const cm = el && el._codemirror;
    if (!cm) return;

    // Bersihkan marker lama
    const prev = el.__eucDiagLines || [];
    for (const line of prev) {
      if (line >= 0 && line < cm.lineCount()) {
        cm.setGutterMarker(line, "euc-lint", null);
        cm.removeLineClass(line, "background", "euc-error-line");
      }
    }
    el.__eucDiagLines = [];
    if (!diagnostics || !diagnostics.length) return;

    const marked = new Set();
    for (const d of diagnostics) {
      const line = Number(d && d.line);
      if (!isFinite(line) || line < 0 || line >= cm.lineCount()) continue;
      if (marked.has(line)) continue;
      marked.add(line);

      const isError = !d.severity || d.severity === "error";
      const marker = document.createElement("div");
      marker.className =
        "euc-lint-marker " + (isError ? "euc-lint-error" : "euc-lint-warn");
      marker.textContent = isError ? "✖" : "⚠";
      marker.title =
        (d.message || "Diagnostic") + " (line " + (line + 1) + ")";
      cm.setGutterMarker(line, "euc-lint", marker);
      cm.addLineClass(line, "background", "euc-error-line");
      el.__eucDiagLines.push(line);
    }
  }

  TSIX.register("CM_SET_VALUE", handleCMSetValue);
  TSIX.register("CM_SET_THEME", handleCMSetTheme);
  TSIX.register("CM_SET_DIAGNOSTICS", handleCMSetDiagnostics);
})();
