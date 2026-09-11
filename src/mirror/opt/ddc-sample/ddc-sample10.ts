/**
 * ddc-sample10.ts — DDC Sample #10: LCD MONOKROM 160×80 (KALKULATOR GRAFIS)
 *
 * TGA (TSIX GUI App) — pasangannya: graphcalc.js (NJ).
 *
 * Layar LCD dot-matrix khas kalkulator grafis:
 *   - 160×80 piksel LOGIKA (logika kalkulator: 1 px = 4 px fisik, scale 4).
 *   - MONOKROM: piksel ON hitam pekat di atas "kaca" hijau metalik —
 *     hanya 2 level (bukan anti-alias), persis LCD grafis era 90-an.
 *   - TRAILING (persistence): piksel yang padam tidak langsung hilang —
 *     levelnya luruh bertahap dan di-dither Bayer 4×4 sehingga tampak
 *     membayang lalu memudar, khas LCD matriks pasif. Bisa di-toggle.
 *   - Font bitmap 3×5, grid titik, sumbu + tick, kurva fungsi, dan
 *     kursor TRACE dengan crosshair titik-titik.
 *   - Tombol keypad (SIN/COS/TAN/X²/GRID/TRAIL) mengirim perintah ke NJ
 *     lewat jembatan DDC (TGA ⇄ NJ) — zero WebSocket per-frame.
 *
 * CARA LIB SAMPAI KE NJ: DOME menyajikan hasil transpile /lib/framebuffer.ts
 * sebagai asset statis /dome/framebuffer.js (IIFE) → window.FrameBuffer →
 * dome-client-ddc.js menempelkannya ke DDC.FrameBuffer. NJ tinggal:
 *     var fb = new DDC.FrameBuffer(c2, W, H, { scale: n });
 * TIDAK perlu prepend/transpile apa pun di TGA.
 *
 * Jalankan: ddc-sample10
 * PASTIKAN DOME SUDAH RUNNING: dome
 * DEPLOY: sync VFS → restart DOME → hard-refresh browser (asset statis
 * dibaca sekali saat startup; /lib/framebuffer.ts harus ada →
 * npm run vfs:bootstrap).
 */

import { Program, std, fs } from "@tsix/Application";
import { TForm, TPanel, TLabel, TButton, HStack } from "@tsix/cashew";
import { mountDDC, DDCApp } from "@tsix/ddc";
import { theme } from "@tsix/theme";

export const appMode = "gui";

// ================================================================
// GEOMETRI LCD — 160×80 logika, di-zoom 4× → 640×320 fisik
// ================================================================
const LG_W = 160;
const LG_H = 80;
const SCALE = 2;
const PHYS_W = LG_W * SCALE; // 640
const PHYS_H = LG_H * SCALE; // 320

const NJ_PATH = "/opt/ddc-sample/graphcalc.js";

