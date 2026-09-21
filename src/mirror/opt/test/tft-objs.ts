/**
 * tft-objs.ts — 💥 Stress animasi TFT 320x240 (/dev/tft) — RAMAI & AGRESIF
 *
 * Pasangan "versi warna" dari `lcd-objs` (LM6029 128x64): banyak objek bergerak,
 * plasma latar, starfield 3D, kubus wireframe, spektrum, dan marquee — semuanya
 * diraster **LOKAL** di `TftFramebuffer` (nol syscall), lalu dikirim dengan
 * **SATU `blit()` per frame** (= 1 round-trip IPC + 1 transfer 150 KB,
 * auto-flush ON).
 *
 * ── PEMAKAIAN ──
 *   tft-objs                     → jalan terus (Ctrl+C untuk berhenti)
 *   tft-objs 30                  → jalan 30 detik
 *   tft-objs 20 --insane         → preset terberat
 *   tft-objs 20 --lite           → preset paling ringan (buat Pi lambat)
 *   tft-objs 10 --stats          → pakai + laporan ms per tahap tiap 2 detik
 *   tft-objs bench 5             → ukur fps & biaya raster/blit (tanpa batas fps)
 *   tft-objs -h                  → bantuan lengkap
 *
 * ── OPSI ──
 *   --sq N        kotak berputar memantul        (preset: 6)
 *   --tri N       segitiga berputar memantul     (preset: 5)
 *   --cir N       lingkaran berdenyut            (preset: 8)
 *   --stars N     bintang starfield 3D           (preset: 120)
 *   --bars N      bar spektrum di bawah          (preset: 24)
 *   --plasma R    plasma latar pada 1/R resolusi (preset: 2; 0 = mati)
 *   --trail N     jejak gerak (fade 1..3); >0 → plasma jadi grid titik
 *   --cube on|off kubus wireframe 3D             (preset: on)
 *   --hud on|off  overlay FPS/kursor             (preset: on)
 *   --fps N       batasi laju frame; 0 = bebas   (preset: 0)
 *   --stats       laporan biaya per tahap tiap 2 detik
 *   --lite | --insane                      preset lebih ringan / lebih brutal
 *
 * ── CATATAN PERFORMA (baca kalau di Pi terasa berat) ──
 * Biaya frame = plasma (paling mahal: 1/R² piksel dihitung) + shape + 1 blit.
 * Preset `--lite` menaikkan R plasma dan mengurangi objek — itu dua tombol
 * pertama yang perlu dinaikkan kalau fps kurang. Pakai `--stats` supaya
 * kelihatan tahap mana yang makan waktu.
 *
 * HUD di sini digambar dengan **font 3x5 lokal** (bukan `printText()`), supaya
 * satu frame tetap 1 syscall — semua tulisan hidup di userland.
 *
 * (c) 2026 TSIX Project
 */

import { Program, std } from "@tsix/Application";
import { tft, TftFramebuffer, TFT_COLOR, TFT_WIDTH, TFT_HEIGHT, rgb } from "@tsix/tftLib";

const W = TFT_WIDTH; // 320
const H = TFT_HEIGHT; // 240

/** Band HUD di atas, bar spektrum + marquee di bawah. */
const HUD_H = 10;
const BAR_H = 30;
const PLAY_TOP = HUD_H + 1;
const PLAY_BOT = H - BAR_H; // batas bawah area objek

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const nowMs = () => Date.now();

// ================================================================
// FONT 3x5 LOKAL (digambar ke framebuffer, tanpa syscall)
// ================================================================

