import { UserLib } from "@tsix/UserLib";

const SERVICE_ID = "jayalaras.service";
const CONFIG_PATH = "/etc/smartbulb/config.json";
const DEFAULT_PORT = 45452;
const DEFAULT_STATIC_ROOT = "/opt/smartbulb";

// Legacy setLight(id, value) compatibility. index.html lama mengirim bulb id
// sebagai argumen; gateway menerjemahkan id tersebut ke port logika relay NOS.
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

const BINARY_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif"]);

/** Normalize a URL path without importing the host `path` module. */
function safeRelativePath(requestUrl: string): string | null {
  const rawPath = (requestUrl || "/").split("?", 1)[0];
  const decoded = decodeURIComponent(rawPath);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const parts = relative.split("/");
  const safe: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") return null;
    safe.push(part);
  }
  return safe.join("/") || "index.html";
}

function fileExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot).toLowerCase() : "";
}

export default class SmartBulbWebGateway {
  async execute(lib: UserLib, args: string[]) {
    const { std, shell, fs, web } = lib;
    if (args.includes("--help") || args.includes("-h")) {
      await std.print(
        "Usage: web-gateway [port]\nLegacy JayaLaras WebSocket gateway.\n",
      );
      return;
    }

    let config: any = {
      webGateway: { port: DEFAULT_PORT, staticRoot: DEFAULT_STATIC_ROOT },
    };
    try {
      const rawConfig = await fs.readFile(CONFIG_PATH);
      if (rawConfig) config = { ...config, ...JSON.parse(String(rawConfig)) };
    } catch (_) {
      await std.log(
        `[smartbulb-web] Config tidak ditemukan/invalid (${CONFIG_PATH}), memakai default`,
      );
    }
    const webConfig = config.webGateway || {};
    const requestedPort = Number.parseInt(
      args[0] || String(webConfig.port || DEFAULT_PORT),
      10,
    );
    const port = Number.isFinite(requestedPort) ? requestedPort : DEFAULT_PORT;
    const staticRoot = String(webConfig.staticRoot || DEFAULT_STATIC_ROOT);

    await shell.daemonize("JayaLaras Smart Bulb Web Gateway");

    let latestState: any = {
      ports: Array(16).fill(0),
      switches: Array(16).fill(0),
      manual: 0,
    };
    const pendingGet = new Set<(state: any) => void>();
    let stopping = false;

    const sendService = async (message: Record<string, any>) => {
      await shell.send(SERVICE_ID, message);
    };

    const sendLegacyState = async (clientId: string) => {
      await web.send(clientId, {
        protocol: "MQTT",
        topic: "jayalarasiot/portstates",
        // local.html expects the legacy NOS payload format: "value <bits>".
        ret: `value ${latestState.ports.join("")}`,
      });
    };

    const broadcastState = async () => {
      await web.broadcast({
        protocol: "MQTT",
        topic: "jayalarasiot/portstates",
        ret: `value ${latestState.ports.join("")}`,
      });
      const waiters = [...pendingGet];
      pendingGet.clear();
      for (const resolve of waiters) resolve(latestState);
    };

    lib.onEvent("ipc_message", (message: any) => {
      const payload = message?.data || message;
      if (!payload || payload.type !== "SMARTBULB_STATE") return;
      latestState = payload;
      void broadcastState();
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
        const waiter = () => finish(latestState);
        pendingGet.add(waiter);
        setTimeout(() => {
          pendingGet.delete(waiter);
          finish(latestState);
        }, 2000);
      });
      await sendService({ type: "GET" });
      await statePromise;
      return latestState;
    };

    const respondJson = async (reqId: number, status: number, value: any) => {
      await web.respond(
        reqId,
        status,
        "application/json; charset=utf-8",
        JSON.stringify(value),
      );
    };

    const respondRpc = async (clientId: string, request: any) => {
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
          const mappedPort = LEGACY_ID_TO_PORT[idValue];
          if (!Number.isInteger(mappedPort)) throw new Error("invalid light id");
          await sendService({ type: "SET", port: mappedPort, on });
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
            const mappedPort = Number(match[1]);
            if (mappedPort < 0 || mappedPort > 15) {
              throw new Error("invalid port");
            }
            await sendService({
              type: "SET",
              port: mappedPort,
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

      await web.send(clientId, { protocol: "RFC", id, ret });
    };

    web.on("request", async (request: any) => {
      const relative = safeRelativePath(request.url);
      if (!relative) {
        await web.respond(
          request.reqId,
          400,
          "text/plain; charset=utf-8",
          "Bad path\n",
        );
        return;
      }

      try {
        const raw: any = await fs.readFile(`${staticRoot}/${relative}`);
        if (raw === null || raw === undefined) throw new Error("not found");
        const ext = fileExtension(relative);
        const contentType = MIME[ext] || "application/octet-stream";
        const binary = BINARY_EXTENSIONS.has(ext);
        const body = Buffer.isBuffer(raw)
          ? raw.toString(binary ? "latin1" : "utf8")
          : String(raw);
        await web.respond(
          request.reqId,
          200,
          contentType,
          body,
          { "Cache-Control": "no-cache" },
          binary ? "latin1" : "utf8",
        );
      } catch (_) {
        await web.respond(
          request.reqId,
          404,
          "text/plain; charset=utf-8",
          "Not found\n",
        );
      }
    });

    web.on("connection", async (connection: any) => {
      await sendLegacyState(connection.clientId);
    });
    web.on("message", async (message: any) => {
      try {
        await respondRpc(message.clientId, JSON.parse(message.data));
      } catch (_) {
        await web.send(message.clientId, {
          protocol: "RFC",
          id: null,
          ret: { error: "invalid JSON" },
        });
      }
    });
    web.on("close", async () => {});
    web.on("error", async (error: any) => {
      await std.log(
        `[smartbulb-web] ${error?.message || error} (${error?.source || "web"})`,
      );
    });

    const started = await web.start(port, "both");
    if (!started.ok) {
      await std.log(
        `[smartbulb-web] gagal listen port ${port}: ${started.error}`,
      );
      await sendService({ type: "UNREGISTER" }).catch(() => {});
      return;
    }
    await std.log(`[smartbulb-web] listening on http://0.0.0.0:${port}`);

    lib.onEvent("signal", async (signal: any) => {
      if (signal !== "SIGTERM" || stopping) return;
      stopping = true;
      await sendService({ type: "UNREGISTER" }).catch(() => {});
      await shell.exit(0);
    });

    await new Promise<never>(() => {});
  }
}
