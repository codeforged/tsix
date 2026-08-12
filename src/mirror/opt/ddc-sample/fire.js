/**
 * fire.js — DDC NJ: Animasi API (classic DOOM fire, canvas MURNI)
 *
 * Implementasi "Doom fire" klasik dengan palette 37 warna:
 * - Grid sel api, baris bawah paling panas (putih), merambat ke atas
 *   dengan pendinginan acak + sebaran horizontal.
 * - Render pakai ImageData (cepat, autentik 90-an).
 * Zero WebSocket per-frame — loop RAF murni di browser.
 */
DDC.onInit(function (ctx) {
  var W = ctx.width;
  var H = ctx.height;
  var c2 = ctx.canvas.getContext("2d");

  /* Classic 37-color fire palette */
  var FIRE_PALETTE_SIZE = 37;
  var fire_palette = [
    0x070707, 0x1F0707, 0x2F0F07, 0x470F07, 0x571707, 0x671F07, 0x771F07,
    0x8F2707, 0x9F2F07, 0xAF3F07, 0xBF4707, 0xC74707, 0xDF4F07, 0xDF5707,
    0xDF5707, 0xD75F07, 0xD75F07, 0xD7670F, 0xCF6F0F, 0xCF770F, 0xCF7F0F,
    0xCF8717, 0xC78717, 0xC78F17, 0xC7971F, 0xBF9F1F, 0xBF9F1F, 0xBFA727,
    0xBFA727, 0xBFAF2F, 0xB7AF2F, 0xB7B72F, 0xB7B737, 0xCFCF6F, 0xDFDF9F,
    0xEFEFC7, 0xFFFFFF
  ];
  // Precompute channel RGBA (buat putImageData)
  var palR = [], palG = [], palB = [];
  for (var i = 0; i < FIRE_PALETTE_SIZE; i++) {
    palR.push((fire_palette[i] >> 16) & 255);
    palG.push((fire_palette[i] >> 8) & 255);
    palB.push(fire_palette[i] & 255);
  }

  var cellW = 3; // ukuran tiap sel api
  // Kendali kecepatan jilatan api: grid di-update tiap UPDATE_EVERY frame.
  //   1 = paling cepat (tiap frame ~60fps, jilatan liar)
  //   2 = sedang
  //   3 = lambat / lembut (default)
  // Render tetap tiap frame → transisi tetap halus.
  var UPDATE_EVERY = 1;
  var frameCount = 0;
  var cols, rows, fire, imgData, data;

  function initGrid() {
    cols = Math.max(1, Math.floor(W / cellW));
    rows = Math.max(1, Math.floor(H / cellW));
    fire = new Array(cols * rows);
    for (var i = 0; i < fire.length; i++) fire[i] = 0;
    imgData = c2.createImageData(W, H);
    data = imgData.data;
  }

  // Doom fire: baris bawah paling panas, merambat ke atas + pendinginan acak
  function updateFire() {
    for (var y = rows - 1; y >= 0; y--) {
      for (var x = 0; x < cols; x++) {
        var below = y + 1 >= rows
          ? FIRE_PALETTE_SIZE - 1
          : fire[(y + 1) * cols + x];
        var v = below - ((Math.random() * 3) | 0); // dingin acak 0-2
        if (v < 0) v = 0;
        var dx = Math.random() < 0.5 ? -1 : 1; // sebaran kiri/kanan
        fire[y * cols + ((x + dx + cols) % cols)] = v;
      }
    }
  }

  // Render pakai ImageData (cepat)
  function renderFire() {
    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < cols; x++) {
        var v = fire[y * cols + x];
        var r = palR[v], g = palG[v], b = palB[v];
        var baseY = y * cellW * W * 4 + x * cellW * 4;
        for (var py = 0; py < cellW; py++) {
          var rowBase = baseY + py * W * 4;
          for (var px = 0; px < cellW; px++) {
            var idx = rowBase + px * 4;
            data[idx] = r;
            data[idx + 1] = g;
            data[idx + 2] = b;
            data[idx + 3] = 255;
          }
        }
      }
    }
    c2.putImageData(imgData, 0, 0);
  }

  function frame() {
    // Render tiap frame (halus), tapi propagasi api di-update lebih lambat
    // biar jilatan api gak keburu-buru / keburu habis.
    frameCount++;
    if (frameCount % UPDATE_EVERY === 0) updateFire();
    renderFire();
    ctx.raf(frame);
  }

  ctx.onResize = function (w, h) {
    W = w;
    H = h;
    initGrid();
  };

  initGrid();
  ctx.send({ event: "ready", data: { width: W, height: H } });
  ctx.raf(frame);
});
