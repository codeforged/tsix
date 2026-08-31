import { Program, std, NetSocket } from "@tsix/Application";

/**
 * NETSOCKET RX AESGCM — Example receiver using a custom encryption agent (Path A).
 *
 * This variant of `netsocket-rx` shows the custom security-agent SOP:
 * `upgradeSecurity(key, { agent: "aes-gcm" })` — AES-256-GCM, not the default
 * chacha20. The agent is chosen by NAME (string, not a class) because the
 * kernel instantiates it through a registry (SimpleMQTNLDriver.getAgent).
 *
 * Flow:
 *   1. `new NetSocket({ port, key })` — configure via object literal
 *   2. `onData` / `onError` — event handlers
 *   3. `open()` — socket + bind (PLAIN first)
 *   4. `upgradeSecurity(key, { agent: "aes-gcm" })` — switch to AES-256-GCM
 *   5. `waitClosed()` — keep the process alive until the socket closes (Ctrl+C)
 *
 * Auto-cleanup default: Ctrl+C → close() (release port + normalize agent).
 *
 * Run:  netsocket-rx-aesgcm [port]
 * (default port 2600 — pair with `netsocket-tx-aesgcm`)
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
  const port = parseInt(args[0] || "2600", 10);

  const sock = new NetSocket({ port, key: KEY_HEX });

  sock.onData = (pkt) => {
    std.println(
      `${yellow}[RX-aesgcm] ${pkt.src}:${pkt.port} (local ${pkt.localPort}) -> ${pkt.data}${reset}`,
    );
    // Reply back (request-response) if needed:
    //   await sock.reply(pkt, "pong");
  };

  sock.onError = (err) => {
    std.println(`${red}[RX-aesgcm] error: ${err.message}${reset}`);
  };

  // 1) Open the socket — plain first.
  await sock.open();
  await std.println(
    `${green}[RX-aesgcm] Listening (PLAIN) on port ${sock.port}...${reset}`,
  );

  // 2) Our own node address (so we know the target for netsocket-tx-aesgcm).
  try {
    const ns = await sock.netstat();
    const iface =
      ns?.interfaces?.find((i: any) => i.deviceName === ns.defaultDevice) ||
      ns?.interfaces?.[0];
    if (iface) {
      await std.println(
        `${dim}[RX-aesgcm] Node address: ${iface.address} (default: ${ns.defaultDevice})${reset}`,
      );
    }
  } catch (_e) {
    /* netstat is optional — failing is not a problem */
  }

  // 3) Switch to secure mode with the CUSTOM aes-gcm agent (explicit).
  await sock.upgradeSecurity(KEY_HEX, { agent: "aes-gcm" });
  await std.println(
    `${green}[RX-aesgcm] AES-256-GCM ACTIVE (isSecured=${sock.isSecured}, agent=${sock.agent}). Waiting for data...${reset}`,
  );

  // 4) Keep the process alive until the socket closes.
  await sock.waitClosed();
  await std.println(`${cyan}[RX-aesgcm] Socket closed. Bye!${reset}`);
});
