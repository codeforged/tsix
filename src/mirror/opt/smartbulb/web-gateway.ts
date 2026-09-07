import { UserLib } from "@tsix/UserLib";

// Capture the host modules before the worker sandbox changes require().
const hostRequire = require;

const SERVICE_ID = "jayalaras.service";
const DEFAULT_PORT = 45452;
const STATIC_ROOT = "/opt/smartbulb";

// Legacy setLight(id, value) compatibility. index.html lama mengirim bulb id
// sebagai argumen; gateway menerjemahkan id tersebut ke port logika relay NOS.
// Tabel ini bisa disesuaikan dengan mapping UI legacy tanpa mengubah HTML.
const LEGACY_ID_TO_PORT = [
  15, 8, 7, 2, 15, 10, 11, 4, 12, 9, 5, 13, 0, 1, 6, 14,
];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

function jsonSend(socket: any, value: any) {
  if (socket.readyState === 1) socket.send(JSON.stringify(value));
}

export default class SmartBulbWebGateway {
  async execute(lib: UserLib, args: string[]) {
    const { std, fs, shell } = lib;
    if (args.includes("--help") || args.includes("-h")) {
      await std.print(
        "Usage: web-gateway [port]\nLegacy JayaLaras WebSocket gateway.\n",
      );
      return;
    }

    const requestedPort = Number.parseInt(args[0] || String(DEFAULT_PORT), 10);
    const port = Number.isFinite(requestedPort) ? requestedPort : DEFAULT_PORT;
    const http = hostRequire("http");
    const WebSocket = hostRequire("ws");
    const path = hostRequire("path");
    const url = hostRequire("url");

    await shell.daemonize("JayaLaras Smart Bulb Web Gateway");

    let latestState: any = {
      ports: Array(16).fill(0),
      switches: Array(16).fill(0),
      manual: 0,
    };
    const clients = new Set<any>();
    const pendingGet = new Set<(state: any) => void>();

    const sendService = async (message: Record<string, any>) => {
      await shell.send(SERVICE_ID, message);
    };

    const sendLegacyState = (socket: any) => {
      // cygRFC.js understands this MQTT envelope; cygnus.rfc.js safely ignores
      // it. This also lets docs/smartbulb/local.html receive live updates.
      jsonSend(socket, {
        protocol: "MQTT",
        topic: "jayalarasiot/portstates",
        // local.html expects the legacy NOS payload format: "value <bits>".
        ret: `value ${latestState.ports.join("")}`,
      });
    };

    const broadcastState = () => {
      for (const socket of clients) sendLegacyState(socket);
      const waiters = [...pendingGet];
      pendingGet.clear();
      for (const resolve of waiters) resolve(latestState);
    };

    lib.onEvent("ipc_message", (message: any) => {
      const payload = message?.data || message;
      if (!payload || payload.type !== "SMARTBULB_STATE") return;
      latestState = payload;
      broadcastState();
    });

    await shell.registerIdentity(`${SERVICE_ID}.web`);
    await sendService({ type: "REGISTER" });

    const getState = async () => {
      const statePromise = new Promise<any>((resolve) => {
        let settled = false;
        const finish = (state: any) => {
          if (settled) return;
          settled = true;
          resolve(state);
        };
        pendingGet.add(() => finish(latestState));
        setTimeout(() => finish(latestState), 2000);
      });
      await sendService({ type: "GET" });
      await statePromise;
      return latestState;
    };

    const handleRpc = async (socket: any, request: any) => {
      const id = request?.id;
      const name = request?.name;
      const params = Array.isArray(request?.params) ? request.params : [];
      let ret: any = 0;

      try {
        if (name === "getAllPortStatus") {
          const state = await getState();
          ret = state.ports;
        } else if (name === "setLight") {
          const idValue = Number(params[0]);
          const on = Boolean(params[1]);
          const port = LEGACY_ID_TO_PORT[idValue];
          if (!Number.isInteger(port)) throw new Error("invalid light id");
          await sendService({ type: "SET", port, on });
          ret = JSON.stringify({ id: idValue, val: on ? 1 : 0 });
        } else if (name === "MQTTsendMsg") {
          const topic = String(params[0] || "");
          const command = String(params[1] || "");
          if (topic !== "jayalarasiot/portstates") {
            throw new Error("unsupported topic");
          }
          if (command === "get") {
            const state = await getState();
            ret = state.ports.join("");
          } else {
            const match = command.match(/^set\s+(\d+)\s*:\s*([01])$/);
            if (!match) throw new Error("invalid portstates command");
            await sendService({
              type: "SET",
              port: Number(match[1]),
              on: match[2] === "1",
            });
            ret = "sent";
          }
        } else {
          throw new Error(`unsupported RPC: ${name}`);
        }
      } catch (error: any) {
        ret = { error: error?.message || String(error) };
      }

      jsonSend(socket, { protocol: "RFC", id, ret });
    };

    const server = http.createServer(async (request: any, response: any) => {
      const pathname = url.parse(request.url || "/").pathname || "/";
      const relative = pathname === "/" ? "index.html" : pathname.slice(1);
      const safe = path.normalize(relative);
      if (safe.startsWith("..") || path.isAbsolute(safe)) {
        response.writeHead(400);
        response.end("Bad path");
        return;
      }
      const vfsPath = `${STATIC_ROOT}/${safe}`;
      try {
        const raw = await fs.readFile(vfsPath);
        if (raw === null || raw === undefined) throw new Error("not found");
        const ext = path.extname(safe).toLowerCase();
        response.writeHead(200, {
          "Content-Type": MIME[ext] || "application/octet-stream",
          "Cache-Control": "no-cache",
        });
        response.end(
          Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), "latin1"),
        );
      } catch (_) {
        response.writeHead(404);
        response.end("Not found");
      }
    });

    const wss = new WebSocket.Server({ server });
    wss.on("connection", (socket: any) => {
      clients.add(socket);
      socket.on("message", (raw: any) => {
        try {
          void handleRpc(socket, JSON.parse(raw.toString()));
        } catch (_) {
          jsonSend(socket, {
            protocol: "RFC",
            id: null,
            ret: { error: "invalid JSON" },
          });
        }
      });
      socket.on("close", () => clients.delete(socket));
      socket.on("error", () => clients.delete(socket));
    });

    let stopping = false;
    const cleanup = async () => {
      if (stopping) return;
      stopping = true;
      await sendService({ type: "UNREGISTER" }).catch(() => {});
      for (const socket of clients) socket.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    lib.onEvent("signal", async (signal: any) => {
      if (signal === "SIGTERM") {
        await cleanup();
        await shell.exit(0);
      }
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "0.0.0.0", () => resolve());
    });
    await std.log(`[smartbulb-web] listening on http://0.0.0.0:${port}`);

    await new Promise<never>(() => {});
  }
}
