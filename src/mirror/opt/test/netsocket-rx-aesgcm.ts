import { Program, std, NetSocket } from "@tsix/Application";

/**
 * NETSOCKET RX AESGCM — Receiver memakai agent enkripsi kustom (Jalur A).
 *
 * Ini varian `netsocket-rx` yang menunjukkan SOP custom security agent:
 * `upgradeSecurity(key, { agent: "aes-gcm" })` — AES-256-GCM, bukan default
 * chacha20. Agent dipilih via NAMA string (bukan class) karena kernel yang
 * meng-instantiate-nya lewat registry (SimpleMQTNLDriver.getAgent).
 *
 * Alur:
 *   1. `new NetSocket({ port, key })` — konfigurasi object literal
 *   2. `onData` / `onError` — event handler
 *   3. `open()` — socket + bind (PLAIN dulu)
 *   4. `upgradeSecurity(key, { agent: "aes-gcm" })` — switch ke AES-256-GCM
 *   5. `waitClosed()` — jaga proses hidup sampai socket ditutup (Ctrl+C)
 *
 * Auto-cleanup default: Ctrl+C → close() (release port + normalisasi agent).
 *
 * Jalankan:  netsocket-rx-aesgcm [port]
 * (default port 2600 — pasangkan dengan `netsocket-tx-aesgcm`)
 */

const KEY_HEX =
  "81ff71ed574e54597690ae7b04e4ef5fc87497fe10b6b037cb031af7c7d67619";

const green = "\x1b[92m";
const yellow = "\x1b[93m";
const cyan = "\x1b[96m";
const red = "\x1b[91m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";

export const main = Program(async (args: string[]) => {
  const port = parseInt(args[0] || "2600", 10);

  const sock = new NetSocket({ port, key: KEY_HEX });

  sock.onData = (pkt) => {
    std.println(
      `${yellow}[RX-aesgcm] ${pkt.src}:${pkt.port} (local ${pkt.localPort}) -> ${pkt.data}${reset}`,
    );
    // Balas balik (request-response) kalau perlu:
    //   await sock.reply(pkt, "pong");
  };

  sock.onError = (err) => {
    std.println(`${red}[RX-aesgcm] error: ${err.message}${reset}`);
  };

  // 1) Buka socket — plain dulu.
  await sock.open();
  await std.println(
    `${green}[RX-aesgcm] Listening (PLAIN) on port ${sock.port}...${reset}`,
  );

  // 2) Alamat node sendiri (biar tahu target untuk netsocket-tx-aesgcm).
  try {
    const ns = await sock.netstat();
    const iface =
      ns?.interfaces?.find((i: any) => i.deviceName === ns.defaultDevice) ||
      ns?.interfaces?.[0];
    if (iface) {
      await std.println(
        `${dim}[RX-aesgcm] Node address: ${iface.address} (default: ${ns.defaultDevice})${reset}`,
      );
    }
  } catch (_e) {
    /* netstat opsional — gagal tidak masalah */
  }

  // 3) Switch ke mode aman dengan AGENT KUSTOM aes-gcm (eksplisit).
  await sock.upgradeSecurity(KEY_HEX, { agent: "aes-gcm" });
  await std.println(
    `${green}[RX-aesgcm] AES-256-GCM ACTIVE (isSecured=${sock.isSecured}, agent=${sock.agent}). Menunggu data...${reset}`,
  );

  // 4) Jaga proses tetap hidup sampai socket ditutup.
  await sock.waitClosed();
  await std.println(`${cyan}[RX-aesgcm] Socket closed. Bye!${reset}`);
});
