/* ============================================================
 * DOME Client — Window Manager
 * ============================================================
 * Tanggung jawab: lifecycle window (create/destroy), fokus/z-index,
 * animasi minimize/restore/maximize/unmaximize, drag & resize,
 * sinkronisasi state window ke server (window_state).
 * - Inbound: CREATE_WINDOW, DESTROY_WINDOW, MINIMIZE_WINDOW,
 *            RESTORE_WINDOW, MAXIMIZE_WINDOW, UNMAXIMIZE_WINDOW, FOCUS
 */
(function () {
  "use strict";
  const TSIX = window.TSIX;
  const S = TSIX.state;

  const FADE_DURATION = 200; // ms

  // Sync window state ke server (posisi, ukuran) untuk persistensi saat refresh
  function syncWindowState(wid) {
    const w = S.windows.get(wid);
    if (!w || !w.el) return;
    const r = w.el.getBoundingClientRect();
    TSIX.send({
      wid: wid,
      targetId: "__window__",
      eventType: "window_state",
      value: JSON.stringify({
        left: Math.round(r.left),
        top: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
        isMaximized: w._isMaximized || false,
      }),
    });
  }

  // Helper: cari taskbar button via [data-wid], return { left, top } atau null
  function getTaskbarBtnTarget(wid) {
    const btn = document.querySelector('[data-wid="' + wid + '"]');
    if (!btn) return null;
    const br = btn.getBoundingClientRect();
    return {
      left: br.left + br.width / 2 - 60 + "px",
      top: br.top + br.height / 2 - 14 + "px",
    };
  }

  function focusWindow(wid) {
    if (S.focusedWid === wid) return;
    const win = S.windows.get(wid);
    if (!win) return;
    // Fullscreen windows always stay at bottom
    if (win.el.style.zIndex === "1") return;
    if (S.focusedWid) {
      const prev = S.windows.get(S.focusedWid);
      if (prev) prev.el.classList.remove("focused");
    }
    win.el.classList.add("focused");
    win.el.style.zIndex = ++S.zCounter;
    S.focusedWid = wid;
  }

  // --- CREATE / DESTROY ---

  function handleCreateWindow(msg) {
    const {
      wid,
      pid,
      title,
      icon,
      fullscreen,
      width,
      height,
      resizable,
      frameless,
      maximizable,
    } = msg;
    const winEl = document.createElement("div");
    winEl.className = "tsix-window focused";
    if (frameless) winEl.classList.add("frameless");
    winEl.id = "win-" + wid;
    if (resizable === false) winEl.style.resize = "none";
    if (fullscreen) {
      winEl.style.left = "0";
      winEl.style.top = "0";
      winEl.style.width = "100vw";
      winEl.style.height = "100vh";
      winEl.style.borderRadius = "0";
      winEl.style.zIndex = "1";
    } else {
      // Ukuran efektif window (dipakai juga untuk perhitungan centered)
      const winW = msg.posX !== undefined && msg.posW ? msg.posW : width || 420;
      const winH = msg.posH || height;
      // Posisi custom (posX/posY dari left/top) atau centered di viewport
      let posX = msg.posX;
      let posY = msg.posY;
      if (msg.centered) {
        posX = Math.round((window.innerWidth - winW) / 2);
        posY = Math.round((window.innerHeight - (winH || 420)) / 2);
      }
      winEl.style.left =
        (posX !== undefined ? posX : 80 + S.windows.size * 30) + "px";
      winEl.style.top =
        (posY !== undefined ? posY : 60 + S.windows.size * 30) + "px";
      winEl.style.width = winW + "px";
      if (winH) winEl.style.height = winH + "px";
      winEl.style.minHeight = "200px";
    }

    // FRAMELESS: skip titlebar entirely — no drag, no close button, no frame
    if (!frameless) {
      const titleBar = document.createElement("div");
      titleBar.className = "tsix-titlebar";
      // Ikon (opsional) di kiri, lalu judul — dua span terpisah biar
      // handleWindowTitle (query .tsix-titlebar-title) tidak salah sasaran.
      if (icon) {
        const iconSpan = document.createElement("span");
        iconSpan.className = "tsix-titlebar-icon";
        iconSpan.textContent = icon;
        titleBar.appendChild(iconSpan);
      }
      const titleSpan = document.createElement("span");
      titleSpan.className = "tsix-titlebar-title";
      titleSpan.textContent = title || "App";
      titleBar.appendChild(titleSpan);

      // Button container (right side): minimize | restore | close
      const btnContainer = document.createElement("span");
      btnContainer.style.cssText =
        "display:flex;align-items:center;gap:4px;margin-left:auto;";

      // Minimize button
      const minBtn = document.createElement("button");
      minBtn.className = "min-btn";
      minBtn.textContent = "─";
      minBtn.title = "Minimize";
      minBtn.onclick = (e) => {
        e.stopPropagation();
        TSIX.send({
          wid: wid,
          targetId: "__window__",
          eventType: "minimize_window",
        });
      };
      btnContainer.appendChild(minBtn);

      // Restore button (hidden by default)
      const restoreBtn = document.createElement("button");
      restoreBtn.className = "restore-btn";
      restoreBtn.textContent = "⬜";
      restoreBtn.title = "Restore";
      restoreBtn.style.display = "none";
      restoreBtn.onclick = (e) => {
        e.stopPropagation();
        TSIX.send({
          wid: wid,
          targetId: "__window__",
          eventType: "restore_window",
        });
      };
      btnContainer.appendChild(restoreBtn);

      // Maximize button (hidden if maximizable === false or fullscreen)
      const maxBtn = document.createElement("button");
      maxBtn.className = "max-btn";
      maxBtn.textContent = "🗖";
      maxBtn.title = "Maximize";
      if (maximizable === false || fullscreen) maxBtn.style.display = "none";
      maxBtn.onclick = (e) => {
        e.stopPropagation();
        TSIX.send({
          wid: wid,
          targetId: "__window__",
          eventType: "maximize_window",
        });
      };
      btnContainer.appendChild(maxBtn);

      // Unmaximize button (hidden by default, shown when maximized)
      const unmaxBtn = document.createElement("button");
      unmaxBtn.className = "unmax-btn";
      unmaxBtn.textContent = "🗗";
      unmaxBtn.title = "Restore Down";
      unmaxBtn.style.display = "none";
      unmaxBtn.onclick = (e) => {
        e.stopPropagation();
        TSIX.send({
          wid: wid,
          targetId: "__window__",
          eventType: "unmaximize_window",
        });
      };
      btnContainer.appendChild(unmaxBtn);

      // Close button
      const closeBtn = document.createElement("button");
      closeBtn.className = "close-btn";
      closeBtn.textContent = "✕";
      closeBtn.onclick = () => {
        TSIX.send({
          wid: wid,
          targetId: "__window__",
          eventType: "close_window",
        });
      };
      btnContainer.appendChild(closeBtn);
      titleBar.appendChild(btnContainer);

      // Drag logic
      let dragX = 0,
        dragY = 0,
        dragging = false;
      titleBar.onmousedown = (e) => {
        dragging = true;
        dragX = e.clientX - winEl.offsetLeft;
        dragY = e.clientY - winEl.offsetTop;
        document.onmousemove = (ev) => {
          if (!dragging) return;
          winEl.style.left = ev.clientX - dragX + "px";
          winEl.style.top = ev.clientY - dragY + "px";
        };
        document.onmouseup = () => {
          dragging = false;
          document.onmousemove = null;
          // User drag = update orig position
          if (winEl._origRect) {
            const r = winEl.getBoundingClientRect();
            winEl._origRect.left = r.left;
            winEl._origRect.top = r.top;
            winEl._origRect.width = r.width;
            winEl._origRect.height = r.height;
          }
          syncWindowState(wid);
        };
        focusWindow(wid);
      };
      // Double-click titlebar → maximize / unmaximize
      titleBar.ondblclick = (e) => {
        e.stopPropagation();
        const w = S.windows.get(wid);
        if (!w) return;
        // Hormati maximizable: window non-maximizable tidak boleh maximize
        // (tapi tetap boleh unmaximize jika sudah terlanjur maximized)
        if (!w._isMaximized && w.maximizable === false) return;
        TSIX.send({
          wid: wid,
          targetId: "__window__",
          eventType: w._isMaximized ? "unmaximize_window" : "maximize_window",
        });
      };
      winEl.appendChild(titleBar);

      // Store refs for minimize/restore/maximize toggle
      winEl._minBtn = minBtn;
      winEl._restoreBtn = restoreBtn;
      winEl._maxBtn = maxBtn;
      winEl._unmaxBtn = unmaxBtn;
    }

    const content = document.createElement("div");
    content.className = "tsix-content";
    // Click anywhere on content = fokus window, bawa ke top
    content.addEventListener("mousedown", () => focusWindow(wid));
    winEl.appendChild(content);

    // Resize handles 4 pojok
    if (resizable !== false) {
      const makeHandle = (cls) => {
        const h = document.createElement("div");
        h.className = "tsix-resize-handle " + cls;
        h.addEventListener("mousedown", (e) => {
          e.stopPropagation();
          e.preventDefault();
          const startX = e.clientX,
            startY = e.clientY;
          const startRect = winEl.getBoundingClientRect();
          const startLeft = winEl.offsetLeft;
          const startTop = winEl.offsetTop;
          const onMove = (ev) => {
            const dx = ev.clientX - startX,
              dy = ev.clientY - startY;
            let l = startLeft,
              t = startTop,
              w = startRect.width,
              h = startRect.height;
            if (cls.includes("n")) {
              t = startTop + dy;
              h = startRect.height - dy;
            }
            if (cls.includes("s")) {
              h = startRect.height + dy;
            }
            if (cls.includes("w")) {
              l = startLeft + dx;
              w = startRect.width - dx;
            }
            if (cls.includes("e")) {
              w = startRect.width + dx;
            }
            if (w >= 200) {
              winEl.style.left = l + "px";
              winEl.style.width = w + "px";
            }
            if (h >= 100) {
              winEl.style.top = t + "px";
              winEl.style.height = h + "px";
            }
          };
          const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            if (winEl._origRect) {
              const r = winEl.getBoundingClientRect();
              winEl._origRect.left = r.left;
              winEl._origRect.top = r.top;
              winEl._origRect.width = r.width;
              winEl._origRect.height = r.height;
            }
          };
          document.addEventListener("mousemove", onMove);
          document.addEventListener("mouseup", onUp);
        });
        winEl.appendChild(h);
      };
      makeHandle("nw");
      makeHandle("ne");
      makeHandle("sw");
      makeHandle("se");
      makeHandle("n");
      makeHandle("s");
      makeHandle("e");
      makeHandle("w");
    }

    S.desktop.appendChild(winEl);

    const ir = winEl.getBoundingClientRect();
    winEl._origRect = {
      left: ir.left,
      top: ir.top,
      width: ir.width,
      height: ir.height,
    };

    // ResizeObserver: update origRect ukuran saat user resize (tapi skip jika maximized/fullscreen/animating)
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => {
        const w = S.windows.get(wid);
        if (!w) return;
        // Skip jika maximized atau sedang animasi (minimize/restore/maximize/unmaximize)
        if (w._isMaximized || w._animating) return;
        if (winEl.style.zIndex === "1") return; // fullscreen
        const r = winEl.getBoundingClientRect();
        if (winEl._origRect) {
          if (
            winEl._origRect.width !== r.width ||
            winEl._origRect.height !== r.height
          ) {
            winEl._origRect.width = r.width;
            winEl._origRect.height = r.height;
            syncWindowState(wid);
          }
        }
      });
      ro.observe(winEl);
    }

    S.windows.set(wid, {
      el: winEl,
      content: content,
      pid: pid,
      maximizable: maximizable !== false, // default true
      fullscreen: !!fullscreen,
    });
    focusWindow(wid);
  }

  function handleDestroyWindow(msg) {
    const { wid } = msg;
    const win = S.windows.get(wid);
    if (win) {
      win.el.remove();
      S.windows.delete(wid);
      if (S.focusedWid === wid) S.focusedWid = null;
    }
    // Safety net: hentikan semua DDC (RAF loop NJ) milik window ini
    if (typeof TSIX.destroyDDCByWid === "function") {
      TSIX.destroyDDCByWid(wid);
    }
    // Wipe cache suara preload milik window ini (key "<wid>:...")
    if (typeof TSIX.clearSfxByWid === "function") {
      TSIX.clearSfxByWid(wid);
    }
    // Wipe ResourceBank cache milik window ini (RES_LOAD "<wid>:...")
    if (typeof TSIX.clearResByWid === "function") {
      TSIX.clearResByWid(wid);
    }
  }

  // --- MINIMIZE / RESTORE (fade animation) ---

  function handleMinimizeWindow(msg) {
    const win = S.windows.get(msg.wid);
    if (!win || !win.el) return;

    // Guard: already hidden or currently animating
    if (win.el.style.display === "none" || win._animating) return;

    // Fullscreen windows — just fade and hide
    if (win.el.style.zIndex === "1") {
      win._animating = true;
      win.el.style.transition = "opacity " + FADE_DURATION + "ms ease-in";
      win.el.style.opacity = "0";
      if (win.el._minBtn) win.el._minBtn.style.display = "none";
      if (win.el._restoreBtn)
        win.el._restoreBtn.style.display = "inline-block";
      const finish = () => {
        win.el.style.display = "none";
        win._animating = false;
        win.el.removeEventListener("transitionend", finish);
      };
      win.el.addEventListener("transitionend", finish);
      setTimeout(() => {
        if (win.el.style.display !== "none") {
          win.el.style.display = "none";
          win._animating = false;
        }
      }, FADE_DURATION + 60);
      return;
    }

    win._animating = true;

    // Save actual rendered position & size
    const rect = win.el.getBoundingClientRect();
    win._savedRect = {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };

    // Cari taskbar button via [data-wid] langsung — ambil posisinya sekarang
    const tbTarget = getTaskbarBtnTarget(msg.wid);
    const targetLeft = tbTarget ? tbTarget.left : rect.left + "px";
    const targetTop = tbTarget
      ? tbTarget.top
      : window.innerHeight - 50 + "px";
    win._savedTbRect = tbTarget;

    // Temporarily remove min-height
    win._savedMinHeight = win.el.style.minHeight;
    win.el.style.minHeight = "0";

    if (win.el._minBtn) win.el._minBtn.style.display = "none";
    if (win.el._restoreBtn)
      win.el._restoreBtn.style.display = "inline-block";

    // Animate to taskbar button
    win.el.style.transition =
      "left 280ms ease-in, top 280ms ease-in, width 280ms ease-in, height 280ms ease-in, opacity 280ms ease-in, transform 280ms ease-in";
    win.el.style.transformOrigin = "center center";
    win.el.style.left = targetLeft;
    win.el.style.top = targetTop;
    win.el.style.width = "120px";
    win.el.style.height = "28px";
    win.el.style.transform = "scale(0.4)";
    win.el.style.opacity = "0.2";
    win.el.style.pointerEvents = "none";

    const finish = () => {
      win.el.style.display = "none";
      win.el.removeEventListener("transitionend", finish);
      win._animating = false;
    };
    win.el.addEventListener("transitionend", finish);
    setTimeout(() => {
      if (win.el.style.display !== "none") {
        win.el.style.display = "none";
        win._animating = false;
      }
    }, 350);
  }

  function handleRestoreWindow(msg) {
    const win = S.windows.get(msg.wid);
    if (!win || !win.el) return;

    if (win._animating) return;
    if (win.el.style.display !== "none") return;

    // Fullscreen — just show
    if (win.el.style.zIndex === "1") {
      win._animating = true;
      win.el.style.transition = "none";
      win.el.style.opacity = "0";
      win.el.style.display = "";
      if (win._savedRect) {
        win.el.style.left = win._savedRect.left + "px";
        win.el.style.top = win._savedRect.top + "px";
        win.el.style.width = win._savedRect.width + "px";
        win.el.style.height = win._savedRect.height + "px";
      }
      if (win.el._minBtn) win.el._minBtn.style.display = "inline-block";
      if (win.el._restoreBtn) win.el._restoreBtn.style.display = "none";
      void win.el.offsetHeight;
      win.el.style.transition = "opacity " + FADE_DURATION + "ms ease-out";
      win.el.style.opacity = "1";
      const finish = () => {
        win.el.style.transition = "";
        win._animating = false;
        win.el.removeEventListener("transitionend", finish);
      };
      win.el.addEventListener("transitionend", finish);
      setTimeout(() => {
        win.el.style.transition = "";
        win._animating = false;
      }, FADE_DURATION + 60);
      focusWindow(msg.wid);
      return;
    }

    let saved = win._savedRect;
    // Safety: rect nol (mis. sisa maximize saat window masih hidden)
    // → jangan restore ke (0,0,0,0), pakai posisi/ukuran asli.
    if (saved && (saved.width <= 0 || saved.height <= 0)) {
      saved = win.el._origRect || null;
    }
    if (!saved) {
      // No saved rect — just fade in place
      win._animating = true;
      win.el.style.transition = "none";
      win.el.style.opacity = "0";
      win.el.style.display = "";
      if (win.el._minBtn) win.el._minBtn.style.display = "inline-block";
      if (win.el._restoreBtn) win.el._restoreBtn.style.display = "none";
      void win.el.offsetHeight;
      win.el.style.transition = "opacity " + FADE_DURATION + "ms ease-out";
      win.el.style.opacity = "1";
      win.el.style.pointerEvents = "";
      const finish = () => {
        win.el.style.transition = "";
        win._animating = false;
        win.el.removeEventListener("transitionend", finish);
      };
      win.el.addEventListener("transitionend", finish);
      setTimeout(() => {
        win.el.style.transition = "";
        win._animating = false;
      }, FADE_DURATION + 60);
      focusWindow(msg.wid);
      return;
    }

    win._animating = true;

    // Cari posisi TB fresh setiap kali restore — bisa saja berubah
    const tbTarget = getTaskbarBtnTarget(msg.wid) || win._savedTbRect;
    const startLeft = tbTarget ? tbTarget.left : saved.left + "px";
    const startTop = tbTarget
      ? tbTarget.top
      : window.innerHeight - 50 + "px";

    // Temporarily remove min-height
    win.el.style.minHeight = "0";

    // Jump to starting position (no transition)
    win.el.style.transition = "none";
    win.el.style.left = startLeft;
    win.el.style.top = startTop;
    win.el.style.width = "120px";
    win.el.style.height = "28px";
    win.el.style.transform = "scale(0.4)";
    win.el.style.opacity = "0.2";
    win.el.style.pointerEvents = "none";
    win.el.style.display = "";

    if (win.el._minBtn) win.el._minBtn.style.display = "inline-block";
    if (win.el._restoreBtn) win.el._restoreBtn.style.display = "none";

    // Force reflow
    void win.el.offsetHeight;

    // Animate to saved position
    win.el.style.transition =
      "left 280ms ease-out, top 280ms ease-out, width 280ms ease-out, height 280ms ease-out, opacity 280ms ease-out, transform 280ms ease-out";
    win.el.style.transformOrigin = "center center";
    win.el.style.left = saved.left + "px";
    win.el.style.top = saved.top + "px";
    win.el.style.width = saved.width + "px";
    win.el.style.height = saved.height + "px";
    win.el.style.transform = "scale(1)";
    win.el.style.opacity = "1";
    win.el.style.pointerEvents = "";

    const finish = () => {
      win.el.style.transition = "";
      win.el.style.transform = "";
      win.el.style.opacity = "";
      if (win._savedMinHeight !== undefined)
        win.el.style.minHeight = win._savedMinHeight;
      win.el.removeEventListener("transitionend", finish);
      win._animating = false;
    };
    win.el.addEventListener("transitionend", finish);
    setTimeout(() => {
      win.el.style.transition = "";
      win.el.style.transform = "";
      win.el.style.opacity = "";
      if (win._savedMinHeight !== undefined)
        win.el.style.minHeight = win._savedMinHeight;
      win._animating = false;
    }, 350);

    focusWindow(msg.wid);
  }

  // --- MAXIMIZE / UNMAXIMIZE ---

  function handleMaximizeWindow(msg) {
    const win = S.windows.get(msg.wid);
    if (!win || !win.el) return;
    if (win._animating) return;

    // Guard: window non-maximizable tidak boleh di-maximize
    if (win.maximizable === false) return;

    // Guard: already maximized or fullscreen
    if (win._isMaximized) return;

    win._animating = true;

    // Window sedang minimized (display:none) → tampilkan dulu di posisi
    // terakhirnya sebelum maximize. Tanpa ini getBoundingClientRect()
    // mengembalikan (0,0,0,0) → rect tersimpan jadi nol → saat di-restore
    // window muncul di pojok kiri atas dengan ukuran aneh, dan maximize
    // tidak terlihat sama sekali (window tetap hidden).
    if (win.el.style.display === "none") {
      win.el.style.transition = "none";
      win.el.style.opacity = "";
      win.el.style.transform = "";
      win.el.style.pointerEvents = "";
      win.el.style.display = "";
      if (win._savedRect) {
        win.el.style.left = win._savedRect.left + "px";
        win.el.style.top = win._savedRect.top + "px";
        win.el.style.width = win._savedRect.width + "px";
        win.el.style.height = win._savedRect.height + "px";
      }
      if (win._savedMinHeight !== undefined)
        win.el.style.minHeight = win._savedMinHeight;
      if (win.el._minBtn) win.el._minBtn.style.display = "inline-block";
      if (win.el._restoreBtn) win.el._restoreBtn.style.display = "none";
      void win.el.offsetHeight; // force reflow agar rect valid
      win.el.style.transition = "";
    }

    // Save current position & size for minimize→restore animation
    const rect = win.el.getBoundingClientRect();
    win._savedRect = {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
    // Simpan ke _unmaximizeRect — HANYA disentuh oleh MAXIMIZE dan UNMAXIMIZE, tidak ada yg lain
    win._unmaximizeRect = {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };

    // Toggle titlebar buttons
    if (win.el._maxBtn) win.el._maxBtn.style.display = "none";
    if (win.el._unmaxBtn) win.el._unmaxBtn.style.display = "inline-block";

    // Disable resize while maximized
    win._savedResize = win.el.style.resize;
    win.el.style.resize = "none";

    // Animate to full viewport
    win.el.style.transition =
      "left 250ms ease-out, top 250ms ease-out, width 250ms ease-out, height 250ms ease-out";
    win.el.style.left = "0";
    win.el.style.top = "0";
    win.el.style.width = "100vw";
    win.el.style.height = "100vh";
    win.el.style.borderRadius = "0";

    win._isMaximized = true;

    const finish = () => {
      win.el.style.transition = "";
      win.el.removeEventListener("transitionend", finish);
      win._animating = false;
    };
    win.el.addEventListener("transitionend", finish);
    setTimeout(() => {
      win.el.style.transition = "";
      win._animating = false;
    }, 300);

    focusWindow(msg.wid);
    syncWindowState(msg.wid);
  }

  function handleUnmaximizeWindow(msg) {
    const win = S.windows.get(msg.wid);
    if (!win || !win.el) return;
    if (win._animating) return;

    // Guard: not maximized
    if (!win._isMaximized) return;

    // Gunakan _unmaximizeRect — disimpan pas MAXIMIZE, hanya dipakai di sini
    const saved = win._unmaximizeRect || win.el._origRect || win._savedRect;
    if (!saved) return;

    win._animating = true;

    // Toggle titlebar buttons
    if (win.el._maxBtn) win.el._maxBtn.style.display = "inline-block";
    if (win.el._unmaxBtn) win.el._unmaxBtn.style.display = "none";

    // Restore resize
    if (win._savedResize !== undefined) win.el.style.resize = win._savedResize;

    // Restore border radius
    win.el.style.borderRadius = "";

    // Sync _savedRect so next minimize captures the correct unmaximized size
    win._savedRect = {
      left: saved.left,
      top: saved.top,
      width: saved.width,
      height: saved.height,
    };

    // Animate back to saved position
    win.el.style.transition =
      "left 250ms ease-out, top 250ms ease-out, width 250ms ease-out, height 250ms ease-out";
    win.el.style.left = saved.left + "px";
    win.el.style.top = saved.top + "px";
    win.el.style.width = saved.width + "px";
    win.el.style.height = saved.height + "px";

    win._isMaximized = false;

    const finish = () => {
      win.el.style.transition = "";
      win.el.removeEventListener("transitionend", finish);
      win._animating = false;
    };
    win.el.addEventListener("transitionend", finish);
    setTimeout(() => {
      win.el.style.transition = "";
      win._animating = false;
    }, 300);

    focusWindow(msg.wid);
    syncWindowState(msg.wid);
  }

  function handleFocus(msg) {
    focusWindow(msg.wid);
  }

  // Ekspor helper yang mungkin dipakai modul lain
  TSIX.focusWindow = focusWindow;
  TSIX.getTaskbarBtnTarget = getTaskbarBtnTarget;

  TSIX.register("CREATE_WINDOW", handleCreateWindow);
  TSIX.register("DESTROY_WINDOW", handleDestroyWindow);
  TSIX.register("MINIMIZE_WINDOW", handleMinimizeWindow);
  TSIX.register("RESTORE_WINDOW", handleRestoreWindow);
  TSIX.register("MAXIMIZE_WINDOW", handleMaximizeWindow);
  TSIX.register("UNMAXIMIZE_WINDOW", handleUnmaximizeWindow);
  TSIX.register("FOCUS", handleFocus);
})();
