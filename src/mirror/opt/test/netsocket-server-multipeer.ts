import { Program, std, NetSocketServer } from "@tsix/Application";

/**
 * NETSOCKET SERVER MULTIPEER — satu port, banyak peer, key per-peer.
 *
 * `NetSocketServer` membungkus satu `NetSocket` yang di-bind ke satu port.
 * Setiap peer mendapat `NetPeerSession` sendiri; enkripsi dilakukan per-peer
 * di userland (bukan `upgradeSecurity` kernel, yang hanya satu key per port).
 *
 * Cocok untuk client yang sudah memakai `NetSocket.upgradePsk()` /
 * `NetSocket.upgradeSecurity()`: payload masuk didekripsi agent sesi, balasan
 * dienkripsi agent yang sama.
 *
 * Run:  netsocket-server-multipeer [port]
 * (default port 2721 — pair with `netsocket-tx-psk localhost 2721`)
 */

const PSK = "tsix-netsocket-psk-contoh";
const SESSION_IDLE_MS = 60_000;

const green = "\x1b[92m";
const yellow = "\x1b[93m";
const cyan = "\x1b[96m";
const red = "\x1b[91m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";

export const main = Program(async (args: string[]) => {
  const port = parseInt(args[0] || "2721", 10);

  const server = new NetSocketServer({
    port,
    protocol: "JSON",
    sessionIdleMs: SESSION_IDLE_MS,
  });

  server.onSession = (peer) => {
    std.println(
      `${green}[multipeer] sesi baru ${peer.id}${reset}`,
    );
    // Semua peer contoh ini memakai PSK yang sama. Untuk key berbeda,
    // panggil peer.enableSecurity(keyHex) sesuai hasil autentikasi.
    peer.enablePsk(PSK);

    peer.onJson = async (value, pkt) => {
      std.println(
        `${yellow}[multipeer] ${peer.id} -> ${JSON.stringify(value)}${reset}`,
      );
      await peer.replyJson(pkt, {
        echo: value,
        from: "netsocket-server-multipeer",
        ts: Date.now(),
      });
    };
    peer.onError = (err) => {
      std.println(`${red}[multipeer] ${peer.id} error: ${err.message}${reset}`);
    };
    peer.onClose = () => {
      std.println(`${dim}[multipeer] sesi ditutup ${peer.id}${reset}`);
    };
  };

  server.onError = (err) => {
    std.println(`${red}[multipeer] server error: ${err.message}${reset}`);
  };

  await server.listen();
  await std.println(
    `${green}[multipeer] Listening on ${server.port} dengan PSK per-peer.${reset}`,
  );

  await server.waitClosed();
  await std.println(`${cyan}[multipeer] Server closed.${reset}`);
});
