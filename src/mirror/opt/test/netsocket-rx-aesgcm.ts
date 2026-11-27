import { Program, std, NetSocket } from "@tsix/Application";
import { SecurityAgent } from "@common/SecurityAgent";

/** `--key <64 hex>` dari argumen; sisanya dikembalikan apa adanya. */
function takeKeyArg(argv: string[]): { key: string | null; rest: string[] } {
  const i = argv.indexOf("--key");
  if (i < 0) return { key: null, rest: argv };
  const key = argv[i + 1];
  if (!key || !/^[0-9a-fA-F]{64}$/.test(key)) throw new Error("--key must be 64 hex characters (32 bytes)");
  return { key: key.toLowerCase(), rest: argv.filter((_, j) => j !== i && j !== i + 1) };
}

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
 * Run:  netsocket-rx-aesgcm [port] [--key <64 hex>]
 * (default port 2600 — pair with `netsocket-tx-aesgcm`)
 * Without `--key` a random key is generated and printed; pass the same key to
 * `netsocket-tx-aesgcm --key ...`. Keys are never hard-coded: a key written in
 * a public repository is not a secret (SEC-32).
 */

const green = "\x1b[92m";
const yellow = "\x1b[93m";
const cyan = "\x1b[96m";
const red = "\x1b[91m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";

export const main = Program(async (argv: string[]) => {
  const { key, rest: args } = takeKeyArg(argv);
  const KEY_HEX = key ?? SecurityAgent.generateSessionKey().toString("hex");
  if (!key) await std.println(`${cyan}[RX-aesgcm] Generated key (pass to TX with --key): ${KEY_HEX}${reset}`);
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
