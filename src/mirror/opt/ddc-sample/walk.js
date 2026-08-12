/**
 * DDC Sample 5 — 3D Walk (Three.js)
 *
 * NJ (Native JS) — jalan 100% di browser.
 * - Humanoid kotak-kotak prosedural (tanpa external model).
 * - Gerak RELATIF thd arah hadap: W maju / S mundur / D geser kanan / A geser kiri.
 * - MOUSE menentukan arah/vektor si walker — halus 360° (bukan 8 arah mata angin).
 *   Cukup gerakkan mouse di atas area, tanpa perlu klik.
 * - Suara langkah kaki: tiap STEP_INTERVAL detik kirim event "step" ke TGA,
 *   TGA memutar footstep.wav dari cache ResourceBank (PLAY_SOUND by name).
 * - Peta (bangunan kotak + posisi player) dari ResourceBank "LEVEL" (level.json).
 *
 * Resource (dari TGA via ctx.resBank):
 *   resBank.getResource("LEVEL") → level.json (object)
 *   resBank.ready("LEVEL")       → promise, resolve saat peta siap
 *   event "sound"/"step"         → footstep.wav (diputar TGA)
 *
 * Kontrak NJ: DDC.onInit(function (ctx) { ... }).
 */
DDC.onInit(function (ctx) {
  "use strict";
  var scene, camera, renderer;
  var keys = {};
  var person, body, legsL, legsR, armsL, armsR;
  var pos = { x: 0, z: 8 };
  var heading = 0; // arah hadap (dikontrol mouse)
  var targetHeading = 0;
  // MODE KAMERA: 1 = FPV (ruang yang bergerak, kamera di posisi mata player),
  //               2 = third-person (walker yang bergerak, kamera 3/4)
  var VIEW_MODE = 2;
  var MOUSE_SENS = 0.005; // sensitivitas rotasi heading (mode FPV)
  var pitch = 0; // lihat atas/bawah (mode FPV)
  var PITCH_LIMIT = 1.2; // batas pitch ± rad (≈±69°)
  var lastClientX = 0; // delta fallback (mode FPV, tanpa pointer lock)
  var lastClientY = 0;
  var lastMouseT = 0; // waktu gerakan mouse terakhir (deteksi mouse idle)
  var pointerLock = false; // pointer lock aktif (best-effort, mode FPV)
  var steering = false; // kontrol game aktif (FPV: yaw nyala). Klik→true, ESC→false
  var mouseValid = false;
  var mouseWorld = null;
  var raycaster = null;
  var groundPlane = null;
  var ndc = null;
  var walkPhase = 0;
  var stepAcc = 0;
  var STEP_INTERVAL = 0.65; // detik per langkah
  var SPEED = 4; // unit/detik
  var lastT = 0;

  function buildPerson() {
    person = new THREE.Group();
    // Torso
    body = new THREE.Mesh(
      new THREE.BoxGeometry(0.7, 1.0, 0.4),
      new THREE.MeshLambertMaterial({ color: 0x2980b9 })
    );
    body.position.y = 1.3;
    person.add(body);
    // Kepala
    var head = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.4, 0.4),
      new THREE.MeshLambertMaterial({ color: 0xf5cba7 })
    );
    head.position.y = 2.0;
    person.add(head);
    // Lengan (pivot di bahu)
    armsL = new THREE.Group();
    armsL.position.set(-0.45, 1.6, 0);
    armsR = new THREE.Group();
    armsR.position.set(0.45, 1.6, 0);
    var armMat = new THREE.MeshLambertMaterial({ color: 0xe74c3c });
    var armL = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.8, 0.18), armMat);
    armL.position.y = -0.4;
    armsL.add(armL);
    var armR = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.8, 0.18), armMat);
    armR.position.y = -0.4;
    armsR.add(armR);
    person.add(armsL);
    person.add(armsR);
    // Kaki (pivot di pinggul)
    var legMat = new THREE.MeshLambertMaterial({ color: 0x2c3e50 });
    legsL = new THREE.Group();
    legsL.position.set(-0.18, 0.8, 0);
    legsR = new THREE.Group();
    legsR.position.set(0.18, 0.8, 0);
    var legL = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.8, 0.22), legMat);
    legL.position.y = -0.4;
    legsL.add(legL);
    var legR = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.8, 0.22), legMat);
    legR.position.y = -0.4;
    legsR.add(legR);
    person.add(legsL);
    person.add(legsR);

    person.position.set(pos.x, 0, pos.z);
    scene.add(person);
  }

  // Terapkan peta dari ResourceBank "LEVEL" (dipanggil saat resource siap)
  function applyLevel() {
    if (!ctx.resBank) return;
    var level = ctx.resBank.getResource("LEVEL");
    if (!level) return;
    var buildings = level.buildings || [];
    buildings.forEach(function (b) {
      var m = new THREE.Mesh(
        new THREE.BoxGeometry(b.w, b.h, b.d),
        new THREE.MeshLambertMaterial({
          color: parseInt(String(b.color).slice(1), 16),
        })
      );
      m.position.set(b.x, b.h / 2, b.z);
      scene.add(m);
    });
    if (level.player) {
      pos.x = level.player.x || 0;
      pos.z = level.player.z || 8;
      person.position.set(pos.x, 0, pos.z);
    }
  }

  function buildWorld() {
    // Ground
    var ground = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.MeshLambertMaterial({ color: 0x3a5a3a })
    );
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
    // Jalan
    var path = new THREE.Mesh(
      new THREE.PlaneGeometry(4, 40),
      new THREE.MeshLambertMaterial({ color: 0x8a7a5a })
    );
    path.rotation.x = -Math.PI / 2;
    path.position.y = 0.01;
    scene.add(path);

    // Bangunan dari ResourceBank (tunggu ready biar tidak kosong)
    if (ctx.resBank && typeof ctx.resBank.ready === "function") {
      ctx.resBank.ready("LEVEL").then(applyLevel);
    } else {
      applyLevel();
    }
  }

  // --- Mouse → arah hadap ---
  // Mode 2 (third-person): kursor VISIBLE, arah absolut dari titik tanah di
  //   bawah kursor (raycast). Cukup hover di area.
  // Mode 1 (FPV): kursor HIDDEN, gerakan mouse = rotasi heading (yaw relatif)
  //   pakai movementX (atau delta clientX). Best-effort pointer lock di
  //   document.body biar bisa muter terus tanpa mentok tepi window.
  function applyCursor() {
    // Kursor hidden HANYA saat FPV + kontrol aktif (locked). Saat ESC/unlock,
    // kursor kembali visible — yaw juga disable sampai klik lagi (commit).
    if (VIEW_MODE === 1 && steering) {
      ctx.canvas.style.cursor = "none";
    } else {
      ctx.canvas.style.cursor = "";
      if (pointerLock && document.exitPointerLock) {
        try { document.exitPointerLock(); } catch (_) {}
      }
    }
  }

  function setupMouse() {
    raycaster = new THREE.Raycaster();
    groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    ndc = new THREE.Vector2();
    mouseWorld = new THREE.Vector3();
    var worldPoint = new THREE.Vector3();

    // Mode 2: raycast absolut (arah dari titik tanah di bawah kursor)
    function onRaycast(e) {
      if (VIEW_MODE !== 2) return;
      if (!ctx.canvas) return;
      var rect = ctx.canvas.getBoundingClientRect();
      var mx = e.clientX - rect.left;
      var my = e.clientY - rect.top;
      var w = ctx.width || rect.width;
      var h = ctx.height || rect.height;
      ndc.x = (mx / w) * 2 - 1;
      ndc.y = -(my / h) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      if (raycaster.ray.intersectPlane(groundPlane, worldPoint)) {
        mouseWorld.copy(worldPoint);
        mouseValid = true;
        lastMouseT = ctx.now(); // tandai gerakan mouse terakhir
      }
    }
    ctx.canvas.addEventListener("pointermove", onRaycast);
    ctx.canvas.addEventListener("pointerdown", onRaycast);

    // Mode 1 (FPV): delta gerakan mouse → rotasi heading (yaw) + pitch (atas/bawah).
    // Hanya aktif saat steering (control game) — klik untuk commit, ESC untuk lepas.
    function onSteer(e) {
      if (VIEW_MODE !== 1 || !steering) return;
      var dx = e.movementX || (e.clientX - lastClientX);
      var dy = e.movementY || (e.clientY - lastClientY);
      lastClientX = e.clientX;
      lastClientY = e.clientY;
      targetHeading -= (dx || 0) * MOUSE_SENS;
      // mouse ke atas (dy negatif) → lihat ke atas (pitch naik)
      pitch += (dy || 0) * -MOUSE_SENS;
      pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
      lastMouseT = ctx.now(); // tandai gerakan mouse terakhir
    }
    document.addEventListener("mousemove", onSteer);
    ctx.canvas.addEventListener("mousemove", onSteer);

    // FPV: klik body window → COMMIT masuk control game (steering on),
    // hide kursor, lalu coba pointer lock (muter tanpa batas).
    ctx.canvas.addEventListener("mousedown", function (e) {
      if (VIEW_MODE !== 1) return;
      lastClientX = e.clientX;
      steering = true;
      applyCursor();
      if (!pointerLock && document.body && document.body.requestPointerLock) {
        var p = document.body.requestPointerLock();
        if (p && typeof p.catch === "function") p.catch(function () {});
      }
    });

    document.addEventListener("pointerlockchange", function () {
      pointerLock = document.pointerLockElement != null;
      // FPV: steering ikut status lock. ESC (unlock) → yaw mati + kursor visible.
      if (VIEW_MODE === 1) {
        steering = pointerLock;
        applyCursor();
      }
    });
    document.addEventListener("pointerlockerror", function () {
      // pointer lock ditolak — steering tetap on (fallback CSS-hide + delta)
      if (VIEW_MODE === 1) {
        steering = true;
        applyCursor();
      }
    });

    // ESC manual (fallback saat pointer lock tidak aktif): lepas control game
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && VIEW_MODE === 1 && steering) {
        steering = false;
        applyCursor();
        if (pointerLock && document.exitPointerLock) {
          try { document.exitPointerLock(); } catch (_) {}
        }
      }
    });
  }

  function update(dt) {
    // Arah hadap tergantung mode:
    //   FPV (1): heading di-update delta mouse (onSteer) → lerp halus.
    //   third-person (2): heading absolut dari titik tanah di bawah kursor.
    // Kalau mouse sudah diam >120ms, jangan lanjut muter sama sekali — heading
    // dibekukan di posisi terakhir (tidak lerp, tidak snap) = berhenti total.
    var mouseIdle = ctx.now() - lastMouseT > 30;
    if (VIEW_MODE === 1) {
      if (!mouseIdle) {
        var d1 = targetHeading - heading;
        d1 =
          ((((d1 + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) -
          Math.PI;
        heading += d1 * Math.min(1, dt * 12);
        person.rotation.y = heading;
      }
    } else if (mouseValid && !mouseIdle) {
      targetHeading = Math.atan2(
        mouseWorld.x - pos.x,
        mouseWorld.z - pos.z
      );
      var d2 = targetHeading - heading;
      d2 =
        ((((d2 + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) -
        Math.PI;
      heading += d2 * Math.min(1, dt * 10);
      person.rotation.y = heading;
    }

    // Input RELATIF thd arah hadap: W maju, S mundur, D geser kanan, A geser kiri
    var fx = Math.sin(heading); // vektor maju
    var fz = Math.cos(heading);
    var rx = -Math.cos(heading); // vektor kanan (strafe)
    var rz = Math.sin(heading);

    var mx = 0,
      mz = 0;
    if (keys["KeyW"]) {
      mx += fx;
      mz += fz;
    }
    if (keys["KeyS"]) {
      mx -= fx;
      mz -= fz;
    }
    if (keys["KeyD"]) {
      mx += rx;
      mz += rz;
    }
    if (keys["KeyA"]) {
      mx -= rx;
      mz -= rz;
    }

    var moving = mx !== 0 || mz !== 0;

    if (moving) {
      var len = Math.sqrt(mx * mx + mz * mz);
      mx /= len;
      mz /= len;
      pos.x += mx * SPEED * dt;
      pos.z += mz * SPEED * dt;
      // Clamp ke dalam peta (ground 60x60)
      pos.x = Math.max(-28, Math.min(28, pos.x));
      pos.z = Math.max(-28, Math.min(28, pos.z));

      walkPhase += dt * 7;
      // Suara langkah kaki (tiap STEP_INTERVAL detik saat bergerak)
      stepAcc += dt;
      if (stepAcc >= STEP_INTERVAL) {
        stepAcc = 0;
        ctx.send({ event: "sound", data: "step" });
      }
    } else {
      walkPhase = 0; // stance netral
      stepAcc = 0;
    }

    // Terapkan ayunan kaki & lengan
    var s = Math.sin(walkPhase);
    legsL.rotation.x = s * 0.6;
    legsR.rotation.x = -s * 0.6;
    armsL.rotation.x = -s * 0.5;
    armsR.rotation.x = s * 0.5;
    // Body sedikit naik-turun saat melangkah
    body.position.y = 1.3 + Math.abs(Math.sin(walkPhase)) * 0.06;

    person.position.set(pos.x, 0, pos.z);

    // --- MODE KAMERA ---
    if (VIEW_MODE === 1) {
      // MODE 1: FPV — ruang yang bergerak. Walker disembunyikan, kamera di
      // posisi mata player (y≈1.6) melihat searah heading (yaw) + pitch
      // (atas/bawah, dikontrol mouse). FOV lebih lebar biar imersif.
      person.visible = false;
      if (camera.fov !== 75) {
        camera.fov = 75;
        camera.updateProjectionMatrix();
      }
      var cp = Math.cos(pitch);
      camera.position.set(pos.x, 1.6, pos.z);
      camera.lookAt(
        pos.x + Math.sin(heading) * cp * 10,
        1.6 + Math.sin(pitch) * 10,
        pos.z + Math.cos(heading) * cp * 10
      );
    } else {
      // MODE 2: third-person — walker yang bergerak, kamera fixed 3/4.
      person.visible = true;
      person.rotation.y = heading;
      if (camera.fov !== 60) {
        camera.fov = 60;
        camera.updateProjectionMatrix();
      }
      camera.position.set(pos.x + 12, 14, pos.z + 12);
      camera.lookAt(pos.x, 1, pos.z);
    }
  }

  function frame() {
    var now = ctx.now();
    var dt = lastT ? Math.min(0.05, (now - lastT) / 1000) : 0.016;
    lastT = now;
    update(dt);
    renderer.render(scene, camera);
    ctx.raf(frame);
  }

  // ---- Init ----
  var W = ctx.width,
    H = ctx.height;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);

  camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 500);
  camera.position.set(12, 14, 12);
  camera.lookAt(0, 1, 0);

  renderer = new THREE.WebGLRenderer({ canvas: ctx.canvas, antialias: true });
  renderer.setSize(W, H, false);
  renderer.setPixelRatio(ctx.dpr || 1);

  // Lighting
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  var dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(10, 20, 10);
  scene.add(dir);

  buildPerson();
  buildWorld();
  setupMouse();
  applyCursor();

  // Keyboard: track tombol ditahan (down/up) + toggle mode kamera (V)
  ctx.onKey = function (ev) {
    if (ev.down) keys[ev.code] = true;
    else delete keys[ev.code];

    // V → toggle mode kamera (1 = FPV <-> 2 = third-person), abaikan auto-repeat
    if (ev.code === "KeyV" && ev.down && !ev.repeat) {
      VIEW_MODE = VIEW_MODE === 1 ? 2 : 1;
      person.visible = VIEW_MODE !== 1;
      steering = false; // reset control — butuh klik lagi untuk commit di FPV
      pitch = 0; // pandangan kembali lurus saat masuk FPV
      applyCursor();
    }
  };

  // Resize: sesuaikan kamera + renderer saat window di-resize
  ctx.onResize = function (w, h) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  };

  lastT = ctx.now();
  ctx.raf(frame);
  ctx.send({ event: "ready", data: { width: W, height: H } });
});
