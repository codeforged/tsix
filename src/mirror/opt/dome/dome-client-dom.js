/* ============================================================
 * DOME Client — DOM Engine (buildDOM) + Node Lifecycle
 * ============================================================
 * - buildDOM(): konversi node tree dari DOME server → DOM nyata,
 *   termasuk widget khusus (xterm, codemirror), splitter & column-resizer.
 * - Inbound: MOUNT_NODE, UNMOUNT_NODE, UPDATE_PROPS
 */
(function () {
  "use strict";
  const TSIX = window.TSIX;
  const S = TSIX.state;

  let _tsixScrollbarW = null;
  function tsixScrollbarWidth() {
    if (_tsixScrollbarW !== null) return _tsixScrollbarW;
    const probe = document.createElement("div");
    probe.style.cssText =
      "width:100px;height:100px;overflow:scroll;position:absolute;visibility:hidden;";
    document.body.appendChild(probe);
    _tsixScrollbarW = probe.offsetWidth - probe.clientWidth;
    document.body.removeChild(probe);
    return _tsixScrollbarW;
  }

  // Pasang listener HANYA SEKALI per elemen per event type (lacak via el.__tsixL).
  // Alasan: handleUpdateProps kadang menerima beberapa listener props sekaligus
  // (mis. onInputId + onKeydownId di field password login asteracea). Pendekatan
  // lama yang cloneNode elemen untuk "membersihkan listener lama" justru MENGHAPUS
  // listener yang baru dipasang di props sebelumnya (cloneNode tidak menyalin
  // listener) → mengetik di field password tidak terkirim → login selalu gagal
  // padahal password benar. Dengan ensureListener, listener tidak dobel & tidak hilang.
  function ensureListener(el, event, listener) {
    if (!el.__tsixL) el.__tsixL = Object.create(null);
    if (!el.__tsixL[event]) {
      el.addEventListener(event, listener);
      el.__tsixL[event] = true;
    }
  }

  function buildDOM(node, wid) {
    if (!node) return null;

    let el;

    // Special: xterm.js terminal
    if (node.tag === "xterm") {
      el = document.createElement("div");
      el.setAttribute("data-tsix-id", node.id);
      el.style.width = "100%";
      el.style.height = "100%";
      el.style.minHeight = "300px";
      // Jangan set resize:"both" — itu bikin grip resize sendiri di pojok kanan
      // bawah. Resize xterm harus ngikut window saja (via ResizeObserver fit).
      el.style.overflow = "hidden";
      el._xtermNodeId = node.id;
      el._xtermWid = wid;
      // Init xterm dengan theme dari props
      setTimeout(() => TSIX.initXterm(el, node.props?.termTheme), 100);
      return el;
    }

    // Special: CodeMirror editor
    if (node.tag === "codemirror") {
      el = document.createElement("div");
      el.setAttribute("data-tsix-id", node.id);
      el.style.width = "100%";
      el.style.height = "100%";
      el.style.minHeight = "200px";
      el.style.overflow = "hidden";
      el.style.flex = "1"; // fill flex parent
      setTimeout(() => {
        if (typeof CodeMirror === "undefined") return;
        const cm = CodeMirror(el, {
          value: node.props?.value || "",
          mode: node.props?.mode || "javascript",
          theme: node.props?.theme || "dracula",
          lineNumbers: true,
          autofocus: true,
          tabSize: 2,
        });
        cm.on("change", () => {
          TSIX.send({
            wid: wid,
            targetId: node.id,
            eventType: "cm_change",
            value: cm.getValue(),
          });
        });
        el._codemirror = cm;

        // Extra keyboard shortcuts
        cm.setOption("extraKeys", {
          "Ctrl-S": function () {
            TSIX.send({
              wid: wid,
              targetId: node.id,
              eventType: "cm_save",
              value: cm.getValue(),
            });
          },
          "Ctrl-H": "replace",
          "Ctrl-L": "findNext",
        });

        // Auto-refresh on container resize
        if (typeof ResizeObserver !== "undefined") {
          new ResizeObserver(() => {
            cm.refresh();
          }).observe(el);
        }
      }, 100);
      return el;
    }

    // Special: DDC (Direct Draw and Control) — native JS animation widget.
    // NJ (source di props) di-mount dalam Shadow DOM oleh dome-client-ddc.js.
    if (node.tag === "ddc") {
      el = document.createElement("div");
      el.setAttribute("data-tsix-id", node.id);
      el.style.width = "100%";
      el.style.height = "100%";
      el.style.minHeight = "120px";
      el.style.position = "relative"; // anchor untuk .ddc-stage (absolute)
      el.style.overflow = "hidden";
      el._ddcNodeId = node.id;
      el._ddcWid = wid;
      setTimeout(() => TSIX.initDDC(el, wid, node.props), 100);
      return el;
    }

    // Special: Tabulator data grid widget (ConnectedTabulator).
    // Library Tabulator di-load di dome-client.html; inisialisasi dilakukan
    // oleh dome-client-tabulator.js. Tag ini menandakan DOME bahwa elemen
    // adalah container grid — bukan DOM biasa.
    if (node.tag === "tabulator") {
      el = document.createElement("div");
      el.setAttribute("data-tsix-id", node.id);
      el.style.width = "100%";
      el.style.height = "100%";
      el.style.minHeight = "120px";
      el.style.overflow = "hidden";
      el._tabNodeId = node.id;
      el._tabWid = wid;
      setTimeout(() => TSIX.initTabulator(el, wid, node.props || {}), 100);
      return el;
    }

    if (node.tag === "text") {
      el = document.createTextNode(node.props?.text || "");
    } else {
      el = document.createElement(node.tag);
      el.setAttribute("data-tsix-id", node.id);

      // Apply props
      const props = node.props || {};
      for (const [key, value] of Object.entries(props)) {
        if (key === "text") {
          el.textContent = value;
        } else if (key === "innerHTML") {
          el.innerHTML = value;
        } else if (key === "style" && typeof value === "object") {
          Object.assign(el.style, value);
        } else if (key === "className") {
          el.className = value;
        } else if (key === "disabled") {
          if (value) el.setAttribute("disabled", "");
          else el.removeAttribute("disabled");
        } else if (key === "onClickId") {
          // Register click → send event back to gued
          // Cursor via CSS attribute (data-tsix-onclick), BUKAN inline —
          // biar inline cursor dari app (mis. arrow taskbar) tetap menang.
          el.setAttribute("data-tsix-onclick", "1");
          ensureListener(el, "click", (e) => {
            e.stopPropagation();
            TSIX.send({
              wid: wid,
              targetId: node.id,
              eventType: "click",
            });
          });
        } else if (key === "onContextMenuId") {
          el.style.cursor = "context-menu";
          el.setAttribute("oncontextmenu", "return false;");
          ensureListener(el, "contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            TSIX.send({
              wid: wid,
              targetId: node.id,
              eventType: "contextmenu",
              value: JSON.stringify({ x: e.clientX, y: e.clientY }),
            });
          });
        } else if (key === "onInputId") {
          ensureListener(el, "input", (e) => {
            TSIX.send({
              wid: wid,
              targetId: node.id,
              eventType: "input",
              value: e.target.value,
            });
          });
        } else if (key === "onKeydownId") {
          ensureListener(el, "keydown", (e) => {
            // Prevent Tab from moving focus — apps handle Tab themselves
            if (e.key === "Tab") e.preventDefault();
            TSIX.send({
              wid: wid,
              targetId: node.id,
              eventType: "keydown",
              value: e.key,
            });
          });
        } else if (key === "onKbId") {
          // Keyboard capture (komponen Keyboard): elemen penangkap = penanda
          // + pengelola fokus saja. Event keyboard ditangkap di LEVEL DOCUMENT
          // (listener keydown/keyup global di bawah) — lebih andal, tak
          // bergantung fokus elemen ini secara ketat.
          el.setAttribute("tabindex", "-1");
          keyboardCaptureByWid[wid] = node.id;
          keyboardCaptureFocus(wid);
          setTimeout(function () {
            keyboardCaptureFocus(wid);
          }, 300);
        } else if (
          key === "placeholder" ||
          key === "type" ||
          key === "href" ||
          key === "src" ||
          key === "alt" ||
          key === "title" ||
          key === "width" ||
          key === "height" ||
          key === "rows" ||
          key === "cols" ||
          key === "autofocus" ||
          key.startsWith("data-")
        ) {
          // title set sebagai data-tt (custom tooltip, bukan native)
          if (key === "title") {
            el.setAttribute("data-tt", String(value));
          } else {
            el.setAttribute(key, String(value));
          }
        } else if (key === "selected") {
          // Set .selected property so <option> shows the right entry
          el.selected = !!value;
        } else if (key === "value") {
          // Set .value property (not attribute) so input fields update live
          el.value = value;
        }
      }
    }

    // Recurse children — overlay roots are extracted to global overlay layer
    // so they render above ALL windows (fullscreen windows are locked at z-index 1).
    if (node.children && Array.isArray(node.children)) {
      for (const child of node.children) {
        const childEl = buildDOM(child, wid);
        if (!childEl) continue;

        // Overlay roots: specific elements that must render above ALL windows.
        // Only extract by ID — children inside an overlay root must stay with their parent.
        // (z-index check is in handleMountNode for dynamically-mounted overlays, not here.)
        // - launcher-overlay: modal launcher
        // - taskbar-wrapper:  taskbar Asteracea — ALWAYS ON TOP, tanpa ini kalah sama window app
        if (
          child.id === "launcher-overlay" ||
          child.id === "taskbar-wrapper"
        ) {
          const overlay = document.getElementById("__tsix_overlay_layer__");
          if (overlay) {
            if (child.id === "launcher-overlay") {
              // Fill the entire viewport so flex centering works
              childEl.style.position = "fixed";
              childEl.style.top = "0";
              childEl.style.right = "0";
              childEl.style.bottom = "0";
              childEl.style.left = "0";
            }
            overlay.appendChild(childEl);
          }
          continue; // Don't append to parent window
        }

        el.appendChild(childEl);
      }
    }

    // === SPLITTER: draggable divider (hanya untuk element nodes) ===
    const splitterDir = el.getAttribute?.("data-splitter");
    if (splitterDir === "h" || splitterDir === "v") {
      el.style.cursor = splitterDir === "h" ? "col-resize" : "row-resize";
      el.style.userSelect = "none";
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const parent = el.parentElement;
        if (!parent) return;
        const prev = el.previousElementSibling;
        const next = el.nextElementSibling;
        if (!prev || !next) return;
        const isH = splitterDir === "h";
        const startPos = isH ? e.clientX : e.clientY;
        const prevSize = isH ? prev.offsetWidth : prev.offsetHeight;
        const parentSize = isH ? parent.offsetWidth : parent.offsetHeight;
        if (parentSize <= 0) return;
        const totalSize = parentSize;

        const onMove = (ev) => {
          const delta = (isH ? ev.clientX : ev.clientY) - startPos;
          const pct = ((prevSize + delta) / totalSize) * 100;
          if (pct > 15 && pct < 85) {
            if (isH) {
              prev.style.flex = "none";
              prev.style.width = pct + "%";
              next.style.flex = "none";
              next.style.width = 100 - pct + "%";
            } else {
              prev.style.flex = "none";
              prev.style.height = pct + "%";
              next.style.flex = "none";
              next.style.height = 100 - pct + "%";
            }
          }
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    }

    // === COLUMN RESIZER: drag tepi header th untuk resize kolom ===
    // Dipicu elemen bertanda data-col-resize="1" (handle di dalam th).
    // Sesuaikan lebar <col> di colgroup — native di browser, tanpa event relay ke app.
    if (el.getAttribute?.("data-col-resize") === "1") {
      el.style.cursor = "col-resize";
      el.style.userSelect = "none";
      // Klik pada handle jangan diteruskan ke th (biar tidak trigger sort)
      el.addEventListener("click", (e) => e.stopPropagation());
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const th = el.closest("th");
        if (!th) return;
        const tr = th.parentElement;
        if (!tr) return;
        const colIdx = Array.prototype.indexOf.call(tr.children, th);
        const table = th.closest("table");
        if (!table) return;
        const colgroup = table.querySelector("colgroup");
        if (!colgroup) return;
        const col = colgroup.children[colIdx];
        if (!col) return;
        const startX = e.clientX;
        const startW = col.offsetWidth || th.offsetWidth || 100;
        let lastW = startW;
        const onMove = (ev) => {
          const newW = Math.max(60, startW + (ev.clientX - startX));
          lastW = newW;
          col.style.width = newW + "px";
          // Sinkronkan ke semua colgroup di grid (header + body) biar kolom tetap sejajar
          const key = col.getAttribute("data-col-key");
          if (key) {
            // Scope harus wrapper grid (.tsix-dgrid), BUKAN table.parentElement —
            // biar colgroup body (data row) ikut tersinkron saat drag resize.
            const wrap = table.closest(".tsix-dgrid") || table.parentElement;
            if (wrap) {
              wrap
                .querySelectorAll('col[data-col-key="' + CSS.escape(key) + '"]')
                .forEach((c) => {
                  c.style.width = newW + "px";
                });
            }
          }
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          // Kabari app (ConnectedDataGrid): lebar kolom berubah → app simpan &
          // re-apply saat render ulang. Ini yang bikin lebar hasil drag TETAP
          // (tidak "melebar"/reset sendiri) sampai user drag lagi.
          // Scope wrap = wrapper grid (.tsix-dgrid) — targetId harus id grid
          // biar handler col_resized di app kepanggil.
          const key = col.getAttribute("data-col-key");
          const wrap = table.closest(".tsix-dgrid") || table.parentElement;
          if (key && wrap) {
            const wrapId = wrap.getAttribute("data-tsix-id");
            if (wrapId) {
              TSIX.send({
                wid: wid,
                targetId: wrapId,
                eventType: "col_resized",
                value: JSON.stringify({ key, width: lastW }),
              });
            }
          }
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    }

    // DataGrid (tsix-dgrid): header & body kini dalam SATU scroll container
    // (body-scroll) dengan th sticky — scroll horizontal & lebar kolom otomatis
    // sinkron, tidak perlu kompensasi/relay manual.

    return el;
  } // end buildDOM

  // --- ACTION HANDLERS: Node lifecycle ---

  function handleMountNode(msg) {
    const { wid, node, targetId } = msg;
    const win = S.windows.get(wid);
    if (!win) return;

    const domEl = buildDOM(node, wid);
    if (!domEl) return;

    // Special: "start-menu" must always render above application windows.
    if (node.id === "start-menu") {
      const old = document.getElementById("__global_start_menu__");
      if (old) old.remove();
      domEl.id = "__global_start_menu__";
      domEl.setAttribute("data-tsix-id", node.id);
      domEl.style.position = "fixed";
      domEl.style.zIndex = "9999999999";
      domEl.style.pointerEvents = "auto";
      domEl.style.left = domEl.style.left || "15%";
      domEl.style.top = domEl.style.top || "10%";
      domEl.style.transformOrigin = "top left";
      document.body.appendChild(domEl);
      return;
    }

    // Special: overlay elements (launcher, taskbar, modals, etc.)
    // Must render above ALL windows — fullscreen windows are locked at z-index 1,
    // so overlay children would be buried under regular app windows otherwise.
    const isOverlayRoot =
      node.id === "launcher-overlay" || node.id === "taskbar-wrapper";
    const isOverlayChild =
      targetId === "launcher-overlay" || targetId === "taskbar-wrapper";

    if (isOverlayRoot || isOverlayChild) {
      const container = document.getElementById("__tsix_overlay_layer__");
      if (container) {
        if (isOverlayRoot && node.id === "launcher-overlay") {
          // The overlay root fills the entire viewport
          domEl.style.position = "fixed";
          domEl.style.inset = "0";
        }
        container.appendChild(domEl);
        return;
      }
    }

    if (targetId) {
      const parent = TSIX.findElementById(wid, targetId);
      if (parent) {
        parent.appendChild(domEl);
      } else {
        // Parent not found — discard (jangan fallback ke win.content)
      }
    } else {
      win.content.appendChild(domEl);
    }
  }

  function handleUnmountNode(msg) {
    const { wid, targetId } = msg;
    if (!targetId) return;
    const el = TSIX.findElementById(wid, targetId);
    if (el) el.remove();
  }

  function handleUpdateProps(msg) {
    const { wid, targetId, props } = msg;
    if (!targetId || !props) return;
    let el = TSIX.findElementById(wid, targetId);
    if (!el) return;

    for (const [key, value] of Object.entries(props)) {
      if (key === "text") {
        el.textContent = value;
      } else if (key === "innerHTML") {
        el.innerHTML = value;
      } else if (key === "style" && typeof value === "object") {
        Object.assign(el.style, value);
      } else if (key === "disabled") {
        if (value) el.setAttribute("disabled", "");
        else el.removeAttribute("disabled");
      } else if (key === "className") {
        el.className = value;
      } else if (key === "onClickId") {
        // ensureListener: pasang sekali, TIDAK cloneNode. Clone justru menghapus
        // listener yang baru dipasang di props lain dalam batch yang sama (mis.
        // onInputId + onKeydownId di field password) → lihat komentar helper.
        el.setAttribute("data-tsix-onclick", "1");
        ensureListener(el, "click", (e) => {
          e.stopPropagation();
          TSIX.send({
            wid: wid,
            targetId: targetId,
            eventType: "click",
          });
        });
      } else if (key === "onContextMenuId") {
        el.style.cursor = "context-menu";
        el.setAttribute("oncontextmenu", "return false;");
        ensureListener(el, "contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          TSIX.send({
            wid: wid,
            targetId: targetId,
            eventType: "contextmenu",
            value: JSON.stringify({ x: e.clientX, y: e.clientY }),
          });
        });
      } else if (key === "onInputId") {
        ensureListener(el, "input", (e) => {
          TSIX.send({
            wid: wid,
            targetId: targetId,
            eventType: "input",
            value: e.target.value,
          });
        });
      } else if (key === "onKeydownId") {
        ensureListener(el, "keydown", (e) => {
          // Prevent Tab from moving focus — apps handle Tab themselves
          if (e.key === "Tab") e.preventDefault();
          TSIX.send({
            wid: wid,
            targetId: targetId,
            eventType: "keydown",
            value: e.key,
          });
        });
      } else if (key === "onKbId") {
        // Keyboard capture: penanda + pengelola fokus (lihat komentar mount).
        el.setAttribute("tabindex", "-1");
        keyboardCaptureByWid[wid] = targetId;
        keyboardCaptureFocus(wid);
      } else if (key === "value") {
        // Set .value property (not attribute) so input fields update live
        el.value = value;
      } else if (key === "scrollTop") {
        el.scrollTop = parseInt(value) || 0;
      } else if (key === "scrollLeft") {
        el.scrollLeft = parseInt(value) || 0;
      } else {
        el.setAttribute(key, String(value));
      }
    }
  }

  TSIX.register("MOUNT_NODE", handleMountNode);
  TSIX.register("UNMOUNT_NODE", handleUnmountNode);
  TSIX.register("UPDATE_PROPS", handleUpdateProps);

  // ── Keyboard capture global (pola DDC) ──
  // App (komponen Keyboard) daftarkan elemen penangkap per-window. DOME
  // lalu mengelola fokus otomatis: fokus saat attach, dan refokus saat
  // user klik di mana pun DALAM window tsb (kecuali di input teks) —
  // jadi panah/spasi langsung kedengaran selama window aktif.
  const keyboardCaptureByWid = {};

  function keyboardCaptureFocus(wid) {
    const targetId = keyboardCaptureByWid[wid];
    if (!targetId) return;
    const el = TSIX.findElementById(wid, targetId);
    if (el && typeof el.focus === "function" && document.activeElement !== el) {
      el.focus();
    }
  }

  TSIX.register("KEYBOARD_ATTACH", function (msg) {
    keyboardCaptureByWid[msg.wid] = msg.targetId;
    keyboardCaptureFocus(msg.wid);
  });
  TSIX.register("KEYBOARD_DETACH", function (msg) {
    delete keyboardCaptureByWid[msg.wid];
  });

  // ── Refokus saat klik di dalam window (pola DDC) ──
  // Klik di area NON-interaktif window → preventDefault agar browser TIDAK
  // memindahkan fokus ke <body> (yang ada di luar .tsix-window), lalu
  // fokuskan elemen penangkap. Tanpa preventDefault, browser selalu menarik
  // fokus ke body pada mousedown → keyboard langsung "cuek" setelah body
  // diklik. Klik di input/textarea/select/tombol dibiarkan (fokus natural),
  // tapi untuk tombol fokus dikembalikan ke penangkap setelah click-nya
  // sempat jalan (agar spasi/Enter tidak "menekan ulang" tombol).
  document.addEventListener("mousedown", function (e) {
    const t = e.target;
    if (!t || typeof t.closest !== "function") return;
    // Elemen yang butuh fokus sendiri: jangan diganggu.
    if (t.closest("input, textarea, select, [contenteditable='true']")) return;
    const winEl = t.closest(".tsix-window");
    if (!winEl) return;
    const id = winEl.id || "";
    if (id.indexOf("win-") !== 0) return;
    const wid = id.slice(4);
    if (!keyboardCaptureByWid[wid]) return;

    // Tombol & elemen klik lain: biarkan click-nya jalan, LALU refokus.
    // (Pola yang sama dipakai DDC canvas.)
    const isClickable = !!t.closest("button, [data-tsix-onclick], select");
    if (isClickable) {
      setTimeout(function () {
        keyboardCaptureFocus(wid);
      }, 0);
      return;
    }

    // Area non-interaktif (label, ruang kosong window): cegah default
    // mousedown yang MENGAMBIL fokus ke body, lalu fokus penangkap.
    e.preventDefault();
    keyboardCaptureFocus(wid);
  });

  // ── Keyboard global di LEVEL DOCUMENT ──
  // Event diteruskan ke app selama fokus berada DI DALAM window yang punya
  // keyboard capture (dan bukan di input teks). Ini jauh lebih andal daripada
  // bergantung fokus elemen penangkap — cukup klik di dalam window (refokus)
  // atau auto-fokus saat mount sudah cukup.
  function kbDocSend(e, down) {
    const t = e.target;
    if (!t || typeof t.closest !== "function") return;
    // Jangan mencuri ketikan yang memang milik input teks (password, memo, dll).
    if (t.closest("input, textarea, select, [contenteditable='true']")) return;
    // Fallback: kalau target di luar window (mis. <body> karena klik body
    // sebelum sempat refokus), tetap arahkan ke window yang sedang FOCUS
    // (teratas) yang punya keyboard capture. Ini bikin keyboard tetap jalan
    // walau fokus sempat "nyasar" ke body.
    let winEl = t.closest(".tsix-window");
    let wid = null;
    if (winEl) {
      const id = winEl.id || "";
      if (id.indexOf("win-") === 0) wid = id.slice(4);
    }
    if (!wid && S.focusedWid && keyboardCaptureByWid[S.focusedWid]) {
      wid = S.focusedWid;
    }
    if (!wid) return;
    const targetId = keyboardCaptureByWid[wid];
    if (!targetId) return;
    if (
      down &&
      ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " "].indexOf(e.key) >=
      0
    ) {
      e.preventDefault();
    }
    TSIX.send({
      wid: wid,
      targetId: targetId,
      eventType: "kb_key",
      value: JSON.stringify({
        key: e.key,
        code: e.code,
        down: down,
        repeat: !!e.repeat,
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey,
      }),
    });
  }
  document.addEventListener("keydown", function (e) {
    kbDocSend(e, true);
  });
  document.addEventListener("keyup", function (e) {
    kbDocSend(e, false);
  });
  // Penanda versi — cek di devtools untuk memastikan browser pakai client
  // JS terbaru (kalau tidak muncul, hard-reload halaman TDE: Cmd+Shift+R).
  console.log(
    "[TSIX] dome-client-dom v2: keyboard capture (document-level) ready",
  );
})();
