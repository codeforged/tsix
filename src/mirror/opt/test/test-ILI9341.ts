/**
 * test-ILI9341.ts — 🖥️ Demo & uji TFT WARNA 320x240 (ILI9341) via /dev/tft
 *
 * Versi TSIX dari skrip Node yang menulis RGB565 langsung ke `/dev/fb1`:
 * aplikasi TIDAK menyentuh framebuffer host sama sekali, cukup bicara ke
 * `/dev/tft` lewat HAL ("Everything is a File") — buka fd → ioctl / write →
 * tutup. Deteksi node `/dev/fbN`, konversi warna, dan rasterisasi ada di
 * driver (`ILI9341Device`) + library (`@tsix/tftLib`).
 *
 * ── PEMAKAIAN ──
 *   test-ILI9341                        → suite visual lengkap (7 scene)
 *   test-ILI9341 --fast                 → suite dengan jeda lebih singkat
 *   test-ILI9341 info                   → status driver (GET_INFO) + node fb host
 *   test-ILI9341 clear                  → bersihkan layar
 *   test-ILI9341 text "Halo TSIX"       → cetak teks berwarna
 *   test-ILI9341 colors                 → palet + rampa R/G/B (uji warna & urutan)
 *   test-ILI9341 shapes                 → semua primitive GFX berwarna
 *   test-ILI9341 fonts                  → 4 font × 3 ukuran (transparan & opaque)
 *   test-ILI9341 fb                     → pola framebuffer (cek orientasi/stride)
 *   test-ILI9341 sprites                → drawBitmap 1 bpp + sprite RGB565
 *   test-ILI9341 rotation               → putar 0..3 dengan penanda arah
 *   test-ILI9341 rotation 1             → set rotasi (0..3)
 *   test-ILI9341 hud [detik]            → dashboard animasi (default 10s, 0 = terus)
 *   test-ILI9341 fps [detik]            → benchmark 8 fase (default 3s/fase)
 *   test-ILI9341 fbdev                  → tampilkan node framebuffer host
 *   test-ILI9341 fbdev /dev/fb2         → pindah node framebuffer host
 *   test-ILI9341 brightness 0..255      → kecerahan (butuh backlightPath)
 *   test-ILI9341 backlight|invert|display on|off
 *   test-ILI9341 pixel <x> <y>          → baca warna satu piksel (round-trip)
 *
 * Konstanta ioctl sudah dibungkus `src/mirror/lib/tftLib.ts` — aplikasi cukup
 * `import { tft, rgb } from "@tsix/tftLib"`, tanpa hardcode magic number.
 *
 * ── ANIMASI: TIGA HAL YANG MENENTUKAN FPS ──
 *   1. `await tft.xxx()` = 1 round-trip IPC. Jangan gambar per-piksel lewat
 *      ioctl (ratusan round-trip/frame) — gambar LOKAL di `TftFramebuffer`
 *      (nol syscall), lalu kirim frame sekali.
 *   2. Satu `flush()` memindahkan **150 KB** ke /dev/fbN. Jangan flush
 *      berkali-kali per frame.
 *   3. `blit()` MENGGANTI seluruh isi layar, jadi teks yang sudah dicetak di
 *      back-buffer kernel akan terhapus oleh blit berikutnya. Teks tidak bisa
 *      diraster lokal (font ada di kernel) → untuk HUD berteks pakai pola
 *      **autoFlush OFF**:
 *
 *          await tft.setAutoFlush(false);
 *          for (;;) {
 *            fb.clear(...); ...gambar lokal...;
 *            await tft.blit(fb);                    // 1 syscall (ke back-buffer)
 *            await tft.printText(clock, x, y, 3);   // 1 syscall (gambar teks)
 *            await tft.flush();                     // 1 syscall + 1x 150 KB
 *          }
 *
 *      = 3 round-trip, tapi hanya SATU transfer 150 KB per frame (dengan
 *      autoFlush ON, blit + printText masing-masing memicu transfer penuh).
 *      Scene `hud` dan benchmark `fps` di bawah mengukur pola ini apa adanya.
 *
 * (c) 2026 TSIX Project
 */

import { Program, std } from "@tsix/Application";
import {
    tft,
    TftFramebuffer,
    TFT_COLOR,
    TFT_FONT_NAMES,
    TFT_WIDTH,
    TFT_HEIGHT,
    TFT_STRIDE,
    TFT_FB_SIZE,
    rgb,
    TftFont,
} from "@tsix/tftLib";

const W = TFT_WIDTH; // 320
const H = TFT_HEIGHT; // 240

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Palet warna utama (nama + RGB565) untuk bar & legenda. */
const PALETTE: Array<[string, number]> = [
    ["RED", TFT_COLOR.RED],
    ["GREEN", TFT_COLOR.GREEN],
    ["BLUE", TFT_COLOR.BLUE],
    ["CYAN", TFT_COLOR.CYAN],
    ["MAGENTA", TFT_COLOR.MAGENTA],
    ["YELLOW", TFT_COLOR.YELLOW],
    ["WHITE", TFT_COLOR.WHITE],
    ["NAVY", TFT_COLOR.NAVY],
];

