/**
 * joy-sim.ts — 🕹️ Simulator joystick virtual (untuk tes /dev/joystick)
 *
 * Menyuntikkan state joystick virtual ke /dev/joystick via ioctl injection.
 * Jalankan di satu terminal, lalu `read-joystick` di terminal lain —
 * keduanya berbagi device kernel yang sama (Everything is a File).
 *
 * Jalankan: joy-sim [durasiDetik]
 *   - Gerakkan axis 0 & 1 (sinus/cosinus)
 *   - Kedipkan tombol 0..3
 *
 * (c) 2026 TSIX Project
 */

import { Program, std } from "@tsix/Application";
import { joystick } from "../../lib/joystickLib";

export const main = Program(async (args: string[]) => {
    const dur = args[0] ? parseFloat(args[0]) : 30;

    await std.println("");
    await std.println("🕹️ joy-sim — inject joystick virtual ke /dev/joystick");
    await std.println("════════════════════════════════════════");

    if (!(await joystick.isAvailable())) {
        await std.error("❌ /dev/joystick tidak tersedia.");
        await std.error(
            "   Pastikan driver joystick sudah di-load kernel (aux-devices).",
        );
        return;
    }

    await joystick.injectConnect("virtual-gamepad", 2, 4);
    await std.println("✔ Connected: virtual-gamepad (2 axes, 4 buttons)");
    await std.println(
        `   Durasi ${dur} detik. Jalankan read-joystick di terminal lain!`,
    );
    await std.println("");

    const started = Date.now();
    let n = 0;
    while (Date.now() - started < dur * 1000) {
        const t = n * 0.1;
        const axes = [Math.sin(t), Math.cos(t)];
        const buttons: number[] = [];
        for (let i = 0; i < 4; i++) {
            buttons.push((n + i) % 8 < 4 ? 1 : 0); // kedip bergantian
        }
        await joystick.injectState({
            connected: true,
            id: "virtual-gamepad",
            axes,
            buttons,
        });

        if (n % 10 === 0) {
            await std.println(
                `⏱ t=${t.toFixed(1)}s A0=${axes[0].toFixed(2)} A1=${axes[1].toFixed(
                    2,
                )} B=[${buttons.map((b) => (b ? "█" : "·")).join("")}]`,
            );
        }
        n++;
        await new Promise((r) => setTimeout(r, 100));
    }

    await joystick.injectDisconnect();
    await std.println("");
    await std.println("🕹️ joy-sim selesai (disconnect). ✅");
});
