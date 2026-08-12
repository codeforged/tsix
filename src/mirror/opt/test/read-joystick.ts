/**
 * read-joystick.ts — 🎮 Contoh aplikasi pembaca joystick (/dev/joystick)
 *
 * Membaca state joystick via userland library (joystickLib.ts) dan
 * menampilkannya ke terminal secara real-time.
 *
 * Jalankan (dari launcher Asteracea atau shell):
 *   read-joystick                  → scan 15 detik, print semua axis & tombol
 *   (buka terminal lain: joy-sim untuk inject joystick virtual)
 *   read-joystick --once           → keluar setelah tombol 0 ditekan
 *   read-joystick --count 5        → baca 5 sampel lalu keluar
 *   read-joystick --deadzone 0.15  → set deadzone sebelum membaca
 *
 * (c) 2026 TSIX Project
 */

import { Program, std } from "@tsix/Application";
import { joystick } from "@tsix/joystickLib";

export const main = Program(async (args: string[]) => {
  // ── Parse argumen sederhana ──
  const once = args.includes("--once");
  const dzIdx = args.indexOf("--deadzone");
  const deadzone = dzIdx >= 0 ? parseFloat(args[dzIdx + 1]) : NaN;
  const cntIdx = args.indexOf("--count");
  const maxSamples = cntIdx >= 0 ? parseInt(args[cntIdx + 1], 10) : Infinity;

  await std.println("");
  await std.println("════════════════════════════════════════");
  await std.println("  🎮 read-joystick — baca /dev/joystick");
  await std.println("════════════════════════════════════════");

  // ── Cek device tersedia ──
  if (!(await joystick.isAvailable())) {
    await std.error("❌ /dev/joystick tidak tersedia.");
    await std.error(
      "   Pastikan driver joystick sudah di-load kernel (aux-devices).",
    );
    return;
  }
  await std.println("✔ /dev/joystick tersedia");

  // ── Opsional: set deadzone ──
  if (!isNaN(deadzone)) {
    const dz = await joystick.setDeadzone(deadzone);
    await std.println(`✔ Deadzone diset → ${dz}`);
  }

  // ── Info perangkat ──
  const info = await joystick.getInfo();
  await std.println(
    `ℹ Info: id="${info?.id || "-"}" axes=${info?.axes ?? 0} buttons=${info?.buttons ?? 0
    } deadzone=${info?.deadzone ?? 0}`,
  );
  await std.println("");

  // ── Loop pembacaan real-time ──
  let samples = 0;
  const started = Date.now();
  const DURATION_MS = 15000; // default 15 detik

  while (true) {
    // Joystick belum terhubung → scan periodik
    if (!(await joystick.isConnected())) {
      await std.print("\r⌛ Joystick belum terhubung... (scan tiap 500ms)      ");
      if (once) break;
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }

    // Baca snapshot & format untuk terminal
    const st = await joystick.getState();
    const axStr = (st.axes || [])
      .map((v: number, i: number) => `A${i}:${v.toFixed(2)}`)
      .join(" ");
    const btnStr = (st.buttons || [])
      .map((v: number, i: number) => `B${i}:${v > 0.5 ? "█" : "·"}`)
      .join(" ");
    await std.print(`\r🎮 ${axStr}  |  ${btnStr}            `);
    samples++;

    // Kondisi keluar
    if (once && st.buttons[0] > 0.5) {
      await std.println("\n⏹ Tombol 0 ditekan — keluar.");
      break;
    }
    if (samples >= maxSamples) {
      await std.println("\n⏹ Mencapai batas sampel.");
      break;
    }
    if (Date.now() - started > DURATION_MS) {
      await std.println("\n⏰ Waktu habis (15 detik).");
      break;
    }

    await new Promise((r) => setTimeout(r, 100));
  }

  await joystick.close();
  await std.println("");
  await std.println("[read-joystick] Selesai ✅");
});
