/**
 * cli-read-keyboard — Versi CLI dari gui-read-keyboard.
 *
 * Lapisan tipis di atas lib.keyboard (KeyboardLib di UserLib.ts —
 * padanan CLI dari TKeyboard Cashew). Semua decode escape sequence,
 * control char, & modifier ditangani di lib.
 *
 * Perbedaan dengan versi GUI (TKeyboard):
 *   - Terminal HANYA mengirim byte stream — TIDAK ada event keyup &
 *     auto-repeat. Jadi semua tampil sebagai [▼ down], dan kolom repeat
 *     tidak tersedia (hanya bisa ditebak, tidak andal).
 *
 * Jalankan: /opt/test/cli-read-keyboard
 * Keluar  : Ctrl+C (atau Ctrl+D). Jangan pakai Q — itu tombol yang mau dites.
 */

import { Program, std, keyboard, shell } from "@tsix/Application";

export const main = Program(async () => {
  await std.println("=== cli-read-keyboard (raw keyboard decoder) ===");
  await std.println(
    "Tekan tombol apa saja. Keluar: Ctrl+C (terminal tidak kirim keyup/repeat).\n",
  );

  // Claim SIGINT supaya proses tidak di-terminate default oleh kernel;
  // byte \x03 tetap masuk ke buffer raw → kita tangani & keluar rapi.
  shell.onSignal("SIGINT", () => {});

  await keyboard.enable();
  try {
    while (true) {
      const ev = await keyboard.readKey();
      if (!ev) break;

      const mods =
        (ev.ctrl ? "Ctrl+" : "") +
        (ev.shift ? "Shift+" : "") +
        (ev.alt ? "Alt+" : "");
      await std.print(
        `\x1b[36m[▼ down] ${mods}${ev.key}  · code: ${ev.code} · seq: ${ev.seq}\x1b[0m\n`,
      );

      // Keluar: Ctrl+C / Ctrl+D
      if (ev.ctrl && (ev.code === "KeyC" || ev.code === "KeyD")) break;
    }
  } finally {
    await keyboard.disable();
    await std.print("\x1b[0m"); // reset atribut ANSI
  }
  await std.println("\n[keluar]");
});