/** Bingkai tipis di tepi layar (penanda area gambar). */
async function frame(color = TFT_COLOR.DARK_GRAY) {
    await tft.drawRect(0, 0, W, H, color);
}

/** Header scene: judul kiri-atas + sub-judul + garis pemisah. */
async function header(title: string, sub = "") {
    await tft.setFont(TftFont.DEFAULT);
    await tft.setTextColor(TFT_COLOR.CYAN_NEON);
    await tft.printText(title, 6, 6, 2);
    if (sub) {
        await tft.setTextColor(TFT_COLOR.GRAY);
        await tft.printText(sub, 6, 26, 1);
    }
    await tft.drawLine(6, 36, W - 7, 36, TFT_COLOR.DARK_GRAY);
}

/**
 * Gambar gelombang sinus ke framebuffer LOKAL (nol syscall).
 * Dipakai scene `fb` & `hud` — contoh bahwa rasterisasi animasi sebaiknya
 * terjadi di userland, bukan lewat satu ioctl per titik.
 */
function drawWave(
    fb: TftFramebuffer,
    yBase: number,
    x0: number,
    width: number,
    phase: number,
    amp = 18,
) {
    for (let x = 0; x < width; x++) {
        const y =
            yBase +
            Math.round(
                amp * Math.sin((x + phase * 4) * 0.04) +
                    (amp / 3) * Math.sin((x + phase * 7) * 0.11),
            );
        fb.setPixel(x0 + x, y, TFT_COLOR.CYAN_NEON);
        fb.setPixel(x0 + x, y + 1, rgb(0, 90, 90));
    }
}

// ================================================================
// SCENE
// ================================================================

/** Scene 1 — palet warna & rampa (uji urutan RGB565 + linearitas panel). */
async function sceneColors(pause: number) {
    await std.println("1. Palet & rampa warna...");
    await tft.clear(TFT_COLOR.BLACK);

    // 8 blok palet di baris atas.
    const bw = Math.floor((W - 12) / PALETTE.length);
    for (let i = 0; i < PALETTE.length; i++) {
        await tft.fillRect(6 + i * bw, 44, bw - 1, 44, PALETTE[i][1]);
    }

    // Rampa R/G/B (5 bit untuk R & B, 6 bit untuk G) — gradasi harus mulus.
    for (let x = 0; x < W - 12; x++) {
        const t = Math.round((x / (W - 13)) * 255);
        await tft.drawLine(6 + x, 94, 6 + x, 113, rgb(t, 0, 0));
        await tft.drawLine(6 + x, 115, 6 + x, 134, rgb(0, t, 0));
        await tft.drawLine(6 + x, 136, 6 + x, 155, rgb(0, 0, t));
    }
    await tft.setTextColor(TFT_COLOR.WHITE);
    await tft.printText("R / G / B ramp", 6, 159, 1);

    // Kotak grayscale 16 langkah di baris bawah.
    const gw = Math.floor((W - 12) / 16);
    for (let i = 0; i < 16; i++) {
        await tft.fillRect(6 + i * gw, 174, gw - 1, 20, rgb(Math.round((i / 15) * 255)));
    }
    await tft.printText("grayscale 16 step", 6, 198, 1);

    await header("COLORS", "320x240 RGB565 · palet + ramp");
    await tft.flush();
    await sleep(pause);
}

/** Scene 2 — semua primitive GFX berwarna. */
async function sceneShapes(pause: number) {
    await std.println("2. Bentuk geometri (outline & terisi)...");
    await tft.clear(TFT_COLOR.PANEL_BG);

    await tft.drawRect(8, 46, 60, 40, TFT_COLOR.WHITE);
    await tft.fillRect(74, 46, 60, 40, TFT_COLOR.MAROON);
    await tft.drawCircle(180, 66, 20, TFT_COLOR.CYAN_NEON);
    await tft.fillCircle(240, 66, 20, TFT_COLOR.ORANGE);
    await tft.drawTriangle(20, 150, 60, 100, 100, 150, TFT_COLOR.YELLOW);
    await tft.fillTriangle(120, 150, 160, 100, 200, 150, TFT_COLOR.GREEN_DARK);
    await tft.drawRoundRect(214, 100, 66, 50, 12, TFT_COLOR.MAGENTA);
    await tft.fillRoundRect(234, 162, 60, 34, 10, TFT_COLOR.GRAY);
    await tft.drawLine(8, 200, W - 9, 200, TFT_COLOR.DARK_GRAY);
    await tft.drawLine(8, 204, W - 9, 226, TFT_COLOR.BLUE);
    await tft.drawLine(8, 226, W - 9, 204, TFT_COLOR.RED);

    await header("SHAPES", "rect · circle · triangle · roundRect · line");
    await tft.flush();
    await sleep(pause);
}

