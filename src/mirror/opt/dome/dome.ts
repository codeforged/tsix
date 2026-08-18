import { Program, std, fs, shell } from "@tsix/Application";
import {
  GUIAction,
  IGUIPayload,
  IBrowserEvent,
  IGUIEventIPC,
  IWindowEntry,
} from "@common/GUITypes";
import { SyscallCode } from "@common/SyscallCode";
import { v4 as uuidv4 } from "uuid";

// Capture REAL Node.js require at module top level (before sandbox locks it)
// Module._compile wraps code with (exports, require, module, ...) â€”
// this 'require' is the REAL one, not the hijacked one.
const _hostRequire = require;

/**
 * DOME â€” DOM Engine (PixelSpace Display Server)
 *
 * "Display Server-nya TSIX" â€” setara X11/Wayland.
 * Bridge antara Worker TSIX dan Web Browser via PixelSpace Protocol.
 *
 * Tugas:
 * 1. WebSocket Server (port 8080) â€” jembatan ke Browser
 * 2. Window Registry â€” wid â†’ pid â†’ wsClientId
 * 3. Z-Index & Focus Manager
 * 4. Relay: Kernel IPC â†” Browser WebSocket
 */

// ============================================================
// TYPES
// ============================================================

interface GuedWindowEntry {
  wid: string;
  pid: number;
  title: string;
  zIndex: number;
  focused: boolean;
  wsClientId: string | null;
  createdAt: number;
  fullscreen?: boolean;
  width?: number;
  height?: number;
  resizable?: boolean;
  frameless?: boolean;
  maximizable?: boolean;
  // State persist across browser refresh
  isMaximized?: boolean;
  winLeft?: number;
  winTop?: number;
  winWidth?: number;
  winHeight?: number;
}

interface BrowserMessage {
  type:
  | "CREATE_WINDOW"
  | "DESTROY_WINDOW"
  | "MOUNT_NODE"
  | "UNMOUNT_NODE"
  | "UPDATE_PROPS"
  | "FOCUS"
  | "MINIMIZE_WINDOW"
  | "RESTORE_WINDOW"
  | "MAXIMIZE_WINDOW"
  | "UNMAXIMIZE_WINDOW"
  | "TERM_OUTPUT"
  | "CM_SET_VALUE"
  | "CHART_INIT"
  | "CHART_DATA"
  | "CHART_DESTROY"
  | "DDC_MSG"
  | "DDC_RESIZE"
  | "DDC_STOP"
  | "TB_DATA"
  | "TB_APPEND"
  | "TB_COLS"
  | "TB_SORT"
  | "TB_SELECT"
  | "TB_CLEAR_SELECT"
  | "TB_DESTROY"
  | "TB_THEME";
  wid?: string;
  pid?: number;
  title?: string;
  icon?: string;
  action?: string;
  node?: any;
  props?: Record<string, any>;
  targetId?: string;
  frameless?: boolean;
  resizable?: boolean;
  maximizable?: boolean;
  fullscreen?: boolean;
  width?: number;
  height?: number;
  data?: string;
  value?: any;
}

// ============================================================
// MAIN
// ============================================================

