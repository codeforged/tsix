if (typeof module === 'undefined') {
  var module = { exports: {} };
  var exports = module.exports;
} 

DDC.onInit(function (ctx) {
  var W = ctx.width;
  var H = ctx.height;

  // VARIABEL PARAMETER TUNING REAL-TIME (KONTROL SLIDER CASHEW)
  var physicsMassMultiplier = 1.0;   // Dikendalikan oleh Mass Slider
  var timeSpeedMultiplier = 1.0;      // Dikendalikan oleh Speed Slider
  var MAX_PARTICLE_COUNT = 2000;    // Alokasikan batas maksimum memori buffer sejak awal
  var activeParticles = 400;        // Jumlah partikel aktif default awal dari Slider ke-3

  function startThreeSimulation() {
    var renderer = new THREE.WebGLRenderer({
      canvas: ctx.canvas,
      antialias: true,
      alpha: true,
    });
    renderer.setPixelRatio(ctx.dpr || 1);
    renderer.setSize(W, H);
    renderer.setClearColor(0x000000, 0);

    var scene = new THREE.Scene();
    
    var camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 100);
    var cameraRadius = 5;
    var cameraTheta = 0;
    var cameraPhi = Math.PI / 4;
    
    function updateCameraPosition() {
      camera.position.x = cameraRadius * Math.sin(cameraPhi) * Math.sin(cameraTheta);
      camera.position.y = cameraRadius * Math.cos(cameraPhi);
      camera.position.z = cameraRadius * Math.sin(cameraPhi) * Math.cos(cameraTheta);
      camera.lookAt(0, -0.5, 0);
    }
    updateCameraPosition();

    // Buat mesh visual lubang hitam
    var bhGeometry = new THREE.SphereGeometry(0.2, 16, 16);
    var bhMaterial = new THREE.MeshBasicMaterial({ color: 0x050505 });
    var blackHoleMesh = new THREE.Mesh(bhGeometry, bhMaterial);
    scene.add(blackHoleMesh);

    // Setup Sistem Partikel Menggunakan Batas Alokasi Maksimal
    var geometry = new THREE.BufferGeometry();
    var positions = new Float32Array(MAX_PARTICLE_COUNT * 3);
    var colors = new Float32Array(MAX_PARTICLE_COUNT * 3);

    var pData = [];
    var colorObj = new THREE.Color();

    for (var i = 0; i < MAX_PARTICLE_COUNT; i++) {
      var angle = Math.random() * Math.PI * 2;
      var radius = 0.6 + Math.random() * 2.2;
      
      positions[i * 3] = Math.cos(angle) * radius;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = Math.sin(angle) * radius;

      // Pewarnaan gradasi disk kosmik awal
      if (radius < 1.2) {
        colorObj.setHex(0xffaa44); // Orange inti piringan akresi
      } else {
        colorObj.setHex(0x00e5ff); // Neon Cyan luar angkasa dingin
      }
      colors[i * 3] = colorObj.r;
      colors[i * 3 + 1] = colorObj.g;
      colors[i * 3 + 2] = colorObj.b;

      pData.push({
        radius: radius,
        angle: angle,
        baseSpeed: (0.015 + Math.random() * 0.02) * (1.5 / radius),
      });
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    var pMaterial = new THREE.PointsMaterial({
      size: 0.04,
      vertexColors: true,
      transparent: true,
      opacity: 0.85
    });

    var particleSystem = new THREE.Points(geometry, pMaterial);
    scene.add(particleSystem);

    // --- INTERAKSI DRAG KAMERA ---
    var dragging = false;
    var lastX = 0; var lastY = 0;

    ctx.canvas.addEventListener("pointerdown", function (e) {
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      try { ctx.canvas.setPointerCapture(e.pointerId); } catch (_) {}
    });

    ctx.canvas.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var dx = e.clientX - lastX; var dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      cameraTheta -= dx * 0.007;
      cameraPhi   -= dy * 0.007;
      cameraPhi = Math.max(0.1, Math.min(Math.PI / 2 - 0.05, cameraPhi));
      updateCameraPosition();
    });

    ctx.canvas.addEventListener("pointerup", function () { dragging = false; });
    ctx.canvas.addEventListener("pointercancel", function () { dragging = false; });

    // ================================================================
    // RECEIVE MESSAGES FROM CASHEW (TGA -> NJ BRIDGE)
    // ================================================================
    ctx.onMessage = function (msg) {
      if (msg.cmd === "update_mass") {
        physicsMassMultiplier = msg.value / 100;
        blackHoleMesh.scale.set(physicsMassMultiplier, physicsMassMultiplier, physicsMassMultiplier);
      } else if (msg.cmd === "update_speed") {
        timeSpeedMultiplier = msg.value;
      } else if (msg.cmd === "update_particles") {
        // Parsing nilai input dari slider partikel baru buatan om
        var requestedCount = msg.value*20;
        // Proteksi batas alokasi agar tidak memicu memory out-of-bounds crash
        activeParticles = Math.max(0, Math.min(MAX_PARTICLE_COUNT, requestedCount));        
      }
    };

    // --- LOOP ENGINE ANIMASI 3D ---
    function frame() {
      var positionsAttr = particleSystem.geometry.attributes.position.array;

      for (var i = 0; i < MAX_PARTICLE_COUNT; i++) {
        
        // JIKA INDEKS PARTIKEL DI LUAR KUOTA AKTIF -> SEMBUNYIKAN KE KOORDINAT GAIB
        if (i >= activeParticles) {
          positionsAttr[i * 3] = 0;       // X
          positionsAttr[i * 3 + 1] = -999;  // Y (Sembunyikan jauh ke bawah area rendering)
          positionsAttr[i * 3 + 2] = 0;       // Z
          continue;
        }

        // JIKA AMBANG KUOTA AMAN -> Jalankan simulasi orbit relativitas
        var data = pData[i];
        
        // Kecepatan putar dipengaruhi multiplier fasa waktu
        data.angle += data.baseSpeed * timeSpeedMultiplier;
        
        // Kecepatan spiral tersedot dipengaruhi oleh fasa kekuatan massa gravitasi
        data.radius -= 0.002 * physicsMassMultiplier * timeSpeedMultiplier;
        
        // Kedalaman corong amblas (sumbu Y negatif) mengikuti distorsi massa
        var targetY = -0.15 * physicsMassMultiplier / (data.radius * data.radius);
        
        // Respawn balik ke tepi cakrawala luar jika sudah tertelan batas horizon lubang hitam
        if (data.radius <= (0.25 * physicsMassMultiplier)) {
          data.radius = 2.2 + Math.random() * 0.6;
          data.angle = Math.random() * Math.PI * 2;
          targetY = 0;
        }

        // Petakan ulang ke data koordinat memori vertex WebGL
        positionsAttr[i * 3] = Math.cos(data.angle) * data.radius;     // X
        positionsAttr[i * 3 + 1] = targetY;                            // Y
        positionsAttr[i * 3 + 2] = Math.sin(data.angle) * data.radius; // Z
      }

      // Beritahu Three.js kalau array koordinat posisi telah dimodifikasi
      particleSystem.geometry.attributes.position.needsUpdate = true;
      blackHoleMesh.rotation.y += 0.02 * timeSpeedMultiplier;

      renderer.render(scene, camera);
      ctx.raf(frame);
    }

    ctx.onResize = function (w, h) {
      W = w; H = h;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };

    ctx.onDestroy = function () {
      renderer.dispose();
    };

    ctx.send({ event: "ready", data: { width: W, height: H, count: activeParticles } });
    ctx.raf(frame);
  }

  var tries = 0;
  var waiter = setInterval(function () {
    tries++;
    if (typeof THREE !== "undefined" || tries > 100) {
      clearInterval(waiter);
      try {
        startThreeSimulation();
      } catch (e) {
        console.error("[blackhole3d] init error:", e);
      }
    }
  }, 200);
});
