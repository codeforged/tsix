/**
 * Verifikasi mandiri framebuffer.ts (tanpa vitest — rolldown binding rusak di
 * env ini). Meniru logika framebuffer.test.ts tapi memakai assert biasa.
 * Jalankan: node -r esbuild-register -r tsconfig-paths/register scripts/verify-framebuffer.ts
 */
import { FrameBuffer, RGB } from "../src/mirror/lib/framebuffer";

function makeCtx(): any {
    const images = new Map<any, Uint8ClampedArray>();
    const ctx = {
        createImageData: (w: number, h: number) => {
            const id = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
            images.set(id, id.data);
            return id;
        },
        putImageData: () => { },
    };
    ctx.__images = images;
    return ctx;
}

function readPixel(fb: FrameBuffer, x: number, y: number): RGB {
    const ctx = (fb as any).ctx;
    const data: Uint8ClampedArray = ctx.__images.get((fb as any).fb);
    const idx = (y * fb.width + x) * 4;
    return [data[idx], data[idx + 1], data[idx + 2]];
}

/** true jika piksel 'menyala' (berbeda dari background hitam default). */
function isLit(fb: FrameBuffer, x: number, y: number): boolean {
    const [r, g, b] = readPixel(fb, x, y);
    return r !== 0 || g !== 0 || b !== 0;
}

function countPixels(fb: FrameBuffer): number {
    let n = 0;
    for (let y = 0; y < fb.height; y++)
        for (let x = 0; x < fb.width; x++) if (isLit(fb, x, y)) n++;
    return n;
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = "") {
    if (cond) {
        pass++;
        console.log("  ✔ " + name);
    } else {
        fail++;
        console.error("  ✘ " + name + (extra ? " — " + extra : ""));
    }
}

const RED: RGB = [255, 0, 0];
const GREEN: RGB = [0, 255, 0];
const BLUE: RGB = [0, 0, 255];

console.log("== Konstruksi ==");
{
    const fb = new FrameBuffer(makeCtx(), 320, 200);
    check("scale=1 ukuran fisik", fb.width === 320 && fb.height === 200 && fb.scale === 1);
    const fb2 = new FrameBuffer(makeCtx(), 320, 200, { scale: 2 });
    check("scale=2 ukuran logika", fb2.width === 160 && fb2.height === 100 && fb2.scale === 2);
    const fb3 = new FrameBuffer(makeCtx(), 100, 100, { scale: 0 });
    check("scale<1 dipaksa 1", fb3.scale === 1);
}

console.log("== fillScreen / clear ==");
{
    const fb = new FrameBuffer(makeCtx(), 10, 10);
    fb.fillScreen(12, 34, 56);
    check("fillScreen semua piksel", JSON.stringify(readPixel(fb, 0, 0)) === "[12,34,56]" && JSON.stringify(readPixel(fb, 9, 9)) === "[12,34,56]");
    fb.fillScreen(255, 255, 255);
    fb.clear();
    check("clear = hitam", JSON.stringify(readPixel(fb, 3, 7)) === "[0,0,0]");
}

console.log("== pixel & clipping ==");
{
    const fb = new FrameBuffer(makeCtx(), 20, 20);
    fb.pixel(5, 5, GREEN);
    check("pixel RGBA", JSON.stringify(readPixel(fb, 5, 5)) === "[0,255,0]");
    let threw = false;
    try { fb.pixel(-1, 0, RED); fb.pixel(20, 0, RED); fb.pixel(0, 20, RED); } catch { threw = true; }
    check("pixel OOB tidak throw", !threw);
    check("pixel OOB tidak menulis", !isLit(fb, 0, 0));
}

console.log("== line ==");
{
    const fb = new FrameBuffer(makeCtx(), 20, 20);
    fb.line(2, 5, 8, 5, RED);
    let ok = true;
    for (let x = 2; x <= 8; x++) if (JSON.stringify(readPixel(fb, x, 5)) !== "[255,0,0]") ok = false;
    check("garis horizontal", ok);
    const fb2 = new FrameBuffer(makeCtx(), 20, 20);
    fb2.line(1, 1, 9, 9, GREEN);
    check("diagonal 45° = 9 titik", countPixels(fb2) === 9, "got " + countPixels(fb2));
    const fb3 = new FrameBuffer(makeCtx(), 20, 20);
    fb3.line(8, 5, 2, 5, BLUE);
    let ok3 = true;
    for (let x = 2; x <= 8; x++) if (JSON.stringify(readPixel(fb3, x, 5)) !== "[0,0,255]") ok3 = false;
    check("arah terbalik", ok3);
}