/** Scene 3 — 4 font × 3 ukuran, teks transparan & opaque. */
async function sceneFonts(pause: number) {
    await std.println("3. Font 0..3 (transparan & opaque)...");
    const ids = [
        TftFont.DEFAULT,
        TftFont.FREE_SANS_9,
        TftFont.FREE_SANS_BOLD_12,
        TftFont.FREE_MONO_9,
    ];

    for (const id of ids) {
        await tft.clear(TFT_COLOR.BLACK);
        await header(`FONT ${id}`, TFT_FONT_NAMES[id]);

        await tft.setFont(id);
        await tft.setTextColor(TFT_COLOR.WHITE);
        await tft.printText(TFT_FONT_NAMES[id], 6, 60, 1);
        await tft.setTextColor(TFT_COLOR.CYAN_NEON);
        await tft.printText("Aa Bb Cc 0123 :;!?", 6, 84, 1);
        await tft.setTextColor(TFT_COLOR.ORANGE);
        await tft.printText("Aa 0123", 6, 120, 2);
        // Contoh opaque: latar glyph ikut ditulis — wajib untuk angka yang
        // berubah-ubah supaya tidak menumpuk dengan isi frame sebelumnya.
        await tft.setTextColor(TFT_COLOR.BLACK, TFT_COLOR.YELLOW);
        await tft.printText("12:34:56", 6, 170, 2);
        await tft.setTextColor(TFT_COLOR.GREEN);
        await tft.printText("opaque bg di atas ini", 6, 196, 1);
        await tft.setTextColor(TFT_COLOR.WHITE); // kembali transparan

        await tft.flush();
        await std.println(`   → font ${id}: ${TFT_FONT_NAMES[id]}`);
        await sleep(pause);
    }
    await tft.setFont(TftFont.DEFAULT);
}

/** Scene 4 — pola framebuffer: cek orientasi, stride, dan urutan warna. */
async function sceneFramebuffer(pause: number) {
    await std.println("4. Pola framebuffer (orientasi/stride/urutan warna)...");
    const fb = tft.framebuffer();
    fb.clear(TFT_COLOR.BLACK);

    // Papan catur 8x8 di kiri — kalau stride salah, polanya jadi miring.
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < 100; x++) {
            if (((x >> 3) + (y >> 3)) % 2 === 0) fb.setPixel(x, y, rgb(40));
        }
    }
    // Diagonal — penanda orientasi (kiri-atas → kanan-bawah, dan sebaliknya).
    fb.line(100, 0, W - 1, H - 1, TFT_COLOR.CYAN_NEON);
    fb.line(100, H - 1, W - 1, 0, TFT_COLOR.MAGENTA);
    // Rampa horizontal (baris 1) & vertikal (2 kolom paling kanan).
    for (let x = 0; x < W; x++) fb.setPixel(x, 1, rgb(Math.round((x / (W - 1)) * 255)));
    for (let y = 0; y < H; y++) fb.hLine(W - 2, y, 2, rgb(Math.round((y / (H - 1)) * 255)));
    // Penanda sudut: MERAH kiri-atas, HIJAU kiri-bawah, BIRU kanan-atas.
    fb.fillRect(0, 0, 8, 8, TFT_COLOR.RED);
    fb.fillRect(0, H - 8, 8, 8, TFT_COLOR.GREEN);
    fb.fillRect(W - 8, 0, 8, 8, TFT_COLOR.BLUE);

    const t0 = Date.now();
    const ok = await tft.blit(fb); // 1 syscall: frame penuh MENGGANTI layar
    // Saat autoFlush OFF (dipakai suite), present harus diminta eksplisit.
    if (!(await tft.isAutoFlush())) await tft.flush();
    await std.println(`   → blit(${fb.bytes.length} byte) = ${ok} dalam ${Date.now() - t0} ms`);
    await sleep(pause);
}

