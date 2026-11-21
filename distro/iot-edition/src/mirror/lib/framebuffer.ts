/**
 * framebuffer.ts — DDC framebuffer 2D primitive library (mirror Adafruit-GFX)
 *
 * Renderer level-pixel murni untuk aplikasi DDC NJ (Native JavaScript) yang
 * berjalan di browser. Semua drawing ditulis langsung ke array RGBA sebuah
 * ImageData (software back-buffer), lalu di-flush sekali via putImageData()
 * oleh present() — TANPA path canvas 2D (moveTo/lineTo/arc).
 *
 * Terinspirasi API Adafruit-GFX (drawPixel, drawLine, drawCircle, fillRect,
 * drawTriangle, drawRoundRect, ...) — tapi khusus "framebuffer mode":
 *   - Tanpa state pen (warna selalu argumen eksplisit, bukan this.color).
 *   - present() eksplisit (swap-buffer ala pixeloperation.js / fire.js).
 *
 * DUA MODE RESOLUSI (mengikuti 2 pola framebuffer yang sudah ada di repo):
 *   1. FISIK  (default, scale=1) — ImageData ukuran W×H persis canvas.
 *      Pola: src/mirror/opt/ddc-sample/fire.js
 *   2. LOGIKA (scale>=2)         — framebuffer kecil (W/scale × H/scale),
 *      tiap 1 piksel logika dirender sebagai blok scale×scale piksel fisik
 *      saat present(). Pola: src/mirror/opt/ddc-sample/pixeloperation.js
 *
 * CATATAN VFS: library @tsix/* di-resolve worker dari /lib/*.ts, jadi file ini
 * otomatis bisa di-import TGA sebagai `import { FrameBuffer } from "@tsix/framebuffer"`.
 * Untuk NJ (browser) yang di-eval via new Function("DDC", src), library harus
 * di-inject sebagai string — hasil transpile VFS /lib/framebuffer.js otomatis
 * mengekspos `FrameBuffer` sebagai GLOBAL window.FrameBuffer (lihat footer di
 * bawah file), sehingga NJ tinggal `new FrameBuffer(ctx.canvas.getContext("2d"), W, H)`.
 *
 * Semua koordinat adalah integer piksel LOGIKA (mode logika) atau piksel FISIK
 * (mode fisik). Warna memakai color: [r,g,b] (0-255). Tidak ada alpha blending
 * — tulis langsung (opaque), konsisten dengan putImageData.
 */

export type RGB = [number, number, number];

export interface FrameBufferOptions {
    /** 1 = framebuffer fisik (ukuran canvas penuh). >=2 = framebuffer logika
     *  dengan upscale blok scale×scale saat present(). Default 1. */
    scale?: number;
}

export class FrameBuffer {
    /** Ukuran logika (== fisik bila scale=1). */
    readonly width: number;
    readonly height: number;
    readonly scale: number;

    private ctx: CanvasRenderingContext2D;
    /** ImageData LOGIKA — back-buffer tempat semua drawing. */
    private fb: ImageData;
    private data: Uint8ClampedArray;
    /** ImageData FISIK (W×H) — hasil scale-up, dipakai present(). */
    private out: ImageData;
    private outData: Uint8ClampedArray;
    private physW: number;
    private physH: number;

    constructor(
        ctx: CanvasRenderingContext2D,
        width: number,
        height: number,
        opts: FrameBufferOptions = {},
    ) {
        const scale = Math.max(1, Math.floor(opts.scale ?? 1));
        this.ctx = ctx;
        this.scale = scale;
        this.width = Math.max(1, Math.floor(width / scale));
        this.height = Math.max(1, Math.floor(height / scale));
        this.physW = Math.max(1, Math.floor(width));
        this.physH = Math.max(1, Math.floor(height));
        this.fb = ctx.createImageData(this.width, this.height);
        this.data = this.fb.data;
        this.out = ctx.createImageData(this.physW, this.physH);
        this.outData = this.out.data;
    }

    // ============================================================
    // PEMELIHARAAN BUFFER
    // ============================================================

