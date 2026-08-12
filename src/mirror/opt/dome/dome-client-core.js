/* ============================================================
 * DOME Client — Core (Bootstrapping, Shared State, WebSocket)
 * ============================================================
 * Bagian dari DOME browser engine (dome-client.html).
 * File ini WAJIB di-load PALING AWAL — mendefinisikan namespace
 * global window.TSIX yang dipakai semua modul lain.
 *
 * Tanggung jawab:
 *  - State bersama (desktop, windows, focusedWid, zCounter, overlay, socket)
 *  - Koneksi WebSocket + auto-reconnect
 *  - Dispatcher pesan inbound (router ke handler yang di-register per-modul)
 *  - Helper umum: send(), findElementById(), register()
 */
(function () {
  "use strict";

  // ---- State bersama (dipakai lintas modul via TSIX.state) ----
  const state = {
    desktop: document.getElementById("desktop"),
    windows: new Map(), // wid → { el, content, pid }
    focusedWid: null,
    zCounter: 100,
    overlayLayer: null,
    socket: null,
    reconnectTimer: null,
    reconnectDelay: 1000, // mulai 1s, backoff sampai maks 10s
  };

  // Overlay layer: elemen khusus di atas SEMUA window (z-index tertinggi).
  let overlayLayer = document.getElementById("__tsix_overlay_layer__");
  if (!overlayLayer) {
    overlayLayer = document.createElement("div");
    overlayLayer.id = "__tsix_overlay_layer__";
    overlayLayer.className = "tsix-overlay-layer";
    document.body.appendChild(overlayLayer);
  }
  overlayLayer.style.position = "fixed";
  overlayLayer.style.inset = "0";
  overlayLayer.style.pointerEvents = "none";
  overlayLayer.style.zIndex = "9999999999";
  overlayLayer.style.isolation = "isolate";
  overlayLayer.style.display = "block";
  state.overlayLayer = overlayLayer;

  // ---- Registry handler pesan inbound (per tipe) ----
  const handlers = {};

  function register(type, fn) {
    handlers[type] = fn;
  }

  // Kirim event ke DOME server (aman kalau socket belum siap).
  function send(payload) {
    const s = state.socket;
    if (s && s.readyState === 1) {
      s.send(JSON.stringify(payload));
    }
  }

  // Cari elemen DOM milik app tertentu (window, start-menu, overlay).
  function findElementById(wid, nodeId) {
    const win = state.windows.get(wid);
    if (win) {
      const el = win.el.querySelector(
        '[data-tsix-id="' + CSS.escape(nodeId) + '"]',
      );
      if (el) return el;
    }
    const gm = document.getElementById("__global_start_menu__");
    if (gm) {
      if (gm.getAttribute("data-tsix-id") === nodeId) return gm;
      const child = gm.querySelector(
        '[data-tsix-id="' + CSS.escape(nodeId) + '"]',
      );
      if (child) return child;
    }
    const overlay = document.getElementById("__tsix_overlay_layer__");
    if (overlay) {
      if (overlay.getAttribute("data-tsix-id") === nodeId) return overlay;
      const child = overlay.querySelector(
        '[data-tsix-id="' + CSS.escape(nodeId) + '"]',
      );
      if (child) return child;
    }
    return null;
  }

  // ---- Koneksi WebSocket + auto-reconnect ----
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = protocol + "//" + location.host;

  function connectWebSocket() {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    state.socket = new WebSocket(wsUrl);

    state.socket.onopen = () => {
      state.reconnectDelay = 1000; // reset backoff pada koneksi sukses
      console.log("[TSIX] WebSocket connected");
    };

    state.socket.onclose = () => {
      state.reconnectTimer = setTimeout(() => {
        connectWebSocket();
        state.reconnectDelay = Math.min(state.reconnectDelay * 1.5, 10000);
      }, state.reconnectDelay);
      // Hapus semua window dari sesi lama saat reconnect
      state.windows.forEach((w) => {
        try {
          w.el.remove();
        } catch (e) { }
      });
      state.windows.clear();
      state.focusedWid = null;
      state.zCounter = 100;
    };

    state.socket.onerror = () => {
      // onclose akan menyusul, memicu reconnect
    };

    // --- INBOUND: Terima perintah dari DOME server ---
    state.socket.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return; // abaikan pesan rusak
      }
      const fn = handlers[msg.type];
      if (fn) fn(msg);
    };
  }

  // Ekspor namespace global untuk modul lain
  window.TSIX = {
    state,
    register,
    send,
    findElementById,
    connectWebSocket,
  };

  // ================================================================
  // PROTEKSI NAVIGASI — cegah refresh/back tidak sengaja
  // ================================================================
  // User sering tidak sengaja refresh (F5 / Cmd+R / Ctrl+R) atau back
  // gesture (macOS trackpad) di browser TDE. Di sini tampilkan prompt
  // konfirmasi sebelum halaman benar-benar di-unload.
  (function protectNavigation() {
    let allowReload = false; // true saat user sudah konfirmasi refresh

    // Tandai interaksi user — beberapa browser (Chrome 91+) mematikan
    // beforeunload jika halaman belum pernah disentuh.
    document.addEventListener("pointerdown", function () { }, { once: true });

    const isRefreshKey = function (e) {
      return (
        e.key === "F5" ||
        ((e.key === "r" || e.key === "R") && (e.ctrlKey || e.metaKey))
      );
    };

    // 1) Refresh via keyboard → prompt custom (konfirmasi dulu)
    document.addEventListener(
      "keydown",
      function (e) {
        if (!isRefreshKey(e) || e.repeat) return;
        e.preventDefault();
        const ok = window.confirm(
          "Yakin mau refresh TDE?\n\n" +
          "Semua window yang berjalan akan ditutup lalu di-restore " +
          "ulang dari server.\n\n" +
          "OK = refresh, Cancel = batal",
        );
        if (ok) {
          allowReload = true;
          window.location.reload();
        }
      },
      true,
    );

    // 2) Back/forward, close tab, navigasi lain → dialog native browser
    window.addEventListener("beforeunload", function (e) {
      if (allowReload) return; // refresh yang sudah dikonfirmasi
      e.preventDefault();
      e.returnValue = "";
    });
  })();

  // Initial connection
  connectWebSocket();
})();
