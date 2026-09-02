import { Program, std, NetSocket } from "@tsix/Application";

/**
 * NETSOCKET TX — Example sender using NetSocket (Cashew-style).
 *
 * Flow shown:
 *   1. `new NetSocket({ port, key })` — request a RANDOM available port (0);
 *      after `open()`, `sock.port` holds the ACTUAL port the kernel picked
 *   2. Set `onData` BEFORE `open()` — the event-driven recv loop only starts
 *      if `onData` is already attached when `open()` runs (so TX can receive
 *      the reply/pong back from the receiver)
 *   3. `open()` — socket + bind (PLAIN first)
 *   4. `upgradeSecurity()` — explicit switch to ChaCha20-Poly1305
 *   5. `sendTo(addr, port, data)` — send a message (here via setTimeout)
 *   6. `waitClosed()` + `close()` — keep alive until closed, then release
 *
 * ✅ Port boleh 0 (ephemeral): kernel memilih port random yang available dan
 * `sock.port` otomatis berisi port ASLI hasil pilihan kernel setelah `open()`.
 * MQTNL encrypts per srcPort, jadi `upgradeSecurity()` menempelkan session key
 * ke `sock.port` (port asli) — bukan ke port 0 — sehingga TX aman tetap bisa
 * meng-upgrade security tanpa harus memilih port tetap sendiri.
 *
 * ⚠️ Encrypted mode is ON here — make sure the receiver also calls
 * `upgradeSecurity()` with the same key (e.g. netsocket-rx).
 *
 * Run:  netsocket-tx [address] [port]
 * (default address "localhost", port 2500 — pair with `netsocket-rx`)
 */

const KEY_HEX =
  "5555cca25cb99006aa2243fc09f859575612ec49c27c8885882618317e56a114";

const green = "\x1b[92m";
const yellow = "\x1b[93m";
const cyan = "\x1b[96m";
const red = "\x1b[91m";
const reset = "\x1b[0m";

export const main = Program(async (args: string[]) => {
  const targetAddr = args[0] || "localhost";
  const targetPort = parseInt(args[1] || "2500", 10);
  const myPort = 0; // 0 = minta port random yang available (kernel yang pilih)

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
    `${green}[TX] Socket ready (local port ${sock.port} — assigned by kernel, PLAIN)${reset}`,
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
    std.println(
      `${ok ? green : red}[TX] -> ${targetAddr}:${targetPort} ${ok ? "OK" : "FAILED"}${reset}  ${cyan}${msg}${reset}`,
    );
  }, 2000);

  await sock.waitClosed();
  // Close: release port + normalize security agent (idempotent).
  await sock.close();
  await std.println(
    `${yellow}[TX] Done. Socket closed (port released).${reset}`,
  );
});
