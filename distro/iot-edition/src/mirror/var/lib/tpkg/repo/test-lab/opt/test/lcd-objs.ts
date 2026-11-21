/**
 * lcd-objs.ts — 🖥️ Stress-demo animasi LCD 128x64 (banyak objek, 1 syscall/frame)
 *
 * Tujuan: membuktikan jalur cepat LCD TSIX tetap kencang saat layar dipenuhi
 * objek bergerak. SEMUA gambar diraster LOKAL di `LcdFramebuffer` (nol syscall),
 * lalu di-present dengan SATU `blit()` per frame — auto-flush ON membuat driver
 * menjalankan clear + drawBitmap + display di dalam satu `write()`. Jadi:
 * 1 frame = 1 round-trip IPC, bukan 1 syscall per objek.
 *
 * Isi animasi (semua matematika trivial — tambah/balik tanda saja):
 *   - Kotak terisi yang memantul di tepi area main.
 *   - Segitiga terisi yang memantul (raster scanline lokal, bukan ioctl).
 *   - Bar bergerak di band bawah (tingginya naik-turun lalu balik arah).
 *   - HUD kecil: FPS aktual + jumlah objek (font 3x5 lokal, tanpa syscall).
 *
 * ── PEMAKAIAN ──
 *   lcd-objs                       → jalan terus (Ctrl+C berhenti)
 *   lcd-objs 10                    → jalan 10 detik, lalu cetak ringkasan
 *   lcd-objs 10 --sq 8 --tri 6     → jumlah kotak / segitiga terisi
 *   lcd-objs --bars 24             → jumlah bar bawah
 *   lcd-objs --fps 30              → pacing ≈30 fps (ini DEFAULT)
 *   lcd-objs --fps 0               → tanpa jeda (max; untuk stress/benchmark)
 *   lcd-objs --help                → daftar opsi lengkap (tanpa buka source 🙂)
 *
 * Tanpa hardware (panel palsu / PLCD):
 *   /opt/plcd/launcher /opt/test/lcd-objs.ts 10
 *
 * ⚠️ POLA PENTING — JANGAN diubah: jangan memakai `lcd.fillRect()`/
 * `lcd.drawPixel()` per objek. Tiap panggilan itu 1 round-trip IPC, jadi
 * 10 objek × 30 fps = 300 syscall/detik dan FPS langsung jatuh. Gambar di
 * framebuffer lokal, present **sekali** per frame.
 *
 * (c) 2026 TSIX Project
 */

import { Program, std } from "@tsix/Application";
import { lcd, LcdFramebuffer, LCD_WIDTH, LCD_HEIGHT, type LcdColor } from "@tsix/lcdLib";

const W = LCD_WIDTH; // 128
const H = LCD_HEIGHT; // 64

/** Band atas untuk HUD (FPS + jumlah objek) dan band bawah untuk bars. */
const HUD_H = 8;
const BAR_H = 12;
/** Area main objek memantul: di antara HUD dan bars. */
const PLAY_TOP = HUD_H;
const PLAY_BOT = H - BAR_H - 1; // 51

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ================================================================
// FONT HUD 3x5 (lokal — digambar ke framebuffer, tanpa syscall)
// ================================================================
const FONT: Record<string, number[]> = {
    "0": [7, 5, 5, 5, 7],
    "1": [2, 6, 2, 2, 7],
    "2": [7, 1, 7, 4, 7],
    "3": [7, 1, 7, 1, 7],
    "4": [5, 5, 7, 1, 1],
    "5": [7, 4, 7, 1, 7],
    "6": [7, 4, 7, 5, 7],
    "7": [7, 1, 2, 2, 2],
    "8": [7, 5, 7, 5, 7],
    "9": [7, 5, 7, 1, 7],
    B: [6, 5, 6, 5, 6],
    F: [7, 4, 7, 4, 4],
    K: [5, 5, 6, 5, 5],
    O: [7, 5, 5, 5, 7],
    P: [7, 5, 7, 4, 4],
    S: [7, 4, 7, 1, 7],
    " ": [0, 0, 0, 0, 0],
    ":": [0, 2, 0, 2, 0],
};

/** Lebar teks 3x5 dalam piksel (advance 4 px/char). */
function textWidth(text: string): number {
    return text.length * 4 - 1;
}

/** Gambar teks 3x5 lokal ke framebuffer (tanpa syscall). */
function drawText(fb: LcdFramebuffer, x: number, y: number, text: string, color: LcdColor = 1): void {
    const str = String(text).toUpperCase();
    let cx = x;
    for (let i = 0; i < str.length; i++) {
        const g = FONT[str.charAt(i)] || FONT[" "];
        for (let r = 0; r < 5; r++) {
            const bits = g[r];
            if (bits & 4) fb.setPixel(cx, y + r, color);
            if (bits & 2) fb.setPixel(cx + 1, y + r, color);
            if (bits & 1) fb.setPixel(cx + 2, y + r, color);
        }
        cx += 4;
    }
}

