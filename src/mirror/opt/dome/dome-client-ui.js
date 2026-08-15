/* ============================================================
 * DOME Client — UI Helpers (theme, tooltip, context menu, dll)
 * ============================================================
 * - Restore theme dari localStorage + WINDOW_THEME (CSS variables)
 * - Tooltip system (data-tt)
 * - Context menu (taskbar / app element / desktop kosong)
 * - Dismiss start-menu & launcher saat klik di luar
 * - PLAY_SOUND (audio)
 * - Inbound: WINDOW_TITLE, WINDOW_THEME, PLAY_SOUND
 */
(function () {
  "use strict";
  const TSIX = window.TSIX;
  const S = TSIX.state;

  // --- Restore theme dari localStorage (tahan F5) ---
  (function restoreTheme() {
    try {
      const saved = localStorage.getItem("tsix_theme_colors");
      if (saved) {
        const colors = JSON.parse(saved);
        const root = document.documentElement;
        if (colors.titlebar)
          root.style.setProperty("--titlebar", colors.titlebar);
        if (colors.bg) root.style.setProperty("--bg", colors.bg);
        if (colors.surface) root.style.setProperty("--surface", colors.surface);
        if (colors.buttonBg)
          root.style.setProperty("--surface2", colors.buttonBg);
        if (colors.accent) root.style.setProperty("--accent", colors.accent);
        if (colors.text) root.style.setProperty("--text", colors.text);
        if (colors.textDim)
          root.style.setProperty("--text-dim", colors.textDim);
        if (colors.textMuted)
          root.style.setProperty("--text-muted", colors.textMuted);
        if (colors.borderColor)
          root.style.setProperty("--border", colors.borderColor);
        if (colors.buttonBg)
          root.style.setProperty("--button-bg", colors.buttonBg);
        if (colors.inputBg)
          root.style.setProperty("--input-bg", colors.inputBg);
        if (colors.accentBg)
          root.style.setProperty("--accent-bg", colors.accentBg);
        // Update window borders
        document.querySelectorAll(".tsix-window").forEach((el) => {
          el.style.borderColor = colors.borderColor || "#4caf50";
          el.style.boxShadow =
            colors.shadow || "0 8px 32px rgba(0,0,0,0.4)";
        });
      }
    } catch (_) { }
  })();

  // Hide start-menu/launcher when user clicks anywhere outside them.
  document.addEventListener(
    "mousedown",
    (ev) => {
      try {
        // --- Start-menu dismiss ---
        const gm = document.getElementById("__global_start_menu__");
        if (gm) {
          if (!gm.contains(ev.target)) {
            gm.style.opacity = "0";
            gm.style.transform = "scale(0.95)";
            gm.style.pointerEvents = "none";
            const owner = gm.getAttribute("data-tsix-owner-wid");
            if (owner) {
              TSIX.send({
                wid: owner,
                targetId: "workspace",
                eventType: "click",
              });
            }
          }
        }
        // --- Launcher dismiss (click outside panel) ---
        const lo = document.querySelector('[data-tsix-id="launcher-overlay"]');
        if (lo && lo.style.display !== "none") {
          const panel = lo.querySelector('[data-tsix-id="launcher-panel"]');
          if (panel && !panel.contains(ev.target)) {
            // Hide the overlay immediately
            lo.style.display = "none";
            // Directly notify the window manager to sync launcherOpen state.
            // We can't rely on event bubbling because app windows may be in
            // a cloned/replaced DOM branch of #desktop.
            const desktopEl = document.querySelector(
              '[data-tsix-id="desktop"]',
            );
            if (desktopEl) {
              const winEl = desktopEl.closest('[id^="win-"]');
              if (winEl) {
                const wid = winEl.id.replace("win-", "");
                TSIX.send({
                  wid: wid,
                  targetId: "desktop",
                  eventType: "click",
                });
              }
            }
          }
        }
      } catch (e) {
        /* ignore */
      }
    },
    true,
  );

  // Context Menu (global, 1x) — taskbar + desktop right-click
  document.addEventListener("contextmenu", (e) => {
    // Priority 1: Taskbar button — cari by data-wid atau class tsix-taskbar-btn
    const btn = e.target.closest("[data-wid], .tsix-taskbar-btn");
    if (btn) {
      e.preventDefault();
      const wid = btn.getAttribute("data-wid");
      if (!wid) return;
      const old = document.getElementById("__tsix_context_menu__");
      if (old) old.remove();
      const menu = document.createElement("div");
      menu.id = "__tsix_context_menu__";
      let menuLeft = e.clientX,
        menuTop = e.clientY;
      const menuW = 150,
        menuH = 80;
      if (menuTop + menuH > window.innerHeight) menuTop = e.clientY - menuH;
      if (menuLeft + menuW > window.innerWidth)
        menuLeft = window.innerWidth - menuW;
      if (menuTop < 0) menuTop = 0;
      menu.style.cssText =
        "position:fixed;z-index:99999999;background:#1e2a4a;border:1px solid #4caf50;border-radius:6px;padding:4px 0;min-width:120px;box-shadow:0 4px 20px rgba(0,0,0,0.5);left:" +
        menuLeft +
        "px;top:" +
        (parseInt(menuTop) - 50) +
        "px;";
      const makeItem = (label, onClick, opts) => {
        const disabled = !!(opts && opts.disabled);
        const item = document.createElement("div");
        item.textContent = label;
        item.style.cssText =
          "padding:6px 12px;font-size:12px;color:" +
          (disabled ? "#777" : "#e0e0e0") +
          ";cursor:" +
          (disabled ? "default" : "pointer") +
          ";user-select:none;";
        if (!disabled) {
          item.addEventListener("mouseenter", () => {
            item.style.background = "rgba(76,175,80,0.2)";
          });
          item.addEventListener("mouseleave", () => {
            item.style.background = "";
          });
          item.addEventListener("click", (ev) => {
            ev.stopPropagation();
            onClick();
          });
        }
        menu.appendChild(item);
      };
      makeItem("Move", () => {
        menu.remove();
        const w = S.windows.get(wid);
        if (!w || !w.el) return;
        w.el.style.outline = "3px dashed #4caf50";
        w.el.style.outlineOffset = "-3px";
        document.body.style.cursor = "move";
        const cross = document.createElement("div");
        cross.textContent = "✚";
        cross.style.cssText =
          "position:absolute;z-index:999999999;top:50%;left:50%;transform:translate(-50%,-50%);font-size:24px;color:#4caf50;text-shadow:0 0 8px #000,0 0 3px #000;pointer-events:none;user-select:none;";
        w.el.appendChild(cross);
        const onKey = (ke) => {
          let l = w.el.offsetLeft,
            t = w.el.offsetTop;
          if (ke.key === "ArrowUp") t -= 8;
          else if (ke.key === "ArrowDown") t += 8;
          else if (ke.key === "ArrowLeft") l -= 8;
          else if (ke.key === "ArrowRight") l += 8;
          else if (ke.key === "Enter" || ke.key === "Escape") {
            document.removeEventListener("keydown", onKey);
            document.removeEventListener("mousedown", onCancel);
            w.el.style.outline = "";
            w.el.style.outlineOffset = "";
            document.body.style.cursor = "";
            cross.remove();
            if (ke.key === "Enter" && w.el._origRect) {
              const r = w.el.getBoundingClientRect();
              w.el._origRect.left = r.left;
              w.el._origRect.top = r.top;
            }
            return;
          }
          w.el.style.left = l + "px";
          w.el.style.top = t + "px";
          ke.preventDefault();
        };
        const onCancel = () => {
          document.removeEventListener("keydown", onKey);
          document.removeEventListener("mousedown", onCancel);
          w.el.style.outline = "";
          w.el.style.outlineOffset = "";
          document.body.style.cursor = "";
          cross.remove();
        };
        document.addEventListener("keydown", onKey);
        document.addEventListener("mousedown", onCancel);
      });
      makeItem("Restore", () => {
        menu.remove();
        TSIX.send({
          wid,
          targetId: "__window__",
          eventType: "restore_window",
        });
      });
      makeItem("Minimize", () => {
        menu.remove();
        TSIX.send({
          wid,
          targetId: "__window__",
          eventType: "minimize_window",
        });
      });
      // Maximize / Restore Down — hormati flag maximizable
      const wctx = S.windows.get(wid);
      if (wctx && wctx._isMaximized) {
        makeItem("Restore Down", () => {
          menu.remove();
          TSIX.send({
            wid,
            targetId: "__window__",
            eventType: "unmaximize_window",
          });
        });
      } else if (wctx && wctx.maximizable === false) {
        // Disabled — konsisten dgn tombol maximize di titlebar yg disembunyikan
        makeItem("Maximize", () => { }, { disabled: true });
      } else {
        makeItem("Maximize", () => {
          menu.remove();
          TSIX.send({
            wid,
            targetId: "__window__",
            eventType: "maximize_window",
          });
        });
      }
      // Separator
      const sep = document.createElement("div");
      sep.style.cssText =
        "height:1px;background:rgba(255,255,255,0.1);margin:4px 8px;";
      menu.appendChild(sep);
      makeItem("Close", () => {
        menu.remove();
        TSIX.send({
          wid,
          targetId: "__window__",
          eventType: "close_window",
        });
      });
      document.body.appendChild(menu);
      const closeMenu = (ev) => {
        if (!menu.contains(ev.target)) {
          menu.remove();
          document.removeEventListener("mousedown", closeMenu);
        }
      };
      document.addEventListener("mousedown", closeMenu);
      return;
    }

    // Priority 2: Element inside app window — cari [oncontextmenu] terdekat
    const appEl = e.target.closest("[oncontextmenu]");
    if (appEl) {
      e.preventDefault();
      const winEl = appEl.closest(".tsix-window");
      if (!winEl) return;
      const wId = winEl.id.replace("win-", "");
      const tsixId = appEl.getAttribute("data-tsix-id");
      if (!wId || !tsixId) return;
      TSIX.send({
        wid: wId,
        targetId: tsixId,
        eventType: "contextmenu",
        value: JSON.stringify({ x: e.clientX, y: e.clientY }),
      });
      return;
    }

    // Priority 3: Desktop right-click → cek apakah bener2 di desktop kosong
    // (jangan tampil kalau di dalam window aplikasi lain)
    const clickedWin = e.target.closest(".tsix-window");
    if (clickedWin) {
      // Masih dalam window — cuma tampil DCM kalau itu WM window (z-index 1)
      const zIdx = clickedWin.style.zIndex;
      if (zIdx !== "1") return; // App window — skip
    }
    e.preventDefault();
    const wmWin = document.querySelector('.tsix-window[style*="z-index: 1"]');
    if (wmWin) {
      const wid = wmWin.id.replace("win-", "");
      TSIX.send({
        wid,
        targetId: "__window__",
        eventType: "contextmenu_desktop",
        value: JSON.stringify({ x: e.clientX, y: e.clientY }),
      });
    }
  });

  // ===== TSIX Tooltip — muncul centered di atas icon =====
  let _tooltipTimer = null;
  let _tooltipEl = null;

  function hideTooltip() {
    if (_tooltipTimer) {
      clearTimeout(_tooltipTimer);
      _tooltipTimer = null;
    }
    if (_tooltipEl) {
      _tooltipEl.classList.remove("visible");
      setTimeout(() => {
        if (_tooltipEl) {
          _tooltipEl.remove();
          _tooltipEl = null;
        }
      }, 150);
    }
  }

  function showTooltip(target, text) {
    hideTooltip();
    const el = document.createElement("div");
    el.id = "__tsix_tooltip__";
    el.textContent = text;
    document.body.appendChild(el);
    _tooltipEl = el;
    void el.offsetWidth;
    const br = target.getBoundingClientRect();
    const tw = el.offsetWidth;
    const left = br.left + br.width / 2 - tw / 2;
    const top = br.top - el.offsetHeight - 6;
    el.style.left = Math.max(4, left) + "px";
    el.style.top = (top < 0 ? br.bottom + 4 : top) + "px";
    el.classList.add("visible");
  }

  // Tooltip via event delegation di document (taskbar di overlay layer)
  document.addEventListener(
    "mouseover",
    (e) => {
      const btn = e.target.closest("[data-tt]");
      if (!btn) return;
      if (_tooltipTimer) clearTimeout(_tooltipTimer);
      _tooltipTimer = setTimeout(() => {
        const text = btn.getAttribute("data-tt");
        if (!text) return;
        showTooltip(btn, text);
      }, 300);
    },
    true,
  );

  document.addEventListener(
    "mouseout",
    (e) => {
      const btn = e.target.closest("[data-tt]");
      if (!btn || btn.contains(e.relatedTarget)) return;
      if (_tooltipTimer) {
        clearTimeout(_tooltipTimer);
        _tooltipTimer = null;
      }
      setTimeout(() => {
        if (_tooltipEl) {
          _tooltipEl.classList.remove("visible");
          setTimeout(() => {
            if (_tooltipEl) {
              _tooltipEl.remove();
              _tooltipEl = null;
            }
          }, 150);
        }
      }, 50);
    },
    true,
  );

  // --- Inbound handlers ---

  function handleWindowTitle(msg) {
    const { wid, title } = msg;
    const win = S.windows.get(wid);
    if (!win) return;
    let span = win.el.querySelector(".tsix-titlebar .tsix-titlebar-title");
    if (!span) span = win.el.querySelector(".tsix-titlebar span"); // fallback
    if (span) span.textContent = title || "App";
  }

  function handleWindowTheme(msg) {
    const { colors } = msg;
    if (!colors) return;
    const root = document.documentElement;
    root.style.setProperty(
      "--titlebar",
      colors.titlebar || root.style.getPropertyValue("--titlebar"),
    );
    root.style.setProperty(
      "--bg",
      colors.bg || root.style.getPropertyValue("--bg"),
    );
    root.style.setProperty(
      "--surface",
      colors.surface || root.style.getPropertyValue("--surface"),
    );
    root.style.setProperty(
      "--surface2",
      colors.buttonBg || root.style.getPropertyValue("--surface2"),
    );
    root.style.setProperty(
      "--accent",
      colors.accent || root.style.getPropertyValue("--accent"),
    );
    root.style.setProperty(
      "--text",
      colors.text || root.style.getPropertyValue("--text"),
    );
    root.style.setProperty(
      "--text-dim",
      colors.textDim || root.style.getPropertyValue("--text-dim"),
    );
    root.style.setProperty(
      "--text-muted",
      colors.textMuted || root.style.getPropertyValue("--text-muted"),
    );
    root.style.setProperty(
      "--border",
      colors.borderColor || root.style.getPropertyValue("--border"),
    );
    root.style.setProperty(
      "--button-bg",
      colors.buttonBg || root.style.getPropertyValue("--button-bg"),
    );
    root.style.setProperty(
      "--input-bg",
      colors.inputBg || root.style.getPropertyValue("--input-bg"),
    );
    root.style.setProperty(
      "--accent-bg",
      colors.accentBg || root.style.getPropertyValue("--accent-bg"),
    );
    // Update semua window border
    document.querySelectorAll(".tsix-window").forEach((el) => {
      el.style.borderColor = colors.borderColor || "#4caf50";
      el.style.boxShadow = colors.shadow || "0 8px 32px rgba(0,0,0,0.4)";
    });
    // Simpan ke localStorage biar tahan F5
    try {
      localStorage.setItem("tsix_theme_colors", JSON.stringify(colors));
    } catch (_) { }
  }

  // Cache suara preload: nama → Audio (dikirim SEKALI dari app saat startup).
  // Dipakai PLAY_SOUND { name } biar tidak mengirim base64 penuh tiap play.
  var sfxCache = (window._tsixSfxCache = window._tsixSfxCache || {});

  function handleSfxPreload(msg) {
    const { name, data } = msg;
    if (!name || !data) return;
    try {
      const audio = new Audio("data:audio/mpeg;base64," + data);
      audio.volume = 0.7;
      sfxCache[name] = audio;
      audio.load();
    } catch (e) {
      /* ignore */
    }
  }

  function handlePlaySound(msg) {
    // Prioritas 1: suara dari cache (SFX_PRELOAD lama atau ResourceBank RES_LOAD)
    // — kirim nama doang, hemat WS.
    if (msg.name) {
      const cached =
        sfxCache[msg.name] ||
        (window._tsixResBank && window._tsixResBank[msg.name]);
      if (cached && typeof cached.play === "function") {
        try {
          if (cached.currentTime !== undefined) cached.currentTime = 0;
          cached.play().catch(function () {
            /* autoplay blocked */
          });
        } catch (e) {
          /* fallthrough ke pola lama */
        }
        return;
      }
    }
    // Prioritas 2: pola lama — data base64 langsung (Asteracea, dll).
    const { data } = msg;
    if (!data) return;
    try {
      const audio = new Audio("data:audio/mpeg;base64," + data);
      audio.volume = 0.7;
      audio.play().catch(function () {
        /* autoplay blocked */
      });
    } catch (e) {
      /* ignore */
    }
  }

  // Hapus semua suara preload milik window tertentu (key "<wid>:...").
  // Dipanggil dome-client-windows saat window di-destroy → memory audio dilepas.
  function clearSfxByWid(wid) {
    const prefix = wid + ":";
    Object.keys(sfxCache).forEach(function (k) {
      if (k.indexOf(prefix) === 0) {
        try {
          if (sfxCache[k].pause) sfxCache[k].pause();
        } catch (_) { }
        delete sfxCache[k];
      }
    });
  }
  TSIX.clearSfxByWid = clearSfxByWid;

  TSIX.register("WINDOW_TITLE", handleWindowTitle);
  TSIX.register("WINDOW_THEME", handleWindowTheme);
  TSIX.register("SFX_PRELOAD", handleSfxPreload);
  TSIX.register("PLAY_SOUND", handlePlaySound);
})();
