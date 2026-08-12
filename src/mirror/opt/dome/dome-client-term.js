/* ============================================================
 * DOME Client — Terminal (xterm.js)
 * ============================================================
 * Modul penanganan widget <xterm> di dome-client.
 * - Inbound: TERM_OUTPUT, TERM_THEME, TERM_REFRESH, TERM_RESIZE, TERM_FOCUS
 * - initXterm() diekspos via TSIX.initXterm (dipakai buildDOM di dom module)
 */
(function () {
  "use strict";
  const TSIX = window.TSIX;

  function handleTermOutput(msg) {
    const { wid, targetId, data } = msg;
    const el = TSIX.findElementById(wid, targetId);
    if (el && el._xterm) {
      el._xterm.write(data);
    }
  }

  function handleTermRefresh(msg) {
    const { wid, targetId } = msg;
    const el = TSIX.findElementById(wid, targetId);
    if (el && el._xterm) {
      el._xterm.refresh(0, el._xterm.rows - 1);
    }
  }

  function handleTermResize(msg) {
    const { wid, targetId, cols, rows } = msg;
    if (!cols || !rows) return;
    const el = TSIX.findElementById(wid, targetId);
    if (el) {
      if (el._xterm) {
        el._xterm.resize(cols, rows);
      } else {
        // xterm belum siap — simpan ukuran, terapkan pas siap
        el._pendingResize = { cols, rows };
      }
    }
  }

  function handleTermFocus(msg) {
    const { wid, targetId } = msg;
    const el = TSIX.findElementById(wid, targetId);
    if (!el) return;
    if (el._xterm) {
      el._xterm.focus();
    } else {
      // xterm belum siap (initXterm masih delay) — fokus nanti di initXterm
      el._pendingFocus = true;
    }
  }

  function handleTermTheme(msg) {
    const { wid, targetId, colors } = msg;
    const el = TSIX.findElementById(wid, targetId);
    if (!el) return;
    el.style.background = colors.background || "#0a0a0a";
    // Recreate xterm dengan tema baru (canvas text butuh constructor ulang)
    if (el._xterm) {
      el._xterm.dispose();
      el._xterm = null;
    }
    initXterm(el, colors);
  }

  // --- Resize tooltip (indikator rows:cols saat window di-resize) ---
  function initResizeTooltip(el) {
    // Rebuild kalo tip lama sudah tidak terpasang (mis. usai recreate xterm)
    if (el._resizeTip && el._resizeTip.isConnected) return;
    el.style.position = "relative"; // anchor overlay
    const tip = document.createElement("div");
    tip.className = "_tsix_resize_tip";
    tip.style.cssText =
      "position:absolute;right:12px;bottom:12px;padding:3px 8px;" +
      "font:600 12px 'SF Mono','Menlo','Courier New',monospace;" +
      "border-radius:4px;background:rgba(0,0,0,0.78);color:#fff;" +
      "border:1px solid rgba(255,255,255,0.15);" +
      "pointer-events:none;opacity:0;transition:opacity .15s;" +
      "z-index:10;white-space:nowrap;";
    el.appendChild(tip);
    let hideTimer = null;
    el._showResizeTip = function (text) {
      tip.textContent = text;
      tip.style.opacity = "1";
      clearTimeout(hideTimer);
      hideTimer = setTimeout(function () {
        tip.style.opacity = "0";
      }, 1500);
    };
    el._resizeTip = tip;
  }

  // --- xterm.js init (dipanggil dari buildDOM dan handleTermTheme) ---
  function initXterm(el, themeColors) {
    if (typeof Terminal === "undefined") return;
    // Hapus isi lama (xterm DOM) kalo ada (misal dari recreate)
    el.innerHTML = "";
    const oldStyle = el.querySelector("._tsix_term_theme");
    if (oldStyle) oldStyle.remove();
    const cw = el.clientWidth || 700;
    const ch = el.clientHeight || 400;
    const initCols = Math.max(20, Math.floor(cw / 8.4));
    const initRows = Math.max(5, Math.floor(ch / 16));
    const tt = themeColors;
    const termTheme = tt
      ? Object.assign(
          {
            background: tt.background || "#0a0a0a",
            foreground: tt.foreground || "#e0e0e0",
            cursor: tt.cursor || "#4caf50",
          },
          tt,
        )
      : {
          background: "#0a0a0a",
          foreground: "#e0e0e0",
          cursor: "#4caf50",
        };
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      cols: initCols,
      rows: initRows,
      convertEol: true,
      fontFamily: "'SF Mono', 'Menlo', 'Courier New', monospace",
      fontWeight: "600",
      theme: {
        ...termTheme,
        background: "rgba(0,0,0,0)", // transparent biar selection layer tembus
      },
    });
    term.open(el);
    initResizeTooltip(el);
    if (tt) {
      const style = document.createElement("style");
      style.className = "_tsix_term_theme";
      const selBase =
        '[data-tsix-id="' + CSS.escape(el._xtermNodeId || "") + '"]';
      style.textContent =
        selBase +
        " .xterm-viewport { background: " +
        (tt.background || "#0a0a0a") +
        " !important; }" +
        selBase +
        " .xterm-cursor { background: " +
        (tt.cursor || "#4caf50") +
        " !important; color: " +
        (tt.cursorAccent || "#000000") +
        " !important; }";
      el.appendChild(style);
    }
    term.onData(function (data) {
      TSIX.send({
        wid: el._xtermWid,
        targetId: el._xtermNodeId,
        eventType: "term_input",
        value: data,
      });
    });
    el._xterm = term;
    // Auto-focus jika ada permintaan focus sebelum xterm siap
    if (el._pendingFocus) {
      term.focus();
      el._pendingFocus = false;
    }
    // Terapkan pendingResize kalo ada
    if (el._pendingResize) {
      term.resize(el._pendingResize.cols, el._pendingResize.rows);
      delete el._pendingResize;
    }
    // Auto-fit rows/cols
    var fit = function () {
      var w = el.clientWidth,
        h = el.clientHeight;
      var cols = Math.floor(w / 8.4);
      var rows = Math.floor(h / 16);
      if (cols > 0 && rows > 0) {
        var c = Math.max(20, cols);
        var r = Math.max(5, rows);
        if (term.rows !== r || term.cols !== c) {
          term.resize(c, r);
          TSIX.send({
            wid: el._xtermWid,
            targetId: el._xtermNodeId,
            eventType: "term_resize",
            cols: c,
            rows: r,
          });
          // Tooltip indikator row:col saat resize
          if (el._showResizeTip) {
            el._showResizeTip("R:" + r + "  C:" + c);
          }
        }
      }
    };
    fit();
    // Kirim term_resize AWAL yang pasti ke proses pemilik window (pixelterm).
    // xterm baru dibuat LANGSUNG dengan ukuran hasil fit(), jadi fit() tidak
    // mengirim term_resize (ukurannya tidak berubah). Tanpa ini pixelterm
    // ke-2+ tidak pernah tahu ukuran sebenarnya -> atto tidak di-resize ->
    // status bar tidak ikut cursor (harus resize manual dulu baru benar).
    TSIX.send({
      wid: el._xtermWid,
      targetId: el._xtermNodeId,
      eventType: "term_resize",
      cols: term.cols,
      rows: term.rows,
    });
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(fit).observe(el);
    }
  }

  // Ekspor initXterm agar bisa dipakai buildDOM (dom module)
  TSIX.initXterm = initXterm;

  TSIX.register("TERM_OUTPUT", handleTermOutput);
  TSIX.register("TERM_THEME", handleTermTheme);
  TSIX.register("TERM_REFRESH", handleTermRefresh);
  TSIX.register("TERM_RESIZE", handleTermResize);
  TSIX.register("TERM_FOCUS", handleTermFocus);
})();
