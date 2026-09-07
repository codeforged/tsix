import { IDevice, KContext } from "../IDevice";
import { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";

/**
 * WebSocketDevice — Kernel WebSocket Server Device (/dev/wsd)
 *
 * Bagian WebSocket dari pemisahan "web server" vs "web socket" (lihat juga
 * HttpServerDevice /dev/httpd). Server hidup di KERNEL LAND; userland:
 *
 *   # Mode A: WS standalone (port sendiri)
 *   fd = fs.open("/dev/wsd", "r+");
 *   fs.ioctl(fd, WSD_LISTEN, { port, ownerPid });
 *
 *   # Mode B: WS attach ke HTTP server milik owner yg sama (SATU port)
 *   #  (buka /dev/httpd + LISTEN dulu, baru attach di sini)
 *   fs.ioctl(fd, WSD_ATTACH, { ownerPid });
 *
 *   lib.onEvent("ws_event", cb);      // WS_CONNECT/WS_MESSAGE/WS_CLOSE/...
 *   fs.ioctl(fd, WSD_SEND, { ownerPid, clientId, data });
 *   fs.ioctl(fd, WSD_BROADCAST, { ownerPid, data });
 *   fs.ioctl(fd, WSD_CLOSE, { ownerPid, clientId });
 *
 * Jadi aplikasi bebas: HTTP saja, WS saja, atau dua-duanya (satu port via
 * ATTACH). ioctl codes sinkron dgn contoh `src/mirror/opt/test/webd-demo.ts`.
 *
 * (c) 2026 TSIX Project
 */

// ── ioctl codes (di-share ke userland via contoh webd-demo.ts) ──
export const WSD_LISTEN = 0x5201; // { port, ownerPid } — standalone
export const WSD_ATTACH = 0x5202; // { ownerPid } — attach ke httpd milik owner
export const WSD_SEND = 0x5203; // { ownerPid, clientId, data }
export const WSD_BROADCAST = 0x5204; // { ownerPid, data }
export const WSD_CLOSE = 0x5205; // { ownerPid, clientId }
export const WSD_STATUS = 0x5206; // { ownerPid }

/** Event channel kernel → userland. */
export const WSD_EVENT_CHANNEL = "ws_event";

interface WsCtx {
  ownerPid: number;
  port: number;
  listening: boolean;
  wss: WebSocketServer | null;
  clients: Map<string, any>; // clientId → ws socket
}

export class WebSocketDevice implements IDevice {
  name = "wsd";
  uid = 0;
  gid = 0;
  mode = 0o666;

  private kernel: any;
  private servers = new Map<number, WsCtx>(); // key: ownerPid

  constructor(kernel?: any) {
    this.kernel = kernel || null;
  }

  static autoRegister(kernel: any): void {
    kernel.devices["wsd"] = new WebSocketDevice(kernel);
  }

  public init(ctx: KContext): void {
    ctx.syslog(
      "[wsd] WebSocketDevice siap — WS server kernel land (/dev/wsd)",
    );
  }

  public present(): boolean {
    return true;
  }
  public read(): any {
    return null;
  }
  public write(): boolean {
    return false;
  }

  private emit(ctx: WsCtx, payload: Record<string, any>): void {
    try {
      this.kernel?.scheduler?.sendEvent(
        ctx.ownerPid,
        WSD_EVENT_CHANNEL,
        payload,
      );
    } catch (_) {
      /* ignore */
    }
  }

  private getCtx(ownerPid: number): WsCtx {
    let ctx = this.servers.get(ownerPid);
    if (!ctx) {
      ctx = {
        ownerPid,
        port: 0,
        listening: false,
        wss: null,
        clients: new Map(),
      };
      this.servers.set(ownerPid, ctx);
    }
    return ctx;
  }

  /** Pasang listener bersama untuk sebuah WSS (standalone maupun attach). */
  private wireWss(ctx: WsCtx, wss: WebSocketServer): void {
    wss.on("connection", (socket: any) => {
      const clientId = uuidv4().substring(0, 8);
      ctx.clients.set(clientId, socket);
      this.emit(ctx, { type: "WS_CONNECT", clientId });

      socket.on("message", (data: any, isBinary: boolean) => {
        let text: string;
        try {
          text = isBinary ? data.toString("utf8") : data.toString();
        } catch (_) {
          text = String(data);
        }
        this.emit(ctx, {
          type: "WS_MESSAGE",
          clientId,
          data: text,
          binary: !!isBinary,
        });
      });
      socket.on("close", () => {
        ctx.clients.delete(clientId);
        this.emit(ctx, { type: "WS_CLOSE", clientId });
      });
      socket.on("error", () => {
        ctx.clients.delete(clientId);
      });
    });
  }

  public ioctl(cmd: number, arg: any): any {
    try {
      switch (cmd) {
        // ── Standalone WS server (port sendiri) ──
        case WSD_LISTEN: {
          const { port, ownerPid } = (arg || {}) as {
            port: number;
            ownerPid: number;
          };
          if (!Number.isFinite(port) || port <= 0 || port > 65535)
            return { error: "invalid port" };
          if (!Number.isFinite(ownerPid) || ownerPid <= 0)
            return { error: "invalid ownerPid" };
          const ctx = this.getCtx(ownerPid);
          if (ctx.listening) return { listening: true, port: ctx.port };

          const wss = new WebSocketServer({ port });
          ctx.port = port;
          ctx.wss = wss;
          this.wireWss(ctx, wss);
          wss.on("listening", () => {
            ctx.listening = true;
            this.emit(ctx, { type: "LISTENING", port });
          });
          wss.on("error", (e: any) => {
            this.emit(ctx, {
              type: "LISTEN_ERROR",
              message: e?.message || String(e),
            });
          });
          return { starting: true, port };
        }

        // ── Attach ke HTTP server milik owner (SATU port: HTTP+WS upgrade) ──
        case WSD_ATTACH: {
          const { ownerPid } = (arg || {}) as { ownerPid: number };
          if (!Number.isFinite(ownerPid) || ownerPid <= 0)
            return { error: "invalid ownerPid" };
          const ctx = this.getCtx(ownerPid);
          if (ctx.listening) return { listening: true, port: ctx.port };

          const httpd = this.kernel?.devices?.["httpd"];
          const httpServer = httpd?.getHttpServer?.(ownerPid) || null;
          if (!httpServer) {
            this.emit(ctx, {
              type: "LISTEN_ERROR",
              message: "httpd belum listen utk pid ini (buka /dev/httpd dulu)",
            });
            return { error: "no http server to attach" };
          }
          const wss = new WebSocketServer({ server: httpServer });
          ctx.wss = wss;
          ctx.port = 0; // ikut port httpd (diketahui via httpd status)
          this.wireWss(ctx, wss);
          // Tidak ada port baru — tandai listening segera.
          setImmediate(() => {
            ctx.listening = true;
            this.emit(ctx, { type: "LISTENING", attached: true, ownerPid });
          });
          return { attached: true };
        }

        // ── Kirim per client ──
        case WSD_SEND: {
          const { ownerPid, clientId, data } = (arg || {}) as {
            ownerPid: number;
            clientId: string;
            data: any;
          };
          const socket = this.servers.get(ownerPid)?.clients.get(clientId);
          if (!socket || socket.readyState !== 1) return false;
          socket.send(data);
          return true;
        }

        // ── Broadcast ke semua client ──
        case WSD_BROADCAST: {
          const { ownerPid, data } = (arg || {}) as {
            ownerPid: number;
            data: any;
          };
          const ctx = this.servers.get(ownerPid);
          if (!ctx) return false;
          let sent = 0;
          ctx.clients.forEach((socket) => {
            if (socket.readyState === 1) {
              socket.send(data);
              sent++;
            }
          });
          return sent;
        }

        // ── Tutup satu client ──
        case WSD_CLOSE: {
          const { ownerPid, clientId } = (arg || {}) as {
            ownerPid: number;
            clientId: string;
          };
          const ctx = this.servers.get(ownerPid);
          const socket = ctx?.clients.get(clientId);
          if (!socket) return false;
          try {
            socket.close();
          } catch (_) {
            /* ignore */
          }
          ctx!.clients.delete(clientId);
          return true;
        }

        case WSD_STATUS: {
          const { ownerPid } = (arg || {}) as { ownerPid: number };
          const ctx = this.servers.get(ownerPid);
          if (!ctx) return { listening: false };
          return {
            listening: ctx.listening,
            port: ctx.port,
            clients: ctx.clients.size,
          };
        }

        default:
          return null;
      }
    } catch (e: any) {
      return { error: e?.message || String(e) };
    }
  }
}

export default WebSocketDevice;
