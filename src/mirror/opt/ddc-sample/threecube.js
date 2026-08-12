/**
 * threecube.js — DDC NJ: Wireframe Cube dengan Three.js
 *
 * Cube frame berputar bebas (rotasi x/y/z) di posisi tetap, di-render via
 * Three.js (global THREE — di-load CDN di dome-client.html).
 * Zero WebSocket per-frame; render loop murni di browser.
 *
 * DRAG: geser di panel stage → rotasi manual mengikuti arah drag.
 *   • horizontal → rotasi horizontal (sumbu Y)
 *   • vertical   → rotasi vertical (sumbu X)
 * Auto-rotate jeda selama/beberapa saat setelah drag.
 */
DDC.onInit(function (ctx) {
  var W = ctx.width;
  var H = ctx.height;

  function startThree() {
    var renderer = new THREE.WebGLRenderer({
      canvas: ctx.canvas,
      antialias: true,
      alpha: true, // background transparan → warna stage tetap keliatan
    });
    renderer.setPixelRatio(ctx.dpr || 1);
    renderer.setSize(W, H);
    renderer.setClearColor(0x000000, 0);

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 100);
    camera.position.set(0, 0, 3); // posisi tetap
    camera.lookAt(0, 0, 0);

    // Cube frame (wireframe)
    var cube = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 1.4, 1.4),
      new THREE.MeshBasicMaterial({ color: 0x4caf50, wireframe: true }),
    );
    scene.add(cube);

    // --- DRAG: rotasi manual mengikuti arah drag ---
    // horizontal drag → rotasi sumbu Y | vertical drag → rotasi sumbu X
    var dragging = false;
    var lastX = 0;
    var lastY = 0;
    var lastDragAt = 0;

    ctx.canvas.addEventListener("pointerdown", function (e) {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      // Capture biar drag tetap jalan walau kursor keluar canvas
      try {
        ctx.canvas.setPointerCapture(e.pointerId);
      } catch (_) {}
    });
    ctx.canvas.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var dx = e.clientX - lastX;
      var dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      cube.rotation.y += dx * 0.01; // horizontal
      cube.rotation.x += dy * 0.01; // vertical
      lastDragAt = Date.now();
    });
    ctx.canvas.addEventListener("pointerup", function () {
      dragging = false;
    });
    ctx.canvas.addEventListener("pointercancel", function () {
      dragging = false;
    });

    // Animasi — RAF di browser. Auto-rotate jalan kalau tidak sedang
    // di-drag (dengan grace period 300ms setelah drag terakhir).
    function frame() {
      var auto = !dragging && Date.now() - lastDragAt > 300;
      if (auto) {
        cube.rotation.x += 0.008;
        cube.rotation.y += 0.012;
        cube.rotation.z += 0.006;
      }
      renderer.render(scene, camera);
      ctx.raf(frame);
    }

    ctx.onResize = function (w, h) {
      W = w;
      H = h;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };

    ctx.onDestroy = function () {
      renderer.dispose();
    };

    ctx.send({ event: "ready", data: { width: W, height: H } });
    ctx.raf(frame);
  }

  // Tunggu THREE tersedia (CDN bisa telat; max ~20 detik)
  var tries = 0;
  var waiter = setInterval(function () {
    tries++;
    if (typeof THREE !== "undefined" || tries > 100) {
      clearInterval(waiter);
      try {
        startThree();
      } catch (e) {
        console.error("[threecube] init error:", e);
      }
    }
  }, 200);
});
