/**
 * hello.js — DDC NJ: Hello World (canvas MURNI, TANPA Fabric/external lib)
 *
 * Teks "Hello, TSIX!" bergeser dari kiri ke kanan, lalu balik ke kiri,
 * terus menerus (bounce). Jalan 100% di browser — zero WebSocket per-frame.
 */
DDC.onInit(function (ctx) {
  document.querySelector('[data-tsix-id="path-display"]').textContent = "hahahaha";
  var W = ctx.width;
  var H = ctx.height;
  var c2 = ctx.canvas.getContext("2d");
  var text = "Hello, TSIX!";
  var x = 0;
  var speed = 2;

  function frame() {
    c2.clearRect(0, 0, W, H);

    c2.font = "bold 28px monospace";
    c2.textBaseline = "middle";
    var tw = c2.measureText(text).width;

    x += speed;
    if (x + tw > W) {
      x = W - tw;
      speed = -speed; // kena kanan → balik ke kiri
    }
    if (x < 0) {
      x = 0;
      speed = -speed; // kena kiri → balik ke kanan
    }

    c2.fillStyle = "#4caf50";
    c2.fillText(text, x, H / 2);

    ctx.raf(frame);
  }

  ctx.onResize = function (w, h) {
    W = w;
    H = h;
  };

  ctx.send({ event: "ready", data: { width: W, height: H } });
  ctx.raf(frame);
});