/** Encode teks ASCII jadi bitmap 1 bpp 5x7 (font mini lokal, untuk uji bitmap). */
function encodeMono(text: string, scale: number): { bytes: Uint8Array; w: number; h: number } {
    const GLYPH: Record<string, number[]> = {
        T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100],
        S: [0b11111, 0b10000, 0b11111, 0b00001, 0b11111],
        I: [0b11111, 0b00100, 0b00100, 0b00100, 0b11111],
        X: [0b10001, 0b01010, 0b00100, 0b01010, 0b10001],
        " ": [0, 0, 0, 0, 0],
    };
    const chars = text.toUpperCase().split("");
    const cw = 5 * scale;
    const w = Math.max(1, chars.length * (cw + scale) - scale);
    const h = 7 * scale;
    const stride = Math.ceil(w / 8);
    const bytes = new Uint8Array(stride * h);
    const put = (px: number, py: number) => {
        if (px < 0 || py < 0 || px >= w || py >= h) return;
        bytes[py * stride + (px >> 3)] |= 0x80 >> (px & 7);
    };
    let cx = 0;
    for (const ch of chars) {
        const g = GLYPH[ch] || GLYPH[" "];
        for (let r = 0; r < 5; r++) {
            for (let c = 0; c < 5; c++) {
                if (!((g[r] >> (4 - c)) & 1)) continue;
                for (let sy = 0; sy < scale; sy++) {
                    for (let sx = 0; sx < scale; sx++) put(cx + c * scale + sx, r * scale + sy);
                }
            }
        }
        cx += cw + scale;
    }
    return { bytes, w, h };
}

/** Scene 5 — drawBitmap: 1 bpp mono + sprite RGB565 mentah. */
async function sceneSprites(pause: number) {
    await std.println("5. Bitmap mono 1 bpp & sprite RGB565...");
    await tft.clear(TFT_COLOR.PANEL_BG);
    await header("BITMAP", "1 bpp transparan · RGB565 mentah");

    // (a) Mono 1 bpp MSB-first — papan catur 16x16 (2 byte per baris).
    const mono = new Uint8Array(16 * 2);
    for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
            if ((x + y) % 2 === 0) mono[y * 2 + (x >> 3)] |= 0x80 >> (x & 7);
        }
    }
    await tft.drawBitmap(10, 46, mono, 16, 16, TFT_COLOR.WHITE);
    await tft.setTextColor(TFT_COLOR.GRAY);
    await tft.printText("mono 1bpp", 10, 66, 1);

    // (b) Sprite RGB565 32x32 mentah (w*h*2 byte) — warna asli, bukan 1 warna.
    const sw = 32;
    const sprite = new Uint8Array(sw * sw * 2);
    for (let y = 0; y < sw; y++) {
        for (let x = 0; x < sw; x++) {
            const o = (y * sw + x) * 2;
            const c = rgb(x * 8, y * 8, 255 - x * 8);
            sprite[o] = c & 0xff;
            sprite[o + 1] = (c >> 8) & 0xff;
        }
    }
    await tft.drawBitmap(46, 46, sprite, sw, sw);
    await tft.printText("RGB565 raw", 46, 82, 1);

    // (c) Logo bitmap → jalur 1 bpp dengan skala (font mini lokal di atas).
    const logo = encodeMono("TSIX", 5);
    await tft.drawBitmap(100, 46, logo.bytes, logo.w, logo.h, TFT_COLOR.CYAN_NEON);
    await tft.printText("bitmap 5x7 x5", 100, 96, 1);

    // (d) Bandingkan: teks driver (glcdfont) di sebelah kanan.
    await tft.setTextColor(TFT_COLOR.WHITE);
    await tft.setFont(TftFont.DEFAULT);
    await tft.printText("TEKS DRIVER", 210, 50, 2);
    await tft.printText("(glcdfont 5x7)", 210, 70, 1);

    await tft.flush();
    await sleep(pause);
}

/** Scene 6 — rotasi 0..3 dengan penanda arah (cek orientasi panel). */
async function sceneRotation(pause: number) {
    await std.println("6. Rotasi 0..3...");
    for (let r = 0; r < 4; r++) {
        await tft.setRotation(r);
        const lw = await tft.getWidth();
        const lh = await tft.getHeight();

        await tft.clear(TFT_COLOR.BLACK);
        await tft.drawRect(0, 0, lw, lh, TFT_COLOR.DARK_GRAY);
        // Panah penanda "atas" layar — harus SELALU menunjuk ke atas fisik.
        await tft.fillTriangle(
            Math.floor(lw / 2),
            8,
            Math.floor(lw / 2) - 14,
            34,
            Math.floor(lw / 2) + 14,
            34,
            TFT_COLOR.RED,
        );
        await tft.fillRect(0, 0, 12, 12, TFT_COLOR.GREEN); // sudut kiri-atas logika
        await tft.fillRect(lw - 12, lh - 12, 12, 12, TFT_COLOR.BLUE); // kanan-bawah logika
        await tft.setFont(TftFont.DEFAULT);
        await tft.setTextColor(TFT_COLOR.WHITE);
        await tft.printText(`ROT ${r}`, 6, Math.floor(lh / 2) - 8, 2);
        await tft.setTextColor(TFT_COLOR.GRAY);
        await tft.printText(`${lw}x${lh}`, 6, Math.floor(lh / 2) + 12, 1);
        await tft.printText("atas = panah merah", 6, lh - 14, 1);
        await tft.flush();
        await std.println(`   → rotasi ${r}: ${lw}x${lh}`);
        await sleep(pause);
    }
    await tft.setRotation(0);
    await std.println("   ↩ kembali ke rotasi 0 (320x240).");
}