/** Teks 3x5 rata-kanan di `rightX` (eksklusif). */
function drawTextRight(fb: LcdFramebuffer, rightX: number, y: number, text: string, color: LcdColor = 1): void {
    drawText(fb, rightX - textWidth(String(text)), y, text, color);
}

// ================================================================
// RASTER LOKAL
// ================================================================

/**
 * Segitiga terisi (scanline) — versi lokal supaya tidak memakai ioctl
 * `LCD_FILL_TRIANGLE` (yang berarti 1 syscall per objek per frame).
 * Titik di luar layar aman: `fb.hLine`/`setPixel` sudah bounds-check.
 */
function fillTri(
    fb: LcdFramebuffer,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: LcdColor = 1,
): void {
    // Urutkan puncak: (ax,ay) paling atas → (cx,cy) paling bawah.
    let ax = x0,
        ay = y0,
        bx = x1,
        by = y1,
        cx = x2,
        cy = y2;
    if (ay > by) [ax, ay, bx, by] = [bx, by, ax, ay];
    if (by > cy) [bx, by, cx, cy] = [cx, cy, bx, by];
    if (ay > by) [ax, ay, bx, by] = [bx, by, ax, ay];

    const lerp = (ya: number, xa: number, yb: number, xb: number, y: number) =>
        yb === ya ? xa : xa + ((xb - xa) * (y - ya)) / (yb - ya);

    for (let y = ay; y <= cy; y++) {
        const xs: number[] = [];
        if (y >= ay && y <= by) xs.push(lerp(ay, ax, by, bx, y));
        if (y >= by && y <= cy) xs.push(lerp(by, bx, cy, cx, y));
        if (y >= ay && y <= cy) xs.push(lerp(ay, ax, cy, cx, y));
        if (!xs.length) continue;
        const lo = Math.round(Math.min(...xs));
        const hi = Math.round(Math.max(...xs));
        fb.hLine(lo, y, hi - lo + 1, color);
    }
}

// ================================================================
// OBJEK BERGERAK
// ================================================================

type Shape = "rect" | "tri";

interface Mover {
    x: number;
    y: number;
    w: number;
    h: number;
    vx: number;
    vy: number;
    shape: Shape;
}

/** Bar bawah: tinggi naik-turun, balik arah saat menyentuh batas. */
interface Bar {
    h: number;
    v: number;
}

/** Langkah + pantulan sederhana: cukup tambah lalu balik tanda. */
function stepMover(o: Mover): void {
    o.x += o.vx;
    o.y += o.vy;
    if (o.x <= 0) {
        o.x = 0;
        o.vx = -o.vx;
    } else if (o.x + o.w >= W) {
        o.x = W - o.w;
        o.vx = -o.vx;
    }
    if (o.y <= PLAY_TOP) {
        o.y = PLAY_TOP;
        o.vy = -o.vy;
    } else if (o.y + o.h >= PLAY_BOT) {
        o.y = PLAY_BOT - o.h;
        o.vy = -o.vy;
    }
}

function drawMover(fb: LcdFramebuffer, o: Mover): void {
    const x = Math.round(o.x);
    const y = Math.round(o.y);
    if (o.shape === "rect") {
        fb.fillRect(x, y, o.w, o.h, 1);
    } else {
        fillTri(fb, x + (o.w >> 1), y, x, y + o.h - 1, x + o.w - 1, y + o.h - 1, 1);
    }
}

// ================================================================
// BANTUAN (--help)
// ================================================================

