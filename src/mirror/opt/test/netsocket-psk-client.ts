import { Program, std, PskSocket } from "@tsix/Application";

/**
 * NETSOCKET PSK CLIENT — handshake PSK dengan `PskSocket`.
 *
 * `open()` menunggu sampai handshake selesai (server proof diverifikasi,
 * session key diturunkan). Setelah itu `send()` otomatis terenkripsi.
 *
 * Run:  netsocket-psk-client [address] [port]
 * (default address "localhost", port 2720 — pair with `netsocket-psk-server`)
 */

const PSK = "rahasia-bersama";

const green = "\x1b[92m";
const yellow = "\x1b[93m";
const cyan = "\x1b[96m";
const red = "\x1b[91m";
const reset = "\x1b[0m";

export const main = Program(async (args: string[]) => {
  const targetAddr = args[0] || "localhost";
  const targetPort = parseInt(args[1] || "2720", 10);

  const sock = new PskSocket({
    role: "client",
    port: 0,
    psk: PSK,
    peer: { address: targetAddr, port: targetPort },
  });

  sock.onMessage = (message, pkt) => {
    std.println(
      `${yellow}[psk-client RX] ${pkt.src}:${pkt.port} -> ${message}${reset}`,
    );
  };
  sock.onError = (err) => {
    std.println(`${red}[psk-client] error: ${err.message}${reset}`);
  };

  // open() client menunggu handshake selesai.
  await sock.open();
  await std.println(
    `${green}[psk-client] Secure channel siap (local port ${sock.port})${reset}`,
  );

  const text = JSON.stringify({
    from: "netsocket-psk-client",
    ts: Date.now(),
  });
  const ok = await sock.send(text);
  await std.println(
    `${ok ? green : red}[psk-client] -> ${targetAddr}:${targetPort} ${ok ? "OK" : "FAILED"}${reset}  ${cyan}${text}${reset}`,
  );

  // Beri waktu balasan datang, lalu tutup.
  await new Promise((r) => setTimeout(r, 1000));
  await sock.close("client selesai");
});
