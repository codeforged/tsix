import { Program, std, NetSocket } from "@tsix/Application";

/**
 * NETSOCKET RX — Example receiver using NetSocket (Cashew-style).
 *
 * Flow shown:
 *   1. `new NetSocket({ port, key })` — configure via object literal
 *   2. `onData` / `onError` — event handlers (not a manual recv() loop)
 *   3. `open()` — socket + bind (PLAIN first, security is NOT automatic)
 *   4. `upgradeSecurity()` — explicit switch to ChaCha20-Poly1305
 *   5. `waitClosed()` — keep the process alive until the socket closes (Ctrl+C)
 *
 * The event-driven pattern is used here: set `onData` BEFORE `open()`, then
 * `await sock.waitClosed()` to stay alive. The internal loop dispatches each
 * incoming packet to `onData`.
 *
 * Auto-cleanup is ON by default: Ctrl+C → close() (release port + normalize
 * security agent) then exit(130). No manual signal handling needed.
 *
 * Run:  netsocket-rx [port]
 * (default port 2500 — pair with `netsocket-tx`)
 */

const KEY_HEX =
  "81ff71ed574e54597690ae7b04e4ef5fc87497fe10b6b037cb031af7c7d67619";

const green = "\x1b[92m";
const yellow = "\x1b[93m";
const cyan = "\x1b[96m";
const red = "\x1b[91m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";

export const main = Program(async (args: string[]) => {
  const port = parseInt(args[0] || "2500", 10);

  const sock = new NetSocket({ port, key: KEY_HEX });

  // Event-driven: onData is called by the internal loop (started at open()).
  sock.onData = (pkt) => {
    std.println(
      `${yellow}[RX] ${pkt.src}:${pkt.port} (local ${pkt.localPort}) -> ${pkt.data}${reset}`,
    );
    // Reply back (request-response) if needed:
    sock.reply(pkt, "pong");
  };

  sock.onError = (err) => {
    std.println(`${red}[RX] error: ${err.message}${reset}`);
  };

  // 1) Open the socket — plain first.
  await sock.open();
  await std.println(
    `${green}[RX] Listening (PLAIN) on port ${sock.port}...${reset}`,
  );

  // 2) Our own node address (so we know the target for netsocket-tx).
  try {
    const ns = await sock.netstat();
    const iface =
      ns?.interfaces?.find((i: any) => i.deviceName === ns.defaultDevice) ||
      ns?.interfaces?.[0];
    if (iface) {
      await std.println(
        `${dim}[RX] Node address: ${iface.address} (default: ${ns.defaultDevice})${reset}`,
      );
    }
  } catch (_e) {
    /* netstat is optional — failing is not a problem */
  }

  // 3) Switch to secure mode EXPLICITLY (not automatic on open).
  await sock.upgradeSecurity();
  await std.println(
    `${green}[RX] Mode: ${sock.isSecured ? "ChaCha20-Poly1305 ACTIVE" : "PLAIN (no encryption)"} (isSecured=${sock.isSecured}). Waiting for data...${reset}`,
  );

  // 4) Keep the process alive; onData handles incoming packets.
  await sock.waitClosed();

  await std.println(`${cyan}[RX] Socket closed. Bye!${reset}`);
});
