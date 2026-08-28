import { describe, it, expect } from "vitest";
import { FrameBuffer, RGB } from "./framebuffer";

/**
 * Stub CanvasRenderingContext2D minimal untuk test (tanpa DOM/jsdom).
 * Hanya menyediakan createImageData/putImageData yang dibutuhkan FrameBuffer.
 */
function makeCtx(): CanvasRenderingContext2D {
    const images = new Map<ImageData, Uint8ClampedArray>();
    const ctx = {
        createImageData: (w: number, h: number): ImageData => {
            const id = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) } as unknown as ImageData;
            images.set(id, id.data);
            return id;
        },
        putImageData: (_img: ImageData, _dx: number, _dy: number): void => {
            // no-op di test — kita inspeksi buffer via readPixel
        },
    } as unknown as CanvasRenderingContext2D;
    (ctx as any).__images = images;
    return ctx;
}

/** Baca warna piksel dari buffer INTERNAL (logika) FrameBuffer. */
function readPixel(fb: FrameBuffer, x: number, y: number): RGB {
    const ctx = (fb as any).ctx as any;
    const data: Uint8ClampedArray = ctx.__images.get((fb as any).fb)!;
    const idx = (y * fb.width + x) * 4;
    return [data[idx], data[idx + 1], data[idx + 2]];
}

/** true jika piksel 'menyala' (berbeda dari background hitam default). */
function isLit(fb: FrameBuffer, x: number, y: number): boolean {
    const [r, g, b] = readPixel(fb, x, y);
    return r !== 0 || g !== 0 || b !== 0;
}

/** Hitung piksel menyala. */
function countPixels(fb: FrameBuffer): number {
    let n = 0;
    for (let y = 0; y < fb.height; y++)
        for (let x = 0; x < fb.width; x++) if (isLit(fb, x, y)) n++;
    return n;
}

const RED: RGB = [255, 0, 0];
const GREEN: RGB = [0, 255, 0];
const BLUE: RGB = [0, 0, 255];