/** Bit per baris (bit 2..0 = kolom kiri..kanan), 5 baris per glyph. */
const FONT_SRC: Record<string, string> = {
    "0": "111/101/101/101/111", "1": "010/110/010/010/111", "2": "111/001/111/100/111",
    "3": "111/001/111/001/111", "4": "101/101/111/001/001", "5": "111/100/111/001/111",
    "6": "111/100/111/101/111", "7": "111/001/001/010/010", "8": "111/101/111/101/111",
    "9": "111/101/111/001/111",
    A: "111/101/111/101/101", B: "110/101/110/101/110", C: "111/100/100/100/111",
    D: "110/101/101/101/110", E: "111/100/111/100/111", F: "111/100/111/100/100",
    G: "111/100/101/101/111", H: "101/101/111/101/101", I: "111/010/010/010/111",
    J: "001/001/001/101/111", K: "101/101/110/101/101", L: "100/100/100/100/111",
    M: "101/111/111/101/101", N: "110/101/101/101/101", O: "111/101/101/101/111",
    P: "111/101/111/100/100", Q: "111/101/101/111/001", R: "111/101/111/110/101",
    S: "111/100/111/001/111", T: "111/010/010/010/010", U: "101/101/101/101/111",
    V: "101/101/101/101/010", W: "101/101/111/111/101", X: "101/101/010/101/101",
    Y: "101/101/010/010/010", Z: "111/001/010/100/111",
    " ": "000/000/000/000/000", ":": "000/010/000/010/000", ".": "000/000/000/000/010",
    "/": "001/001/010/100/100", "-": "000/000/111/000/000", "%": "101/001/010/100/101",
};

/** Peta glyph → 5 baris (bit 2 = kolom kiri). */
const FONT: Record<string, number[]> = (() => {
    const map: Record<string, number[]> = {};
    for (const ch of Object.keys(FONT_SRC)) {
        map[ch] = FONT_SRC[ch].split("/").map((row) => {
            let bits = 0;
            for (let i = 0; i < 3; i++) if (row[i] === "1") bits |= 4 >> i;
            return bits;
        });
    }
    return map;
})();

/** Lebar teks 3x5 dalam piksel (advance 4 px/char × skala). */
function textWidth(text: string, scale = 1): number {
    return Math.max(0, text.length * 4 * scale - scale);
}

/** Gambar teks 3x5 lokal ke framebuffer (tanpa syscall). */
function drawText(
    fb: TftFramebuffer,
    x: number,
    y: number,
    text: string,
    color: number,
    scale = 1,
): void {
    const str = String(text).toUpperCase();
    let cx = x;
    for (const ch of str) {
        const g = FONT[ch] || FONT[" "];
        for (let r = 0; r < 5; r++) {
            const bits = g[r];
            if (!bits) continue;
            for (let c = 0; c < 3; c++) {
                if (!((bits >> (2 - c)) & 1)) continue;
                if (scale === 1) fb.setPixel(cx + c, y + r, color);
                else fb.fillRect(cx + c * scale, y + r * scale, scale, scale, color);
            }
        }
        cx += 4 * scale;
    }
}

// ================================================================
// LUT: SIN/COS + PALET (hindari Math.sin di dalam loop piksel)
// ================================================================

const LUT_N = 1024;
const SIN = new Int16Array(LUT_N);
const COS = new Int16Array(LUT_N);
for (let i = 0; i < LUT_N; i++) {
    SIN[i] = Math.round(Math.sin((i / LUT_N) * Math.PI * 2) * 256);
    COS[i] = Math.round(Math.cos((i / LUT_N) * Math.PI * 2) * 256);
}

/** Ambil nilai SIN dari indeks apa pun (mask 1024) — pengganti Math.sin cepat. */
const sinI = (i: number) => SIN[i & (LUT_N - 1)];
const cosI = (i: number) => COS[i & (LUT_N - 1)];

/** Interpolasi palet RGB565 (unpack → lerp → pack) jadi N langkah. */
function buildPalette(colors: number[], steps = 256): Uint16Array {
    const out = new Uint16Array(steps);
    const n = colors.length;
    const unpack = (c: number) => [((c >> 11) & 31) << 3, ((c >> 5) & 63) << 2, (c & 31) << 3];
    for (let i = 0; i < steps; i++) {
        const t = (i / steps) * n;
        const a = Math.floor(t) % n;
        const b = (a + 1) % n;
        const f = t - Math.floor(t);
        const ca = unpack(colors[a]);
        const cb = unpack(colors[b]);
        out[i] = rgb(
            ca[0] + (cb[0] - ca[0]) * f,
            ca[1] + (cb[1] - ca[1]) * f,
            ca[2] + (cb[2] - ca[2]) * f,
        );
    }
    return out;
}

