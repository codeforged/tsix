import { Program, std, NetSocket } from "@tsix/Application";

/**
 * NETSOCKET TX — Example sender using NetSocket (Cashew-style).
 *
 * Flow shown:
 *   1. `new NetSocket({ port, key })` — bind a FIXED local port
 *   2. Set `onData` BEFORE `open()` — the event-driven recv loop only starts
 *      if `onData` is already attached when `open()` runs (so TX can receive
 *      the reply/pong back from the receiver)
 *   3. `open()` — socket + bind (PLAIN first)
 *   4. `upgradeSecurity()` — explicit switch to ChaCha20-Poly1305
 *   5. `sendTo(addr, port, data)` — send a message (here via setTimeout)
 *   6. `waitClosed()` + `close()` — keep alive until closed, then release
 *
 * ⚠️ Why must the TX port be FIXED (not 0)? MQTNL encrypts per srcPort — the
 * session key from `upgradeSecurity()` is attached to that port. With an
 * ephemeral port 0 the key lands on the wrong port and the payload is sent
 * plaintext (a secured receiver will fail to decrypt).
 *
 * ⚠️ Encrypted mode is ON here — make sure the receiver also calls
 * `upgradeSecurity()` with the same key (e.g. netsocket-rx).
 *
 * Run:  netsocket-tx [address] [port]
 * (default address "localhost", port 2500 — pair with `netsocket-rx`)
 */

const KEY_HEX =
  "81ff71ed574e54597690ae7b04e4ef5fc87497fe10b6b037cb031af7c7d67619";

const green = "\x1b[92m";
const yellow = "\x1b[93m";
const cyan = "\x1b[96m";
const red = "\x1b[91m";
const reset = "\x1b[0m";

export const main = Program(async (args: string[]) => {
  const targetAddr = args[0] || "localhost";
  const targetPort = parseInt(args[1] || "2500", 10);
  const myPort = 2501; // fixed local port so per-srcPort encryption works

  const sock = new NetSocket({ port: myPort, key: KEY_HEX });

  // Set onData BEFORE open() — the event-driven recv loop only starts when
  // onData is already attached at open() time. If set afterwards, TX will
  // never receive the reply (pong) from the receiver.
  sock.onData = (pkt) => {
    std.println(
      `${yellow}[RX] ${pkt.src}:${pkt.port} (local ${pkt.localPort}) -> ${pkt.data}${reset}`,
    );
  };

  await sock.open();
  await std.println(
    `${green}[TX] Socket ready (local port ${sock.port}, PLAIN)${reset}`,
  );

  // Switch to secure mode EXPLICITLY (encrypted). The receiver must do the
  // same with the same key.
  await sock.upgradeSecurity();
  await std.println(
    `${green}[TX] Mode: ${sock.isSecured ? "ChaCha20-Poly1305 ACTIVE" : "PLAIN (no encryption)"} (isSecured=${sock.isSecured})${reset}`,
  );

  // Send a message after 2s so the receiver has time to be ready.
  setTimeout(async () => {
    const msg = JSON.stringify({
      seq: 100,
      from: "netsocket-tx",
      ts: Date.now(),
    });
    const ok = await sock.sendTo(targetAddr, targetPort, msg);
    std.println(`${ok ? green : red}[TX] -> ${targetAddr}:${targetPort} ${ok ? "OK" : "FAILED"}${reset}  ${cyan}${msg}${reset}`);
  }, 2000);

  await sock.waitClosed();
  // Close: release port + normalize security agent (idempotent).
  await sock.close();
  await std.println(
    `${yellow}[TX] Done. Socket closed (port released).${reset}`,
  );
});