/** Cetak cara pakai lengkap — dipanggil oleh `-h` / `--help`. */
async function printHelp(): Promise<void> {
    await std.println("");
    await std.println("🎯 lcd-objs — stress animasi LCD 128x64 (1 syscall/frame)");
    await std.println("");
    await std.println("PEMAKAIAN");
    await std.println("  lcd-objs [detik] [opsi]");
    await std.println("");
    await std.println("ARGUMEN");
    await std.println("  detik            Lama jalan (detik). Kosong / 0 = terus-menerus,");
    await std.println("                   berhenti dengan Ctrl+C.");
    await std.println("");
    await std.println("OPSI");
    await std.println("  --sq N           Kotak terisi memantul          (default 5)");
    await std.println("  --tri N          Segitiga terisi memantul       (default 4)");
    await std.println("  --bars N         Bar bergerak di band bawah     (default 16)");
    await std.println("  --fps N          Batasi laju frame; 0 = bebas   (default 30)");
    await std.println("  -h, --help       Tampilkan bantuan ini");
    await std.println("");
    await std.println("CONTOH");
    await std.println("  lcd-objs 10                   10 detik, setelan default");
    await std.println("  lcd-objs 10 --sq 8 --tri 6    8 kotak + 6 segitiga");
    await std.println("  lcd-objs --bars 24            24 bar");
    await std.println("  lcd-objs --fps 30             batasi ≈30 fps (33 ms/frame)");
    await std.println("  lcd-objs 10 --sq 15 --tri 10 --bars 32    mode spam objek");
    await std.println("");
    await std.println("TANPA HARDWARE (panel palsu / PLCD)");
    await std.println("  /opt/plcd/launcher /opt/test/lcd-objs.ts 10");
    await std.println("");
    await std.println("CATATAN");
    await std.println("  Semua objek diraster LOKAL di framebuffer, lalu di-present");
    await std.println("  SEKALI per frame (blit + autoFlush) — jumlah objek TIDAK");
    await std.println("  menambah syscall. FPS aktual tampil di HUD panel.");
    await std.println("");
    await std.println("  Pacing default 30 fps. Saat dilihat lewat PLCD emulator, JANGAN");
    await std.println("  pakai --fps 0: app yang berlari 300+ fps hanya disampling ~60 Hz");
    await std.println("  oleh viewer, jadi objek terlihat melompat (aliasing temporal).");
    await std.println("");
}

// ================================================================
// MAIN
// ================================================================