export const main = Program(async (_args: string[]) => {
    await std.log("=== DDC Sample 10 — Graphic Calculator LCD 160×80 (mono) ===");

    // ================================================================
    // FORM — Delphi style + chassis plastik gelap ala kalkulator
    // ================================================================
    const form = new TForm({
        title: "DDC Sample 10 — Graphic Calculator (160×80 Mono LCD)",
        icon: "🧮",
        width: 700,
        height: 520,
        maximizable: false,
        resizable: false,
    });
    form.style = { ...form.style, padding: "0", margin: "0" };

    const lblTitle = new TLabel("lbl-title");
    lblTitle.caption = "🧮 TSIX Graphic Calculator — LCD Monokrom 160×80";
    lblTitle.style = {
        fontSize: "13px",
        fontWeight: "700",
        color: theme.colors.accent,
        padding: "10px 12px 0 12px",
    };
    form.add(lblTitle);

    const lblStatus = new TLabel("lbl-status");
    lblStatus.caption = "⏳ Menyiapkan LCD monokrom...";
    lblStatus.style = {
        fontSize: "11px",
        color: theme.colors.textMuted,
        fontFamily: "monospace",
        padding: "2px 12px 6px 12px",
    };
    form.add(lblStatus);

    let anim: DDCApp | null = null;

    // --- Chassis kalkulator (plastik gelap, sudut membulat) ---
    const body = new TPanel("calc-body", {
        alignSelf: "center",
        padding: "14px 14px 12px 14px",
        borderRadius: "16px",
        border: "1px solid #45454f",
        background: "linear-gradient(180deg, #35353f 0%, #24242b 55%, #191920 100%)",
        boxShadow: "0 12px 28px rgba(0,0,0,0.5)",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
    });

    // --- Bezel (bingkai hitam) yang menenggelamkan LCD ---
    const bezel = new TPanel("lcd-bezel", {
        alignSelf: "center",
        boxSizing: "border-box",
        width: PHYS_W + 14 + "px",
        height: PHYS_H + 14 + "px",
        padding: "6px",
        borderRadius: "8px",
        border: "1px solid #000",
        background: "#0b0d08",
        boxShadow: "inset 0 2px 10px rgba(0,0,0,0.85)",
    });

    // --- Panel LCD: ukuran DIKUNCI pas 640×320 supaya ResizeObserver
    //     DOME melihat canvas = kelipatan pas dari 160×80 (scale 4). ---
    const stage = new TPanel("stage", {
        boxSizing: "border-box",
        width: PHYS_W + "px",
        height: PHYS_H + "px",
        flex: "0 0 auto",
        padding: "0",
        margin: "0",
        border: "none",
        borderRadius: "0",
        overflow: "hidden",
        background: "rgb(172, 209, 93)", // hijau metalik (warna piksel OFF)
    });
    bezel.add(stage);

    // --- Baris merek di bawah LCD ---
    const brandLeft = new TLabel("lbl-brand");
    brandLeft.caption = "TSIX-GC10";
    brandLeft.style = {
        fontSize: "11px",
        fontWeight: "700",
        letterSpacing: "2px",
        color: "#c9d6a8",
        fontFamily: "monospace",
    };

    const brandRight = new TLabel("lbl-brand-r");
    brandRight.caption = "GRAPHING CALCULATOR · MONO LCD";
    brandRight.style = {
        fontSize: "10px",
        letterSpacing: "1px",
        color: "#8d9a76",
        fontFamily: "monospace",
    };

    body.add(HStack({ justifyContent: "space-between", width: "100%" }, brandLeft, brandRight));
    body.add(bezel);

    // ================================================================
    // KEYPAD — tombol kalkulator (perintah TGA → NJ)
    // ================================================================
    const makeKey = (id: string, caption: string, send: () => any, width = "74px"): TButton => {
        const b = new TButton(id);
        b.caption = caption;
        b.style = {
            width,
            padding: "7px 0",
            fontSize: "11px",
            fontWeight: "700",
            fontFamily: "monospace",
            color: "#e6eeda",
            background: "linear-gradient(180deg, #4b4b57 0%, #2a2a32 100%)",
            border: "1px solid #5c5c6a",
            borderRadius: "6px",
            boxShadow: "0 2px 0 #101014",
            cursor: "pointer",
        };
        b.onClick = () => {
            if (anim) void anim.send(send());
        };
        return b;
    };

    const keypad = HStack(
        { justifyContent: "center", width: "100%", gap: "8px" },
        makeKey("key-onoff", "ON/OFF", () => {
            lblStatus.caption = "ON/OFF";
            return { cmd: "on/off" };
        }),
        makeKey("key-sin", "SIN", () => {
            lblStatus.caption = "🎛️ Y1=SIN(X) dikirim ke NJ";
            return { cmd: "fn", value: "SIN" };
        }),
        makeKey("key-cos", "COS", () => {
            lblStatus.caption = "🎛️ Y1=COS(X) dikirim ke NJ";
            return { cmd: "fn", value: "COS" };
        }),
        makeKey("key-tan", "TAN", () => {
            lblStatus.caption = "🎛️ Y1=TAN(X) dikirim ke NJ";
            return { cmd: "fn", value: "TAN" };
        }),
        makeKey("key-x2", "X²", () => {
            lblStatus.caption = "🎛️ Y1=X²/12-1.5 dikirim ke NJ";
            return { cmd: "fn", value: "X2" };
        }),
        makeKey("key-grid", "GRID", () => {
            lblStatus.caption = "🎛️ Toggle grid titik";
            return { cmd: "grid" };
        }),
        makeKey("key-trail", "TRAIL", () => {
            lblStatus.caption = "🎛️ Toggle trailing (persistence LCD)";
            return { cmd: "trail" };
        }),
    );
    body.add(keypad);

    form.add(body);

    // ================================================================
    // DDC — baca NJ dari folder yang sama, mount ke panel LCD
    // ================================================================
    form.onSetup = async (screen) => {
        const src = (await fs.readFile(NJ_PATH)) || "";
        if (!src) {
            await std.error("[ddc-sample10] NJ tidak ditemukan: " + NJ_PATH);
        }

        anim = await mountDDC(screen, { id: "ddc-lcd", source: src, width: PHYS_W, height: PHYS_H }, "stage");

        anim.on("ready", (ev: any) => {
            lblStatus.caption = `✅ LCD ${ev.width}×${ev.height} px (mono, skala ×${ev.scale}) — trailing ${ev.trail ? "ON" : "OFF"}`;
        });

        anim.on("state", (ev: any) => {
            lblStatus.caption = `🎛️ Y1=${ev.mode}(X) • grid ${ev.grid ? "ON" : "OFF"} • trailing ${ev.trail ? "ON" : "OFF"}`;
        });
    };

    await form.run();

    // Cleanup: hentikan NJ saat form tutup (anti resource leak)
    const ddcHandle: DDCApp | null = anim as DDCApp | null;
    if (ddcHandle) await ddcHandle.destroy();
    await std.log("[ddc-sample10] Done ✅");
});
