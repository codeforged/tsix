/**
 * smartbulb/scheduler.ts — ⏰ JayaLaras Lampu Otomatis (jadwal)
 *
 * Dijalankan oleh `crond` (lihat /etc/crontab, tiap 5 menit) sebagai client
 * IPC ke `jayalaras.service` — sama seperti `setgpio.ts`/`control.ts`. Tidak
 * menyentuh MCP23017 langsung.
 *
 * Aturan jadwal (waktu lokal Raspberry Pi):
 *   1. 18:00–04:00  → ON  teras depan (9), teras belakang (12)
 *   2. 06:00–17:00  → OFF teras depan (9), teras belakang (12)
 *   3. 23:00–03:00  → OFF kamar anak (2), ruang tengah depan (3) & belakang (8)
 *
 * Jam di luar aturan TIDAK disentuh → kontrol manual/saklar tetap dihormati.
 * Tiap dijalankan: REGISTER → GET state → SET hanya port yang berubah →
 * UNREGISTER. Idempoten & meminimalkan penulisan I2C (tidak menulis ulang
 * nilai yang sudah sama).
 *
 * Cara pakai:
 *   /opt/smartbulb/scheduler.js           # jalankan sekali (ikut jam skrg)
 *   /opt/smartbulb/scheduler.js --dry     # hanya tampilkan keputusan, tanpa IPC
 *
 * (c) 2026 TSIX Project
 */

import { UserLib } from "@tsix/UserLib";

/** Identity daemon pemilik hardware (service.ts). */
const SERVICE_ID = "jayalaras.service";

/** Waktu tunggu balasan IPC setelah satu request (ms). */
const REPLY_TIMEOUT_MS = 2500;
/** Waktu tunggu probe awal (service online?) (ms). */
const PROBE_TIMEOUT_MS = 1500;

// Port logika relay (denah JayaLaras — jangan tertukar dengan index GUI).
const P_TERAS_DEPAN = 9;
const P_TERAS_BELAKANG = 12;
const P_RUANG_TENGAH_DEPAN = 3;
const P_RUANG_TENGAH_BELAKANG = 8;
const P_KAMAR_ANAK = 2;

/** Cek jam dalam rentang; `from > to` berarti lintas tengah malam. */
function inRange(hour: number, from: number, to: number): boolean {
  return from <= to ? hour >= from && hour <= to : hour >= from || hour <= to;
}

export default class SmartBulbScheduler {
  async execute(lib: UserLib, args: string[]) {
    const { std, shell } = lib;

    if (args.includes("--help") || args.includes("-h")) {
      await std.println("Scheduler lampu otomatis JayaLaras (client IPC ke jayalaras.service).");
      await std.println("");
      await std.println("Aturan jadwal:");
      await std.println("  1) 18:00-04:00  ON  teras depan, teras belakang");
      await std.println("  2) 06:00-17:00  OFF teras depan, teras belakang");
      await std.println("  3) 23:00-03:00  OFF kamar anak, ruang tengah depan & belakang");
      await std.println("");
      await std.println("Usage:");
      await std.println("  scheduler.js          # jalankan sekali");
      await std.println("  scheduler.js --dry   # tampilkan keputusan saja (tanpa IPC)");
      return;
    }

    const now = new Date();
    const h = now.getHours();
    const pad = (n: number) => String(n).padStart(2, "0");
    const dry = args.includes("--dry");
    await std.println(
      `⏰ [smartbulb] scheduler ${pad(now.getHours())}:${pad(now.getMinutes())} (hour=${h})${dry ? " [DRY]" : ""}`,
    );

    // ── Keputusan jadwal per port ──
    const night = inRange(h, 18, 4); // aturan 1 (>=18:00 s.d. <=04:00)
    const day = inRange(h, 6, 17); // aturan 2 (>=06:00 s.d. <=17:00)
    const lateNight = inRange(h, 23, 3); // aturan 3 (>=23:00 s.d. <=03:00)

    const desired = new Map<number, boolean>();
    if (night) {
      desired.set(P_TERAS_DEPAN, true);
      desired.set(P_TERAS_BELAKANG, true);
    }
    if (day) {
      desired.set(P_TERAS_DEPAN, false);
      desired.set(P_TERAS_BELAKANG, false);
    }
    if (lateNight) {
      desired.set(P_KAMAR_ANAK, false);
      desired.set(P_RUANG_TENGAH_DEPAN, false);
      desired.set(P_RUANG_TENGAH_BELAKANG, false);
    }

    if (dry || desired.size === 0) {
      if (desired.size === 0) {
        await std.println("   (tidak ada aturan aktif jam ini — tidak menyentuh apa pun)");
      } else {
        for (const [p, on] of desired) {
          await std.println(`   ${on ? "ON " : "OFF"} port ${String(p).padStart(2, " ")}`);
        }
      }
      // --dry, atau tidak ada perubahan yang diperlukan jam ini → selesai tanpa IPC.
      return;
    }

    // ── State & listener balasan IPC (pola sama dgn setgpio.ts) ──
    // Dipakai objek penampung (bukan bare let) supaya TypeScript tidak
    // menyempitkan tipe variabel yang hanya di-assign dari dalam callback.
    const state: { latest: { ports: number[] } | null } = { latest: null };
    let waiter: (() => void) | null = null;

    lib.onEvent("ipc_message", (msg: any) => {
      const payload = msg?.data || msg;
      if (!payload || payload.type !== "SMARTBULB_STATE") return;
      state.latest = payload;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w();
      }
    });

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

    const send = async (p: Record<string, any>) => {
      try {
        await shell.send(SERVICE_ID, p);
      } catch (_) {
        /* service tak dikenal — tertangkap via timeout probe */
      }
    };

    // ── Probe: REGISTER → service balas state ke pid kita ──
    const probe = waitReply(PROBE_TIMEOUT_MS);
    await send({ type: "REGISTER" });
    if (!(await probe)) {
      await std.println(
        `❌ Service "${SERVICE_ID}" tidak merespon — pastikan /opt/smartbulb/service.js berjalan.`,
      );
      return;
    }

    // ── Ambil state terkini ──
    const g = waitReply(REPLY_TIMEOUT_MS);
    await send({ type: "GET" });
    await g;
    const ports: number[] = state.latest?.ports || [];

    // ── SET hanya port yang berbeda dari jadwal ──
    const changes: string[] = [];
    for (const [p, on] of desired) {
      const cur = ports[p] ? true : false;
      if (cur === on) {
        await std.println(`   port ${String(p).padStart(2, " ")} sudah ${on ? "ON" : "OFF"} (skip)`);
        continue;
      }
      const r = waitReply(REPLY_TIMEOUT_MS);
      await send({ type: "SET", port: p, on });
      await r;
      changes.push(`port ${p} → ${on ? "ON" : "OFF"}`);
      await std.println(`   ${on ? "💡 ON " : "🌑 OFF"} port ${String(p).padStart(2, " ")} (diubah)`);
    }

    // Lepas subscribe lalu selesai.
    await send({ type: "UNREGISTER" });

    await std.println(
      changes.length > 0 ? `   ✅ ${changes.join(", ")}` : "   ✅ tidak ada perubahan",
    );
  }
}