/**
 * Scene 7 — dashboard animasi (pola HUD hemat transfer).
 *
 * Resep: autoFlush OFF → `blit()` (grafis lokal) + `printText()` (teks) +
 * `flush()` = 3 round-trip, tapi hanya SATU transfer 150 KB ke /dev/fbN.
 *
 * @param seconds 0 = jalan terus sampai Ctrl+C; selain itu durasi detik.
 */
async function sceneHud(seconds: number) {
    await std.println("7. Dashboard animasi (raster lokal + 1x transfer/frame)...");
    await tft.setAutoFlush(false);
    const fb = tft.framebuffer();
    const cardBg = rgb(16, 18, 28);

    let tick = 0;
    let frames = 0;
    const t0 = Date.now();
    const limit = seconds > 0 ? seconds * 1000 : Infinity;

    while (Date.now() - t0 < limit) {
        const now = new Date();
        const clock =
            `${String(now.getHours()).padStart(2, "0")}:` +
            `${String(now.getMinutes()).padStart(2, "0")}:` +
            `${String(now.getSeconds()).padStart(2, "0")}`;
        const date =
            `${String(now.getDate()).padStart(2, "0")}/` +
            `${String(now.getMonth() + 1).padStart(2, "0")}/${now.getFullYear()}`;

        // ── Grafis lokal (nol syscall) ──
        fb.clear(cardBg);

        // Kartu jam + strip aksen.
        fb.rect(8, 44, 180, 76, TFT_COLOR.DARK_GRAY);
        fb.fillRect(8, 44, 4, 76, TFT_COLOR.CYAN_NEON);

        // Gelombang sinus berjalan.
        drawWave(fb, 150, 12, 296, tick);

        // Gauge melingkar: busur terisi proporsional (0..2π).
        const gx = 240;
        const gy = 78;
        fb.circle(gx, gy, 32, TFT_COLOR.DARK_GRAY);
        const pct = (Math.sin(tick * 0.05) + 1) / 2;
        for (let i = 0; i < 60; i++) {
            const a = (i / 60) * Math.PI * 2 - Math.PI / 2;
            const on = i / 60 <= pct;
            const r = on ? 30 : 28;
            fb.setPixel(
                gx + Math.round(Math.cos(a) * r),
                gy + Math.round(Math.sin(a) * r),
                on ? TFT_COLOR.ORANGE : rgb(50),
            );
        }

        // Histogram di kanan bawah.
        for (let i = 0; i < 12; i++) {
            const h = 6 + Math.round(26 * ((Math.sin(tick * 0.08 + i * 0.6) + 1) / 2));
            fb.fillRect(182 + i * 11, 226 - h, 8, h, i % 2 ? TFT_COLOR.GREEN_DARK : TFT_COLOR.GREEN);
        }

        // Bola memantul.
        const bx = 30 + Math.round(130 * (0.5 + 0.5 * Math.sin(tick * 0.06)));
        const by = 205 - Math.abs(Math.round(55 * Math.sin(tick * 0.09)));
        fb.fillCircle(bx, by, 7, TFT_COLOR.YELLOW);
        fb.fillCircle(bx, by, 3, TFT_COLOR.WHITE);

        // ── Kirim frame: 1 syscall ──
        await tft.blit(fb);

        // ── Teks (font ada di kernel) — wajib dicetak ulang tiap frame karena
        //    blit mengganti seluruh layar. Opaque bg supaya tidak menumpuk. ──
        await tft.setFont(TftFont.DEFAULT);
        await tft.setTextColor(TFT_COLOR.CYAN_NEON, cardBg);
        await tft.printText(clock, 24, 54, 3);
        await tft.setTextColor(TFT_COLOR.WHITE, cardBg);
        await tft.printText("TSIX /dev/tft", 24, 86, 1);
        await tft.setTextColor(TFT_COLOR.GRAY, cardBg);
        await tft.printText(`${date} f${String(frames).padStart(6, "0")}`, 24, 100, 1);

        // ── Present: 1 syscall + 1 transfer 150 KB ──
        await tft.flush();

        frames++;
        tick++;
        await sleep(16); // pacing aplikasi (~60 fps maksimum)
    }

    await tft.setAutoFlush(true);
    await tft.setTextColor(TFT_COLOR.WHITE); // kembali transparan
    const elapsed = (Date.now() - t0) / 1000;
    await std.println(
        `   → ${frames} frame dalam ${elapsed.toFixed(1)}s = ${(frames / elapsed).toFixed(1)} fps`,
    );
}

// ================================================================
// PERINTAH KONTROL
// ================================================================

