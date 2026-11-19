import { Program, std, PskSocket } from "@tsix/Application";

/**
 * NETSOCKET PSK SERVER — handshake PSK (nonce + HMAC), lalu ChaCha20.
 *
 * Beda dengan `upgradePsk()` (kunci statis), `PskSocket` menurunkan session
 * key unik per koneksi dan saling membuktikan identitas lewat HMAC.
 *
 * Run:  netsocket-psk-server [port]
 * (default port 2720 — pair with `netsocket-psk-client`)
 */

const PSK = "rahasia-bersama";

const green = "\x1b[92m";
const yellow = "\x1b[93m";
const red = "\x1b[91m";
const reset = "\x1b[0m";

export const main = Program(async (args: string[]) => {
  const port = parseInt(args[0] || "2720", 10);
  const sock = new PskSocket({ role: "server", port, psk: PSK });

  sock.onReady = () => {
    std.println(`${green}[psk-server] Handshake selesai — channel aman aktif${reset}`);
  };
  sock.onMessage = (message, pkt) => {
    std.println(
      `${yellow}[psk-server] ${pkt.src}:${pkt.port} -> ${message}${reset}`,
    );
    void sock.reply(pkt, `echo: ${message}`);
  };
  sock.onError = (err) => {
    std.println(`${red}[psk-server] error: ${err.message}${reset}`);
  };

  await sock.open();
  await std.println(`${green}[psk-server] Listening on ${sock.port}...${reset}`);

  await sock.waitClosed();
  await std.println(`${yellow}[psk-server] Bye!${reset}`);
});