export const main = Program(async (args: string[]) => {
    // ── Parsing argumen (sengaja sederhana, tanpa dependensi) ──
    const positional: string[] = [];
    let nSq = 5;
    let nTri = 4;
    let nBars = 16;
    /**
     * Pacing default 30 fps. Penting untuk PLCD/emulator: kalau app berlari
     * tanpa jeda (300+ fps di pseudo-LCD), viewer yang sampling ~60 Hz hanya
     * menangkap sepersekian frame → objek tampak MELOMPAT (aliasing temporal),
     * bukan karena viewer-nya lambat. Pakai `--fps 0` untuk mode bebas
     * (stress/benchmark) — di hardware panel sendiri mentok ~28 fps karena SPI.
     */
    let fpsCap = 30;
    let wantHelp = false;
    /** Flag yang salah / kehilangan nilai — dilaporkan, bukan diam-diam diabaikan. */
    let badArg: string | null = null;

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const raw = args[i + 1];
        // Nilai dianggap ada kalau bukan flag lain (mis. `--sq --tri` = salah).
        const hasVal = raw !== undefined && !raw.startsWith("-");

        if (a === "-h" || a === "--help") {
            wantHelp = true;
        } else if (a === "--sq" || a === "--tri" || a === "--bars" || a === "--fps") {
            if (!hasVal) {
                badArg = a;
                continue;
            }
            i++;
            const n = Math.max(0, parseInt(raw, 10) || 0);
            if (a === "--sq") nSq = n;
            else if (a === "--tri") nTri = n;
            else if (a === "--bars") nBars = n;
            else fpsCap = n;
        } else if (a.startsWith("-")) {
            badArg = a;
        } else {
            positional.push(a);
        }
    }

    // Bantuan lebih dulu — tidak perlu hardware, tidak buka FD.
    if (wantHelp) {
        await printHelp();
        return;
    }

    // Durasi harus angka bulat; salah ketik (mis. `lcd-objs abc`) jangan
    // diam-diam dianggap "jalan terus".
    if (positional[0] !== undefined && !/^\d+$/.test(positional[0])) badArg = positional[0];
    if (badArg) {
        await std.error(`❌ Argumen tidak dikenal / nilai hilang: ${badArg}`);
        await std.error("   Jalankan `lcd-objs --help` untuk daftar opsi.");
        return;
    }

    const seconds = Math.max(0, parseInt(positional[0], 10) || 0);
    /** Jeda antar-frame; 0 = tanpa jeda (frame secepat panel). */
    const frameMs = fpsCap > 0 ? Math.max(1, Math.round(1000 / fpsCap)) : 0;

    await std.println("");
    await std.println("╔════════════════════════════════════════════╗");
    await std.println("║ 🎯 lcd-objs — stress animasi (1 syscall/f)  ║");
    await std.println("╚════════════════════════════════════════════╝");

    try {
        if (!(await lcd.isAvailable())) {
            await std.error(`❌ ${lcd.devicePath} belum siap (available=false).`);
            await std.error("   Cek SPI / paket lm6029acw, atau jalankan lewat launcher PLCD.");
            return;
        }

        // Present per frame = 1 write() di driver (clear + blit + display).
        await lcd.setAutoFlush(true);

        const info = await lcd.getInfo();
        await std.println(`✔ ${lcd.devicePath} — ${info?.width}x${info?.height}` + (info?.pseudo ? " (pseudo)" : ""));
        await std.println(
            `   objek: ${nSq} kotak + ${nTri} segitiga + ${nBars} bar` +
                ` • pacing: ${frameMs ? `${fpsCap} fps (${frameMs} ms)` : "tanpa jeda"}` +
                ` • durasi: ${seconds ? `${seconds}s` : "terus-menerus (Ctrl+C)"}`,
        );

        // ── Bangun objek ──
        const rnd = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
        const rndSign = () => (Math.random() < 0.5 ? -1 : 1);

        const movers: Mover[] = [];
        for (let i = 0; i < nSq; i++) {
            const w = 8 + Math.floor(Math.random() * 7);
            const h = 6 + Math.floor(Math.random() * 5);
            movers.push({
                x: rnd(0, W - w),
                y: rnd(PLAY_TOP, PLAY_BOT - h),
                w,
                h,
                vx: rndSign() * (1 + Math.floor(Math.random() * 2)),
                vy: rndSign() * (1 + Math.floor(Math.random() * 2)),
                shape: "rect",
            });
        }
        for (let i = 0; i < nTri; i++) {
            const w = 10 + Math.floor(Math.random() * 8);
            const h = 8 + Math.floor(Math.random() * 6);
            movers.push({
                x: rnd(0, W - w),
                y: rnd(PLAY_TOP, PLAY_BOT - h),
                w,
                h,
                vx: rndSign() * (1 + Math.floor(Math.random() * 2)),
                vy: rndSign() * (1 + Math.floor(Math.random() * 2)),
                shape: "tri",
            });
        }

        // Bar bawah: tinggi 2..maxBarH, arah bervariasi.
        const barMaxH = BAR_H - 2;
        const barW = nBars > 0 ? Math.max(2, Math.floor(W / nBars) - 1) : 0;
        const bars: Bar[] = [];
        for (let i = 0; i < nBars; i++) {
            bars.push({ h: 2 + Math.floor(Math.random() * (barMaxH - 1)), v: rndSign() });
        }

        const barBaseline = H - 1;
        const fb = lcd.framebuffer(); // satu back-buffer dipakai ulang

        let frames = 0;
        let totalFrames = 0;
        let fps = 0;
        let fpsWindowStart = Date.now();
        const startedAt = fpsWindowStart;
        let run = true;

        while (run) {
            fb.clear();

            // 1) HUD (band atas) — FPS + jumlah objek (O) / bar (B).
            drawText(fb, 1, 1, `FPS:${fps}`);
            drawTextRight(fb, W - 1, 1, `${movers.length}O ${bars.length}B`);
            fb.hLine(0, HUD_H - 1, W, 1);

            // 2) Objek memantul.
            for (const o of movers) {
                stepMover(o);
                drawMover(fb, o);
            }

            // 3) Bars bawah (naik-turun lalu balik arah).
            for (let i = 0; i < bars.length; i++) {
                const b = bars[i];
                b.h += b.v;
                if (b.h <= 2) {
                    b.h = 2;
                    b.v = -b.v;
                } else if (b.h >= barMaxH) {
                    b.h = barMaxH;
                    b.v = -b.v;
                }
                fb.fillRect(i * (barW + 1), barBaseline - b.h + 1, barW, b.h, 1);
            }

            // 4) Present 1 frame = 1 syscall (autoFlush ON).
            await lcd.blit(fb);

            frames++;
            totalFrames++;

            // Hitung FPS aktual sekali per detik (tanpa syscall).
            const now = Date.now();
            if (now - fpsWindowStart >= 1000) {
                fps = Math.round((frames * 1000) / (now - fpsWindowStart));
                frames = 0;
                fpsWindowStart = now;
                if (seconds && now - startedAt >= seconds * 1000) run = false;
            }

            if (frameMs) await sleep(frameMs);
        }

        const elapsed = (Date.now() - startedAt) / 1000;
        const avg = elapsed > 0 ? (totalFrames / elapsed).toFixed(1) : "0";
        await std.println("");
        await std.println(
            `✔ Selesai: ${totalFrames} frame dalam ${elapsed.toFixed(1)}s` +
                ` — rata-rata ${avg} fps (${movers.length} kotak/segitiga + ${bars.length} bar).`,
        );
    } catch (e: any) {
        await std.error(`❌ Error: ${e.message}`);
    } finally {
        await lcd.close();
    }

    await std.println("");
});
