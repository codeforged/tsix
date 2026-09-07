/**
 * test/webd-demo.ts — 🧪 Contoh pemakaian `lib.web` (WebLib)
 *
 * Server HTTP + WebSocket lewat API yang programmer-friendly — tanpa
 * ioctl mentah, tanpa hostRequire("http"/"ws"). Di belakang layar WebLib
 * membungkus device kernel /dev/httpd & /dev/wsd.
 *
 * Mode:
 *   webd-demo [port]              → HTTP + WS SATU port (default)
 *   webd-demo --http-only [port]  → HTTP saja
 *   webd-demo --ws-only [port]    → WS saja (standalone)
 *   webd-demo --help
 *
 * (c) 2026 TSIX Project
 */

import { Program, std } from "@tsix/Application";

const DEFAULT_PORT = 9595;

export const main = Program(async (args: string[]) => {
  if (args.includes("--help") || args.includes("-h")) {
    await std.println("Usage: webd-demo [port] | --http-only [port] | --ws-only [port]");
    await std.println("  Demo lib.web (/dev/httpd + /dev/wsd).");
    return;
  }

  const httpOnly = args.includes("--http-only");
  const wsOnly = args.includes("--ws-only");
  const mode: "both" | "http" | "ws" = wsOnly ? "ws" : httpOnly ? "http" : "both";
  const portArg =
    args.find((a) => !a.startsWith("--") && /^\d+$/.test(a)) ||
    String(DEFAULT_PORT);
  const port = Number.parseInt(portArg, 10);

  const lib = (global as any)._tsixLib;
  const srv = lib?.web;
  if (!lib || !srv) {
    await std.println("❌ lib.web tidak tersedia (UserLib lama? sync ulang).");
    return;
  }

  // ── Handler HTTP ──
  srv.on("request", async (req: any) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/" || url === "/hello") {
      await srv.respond(
        req.reqId,
        200,
        "text/plain; charset=utf-8",
        "TSIX lib.web OK 🚀 (kernel land)\n",
      );
    } else if (url === "/json") {
      await srv.respond(
        req.reqId,
        200,
        "application/json; charset=utf-8",
        JSON.stringify({
          service: "webd-demo",
          api: "lib.web (/dev/httpd + /dev/wsd)",
          pid: lib.getPid(),
          port,
          mode,
          ts: new Date().toISOString(),
        }),
      );
    } else if (url === "/count") {
      const st = await srv.status();
      await srv.respond(
        req.reqId,
        200,
        "application/json; charset=utf-8",
        JSON.stringify({ wsClients: st?.wsClients || 0, pid: lib.getPid() }),
      );
    } else {
      await srv.respond(
        req.reqId,
        404,
        "text/plain; charset=utf-8",
        `Not Found: ${url}\n`,
      );
    }
  });

  // ── Handler WebSocket ──
  srv.on("connection", async (c: any) => {
    await std.println(`   🔌 WS connect: ${c.clientId}`);
    await srv.send(c.clientId, {
      type: "welcome",
      text: "TSIX lib.web connected",
      clientId: c.clientId,
    });
  });
  srv.on("message", async (m: any) => {
    await std.println(`   📩 WS ${m.clientId}: ${m.data}`);
    let msg: any = null;
    try {
      msg = JSON.parse(m.data);
    } catch (_) {
      /* bukan JSON */
    }
    if (msg && typeof msg === "object") {
      if (msg.cmd === "broadcast") {
        await srv.broadcast({ type: "broadcast", msg: msg.msg || "..." });
      } else if (msg.cmd === "count") {
        const st = await srv.status();
        await srv.send(m.clientId, { type: "count", clients: st?.wsClients || 0 });
      } else {
        await srv.send(m.clientId, { type: "echo", back: msg });
      }
    } else {
      await srv.send(m.clientId, { type: "echo", back: m.data });
    }
  });
  srv.on("close", async (c: any) => {
    await std.println(`   📴 WS close: ${c.clientId}`);
  });
  srv.on("error", async (e: any) => {
    await std.println(`⚠️  ${e?.message || e} (${e?.source || "-"})`);
  });

  // ── Mulai ──
  const r = await srv.start(port, mode);
  if (!r.ok) {
    await std.println(`❌ Gagal start (${mode}) port ${port}: ${r.error}`);
    return;
  }
  await std.println(
    mode === "http"
      ? `🌐 [webd-demo] HTTP  http://0.0.0.0:${port}`
      : mode === "ws"
        ? `🔌 [webd-demo] WS    ws://0.0.0.0:${port}`
        : `🌐 [webd-demo] HTTP+WS http(s)://0.0.0.0:${port} (satu port)`,
  );
  await std.println("   (Ctrl+C / kill utk berhenti)");

  while (true) {
    await new Promise((r2) => setTimeout(r2, 5000));
  }
});