/** Palet plasma & palet bintang (dibuat sekali saat start). */
const PLASMA_PAL = buildPalette([
    TFT_COLOR.PANEL_BG,
    rgb(0, 40, 90),
    rgb(0, 160, 190),
    rgb(120, 0, 140),
    rgb(200, 40, 90),
    rgb(255, 170, 40),
    TFT_COLOR.PANEL_BG,
]);

const STAR_RAMP = (() => {
    const ramp = new Uint16Array(8);
    for (let i = 0; i < 8; i++) {
        const f = i / 7;
        ramp[i] = rgb(60 + 195 * f, 90 + 165 * f, 140 + 115 * f);
    }
    return ramp;
})();

// ================================================================
// EFEK
// ================================================================

/**
 * Plasma latar berbasis LUT.
 *
 * @param step   1 = penuh (paling mahal), 2..4 = blok `step`x`step` (lebih murah)
 * @param sparse true = hanya 1 piksel per blok (dipakai saat `--trail` hidup,
 *               supaya jejak objek masih terlihat di sela-sela grid)
 */
function plasma(fb: TftFramebuffer, t: number, step: number, sparse: boolean): void {
    const words = fb.words;
    const t2 = t * 2;
    const t3 = t * 3;
    const tt = (t * 1.3) | 0;
    for (let y = 0; y < H; y += step) {
        const y1 = y * 7 - tt;
        const yq = (y * y) >> 4;
        for (let x = 0; x < W; x += step) {
            const v =
                sinI(x * 6 + t) +
                sinI(y1) +
                sinI(x * 3 + y * 4 + t2) +
                sinI(((x * x) >> 4) + yq + t3);
            const c = PLASMA_PAL[((v + 1024) >> 3) & 0xff];
            if (sparse) {
                words[y * W + x] = c;
                continue;
            }
            const ye = Math.min(y + step, H);
            const xe = Math.min(x + step, W);
            for (let yy = y; yy < ye; yy++) {
                const row = yy * W;
                for (let xx = x; xx < xe; xx++) words[row + xx] = c;
            }
        }
    }
}

/** Fade seluruh frame (jejak gerak): RGB565 dibagi dua per kanal. */
function fade(fb: TftFramebuffer, times: number): void {
    const words = fb.words;
    for (let pass = 0; pass < times; pass++) {
        for (let i = 0; i < words.length; i++) {
            const c = words[i];
            if (c === 0) continue;
            words[i] = ((((c >> 11) & 31) >> 1) << 11) | ((((c >> 5) & 63) >> 1) << 5) | ((c & 31) >> 1);
        }
    }
}

/** Bintang starfield 3D (proyeksi sederhana + ekor pendek). */
interface Star {
    x: number;
    y: number;
    z: number;
}

function initStars(n: number): Star[] {
    const out: Star[] = [];
    for (let i = 0; i < n; i++) {
        out.push({ x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: 0.1 + Math.random() * 0.9 });
    }
    return out;
}

function drawStars(fb: TftFramebuffer, stars: Star[], speed: number, cx: number, cy: number): void {
    const focal = 170;
    for (const s of stars) {
        s.z -= speed;
        if (s.z <= 0.03) {
            s.x = Math.random() * 2 - 1;
            s.y = Math.random() * 2 - 1;
            s.z = 1;
        }
        const inv = 1 / s.z;
        const px = (cx + s.x * focal * inv) | 0;
        const py = (cy + s.y * focal * inv) | 0;
        if (px < 0 || px >= W || py < 0 || py >= H) continue;
        const bright = Math.max(0, Math.min(7, ((1 - s.z) * 7.99) | 0));
        fb.setPixel(px, py, STAR_RAMP[bright]);
        // Ekor: 1 piksel lebih jauh dari pusat, lebih redup.
        const tx = (px + (px - cx) * 0.06) | 0;
        const ty = (py + (py - cy) * 0.06) | 0;
        if (tx >= 0 && tx < W && ty >= 0 && ty < H) {
            fb.setPixel(tx, ty, STAR_RAMP[Math.max(0, bright - 3)]);
        }
    }
}

