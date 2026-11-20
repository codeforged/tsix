/* ============================================================
 * DOME Client — DDC (Direct Draw and Control)
 * ============================================================
 * Widget <ddc> — aplikasi Native JavaScript (NJ) di dalam window TSIX.
 * Animasi berjalan 100% di browser (zero WebSocket per-frame),
 * komunikasi tetap lewat mekanisme PixelSpace.
 *
 *   TGA (Worker) ──DDC_MSG──► DOME ──► Browser: NJ.onMessage()
 *   NJ (Browser)  ──ddc_event──► DOME ──► TGA: DDCApp.on()
 *
 * Keamanan "hak gambar":
 *   - NJ di-mount dalam Shadow DOM → id/class aman dari app lain.
 *   - Container overflow:hidden + canvas sebesar window → NJ secara
 *     fisik tidak bisa menggambar keluar area window-nya.
 *   - NJ hanya mendapat object ctx terbatas (canvas, raf, send, ...),
 *     bukan window/document penuh.
 *
 * Fabric.js (MIT) dimuat via CDN di dome-client.html — tersedia
 * sebagai ctx.fabric.
 *
 * Inbound (dari app via relay dome.ts):
 *   DDC_MSG    { wid, targetId, data }
 *   DDC_RESIZE { wid, targetId, width, height }
 *   DDC_STOP   { wid, targetId }
 *
 * Outbound (ke app, via forward GUI_EVENT generik di dome.ts):
 *   ddc_event (value=JSON) — pesan dari NJ
 *   ddc_mouse (value=JSON) — mousedown/mouseup/click/dblclick
 *   ddc_key   (value=JSON) — keydown
 */
