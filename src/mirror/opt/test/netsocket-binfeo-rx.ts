import { Program, std, NetSocket } from "@tsix/Application";

/**
 * NETSOCKET BINFEO RX — Example receiver using the ENCRYPTED binary protocol.
 *
 * `Binfeo` adalah protocol biner yang BISA dienkripsi untuk komunikasi NORMAL
 * (BUKAN untuk ESP OTA). Berbeda dari "Binary" (OTA) yang melewati enkripsi,
 * `Binfeo` mengirim payload terenkripsi (ChaCha20-Poly1305) dengan byte mentah
 * yang utuh sampai ke receiver.
 *
 * Flow:
 *   1. `new NetSocket({ port, key, protocol: "Binfeo" })` — bind port tetap
 *   2. `onData` sebelum `open()` — event-driven (payload = Buffer)
 *   3. `open()` — socket + bind (PLAIN) + set protocol per-port = Binfeo
 *   4. `upgradeSecurity()` — switch ke ChaCha20-Poly1305 (key utk port ini)
 *   5. `waitClosed()` + `close()`
 *
 * Run:  netsocket-binfeo-rx [port]
 * (default port 2700 — pair with `netsocket-binfeo-tx`)
 */

const KEY_HEX =
  "81ff71ed574e54597690ae7b04e4ef5fc87497fe10b6b037cb031af7c7d67619";

const green = "\x1b[92m";
const yellow = "\x1b[93m";
const cyan = "\x1b[96m";
const red = "\x1b[91m";
const reset = "\x1b[0m";

export const main = Program(async (args: string[]) => {
  const port = parseInt(args[0] || "2700", 10);

  const sock = new NetSocket({ port, key: KEY_HEX, protocol: "Binfeo" });

  sock.onData = (pkt) => {
    const raw = Buffer.isBuffer(pkt.data) ? pkt.data : Buffer.from(pkt.data);
    // Tampilkan isi byte (hex) + teks — bukti byte >= 0x80 tidak rusak.
    std.println(
      `${yellow}[RX] ${pkt.src}:${pkt.port} (local ${pkt.localPort}, isBinary=${pkt.isBinary})${reset}`,
    );
    std.println(`${cyan}[RX]   hex: ${raw.toString("hex")}${reset}`);
    std.println(`${cyan}[RX]  text: ${raw.toString("utf8")}${reset}`);
  };

  sock.onError = (err) => {
    std.println(`${red}[RX] error: ${err.message}${reset}`);
  };

  await sock.open();
  await std.println(
    `${green}[RX] Binfeo listening (PLAIN) on port ${sock.port}...${reset}`,
  );

  await sock.upgradeSecurity();
  await std.println(
    `${green}[RX] Mode: ${sock.isSecured ? "ChaCha20-Poly1305 ACTIVE (Binfeo)" : "PLAIN"} (isSecured=${sock.isSecured}). Waiting for data...${reset}`,
  );

  await sock.waitClosed();
  await std.println(`${cyan}[RX] Socket closed. Bye!${reset}`);
});