/** Isi poligon (scanline, even-odd) — untuk kotak/segitiga yang BERPUTAR. */
function fillPoly(fb: TftFramebuffer, pts: number[][], color: number): void {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
        if (p[1] < minY) minY = p[1];
        if (p[1] > maxY) maxY = p[1];
    }
    minY = Math.max(0, Math.floor(minY));
    maxY = Math.min(H - 1, Math.ceil(maxY));
    const xs: number[] = [];
    for (let y = minY; y <= maxY; y++) {
        xs.length = 0;
        for (let i = 0; i < pts.length; i++) {
            const a = pts[i];
            const b = pts[(i + 1) % pts.length];
            if (a[1] === b[1]) continue;
            if (y + 0.5 < Math.min(a[1], b[1]) || y + 0.5 >= Math.max(a[1], b[1])) continue;
            xs.push(a[0] + ((b[0] - a[0]) * (y + 0.5 - a[1])) / (b[1] - a[1]));
        }
        if (!xs.length) continue;
        xs.sort((p, q) => p - q);
        for (let i = 0; i + 1 < xs.length; i += 2) {
            const x0 = Math.max(0, Math.ceil(xs[i]));
            const x1 = Math.min(W - 1, Math.floor(xs[i + 1]));
            if (x1 >= x0) fb.hLine(x0, y, x1 - x0 + 1, color);
        }
    }
}

/** Objek memantul: kotak & segitiga (berputar), lingkaran (berdenyut). */
interface Mover {
    x: number;
    y: number;
    vx: number;
    vy: number;
    size: number;
    rot: number;
    vrot: number;
    color: number;
    kind: "sq" | "tri" | "cir";
    phase: number;
}

function makeMovers(cfg: { sq: number; tri: number; cir: number }): Mover[] {
    const list: Mover[] = [];
    const palette = [
        TFT_COLOR.CYAN_NEON, TFT_COLOR.ORANGE, TFT_COLOR.YELLOW, TFT_COLOR.MAGENTA,
        TFT_COLOR.GREEN, TFT_COLOR.RED, TFT_COLOR.WHITE, TFT_COLOR.BLUE,
    ];
    const add = (kind: Mover["kind"], n: number, sizeMin: number, sizeMax: number, spd: number) => {
        for (let i = 0; i < n; i++) {
            const size = sizeMin + Math.random() * (sizeMax - sizeMin);
            list.push({
                x: size + Math.random() * (W - size * 2),
                y: PLAY_TOP + size + Math.random() * Math.max(1, PLAY_BOT - PLAY_TOP - size * 2),
                vx: (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random()) * spd,
                vy: (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random()) * spd,
                size,
                rot: Math.random() * LUT_N,
                vrot: (Math.random() - 0.5) * 0.3,
                color: palette[(Math.random() * palette.length) | 0],
                kind,
                phase: Math.random() * LUT_N,
            });
        }
    };
    add("sq", cfg.sq, 10, 26, 1.4);
    add("tri", cfg.tri, 12, 30, 1.8);
    add("cir", cfg.cir, 5, 14, 2.2);
    return list;
}

/** Langkah + pantulan di dalam area main. */
function stepMover(o: Mover): void {
    o.x += o.vx;
    o.y += o.vy;
    o.rot += o.vrot;
    if (o.x <= o.size) {
        o.x = o.size;
        o.vx = Math.abs(o.vx);
    } else if (o.x >= W - o.size) {
        o.x = W - o.size;
        o.vx = -Math.abs(o.vx);
    }
    if (o.y <= PLAY_TOP + o.size) {
        o.y = PLAY_TOP + o.size;
        o.vy = Math.abs(o.vy);
    } else if (o.y >= PLAY_BOT - o.size) {
        o.y = PLAY_BOT - o.size;
        o.vy = -Math.abs(o.vy);
    }
}

