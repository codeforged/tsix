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
  // Bezel + scanline + vignette + tint + flicker. Semua opt-in lewat prop `crt`.
  //
  // PRINSIP GEOMETRI (penting, jangan diubah tanpa alasan):
  //   1. Bezel digambar sebagai background dengan `object-fit: contain` �
  //      aspek gambar SELALU terjaga (tidak gepeng) di ukuran window apa pun.
  //   2. Posisi & ukuran layar dihitung PROPORSIONAL terhadap kotak bezel
  //      (bukan persen window), memakai `hole` yang diukur dari gambar asli.
  //      Karena itu layar selalu berada persis di lubang bezel dan tetap CENTER
  //      saat window di-resize.
  //   3. Layout dihitung ulang pada setiap resize lewat ResizeObserver.
  //
  // Ini juga menutup kelas bug sebelumnya: layar selalu kotak opak di atas
  // bezel, jadi gambar tidak mungkin menutupi teks.
  function applyCrtFx(el, crt) {
    el.querySelectorAll("._tsix_crt").forEach(function (n) { n.remove(); });
    if (!crt || !crt.enabled) return;

    var bezel = crt.bezel || {};
    // Nilai default diukur dari retro-crt.jpg (655x576).
    var imgW = bezel.imgW || 655;
    var imgH = bezel.imgH || 576;
    var hole = bezel.hole || { left: 0.13, right: 0.88, top: 0.12, bottom: 0.78 };
    var screenBg = crt.screenBg || "#020803";

    el.style.position = "relative";
    el.style.background = screenBg;
    el.style.overflow = "hidden";

    // 1) Bezel: satu elemen background, aspect-preserving (contain).
    var stage = document.createElement("div");
    stage.className = "_tsix_crt _tsix_crt_stage";
    stage.style.cssText =
      "position:absolute;inset:0;pointer-events:none;z-index:0;overflow:hidden;";
    var bimg = document.createElement("div");
    bimg.className = "_tsix_crt _tsix_crt_bezel";
    // Posisi & ukuran ditentukan layout() (bukan `inset:0`), supaya bezel bisa
    // digeser agar LUBANG LAYAR-nya tepat di tengah window.
    bimg.style.cssText =
      "position:absolute;left:0;top:0;" +
      "background-repeat:no-repeat;background-position:0 0;" +
      "background-size:100% 100%;" +
      (bezel.imageUrl ? "background-image:url(" + bezel.imageUrl + ");" : "");
    stage.appendChild(bimg);

    // 2) Layar: kotak opak di atas bezel (z-index 1).
    var screen = document.createElement("div");
    screen.className = "_tsix_crt _tsix_crt_screen";
    screen.style.cssText =
      "position:absolute;z-index:1;overflow:hidden;" +
      "background:" + screenBg + ";" +
      "border-radius:" + (bezel.screenRadius || "14px") + ";" +
      "box-shadow:0 0 26px 8px rgba(0,0,0,0.9) inset;";
    stage.appendChild(screen);

    // 3) Overlay efek di atas teks: vignette + scanline + tint (+ flicker).
    var fx = document.createElement("div");
    fx.className = "_tsix_crt _tsix_crt_fx";
    var scan = crt.scanline || {};
    var period = scan.period || 3;
    var lineAlpha = scan.alpha != null ? scan.alpha : 0.28;
    var layers = [];
    layers.push(
      "radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0," +
      (crt.vignette != null ? crt.vignette : 0.45) + ") 100%)"
    );
    layers.push(
      "repeating-linear-gradient(0deg, rgba(0,0,0," + lineAlpha + ") 0px, " +
      "rgba(0,0,0," + lineAlpha + ") 1px, rgba(0,0,0,0) 1px, rgba(0,0,0,0) " +
      period + "px)"
    );
    if (crt.tint) layers.push("linear-gradient(" + crt.tint + ", " + crt.tint + ")");
    fx.style.cssText =
      "position:absolute;inset:0;pointer-events:none;z-index:2;" +
      "background:" + layers.join(",") + ";";
    screen.appendChild(fx);

    if (crt.flicker) {
      var anim = document.createElement("style");
      anim.className = "_tsix_crt _tsix_crt_anim";
      var key = "_tsixCrtFlicker";
      anim.textContent =
        "@keyframes " + key + " {0%,100%{opacity:.978}50%{opacity:1}}" +
        '[data-tsix-id="' + CSS.escape(el._xtermNodeId || "") + '"] ._tsix_crt_fx' +
        "{animation:" + key + " 120ms steps(2,end) infinite;}";
      stage.appendChild(anim);
    }

    el.appendChild(stage);

    // Elemen .xterm dipindah ke dalam layar; ukurannya mengikuti layar.
    var xtermEl = el.querySelector(".xterm");
    if (xtermEl) {
      screen.appendChild(xtermEl);
      xtermEl.style.width = "100%";
      xtermEl.style.height = "100%";
      xtermEl.style.overflow = "hidden";
    }

    // ---- Perhitungan layout ----
    // Tujuan: LUBANG LAYAR (bukan seluruh gambar) yang dipusatkan di window, dan
    // layar tidak pernah lebih besar dari window. Jadi saat resize, layar tumbuh
    // menyusut sambil tetap persis di tengah.
    function layout() {
      var cw = el.clientWidth;
      var ch = el.clientHeight;
      if (!cw || !ch) return null;

      var holeW = hole.right - hole.left;   // fraksi lebar lubang (0..1)
      var holeH = hole.bottom - hole.top;   // fraksi tinggi lubang
      if (holeW <= 0 || holeH <= 0) return null;

      var holeCnFx = (hole.left + hole.right) / 2;  // pusat lubang (fraksi)
      var holeCnFy = (hole.top + hole.bottom) / 2;

      // Skala dibatasi EMPAT syarat, ambil yang terkecil. Tujuannya: layar
      // persis di tengah window (permintaan utama) TANPA casing terpotong.
      //
      // Karena lubang layar TIDAK center di gambar (di retro-crt.jpg: atas 12%,
      // bawah 22%), memusatkan lubang otomatis menggeser gambar. Jadi selain
      // ukuran, arah geser juga harus dibatasi — kalau tidak, sisi yang lebih
      // panjang akan keluar window (pernah terjadi pada window portrait).
      var MARGIN_HOLE = 0.94;  // margin area layar
      var MARGIN_IMG = 0.98;   // margin gambar penuh (casing)
      var maxCx = Math.max(holeCnFx, 1 - holeCnFx);  // setengah-lebar terjauh gambar
      var maxCy = Math.max(holeCnFy, 1 - holeCnFy);  // setengah-tinggi terjauh gambar
      var scale = Math.min(
        // (a) lubang muat di window
        (cw * MARGIN_HOLE) / (imgW * holeW),
        (ch * MARGIN_HOLE) / (imgH * holeH),
        // (b) gambar penuh muat walau sudah digeser agar lubang center
        (cw * MARGIN_IMG) / (2 * maxCx * imgW),
        (ch * MARGIN_IMG) / (2 * maxCy * imgH)
      );
      var bw = imgW * scale;
      var bh = imgH * scale;

      // Posisi gambar: geser supaya pusat LUBANG jatuh tepat di pusat window.
      var bx = cw / 2 - holeCnFx * bw;
      var by = ch / 2 - holeCnFy * bh;

      bimg.style.left = Math.round(bx) + "px";
      bimg.style.top = Math.round(by) + "px";
      bimg.style.width = Math.round(bw) + "px";
      bimg.style.height = Math.round(bh) + "px";

      // Layar = area lubang, relatif ke gambar.
      screen.style.left = Math.round(bx + hole.left * bw) + "px";
      screen.style.top = Math.round(by + hole.top * bh) + "px";
      screen.style.width = Math.round(holeW * bw) + "px";
      screen.style.height = Math.round(holeH * bh) + "px";

      return { sw: Math.round(holeW * bw), sh: Math.round(holeH * bh) };
    }

    layout();

    // Re-layout saat window berubah ? layar tetap presisi di tengah bezel.
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(layout).observe(el);
    }
    el._crtLayout = layout;
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
    // Efek CRT dipasang SEBELUM fit() � `fit()` mengukur layer layar (yang baru
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
      // Amati NODE XTERM (el) � bukan layer layar. Bezel & layar di-hitung
      // ulang oleh applyCrtFx() (yang punya ResizeObserver sendiri), jadi
      // mengamati el memberi reaksi pada resize window yang sebenarnya.
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
