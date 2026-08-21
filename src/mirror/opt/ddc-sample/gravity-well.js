/**
 * gravity-well.js — DDC Native JavaScript (NJ) Sample (Fabric.js based)
 *
 * Simulasi fisika Medan Gravitasi / Lubang Hitam Interaktif.
 * Animasi 100% berjalan lokal di browser (Zero WebSocket per-frame).
 */
DDC.onInit(function (ctx) {
  var W = ctx.width;
  var H = ctx.height;

  // Inisialisasi Fabric Canvas sesuai pola bawaan
  var canvas = new ctx.fabric.Canvas(ctx.canvas, {
    selection: false,
    preserveObjectStacking: true,
  });

  var particles = [];
  // Konstanta Fisika
  var G = 150;            // Konstanta Gravitasi (bisa disesuaikan kekuatannya)
  var MAX_PARTICLES = 80; // Batas jumlah partikel agar performa tetap ringan

  // Daftar Pusat Massa / Lubang Hitam (Massa besar yang menarik partikel)
  var attractors = [];

  // Fungsi membuat Lubang Hitam (Pusat Gravitasi)
  function addAttractor(x, y, mass) {
    var attr = new ctx.fabric.Circle({
      left: x - 15,
      top: y - 15,
      radius: 15,
      fill: "#ff007f", // Neon Pink/Magenta
      shadow: new ctx.fabric.Shadow({
        color: "rgba(255, 0, 127, 0.7)",
        blur: 15,
      }),
      selectable: false
    });
    attr.mx = x; // Menyimpan koordinat pusat x untuk kalkulasi fisika
    attr.my = y; // Menyimpan koordinat pusat y untuk kalkulasi fisika
    attr.mass = mass;

    canvas.add(attr);
    attractors.push(attr);
    return attr;
  }

  // Fungsi membuat partikel kosmik kecil mengorbit
  function addParticle(x, y) {
    var p = new ctx.fabric.Circle({
      left: x - 3,
      top: y - 3,
      radius: 2 + Math.random() * 2,
      fill: "rgba(0, 255, 255, 0.9)", // Cyan bercahaya
      selectable: false
    });

    // Berikan kecepatan awal tegak lurus (tangensial) agar menciptakan orbit melingkar, bukan jatuh langsung
    var angle = Math.atan2(y - H / 2, x - W / 2) + Math.PI / 2;
    var speed = 3 + Math.random() * 3;
    p.vx = Math.cos(angle) * speed;
    p.vy = Math.sin(angle) * speed;

    canvas.add(p);
    particles.push(p);
    return p;
  }

  // Loop Animasi Fisika Utama — Diproses lokal via RAF
  function frame() {
    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      
      // Ambil posisi titik tengah partikel saat ini
      var px = p.left + p.radius;
      var py = p.top + p.radius;

      var totalAccX = 0;
      var totalAccY = 0;

      // Hitung akumulasi gaya tarik dari semua lubang hitam yang aktif
      for (var j = 0; j < attractors.length; j++) {
        var a = attractors[j];
        var dx = a.mx - px;
        var dy = a.my - py;
        var distanceSq = dx * dx + dy * dy;
        var distance = Math.sqrt(distanceSq);

        // Pencegahan pembagian dengan nol / partikel terlalu dekat tersedot masuk
        if (distance < 16) {
          // Reset partikel ke tepi luar layar jika tersedot masuk lubang hitam
          var spawnAngle = Math.random() * Math.PI * 2;
          var radiusOut = Math.min(W, H) * 0.4;
          p.left = W / 2 + Math.cos(spawnAngle) * radiusOut;
          p.top = H / 2 + Math.sin(spawnAngle) * radiusOut;
          
          var orbitAngle = spawnAngle + Math.PI / 2;
          p.vx = Math.cos(orbitAngle) * 4;
          p.vy = Math.sin(orbitAngle) * 4;
          continue;
        }

        // Rumus Gravitasi Semesta Newton: F = G * (m1 * m2) / r^2
        // Percepatan (Acceleration) a = F / m2 -> a = G * m1 / r^2
        var force = (G * a.mass) / distanceSq;
        
        // Pecah komponen gaya vektor ke sumbu X dan Y
        totalAccX += (dx / distance) * force;
        totalAccY += (dy / distance) * force;
      }

      // Update kecepatan partikel berdasarkan percepatan gravitasi
      p.vx += totalAccX;
      p.vy += totalAccY;

      // Batasi kecepatan maksimal (terminal velocity) agar partikel tidak melesat hilang ke luar angkasa
      var speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      var maxSpeed = 12;
      if (speed > maxSpeed) {
        p.vx = (p.vx / speed) * maxSpeed;
        p.vy = (p.vy / speed) * maxSpeed;
      }

      // Update posisi fisik koordinat objek Fabric
      p.left += p.vx;
      p.top += p.vy;

      // Pantulan tepi layar opsional agar partikel tetap berada di ekosistem canvas
      if (p.left < 0 || p.left > W) p.vx = -p.vx;
      if (p.top < 0 || p.top > H) p.vy = -p.vy;
    }

    // Render perubahaan frame objek Fabric
    canvas.renderAll();
    ctx.raf(frame);
  }

  // KLIK CANVAS: Spawn Lubang Hitam baru di koordinat kursor!
  canvas.on("mouse:down", function (opt) {
    var p = opt.pointer;
    
    // Jika lubang hitam sudah lebih dari 3, bersihkan yang lama agar tidak pusing massanya
    if (attractors.length >= 3) {
      var oldAttr = attractors.shift();
      canvas.remove(oldAttr);
    }

    addAttractor(p.x, p.y, 12); // Spawn titik gravitasi baru
    
    ctx.send({
      event: "new_gravity_well",
      data: { x: Math.round(p.x), y: Math.round(p.y) },
    });
  });

  // Manajemen Pesan Masuk dari TGA (DDC_MSG)
  ctx.onMessage = function (msg) {
    if (msg.cmd === "burst") {
      // Tambahkan ledakan 15 partikel kosmik acak dari tengah
      for (var i = 0; i < 15; i++) {
        addParticle(W / 2 + (Math.random() - 0.5) * 20, H / 2 + (Math.random() - 0.5) * 20);
      }
    } else if (msg.cmd === "clear") {
      // Bersihkan semua elemen simulasi
      particles.forEach(function(p) { canvas.remove(p); });
      attractors.forEach(function(a) { canvas.remove(a); });
      particles = [];
      attractors = [];
      addAttractor(W / 2, H / 2, 15); // Sisakan satu lubang hitam utama di tengah
    }
  };

  ctx.onResize = function (w, h) {
    W = w; H = h;
    canvas.setDimensions({ width: w, height: h });
    
    // Pindahkan Lubang Hitam utama ke tengah resolusi baru jika hanya ada 1
    if (attractors.length === 1) {
      attractors[0].left = W / 2 - 15;
      attractors[0].top = H / 2 - 15;
      attractors[0].mx = W / 2;
      attractors[0].my = H / 2;
    }
    canvas.renderAll();
  };

  ctx.onDestroy = function () {
    canvas.dispose();
  };

  // --- Inisialisasi Kondisi Awal Tampilan ---
  // 1. Buat 1 Lubang Hitam Inti di Tengah-tengah layar
  addAttractor(W / 2, H / 2, 15);

  // 2. Sebarkan partikel awal mengelilingi cincin orbit luar lubang hitam
  for (var i = 0; i < MAX_PARTICLES; i++) {
    var spawnAngle = (i / MAX_PARTICLES) * Math.PI * 2;
    // Jarak sebaran cincin orbit (akresi disk) antara 60 hingga 180 piksel dari pusat
    var distance = 60 + Math.random() * 120; 
    var sX = W / 2 + Math.cos(spawnAngle) * distance;
    var sY = H / 2 + Math.sin(spawnAngle) * distance;
    addParticle(sX, sY);
  }

  // Beri tahu TGA bahwa NJ siap menerima instruksi
  ctx.send({
    event: "ready",
    data: { width: W, height: H, type: "gravity_well_sim" },
  });

  ctx.raf(frame);
});