function drawMover(fb: TftFramebuffer, o: Mover, ring = true): void {
    const x = o.x | 0;
    const y = o.y | 0;
    if (o.kind === "cir") {
        const r = o.size * (0.75 + 0.25 * (sinI(o.phase) / 256));
        fb.fillCircle(x, y, r | 0, o.color);
        if (ring) fb.circle(x, y, ((r | 0) + 4), rgb(255, 255, 255));
        o.phase += 37;
        return;
    }
    const ca = COS[(o.rot | 0) & (LUT_N - 1)] / 256;
    const sa = SIN[(o.rot | 0) & (LUT_N - 1)] / 256;
    const pts: number[][] = [];
    const corners = o.kind === "sq" ? [[-1, -1], [1, -1], [1, 1], [-1, 1]] : [[0, -1], [1, 1], [-1, 1]];
    for (const [ux, uy] of corners) {
        const sx = ux * o.size;
        const sy = uy * o.size;
        pts.push([x + sx * ca - sy * sa, y + sx * sa + sy * ca]);
    }
    fillPoly(fb, pts, o.color);
    if (ring) {
        for (let i = 0; i < pts.length; i++) {
            const a = pts[i];
            const b = pts[(i + 1) % pts.length];
            fb.line(a[0] | 0, a[1] | 0, b[0] | 0, b[1] | 0, TFT_COLOR.WHITE);
        }
    }
}

/** Kubus wireframe 3D berputar pada dua sumbu. */
const CUBE_V: number[][] = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
];
const CUBE_E: number[][] = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
];

function drawCube(fb: TftFramebuffer, t: number, cx: number, cy: number, scale: number): void {
    const ax = (t * 7) | 0;
    const ay = (t * 11) | 0;
    const ca1 = COS[ax & (LUT_N - 1)] / 256;
    const sa1 = SIN[ax & (LUT_N - 1)] / 256;
    const ca2 = COS[ay & (LUT_N - 1)] / 256;
    const sa2 = SIN[ay & (LUT_N - 1)] / 256;
    const proj: number[][] = [];
    for (const v of CUBE_V) {
        // Rotasi X lalu Y, proyeksi perspektif ringan.
        const y1 = v[1] * ca1 - v[2] * sa1;
        const z1 = v[1] * sa1 + v[2] * ca1;
        const x2 = v[0] * ca2 + z1 * sa2;
        const z2 = -v[0] * sa2 + z1 * ca2;
        const d = 3.2 + z2;
        proj.push([cx + (x2 * scale * 3.2) / d, cy + (y1 * scale * 3.2) / d]);
    }
    for (let i = 0; i < CUBE_E.length; i++) {
        const [a, b] = CUBE_E[i];
        const color = i < 4 ? TFT_COLOR.CYAN_NEON : i < 8 ? TFT_COLOR.ORANGE : TFT_COLOR.MAGENTA;
        fb.line(proj[a][0] | 0, proj[a][1] | 0, proj[b][0] | 0, proj[b][1] | 0, color);
    }
}

/** Bar spektrum di band bawah (warna bergradasi vertikal). */
function drawBars(fb: TftFramebuffer, t: number, n: number): void {
    const bw = Math.max(2, Math.floor(W / n));
    const base = H - 10;
    const maxH = BAR_H - 12;
    for (let i = 0; i < n; i++) {
        const a = sinI(i * 97 + t * 13);
        const b = sinI(i * 53 - t * 7);
        const c = sinI(i * 211 + t * 3);
        const h = 3 + ((((a + b + c) / 3 + 256) * maxH) / 512) | 0;
        const x = i * bw;
        for (let k = 0; k < h; k++) {
            const y = base - k;
            if (y < 0) break;
            const f = k / maxH;
            fb.hLine(x, y, bw - 1, rgb(80 + 175 * f, 255 - 120 * f, 180 - 160 * f));
        }
    }
}

/** Marquee berjalan di baris paling bawah (font lokal, nol syscall). */
function drawMarquee(fb: TftFramebuffer, text: string, offset: number): void {
    const width = textWidth(text);
    // Mulai dari kanan layar, bergerak ke kiri, masuk lagi dari kanan.
    const x = W - (offset % (width + W));
    drawText(fb, x, H - 7, text, TFT_COLOR.CYAN_NEON);
}

