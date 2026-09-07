/**
 * smartbulb/setgpio.ts — 🛠️ JayaLaras GPIO Control (CLI, client service)
 *
 * Migrasi `setgpio` (NOS, 2020 — author: Andriansah) ke TSIX.
 *
 * Posisi: SETINGKAT `control.ts` — keduanya CLIENT dari `service.ts`.
 * Tidak menyentuh MCP23017 langsung; semua request lewat IPC ke daemon
 * `jayalaras.service` (pemilik hardware + logika saklar, lihat service.ts):
 *
 *   setgpio ──IPC──▶ jayalaras.service ──▶ MCP23017 relay
 *
 * Protokol IPC (sama dgn control.ts / web-gateway.ts):
 *   kirim  { type:"REGISTER" }                 → subscribe + service balas state
 *   kirim  { type:"GET" }                      → service balas state ke pengirim
 *   kirim  { type:"SET", port, on }            → set satu port logika (0..15)
 *   kirim  { type:"SETALL", on }               → set semua port
 *   kirim  { type:"UNREGISTER" }               → berhenti subscribe
 *   terima { type:"SMARTBULB_STATE", ports[16], switches[16], manual }
 *
 * `ports[]` = state lampu LOGIKA (1 = ON, 0 = OFF) — persis output
 * `getAllPortStatus()` di NOS. Soal active-low & mapping port→pin sudah
 * ditangani service, CLI tidak perlu tahu.
 *
 * Sintaks (mirror NOS):
 *   setgpio                      → status lampu (via service)
 *   setgpio --status             → status lampu
 *   setgpio <port>=<1|0> [...]   → nyalakan/matikan satu atau lebih lampu
 *   setgpio 8=1 12=0 --status    → set lalu tampilkan status
 *
 * Opsi tambahan (TSIX):
 *   --bits   → tampilkan juga state mentah `value <16-bit>` (format legacy
 *              jayalarasiot/portstates, kompatibel local.html/web-gateway)
 *
 * Contoh:
 *   setgpio 8=1                  # nyalakan ruang tengah belakang (port 8)
 *   setgpio 9=0                  # matikan teras depan (port 9)
 *   setgpio 13=1 --status --bits # nyalakan exhaust + status + bits
 *
 * Catatan: kalau `service.js` belum jalan, perintah ini menolak (bukan
 * simulasi). Jalankan `/opt/smartbulb/service.js [--hw]` dulu.
 *
 * (c) 2026 TSIX Project
 */

import { UserLib } from "@tsix/UserLib";

/** Identity daemon pemilik hardware (service.ts). */
const SERVICE_ID = "jayalaras.service";

/** Waktu tunggu balasan IPC setelah satu request (ms). */
const REPLY_TIMEOUT_MS = 2000;
/** Waktu tunggu probe awal (service online?) (ms). */
const PROBE_TIMEOUT_MS = 1500;

/** Nama ruangan per port logika (denah JayaLaras, sama dengan control.ts). */
const PORT_NAMES: Record<number, string> = {
  8: "ruang tengah belakang",
  3: "ruang tengah depan",
  4: "ruang kerja",
  2: "kamar anak",
  7: "dapur",
  10: "wc kamar",
  11: "wc utama",
  15: "kamar utama",
  12: "teras belakang",
  9: "teras depan",
  5: "taman",
  13: "exhaust fan ruang kerja",
};
/** Urutan tampilan port (mengikuti portMap NOS). */
const MAP_ORDER = [8, 3, 4, 2, 7, 10, 11, 15, 12, 9, 5, 13];

const portName = (p: number): string => PORT_NAMES[p] || `(port ${p})`;