    /** Isi seluruh framebuffer logika dengan satu warna (default: hitam). */
    fillScreen(r = 0, g = 0, b = 0): void {
        const d = this.data;
        for (let i = 0; i < d.length; i += 4) {
            d[i] = r;
            d[i + 1] = g;
            d[i + 2] = b;
            d[i + 3] = 255;
        }
    }

    /** Alias fillScreen(0,0,0). */
    clear(): void {
        this.fillScreen(0, 0, 0);
    }

    /**
     * Flush framebuffer ke canvas (swap-buffer).
     * - scale=1: putImageData langsung.
     * - scale>1 : upscale blok scale×scale dulu.
     * O(1) atau O(W×H) tergantung mode; panggil SEKALI per frame.
     */
    present(): void {
        if (this.scale === 1) {
            this.ctx.putImageData(this.fb, 0, 0);
            return;
        }
        const scale = this.scale;
        const lw = this.width;
        const lh = this.height;
        const data = this.data;
        const out = this.outData;
        const W = this.physW;
        const H = this.physH;
        for (let ly = 0; ly < lh; ly++) {
            for (let lx = 0; lx < lw; lx++) {
                const li = (ly * lw + lx) * 4;
                const r = data[li];
                const g = data[li + 1];
                const b = data[li + 2];
                for (let py = 0; py < scale; py++) {
                    const oy = ly * scale + py;
                    if (oy >= H) break; // potongan bawah
                    const rowBase = (oy * W + lx * scale) * 4;
                    for (let px = 0; px < scale; px++) {
                        const ox = lx * scale + px;
                        if (ox >= W) break; // potongan kanan
                        const oi = rowBase + px * 4;
                        out[oi] = r;
                        out[oi + 1] = g;
                        out[oi + 2] = b;
                        out[oi + 3] = 255;
                    }
                }
            }
        }
        this.ctx.putImageData(this.out, 0, 0);
    }

    // ============================================================
    // PRIMITIF — semua dibangun di atas pixel() (pola Adafruit-GFX)
    // ============================================================

    /** Tulis SATU piksel logika. Koordinat di luar grid → diabaikan. */
    pixel(x: number, y: number, color: RGB): void {
        if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
        const idx = (y * this.width + x) * 4;
        this.data[idx] = color[0];
        this.data[idx + 1] = color[1];
        this.data[idx + 2] = color[2];
        this.data[idx + 3] = 255;
    }

    /**
     * Garis Bresenham (integer-only, error term dx+dy).
     * Menerima koordinat apa pun (tidak harus x0<=x1) — di-normalisasi internal.
     */
    line(x0: number, y0: number, x1: number, y1: number, color: RGB): void {
        x0 |= 0;
        y0 |= 0;
        x1 |= 0;
        y1 |= 0;
        const dx = Math.abs(x1 - x0);
        const dy = -Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1;
        const sy = y0 < y1 ? 1 : -1;
        let err = dx + dy;
        for (; ;) {
            this.pixel(x0, y0, color);
            if (x0 === x1 && y0 === y1) break;
            const e2 = 2 * err;
            if (e2 >= dy) {
                err += dy;
                x0 += sx;
            }
            if (e2 <= dx) {
                err += dx;
                y0 += sy;
            }
        }
    }

    /** Garis horizontal cepat (scanline) — lebih efisien dari line(). */
    hline(x0: number, x1: number, y: number, color: RGB): void {
        if (y < 0 || y >= this.height) return;
        const a = Math.max(0, Math.min(x0, x1)) | 0;
        const b = Math.min(this.width - 1, Math.max(x0, x1)) | 0;
        for (let x = a; x <= b; x++) this.pixel(x, y, color);
    }

    /** Garis vertikal cepat. */
    vline(x: number, y0: number, y1: number, color: RGB): void {
        if (x < 0 || x >= this.width) return;
        const a = Math.max(0, Math.min(y0, y1)) | 0;
        const b = Math.min(this.height - 1, Math.max(y0, y1)) | 0;
        for (let y = a; y <= b; y++) this.pixel(x, y, color);
    }

