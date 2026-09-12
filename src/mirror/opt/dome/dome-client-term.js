/* ============================================================
 * DOME Client � Terminal (xterm.js)
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
        // xterm belum siap � simpan ukuran, terapkan pas siap
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
      // xterm belum siap (initXterm masih delay) � fokus nanti di initXterm
      el._pendingFocus = true;
    }
  }

  function handleTermTheme(msg) {
    const { wid, targetId, colors } = msg;
    const el = TSIX.findElementById(wid, targetId);
    if (!el) return;
    el.style.background = colors.background || "#0a0a0a";
    // Recreate xterm dengan tema baru (canvas text butuh constructor ulang).
    // Opsi CRT WAJIB diteruskan � kalau tidak, efek retro hilang setiap kali
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
  // Console mengisi SELURUH node xterm (tanpa frame gambar monitor), jadi resize
  // window langsung mengubah COLUMNS/LINES seperti PixelTerm. Yang ditambahkan di
  // sini hanyalah ILUSI TABUNG CRT:
  //   [1] Cembung    : inset shadow tebal di tepi -> kesan kaca melengkung ke dalam
  //   [2] Specular   : kilau lembut di kiri-atas -> pantulan kaca cembung
  //   [3] Vignette   : tepi tabung menggelap
  //   [4] Scanlines  : garis horizontal periodik
  //   [5] Tint       : warna fosfor hijau tipis
  //   [6] Flicker    : denyut sangat halus (bukan strobo)
  //
  // CATATAN KEJUJURAN TEKNIS: ini ilusi visual (cahaya + bayangan), BUKAN distorsi
  // geometris. Distorsi barrel sejati butuh post-processing GPU (WebGL) atau SVG
  // feDisplacementMap yang harus dihitung ulang TIAP FRAME pada canvas terminal ->
  // berat & berisiko bikin input terasa lag. Pendekatan ini nol biaya per-frame.
  //
  // PENTING: overlay WAJIB `pointer-events:none`, dan JANGAN pasang itu pada parent
  // dari `.xterm` -> sifatnya diwariskan ke anak, xterm jadi tidak bisa diketik
  // (bug yang pernah terjadi).
  function applyCrtFx(el, crt) {
    el.querySelectorAll("._tsix_crt").forEach(function (n) { n.remove(); });
    if (!crt || !crt.enabled) return;

    var screenBg = crt.screenBg || "#020803";
    var cv = crt.convex || {};
    var radius = cv.radius != null ? cv.radius : 16;      // px, sudut tabung
    var edge = cv.edge != null ? cv.edge : 0.72;          // 0..1, kedalaman tepi
    var hi = cv.highlight != null ? cv.highlight : 0.07;  // 0..1, kekuatan kilau

    el.style.position = "relative";
    el.style.background = screenBg;
    el.style.overflow = "hidden";
    el.style.borderRadius = radius + "px";
    // Cembung: dua lapis inset shadow -> gelap pekat di tepi, makin tipis ke tengah.
    el.style.boxShadow =
      "inset 0 0 44px 12px rgba(0,0,0," + (edge * 0.62).toFixed(3) + ")," +
      "inset 0 0 120px 30px rgba(0,0,0," + (edge * 0.42).toFixed(3) + ")";

    // Overlay cahaya & efek, di atas teks.
    var fx = document.createElement("div");
    fx.className = "_tsix_crt _tsix_crt_fx";
    var scan = crt.scanline || {};
    var period = scan.period || 3;
    var lineAlpha = scan.alpha != null ? scan.alpha : 0.28;
    var layers = [];

    // [2] Specular highlight: kilau kaca cembung di kiri-atas.
    layers.push(
      "radial-gradient(ellipse 130% 100% at 28% 8%, rgba(190,255,210," +
      hi.toFixed(3) + "), rgba(0,0,0,0) 58%)"
    );
    // [2b] Pantulan tipis di kanan-bawah (menegaskan kelengkungan).
    layers.push(
      "radial-gradient(ellipse 110% 85% at 74% 97%, rgba(120,255,170," +
      (hi * 0.5).toFixed(3) + "), rgba(0,0,0,0) 46%)"
    );
    // [3] Vignette: tepi tabung menggelap.
    layers.push(
      "radial-gradient(ellipse at center, rgba(0,0,0,0) 52%, rgba(0,0,0," +
      (crt.vignette != null ? crt.vignette : 0.45) + ") 100%)"
    );
    // [4] Scanlines.
    layers.push(
      "repeating-linear-gradient(0deg, rgba(0,0,0," + lineAlpha + ") 0px, " +
      "rgba(0,0,0," + lineAlpha + ") 1px, rgba(0,0,0,0) 1px, rgba(0,0,0,0) " +
      period + "px)"
    );
    // [5] Tint fosfor.
    if (crt.tint) layers.push("linear-gradient(" + crt.tint + ", " + crt.tint + ")");

    fx.style.cssText =
      "position:absolute;inset:0;pointer-events:none;z-index:2;" +
      "border-radius:" + radius + "px;" +
      "background:" + layers.join(",") + ";";
    el.appendChild(fx);

    // [6] Flicker halus.
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
  }


  // --- Font bitmap kustom (dipakai RetroTerm; app lain tidak mengirim) ---
  // Menyuntik @font-face ke <head> supaya bisa dipakai xterm. Dilakukan sekali
  // per family — penggantian tema berikutnya tidak menumpuk style duplikat.
  // Kalau `crt.fontFaceCss` kosong, font monospace sistem yang dipakai.
  function installCrtFont(crt) {
    if (!crt || !crt.fontFaceCss) return;
    var familyMatch = /font-family:'([^']+)'/.exec(crt.fontFaceCss);
    var family = familyMatch ? familyMatch[1] : "_tsix_retro";
    var id = "_tsix_font_" + family.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (document.getElementById(id)) return; // sudah terpasang
    var st = document.createElement("style");
    st.id = id;
    st.textContent = crt.fontFaceCss;
    document.head.appendChild(st);
  }

  // --- Ukur ukuran sel (1 karakter) dari xterm.js ---
  // PENTING: jangan pakai estimasi (mis. fontSize*0.6) untuk menghitung
  // cols/rows. Rasio font berbeda-beda — bitmap Tandy 8x16 rasionya 0.5,
  // sedangkan estimasi 0.6 membuat cols/rows LEBIH BANYAK dari yang muat,
  // sehingga xterm.js auto-scroll ke bawah dan teks tampak "tenggelam".
  // Jadi ukur yang sebenarnya, dengan 3 tingkat fallback.
  function measureCell(term, el, fontSize) {
    // 1) Dimensi internal render service (paling akurat).
    try {
      var rs = term._core && term._core._renderService;
      var d = rs && rs.dimensions;
      if (d && d.css && d.css.cell && d.css.cell.width > 0 && d.css.cell.height > 0) {
        return { w: d.css.cell.width, h: d.css.cell.height };
      }
    } catch (_) { /* lanjut ke fallback */ }

    // 2) Elemen pengukur yang dibuat xterm.js (berisi 32 karakter "W").
    try {
      var m = el.querySelector(".xterm-char-measure-element");
      if (m) {
        var r = m.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { w: r.width / 32, h: r.height };
        }
      }
    } catch (_) { /* lanjut ke fallback */ }

    // 3) Estimasi terakhir (rasio 0.6 umum untuk monospace non-bitmap).
    return { w: fontSize * 0.6, h: fontSize * 1.0 };
  }

  // --- xterm.js init (dipanggil dari buildDOM dan handleTermTheme) ---
  function initXterm(el, themeColors, crtOptions) {
    if (typeof Terminal === "undefined") return;
    // Hapus isi lama (xterm DOM) kalo ada (misal dari recreate)
    el.innerHTML = "";
    // Efek CRT (kalau ada) dipasang setelah xterm terbentuk.
    var _crt = crtOptions || el._crtOptions;
    // Font bitmap harus terpasang SEBELUM Terminal dibuat, supaya glyph pertama
    // sudah memakai font yang benar (kalau tidak, terjadi reflow 1 frame).
    installCrtFont(_crt);
    const oldStyle = el.querySelector("._tsix_term_theme");
    if (oldStyle) oldStyle.remove();
    const cw = el.clientWidth || 700;
    const ch = el.clientHeight || 400;
    var _fontSize = (_crt && _crt.fontSize) || 14;
    // Estimasi awal untuk cols/rows SEBELUM xterm ada (dipakai hanya untuk
    // jumlah kolom/baris awal). Setelah font siap, fit() akan mengukur ulang
    // dengan ukuran sel sebenarnya.
    var _cellW = _fontSize * 0.6;
    var _cellH = _fontSize * 1.0;
    const initCols = Math.max(20, Math.floor(cw / _cellW));
    const initRows = Math.max(5, Math.floor(ch / _cellH));
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
      fontSize: _fontSize,
      cols: initCols,
      rows: initRows,
      convertEol: true,
      // Font bitmap dari app (kalau ada) — kalau tidak, fallback monospace sistem.
      fontFamily: (_crt && _crt.fontFamily) ||
        "'SF Mono', 'Menlo', 'Courier New', monospace",
      // Bitmap font tidak punya bobot bold asli; "normal" menghindari sintesis
      // bold yang membuat glyph bitmap buram.
      fontWeight: (_crt && _crt.fontFamily) ? "normal" : "600",
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
        // Latar viewport: transparan HANYA saat CRT aktif, supaya efek tabung
        // (tint/vignette/scanline) terlihat di belakang teks. Untuk app biasa
        // (PixelTerm) tetap memakai warna tema — jangan dibuat transparan
        // tanpa syarat, nanti latarnya hilang.
        " .xterm-viewport { background: " +
        (_crt && _crt.enabled ? "transparent" : (tt.background || "#0a0a0a")) +
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
    // Console mengisi SELURUH node xterm (tanpa frame/bezel), jadi ukurannya
    // cukup dari `el` — sama seperti PixelTerm. Hasilnya: resize window langsung
    // mengubah COLUMNS/LINES ke shell.
    var fit = function () {
      var w = el.clientWidth,
        h = el.clientHeight;
      // Ukur ukuran sel SEBENARNYA dari xterm (bukan estimasi). Tanpa ini,
      // cols/rows bisa lebih banyak dari yang muat -> xterm auto-scroll dan
      // teks tampak tenggelam ke dasar window.
      var cell = measureCell(term, el, _fontSize);
      var cols = Math.floor(w / cell.w);
      var rows = Math.floor(h / cell.h);
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
    // Efek CRT dipasang sebelum fit(). Urutannya tidak lagi kritis (tidak ada
    // layer layar yang harus ada lebih dulu), tapi tetap begini supaya overlay
    // sudah siap saat grid pertama dihitung.
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
      // Amati node xterm itu sendiri — console mengisi penuh (tanpa layer
      // perantara), jadi resize window langsung memicu hitung ulang grid.
      new ResizeObserver(fit).observe(el);
    }

    // Hitung ulang setelah font bitmap benar-benar ter-decode.
    // Font dari data URI dimuat ASINKRON: saat term.open() ukuran sel masih
    // memakai font fallback, lalu berubah begitu font siap. Tanpa re-fit di
    // sini, cols/rows tetap memakai ukuran font fallback -> teks tenggelam.
    if (_crt && _crt.fontFaceCss) {
      var refitAfterFont = function () { try { fit(); } catch (_) { } };
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(refitAfterFont).catch(function () { });
      }
      // Jaring kedua: sebagian browser tidak memicu fonts.ready untuk font
      // yang baru disuntik. Cek eksplisit beberapa kali, lalu berhenti.
      var fontTries = 0;
      var fontTimer = setInterval(function () {
        fontTries++;
        var ready = document.fonts && document.fonts.check
          ? document.fonts.check(_fontSize + "px '" +
            ((_crt.fontFamily || "").split(",")[0].replace(/['"]/g, "")) + "'")
          : true;
        if (ready || fontTries >= 10) {
          clearInterval(fontTimer);
          if (ready) refitAfterFont();
        }
      }, 120);
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
