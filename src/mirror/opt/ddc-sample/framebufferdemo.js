/**
 * framebufferdemo.js — DDC NJ: Demo @tsix/framebuffer (mirror Adafruit-GFX)
 *
 * Menampilkan SEMUA primitif library FrameBuffer di framebuffer LOGIKA
 * ber-scale (gaya pixeloperation.js), dengan animasi kecil:
 *   - Pixel tunggal berkedip
 *   - Garis Bresenham (beberapa sudut)
 *   - Lingkaran & lingkaran terisi (midpoint + scanline)
 *   - Busur (arc) ¼ / ½ / penuh
 *   - Persegi, persegi terisi, persegi sudut membulat
 *   - Segitiga & segitiga terisi
 *   - Polyline (bintang) & hline/vline
 *
 * Library diakses via DDC.FrameBuffer — di-inject oleh DOME ke object DDC
 * dari global window.FrameBuffer (hasil transpile /lib/framebuffer.js yang
 * diprepend oleh TGA ddc-sample9.ts). Jadi NJ TIDAK perlu import:
 *   var fb = new DDC.FrameBuffer(c2, W, H, { scale: 2 });
 *
 * Zero WebSocket per-frame — loop RAF murni di browser.
 */
DDC.onInit(function (ctx) {
    var W = ctx.width;
    var H = ctx.height;
    var c2 = ctx.canvas.getContext("2d");

    // Akses library dari DDC (dipasang DOME bila window.FrameBuffer ada).
    // Fallback ke global untuk kompatibilitas/robust.
    var FB = DDC.FrameBuffer || window.FrameBuffer;
    if (!FB) {
        throw new Error("DDC.FrameBuffer tidak tersedia — prepend /lib/framebuffer.js dulu");
    }

    // Framebuffer LOGIKA + scale 2 → piksel besar ala pixeloperation.js.
    // Kalau mau framebuffer fisik (1:1), pakai scale: 1.
    var fb = new FB(c2, W, H, { scale: 2 });

    var COL = {
        bg: [10, 10, 40],
        red: [255, 60, 60],
        green: [80, 255, 120],
        cyan: [80, 200, 255],
        yellow: [255, 220, 80],
        magenta: [255, 90, 200],
        white: [240, 240, 255],
        orange: [255, 150, 50],
    };

    var t = 0;

    // Bintang 5 sudut → polyline closed
    function starPoints(cx, cy, outer, inner) {
        var pts = [];
        for (var i = 0; i < 10; i++) {
            var ang = -Math.PI / 2 + (i * Math.PI) / 5;
            var r = i % 2 === 0 ? outer : inner;
            pts.push([cx + Math.cos(ang) * r, cy + Math.sin(ang) * r]);
        }
        return pts;
    }

    function drawScene() {
        fb.fillScreen(COL.bg[0], COL.bg[1], COL.bg[2]);

        // 1. Pixel tunggal (berkedip pakai sin)
        var blink = Math.sin(t / 15) > 0;
        if (blink) fb.pixel(6, 6, COL.red);

        // 2. Garis — beberapa sudut
        fb.line(2, 2, fb.width - 3, fb.height - 3, COL.green);   // diagonal utama
        fb.line(2, fb.height - 3, fb.width - 3, 2, COL.green);   // diagonal silang
        fb.line(2, 2, fb.width - 3, 2, COL.cyan);                // atas
        fb.line(2, fb.height - 3, fb.width - 3, fb.height - 3, COL.cyan); // bawah

        // 3. Lingkaran + lingkaran terisi
        var cx1 = Math.floor(fb.width * 0.22);
        var cy1 = Math.floor(fb.height * 0.35);
        var r1 = Math.floor(fb.width * 0.1);
        fb.circle(cx1, cy1, r1, COL.yellow);
        fb.fillCircle(cx1, cy1, Math.floor(r1 / 2), COL.orange);

        // 4. Arc: ¼, ½, penuh
        var ax = Math.floor(fb.width * 0.5);
        var ay = Math.floor(fb.height * 0.3);
        fb.arc(ax, ay, Math.floor(fb.width * 0.08), 0, Math.PI / 2, COL.magenta);
        fb.arc(ax, ay, Math.floor(fb.width * 0.12), 0, Math.PI, COL.magenta);
        fb.arc(ax, ay, Math.floor(fb.width * 0.16), 0, Math.PI * 2, COL.white);

        // 5. Persegi & persegi terisi
        var rx = Math.floor(fb.width * 0.68);
        var ry = Math.floor(fb.height * 0.1);
        fb.rect(rx, ry, Math.floor(fb.width * 0.18), Math.floor(fb.height * 0.14), COL.cyan);
        fb.fillRect(rx + 2, ry + 2, Math.floor(fb.width * 0.08), Math.floor(fb.height * 0.08), COL.blue || COL.green);

        // 6. Segitiga & segitiga terisi
        var tx = Math.floor(fb.width * 0.3);
        var ty = Math.floor(fb.height * 0.68);
        fb.triangle(tx, ty, tx + 24, ty, tx + 12, ty + 20, COL.red);
        fb.fillTriangle(
            Math.floor(fb.width * 0.55), Math.floor(fb.height * 0.72),
            Math.floor(fb.width * 0.75), Math.floor(fb.height * 0.72),
            Math.floor(fb.width * 0.65), Math.floor(fb.height * 0.95),
            COL.green,
        );

        // 7. Persegi sudut membulat
        var brx = Math.floor(fb.width * 0.68);
        var bry = Math.floor(fb.height * 0.62);
        fb.roundRect(brx, bry, Math.floor(fb.width * 0.2), Math.floor(fb.height * 0.16), 6, COL.yellow);

        // 8. Polyline — bintang
        var scx = Math.floor(fb.width * 0.85);
        var scy = Math.floor(fb.height * 0.3);
        fb.polyline(starPoints(scx, scy, Math.floor(fb.width * 0.09), Math.floor(fb.width * 0.045)), COL.white, true);

        // 9. hline / vline cepat
        fb.hline(2, Math.floor(fb.width * 0.4), Math.floor(fb.height * 0.5), COL.orange);
        fb.vline(Math.floor(fb.width * 0.4), Math.floor(fb.height * 0.5), Math.floor(fb.height * 0.7), COL.orange);

        fb.present();
    }

    function frame() {
        drawScene();
        t++;
        ctx.raf(frame);
    }

    ctx.onResize = function (w, h) {
        W = w;
        H = h;
        // Rebuild framebuffer dgn ukuran baru (buffer di-recreate oleh class
        // lewat constructor baru — ganti instance karena W/H berubah).
        fb = new FB(c2, W, H, { scale: 2 });
    };

    ctx.send({ event: "ready", data: { width: W, height: H, scale: 2 } });
    ctx.raf(frame);
});