    /** Kerangka persegi (tidak terisi). */
    rect(x: number, y: number, w: number, h: number, color: RGB): void {
        this.hline(x, x + w - 1, y, color);
        this.hline(x, x + w - 1, y + h - 1, color);
        this.vline(x, y, y + h - 1, color);
        this.vline(x + w - 1, y, y + h - 1, color);
    }

    /** Persegi terisi (scanline fill). */
    fillRect(x: number, y: number, w: number, h: number, color: RGB): void {
        x |= 0;
        y |= 0;
        w |= 0;
        h |= 0;
        for (let yy = y; yy < y + h; yy++) this.hline(x, x + w - 1, yy, color);
    }

    /** Lingkaran midpoint (Bresenham circle) — kerangka. */
    circle(cx: number, cy: number, radius: number, color: RGB): void {
        let x = radius | 0;
        let y = 0;
        let err = 1 - x;
        while (x >= y) {
            this.plotCirclePoints(cx, cy, x, y, color);
            y++;
            if (err < 0) {
                err += 2 * y + 1;
            } else {
                x--;
                err += 2 * (y - x) + 1;
            }
        }
    }

    /** Lingkaran terisi (fill via scanline per baris). */
    fillCircle(cx: number, cy: number, radius: number, color: RGB): void {
        let x = radius | 0;
        let y = 0;
        let err = 1 - x;
        while (x >= y) {
            this.hline(cx - x, cx + x, cy + y, color);
            if (y !== 0) this.hline(cx - x, cx + x, cy - y, color);
            if (x !== y) {
                this.hline(cx - y, cx + y, cy + x, color);
                this.hline(cx - y, cx + y, cy - x, color);
            }
            y++;
            if (err < 0) {
                err += 2 * y + 1;
            } else {
                x--;
                err += 2 * (y - x) + 1;
            }
        }
    }

    /**
     * Busur lingkaran (arc) dari startAngle ke stopAngle.
     * - Sudut dalam RADIAN, 0 = arah kanan (3 o'clock), searah jarum jam.
     * - sweep = true → sweep (lawan jarum jam); false → default (searah jarum jam).
     * - Di-render via sampling (jumlah titik = f(radius)), bukan midpoint —
     *   karena arc mid-point butuh oktan parsial. Mirip pendekatan GFX tapi
     *   memakai pendekatan linier sederhana.
     */
    arc(
        cx: number,
        cy: number,
        radius: number,
        startAngle: number,
        stopAngle: number,
        color: RGB,
        sweep = false,
    ): void {
        const r = Math.max(0, radius | 0);
        if (r === 0) {
            this.pixel(cx | 0, cy | 0, color);
            return;
        }
        const PI = Math.PI;
        let a0 = startAngle;
        let a1 = stopAngle;
        if (!sweep) {
            // Normalisasi agar a1 > a0 (searah jarum jam, sudut naik).
            while (a1 <= a0) a1 += PI * 2;
        } else {
            while (a1 >= a0) a1 -= PI * 2;
        }
        // Jumlah titik sampling: ~8 titik per kuadran.
        const steps = Math.max(4, Math.ceil((Math.abs(a1 - a0) / (PI / 2)) * r));
        for (let i = 0; i <= steps; i++) {
            const a = a0 + ((a1 - a0) * i) / steps;
            const px = Math.round(cx + Math.cos(a) * r);
            const py = Math.round(cy + Math.sin(a) * r);
            this.pixel(px, py, color);
        }
    }

    /** Segitiga kerangka (3 sisi). */
    triangle(
        x0: number,
        y0: number,
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        color: RGB,
    ): void {
        this.line(x0, y0, x1, y1, color);
        this.line(x1, y1, x2, y2, color);
        this.line(x2, y2, x0, y0, color);
    }

