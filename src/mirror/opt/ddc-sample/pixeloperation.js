/**
 * pixeloperation.js — DDC NJ: Framebuffer 2D primitif (pixel, garis, lingkaran)
 *
 * Menggambar primitif grafis level-pixel memakai framebuffer (ImageData):
 *   1. Pixel tunggal      di (100, 50)
 *   2. Garis (Bresenham)  dari (10, 10) ke (150, 100)
 *   3. Lingkaran (midpoint) pusat (80, 100), radius 30
 *
 * Semua drawing ditulis langsung ke array RGBA framebuffer lewat setPixel(),
 * lalu di-flush ke canvas dengan putImageData — TANPA path canvas 2D
 * (moveTo/lineTo/arc). Zero WebSocket per-frame, murni di browser.
 *
 * SCALE RATIO: 1 piksel logika dirender sebagai blok SCALE × SCALE piksel
 * fisik di present() (lihat konstanta SCALE di bawah) agar terlihat jelas.
 */
DDC.onInit(function (ctx) {
  let W = ctx.width;  // resolusi FISIK (piksel canvas) — berubah saat resize
  let H = ctx.height;
  const c2 = ctx.canvas.getContext("2d");

  // ================================================================
  // SCALE RATIO — 1 piksel LOGIKA = SCALE × SCALE piksel FISIK
  // ================================================================
  // Ubah sesuai keinginan: 1 (tanpa scaling), 2 (2×2), 3 (3×3), dst.
  // Semua koordinat gambar ditulis dalam "piksel logika" (resolusi kecil),
  // lalu dibesarkan di present() menjadi blok piksel fisik.
  const SCALE = 2;

  // Resolusi logika (framebuffer kecil) — ukuran canvas fisik ÷ SCALE
  let lw, lh;

  // ── Framebuffer level-pixel ──
  let fb;        // ImageData LOGIKA (lw × lh) — tempat menggambar
  let data;      // RGBA framebuffer logika
  let out;       // ImageData FISIK (W × H) — hasil scale-up
  let outData;   // RGBA framebuffer fisik

  function initFramebuffer() {
    lw = Math.max(1, Math.floor(W / SCALE));
    lh = Math.max(1, Math.floor(H / SCALE));
    fb = c2.createImageData(lw, lh);
    data = fb.data;
    out = c2.createImageData(W, H);
    outData = out.data;
  }

  // Isi seluruh framebuffer dengan satu warna latar
  function clearFramebuffer(r, g, b) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }

  // Tulis SATU piksel LOGIKA ke framebuffer (dengan batas logical grid)
  function setPixel(x, y, r, g, b) {
    if (x < 0 || x >= lw || y < 0 || y >= lh) return;
    const idx = (y * lw + x) * 4;
    data[idx] = r;
    data[idx + 1] = g;
    data[idx + 2] = b;
    data[idx + 3] = 255;
  }

  // ── PRESENTATION — scale up framebuffer logika → fisik ──
  // Setiap 1 piksel logika (lx, ly) diperbesar jadi blok SCALE × SCALE
  // piksel fisik, lalu di-flush ke canvas (mirip "swap buffer").
  function present() {
    for (let ly = 0; ly < lh; ly++) {
      for (let lx = 0; lx < lw; lx++) {
        const li = (ly * lw + lx) * 4;
        const r = data[li];
        const g = data[li + 1];
        const b = data[li + 2];
        // Blok SCALE × SCALE piksel fisik
        for (let py = 0; py < SCALE; py++) {
          const oy = ly * SCALE + py;
          if (oy >= H) break; // potongan bawah (canvas tak habis dibagi SCALE)
          const rowBase = (oy * W + lx * SCALE) * 4;
          for (let px = 0; px < SCALE; px++) {
            const ox = lx * SCALE + px;
            if (ox >= W) break; // potongan kanan
            const oi = rowBase + px * 4;
            outData[oi] = r;
            outData[oi + 1] = g;
            outData[oi + 2] = b;
            outData[oi + 3] = 255;
          }
        }
      }
    }
    c2.putImageData(out, 0, 0);
  }

  // ── Algoritma garis Bresenham ──
  // Bebas floating-point, hanya integer increment/error term.
  function drawLine(x0, y0, x1, y1, r, g, b) {
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (; ;) {
      setPixel(x0, y0, r, g, b);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; } // langkah sumbu-x
      if (e2 <= dx) { err += dx; y0 += sy; } // langkah sumbu-y
    }
  }

  // ── Algoritma lingkaran midpoint (Bresenham circle) ──
  function drawCircle(cx, cy, radius, r, g, b) {
    let x = radius;
    let y = 0;
    let err = 1 - radius;
    while (x >= y) {
      plotCirclePoints(cx, cy, x, y, r, g, b);
      y++;
      if (err < 0) {
        err += 2 * y + 1;
      } else {
        x--;
        err += 2 * (y - x) + 1;
      }
    }
  }

  // 8 titik simetris dari satu oktan
  function plotCirclePoints(cx, cy, x, y, r, g, b) {
    setPixel(cx + x, cy + y, r, g, b);
    setPixel(cx - x, cy + y, r, g, b);
    setPixel(cx + x, cy - y, r, g, b);
    setPixel(cx - x, cy - y, r, g, b);
    setPixel(cx + y, cy + x, r, g, b);
    setPixel(cx - y, cy + x, r, g, b);
    setPixel(cx + y, cy - x, r, g, b);
    setPixel(cx - y, cy - x, r, g, b);
  }

  // ── Komposisi adegan ──
  function drawScene() {
    clearFramebuffer(10, 10, 218); // latar biru

    // 1. Pixel tunggal di (100, 50) — merah
    setPixel(100, 50, 255, 60, 60);

    // 2. Garis Bresenham dari (10, 10) ke (150, 100) — hijau
    drawLine(10, 10, 150, 100, 80, 255, 120);

    // 3. Lingkaran pusat (80, 100), radius 30 — sian
    drawCircle(80, 100, 30, 80, 200, 255);

    present();
  }

  function frame() {
    // Adegan statis — cukup render sekali. Loop RAF dipertahankan agar
    // sesuai pola DDC (host bisa tracking/menghentikan RAF per window).
    ctx.raf(frame);
  }

  ctx.onResize = function (w, h) {
    W = w;
    H = h;
    initFramebuffer();
    drawScene();
  };

  initFramebuffer();
  drawScene();
  ctx.send({ event: "ready", data: { width: W, height: H } });
  ctx.raf(frame);
});