/** HUD: fps, ms/frame (dengan bar anggaran 33 ms), jumlah objek, waktu. */
function drawHud(fb: TftFramebuffer, fps: number, ms: number, objs: number, secs: number): void {
    fb.fillRect(0, 0, W, HUD_H - 1, rgb(0, 0, 0));
    fb.hLine(0, HUD_H - 1, W, rgb(40, 40, 60));
    drawText(fb, 2, 2, `FPS ${fps.toFixed(1)}`, TFT_COLOR.CYAN_NEON);
    drawText(fb, 58, 2, `MS ${ms.toFixed(1)}`, ms > 33 ? TFT_COLOR.RED : TFT_COLOR.GREEN);
    drawText(fb, 108, 2, `OBJ ${objs}`, TFT_COLOR.YELLOW);
    drawText(fb, 152, 2, `${secs.toFixed(0)}S`, TFT_COLOR.WHITE);
    // Anggaran frame 33 ms (target 30 fps) — bar cepat menunjukkan kepala.
    const barX = 186;
    const barW = W - barX - 26;
    const ratio = Math.min(1, ms / 33);
    fb.rect(barX, 2, barW, 5, rgb(60, 60, 80));
    fb.fillRect(barX + 1, 3, Math.max(0, Math.round((barW - 2) * ratio)), 3,
        ratio > 0.9 ? TFT_COLOR.RED : ratio > 0.6 ? TFT_COLOR.YELLOW : TFT_COLOR.GREEN);
    drawText(fb, W - 22, 2, `${Math.round(ratio * 100)}%`, TFT_COLOR.GRAY);
}

// ================================================================
// KONFIGURASI & BANTUAN
// ================================================================

interface Cfg {
    seconds: number;
    sq: number;
    tri: number;
    cir: number;
    stars: number;
    bars: number;
    plasma: number;
    trail: number;
    cube: boolean;
    hud: boolean;
    fps: number;
    stats: boolean;
}

const PRESETS: Record<string, Partial<Cfg>> = {
    "--lite": { plasma: 4, stars: 40, sq: 3, tri: 2, cir: 4, bars: 16, trail: 0 },
    "--insane": { plasma: 1, stars: 320, sq: 12, tri: 10, cir: 16, bars: 32, trail: 2 },
};

async function printHelp(): Promise<void> {
    await std.println("");
    await std.println("💥 tft-objs — stress animasi TFT 320x240 (/dev/tft)");
    await std.println("");
    await std.println("PEMAKAIAN");
    await std.println("  tft-objs [detik] [opsi]        (detik kosong/0 = terus-menerus)");
    await std.println("  tft-objs bench [detik]         ukur fps + biaya raster vs blit");
    await std.println("");
    await std.println("OPSI");
    await std.println("  --sq N        kotak berputar              (6)");
    await std.println("  --tri N       segitiga berputar           (5)");
    await std.println("  --cir N       lingkaran berdenyut         (8)");
    await std.println("  --stars N     bintang starfield 3D        (120)");
    await std.println("  --bars N      bar spektrum               (24)");
    await std.println("  --plasma R    plasma pada 1/R resolusi    (2)");
    await std.println("  --trail N     jejak gerak 1..3            (0)");
    await std.println("  --cube on|off kubus wireframe 3D          (on)");
    await std.println("  --hud on|off  overlay FPS/ms/objek        (on)");
    await std.println("  --fps N       batas laju frame; 0 = bebas (0)");
    await std.println("  --stats       laporan per tahap tiap 2s");
    await std.println("  --lite        preset ringan (Pi lambat)");
    await std.println("  --insane      preset paling brutal");
    await std.println("  -h, --help    bantuan ini");
    await std.println("");
    await std.println("Contoh: tft-objs 30 --insane --stats");
    await std.println("        tft-objs 60 --trail 2 --plasma 0 --cube off");
    await std.println("");
}