    /** Segitiga terisi — barycentric scanline (flat/goraud sederhana). */
    fillTriangle(
        x0: number,
        y0: number,
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        color: RGB,
    ): void {
        // Urutkan vertex by y (naik).
        let [ax, ay] = [x0 | 0, y0 | 0];
        let [bx, by] = [x1 | 0, y1 | 0];
        let [cx, cy] = [x2 | 0, y2 | 0];
        if (ay > by) {
            [ax, ay, bx, by] = [bx, by, ax, ay];
        }
        if (by > cy) {
            [bx, by, cx, cy] = [cx, cy, bx, by];
        }
        if (ay > by) {
            [ax, ay, bx, by] = [bx, by, ax, ay];
        }
        // Scan per baris y dari ay..cy, interpolasi x tepi kiri/kanan.
        const totalH = cy - ay;
        if (totalH <= 0) return;
        for (let y = ay; y <= cy; y++) {
            const t1 = totalH === 0 ? 0 : (y - ay) / totalH;
            let xa = ax + t1 * (cx - ax);
            // Tepi kedua: ab lalu bc.
            let xb: number;
            if (y < by) {
                const t2 = by === ay ? 0 : (y - ay) / (by - ay);
                xb = ax + t2 * (bx - ax);
            } else {
                const t2 = by === cy ? 0 : (y - by) / (cy - by);
                xb = bx + t2 * (cx - bx);
            }
            this.hline(Math.floor(Math.min(xa, xb)), Math.ceil(Math.max(xa, xb)), y, color);
        }
    }

    /** Persegi panjang sudut membulat — kerangka. */
    roundRect(
        x: number,
        y: number,
        w: number,
        h: number,
        radius: number,
        color: RGB,
    ): void {
        const r = Math.min(radius, Math.abs(w) / 2, Math.abs(h) / 2) | 0;
        const x1 = x + w - 1;
        const y1 = y + h - 1;
        this.hline(x + r, x1 - r, y, color);
        this.hline(x + r, x1 - r, y1, color);
        this.vline(x, y + r, y1 - r, color);
        this.vline(x1, y + r, y1 - r, color);
        // 4 sudut: kuadran arc radius r.
        this.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5, color);
        this.arc(x1 - r, y + r, r, Math.PI * 1.5, Math.PI * 2, color);
        this.arc(x + r, y1 - r, r, Math.PI * 0.5, Math.PI, color);
        this.arc(x1 - r, y1 - r, r, 0, Math.PI * 0.5, color);
    }

    /** Poligon terbuka dari daftar titik. */
    polyline(pts: Array<[number, number]>, color: RGB, closed = false): void {
        const n = pts.length;
        if (n < 2) return;
        for (let i = 0; i < n - 1; i++) {
            this.line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], color);
        }
        if (closed) {
            this.line(pts[n - 1][0], pts[n - 1][1], pts[0][0], pts[0][1], color);
        }
    }

    // ── internal ──

    /** 8 titik simetris dari satu oktan (helper circle). */
    private plotCirclePoints(cx: number, cy: number, x: number, y: number, color: RGB): void {
        this.pixel(cx + x, cy + y, color);
        this.pixel(cx - x, cy + y, color);
        this.pixel(cx + x, cy - y, color);
        this.pixel(cx - x, cy - y, color);
        this.pixel(cx + y, cy + x, color);
        this.pixel(cx - y, cy + x, color);
        this.pixel(cx + y, cy - x, color);
        this.pixel(cx - y, cy - x, color);
    }
}

/**
 * createFrameBuffer(): helper — buat FrameBuffer dari sebuah <canvas>.
 * Ukuran diambil dari atribut width/height canvas (logical px), scale opsional.
 */
export function createFrameBuffer(
    canvas: HTMLCanvasElement,
    opts: FrameBufferOptions = {},
): FrameBuffer {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("framebuffer: 2D context unavailable");
    return new FrameBuffer(ctx, canvas.width, canvas.height, opts);
}

// ================================================================
// AUTO-REGISTER GLOBAL (untuk DDC NJ / browser)
// ================================================================
// Saat file ini di-transpile ke /lib/framebuffer.js dan di-inject ke NJ
// (yang di-eval via new Function("DDC", src) — tidak bisa import), footer
// ini mengekspos FrameBuffer sebagai GLOBAL (window.FrameBuffer) supaya NJ
// bisa langsung memakainya tanpa perlu require/import.
//   - Di browser: window ada → window.FrameBuffer = FrameBuffer.
//   - Di worker Node (require normal): tidak ada window → no-op, aman.
if (typeof window !== "undefined") {
    (window as any).FrameBuffer = FrameBuffer;
}