/** Suite lengkap. */
async function runSuite(pause: number) {
    // Auto-flush OFF: tiap scene menggambar banyak objek lalu flush sekali.
    await tft.setAutoFlush(false);
    await std.println("autoFlush OFF — flush manual tiap akhir scene.");
    await std.println("");

    await sceneColors(pause);
    await sceneShapes(pause);
    await sceneFonts(pause);
    await sceneFramebuffer(pause);
    await sceneSprites(pause);
    await sceneRotation(pause);
    await sceneHud(pause < 800 ? 3 : 6);

    await tft.clear(TFT_COLOR.BLACK);
    await frame(TFT_COLOR.CYAN_NEON);
    await tft.setFont(TftFont.FREE_SANS_BOLD_12);
    await tft.setTextColor(TFT_COLOR.CYAN_NEON);
    await tft.printCentered("SUKSES", 96, 3);
    await tft.setFont(TftFont.DEFAULT);
    await tft.setTextColor(TFT_COLOR.WHITE);
    await tft.printCentered("suite /dev/tft selesai", 140, 1);
    await tft.flush();
    await std.println("");
    await std.println("✅ Suite selesai.");
}

async function cmdInfo() {
    const info = await tft.getInfo();
    await std.println("");
    await std.println("ℹ Status /dev/tft:");
    for (const [k, v] of Object.entries(info || {})) {
        await std.println(
            `   ${k.padEnd(16)}: ${typeof v === "object" && v !== null ? JSON.stringify(v) : v}`,
        );
    }
    await std.println(`   devicePath      : ${tft.devicePath}`);
    await std.println(`   node fb host    : ${await tft.getFbDevice()}`);
    await std.println(`   stride / frame  : ${TFT_STRIDE} B / ${TFT_FB_SIZE} B`);
    await std.println(`   kecerahan       : ${await tft.getBrightness()} (null = tanpa sysfs)`);
}

async function cmdText(msg: string) {
    await tft.clear(TFT_COLOR.PANEL_BG);
    await frame();
    await tft.setFont(TftFont.FREE_SANS_9);
    await tft.setTextColor(TFT_COLOR.CYAN_NEON);
    await tft.printText("test-ILI9341", 10, 58, 1);
    await tft.setFont(TftFont.DEFAULT);
    await tft.setTextColor(TFT_COLOR.WHITE);
    // Bungkus manual (25 karakter @ size 2 = 300 px) — demo tidak bergantung wrap.
    const MAX = 25;
    for (let i = 0; i < 5 && i * MAX < msg.length; i++) {
        await tft.printText(msg.slice(i * MAX, (i + 1) * MAX), 10, 84 + i * 18, 2);
    }
    await tft.setTextColor(TFT_COLOR.GRAY);
    await tft.printText("lihat juga: colors | fonts | sprites | hud", 10, 208, 1);
    await tft.flush();
    await std.println(`✔ Teks dikirim: "${msg}"`);
}

async function cmdPixel(x?: string, y?: string) {
    if (x === undefined || y === undefined) {
        await std.println("Pemakaian: test-ILI9341 pixel <x> <y>");
        return;
    }
    const c = await tft.getPixel(parseInt(x, 10), parseInt(y, 10));
    if (c === null) {
        await std.println(`Piksel (${x}, ${y}) di luar layar.`);
        return;
    }
    await std.println(`✔ Piksel (${x}, ${y}) = 0x${c.toString(16).padStart(4, "0")} (RGB565)`);
}

