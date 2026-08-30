import { Program, std, NetSocket } from "@tsix/Application";

/**
 * NETSOCKET TX AESGCM — Sender memakai agent enkripsi kustom (Jalur A).
 *
 * Varian `netsocket-tx` yang memilih AES-256-GCM via SOP custom agent:
 * `upgradeSecurity(key, { agent: "aes-gcm" })`. Pasangkan dengan
 * `netsocket-rx-aesgcm` (kedua sisi harus pakai agent yang SAMA + key yang
 * sama, karena RX mendekripsi sesuai agent yang terpasang di port-nya).
 *
 * Alur:
 *   1. `new NetSocket({ port, key })` — bind port lokal TETAP
 *   2. `open()` — socket + bind (PLAIN dulu)
 *   3. `upgradeSecurity(key, { agent: "aes-gcm" })` — switch ke AES-256-GCM
 *   4. `sendTo(addr, port, data)` — kirim beberapa pesan
 *   5. `close()` — release port + normalisasi agent
 *
 * ⚠️ Port TX harus TETAP (bukan 0): MQTNL mengenkripsi per-srcPort, jadi
 * session key di-`upgradeSecurity()` harus terpasang ke port yang benar.
 *
 * Jalankan:  netsocket-tx-aesgcm [address] [port] [count]
 * (default address "mactsix", port 2600, 3 pesan — pasangkan dengan `netsocket-rx-aesgcm`)
 */

const KEY_HEX =
  "81ff71ed574e54597690ae7b04e4ef5fc87497fe10b6b037cb031af7c7d67619";

const green = "\x1b[92m";
const yellow = "\x1b[93m";
const cyan = "\x1b[96m";
const red = "\x1b[91m";
const reset = "\x1b[0m";

export const main = Program(async (args: string[]) => {
  const targetAddr = args[0] || "mactsix";
  const targetPort = parseInt(args[1] || "2600", 10);
  const count = parseInt(args[2] || "3", 10);
  const myPort = 2601; // port lokal tetap supaya enkripsi per-srcPort bekerja

  const sock = new NetSocket({ port: myPort, key: KEY_HEX });

  await sock.open();
  await std.println(
    `${green}[TX-aesgcm] Socket ready (local port ${sock.port}, PLAIN)${reset}`,
  );

  // Switch ke mode aman dengan AGENT KUSTOM aes-gcm (eksplisit).
  await sock.upgradeSecurity(KEY_HEX, { agent: "aes-gcm" });
  await std.println(
    `${green}[TX-aesgcm] AES-256-GCM ACTIVE (isSecured=${sock.isSecured}, agent=${sock.agent})${reset}`,
  );

  for (let i = 1; i <= count; i++) {
    const msg = JSON.stringify({
      seq: i,
      from: "netsocket-tx-aesgcm",
      ts: Date.now(),
    });
    const ok = await sock.sendTo(targetAddr, targetPort, msg);
    await std.println(
      `${ok ? green : red}[TX-aesgcm] #${i} -> ${targetAddr}:${targetPort} ${ok ? "OK" : "FAILED"}${reset}  ${cyan}${msg}${reset}`,
    );
    if (i < count) await new Promise((r) => setTimeout(r, 500));
  }

  // Tutup: release port + normalisasi agent (idempotent).
  await sock.close();
  await std.println(
    `${yellow}[TX-aesgcm] Done. Socket closed (port released).${reset}`,
  );
});
