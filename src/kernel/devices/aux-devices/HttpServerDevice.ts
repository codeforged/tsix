import { IDevice, KContext } from "../IDevice";
import * as http from "http";

/**
 * HttpServerDevice — Kernel HTTP Server Device (/dev/httpd)
 *
 * Bagian HTTP dari pemisahan "web server" vs "web socket" (lihat juga
 * WebSocketDevice /dev/wsd). Server hidup di KERNEL LAND; userland cukup:
 *
 *   fd = fs.open("/dev/httpd", "r+");
 *   fs.ioctl(fd, HTTPD_LISTEN, { port, ownerPid });
 *   lib.onEvent("http_event", cb);     // push HTTP_REQUEST / LISTENING / ...
 *   fs.ioctl(fd, HTTPD_RESPOND, { ownerPid, reqId, status, contentType, body });
 *
 * Aplikasi yang butuh WebSocket di port yang SAMA bisa attach /dev/wsd ke
 * server ini (WebSocketDevice.ATTACH_HTTP). ioctl codes sinkron dgn contoh
 * userland `src/mirror/opt/test/webd-demo.ts`.
 *
 * (c) 2026 TSIX Project
 */

// ── ioctl codes (di-share ke userland via contoh webd-demo.ts) ──
export const HTTPD_LISTEN = 0x5101; // { port, ownerPid }
export const HTTPD_RESPOND = 0x5102; // { ownerPid, reqId, status, contentType, body, encoding?, extraHeaders? }
export const HTTPD_STATUS = 0x5103; // { ownerPid }

/** Event channel kernel → userland. */
export const HTTPD_EVENT_CHANNEL = "http_event";

/** HTTP request yang belum dijawab owner → auto 404 setelah timeout. */
const HTTP_REPLY_TIMEOUT_MS = 30000;

interface HttpCtx {
  ownerPid: number;
  port: number;
  listening: boolean;
  httpServer: http.Server | null;
  pending: Map<number, http.ServerResponse>;
  pendingTimers: Map<number, ReturnType<typeof setTimeout>>;
  reqSeq: number;
}

export class HttpServerDevice implements IDevice {
  name = "httpd";
  uid = 0;
  gid = 0;
  mode = 0o666;

  private kernel: any;
  private servers = new Map<number, HttpCtx>(); // key: ownerPid

  constructor(kernel?: any) {
    this.kernel = kernel || null;
  }

  static autoRegister(kernel: any): void {
    kernel.devices["httpd"] = new HttpServerDevice(kernel);
  }

  public init(ctx: KContext): void {
    ctx.syslog(
      "[httpd] HttpServerDevice siap — HTTP server kernel land (/dev/httpd)",
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

  private emit(ctx: HttpCtx, payload: Record<string, any>): void {
    try {
      this.kernel?.scheduler?.sendEvent(
        ctx.ownerPid,
        HTTPD_EVENT_CHANNEL,
        payload,
      );
    } catch (_) {
      /* ignore */
    }
  }

  private getCtx(ownerPid: number): HttpCtx {
    let ctx = this.servers.get(ownerPid);
    if (!ctx) {
      ctx = {
        ownerPid,
        port: 0,
        listening: false,
        httpServer: null,
        pending: new Map(),
        pendingTimers: new Map(),
        reqSeq: 0,
      };
      this.servers.set(ownerPid, ctx);
    }
    return ctx;
  }

  /** Dipakai WebSocketDevice (attach WS ke HTTP server milik owner yg sama). */
  public getHttpServer(ownerPid: number): http.Server | null {
    const ctx = this.servers.get(ownerPid);
    return ctx?.httpServer || null;
  }

  public ioctl(cmd: number, arg: any): any {
    try {
      switch (cmd) {
        case HTTPD_LISTEN: {
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

          const server = http.createServer((req, res) => {
            const reqId = ++ctx.reqSeq;
            ctx.pending.set(reqId, res);
            const timer = setTimeout(() => {
              ctx.pendingTimers.delete(reqId);
              const r = ctx.pending.get(reqId);
              ctx.pending.delete(reqId);
              if (r && !r.writableEnded) {
                try {
                  r.writeHead(404, {
                    "Content-Type": "text/plain; charset=utf-8",
                  });
                  r.end("Not Found (no reply from owner)");
                } catch (_) {
                  /* ignore */
                }
              }
            }, HTTP_REPLY_TIMEOUT_MS);
            ctx.pendingTimers.set(reqId, timer);
            this.emit(ctx, {
              type: "HTTP_REQUEST",
              reqId,
              method: req.method || "GET",
              url: req.url || "/",
              headers: req.headers,
            });
          });
          server.on("error", (e: any) => {
            this.emit(ctx, {
              type: "LISTEN_ERROR",
              message: e?.message || String(e),
            });
          });
          ctx.httpServer = server;
          ctx.port = port;
          server.listen(port, () => {
            ctx.listening = true;
            this.emit(ctx, { type: "LISTENING", port });
          });
          return { starting: true, port };
        }

        case HTTPD_RESPOND: {
          const {
            ownerPid,
            reqId,
            status,
            contentType,
            body,
            encoding,
            extraHeaders,
          } = (arg || {}) as {
            ownerPid: number;
            reqId: number;
            status?: number;
            contentType?: string;
            body?: string | null;
            encoding?: string;
            extraHeaders?: Record<string, string>;
          };
          const ctx = this.servers.get(ownerPid);
          if (!ctx) return { error: "no http server for pid" };
          const res = ctx.pending.get(reqId);
          if (!res) return { error: "unknown reqId" };
          const timer = ctx.pendingTimers.get(reqId);
          if (timer) {
            clearTimeout(timer);
            ctx.pendingTimers.delete(reqId);
          }
          ctx.pending.delete(reqId);
          const headers: Record<string, string> = extraHeaders || {};
          if (contentType) headers["Content-Type"] = contentType;
          try {
            res.writeHead(status || 200, headers);
            res.end(
              body !== undefined && body !== null
                ? Buffer.from(String(body), (encoding as BufferEncoding) || "utf8")
                : undefined,
            );
          } catch (e: any) {
            return { error: e?.message || String(e) };
          }
          return true;
        }

        case HTTPD_STATUS: {
          const { ownerPid } = (arg || {}) as { ownerPid: number };
          const ctx = this.servers.get(ownerPid);
          if (!ctx) return { listening: false };
          return {
            listening: ctx.listening,
            port: ctx.port,
            pendingHttp: ctx.pending.size,
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

export default HttpServerDevice;