console.log("== rect & fillRect ==");
{
    const fb = new FrameBuffer(makeCtx(), 20, 20);
    fb.rect(2, 2, 5, 4, RED);
    let ok = true;
    for (let x = 2; x <= 6; x++) {
        if (JSON.stringify(readPixel(fb, x, 2)) !== "[255,0,0]") ok = false;
        if (JSON.stringify(readPixel(fb, x, 5)) !== "[255,0,0]") ok = false;
    }
    for (let y = 2; y <= 5; y++) {
        if (JSON.stringify(readPixel(fb, 2, y)) !== "[255,0,0]") ok = false;
        if (JSON.stringify(readPixel(fb, 6, y)) !== "[255,0,0]") ok = false;
    }
    check("rect 4 sisi", ok);
    check("rect dalam kosong", !isLit(fb, 4, 3));
    const fb2 = new FrameBuffer(makeCtx(), 20, 20);
    fb2.fillRect(2, 2, 5, 4, GREEN);
    let ok2 = true;
    for (let y = 2; y <= 5; y++) for (let x = 2; x <= 6; x++) if (JSON.stringify(readPixel(fb2, x, y)) !== "[0,255,0]") ok2 = false;
    check("fillRect penuh", ok2);
}

console.log("== circle & fillCircle ==");
{
    const fb = new FrameBuffer(makeCtx(), 20, 20);
    fb.circle(10, 10, 1, RED);
    check("circle r=1 = 4 piksel", countPixels(fb) === 4, "got " + countPixels(fb));
    const fb2 = new FrameBuffer(makeCtx(), 40, 40);
    fb2.fillCircle(20, 20, 8, GREEN);
    const n = countPixels(fb2);
    check("fillCircle luas ~πr²", n > 150 && n < 230, "got " + n);
    check("fillCircle tengah terisi", JSON.stringify(readPixel(fb2, 20, 20)) === "[0,255,0]");
}

console.log("== triangle ==");
{
    const fb = new FrameBuffer(makeCtx(), 40, 40);
    fb.triangle(5, 5, 20, 5, 12, 20, RED);
    let ok = true;
    for (let x = 5; x <= 20; x++) if (JSON.stringify(readPixel(fb, x, 5)) !== "[255,0,0]") ok = false;
    check("triangle sisi atas", ok);
    const fb2 = new FrameBuffer(makeCtx(), 40, 40);
    fb2.fillTriangle(5, 5, 25, 5, 15, 25, GREEN);
    check("fillTriangle centroid terisi", JSON.stringify(readPixel(fb2, 15, 11)) === "[0,255,0]", "got " + JSON.stringify(readPixel(fb2, 15, 11)));
    check("fillTriangle luar kosong", !isLit(fb2, 0, 0));
}

console.log("== arc ==");
{
    const fb = new FrameBuffer(makeCtx(), 40, 40);
    fb.arc(20, 20, 8, 0, Math.PI * 2, RED);
    const n = countPixels(fb);
    check("arc penuh ≈ 32 piksel", n > 24 && n < 50, "got " + n);
    const fb2 = new FrameBuffer(makeCtx(), 40, 40);
    fb2.arc(20, 20, 8, 0, Math.PI / 2, BLUE);
    let ok = true;
    for (let y = 0; y < 40; y++)
        for (let x = 0; x < 40; x++) {
            const p = readPixel(fb2, x, y);
            if (p && p[2] === 255 && (x < 20 || y < 20)) ok = false;
        }
    check("arc ¼ hanya kuadran kanan-bawah", ok);
}

console.log("== roundRect & polyline ==");
{
    const fb = new FrameBuffer(makeCtx(), 40, 40);
    fb.roundRect(4, 4, 20, 16, 4, RED);
    check("roundRect sisi tengah atas", JSON.stringify(readPixel(fb, 12, 4)) === "[255,0,0]");
    check("roundRect pojok tajam kosong", !isLit(fb, 4, 4), "got " + JSON.stringify(readPixel(fb, 4, 4)));
    const fb2 = new FrameBuffer(makeCtx(), 40, 40);
    fb2.polyline([[5, 5], [20, 5], [12, 20]], RED, true);
    let ok = true;
    for (let x = 5; x <= 20; x++) if (JSON.stringify(readPixel(fb2, x, 5)) !== "[255,0,0]") ok = false;
    check("polyline closed sisi atas", ok);
}

console.log("== present (scale) ==");
{
    const ctx = makeCtx();
    const fb = new FrameBuffer(ctx, 20, 10);
    let called = 0;
    ctx.putImageData = (img: any) => { called++; if (img.width !== 20 || img.height !== 10) called = -1; };
    fb.present();
    check("present scale=1 putImageData fisik", called === 1, "called=" + called);

    const ctx2 = makeCtx();
    const fb2 = new FrameBuffer(ctx2, 20, 10, { scale: 2 });
    fb2.pixel(1, 1, RED);
    let put: any = null;
    ctx2.putImageData = (img: any) => { put = img; };
    fb2.present();
    let ok = put !== null;
    for (let y = 2; y <= 3; y++)
        for (let x = 2; x <= 3; x++) {
            const idx = (y * 20 + x) * 4;
            if (!(put.data[idx] === 255 && put.data[idx + 1] === 0 && put.data[idx + 2] === 0)) ok = false;
        }
    check("present scale=2 blok 2×2", ok);
    check("present scale=2 luar blok kosong", put.data[(2 * 20 + 1) * 4] === 0);
}

console.log("\n===== HASIL: " + pass + " lulus, " + fail + " gagal =====");
process.exit(fail === 0 ? 0 : 1);