(function () {
  "use strict";
  const TSIX = window.TSIX;

  // Runtime per (wid, nodeId)
  const _ddc = {};

  function keyOf(wid, id) {
    return wid + "_" + id;
  }

  // Tunggu Fabric.js selesai dimuat dari CDN (max ~15 detik).
  function waitForFabric(cb, retries) {
    retries = retries || 60;
    if (typeof fabric !== "undefined") return cb(window.fabric);
    if (retries <= 0) return cb(null);
    setTimeout(function () {
      waitForFabric(cb, retries - 1);
    }, 250);
  }

  // --- Inisialisasi runtime DDC dalam elemen host ---
  function initDDC(el, wid, props) {
    const nodeId = el.getAttribute("data-tsix-id");
    const key = keyOf(wid, nodeId);
    if (_ddc[key]) return; // sudah init

    props = props || {};
    const dpr = window.devicePixelRatio || 1;

    console.log(
      "[DDC] initDDC", nodeId, "size=" +
      (props.width || el.clientWidth || 300) + "x" + (props.height || el.clientHeight || 200)
    );

    // Shadow DOM: isolasi style & id dari window/app lain
    const shadow = el.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = [
      ":host { display:block; width:100%; height:100%; }",
      ".ddc-stage { position:absolute; inset:0; overflow:hidden; }",
      "canvas { display:block; }",
    ].join("\n");
    shadow.appendChild(style);

    const stage = document.createElement("div");
    stage.className = "ddc-stage";
    shadow.appendChild(stage);

    const canvas = document.createElement("canvas");
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    stage.appendChild(canvas);

    let width = props.width || el.clientWidth || 300;
    let height = props.height || el.clientHeight || 200;
    let rafId = 0;
    let stopped = false;
    let njInit = null;
    let njOnMessage = null;
    let njOnResize = null;
    let njOnDestroy = null;
    let njOnKey = null;
    let njCtx = null;

    // Koordinat = logical px (CSS px). Raw canvas apps bisa baca ctx.dpr
    // untuk handling retina manual. Fabric default enableRetinaScaling
    // sudah otomatis crisp & memakai koordinat CSS px.
    function setCanvasSize(w, h) {
      width = Math.max(1, Math.round(w));
      height = Math.max(1, Math.round(h));
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = width + "px";
      canvas.style.height = height + "px";
    }
    setCanvasSize(width, height);

    // --- NJ Context: API terbatas (hak gambar + komunikasi saja) ---
    function makeCtx(fabricLib) {
      return {
        // Hak gambar (dalam window ini saja)
        canvas: canvas,
        width: width,
        height: height,
        dpr: dpr,
        fabric: fabricLib || undefined,
        // ResourceBank — ambil resource yang sudah di-load TGA (RES_LOAD)
        // dipakai NJ: ctx.resBank.getResource("SFX-Laser") / "TEXTURE-player1"
        resBank:
          typeof TSIX.makeResBank === "function"
            ? TSIX.makeResBank(wid)
            : undefined,
        now: function () {
          return performance.now();
        },
        raf: function (cb) {
          rafId = requestAnimationFrame(cb);
        },

        // Komunikasi → TGA (lewat PixelSpace, sparse — jangan per-frame)
        send: function (data) {
          TSIX.send({
            wid: wid,
            targetId: nodeId,
            eventType: "ddc_event",
            value: JSON.stringify(data),
          });
        },

        // ← dari TGA (DDC_MSG)
        get onMessage() {
          return njOnMessage;
        },
        set onMessage(fn) {
          njOnMessage = fn;
        },
        // saat ukuran canvas berubah (DDC_RESIZE atau auto window resize)
        get onResize() {
          return njOnResize;
        },
        set onResize(fn) {
          njOnResize = fn;
        },
        // saat DDC di-stop/destroy
        get onDestroy() {
          return njOnDestroy;
        },
        set onDestroy(fn) {
          njOnDestroy = fn;
        },
        // keyboard langsung di browser (game zero-WS) — tetap di-forward ke TGA
        get onKey() {
          return njOnKey;
        },
        set onKey(fn) {
          njOnKey = fn;
        },
      };
    }

    function startNJ(fabricLib) {
      if (stopped || njInit === null) {
        console.warn("[DDC] startNJ skip: stopped=" + stopped + " njInit=" + !!njInit, nodeId);
        return;
      }
      njCtx = makeCtx(fabricLib);
      try {
        njInit(njCtx);
        console.log("[DDC] NJ started", nodeId, fabricLib ? "(fabric)" : "(no fabric)");
      } catch (e) {
        console.error("[DDC] NJ init error:", e);
        stage.innerHTML = "";
        const t = document.createElement("div");
        t.textContent =
          "❌ DDC init error: " + (e && e.message ? e.message : String(e));
        t.style.cssText = "color:#f44336;font:12px monospace;padding:8px;";
        stage.appendChild(t);
      }
    }

    // Evaluasi source NJ. new Function("DDC", src) → body memakai DDC.onInit(fn).
    // Konteks global (bukan sandbox JS penuh) — tapi Shadow DOM mengisolasi
    // style/DOM. Trust model sama seperti xterm/codemirror: dipercaya, dibatasi API.
    const source = props.source || props.src || "";
    if (source) {
      try {
        // Bangun object DDC yang dilempar ke NJ. DDC.FrameBuffer tersedia
        // OTOMATIS bila library @tsix/framebuffer sudah di-inject sebagai
        // global window.FrameBuffer (mis. TGA prepend /lib/framebuffer.js
        // ke source NJ — lihat ddc-sample9). Jadi NJ bisa:
        //   var fb = new DDC.FrameBuffer(c2, W, H, { scale: 2 });
        // tanpa import. NJ lama yang tidak memakai framebuffer TIDAK
        // terpengaruh (FrameBuffer hanya ditambahkan jika window punya).
        const ddcApi = {
          onInit: function (fn) {
            njInit = fn;
          },
        };
        if (typeof window !== "undefined" && typeof window.FrameBuffer === "function") {
          ddcApi.FrameBuffer = window.FrameBuffer;
        }
        const factory = new Function("DDC", source);
        factory(ddcApi);
      } catch (e) {
        console.error("[DDC] NJ parse error:", e);
      }
    } else {
      const t = document.createElement("div");
      t.textContent = "⏳ DDC (empty source)";
      t.style.cssText = "color:#888;font:12px monospace;padding:8px;";
      stage.appendChild(t);
    }

    // Tunggu Fabric hanya jika NJ memakainya. App canvas murni
    // langsung start (tidak perlu nunggu CDN).
    const needsFabric = /\bfabric\b|\bctx\.fabric\b/.test(source);
    if (needsFabric) {
      waitForFabric(function (fabricLib) {
        startNJ(fabricLib);
      });
    } else {
      startNJ(undefined);
    }

    // --- Forward mouse/keyboard ke TGA (mekanisme PixelSpace) ---
    const sendMouse = function (type, ev) {
      const rect = canvas.getBoundingClientRect();
      TSIX.send({
        wid: wid,
        targetId: nodeId,
        eventType: "ddc_mouse",
        value: JSON.stringify({
          type: type,
          x: Math.round(ev.clientX - rect.left),
          y: Math.round(ev.clientY - rect.top),
          button: ev.button,
        }),
      });
    };
    ["mousedown", "mouseup", "click", "dblclick"].forEach(function (t) {
      canvas.addEventListener(t, function (ev) {
        sendMouse(t, ev);
      });
    });
    // Keyboard: dispatch ke NJ lokal (game, zero-WS) DAN forward ke TGA (PixelSpace).
    // keyup disertakan agar NJ bisa tracking tombol ditahan (held-state).
    const dispatchKey = function (ev, down) {
      const payload = {
        key: ev.key,
        code: ev.code,
        ctrl: ev.ctrlKey,
        shift: ev.shiftKey,
        alt: ev.altKey,
        down: down,
        repeat: !!ev.repeat,
      };
      // NJ lokal dulu (reaksi cepat, tanpa round-trip)
      if (njOnKey) {
        try {
          njOnKey(payload);
        } catch (e) {
          console.error("[DDC] onKey error:", e);
        }
      }
      // Forward ke TGA via PixelSpace
      TSIX.send({
        wid: wid,
        targetId: nodeId,
        eventType: "ddc_key",
        value: JSON.stringify(payload),
      });
    };
    canvas.tabIndex = 0;
    canvas.style.outline = "none";
    canvas.addEventListener("keydown", function (ev) {
      // Cegah scroll halaman untuk tombol game (panah & spasi)
      if (
        ev.key === "ArrowLeft" || ev.key === "ArrowRight" ||
        ev.key === "ArrowUp" || ev.key === "ArrowDown" || ev.key === " "
      ) {
        ev.preventDefault();
      }
      dispatchKey(ev, true);
    });
    canvas.addEventListener("keyup", function (ev) {
      dispatchKey(ev, false);
    });
    canvas.addEventListener("mousedown", function () {
      canvas.focus();
    });

    // Auto-fokus agar game langsung bisa main (panah/spasi) tanpa klik dulu
    setTimeout(function () {
      if (!stopped) canvas.focus();
    }, 300);

    // Fokus ulang: klik di mana pun DALAM window app ini → canvas tetap
    // menerima keyboard. Kecuali klik di input/drag-handle, dan TIDAK mencuri
    // fokus dari window/desktop lain (listener di-scope ke content window ini).
    const winEntry = TSIX.state.windows.get(wid);
    const winHost = winEntry ? winEntry.content : null;
    if (winHost) {
      winHost.addEventListener("mousedown", function (ev) {
        const t = ev.target;
        if (!t) return;
        // Elemen yang butuh fokus/gerakan sendiri: input teks, dropdown,
        // drag-handle splitter, resize kolom — jangan diganggu.
        if (
          t.closest &&
          t.closest(
            "input, textarea, select, [data-splitter], [data-col-resize]"
          )
        ) {
          return;
        }

        // Tombol & elemen klik lain (button, data-tsix-onclick): biarkan
        // click-nya jalan dulu, LALU fokus balik ke canvas. Fix: klik
        // "New Game" → spasi berikutnya masuk ke game, bukan re-click tombol.
        const isClickable = t.closest
          ? !!t.closest("button, [data-tsix-onclick]")
          : false;
        if (isClickable) {
          setTimeout(function () {
            if (!stopped) canvas.focus();
          }, 0);
          return;
        }

        // Area non-interaktif (label, ruang kosong): fokus langsung +
        // cegah default mousedown yang MENGAMBIL fokus ke body.
        ev.preventDefault();
        canvas.focus();
      });
    }

    const runtime = {
      ctxResize: function (w, h) {
        setCanvasSize(w, h);
        if (njCtx) {
          njCtx.width = width;
          njCtx.height = height;
        }
        if (njOnResize) {
          try {
            njOnResize(width, height);
          } catch (e) {
            console.error("[DDC] onResize error:", e);
          }
        }
      },
      msg: function (data) {
        if (!njOnMessage) return;
        let parsed = data;
        if (typeof data === "string") {
          try {
            parsed = JSON.parse(data);
          } catch (_) {
            /* bukan JSON — kirim string apa adanya */
          }
        }
        try {
          njOnMessage(parsed);
        } catch (e) {
          console.error("[DDC] onMessage error:", e);
        }
      },
      stop: function () {
        if (stopped) return;
        stopped = true;
        if (rafId) cancelAnimationFrame(rafId);
        if (njOnDestroy) {
          try {
            njOnDestroy();
          } catch (e) {
            /* ignore */
          }
        }
        njInit = null;
        njOnMessage = null;
        njOnResize = null;
        njOnDestroy = null;
        njOnKey = null;
        njCtx = null;
      },
    };
    _ddc[key] = runtime;

    // Auto-resize: ikuti ukuran container (window resize, splitter, dll)
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(function (entries) {
        for (const entry of entries) {
          const w = entry.contentRect.width;
          const h = entry.contentRect.height;
          if (w > 0 && h > 0) {
            const r = _ddc[key];
            if (r) r.ctxResize(w, h);
          }
        }
      }).observe(el);
    }
  }

  // --- Inbound handlers (dari app via dome.ts relay) ---
  function handleDDCMsg(msg) {
    const r = _ddc[keyOf(msg.wid, msg.targetId)];
    if (r) r.msg(msg.data);
  }
  function handleDDCResize(msg) {
    const r = _ddc[keyOf(msg.wid, msg.targetId)];
    if (r && msg.width && msg.height) r.ctxResize(msg.width, msg.height);
  }
  function handleDDCStop(msg) {
    const r = _ddc[keyOf(msg.wid, msg.targetId)];
    if (r) r.stop();
    delete _ddc[keyOf(msg.wid, msg.targetId)];
  }

  // Hentikan & bersihkan SEMUA runtime DDC milik satu window (safety net —
  // dipanggil saat window di-destroy supaya RAF loop NJ tidak bocor, meskipun
  // app lupa memanggil DDCApp.destroy()).
  function destroyDDCByWid(wid) {
    const prefix = wid + "_";
    Object.keys(_ddc).forEach(function (key) {
      if (key.indexOf(prefix) === 0) {
        var r = _ddc[key];
        if (r) {
          try {
            r.stop();
          } catch (_) { }
        }
        delete _ddc[key];
      }
    });
  }

  TSIX.register("DDC_MSG", handleDDCMsg);
  TSIX.register("DDC_RESIZE", handleDDCResize);
  TSIX.register("DDC_STOP", handleDDCStop);
  TSIX.initDDC = initDDC;
  TSIX.destroyDDCByWid = destroyDDCByWid;
})();