describe("FrameBuffer", () => {
    describe("konstruksi", () => {
        it("mode fisik (scale=1): ukuran == canvas", () => {
            const fb = new FrameBuffer(makeCtx(), 320, 200);
            expect(fb.width).toBe(320);
            expect(fb.height).toBe(200);
            expect(fb.scale).toBe(1);
        });

        it("mode logika (scale=2): ukuran = floor(canvas/scale)", () => {
            const fb = new FrameBuffer(makeCtx(), 320, 200, { scale: 2 });
            expect(fb.width).toBe(160);
            expect(fb.height).toBe(100);
            expect(fb.scale).toBe(2);
        });

        it("scale invalid (<1) dipaksa jadi 1", () => {
            const fb = new FrameBuffer(makeCtx(), 100, 100, { scale: 0 });
            expect(fb.scale).toBe(1);
        });
    });

    describe("fillScreen / clear", () => {
        it("fillScreen mengisi semua piksel dengan warna", () => {
            const fb = new FrameBuffer(makeCtx(), 10, 10);
            fb.fillScreen(12, 34, 56);
            expect(readPixel(fb, 0, 0)).toEqual([12, 34, 56]);
            expect(readPixel(fb, 9, 9)).toEqual([12, 34, 56]);
            expect(readPixel(fb, 5, 5)).toEqual([12, 34, 56]);
        });

        it("clear = fillScreen hitam", () => {
            const fb = new FrameBuffer(makeCtx(), 10, 10);
            fb.fillScreen(255, 255, 255);
            fb.clear();
            expect(readPixel(fb, 3, 7)).toEqual([0, 0, 0]);
        });
    });

    describe("pixel & clipping", () => {
        it("pixel menulis RGBA opaque", () => {
            const fb = new FrameBuffer(makeCtx(), 20, 20);
            fb.pixel(5, 5, GREEN);
            expect(readPixel(fb, 5, 5)).toEqual(GREEN);
        });

        it("pixel di luar grid diabaikan (tidak throw & tidak menulis)", () => {
            const fb = new FrameBuffer(makeCtx(), 20, 20);
            expect(() => fb.pixel(-1, 0, RED)).not.toThrow();
            expect(() => fb.pixel(20, 0, RED)).not.toThrow();
            expect(() => fb.pixel(0, 20, RED)).not.toThrow();
            expect(isLit(fb, 0, 0)).toBe(false);
        });
    });

    describe("line (Bresenham)", () => {
        it("garis horizontal", () => {
            const fb = new FrameBuffer(makeCtx(), 20, 20);
            fb.line(2, 5, 8, 5, RED);
            for (let x = 2; x <= 8; x++) expect(readPixel(fb, x, 5)).toEqual(RED);
        });

        it("garis diagonal 45 derajat punya 9 titik (inkl. kedua ujung)", () => {
            const fb = new FrameBuffer(makeCtx(), 20, 20);
            fb.line(1, 1, 9, 9, GREEN);
            expect(countPixels(fb)).toBe(9);
        });

        it("arah terbalik (x1<x0) tetap tergambar", () => {
            const fb = new FrameBuffer(makeCtx(), 20, 20);
            fb.line(8, 5, 2, 5, BLUE);
            for (let x = 2; x <= 8; x++) expect(readPixel(fb, x, 5)).toEqual(BLUE);
        });
    });

    describe("rect & fillRect", () => {
        it("rect menggambar 4 sisi", () => {
            const fb = new FrameBuffer(makeCtx(), 20, 20);
            fb.rect(2, 2, 5, 4, RED);
            for (let x = 2; x <= 6; x++) {
                expect(readPixel(fb, x, 2)).toEqual(RED); // atas
                expect(readPixel(fb, x, 5)).toEqual(RED); // bawah
            }
            for (let y = 2; y <= 5; y++) {
                expect(readPixel(fb, 2, y)).toEqual(RED); // kiri
                expect(readPixel(fb, 6, y)).toEqual(RED); // kanan
            }
            // dalam kosong
            expect(isLit(fb, 4, 3)).toBe(false);
        });

        it("fillRect mengisi area penuh", () => {
            const fb = new FrameBuffer(makeCtx(), 20, 20);
            fb.fillRect(2, 2, 5, 4, GREEN);
            for (let y = 2; y <= 5; y++)
                for (let x = 2; x <= 6; x++) expect(readPixel(fb, x, y)).toEqual(GREEN);
        });
    });

    describe("circle & fillCircle", () => {
        it("circle radius 1 = 4 piksel (midpoint, sudut ortogonal)", () => {
            const fb = new FrameBuffer(makeCtx(), 20, 20);
            fb.circle(10, 10, 1, RED);
            expect(countPixels(fb)).toBe(4);
        });

        it("fillCircle mengisi cakram (jumlah piksel > kerangka)", () => {
            const fb = new FrameBuffer(makeCtx(), 40, 40);
            fb.fillCircle(20, 20, 8, GREEN);
            const n = countPixels(fb);
            // luas π*8² ≈ 201; kerangka 8-circle ≈ 50
            expect(n).toBeGreaterThan(150);
            expect(n).toBeLessThan(230);
            // titik tengah pasti terisi
            expect(readPixel(fb, 20, 20)).toEqual(GREEN);
        });
    });

    describe("triangle", () => {
        it("triangle menggambar 3 sisi", () => {
            const fb = new FrameBuffer(makeCtx(), 40, 40);
            fb.triangle(5, 5, 20, 5, 12, 20, RED);
            // sisi horizontal atas
            for (let x = 5; x <= 20; x++) expect(readPixel(fb, x, 5)).toEqual(RED);
        });

        it("fillTriangle mengisi area (titik dalam terisi)", () => {
            const fb = new FrameBuffer(makeCtx(), 40, 40);
            fb.fillTriangle(5, 5, 25, 5, 15, 25, GREEN);
            // centroid kira-kira (15, ~11)
            expect(readPixel(fb, 15, 11)).toEqual(GREEN);
            // di luar segitiga tidak terisi
            expect(isLit(fb, 0, 0)).toBe(false);
        });
    });

    describe("arc", () => {
        it("arc penuh 0..2π ≈ lingkaran (jumlah piksel ~ sampling)", () => {
            const fb = new FrameBuffer(makeCtx(), 40, 40);
            fb.arc(20, 20, 8, 0, Math.PI * 2, RED);
            const n = countPixels(fb);
            // sampling linier: steps = 8*4 = 32 titik (unik setelah kuantisasi grid)
            expect(n).toBeGreaterThan(24);
            expect(n).toBeLessThan(50);
        });

        it("arc seperempat hanya menempati satu kuadran (x>=cx && y>=cy)", () => {
            const fb = new FrameBuffer(makeCtx(), 40, 40);
            fb.arc(20, 20, 8, 0, Math.PI / 2, BLUE);
            for (let y = 0; y < 40; y++)
                for (let x = 0; x < 40; x++) {
                    const p = readPixel(fb, x, y);
                    if (p && p[2] === 255) {
                        expect(x).toBeGreaterThanOrEqual(20);
                        expect(y).toBeGreaterThanOrEqual(20);
                    }
                }
        });
    });

    describe("roundRect & polyline", () => {
        it("roundRect punya piksel di sisi lurus dan tak ada di pojok tajam", () => {
            const fb = new FrameBuffer(makeCtx(), 40, 40);
            fb.roundRect(4, 4, 20, 16, 4, RED);
            // sisi atas (tengah) terisi
            expect(readPixel(fb, 12, 4)).toEqual(RED);
            // pojok tajam (radius>0) tidak ada pixel di (4,4)
            expect(isLit(fb, 4, 4)).toBe(false);
        });

        it("polyline closed menggambar sisi penutup", () => {
            const fb = new FrameBuffer(makeCtx(), 40, 40);
            fb.polyline([[5, 5], [20, 5], [12, 20]], RED, true);
            for (let x = 5; x <= 20; x++) expect(readPixel(fb, x, 5)).toEqual(RED);
        });
    });

    describe("present (scale)", () => {
        it("scale=1 memanggil putImageData dengan ImageData fisik", () => {
            const ctx = makeCtx() as any;
            const fb = new FrameBuffer(ctx, 20, 10);
            let called = 0;
            ctx.putImageData = (img: ImageData) => {
                called++;
                expect(img.width).toBe(20);
                expect(img.height).toBe(10);
            };
            fb.present();
            expect(called).toBe(1);
        });

        it("scale=2 menulis blok 2x2 ke ImageData fisik", () => {
            const ctx = makeCtx() as any;
            const fb = new FrameBuffer(ctx, 20, 10, { scale: 2 });
            fb.pixel(1, 1, RED);
            let put: ImageData | null = null;
            ctx.putImageData = (img: ImageData) => {
                put = img;
            };
            fb.present();
            expect(put).not.toBeNull();
            // piksel logika (1,1) → blok fisik (2..3, 2..3)
            for (let y = 2; y <= 3; y++)
                for (let x = 2; x <= 3; x++) {
                    const idx = (y * 20 + x) * 4;
                    expect(put!.data[idx]).toBe(255);
                    expect(put!.data[idx + 1]).toBe(0);
                    expect(put!.data[idx + 2]).toBe(0);
                }
            // di luar blok tetap kosong
            expect(put!.data[(2 * 20 + 1) * 4]).toBe(0);
        });
    });
});
