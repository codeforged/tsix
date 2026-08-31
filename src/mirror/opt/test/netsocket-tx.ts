import { Program, std, NetSocket } from "@tsix/Application";

/**
 * NETSOCKET TX — Contoh sender memakai NetSocket (Cashew-style).
 *
 * Alur yang ditunjukkan:
 *   1. `new NetSocket({ port, key })` — bind port lokal TETAP
 *   2. `open()` — socket + bind (PLAIN dulu)
 *   3. `upgradeSecurity()` — switch eksplisit ke ChaCha20-Poly1305
 *   4. `sendTo(addr, port, data)` — kirim beberapa pesan
 *   5. `close()` — release port + normalisasi security agent
 *
 * ⚠️ Kenapa port TX harus TETAP (bukan 0)? Karena MQTNL mengenkripsi per
 * srcPort — session key di-`upgradeSecurity()` dipasang ke port itu. Kalau
 * pakai port 0 (ephemeral), key terpasang ke port yang salah dan payload
 * terkirim plaintext (receiver secured akan gagal decrypt).
 *
 * ⚠️ Mode terenkripsi: aktifkan baris `await sock.upgradeSecurity();` di
 * bawah, dan lakukan hal yang sama di receiver dengan key yang sama.
 *
 * Jalankan:  netsocket-tx [address] [port] [count]
 * (default address "mactsix", port 2500, 3 pesan — pasangkan dengan `netsocket-rx`)
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
  const targetPort = parseInt(args[1] || "2500", 10);
  const count = parseInt(args[2] || "3", 10);
  const myPort = 2501; // port lokal tetap supaya enkripsi per-srcPort bekerja

  const sock = new NetSocket({ port: myPort, key: KEY_HEX });

  await sock.open();
  await std.println(
    `${green}[TX] Socket ready (local port ${sock.port}, PLAIN)${reset}`,
  );

  // Switch ke mode aman SECARA EKSPLISIT. Aktifkan baris di bawah untuk
  // mode terenkripsi (dan lakukan hal yang sama di receiver dengan key sama):
  //   await sock.upgradeSecurity();
  await std.println(
    `${green}[TX] Mode: ${sock.isSecured ? "ChaCha20-Poly1305 ACTIVE" : "PLAIN (tanpa enkripsi)"} (isSecured=${sock.isSecured})${reset}`,
  );

  for (let i = 1; i <= count; i++) {
    const msg = JSON.stringify({
      seq: i,
      from: "netsocket-tx",
      ts: Date.now(),
    });
    const ok = await sock.sendTo(targetAddr, targetPort, msg);
    await std.println(
      `${ok ? green : red}[TX] #${i} -> ${targetAddr}:${targetPort} ${ok ? "OK" : "FAILED"}${reset}  ${cyan}${msg}${reset}`,
    );
    if (i < count) await new Promise((r) => setTimeout(r, 500));
  }

  // Tutup: release port + normalisasi security agent (idempotent).
  await sock.close();
  await std.println(
    `${yellow}[TX] Done. Socket closed (port released).${reset}`,
  );
});