async function cmdFps(seconds: number) {
    const dur = Math.max(1, seconds) * 1000;
    const perSec = (n: number) => (n / (seconds || 1)).toFixed(1);
    await std.println(`Benchmark FPS ${seconds}s / fase (8 fase)...`);

    // 1) IPC-only: ioctl murah TANPA menggambar (GET_WIDTH) — plafon FPS.
    let n = 0;
    let t = Date.now();
    while (Date.now() - t < dur) {
        await tft.getWidth();
        n++;
    }
    const ipc = perSec(n);

    // 2) Raster LOKAL murni (0 syscall): clear + gelombang + lingkaran.
    const fb = tft.framebuffer();
    const localRender = () => {
        fb.clear(rgb(10, 10, 18));
        drawWave(fb, 120, 0, W, n);
        fb.fillCircle(160, 120, 40, TFT_COLOR.ORANGE);
    };
    n = 0;
    t = Date.now();
    while (Date.now() - t < dur) {
        localRender();
        n++;
    }
    const raster = perSec(n);

    // 3) Ioctl render-only: 2 ioctl gambar per iterasi, tanpa flush.
    await tft.setAutoFlush(false);
    n = 0;
    t = Date.now();
    while (Date.now() - t < dur) {
        await tft.fillRect((n % 20) * 15, 60, 12, 10, TFT_COLOR.GREEN);
        await tft.drawRect(0, 0, W, H, TFT_COLOR.WHITE);
        n++;
    }
    const ioctlRender = perSec(n);

    // 4) Flush-only: 1 syscall + 1 transfer 150 KB ke /dev/fbN.
    n = 0;
    t = Date.now();
    while (Date.now() - t < dur) {
        await tft.flush();
        n++;
    }
    const flush = perSec(n);

    // 5) Frame "naif": clear + fillCircle + flush (3 syscall, 1 transfer).
    n = 0;
    t = Date.now();
    while (Date.now() - t < dur) {
        await tft.clear(TFT_COLOR.BLACK);
        await tft.fillCircle(160, 120, 10 + (n % 20), TFT_COLOR.RED);
        await tft.flush();
        n++;
    }
    const naive = perSec(n);

    // 6) Frame 1-sys (autoFlush ON): raster lokal + blit → 1 syscall, 1 transfer.
    await tft.setAutoFlush(true);
    n = 0;
    t = Date.now();
    while (Date.now() - t < dur) {
        fb.clear(TFT_COLOR.BLACK);
        fb.fillCircle(160, 120, 10 + (n % 20), TFT_COLOR.RED);
        await tft.blit(fb);
        n++;
    }
    const oneSys = perSec(n);

    // 7) Frame 1-sys + teks (autoFlush ON): blit + printText = 2 transfer.
    n = 0;
    t = Date.now();
    while (Date.now() - t < dur) {
        fb.clear(TFT_COLOR.BLACK);
        fb.fillCircle(160, 120, 10 + (n % 20), TFT_COLOR.RED);
        await tft.blit(fb);
        await tft.printText(String(n % 1000), 4, 4, 1);
        n++;
    }
    const textPush2 = perSec(n);

    // 8) Frame + teks HEMAT (autoFlush OFF): blit + printText + flush sekali
    //    → 3 round-trip tapi hanya 1 transfer. Inilah pola scene `hud`.
    await tft.setAutoFlush(false);
    n = 0;
    t = Date.now();
    while (Date.now() - t < dur) {
        fb.clear(TFT_COLOR.BLACK);
        fb.fillCircle(160, 120, 10 + (n % 20), TFT_COLOR.RED);
        await tft.blit(fb);
        await tft.printText(String(n % 1000), 4, 4, 1);
        await tft.flush();
        n++;
    }
    const textPush1 = perSec(n);
    await tft.setAutoFlush(true);

    await std.println("");
    await std.println(`   ipc-only      : ${ipc} ioctl/s   (1 round-trip murni)`);
    await std.println(`   raster lokal  : ${raster} frame/s (0 syscall, CPU saja)`);
    await std.println(`   ioctl-render  : ${ioctlRender} iter/s  (2 ioctl gambar, tanpa flush)`);
    await std.println(`   flush-only    : ${flush} fps      (1 syscall + 150 KB)`);
    await std.println(`   full frame    : ${naive} fps      (3 syscall, 1 transfer)`);
    await std.println(`   frame 1-sys   : ${oneSys} fps      (raster lokal + blit)`);
    await std.println(`   frame + teks  : ${textPush2} fps      (blit + printText, 2 transfer)`);
    await std.println(`   teks hemat    : ${textPush1} fps      (blit + printText + flush, 1 transfer)`);
    await std.println("");
    await std.println("   Bacaan: kalau frame 1-sys ≫ full frame ⇒ gambar LOKAL lalu blit");
    await std.println("   sekali memang jalannya. Kalau frame 1-sys ≈ flush-only ⇒ lehernya di");
    await std.println("   transfer 150 KB ke fbdev, bukan IPC. Bandingkan 'frame + teks' vs");
    await std.println("   'teks hemat': menambah teks TANPA transfer kedua hampir gratis.");
}

async function cmdFbDev(path?: string) {
    if (path === undefined) {
        const cur = await tft.getFbDevice();
        await std.println(`ℹ Node framebuffer host: ${cur ?? "(belum terbuka)"}`);
        await std.println("   Ganti: test-ILI9341 fbdev /dev/fb2");
        await std.println("   Auto-deteksi memilih /dev/fb1..fb9 (fb0 = HDMI, sengaja dilewati).");
        return;
    }
    const used = await tft.setFbDevice(path);
    if (used === null) {
        await std.error(`❌ Gagal pindah ke ${path} (node tidak ada / geometri tidak cocok).`);
        const info = await tft.getInfo();
        if (info?.lastError) await std.error(`   ${info.lastError}`);
        return;
    }
    await std.println(`✔ Node framebuffer host → ${used}`);
}

// ================================================================
// MAIN
// ================================================================

