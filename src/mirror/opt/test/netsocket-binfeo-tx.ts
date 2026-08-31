import { Program, std, NetSocket } from "@tsix/Application";

/**
 * NETSOCKET BINFEO TX — Example sender using the ENCRYPTED binary protocol.
 *
 * `Binfeo` adalah protocol biner yang BISA dienkripsi untuk komunikasi NORMAL
 * (BUKAN untuk ESP OTA). Payload dikirim sebagai Buffer, DIENKRIPSI ChaCha20
 * oleh driver (per-srcPort), dan byte mentah tetap utuh sampai receiver.
 *
 * Flow:
 *   1. `new NetSocket({ port: 0, key, protocol: "Binfeo" })` — port random
 *      (ephemeral) dari kernel; `sock.port` = port ASLI setelah open()
 *   2. `onData` sebelum `open()` — biar TX bisa menerima balasan
 *   3. `open()` — socket + bind + set protocol per-port = Binfeo
 *   4. `upgradeSecurity()` — switch ke ChaCha20-Poly1305 (key utk port asli)
 *   5. `sendTo(addr, port, Buffer)` — kirim byte mentah (terenkripsi)
 *   6. `waitClosed()` + `close()`
 *
 * Run:  netsocket-binfeo-tx [address] [port]
 * (default address "localhost", port 2700 — pair with `netsocket-binfeo-rx`)
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
  const targetPort = parseInt(args[1] || "2700", 10);

  const sock = new NetSocket({ port: 0, key: KEY_HEX, protocol: "Binfeo" });

  sock.onData = (pkt) => {
    std.println(
      `${yellow}[TX] ← ${pkt.src}:${pkt.port} (local ${pkt.localPort}) -> ${pkt.data}${reset}`,
    );
  };

  await sock.open();
  await std.println(
    `${green}[TX] Binfeo socket ready (local port ${sock.port} — assigned by kernel, PLAIN)${reset}`,
  );

  await sock.upgradeSecurity();
  await std.println(
    `${green}[TX] Mode: ${sock.isSecured ? "ChaCha20-Poly1305 ACTIVE (Binfeo)" : "PLAIN"} (isSecured=${sock.isSecured})${reset}`,
  );

  // Kirim byte mentah yang sengaja berisi byte >= 0x80 — bukti protocol biner
  // terenkripsi ini tidak merusak data biner (berbeda dari jalur string).
  setTimeout(async () => {
    const payload = Buffer.from([
      0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff, 0x42,
    ]);
    const ok = await sock.sendTo(targetAddr, targetPort, payload);
    std.println(
      `${ok ? green : red}[TX] -> ${targetAddr}:${targetPort} ${ok ? "OK" : "FAILED"}${reset}  ${cyan}hex=${payload.toString("hex")}${reset}`,
    );
  }, 1500);

  await sock.waitClosed();
  await sock.close();
  await std.println(
    `${yellow}[TX] Done. Socket closed (port released).${reset}`,
  );
});