function parseArgs(args: string[]): { cmd: string; cfg: Cfg } {
    const cfg: Cfg = {
        seconds: 0,
        sq: 6,
        tri: 5,
        cir: 8,
        stars: 120,
        bars: 24,
        plasma: 2,
        trail: 0,
        cube: true,
        hud: true,
        fps: 0,
        stats: false,
    };
    // Preset dulu (flag eksplisit menang karena diproses setelahnya).
    for (const a of args) {
        const preset = PRESETS[a];
        if (preset) Object.assign(cfg, preset);
    }

    let cmd = "run";
    let secs: number | undefined;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const val = () => args[++i];
        const num = () => parseInt(args[++i], 10);
        const on = () => (val() || "on").toLowerCase() !== "off";
        if (a.startsWith("--")) {
            switch (a) {
                case "--sq": cfg.sq = Math.max(0, num()); break;
                case "--tri": cfg.tri = Math.max(0, num()); break;
                case "--cir": cfg.cir = Math.max(0, num()); break;
                case "--stars": cfg.stars = Math.max(0, num()); break;
                case "--bars": cfg.bars = Math.max(0, num()); break;
                case "--plasma": cfg.plasma = Math.max(0, num()); break;
                case "--trail": cfg.trail = Math.max(0, Math.min(3, num())); break;
                case "--cube": cfg.cube = on(); break;
                case "--hud": cfg.hud = on(); break;
                case "--fps": cfg.fps = Math.max(0, num()); break;
                case "--stats": cfg.stats = true; break;
                default: break; // preset/help/asing: diabaikan
            }
        } else if (secs === undefined && /^\d+$/.test(a)) {
            secs = parseInt(a, 10);
        } else if (cmd === "run" && a === "bench") {
            cmd = "bench";
        }
    }
    cfg.seconds = cmd === "bench" ? secs ?? 5 : secs ?? 0;
    return { cmd, cfg };
}

// ================================================================
// MAIN
// ================================================================

