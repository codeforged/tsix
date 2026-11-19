import { Program, std, NetSocket } from "@tsix/Application";

/**
 * NETSOCKET TX PSK — Sender dengan enkripsi Pre-Shared Key.
 *
 * Tanpa RSA/handshake: TX dan RX memakai PSK yang sama, lalu `upgradePsk()`
 * menurunkan session key ChaCha20-Poly1305 lewat HKDF-SHA256
 * (info "TSIX-NETSOCKET-PSK-v1").
 *
 * Flow:
 *   1. `new NetSocket({ port: 0, psk })` — port ephemeral (kernel pilih)
 *   2. `onData` dipasang sebelum `open()` agar balasan RX bisa diterima
 *   3. `open()` — socket + bind (masih plain)
 *   4. `upgradePsk()` — aktifkan ChaCha20-Poly1305 dari PSK
 *   5. `sendTo(addr, port, data)` — kirim beberapa pesan
 *   6. `close()` — lepas port + normalisasi security agent
 *
 * Run:  netsocket-tx-psk [address] [port] [count]
 * (default address "localhost", port 2700, 3 pesan — pair with `netsocket-rx-psk`)
 */

const PSK = "tsix-netsocket-psk-contoh";

const green = "\x1b[92m";
const yellow = "\x1b[93m";
const cyan = "\x1b[96m";
const red = "\x1b[91m";
const reset = "\x1b[0m";

export const main = Program(async (args: string[]) => {
  const targetAddr = args[0] || "localhost";
  const targetPort = parseInt(args[1] || "2700", 10);
  const count = parseInt(args[2] || "3", 10);

  const sock = new NetSocket({ port: 0, psk: PSK, protocol: "JSON" });

  sock.onData = (pkt) => {
    std.println(
      `${yellow}[TX-psk RX] ${pkt.src}:${pkt.port} -> ${pkt.data}${reset}`,
    );
  };
  sock.onError = (err) => {
    std.println(`${red}[TX-psk] error: ${err.message}${reset}`);
  };

  await sock.open();
  await std.println(
    `${green}[TX-psk] Socket ready (local port ${sock.port}, PLAIN)${reset}`,
  );

  // TX dan RX harus memakai PSK yang sama.
  await sock.upgradePsk();
  await std.println(
    `${green}[TX-psk] PSK active: ${sock.isPsk ? "ChaCha20-Poly1305" : "PLAIN"} (agent=${sock.agent})${reset}`,
  );

  // Beri waktu RX untuk siap.
  await new Promise((r) => setTimeout(r, 2000));

  for (let i = 1; i <= count; i++) {
    const msg = JSON.stringify({
      seq: i,
      from: "netsocket-tx-psk",
      ts: Date.now(),
    });
    const ok = await sock.sendTo(targetAddr, targetPort, msg);
    await std.println(
      `${ok ? green : red}[TX-psk] #${i} -> ${targetAddr}:${targetPort} ${ok ? "OK" : "FAILED"}${reset}  ${cyan}${msg}${reset}`,
    );
    if (i < count) await new Promise((r) => setTimeout(r, 500));
  }

  await sock.close();
  await std.println(
    `${yellow}[TX-psk] Done. Socket closed (port released).${reset}`,
  );
});
