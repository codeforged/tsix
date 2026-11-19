import { Program, std, NetSocket } from "@tsix/Application";

/**
 * NETSOCKET RX PSK — Receiver dengan enkripsi Pre-Shared Key.
 *
 * Tidak ada RSA dan tidak ada handshake: TX dan RX cukup memakai PSK yang
 * sama. `upgradePsk()` menurunkan session key ChaCha20-Poly1305 dari PSK
 * lewat HKDF-SHA256 (info "TSIX-NETSOCKET-PSK-v1").
 *
 * Flow:
 *   1. `new NetSocket({ port, psk })` — PSK boleh passphrase atau 64 hex
 *   2. `onData` / `onError` — event handler
 *   3. `open()` — socket + bind (masih plain)
 *   4. `upgradePsk()` — aktifkan ChaCha20-Poly1305 dari PSK
 *   5. `waitClosed()` — tetap hidup sampai Ctrl+C
 *
 * Run:  netsocket-rx-psk [port]
 * (default port 2700 — pair with `netsocket-tx-psk`)
 */

const PSK = "tsix-netsocket-psk-contoh";

const green = "\x1b[92m";
const yellow = "\x1b[93m";
const cyan = "\x1b[96m";
const red = "\x1b[91m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";

export const main = Program(async (args: string[]) => {
  const port = parseInt(args[0] || "2700", 10);

  const sock = new NetSocket({ port, psk: PSK, protocol: "JSON" });

  sock.onData = (pkt) => {
    std.println(
      `${yellow}[RX-psk] ${pkt.src}:${pkt.port} (local ${pkt.localPort}) -> ${pkt.data}${reset}`,
    );
    // Balas ke pengirim kalau perlu:
    //   await sock.reply(pkt, "pong");
  };

  sock.onError = (err) => {
    std.println(`${red}[RX-psk] error: ${err.message}${reset}`);
  };

  // 1) Bind port — masih plain.
  await sock.open();
  await std.println(
    `${green}[RX-psk] Listening (PLAIN) on port ${sock.port}...${reset}`,
  );

  // 2) Tampilkan alamat node supaya target TX jelas.
  try {
    const ns = await sock.netstat();
    const iface =
      ns?.interfaces?.find((i: any) => i.deviceName === ns.defaultDevice) ||
      ns?.interfaces?.[0];
    if (iface) {
      await std.println(
        `${dim}[RX-psk] Node address: ${iface.address} (default: ${ns.defaultDevice})${reset}`,
      );
    }
  } catch (_e) {
    /* netstat opsional */
  }

  // 3) Aktifkan PSK encryption (session key diturunkan dari PSK).
  await sock.upgradePsk();
  await std.println(
    `${green}[RX-psk] PSK active: ${sock.isPsk ? "ChaCha20-Poly1305" : "PLAIN"} (agent=${sock.agent}). Waiting for data...${reset}`,
  );

  // 4) Tetap hidup sampai socket ditutup.
  await sock.waitClosed();
  await std.println(`${cyan}[RX-psk] Socket closed. Bye!${reset}`);
});
