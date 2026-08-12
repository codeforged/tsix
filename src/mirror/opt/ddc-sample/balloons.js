/**
 * balloons.js — DDC Native JavaScript (NJ) sample: BALLOON POP
 *
 * Game mini, jalan 100% di browser (zero WebSocket per-frame):
 * - Balon 10-20px warna-warni muncul dari atas-tengah, turun pelan
 *   dengan sudut acak.
 * - Segitiga (player) di bawah dikendalikan panah kiri/kanan.
 * - Spasi = tembak peluru ke atas (vertikal).
 * - Peluru kena balon → balon pecah (explosion partikel sederhana).
 * - Pecah balon = +10 score; balon lolos ke bawah ("bumi") = -5.
 * - Balon kena player → -1 nyawa (5 nyawa); habis → Game Over + High Score.
 * - Score di kanan atas, nyawa (♥) di kiri atas.
 * - High score di-persist oleh TGA ke /opt/ddc-sample/highscore.txt
 *   (contoh baca/tulis file lewat DDCApp messaging).
 *
 * Keyboard di-handle LANGSUNG di browser via ctx.onKey (reaksi cepat),
 * tetap juga di-forward ke TGA lewat mekanisme PixelSpace.
 */
DDC.onInit(function (ctx) {
  var W = ctx.width;
  var H = ctx.height;
  console.log("[balloons] onInit", W, H, "fabric:", !!ctx.fabric);

  var canvas = new ctx.fabric.Canvas(ctx.canvas, {
    selection: false,
    preserveObjectStacking: true,
  });

  var balloons = [];
  var bullets = [];
  var explosions = [];
  var player = null;
  var score = 0;
  var lives = 5; // nyawa awal
  var highScore = 0;
  var gameOver = false;
  var running = true;
  var lastSpawn = Date.now();
  var keys = { left: false, right: false, up: false, down: false };
  // Batas atas player = 30% tinggi layar → pesawat hanya bebas di 70% bawah
  var PLAYER_MAX_TOP_RATIO = 0.3;
  // Joystick: edge-detection tombol fire (B16) supaya sekali tekan = 1 tembakan
  var joyFireDown = false;

  // Enemy kotak agresif: selalu mengejar player, muncul sesekali tiap 30 detik
  // dengan probabilitas 0.7. Bisa ditembak (+15), kena player = -1 nyawa.
  var enemies = [];
  var lastEnemySpawn = Date.now();
  var ENEMY_INTERVAL_MS = 2000; // coba spawn tiap 20 detik
  var ENEMY_SPAWN_PROB = .7; // 100% chance muncul per window

  var colors = [
    "#ff5252", "#ffb300", "#4caf50", "#2196f3",
    "#e040fb", "#ff7043", "#00e5ff", "#c6ff00",
  ];

  // ── Bintang background: warna-warni, scroll dari atas ke bawah, blink ──
  var stars = [];
  var STAR_COUNT = 30;
  function initStars() {
    stars = [];
    for (var i = 0; i < STAR_COUNT; i++) {
      stars.push({
        x: Math.random() * W,
        y: Math.random() * H,
        size: 1 + Math.random() * 3, // 1-4px
        speed: 0.4 + Math.random() * 1.4, // kecepatan scroll
        color: colors[(Math.random() * colors.length) | 0],
        phase: Math.random() * Math.PI * 2, // fase blink acak
        blinkSpeed: 0.04 + Math.random() * 0.08, // kecepatan blink
      });
    }
  }
  // Geser bintang ke bawah; keluar layar → respawn di atas (posisi acak baru)
  function updateStars() {
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      s.y += s.speed;
      s.phase += s.blinkSpeed;
      if (s.y > H + 4) {
        s.y = -4;
        s.x = Math.random() * W;
        s.speed = 0.4 + Math.random() * 1.4;
      }
    }
  }
  // Gambar bintang dengan blink (alpha berdenyut via sin(phase))
  function drawStars() {
    var c2 = ctx.canvas.getContext("2d");
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      var a = 0.3 + 0.7 * Math.abs(Math.sin(s.phase)); // 0.3..1.0
      c2.globalAlpha = a;
      c2.fillStyle = s.color;
      c2.fillRect(s.x, s.y, s.size, s.size);
    }
    c2.globalAlpha = 1;
  }

  // Gelapkan warna hex (ratio 0-1) — buat stroke balon yang lebih gelap
  function darken(hex, ratio) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    r = Math.max(0, Math.round(r * ratio));
    g = Math.max(0, Math.round(g * ratio));
    b = Math.max(0, Math.round(b * ratio));
    return "rgb(" + r + "," + g + "," + b + ")";
  }

  // --- Player: gambar spaceship via ResourceBank (objek PLAIN + manual 2D).
  //     Fabric tidak dirender baik di environment ini, jadi player digambar
  //     manual via drawImage() dari ctx.resBank.getResource("spaceship"). ---
  function createPlayer() {
    var w = 48;
    var h = 54;
    player = {
      left: W / 2 - w / 2,
      top: H - h - 12,
      width: w,
      height: h,
      img: null,
    };
    // Ambil gambar dari ResourceBank (sudah dikirim TGA via RES_LOAD).
    // Kalau belum siap, gambar fallback segitiga sementara sampai onload.
    if (ctx.resBank && typeof ctx.resBank.ready === "function") {
      ctx.resBank
        .ready("spaceship")
        .then(function () {
          var im =
            ctx.resBank && ctx.resBank.getResource("spaceship");
          if (im && player) player.img = im;
        })
        .catch(function () { });
    } else if (ctx.resBank && ctx.resBank.getResource) {
      var im0 = ctx.resBank.getResource("spaceship");
      if (im0 && player) player.img = im0;
    }
  }

  // --- Gambar player manual via 2D: gambar spaceship jika sudah siap,
  //     fallback segitiga putih selama gambar belum load. ---
  function drawPlayer() {
    var c2 = ctx.canvas.getContext("2d");
    if (!player) return;
    var im = player.img;
    if (im && im.complete && im.naturalWidth > 0) {
      // Gambar sesuai ukuran player (preserve aspect tidak wajib — kita
      // kasih ukuran tetap biar hitbox konsisten dengan logika game).
      c2.drawImage(im, player.left, player.top, player.width, player.height);
    } else {
      // Fallback segitiga (kondisi gambar belum siap/gagal)
      c2.beginPath();
      c2.moveTo(player.left + player.width / 2, player.top);
      c2.lineTo(player.left, player.top + player.height);
      c2.lineTo(player.left + player.width, player.top + player.height);
      c2.closePath();
      c2.fillStyle = "#4caf50";
      c2.fill();
    }
  }

  // --- Deteksi balon kena player (segitiga di bawah).
  //     Jarak pusat balon ke kotak pembatas player yang di-inflate radius balon. ---
  function hitPlayer(b) {
    if (!player) return false;
    var px = player.left,
      py = player.top,
      pw = player.width,
      ph = player.height;
    var cx = Math.max(px, Math.min(b.x, px + pw));
    var cy = Math.max(py, Math.min(b.y, py + ph));
    var dx = b.x - cx;
    var dy = b.y - cy;
    return dx * dx + dy * dy < b.r * b.r;
  }

  // --- Spawn balon dari atas-tengah (objek PLAIN, digambar manual via 2D).
  //     Fabric Circle tidak render dengan baik di environment ini,
  //     jadi balon digambar raw 2D — dijamin keliatan & warna-warni. ---
  function spawnBalloon() {
    var r = 5 + Math.random() * 5; // 5-10px
    var x = W / 2 + (Math.random() - 0.5) * 140; // dekat tengah
    balloons.push({
      x: x,
      y: -r * 2 - 5, // di atas layar
      r: r,
      vx: (Math.random() - 0.5) * 0.7, // sudut acak kecil
      vy: 0.6 + Math.random() * 0.9, // turun pelan
      color: colors[(Math.random() * colors.length) | 0],
    });
  }

  // --- Tabrakan dua kotak (axis-aligned) — dipakai enemy vs player.
  //     player = objek fabric (left/top/width/height),
  //     enemy  = objek PLAIN (x/y/size) — seperti balon. ---
  function rectsOverlap(e, p) {
    var eRight = e.x + e.size;
    var eBottom = e.y + e.size;
    var pRight = p.left + p.width;
    var pBottom = p.top + p.height;
    return (
      e.x < pRight &&
      eRight > p.left &&
      e.y < pBottom &&
      eBottom > p.top
    );
  }

  // --- Spawn enemy: objek PLAIN (x/y/size), digambar manual via 2D.
  //     Fabric Rect tidak dirender baik di environment ini (sama seperti
  //     balon), jadi dipakai data plain + drawEnemies(). ---
  function spawnEnemy() {
    var size = 15 + Math.random() * 10; // 15-25px
    enemies.push({
      x: Math.random() * (W - size),
      y: -size - 5, // di atas layar
      size: size,
      color: "#e91e63",
    });
    ctx.send({ event: "sound", data: "drop" }); // suara kemunculan enemy
  }

  // --- Tembak peluru ke atas (vertikal) ---
  function shoot() {
    if (!player) return;
    var bw = 4,
      bh = 14;

    var u = new ctx.fabric.Rect({
      left: player.left + player.width / 2 - bw / 2 - 15,
      top: player.top - bh,
      width: bw,
      height: bh,
      fill: "#ffd54f",
      selectable: false,
      evented: false,
    });
    u.vy = -10;
    canvas.add(u);
    bullets.push(u);

    var u2 = new ctx.fabric.Rect({
      left: player.left + player.width / 2 - bw / 2,
      top: player.top - bh,
      width: bw,
      height: bh,
      fill: "#ffd54f",
      selectable: false,
      evented: false,
    });
    u2.vy = -10;
    canvas.add(u2);
    bullets.push(u2);

    var u3 = new ctx.fabric.Rect({
      left: player.left + player.width / 2 - bw / 2 + 15,
      top: player.top - bh,
      width: bw,
      height: bh,
      fill: "#ffd54f",
      selectable: false,
      evented: false,
    });
    u3.vy = -10;
    canvas.add(u3);
    bullets.push(u3);

    ctx.send({ event: "sound", data: "laser" }); // suara tembak
  }

  // --- Explosion: partikel kecil bertebaran + fade (objek PLAIN, manual 2D).
  //     Fabric Circle tidak dirender baik di environment ini, jadi sama
  //     seperti balon & enemy — pakai data plain + drawExplosions(). ---
  function explode(b) {
    for (var i = 0; i < 8; i++) {
      var a = (Math.PI * 2 * i) / 8;
      explosions.push({
        x: b.x,
        y: b.y,
        vx: Math.cos(a) * 2.5,
        vy: Math.sin(a) * 2.5,
        r: 2 + Math.random() * 3,
        color: b.color || "#ffffff",
        life: 1,
      });
    }
    ctx.send({ event: "sound", data: "explode" }); // suara ledakan
  }

  // --- Gambar partikel explosion manual via 2D (fade) ---
  function drawExplosions() {
    var c2 = ctx.canvas.getContext("2d");
    for (var i = 0; i < explosions.length; i++) {
      var p = explosions[i];
      c2.beginPath();
      c2.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      c2.globalAlpha = Math.max(0, p.life);
      c2.fillStyle = p.color;
      c2.fill();
    }
    c2.globalAlpha = 1;
  }

  function updateScore() {
    // Rekor baru → kabari TGA supaya di-persist ke file segera
    if (score > highScore) {
      highScore = score;
      ctx.send({ event: "highscore", data: highScore });
    }
    ctx.send({ event: "score", data: score }); // sparse, ke TGA
  }

  // --- Update nyawa; kalau habis → game over ---
  function updateLife() {
    ctx.send({ event: "life", data: lives });
    if (lives <= 0) {
      gameOver = true;
      ctx.send({
        event: "gameover",
        data: { score: score, highScore: highScore },
      });
    }
  }

  // --- Score: digambar manual via 2D context.
  //     (Hindari fabric.Text — ada bug fabric 5.3.1: warning
  //     "'alphabetical' is not a valid enum value of type CanvasTextBaseline"
  //     yang bisa membuat render frame error & mematikan loop game.)
  //     Font: Press Start 2P (pixel retro) — single-weight, tanpa bold.
  function drawScore() {
    var c2 = ctx.canvas.getContext("2d");
    c2.save();
    c2.font = "10px 'Press Start 2P', monospace";
    c2.textBaseline = "top";
    c2.fillStyle = "#ffffff";
    c2.fillText("SCORE: " + score, W - 110, 12);
    c2.restore();
  }

  // --- Nyawa: di kiri atas (♥ penuh / ♡ kosong) ---
  function drawLives() {
    var c2 = ctx.canvas.getContext("2d");
    c2.save();
    c2.font = "10px 'Press Start 2P', monospace";
    c2.textBaseline = "top";
    c2.fillStyle = "#ff5252";
    var hearts = "";
    for (var i = 0; i < lives; i++) hearts += "\u2665 "; // ♥
    for (var i = lives; i < 5; i++) hearts += "\u2661 "; // ♡
    c2.fillText("LIVES: " + hearts, 10, 12);
    c2.restore();
  }

  // --- Game Over: overlay di tengah panel + high score (font pixel) ---
  function drawGameOver() {
    var c2 = ctx.canvas.getContext("2d");
    var cx = W / 2;
    var cy = H / 2;
    c2.save();
    c2.fillStyle = "rgba(0,0,0,0.6)";
    c2.fillRect(0, 0, W, H);
    c2.textAlign = "center";
    c2.textBaseline = "middle";
    c2.font = "28px 'Press Start 2P', monospace";
    c2.fillStyle = "#ff5252";
    c2.fillText("GAME OVER", cx, cy - 24);
    c2.font = "14px 'Press Start 2P', monospace";
    c2.fillStyle = "#ffffff";
    c2.fillText("High Score: " + highScore, cx, cy + 24);
    c2.restore();
  }

  // --- Balon: digambar manual via 2D context (dijamin keliatan).
  //     Bentuk ellipse agak lonjong vertikal (rx < ry) biar mirip balon,
  //     stroke 3px warna lebih gelap dari warna balon. ---
  function drawBalloons() {
    var c2 = ctx.canvas.getContext("2d");
    for (var i = 0; i < balloons.length; i++) {
      var b = balloons[i];
      var rx = b.r;
      var ry = b.r * 1.35; // lonjong vertikal
      c2.beginPath();
      c2.ellipse(b.x, b.y, rx, ry, 0, 0, Math.PI * 2);
      c2.fillStyle = b.color;
      c2.fill();
      c2.lineWidth = 3;
      c2.strokeStyle = darken(b.color, 0.5);
      c2.stroke();
    }
  }

  // --- Enemy: digambar manual via 2D (kotak agresif, jaminan keliatan) ---
  function drawEnemies() {
    var c2 = ctx.canvas.getContext("2d");
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      c2.fillStyle = e.color;
      c2.fillRect(e.x, e.y, e.size, e.size);
      c2.lineWidth = 3;
      c2.strokeStyle = "#ff5252";
      c2.strokeRect(e.x, e.y, e.size, e.size);
    }
  }

  // --- Loop utama (RAF di browser, ZERO WS) ---
  // try/catch/finally: satu frame error TIDAK boleh mematikan loop diam-diam.
  function frame() {
    if (!running) return;
    try {
      // Game over → hentikan simulasi, gambar overlay saja
      if (gameOver) {
        canvas.renderAll();
        drawGameOver();
        ctx.raf(frame);
        return;
      }

      // Spawn balon berkala
      if (Date.now() - lastSpawn > 650) {
        spawnBalloon();
        lastSpawn = Date.now();
      }

      // Spawn enemy — tiap 30 detik, probabilitas 0.7 (window baru tiap cek)
      if (Date.now() - lastEnemySpawn > ENEMY_INTERVAL_MS) {
        lastEnemySpawn = Date.now(); // mulai window baru
        if (Math.random() < ENEMY_SPAWN_PROB) spawnEnemy();
      }

      // Gerakkan player (panah + joystick, held-state) — 4 arah
      var speed = 1.8;
      if (keys.left) player.left -= speed;
      if (keys.right) player.left += speed;
      if (keys.up) player.top -= speed;
      if (keys.down) player.top += speed;
      if (player.left < 0) player.left = 0;
      if (player.left + player.width > W) player.left = W - player.width;
      // Batas vertikal: bawah = dasar layar, atas = 30% (70% area bawah)
      var minTop = H * PLAYER_MAX_TOP_RATIO;
      if (player.top < minTop) player.top = minTop;
      if (player.top + player.height > H) player.top = H - player.height;

      // Gerakkan balon (plain objects) + cek tabrakan player & lolos ke bawah
      for (var i = balloons.length - 1; i >= 0; i--) {
        var b = balloons[i];
        b.x += b.vx;
        b.y += b.vy;

        // Kena player → nyawa berkurang, balon pecah
        if (hitPlayer(b)) {
          explode(b);
          balloons.splice(i, 1);
          lives--;
          updateLife();
          continue;
        }

        // Lolos sampai bawah ("bumi") → score -5
        if (b.y - b.r > H) {
          balloons.splice(i, 1);
          score = Math.max(0, score - 5);
          ctx.send({ event: "sound", data: "drop" }); // suara drop balon ke bumi
          updateScore();
        }
      }

      // Gerakkan enemy (plain): selalu mengarah (chase) ke player + tabrakan
      for (var i = enemies.length - 1; i >= 0; i--) {
        var e = enemies[i];
        var ecx = e.x + e.size / 2;
        var ecy = e.y + e.size / 2;
        var pcx = player.left + player.width / 2;
        var pcy = player.top + player.height / 2;
        var dx = pcx - ecx;
        var dy = pcy - ecy;
        var dist = Math.sqrt(dx * dx + dy * dy) || 1;
        var spd = 1.8; // kecepatan chase
        e.x += (dx / dist) * spd;
        e.y += (dy / dist) * spd;

        // Kena player → nyawa berkurang, enemy hancur (ledakan + suara)
        if (rectsOverlap(e, player)) {
          explode({ x: e.x + e.size / 2, y: e.y + e.size / 2, r: e.size / 2, color: e.color });
          enemies.splice(i, 1);
          lives--;
          updateLife();
        }
      }

      // Gerakkan peluru + cek collision dengan balon & enemy
      for (var i = bullets.length - 1; i >= 0; i--) {
        var u = bullets[i];
        u.top += u.vy;
        if (u.top < -20) {
          canvas.remove(u);
          bullets.splice(i, 1);
          continue;
        }
        var ucx = u.left + u.width / 2;
        var ucy = u.top + u.height / 2;
        var hit = false;
        for (var j = balloons.length - 1; j >= 0; j--) {
          var b = balloons[j];
          var dx = ucx - b.x;
          var dy = ucy - b.y;
          if (Math.sqrt(dx * dx + dy * dy) < b.r + 3) {
            explode(b);
            balloons.splice(j, 1);
            canvas.remove(u);
            bullets.splice(i, 1);
            score += 10; // pecah balon = +10
            updateScore();
            hit = true;
            break;
          }
        }
        if (hit) continue;

        // Peluru kena enemy → enemy hancur (+15)
        for (var j = enemies.length - 1; j >= 0; j--) {
          var e = enemies[j];
          var ecx = e.x + e.size / 2;
          var ecy = e.y + e.size / 2;
          if (
            Math.sqrt(
              (ucx - ecx) * (ucx - ecx) + (ucy - ecy) * (ucy - ecy),
            ) <
            e.size / 2 + 3
          ) {
            explode({ x: ecx, y: ecy, r: e.size / 2, color: "#e91e63" });
            enemies.splice(j, 1);
            canvas.remove(u);
            bullets.splice(i, 1);
            score += 15; // enemy = +15
            updateScore();
            hit = true;
            break;
          }
        }
        if (hit) continue;
      }

      // Animasi explosion (plain): partikel bertebaran + fade lalu hapus
      for (var i = explosions.length - 1; i >= 0; i--) {
        var p = explosions[i];
        p.x += p.vx;
        p.y += p.vy;
        p.life -= 0.08;
        if (p.life <= 0) {
          explosions.splice(i, 1);
        } else {
          p.r += 0.5;
        }
      }

      // Background bintang di-scroll & di-update tiap frame
      updateStars();

      canvas.renderAll();
      drawStars();
      drawBalloons();
      drawEnemies();
      drawExplosions();
      drawPlayer();
      drawScore();
      drawLives();
    } catch (e) {
      // Jangan biarkan error satu frame mematikan game diam-diam
      console.error("[DDC-balloons] frame error:", e);
    }
    ctx.raf(frame); // selalu reschedule
  }

  // --- Keyboard langsung di browser (zero-WS), via ctx.onKey ---
  ctx.onKey = function (k) {
    if (k.key === "ArrowLeft" || k.code === "ArrowLeft") keys.left = k.down;
    if (k.key === "ArrowRight" || k.code === "ArrowRight") keys.right = k.down;
    if (k.key === "ArrowUp" || k.code === "ArrowUp") keys.up = k.down;
    if (k.key === "ArrowDown" || k.code === "ArrowDown") keys.down = k.down;
    // Spasi: tembak (abaikan auto-repeat tombol ditahan)
    if ((k.key === " " || k.code === "Space") && k.down && !k.repeat) {
      shoot();
    }
  };

  // --- Reset game (dipanggil tombol New Game di TGA via DDC_MSG) ---
  function resetGame() {
    // Bersihkan objek fabric (peluru) + array plain (balon, enemy, explosion)
    for (var i = bullets.length - 1; i >= 0; i--) canvas.remove(bullets[i]);
    bullets = [];
    explosions = [];
    enemies = [];
    balloons = [];
    lastEnemySpawn = Date.now();

    score = 0;
    lives = 5;
    gameOver = false;
    if (player) {
      player.left = W / 2 - player.width / 2;
      player.top = H - player.height - 12; // mulai di dasar layar
    }

    // Balon awal lagi
    for (var i = 0; i < 3; i++) spawnBalloon();
    for (var i = 0; i < balloons.length; i++) balloons[i].y = 20 + i * 40;
    lastSpawn = Date.now();

    updateScore();
    updateLife();
    ctx.send({
      event: "newgame",
      data: { score: 0, lives: 5, highScore: highScore },
    });
  }

  // ← dari TGA (DDC_MSG): tombol New Game / inisialisasi high score / joystick
  ctx.onMessage = function (msg) {
    if (msg.cmd === "newGame") resetGame();
    if (msg.cmd === "initHighScore") {
      var v = Number(msg.value) || 0;
      if (v > highScore) highScore = v;
      // kalau layar game over lagi tampil, refresh angka high score
      if (gameOver) drawGameOver();
    }
    // JOYSTICK: A0 (axis X) → gerak horizontal, A1 (axis Y) → vertikal,
    //           B16 → fire
    if (msg.cmd === "joy" && msg.data) {
      var ax = Number(msg.data.axis0) || 0;
      var ay = Number(msg.data.axis1) || 0;
      // deadzone 0.3 — hindari drift saat stick di tengah
      keys.left = ax < -0.3;
      keys.right = ax > 0.3;
      // A1: nilai positif = stick ditekan ke bawah → turun; negatif → naik
      keys.down = ay > 0.3;
      keys.up = ay < -0.3;
      var btn = Number(msg.data.button16) || 0;
      if (btn > 0.5) {
        if (!joyFireDown) {
          joyFireDown = true;
          shoot();
        }
      } else {
        joyFireDown = false;
      }
    }
  };

  createPlayer();
  initStars(); // bintang background
  lastSpawn = Date.now();

  // Spawn awal biar balon langsung terlihat (bukan nunggu interval pertama)
  for (var i = 0; i < 3; i++) spawnBalloon();
  for (var i = 0; i < balloons.length; i++) balloons[i].y = 20 + i * 40;

  ctx.send({ event: "ready", data: { width: W, height: H, score: 0 } });
  console.log("[balloons] ready sent", W, H);

  ctx.onResize = function (w, h) {
    W = w;
    H = h;
    canvas.setDimensions({ width: w, height: h });
    if (player) {
      // Jaga player tetap di dalam layar saat ukuran berubah
      if (player.top + player.height > H) player.top = H - player.height;
      var minTop = H * PLAYER_MAX_TOP_RATIO;
      if (player.top < minTop) player.top = minTop;
    }
    initStars(); // sesuaikan bintang dengan ukuran baru
    drawScore();
    drawLives();
  };

  ctx.onDestroy = function () {
    running = false;
    canvas.dispose();
  };

  ctx.raf(frame);
});
