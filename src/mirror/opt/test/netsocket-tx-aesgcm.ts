import { Program, std, NetSocket } from "@tsix/Application";

/**
 * NETSOCKET TX AESGCM — Example sender using a custom encryption agent (Path A).
 *
 * A variant of `netsocket-tx` that picks AES-256-GCM via the custom-agent SOP:
 * `upgradeSecurity(key, { agent: "aes-gcm" })`. Pair it with
 * `netsocket-rx-aesgcm` (both sides must use the SAME agent + the SAME key,
 * because RX decrypts according to the agent attached to its port).
 *
 * Flow:
 *   1. `new NetSocket({ port, key })` — bind a FIXED local port
 *   2. `open()` — socket + bind (PLAIN first)
 *   3. `upgradeSecurity(key, { agent: "aes-gcm" })` — switch to AES-256-GCM
 *   4. `sendTo(addr, port, data)` — send several messages
 *   5. `close()` — release port + normalize agent
 *
 * ⚠️ The TX port must be FIXED (not 0): MQTNL encrypts per-srcPort, so the
 * session key from `upgradeSecurity()` must be attached to the right port.
 *
 * Run:  netsocket-tx-aesgcm [address] [port] [count]
 * (default address "mactsix", port 2600, 3 messages — pair with `netsocket-rx-aesgcm`)
 */

const KEY_HEX =
  "81ff71ed574e54597690ae7b04e4ef5fc87497fe10b6b037cb031af7c7d67619";

const green = "\x1b[92m";
const yellow = "\x1b[93m";
const cyan = "\x1b[96m";
const red = "\x1b[91m";
const reset = "\x1b[0m";

export const main = Program(async (args: string[]) => {
  const targetAddr = args[0] || "mactsix";
  const targetPort = parseInt(args[1] || "2600", 10);
  const count = parseInt(args[2] || "3", 10);
  const myPort = 2601; // fixed local port so per-srcPort encryption works

  const sock = new NetSocket({ port: myPort, key: KEY_HEX });

  await sock.open();
  await std.println(
    `${green}[TX-aesgcm] Socket ready (local port ${sock.port}, PLAIN)${reset}`,
  );

  // Switch to secure mode with the CUSTOM aes-gcm agent (explicit).
  await sock.upgradeSecurity(KEY_HEX, { agent: "aes-gcm" });
  await std.println(
    `${green}[TX-aesgcm] AES-256-GCM ACTIVE (isSecured=${sock.isSecured}, agent=${sock.agent})${reset}`,
  );

  for (let i = 1; i <= count; i++) {
    const msg = JSON.stringify({
      seq: i,
      from: "netsocket-tx-aesgcm",
      ts: Date.now(),
    });
    const ok = await sock.sendTo(targetAddr, targetPort, msg);
    await std.println(
      `${ok ? green : red}[TX-aesgcm] #${i} -> ${targetAddr}:${targetPort} ${ok ? "OK" : "FAILED"}${reset}  ${cyan}${msg}${reset}`,
    );
    if (i < count) await new Promise((r) => setTimeout(r, 500));
  }

  // Close: release port + normalize agent (idempotent).
  await sock.close();
  await std.println(
    `${yellow}[TX-aesgcm] Done. Socket closed (port released).${reset}`,
  );
});
