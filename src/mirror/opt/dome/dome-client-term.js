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
    // Recreate xterm dengan tema baru (canvas text butuh constructor ulang).
    // Opsi CRT WAJIB diteruskan — kalau tidak, efek retro hilang setiap kali
    // tema sistem berubah (mis. user ganti theme di Asteracea).
    const crt = msg.crt || el._crtOptions;
    if (el._xterm) {
      el._xterm.dispose();
      el._xterm = null;
    }
    initXterm(el, colors, crt);
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

  // --- Efek CRT OPSIONAL (dipakai RetroTerm; pixelterm tidak mengaktifkannya) ---
  // Menyuntik elemen overlay di dalam node xterm: vignette, scanlines, phosphor
  // glow, flicker, dan bezel gambar (JPG) sebagai frame. Semua opt-in lewat
  // prop `crt`, jadi tema/app lain tidak terpengaruh.
  function applyCrtFx(el, crt) {
    // Bersihkan efek lama (kalau TERM_THEME di-apply ulang).
    el.querySelectorAll("._tsix_crt").forEach(function (n) { n.remove(); });
    if (!crt || !crt.enabled) return;

    el.style.position = "relative";
    el.style.background = crt.screenBg || "#020803";

    var bezel = crt.bezel || {};
    var inset = bezel.inset || {};
    var top = inset.top || "0px";
    var right = inset.right || "0px";
    var bottom = inset.bottom || "0px";
    var left = inset.left || "0px";

    // 1) Bezel: gambar CRT dipasang sebagai BACKGROUND container, lalu layar
    //    ditimpa di atasnya sebagai kotak opak.
    //
    // MENGAPA BUKAN clip-path: `polygon()` tidak mendukung lubang (butuh subpath
    // arah berlawanan, tidak didukung browser). Poligon "bingkai" naif menutup
    // lewat garis diagonal yang melintasi area layar — akibatnya gambar monitor
    // MENUTUPI teks terminal. Itu bug yang pernah terjadi.
    //
    // Pendekatan ini kebal terhadap kesalahan itu: apa pun bentuk casing di
    // gambar, layar selalu berupa kotak opak di z-index LEBIH TINGGI, jadi teks
    // tidak mungkin tertutup.
    if (bezel.imageUrl) {
      el.style.backgroundImage = "url(" + bezel.imageUrl + ")";
      el.style.backgroundSize = "100% 100%";
      el.style.backgroundRepeat = "no-repeat";
      el.style.backgroundPosition = "center";
    }

    // 2) Lapisan teks terminal DI ATAS bezel (z-index lebih tinggi + opak).
    var screen = document.createElement("div");
    screen.className = "_tsix_crt _tsix_crt_screen";
    screen.style.cssText =
      "position:absolute;" +
      "top:" + top + ";right:" + right + ";bottom:" + bottom + ";left:" + left + ";" +
      "z-index:1;overflow:hidden;" +
      "background:" + (crt.screenBg || "#020803") + ";" +
      "border-radius:" + ((bezel.screenRadius) || "18px") + ";" +
      "box-shadow:0 0 24px 6px rgba(0,0,0,0.85) inset;";
    el.appendChild(screen);

    // Elemen .xterm dipindahkan ke dalam layer screen supaya ikut ter-clip.
    // Ukurannya dipaksa 100% mengikuti layer layar (bukan ukuran luar) — teks
    // jadi tidak pernah meluber menembus bezel.
    var xtermEl = el.querySelector(".xterm");
    if (xtermEl) {
      screen.appendChild(xtermEl);
      xtermEl.style.width = "100%";
      xtermEl.style.height = "100%";
      xtermEl.style.overflow = "hidden";
    }

    // 3) Overlay efek: vignette + scanlines + glow + flicker (di atas teks).
    var fx = document.createElement("div");
    fx.className = "_tsix_crt _tsix_crt_fx";
    var scan = crt.scanline || {};
    var period = scan.period || 3;
    var lineAlpha = scan.alpha != null ? scan.alpha : 0.28;
    var layers = [];

    // Phosphor glow: warna redup di tengah, menguat di tepi (meniru tabung).
    layers.push(
      "radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, " +
      "rgba(0,0,0," + (crt.vignette != null ? crt.vignette : 0.45) + ") 100%)"
    );
    // Scanlines: garis gelap periodik.
    layers.push(
      "repeating-linear-gradient(0deg, rgba(0,0,0," + lineAlpha + ") 0px, " +
      "rgba(0,0,0," + lineAlpha + ") 1px, rgba(0,0,0,0) 1px, rgba(0,0,0,0) " +
      period + "px)"
    );
    // Tint hijau fosfor tipis (opsional).
    if (crt.tint) {
      layers.push(
        "linear-gradient(" + crt.tint + ", " + crt.tint + ")"
      );
    }
    fx.style.cssText =
      "position:absolute;inset:0;pointer-events:none;z-index:2;" +
      "background:" + layers.join(",") + ";";
    // Flicker halus (kalau diaktifkan) — gerakannya sangat kecil, bukan strobo.
    if (crt.flicker) {
      var anim = document.createElement("style");
      anim.className = "_tsix_crt _tsix_crt_anim";
      var key = "_tsixCrtFlicker";
      anim.textContent =
        "@keyframes " + key + " {0%,100%{opacity:.978}50%{opacity:1}}" +
        '[data-tsix-id="' + CSS.escape(el._xtermNodeId || "") + '"] ._tsix_crt_fx' +
        "{animation:" + key + " 120ms steps(2,end) infinite;}";
      el.appendChild(anim);
    }
    screen.appendChild(fx);
  }

  // --- xterm.js init (dipanggil dari buildDOM dan handleTermTheme) ---
  function initXterm(el, themeColors, crtOptions) {
    if (typeof Terminal === "undefined") return;
    // Hapus isi lama (xterm DOM) kalo ada (misal dari recreate)
    el.innerHTML = "";
    // Efek CRT (kalau ada) dipasang setelah xterm terbentuk.
    var _crt = crtOptions || el._crtOptions;
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
    // Auto-fit rows/cols.
    // PENTING (mode CRT): begitu ada bezel, .xterm dipindah ke dalam layer
    // `._tsix_crt_screen` yang LEBIH KECIL dari node xterm. Kalau fit() tetap
    // mengukur `el` (ukuran luar), teks akan meluber keluar area layar dan
    // COLUMNS/LINES ke shell juga salah. Jadi ukur layer layar bila ada.
    var fit = function () {
      var box = el.querySelector("._tsix_crt_screen") || el;
      var w = box.clientWidth,
        h = box.clientHeight;
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
    // Efek CRT dipasang SEBELUM fit() — `fit()` mengukur layer layar (yang baru
    // ada setelah applyCrtFx), jadi urutan ini wajib. Kalau dibalik, xterm
    // diukur terhadap ukuran window dan teksnya meluber keluar area layar.
    if (_crt) {
      el._crtOptions = _crt;
      applyCrtFx(el, _crt);
    }

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
      // Amati layer layar (kalau ada) supaya fit() terpanggil saat area layar
      // berubah — bukan hanya saat window berubah.
      var observeTarget = el.querySelector("._tsix_crt_screen") || el;
      new ResizeObserver(fit).observe(observeTarget);
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