export default class SetGpio {
  async execute(lib: UserLib, args: string[]) {
    const { std, shell } = lib;

    // ── Bantuan ──
    if (args.includes("--help") || args.includes("-h")) {
      await std.println("Syntax: setgpio <port=1|0> [port=1|0 ...] [--status] [--bits]");
      await std.println("        setgpio            # status lampu (via service)");
      await std.println("        setgpio 8=1        # nyalakan lampu port 8");
      await std.println("        setgpio 9=0        # matikan lampu port 9");
      await std.println("");
      await std.println("Semua request via IPC ke daemon jayalaras.service.");
      await std.println("Port map (state lampu logika):");
      for (const p of MAP_ORDER) {
        await std.println(`  ${String(p).padStart(2, " ")} = ${portName(p)}`);
      }
      return;
    }

    const showStatus = args.includes("--status") || args.includes("-status");
    const bitsMode = args.includes("--bits");

    // ── Parse perintah `port=value` (NOS: args.params._) ──
    const commands: { port: number; on: boolean }[] = [];
    for (const a of args) {
      if (a.includes("=") && !a.startsWith("--")) {
        const eq = a.indexOf("=");
        const port = parseInt(a.slice(0, eq).trim(), 10);
        const vStr = a.slice(eq + 1).trim().toLowerCase();
        if (!Number.isFinite(port) || port < 0 || port > 15) {
          await std.println(`❌ Port tidak valid: "${a}" (harus 0..15)`);
          continue;
        }
        let on: boolean;
        if (vStr === "1" || vStr === "on" || vStr === "true") on = true;
        else if (vStr === "0" || vStr === "off" || vStr === "false") on = false;
        else {
          await std.println(
            `❌ Nilai tidak valid utk port ${port}: "${a.slice(eq + 1)}" (pakai 1/0 atau on/off)`,
          );
          continue;
        }
        commands.push({ port, on });
      }
    }
    const wantsStatus = showStatus || commands.length === 0;

    // ── State & listener balasan IPC ──
    let latest: { ports: number[]; switches: number[]; manual: number } | null =
      null;
    let waiter: (() => void) | null = null;

    lib.onEvent("ipc_message", (msg: any) => {
      const payload = msg?.data || msg;
      if (!payload || payload.type !== "SMARTBULB_STATE") return;
      latest = payload;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w();
      }
    });

    /** Tunggu satu balasan SMARTBULB_STATE berikutnya. */
    const waitReply = (timeoutMs: number): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        let settled = false;
        waiter = () => {
          if (!settled) {
            settled = true;
            resolve(true);
          }
        };
        setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve(false);
          }
          waiter = null;
        }, timeoutMs);
      });

    /** Kirim pesan ke service (fire, error ditelan). */
    const send = async (p: Record<string, any>) => {
      try {
        await shell.send(SERVICE_ID, p);
      } catch (_) {
        /* service tak dikenal — ditangani via timeout probe */
      }
    };

    // ── Probe: REGISTER → service balas state ke pid kita ──
    const probe = waitReply(PROBE_TIMEOUT_MS);
    await send({ type: "REGISTER" });
    if (!(await probe)) {
      await std.println(
        `❌ Service "${SERVICE_ID}" tidak merespon. Jalankan dulu:`,
      );
      await std.println("     /opt/smartbulb/service.js [--hw]");
      await std.println(
        "   (pastikan daemon sudah jalan — cek dengan: ps | grep service)",
      );
      return;
    }

    // ── Eksekusi perintah set (via service) ──
    if (commands.length > 0) {
      await std.println(`🔌 ${SERVICE_ID} — mengatur ${commands.length} lampu...`);
      for (const c of commands) {
        const r = waitReply(REPLY_TIMEOUT_MS);
        await send({ type: "SET", port: c.port, on: c.on });
        const ok = await r;
        await std.println(
          `${c.on ? "💡 ON " : "🌑 OFF"}  port ${String(c.port).padStart(2, " ")} = ${portName(c.port)}${ok ? "" : " ⚠️ (tanpa balasan)"}`,
        );
      }
    }

    // ── Tampilkan status ──
    if (wantsStatus) {
      const r = waitReply(REPLY_TIMEOUT_MS);
      await send({ type: "GET" });
      await r;
      await this.printStatus(std, latest);
      if (bitsMode && latest) {
        await std.println("");
        await std.println(`value ${latest.ports.join("")}   ← state mentah (legacy portstates)`);
      }
    }

    // Lepas subscribe lalu selesai.
    await send({ type: "UNREGISTER" });
  }

  private async printStatus(
    std: any,
    latest: { ports: number[]; switches: number[]; manual: number } | null,
  ) {
    await std.println("");
    await std.println("Port Map & Status");
    await std.println("=================");
    await std.println(`Service: ${SERVICE_ID}`);
    if (!latest) {
      await std.println("(belum ada state dari service)");
      return;
    }
    for (const p of MAP_ORDER) {
      const on = latest.ports[p] ? "ON" : "OFF";
      await std.println(
        `${String(p).padStart(2, " ")} = ${portName(p).padEnd(24, " ")} => ${on}`,
      );
    }
    if (latest.manual) {
      await std.println("");
      await std.println("ℹ️  Terakhir diubah lewat saklar fisik (manual).");
    }
  }
}
