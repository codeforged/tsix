import { Program, std, NetSocket } from "@tsix/Application";

/**
 * NETSOCKET RX — Contoh receiver memakai NetSocket (Cashew-style).
 *
 * Alur yang ditunjukkan:
 *   1. `new NetSocket({ port, key })` — konfigurasi via object literal
 *   2. `onData` / `onError` — event handler (bukan loop recv() manual)
 *   3. `open()` — socket + bind (PLAIN dulu, security tidak otomatis)
 *   4. `upgradeSecurity()` — switch eksplisit ke ChaCha20-Poly1305
 *   5. `waitClosed()` — jaga proses hidup sampai socket ditutup (Ctrl+C)
 *
 * ── DUA CARA MENERIMA DATA ───────────────────────────────────────
 * Receiver perlu tetap hidup — kalau main() return, WorkerEntry langsung
 * exit(0) dan proses mati. Ada 2 pola, dipilih via konstanta `manualLoop`:
 *
 *   manualLoop = false → event-driven : set `onData` + `await sock.waitClosed();`
 *       (loop internal yang memanggil onData tiap ada data masuk)
 *   manualLoop = true  → manual loop  : `while (sock.isOpen) { await sock.recv(); }`
 *       (kamu yang menulis loop baca sendiri — persis gaya lama)
 *
 * Keduanya berhenti saat socket ditutup (Ctrl+C → auto-cleanup close).
 * ─────────────────────────────────────────────────────────────────
 *
 * Auto-cleanup aktif secara default: Ctrl+C → close() (release port +
 * normalisasi security agent) lalu exit(130). Tidak perlu handle signal manual.
 *
 * Jalankan:  netsocket-rx [port]
 * (default port 2500 — pasangkan dengan `netsocket-tx`)
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
  const port = parseInt(args[0] || "2500", 10);

  // ============================================================
  // PILIH POLA PENERIMAAN (lihat penjelasan di header file):
  //   false → event-driven : onData + await sock.waitClosed()
  //   true  → manual loop  : while(isOpen){ await sock.recv(); }
  // ============================================================
  const manualLoop = false;

  const sock = new NetSocket({ port, key: KEY_HEX });

  // Event handler — HANYA untuk mode event-driven (manualLoop=false).
  // Kalau manualLoop=true jangan set onData: loop internal akan bertabrakan
  // dengan recv() manual (recv() melempar error di mode event).
  if (!manualLoop) {
    sock.onData = (pkt) => {
      std.println(
        `${yellow}[RX] ${pkt.src}:${pkt.port} (local ${pkt.localPort}) -> ${pkt.data}${reset}`,
      );
      // Balas balik (request-response) kalau perlu:
      //   await sock.reply(pkt, "pong");
    };

    sock.onError = (err) => {
      std.println(`${red}[RX] error: ${err.message}${reset}`);
    };
  }

  // 1) Buka socket — plain dulu.
  await sock.open();
  await std.println(
    `${green}[RX] Listening (PLAIN) on port ${sock.port}...${reset}`,
  );

  // 2) Alamat node sendiri (biar tahu target untuk netsocket-tx).
  try {
    const ns = await sock.netstat();
    const iface =
      ns?.interfaces?.find((i: any) => i.deviceName === ns.defaultDevice) ||
      ns?.interfaces?.[0];
    if (iface) {
      await std.println(
        `${dim}[RX] Node address: ${iface.address} (default: ${ns.defaultDevice})${reset}`,
      );
    }
  } catch (_e) {
    /* netstat opsional — gagal tidak masalah */
  }

  // 3) Switch ke mode aman SECARA EKSPLISIT (bukan otomatis saat open).
  //   await sock.upgradeSecurity();
  await std.println(
    `${green}[RX] Mode: ${sock.isSecured ? "ChaCha20-Poly1305 ACTIVE" : "PLAIN (tanpa enkripsi)"} (isSecured=${sock.isSecured}). Menunggu data...${reset}`,
  );

  // 4) MENERIMA DATA — dua pola:
  if (manualLoop) {
    // Manual loop — pola klasik: while(isOpen){ recv() }.
    await std.println(
      `${dim}[RX] manualLoop=true → while (sock.isOpen) { await sock.recv(); }${reset}`,
    );
    while (sock.isOpen) {
      try {
        const pkt = await sock.recv();
        if (pkt) {
          await std.println(
            `${yellow}[RX] ${pkt.src}:${pkt.port} (local ${pkt.localPort}) -> ${pkt.data}${reset}`,
          );
        }
      } catch (_e) {
        break; // socket ditutup saat recv sedang menunggu → keluar loop
      }
    }
  } else {
    // Event-driven — onData dipanggil loop internal; waitClosed() menjaga
    // proses tetap hidup sampai socket ditutup (Ctrl+C → auto-cleanup).
    await std.println(
      `${dim}[RX] manualLoop=false → onData + await sock.waitClosed();${reset}`,
    );
    await sock.waitClosed();
  }

  await std.println(`${cyan}[RX] Socket closed. Bye!${reset}`);
});