export const main = Program(async (args: string[]) => {
  try {
    const uuid = "da8711c2-5ca9-4f00-ad13-f1226f95594c";
    const ok = await shell.registerIdentity(uuid);
    if (!ok) {
      await std.print(
        "Warning: Failed to register identity. Maybe already in use?\n",
      );
    }

    await std.log("[dome] Starting DOME Engine...", "dome");

    // --- PRIVILEGE CHECK ---
    if (typeof _hostRequire !== "function") {
      await std.log("[dome] FATAL: require not available", "dome");
      await std.println("[dome] FATAL: require not available.");
      return;
    }
    await std.log("[dome] Privilege check OK", "dome");

    const http = _hostRequire("http");
    const ws = _hostRequire("ws");
    await std.log("[dome] Modules loaded (http, ws)", "dome");

    // Detach from TTY
    await std.log("[dome] Daemonizing...", "dome");
    if (await shell.daemonize("PixelSpace DOME Engine")) {
      await std.log("[dome] Daemonized successfully", "dome");
    }

    const PORT = 8080;
    const myPid = shell.getPid();
    await std.log(`[dome] PID=${myPid}, starting on port ${PORT}`, "dome");

    // --- REGISTER WITH KERNEL ---
    const lib = (global as any)._tsixLib;
    if (lib && lib.dispatch) {
      await std.log("[dome] Registering with Kernel...", "dome");
      await lib.dispatch(SyscallCode.GUI_REQ, {
        syscall: "GUI_REQ",
        pid: myPid,
        wid: "__daemon__",
        action: GUIAction.REGISTER_DAEMON,
      });
      await std.log("[dome] Registered as GUI daemon with Kernel", "dome");
    }

    // ============================================================
    // WINDOW REGISTRY (gued's own copy)
    // ============================================================
    const windows = new Map<string, GuedWindowEntry>();
    const wsClients = new Map<string, any>();
    const windowStates = new Map<string, any[]>(); // wid â†’ replay payloads
    let lastThemeColors: Record<string, string> | null = null;
    let nextZIndex = 100;
    // Traffic monitoring — dipisah sumbernya biar observer effect gak ngaco
    let wsTraffic = { rxBytes: 0, rxPkts: 0, txBytes: 0, txPkts: 0 };
    let browserTraffic = { txBytes: 0, txPkts: 0 };
    // Per-app TX accounting: bytes DOME kirim ke browser atas nama tiap app.
    // App pengamat (traffic monitor) bisa exclude traffic-nya sendiri.
    let currentSrcPid = 0; // app yang sedang memicu broadcast (set per handler)
    const appTraffic = new Map<number, { txBytes: number; txPkts: number }>();
    const collectNodeIds = (node: any, ids: Set<string>): void => {
      if (!node || typeof node !== "object") return;
      if (typeof node.id === "string" && node.id) ids.add(node.id);
      if (Array.isArray(node.children)) {
        for (const child of node.children) collectNodeIds(child, ids);
      }
    };

    const pruneWindowState = (wid: string, targetId: string): void => {
      const states = windowStates.get(wid) || [];
      const filtered = states.filter((state: any) => {
        if (state?.type === "MOUNT_NODE") {
          const nodeIds = new Set<string>();
          collectNodeIds(state.node, nodeIds);
          if (state.targetId === targetId || nodeIds.has(targetId))
            return false;
        }
        if (state?.type === "UPDATE_PROPS") {
          if (state.targetId === targetId) return false;
        }
        return true;
      });
      windowStates.set(wid, filtered);
    };

    const getTopWindow = (): GuedWindowEntry | null => {
      let top: GuedWindowEntry | null = null;
      windows.forEach((w) => {
        if (!top || w.zIndex > top.zIndex) top = w;
      });
      return top;
    };

    const getWindowByPid = (wid: string): GuedWindowEntry | undefined =>
      windows.get(wid);

    // ============================================================
    // HTML CLIENT + SPLIT JS MODULES (Presentation Engine — VGA Browser)
    // ============================================================
    // dome-client.html kini tipis (CSS + tag <script>); logika JS dipisah
    // ke modul dome-client-*.js yang disajikan sebagai static assets.
    const htmlFd = await fs.open("/opt/dome/dome-client.html");
    const htmlContent = htmlFd !== null ? ((await fs.read(htmlFd)) ?? "") : "";
    if (htmlFd !== null) await fs.close(htmlFd);

    // Modul JS client — dibaca sekali saat startup (read-only, aman di-cache).
    const staticAssets = new Map<string, { content: string; type: string }>();
    const DOME_CLIENT_JS = [
      "dome-client-core.js",
      "dome-client-term.js",
      "dome-client-codemirror.js",
      "dome-client-chart.js",
      "dome-client-tabulator.js",
      "dome-client-ddc.js",
      "dome-client-res.js",
      "dome-client-dom.js",
      "dome-client-windows.js",
      "dome-client-ui.js",
    ];
    for (const file of DOME_CLIENT_JS) {
      const fd = await fs.open(`/opt/dome/${file}`);
      if (fd !== null) {
        const content = (await fs.read(fd)) ?? "";
        await fs.close(fd);
        staticAssets.set(`/dome/${file}`, {
          content,
          type: "application/javascript",
        });
        await std.log(`[dome] Loaded static asset /dome/${file}`, "dome");
      } else {
        await std.log(
          `[dome] Warning: missing static asset /opt/dome/${file}`,
          "dome",
        );
      }
    }

    // ============================================================
    // HTTP SERVER
    // ============================================================
    const server = http.createServer((req: any, res: any) => {
      const url = (req.url || "/").split("?")[0];
      const asset = staticAssets.get(url);
      if (asset) {
        res.writeHead(200, { "Content-Type": asset.type });
        res.end(asset.content);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(htmlContent);
    });

    // ============================================================
    // WEBSOCKET SERVER
    // ============================================================
    const wss = new ws.Server({ server });

    wss.on("connection", async (socket: any) => {
      const wsClientId = uuidv4().substring(0, 8);
      wsClients.set(wsClientId, socket);
      await std.log(`[dome] Browser connected: ${wsClientId}`, "dome");

      // --- Replay all existing windows to new client ---
      windows.forEach((entry) => {
        socket.send(
          JSON.stringify({
            type: "CREATE_WINDOW",
            wid: entry.wid,
            pid: entry.pid,
            title: entry.title,
            fullscreen: entry.fullscreen || false,
            width: entry.winWidth ?? entry.width,
            height: entry.winHeight ?? entry.height,
            resizable: entry.resizable,
            frameless: entry.frameless || false,
            posX: entry.winLeft,
            posY: entry.winTop,
            posW: entry.winWidth,
            posH: entry.winHeight,
          }),
        );
        // Replay stored mount/update payloads
        const states = windowStates.get(entry.wid) || [];
        std.log(
          `[dome] Replaying ${states.length} states for wid=${entry.wid}`,
          "dome",
        );
        if (states.length > 0) {
          // Log detail 5 state pertama
          const firstStates = states.slice(0, 5);
          for (const s of firstStates) {
            std.log(
              `[dome]   state: type=${s.type} nodeId=${s.node?.id || "-"} targetId=${s.targetId || "-"}`,
              "dome",
            );
          }
          if (states.length > 5) {
            std.log(
              `[dome]   ... and ${states.length - 5} more states`,
              "dome",
            );
          }
          // Cari apakah MOUNT_NODE wm-root ada
          const hasWmRoot = states.some(
            (s: any) => s.type === "MOUNT_NODE" && s.node?.id === "wm-root",
          );
          std.log(`[dome]   wm-root present: ${hasWmRoot}`, "dome");
        }
        for (const s of states) {
          socket.send(JSON.stringify(s));
        }
        // Restore maximized state if needed
        if (entry.isMaximized) {
          socket.send(
            JSON.stringify({ type: "MAXIMIZE_WINDOW", wid: entry.wid }),
          );
        }
      });

      // --- Replay theme to new client ---
      if (lastThemeColors) {
        socket.send(
          JSON.stringify({
            type: "WINDOW_THEME",
            wid: "",
            colors: lastThemeColors,
          }),
        );
      }

      // --- HANDLE EVENTS FROM BROWSER ---
      socket.on("message", async (rawData: string) => {
        // Traffic: count incoming
        wsTraffic.rxBytes += Buffer.byteLength(rawData, "utf8");
        wsTraffic.rxPkts++;
        // Pesan dari browser → bukan traffic "app" (browser-driven)
        currentSrcPid = 0;
        try {
          const event: IBrowserEvent = JSON.parse(rawData.toString());
          const entry = windows.get(event.wid);
          if (!entry) return;

          if (event.eventType === "close_window") {
            // Forward close request to owner worker
            const guiEvent: IGUIEventIPC = {
              type: "GUI_EVENT",
              wid: event.wid,
              targetId: "__window__",
              eventType: "close_window",
            };
            await shell.send(entry.pid, guiEvent);
            broadcastToAll({ type: "DESTROY_WINDOW", wid: event.wid }, true);
            return;
          }

          if (event.eventType === "minimize_window") {
            const guiEvent: IGUIEventIPC = {
              type: "GUI_EVENT",
              wid: event.wid,
              targetId: "__window__",
              eventType: "minimize_window",
            };
            await shell.send(entry.pid, guiEvent);
            broadcastToAll({ type: "MINIMIZE_WINDOW", wid: event.wid }, true);
            return;
          }

          if (event.eventType === "restore_window") {
            const guiEvent: IGUIEventIPC = {
              type: "GUI_EVENT",
              wid: event.wid,
              targetId: "__window__",
              eventType: "restore_window",
            };
            await shell.send(entry.pid, guiEvent);
            broadcastToAll({ type: "RESTORE_WINDOW", wid: event.wid }, true);
            return;
          }

          if (event.eventType === "maximize_window") {
            // Hormati flag maximizable — window yang tidak bisa maximize
            // tidak boleh di-maximize lewat jalur mana pun.
            if (entry.maximizable === false) return;
            const guiEvent: IGUIEventIPC = {
              type: "GUI_EVENT",
              wid: event.wid,
              targetId: "__window__",
              eventType: "maximize_window",
            };
            await shell.send(entry.pid, guiEvent);
            entry.isMaximized = true;
            broadcastToAll({ type: "MAXIMIZE_WINDOW", wid: event.wid }, true);
            return;
          }

          if (event.eventType === "unmaximize_window") {
            const guiEvent: IGUIEventIPC = {
              type: "GUI_EVENT",
              wid: event.wid,
              targetId: "__window__",
              eventType: "unmaximize_window",
            };
            await shell.send(entry.pid, guiEvent);
            entry.isMaximized = false;
            broadcastToAll({ type: "UNMAXIMIZE_WINDOW", wid: event.wid }, true);
            return;
          }

          // cm_save relay: browser → app (Ctrl+S in CodeMirror)
          if (event.eventType === "cm_save") {
            const guiEvent: IGUIEventIPC = {
              type: "GUI_EVENT",
              wid: event.wid,
              targetId: event.targetId,
              eventType: "cm_save",
              value: event.value,
            };
            await shell.send(entry.pid, guiEvent);
            return;
          }

          // contextmenu relay: app element right-click → app
          if (event.eventType === "contextmenu") {
            const guiEvent: IGUIEventIPC = {
              type: "GUI_EVENT",
              wid: event.wid,
              targetId: event.targetId,
              eventType: "contextmenu",
              value: event.value,
            };
            await shell.send(entry.pid, guiEvent);
            return;
          }

          // Handle window_state from browser (position/size sync)
          if (event.eventType === "window_state" && event.value) {
            try {
              const st =
                typeof event.value === "string"
                  ? JSON.parse(event.value)
                  : event.value;
              if (st.left !== undefined) entry.winLeft = st.left;
              if (st.top !== undefined) entry.winTop = st.top;
              if (st.width !== undefined) entry.winWidth = st.width;
              if (st.height !== undefined) entry.winHeight = st.height;
              if (st.isMaximized !== undefined)
                entry.isMaximized = st.isMaximized;
            } catch (_) {
              /* ignore */
            }
            return;
          }

          // Focus window on any interaction
          if (entry.wsClientId === wsClientId) {
            entry.zIndex = nextZIndex++;
            entry.focused = true;
            windows.forEach((w) => {
              if (w.wid !== entry.wid) w.focused = false;
            });

            broadcastToAll({ type: "FOCUS", wid: entry.wid }, true);
          }

          // Forward event to owner worker
          const guiEvent: IGUIEventIPC = {
            type: "GUI_EVENT",
            wid: event.wid,
            targetId: event.targetId,
            eventType: event.eventType,
            value:
              event.eventType === "term_resize"
                ? JSON.stringify({
                  cols: (event as any).cols,
                  rows: (event as any).rows,
                })
                : event.value,
          };
          await shell.send(entry.pid, guiEvent);
        } catch (e) {
          /* ignore malformed messages */
        }
      });

      socket.on("close", async () => {
        wsClients.delete(wsClientId);
        await std.log(`[dome] Browser disconnected: ${wsClientId}`, "dome");
      });
    });

    // TERM_OUTPUT relay: worker â†’ DOME â†’ browser (via SEND_MSG, not GUI_REQ)
    (global as any)._tsixLib.onEvent("ipc_message", async (msg: any) => {
      // Sender PID dari kernel (SEND_MSG) — buat attribusi traffic per-app
      currentSrcPid = (msg as any)?.fromPid || 0;
      const payload = msg?.data;
      if (payload?.type === "TERM_OUTPUT") {
        broadcastToAll({
          type: "TERM_OUTPUT",
          wid: payload.wid,
          targetId: payload.targetId,
          data: payload.data,
        });
      }
      // CM_SET_VALUE relay: Eucalyptus â†’ DOME â†’ browser
      if (payload?.type === "CM_SET_VALUE") {
        broadcastToAll({
          type: "CM_SET_VALUE",
          wid: payload.wid,
          targetId: payload.targetId,
          value: payload.value,
        });
      }
      // CM_SET_THEME relay: Eucalyptus â†' DOME â†' browser (update CodeMirror theme)
      if (payload?.type === "CM_SET_THEME") {
        broadcastToAll({
          type: "CM_SET_THEME",
          wid: payload.wid,
          targetId: payload.targetId,
          theme: payload.theme,
        });
      }
      // CHART_INIT relay: cashew â†' DOME â†' browser (create uPlot)
      if (payload?.type === "CHART_INIT") {
        void std.log(`[dome] CHART_INIT: wid=${payload.wid} targetId=${payload.targetId}`, "dome");
        broadcastToAll({
          type: "CHART_INIT",
          wid: payload.wid,
          targetId: payload.targetId,
          opts: payload.opts,
        });
      }
      // CHART_DATA relay: cashew â†' DOME â†' browser (update uPlot data)
      if (payload?.type === "CHART_DATA") {
        void std.log(`[dome] CHART_DATA: wid=${payload.wid} targetId=${payload.targetId} dataLen=${payload.data?.[0]?.length || 0}`, "dome");
        broadcastToAll({
          type: "CHART_DATA",
          wid: payload.wid,
          targetId: payload.targetId,
          data: payload.data,
        });
      }
      // CHART_DESTROY relay: cashew â†' DOME â†' browser (destroy uPlot)
      if (payload?.type === "CHART_DESTROY") {
        void std.log(`[dome] CHART_DESTROY: wid=${payload.wid} targetId=${payload.targetId}`, "dome");
        broadcastToAll({
          type: "CHART_DESTROY",
          wid: payload.wid,
          targetId: payload.targetId,
        });
      }
      // DDC_MSG relay: TGA â†' DOME â†' browser (native JS widget → NJ.onMessage)
      if (payload?.type === "DDC_MSG") {
        broadcastToAll({
          type: "DDC_MSG",
          wid: payload.wid,
          targetId: payload.targetId,
          data: payload.data,
        });
      }
      // DDC_RESIZE relay: TGA â†' DOME â†' browser (ubah ukuran canvas)
      if (payload?.type === "DDC_RESIZE") {
        broadcastToAll({
          type: "DDC_RESIZE",
          wid: payload.wid,
          targetId: payload.targetId,
          width: payload.width,
          height: payload.height,
        });
      }
      // DDC_STOP relay: TGA â†' DOME â†' browser (hentikan NJ + cleanup)
      if (payload?.type === "DDC_STOP") {
        broadcastToAll({
          type: "DDC_STOP",
          wid: payload.wid,
          targetId: payload.targetId,
        });
      }
      // TB_DATA relay: emerald/cashew â†' DOME â†' browser (Tabulator setData)
      if (payload?.type === "TB_DATA") {
        broadcastToAll({
          type: "TB_DATA",
          wid: payload.wid,
          targetId: payload.targetId,
          rows: payload.rows,
        });
      }
      // TB_APPEND relay: emerald/cashew â†' DOME â†' browser (Tabulator addData)
      if (payload?.type === "TB_APPEND") {
        broadcastToAll({
          type: "TB_APPEND",
          wid: payload.wid,
          targetId: payload.targetId,
          rows: payload.rows,
        });
      }
      // TB_COLS relay: emerald/cashew â†' DOME â†' browser (Tabulator setColumns)
      if (payload?.type === "TB_COLS") {
        broadcastToAll({
          type: "TB_COLS",
          wid: payload.wid,
          targetId: payload.targetId,
          cols: payload.cols,
        });
      }
      // TB_SORT relay: emerald/cashew â†' DOME â†' browser (Tabulator setSort)
      if (payload?.type === "TB_SORT") {
        broadcastToAll({
          type: "TB_SORT",
          wid: payload.wid,
          targetId: payload.targetId,
          key: payload.key,
          dir: payload.dir,
        });
      }
      // TB_SELECT relay: emerald/cashew â†' DOME â†' browser (select row by key)
      if (payload?.type === "TB_SELECT") {
        broadcastToAll({
          type: "TB_SELECT",
          wid: payload.wid,
          targetId: payload.targetId,
          key: payload.key,
        });
      }
      // TB_CLEAR_SELECT relay: emerald/cashew â†' DOME â†' browser (deselect all)
      if (payload?.type === "TB_CLEAR_SELECT") {
        broadcastToAll({
          type: "TB_CLEAR_SELECT",
          wid: payload.wid,
          targetId: payload.targetId,
        });
      }
      // TB_DESTROY relay: emerald/cashew â†' DOME â†' browser (destroy grid)
      if (payload?.type === "TB_DESTROY") {
        broadcastToAll({
          type: "TB_DESTROY",
          wid: payload.wid,
          targetId: payload.targetId,
        });
      }
      // TB_THEME relay: emerald â†' DOME â†' browser (warna theme aktif ke grid)
      if (payload?.type === "TB_THEME") {
        broadcastToAll({
          type: "TB_THEME",
          wid: payload.wid,
          targetId: payload.targetId,
          colors: payload.colors,
        });
      }
      // TERM_THEME relay: pixelterm â†' DOME â†' browser (update xterm theme)
      if (payload?.type === "TERM_THEME") {
        broadcastToAll({
          type: "TERM_THEME",
          wid: payload.wid,
          targetId: payload.targetId,
          colors: payload.colors,
        });
      } // WINDOW_TITLE relay: pixelterm â†' DOME â†' browser (update titlebar)
      if (payload?.type === "WINDOW_TITLE") {
        broadcastToAll({
          type: "WINDOW_TITLE",
          wid: payload.wid,
          title: payload.title,
        });
      }      // WINDOW_THEME relay: theme.applyToDome() → DOME → browser (update CSS vars)
      if (payload?.type === "WINDOW_THEME") {
        lastThemeColors = payload.colors || null;
        broadcastToAll({
          type: "WINDOW_THEME",
          wid: payload.wid,
          colors: payload.colors,
        });
      }
      // THEME_CHANGED broadcast: theme.switchTo() → DOME → semua app + browser
      if (payload?.type === "THEME_CHANGED") {
        // Broadcast ke semua browser
        broadcastToAll({
          type: "THEME_CHANGED",
          theme: payload.theme,
          dir: payload.dir,
        });
        // Forward ke semua app process
        const knownPids = new Set<number>();
        for (const [, win] of windows) {
          if (win.pid && !knownPids.has(win.pid)) {
            knownPids.add(win.pid);
            try {
              await shell.send(win.pid, {
                type: "THEME_CHANGED",
                theme: payload.theme,
                dir: payload.dir,
              });
            } catch (_) { /* app might be gone */ }
          }
        }
        return;
      }
      // PLAY_SOUND relay: app → DOME → browser (audio)
      // name: suara dari cache preload (SFX_PRELOAD); data: base64 langsung (legacy)
      if (payload?.type === "PLAY_SOUND") {
        broadcastToAll({
          type: "PLAY_SOUND",
          name: payload.name,
          data: payload.data,
        });
      }
      // SFX_PRELOAD relay: app → DOME → browser — kirim data suara SEKALI
      // (browser simpan di cache), biar PLAY_SOUND cukup kirim nama (hemat WS).
      if (payload?.type === "SFX_PRELOAD") {
        broadcastToAll({
          type: "SFX_PRELOAD",
          name: payload.name,
          data: payload.data,
        });
      }
      // RES_LOAD relay: ResourceBank (app) → DOME → browser (cache per-window)
      if (payload?.type === "RES_LOAD") {
        broadcastToAll({
          type: "RES_LOAD",
          wid: payload.wid,
          key: payload.key,
          resType: payload.resType,
          mime: payload.mime,
          data: payload.data,
        });
      }
      // TERM_FOCUS relay: pixelterm → DOME → browser (fokus textarea xterm)
      if (payload?.type === "TERM_FOCUS") {
        broadcastToAll({
          type: "TERM_FOCUS",
          wid: payload.wid,
          targetId: payload.targetId,
        });
      }
      // TRAFFIC_QUERY: respond with current WS traffic stats, then reset counters.
      // Observer effect fix: traffic milik app yang bertanya (self) di-exclude,
      // jadi monitor tidak menghitung visualisasi-nya sendiri.
      if (payload?.type === "TRAFFIC_QUERY" && payload?.pid) {
        const self = appTraffic.get(payload.pid) || { txBytes: 0, txPkts: 0 };
        const appTx = Math.max(0, wsTraffic.txBytes - browserTraffic.txBytes);
        const appTxPkts = Math.max(0, wsTraffic.txPkts - browserTraffic.txPkts);
        const stats = {
          ...wsTraffic,
          browserTxBytes: browserTraffic.txBytes,
          browserTxPkts: browserTraffic.txPkts,
          appTxBytes: Math.max(0, appTx - self.txBytes),
          appTxPkts: Math.max(0, appTxPkts - self.txPkts),
          txBytes: Math.max(0, wsTraffic.txBytes - self.txBytes),
          txPkts: Math.max(0, wsTraffic.txPkts - self.txPkts),
          selfTxBytes: self.txBytes,
          selfTxPkts: self.txPkts,
          time: Date.now(),
        };
        wsTraffic = { rxBytes: 0, rxPkts: 0, txBytes: 0, txPkts: 0 };
        browserTraffic = { txBytes: 0, txPkts: 0 };
        appTraffic.clear(); // reset per-app accounting tiap interval
        try { await shell.send(payload.pid, { type: "TRAFFIC_STATS", stats }); } catch (_) { }
      }
    });

    // ============================================================
    // RELAY FROM KERNEL (gui_request events)
    // ============================================================
    (global as any)._tsixLib.onEvent("gui_request", (payload: IGUIPayload) => {
      const { wid, action, pid, node, targetId, props } = payload;
      // Attribusi traffic render GUI ke app pemilik (observer bisa exclude diri)
      currentSrcPid = pid || 0;

      switch (action) {
        case GUIAction.CREATE_WINDOW: {
          const entry: GuedWindowEntry = {
            wid,
            pid,
            title: node?.props?.title || "Untitled",
            zIndex: nextZIndex++,
            focused: true,
            wsClientId: null,
            createdAt: Date.now(),
            fullscreen: node?.props?.fullscreen || false,
            width: node?.props?.width,
            height: node?.props?.height,
            resizable: node?.props?.resizable ?? true,
            frameless: node?.props?.frameless || false,
            maximizable: node?.props?.maximizable ?? true,
          };
          windows.set(wid, entry);
          windowStates.set(wid, []); // Init state history
          windows.forEach((w) => {
            if (w.wid !== wid) w.focused = false;
          });

          broadcastToAll({
            type: "CREATE_WINDOW",
            wid,
            pid,
            title: entry.title,
            icon: node?.props?.icon || "▶️",
            fullscreen: node?.props?.fullscreen || false,
            width: entry.width,
            height: entry.height,
            resizable: entry.resizable,
            frameless: node?.props?.frameless || false,
            maximizable: entry.maximizable,
            posX: node?.props?.posX,
            posY: node?.props?.posY,
            centered: node?.props?.centered || false,
          });
          break;
        }

        case GUIAction.DESTROY_WINDOW: {
          windows.delete(wid);
          windowStates.delete(wid);
          broadcastToAll({ type: "DESTROY_WINDOW", wid });
          break;
        }

        case GUIAction.MINIMIZE_WINDOW: {
          broadcastToAll({ type: "MINIMIZE_WINDOW", wid });
          break;
        }

        case GUIAction.RESTORE_WINDOW: {
          broadcastToAll({ type: "RESTORE_WINDOW", wid });
          break;
        }

        case GUIAction.MAXIMIZE_WINDOW: {
          // Hormati flag maximizable dari window entry
          if (windows.get(wid)?.maximizable === false) break;
          broadcastToAll({ type: "MAXIMIZE_WINDOW", wid });
          break;
        }

        case GUIAction.UNMAXIMIZE_WINDOW: {
          broadcastToAll({ type: "UNMAXIMIZE_WINDOW", wid });
          break;
        }

        case GUIAction.MOUNT_NODE: {
          if (node) {
            const msg = {
              type: "MOUNT_NODE",
              wid,
              node,
              targetId: targetId || undefined,
            };
            const states = windowStates.get(wid) || [];
            states.push(msg);
            windowStates.set(wid, states);
            broadcastToAll(msg);
          }
          break;
        }

        case GUIAction.UNMOUNT_NODE: {
          if (targetId) {
            pruneWindowState(wid, targetId);
            broadcastToAll({ type: "UNMOUNT_NODE", wid, targetId });
          }
          break;
        }

        case GUIAction.UPDATE_PROPS: {
          if (targetId && props) {
            const msg = { type: "UPDATE_PROPS", wid, targetId, props };
            const states = windowStates.get(wid) || [];
            states.push(msg);
            windowStates.set(wid, states);
            broadcastToAll(msg);
          }
          break;
        }
      }
    });

    // ============================================================
    // HELPERS
    // ============================================================
    const broadcastToAll = (message: any, fromBrowser: boolean = false): void => {
      const json = JSON.stringify(message);
      const bytes = Buffer.byteLength(json, "utf8");
      const totalBytes = bytes * wsClients.size;
      const totalPkts = wsClients.size;
      wsTraffic.txBytes += totalBytes;
      wsTraffic.txPkts += totalPkts;
      if (fromBrowser) {
        browserTraffic.txBytes += totalBytes;
        browserTraffic.txPkts += totalPkts;
      }
      // Catat per-app (biar observer seperti traffic monitor bisa exclude diri)
      if (!fromBrowser && currentSrcPid) {
        const t = appTraffic.get(currentSrcPid) || { txBytes: 0, txPkts: 0 };
        t.txBytes += totalBytes;
        t.txPkts += totalPkts;
        appTraffic.set(currentSrcPid, t);
      }
      wsClients.forEach((client) => {
        if (client.readyState === 1) {
          // WebSocket.OPEN
          client.send(json);
        }
      });
    };

    // ============================================================
    // STARTUP
    // ============================================================
    server.listen(PORT, async () => {
      await std.println(
        `[dome] PixelSpace Display Server listening on http://localhost:${PORT}`,
      );
      await std.log(
        `[dome] DOME started on port ${PORT} (PID ${myPid})`,
        "dome",
      );
      // Tandai DOME siap — ditunggu /etc/rc.local sebelum start Asteracea.
      // Ditulis HANYA setelah server listen, artinya DOME sudah daemonize +
      // terdaftar sebagai GUI daemon di Kernel (REGISTER_DAEMON lebih awal).
      try {
        await fs.mkdir("/var/run");
        await fs.writeFile("/var/run/dome.ready", String(myPid));
        await std.log(
          "[dome] Ready marker written: /var/run/dome.ready",
          "dome",
        );
      } catch (e: any) {
        await std.log(
          `[dome] Warning: failed to write ready marker: ${e.message}`,
          "dome",
        );
      }
    });

    // Stay alive forever
    while (true) {
      await new Promise((r) => setTimeout(r, 10000));
    }
  } catch (e: any) {
    await std.log(`[dome] CRASH: ${e.message} â€” ${e.stack}`, "dome");
    await std.println(`[dome] FATAL: ${e.message}`);
  }
});
