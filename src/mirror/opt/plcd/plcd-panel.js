/**
 * plcd-panel.js — DDC NJ: viewer panel PSEUDO-LCD 128x64 (/dev/plcd)
 *
 * Menggambar isi DD-RAM panel palsu (driver kernel `PLCDDevice`) di canvas,
 * 1 piksel logika = `scale` x `scale` piksel fisik (integer, tanpa smoothing)
 * supaya tampak seperti LCD dot-matrix sungguhan — bukan hasil anti-alias.
 *
 * Protokol (TGA → NJ):
 *   { t: "frame", fb, invert, displayOn, backlight, contrast, rev }
 *     `fb` = base64 1024 byte, 1 bpp MSB-first row-major (format drawBitmap
 *     Adafruit_GFX) — sama persis dengan isi panel yang sedang tampil.
 *   { t: "reset" }   → kosongkan panel (mis. /dev/plcd belum ada isinya)
 *
 * NJ → TGA:
 *   { event: "ready", panelW, panelH, scale }
 *
 * Catatan: invert / display-off / backlight-off adalah properti TAMPILAN
 * (kaca panel), jadi diterapkan di sini — byte DD-RAM tetap mentah.
 */
DDC.onInit(function (ctx) {
  var PANEL_W = 128;
  var PANEL_H = 64;
  var W = ctx.width;
  var H = ctx.height;
  var c2 = ctx.canvas.getContext("2d");

  // Palet LCD monokrom: piksel OFF = hijau metalik, ON = hitam pekat.
  var GLASS = [172, 209, 93]; // kaca menyala (backlight ON)
  var GLASS_DIM = [58, 70, 34]; // kaca tanpa backlight
  var INK = [11, 13, 8];

  var state = { invert: false, displayOn: true, backlight: true };
  var scale = 1;
  var offX = 0;
  var offY = 0;
  var haveFrame = false;

  // Canvas offscreen 128x64 → di-blit ke canvas utama dengan skala integer.
  var off = document.createElement("canvas");
  off.width = PANEL_W;
  off.height = PANEL_H;
  var octx = off.getContext("2d");
  var imgData = octx.createImageData(PANEL_W, PANEL_H);

  function layout() {
    scale = Math.max(1, Math.floor(Math.min(W / PANEL_W, H / PANEL_H)));
    offX = Math.floor((W - PANEL_W * scale) / 2);
    offY = Math.floor((H - PANEL_H * scale) / 2);
    c2.imageSmoothingEnabled = false;
  }

  /** Decode base64 1024 byte (1 bpp MSB-first) → ImageData 128x64. */
  function decode(b64) {
    var bytes = atob(b64 || "");
    var d = imgData.data;
    var glass = state.backlight ? GLASS : GLASS_DIM;
    var offCol = state.displayOn ? glass : GLASS_DIM;
    var inkCol = state.invert ? glass : INK;
    for (var y = 0; y < PANEL_H; y++) {
      for (var x = 0; x < PANEL_W; x++) {
        var b = bytes.charCodeAt(y * (PANEL_W >> 3) + (x >> 3)) || 0;
        var bit = (b >> (7 - (x & 7))) & 1;
        var col = bit ? inkCol : offCol;
        var i = (y * PANEL_W + x) * 4;
        d[i] = col[0];
        d[i + 1] = col[1];
        d[i + 2] = col[2];
        d[i + 3] = 255;
      }
    }
    octx.putImageData(imgData, 0, 0);
    haveFrame = true;
  }

  function clearPanel() {
    var d = imgData.data;
    var glass = state.backlight ? GLASS : GLASS_DIM;
    for (var i = 0; i < d.length; i += 4) {
      d[i] = glass[0];
      d[i + 1] = glass[1];
      d[i + 2] = glass[2];
      d[i + 3] = 255;
    }
    octx.putImageData(imgData, 0, 0);
    haveFrame = true;
  }

  function draw() {
    c2.fillStyle = "#0b0d08";
    c2.fillRect(0, 0, W, H);
    c2.imageSmoothingEnabled = false;
    c2.drawImage(off, offX, offY, PANEL_W * scale, PANEL_H * scale);

    // Bingkai tipis tepi panel (biar batas kaca terlihat).
    c2.strokeStyle = "rgba(0,0,0,0.6)";
    c2.lineWidth = 1;
    c2.strokeRect(offX - 0.5, offY - 0.5, PANEL_W * scale + 1, PANEL_H * scale + 1);

    if (!state.displayOn) {
      c2.fillStyle = "rgba(0,0,0,0.55)";
      c2.fillRect(offX, offY, PANEL_W * scale, PANEL_H * scale);
      c2.fillStyle = "#ffd54f";
      c2.font = "bold 12px monospace";
      c2.textAlign = "center";
      c2.textBaseline = "middle";
      c2.fillText(
        "DISPLAY OFF",
        offX + (PANEL_W * scale) / 2,
        offY + (PANEL_H * scale) / 2,
      );
      c2.textAlign = "start";
    }

    if (!state.backlight) {
      c2.fillStyle = "#8d9a76";
      c2.font = "10px monospace";
      c2.textBaseline = "top";
      c2.fillText("⌁ backlight off", offX + 4, offY + 4);
    }
  }

  layout();
  clearPanel();
  draw();
  ctx.send({ event: "ready", panelW: PANEL_W, panelH: PANEL_H, scale: scale });

  ctx.onMessage = function (msg) {
    if (!msg) return;
    if (msg.t === "frame") {
      state.invert = !!msg.invert;
      state.displayOn = msg.displayOn !== false;
      state.backlight = msg.backlight !== false;
      decode(msg.fb);
      draw();
    } else if (msg.t === "reset") {
      state.invert = false;
      state.displayOn = true;
      state.backlight = true;
      clearPanel();
      draw();
    }
  };

  ctx.onResize = function (w, h) {
    W = w;
    H = h;
    layout();
    if (!haveFrame) clearPanel();
    draw();
  };

  ctx.onDestroy = function () {
    haveFrame = false;
  };
});