export const main = Program(async (args: string[]) => {
    await std.println("");
    await std.println("╔═══════════════════════════════════════════════╗");
    await std.println("║ 💥 tft-objs — stress animasi TFT 320x240      ║");
    await std.println("╚═══════════════════════════════════════════════╝");

    if (args.includes("-h") || args.includes("--help")) {
        await printHelp();
        return;
    }

    const { cmd, cfg } = parseArgs(args);

    if (!(await tft.isAvailable())) {
        await std.error(`❌ ${tft.devicePath} belum siap (available=false).`);
        await std.error("   Cek /var/log/syslog: driver mencatat alasan node tidak muncul.");
        return;
    }

    const info = await tft.getInfo();
    await std.println(
        `✔ ${tft.devicePath} → ${info?.fbDevice ?? "?"}` +
            (info?.fbName ? ` (${info.fbName})` : "") +
            ` · ${info?.width}x${info?.height} RGB565`,
    );
    await std.println(
        `   plasma 1/${cfg.plasma || "-"} · stars ${cfg.stars} · objek ` +
            `${cfg.sq + cfg.tri + cfg.cir} · bars ${cfg.bars} · trail ${cfg.trail}` +
            `${cfg.cube ? " · cube" : ""}${cfg.hud ? " · hud" : ""}` +
            `${cfg.seconds ? ` · ${cfg.seconds}s` : " · tanpa batas (Ctrl+C)"}`,
    );
    await std.println("");

    // Pola 1 syscall/frame: auto-flush ON → blit() langsung present.
    await tft.setAutoFlush(true);

    const fb = tft.framebuffer();
    const movers = makeMovers(cfg);
    const stars = initStars(cfg.stars);
    const objects = movers.length + (cfg.cube ? 1 : 0);

    // Akumulator statistik per tahap (ms).
    const acc: Record<string, number> = { fade: 0, plasma: 0, stars: 0, shapes: 0, bars: 0, hud: 0, blit: 0 };
    const add = (k: string, t0: number) => {
        acc[k] += nowMs() - t0;
    };

    const tStart = nowMs();
    const limit = cfg.seconds > 0 ? cfg.seconds * 1000 : Infinity;
    let frames = 0;
    let fps = 0;
    let msFrame = 0;
    let lastStats = tStart;
    const hudEnabled = cfg.hud;
    const cx = W >> 1;
    const cy = (PLAY_TOP + PLAY_BOT) >> 1;

    try {
        while (nowMs() - tStart < limit) {
            const f0 = nowMs();
            const t = frames;

            // 1. Latar: fade (jejak) atau plasma penuh.
            if (cfg.trail > 0) {
                const s = nowMs();
                fade(fb, cfg.trail);
                add("fade", s);
                if (cfg.plasma > 0) {
                    const p = nowMs();
                    plasma(fb, t, cfg.plasma, true);
                    add("plasma", p);
                }
            } else if (cfg.plasma > 0) {
                const p = nowMs();
                plasma(fb, t, cfg.plasma, false);
                add("plasma", p);
            } else {
                fb.clear(TFT_COLOR.PANEL_BG);
            }

            // 2. Starfield.
            if (cfg.stars > 0) {
                const s = nowMs();
                drawStars(fb, stars, 0.004 + 0.002 * sinI(t * 3) / 256, cx, cy);
                add("stars", s);
            }

            // 3. Kubus wireframe (di belakang objek).
            const s2 = nowMs();
            if (cfg.cube) {
                drawCube(fb, t * 0.6, cx, (PLAY_TOP + PLAY_BOT) >> 1, 22);
            }
            add("shapes", s2);

            // 4. Objek bergerak (kotak/segitiga/lingkaran).
            const s3 = nowMs();
            for (const o of movers) {
                stepMover(o);
                drawMover(fb, o);
            }
            add("shapes", s3);

            // 5. Bar spektrum.
            if (cfg.bars > 0) {
                const s = nowMs();
                drawBars(fb, t, cfg.bars);
                add("bars", s);
            }

            // 6. Marquee + HUD (font lokal → tetap 1 syscall/frame).
            const s4 = nowMs();
            drawMarquee(fb, "TSIX /DEV/TFT · ILI9341 320X240 RGB565 · 1 SYSCALL PER FRAME · PLASMA + STARFIELD + WIREFRAME · ", t * 3);
            if (hudEnabled) drawHud(fb, fps, msFrame, objects, (nowMs() - tStart) / 1000);
            add("hud", s4);

            // 7. Kirim frame: SATU syscall (auto-flush ON).
            const b0 = nowMs();
            await tft.blit(fb);
            add("blit", b0);

            frames++;
            const elapsed = nowMs() - tStart;
            fps = frames / (elapsed / 1000);
            msFrame = elapsed / frames; // rata-rata sejak start

            if (cfg.stats && nowMs() - lastStats >= 2000) {
                lastStats = nowMs();
                const per = (k: string) => (acc[k] / frames).toFixed(2).padStart(5);
                await std.println(
                    `   fps ${fps.toFixed(1).padStart(5)} · ms/frame ${(elapsed / frames).toFixed(2)} ` +
                        `│ fade ${per("fade")} plasma ${per("plasma")} stars ${per("stars")} ` +
                        `shape ${per("shapes")} bars ${per("bars")} hud ${per("hud")} blit ${per("blit")}`,
                );
            }

            if (cfg.fps > 0) {
                const spent = nowMs() - f0;
                const target = 1000 / cfg.fps;
                if (spent < target) await sleep(target - spent);
            }
        }
    } finally {
        await tft.setAutoFlush(true);
        const total = (nowMs() - tStart) / 1000;
        const per = (k: string) => `${(acc[k] / Math.max(1, frames)).toFixed(2)} ms`;
        await std.println("");
        await std.println(
            `✅ ${frames} frame dalam ${total.toFixed(1)}s = ${(frames / total).toFixed(1)} fps ` +
                `(${(1000 / (frames / total)).toFixed(2)} ms/frame)`,
        );
        await std.println(`   rata-rata: fade ${per("fade")} · plasma ${per("plasma")} · stars ${per("stars")} · ` +
            `shape ${per("shapes")} · bars ${per("bars")} · hud ${per("hud")} · blit ${per("blit")}`);
        if (cmd === "bench") {
            await std.println(
                "   Catatan: 'blit' = 1 round-trip IPC + transfer 150 KB ke fbdev; " +
                    "sisanya raster CPU murni.",
            );
        }
        await tft.close();
    }

    await std.println("");
});
