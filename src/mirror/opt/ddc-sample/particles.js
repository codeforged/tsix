/**
 * particles.js — DDC Native JavaScript (NJ) sample (Fabric.js based)
 *
 * Berjalan 100% di browser: animasi zero WebSocket per-frame.
 * Komunikasi TGA ↔ NJ tetap lewat mekanisme PixelSpace.
 *
 * - Klik canvas → spawn circle di titik itu + kirim event ke TGA
 * - Terima pesan "burst" / "clear" / "count" dari TGA
 *
 * File ini PLAIN JS (bukan TypeScript) yang dieksekusi di browser
 * dalam konteks window TGA (Shadow DOM, hak gambar terbatas).
 * Berada satu folder dengan TGA-nya (ddc-sample.ts) — via /opt/ddc-sample/.
 */
DDC.onInit(function (ctx) {
  var W = ctx.width;
  var H = ctx.height;

  // Fabric.js dimuat via CDN (MIT). Tersedia sebagai ctx.fabric.
  // enableRetinaScaling default true → crisp di layar HiDPI,
  // koordinat = CSS px (sama dengan ctx.width/ctx.height).
  var canvas = new ctx.fabric.Canvas(ctx.canvas, {
    selection: false,
    preserveObjectStacking: true,
  });

  var circles = [];
  var colors = ["#4caf50", "#2196f3", "#ff9800", "#f44336", "#9c27b0"];

  function addCircle(x, y, r) {
    var c = new ctx.fabric.Circle({
      left: x - r,
      top: y - r,
      radius: r,
      fill: colors[(Math.random() * colors.length) | 0],
    });
    c.vx = (Math.random() - 0.5) * 6;
    c.vy = (Math.random() - 0.5) * 6;
    canvas.add(c);
    circles.push(c);
    return c;
  }

  // Animasi loop — RAF di browser, ZERO WebSocket
  function frame() {
    for (var i = circles.length - 1; i >= 0; i--) {
      var c = circles[i];
      c.left += c.vx;
      c.top += c.vy;
      if (c.left < 0 || c.left + c.radius * 2 > W) c.vx = -c.vx;
      if (c.top < 0 || c.top + c.radius * 2 > H) c.vy = -c.vy;
    }
    canvas.renderAll();
    ctx.raf(frame);
  }

  // Klik canvas → spawn circle + kirim event ke TGA (sparse)
  canvas.on("mouse:down", function (opt) {
    var p = opt.pointer;
    addCircle(p.x, p.y, 12 + Math.random() * 14);
    ctx.send({
      event: "click",
      data: { x: Math.round(p.x), y: Math.round(p.y) },
    });
    ctx.send({ event: "count", data: circles.length });
  });

  // ← dari TGA (DDC_MSG)
  ctx.onMessage = function (msg) {
    if (msg.cmd === "burst") {
      for (var i = 0; i < 6; i++) {
        addCircle(
          W / 2 + (Math.random() - 0.5) * 40,
          H / 2 + (Math.random() - 0.5) * 40,
          12 + Math.random() * 14,
        );
      }
      ctx.send({ event: "count", data: circles.length });
    } else if (msg.cmd === "clear") {
      circles.length = 0;
      canvas.clear();
      ctx.send({ event: "count", data: 0 });
    } else if (msg.cmd === "count") {
      ctx.send({ event: "count", data: circles.length });
    }
  };

  ctx.onResize = function (w, h) {
    W = w;
    H = h;
    canvas.setDimensions({ width: w, height: h });
    // Clamp circle ke area baru
    for (var i = 0; i < circles.length; i++) {
      var c = circles[i];
      if (c.left > W) c.left = W - c.radius * 2;
      if (c.top > H) c.top = H - c.radius * 2;
    }
    canvas.renderAll();
  };

  ctx.onDestroy = function () {
    canvas.dispose();
  };

  // Spawn beberapa circle awal
  for (var i = 0; i < 5; i++) {
    addCircle(
      Math.random() * (W - 40) + 20,
      Math.random() * (H - 40) + 20,
      12 + Math.random() * 10,
    );
  }

  // Kabari TGA bahwa NJ siap
  ctx.send({
    event: "ready",
    data: { width: W, height: H, circles: circles.length },
  });

  ctx.raf(frame);
});