export const main = Program(async (args: string[]) => {
    const positional = args.filter((a) => !a.startsWith("--"));
    const cmd = (positional[0] || "suite").toLowerCase();
    const fast = args.includes("--fast");
    const pause = fast ? 700 : 2000;

    await std.println("");
    await std.println("╔══════════════════════════════════════════════╗");
    await std.println("║ 🖥️  test-ILI9341 — TFT 320x240 via /dev/tft  ║");
    await std.println("╚══════════════════════════════════════════════╝");
    // Device default = /dev/tft (hardware lewat fbdev host, mis. /dev/fb1).
    // Semua akses lewat tftLib (FD + ioctl diurus di dalam).
    try {
        if (!(await tft.isAvailable())) {
            await std.error(`❌ ${tft.devicePath} belum siap (available=false).`);
            await std.error("   Cek: driver fb_ili9341/fbtft aktif? Node /dev/fb1 ada?");
            await std.error("   Lihat /var/log/syslog (driver mencatat alasannya).");
            await std.error("   Node lain? set TSIX_TFT_FB=/dev/fbX lalu boot ulang TSIX.");
            return;
        }

        const info = await tft.getInfo();
        await std.println(
            `✔ ${tft.devicePath} siap — ${info?.width}x${info?.height} RGB565, ` +
                `node host ${info?.fbDevice ?? "?"}` +
                (info?.fbName ? ` (${info.fbName})` : "") +
                `, rotasi ${info?.rotation}, autoFlush ${info?.autoFlush}`,
        );
        await std.println("");

        switch (cmd) {
            case "suite":
                await runSuite(pause);
                break;

            case "info":
                await cmdInfo();
                break;

            case "clear":
                await tft.clear(TFT_COLOR.BLACK);
                await tft.flush();
                await std.println("✔ Layar dibersihkan.");
                break;

            case "text":
                await cmdText(positional.slice(1).join(" ") || "Halo TSIX dari /dev/tft");
                break;

            case "colors":
                await tft.setAutoFlush(false);
                await sceneColors(pause);
                await tft.setAutoFlush(true);
                break;

            case "shapes":
                await tft.setAutoFlush(false);
                await sceneShapes(pause);
                await tft.setAutoFlush(true);
                break;

            case "fonts":
                await tft.setAutoFlush(false);
                await sceneFonts(pause);
                await tft.setAutoFlush(true);
                break;

            case "fb":
                await sceneFramebuffer(pause);
                break;

            case "sprites":
                await tft.setAutoFlush(false);
                await sceneSprites(pause);
                await tft.setAutoFlush(true);
                break;

            case "rotation": {
                const r = positional[1];
                if (r === undefined) {
                    await sceneRotation(pause);
                } else {
                    const used = await tft.setRotation(parseInt(r, 10));
                    await std.println(
                        `✔ Rotasi → ${used} (${await tft.getWidth()}x${await tft.getHeight()}).`,
                    );
                }
                break;
            }

            case "hud": {
                const secs = positional[1] === undefined ? 10 : parseInt(positional[1], 10);
                await sceneHud(Number.isFinite(secs) ? secs : 10);
                break;
            }

            case "fps":
                await cmdFps(parseInt(positional[1], 10) || 3);
                break;

            case "fbdev":
                await cmdFbDev(positional[1]);
                break;

            case "pixel":
                await cmdPixel(positional[1], positional[2]);
                break;

            case "brightness": {
                if (positional[1] === undefined) {
                    await std.println(`ℹ Kecerahan: ${await tft.getBrightness()}`);
                    await std.println("   Set: test-ILI9341 brightness 0..255");
                    break;
                }
                const used = await tft.setBrightness(parseInt(positional[1], 10));
                await std.println(`✔ Kecerahan → ${used} (no-op bila driver tanpa backlightPath).`);
                break;
            }

            case "backlight": {
                const on = (positional[1] || "on").toLowerCase() !== "off";
                await tft.setBacklight(on);
                await std.println(`✔ Backlight ${on ? "ON" : "OFF"}.`);
                break;
            }

            case "invert": {
                const on = (positional[1] || "on").toLowerCase() !== "off";
                await tft.setInvert(on);
                await std.println(`✔ Inversi ${on ? "ON" : "OFF"} (diemulasi driver).`);
                break;
            }

            case "display": {
                const on = (positional[1] || "on").toLowerCase() !== "off";
                await tft.setDisplayOn(on);
                await std.println(`✔ Display ${on ? "ON" : "OFF"}.`);
                break;
            }

            default:
                await std.println(`❓ Perintah tidak dikenal: ${cmd}`);
                await std.println("   suite | info | clear | text | colors | shapes | fonts");
                await std.println("   fb | sprites | rotation | hud | fps | fbdev | pixel");
                await std.println("   brightness | backlight | invert | display");
                break;
        }
    } catch (e: any) {
        await std.error(`❌ Error: ${e.message}`);
    } finally {
        await tft.close();
    }

    await std.println("");
});
