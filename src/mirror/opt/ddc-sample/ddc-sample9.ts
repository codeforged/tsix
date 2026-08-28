/**
 * ddc-sample9.ts — DDC Sample #9: FRAMEBUFFER 2D PRIMITIVES
 *
 * TGA (TSIX GUI App) — pasangannya: framebufferdemo.js (NJ).
 * Demo library @tsix/framebuffer (mirror Adafruit-GFX) yang menggambar
 * primitif 2D langsung ke ImageData (framebuffer):
 *   pixel, line, hline, vline, rect, fillRect, circle, fillCircle,
 *   arc, triangle, fillTriangle, roundRect, polyline — plus present()
 *   (swap-buffer) dengan mode scale (piksel logika → blok fisik). * Adegan statis (bukan animasi) — cukup satu stage canvas penuh. *
 * CARA LIB SAMPAI KE NJ (SEDERHANA):
 *   Library framebuffer disajikan DOME sebagai asset statis /dome/framebuffer.js
 *   (transpile IIFE dari /lib/framebuffer.ts saat DOME startup), dimuat browser
 *   via <script> di dome-client.html → global window.FrameBuffer.
 *   dome-client-ddc.js lalu menempelkannya ke object DDC, sehingga NJ tinggal:
 *       var fb = new DDC.FrameBuffer(c2, W, H, { scale: 2 });
 *   TIDAK perlu prepend/transpile apa pun di TGA.
 *
 * Jalankan: ddc-sample9
 * PASTIKAN DOME SUDAH RUNNING: dome
 * DEPLOY: sync VFS → restart DOME → hard-refresh browser (asset statis dibaca
 * sekali saat startup; /lib/framebuffer.ts harus ada → npm run vfs:bootstrap).
 */

import { Program, std, fs } from "@tsix/Application";
import { TForm, TPanel } from "@tsix/cashew";
import { mountDDC, DDCApp } from "@tsix/ddc";

export const appMode = "gui";

export const main = Program(async (_args: string[]) => {
    await std.log("=== DDC Sample 9 — Framebuffer 2D Primitives ===");

    const NJ_PATH = "/opt/ddc-sample/framebufferdemo.js";

    // ================================================================
    // FORM — Delphi style (sederhana: satu stage penuh)
    // ================================================================
    const form = new TForm({
        title: "DDC Sample 9 — Framebuffer 2D Primitives",
        icon: "🖼️",
        width: 660,
        height: 480,
        maximizable: false,
        resizable: false,
    });
    form.style = { ...form.style, padding: "0", margin: "0" };
    const stage = new TPanel("stage", {
        flex: "1",
        minHeight: "0",
        padding: "0",
        overflow: "hidden",
        background: "#0a0a1e",
        borderRadius: "0",
    });
    form.add(stage);

    // ================================================================
    // DDC — baca NJ dari folder yang sama, mount ke stage
    // ================================================================
    let anim: DDCApp | null = null;

    form.onSetup = async (screen) => {
        const src = (await fs.readFile(NJ_PATH)) || "";
        if (!src) {
            await std.error("[ddc-sample9] NJ tidak ditemukan: " + NJ_PATH);
        }
        anim = await mountDDC(
            screen,
            { id: "ddc-fb", source: src, width: 620, height: 400 },
            "stage",
        );
    };

    await form.run();

    // Cleanup: hentikan NJ saat form tutup (anti resource leak)
    const ddcHandle: DDCApp | null = anim as DDCApp | null;
    if (ddcHandle) await ddcHandle.destroy();
    await std.log("[ddc-sample9] Done ✅");
});
