/**
 * plcd-panel.js — DDC NJ: viewer panel PSEUDO-LCD 128x64 (/dev/plcd)
 *
 * Menggambar isi DD-RAM panel palsu (driver kernel `PLCDDevice`) di canvas,
 * 1 piksel logika = `scale` x `scale` piksel fisik (integer, tanpa smoothing)
 * supaya tampak seperti LCD dot-matrix sungguhan — bukan hasil anti-alias.
 *
 * ── LOOK: sama dengan NJ kalkulator grafis (`opt/ddc-sample/graphcalc.js`) ──
 *   - Kaca LCD = gradient sheen vertikal (sheen di ≈35% tinggi, falloff
 *     kuadratik) — TETAP 2 level: ON hitam pekat, OFF kaca hijau metalik.
 *     Bukan anti-alias, jadi tetap terlihat dot-matrix.
 *   - TRAILING (persistence LCD): piksel yang padam tidak langsung hilang —
 *     levelnya luruh bertahap, dirender SOLID sesaat lalu di-dither Bayer 4×4
 *     sampai benar-benar OFF. Efek khas LCD lama saat gambar berpindah.
 *
 * Protokol (TGA → NJ):
 *   { t: "frame", fb, invert, displayOn, backlight, contrast, rev }
 *     `fb` = base64 1024 byte, 1 bpp MSB-first row-major (format drawBitmap
 *     Adafruit_GFX) — sama persis dengan isi panel yang sedang tampil.
 *   { t: "reset" }   → kosongkan panel (mis. /dev/plcd belum ada isinya)
 *   { t: "style", trail: boolean } → hidup/matikan efek trailing
 *
 * NJ → TGA:
 *   { event: "ready", panelW, panelH, scale, trail }
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
    var state = { invert: false, displayOn: true, backlight: true, trail: false, pixelGap: true };

    // ── PALET (disamakan dengan ddc-sample/graphcalc.js) ──
    // Kaca LCD = dua stop hijau metalik; tiap baris diambil warnanya lewat
    // gradient sheen (glassRow). INK = hitam pekat khas kalkulator grafis.
    var GLASS_HI = [200, 216, 166];
    var GLASS_LO = [138, 158, 102];
    var GLASS_HI_DIM = [72, 84, 48]; // dipakai saat backlight/display OFF
    var GLASS_LO_DIM = [44, 53, 30];
    var INK = state.pixelGap === true ? [0, 0, 0] : [60, 60, 60];

    // ── TRAILING / persistence (ambang sama dengan graphcalc.js) ──
    var FADE = 34; // penurunan level sisa-nyala per frame
    var SOLID_LV = 180; // level >= ini → bayangan masih PEKAT (belum di-dither)
    var BAYER_TH = [0, 136, 34, 170, 204, 68, 238, 102, 51, 187, 17, 153, 238, 119, 221, 85];

    var scale = 1;
    var offX = 0;
    var offY = 0;

    // Frame terakhir (1 = piksel ON) + level sisa-nyala per piksel logika.
    var lit = new Uint8Array(PANEL_W * PANEL_H);
    var ghost = new Uint8Array(PANEL_W * PANEL_H);
    var rafRunning = false;

    // Canvas offscreen 128x64 → di-blit ke canvas utama dengan skala integer.
    var off = document.createElement("canvas");
    off.width = PANEL_W;
    off.height = PANEL_H;
    var octx = off.getContext("2d");
    var imgData = octx.createImageData(PANEL_W, PANEL_H);

    // Grid celah antar-piksel di-render SEKALI per layout ke canvas sendiri.
    // Sebelumnya 190 `fillRect` dijalankan tiap frame SAAT `ctx.filter` (blur)
    // masih aktif — tiap operasi ber-filter memicu pass blur sendiri, dan itu
    // biaya terbesar di viewer (bikin laju efektif jatuh di GPU terintegrasi).
    var gridCanvas = document.createElement("canvas");
    var gctx = gridCanvas.getContext("2d");

    function buildGrid() {
        gridCanvas.width = PANEL_W * scale;
        gridCanvas.height = PANEL_H * scale;
        gctx.clearRect(0, 0, gridCanvas.width, gridCanvas.height);
        if (!state.pixelGap || scale <= 1) return;
        gctx.fillStyle = "#dbddd8";
        for (var x = 1; x < PANEL_W; x++) gctx.fillRect(x * scale, 0, 1, gridCanvas.height);
        for (var y = 1; y < PANEL_H; y++) gctx.fillRect(0, y * scale, gridCanvas.width, 1);
    }

    function layout() {
        scale = Math.max(1, Math.floor(Math.min(W / PANEL_W, H / PANEL_H)));
        offX = Math.floor((W - PANEL_W * scale) / 2);
        offY = Math.floor((H - PANEL_H * scale) / 2);
        c2.imageSmoothingEnabled = false;
        buildGrid();
    }

    /**
     * Warna kaca untuk satu baris — gradient sheen vertikal, persis
     * `paintGlass()` di graphcalc.js: sheen di ≈35% tinggi, falloff kuadratik.
     */
    var rowCol = [0, 0, 0];
    function glassRow(y, dim) {
        var u = y / (PANEL_H - 1); // 0 (atas) .. 1 (bawah)
        var d = Math.abs(u - 0.35) / 0.75;
        if (d > 1) d = 1;
        var s = 1 - d * d;
        var hi = dim ? GLASS_HI_DIM : GLASS_HI;
        var lo = dim ? GLASS_LO_DIM : GLASS_LO;
        rowCol[0] = (lo[0] + (hi[0] - lo[0]) * s) | 0;
        rowCol[1] = (lo[1] + (hi[1] - lo[1]) * s) | 0;
        rowCol[2] = (lo[2] + (hi[2] - lo[2]) * s) | 0;
        return rowCol;
    }

    /**
     * Decode base64 1024 byte (1 bpp MSB-first) → mask `lit` (1 = piksel ON).
     *
     * PENTING (beda dari graphcalc yang menggambar ulang tiap frame): frame di
     * sini datang ASINKRON (hasil polling `GET_REV`), jadi bisa ada dua frame
     * tanpa satu pun tick RAF di antaranya. Karena itu piksel yang baru PADAM
     * diberi level bayangan penuh di sini — kalau hanya mengandalkan `decay()`,
     * bayangan frame sebelumnya tidak akan pernah muncul.
     */
    function setFrame(b64) {
        var s = atob(b64 || "");
        for (var y = 0; y < PANEL_H; y++) {
            var base = y * (PANEL_W >> 3);
            for (var x = 0; x < PANEL_W; x++) {
                var i = y * PANEL_W + x;
                var was = lit[i];
                var b = s.charCodeAt(base + (x >> 3)) || 0;
                var now = (b >> (7 - (x & 7))) & 1;
                lit[i] = now;
                // Baru padam → mulai dari level penuh (jadi bayangan yang luruh).
                if (state.trail && was && !now) ghost[i] = 255;
            }
        }
    }

    /**
     * Luruhkan level sisa-nyala satu langkah (dipanggil per RAF).
     * Piksel yang ON di frame terakhir → level penuh; sisanya turun FADE.
     * Return true selama masih ada bayangan yang perlu diluruhkan.
     */
    function decay() {
        if (!state.trail) {
            ghost.fill(0);
            return false;
        }
        var active = 0;
        for (var i = 0; i < lit.length; i++) {
            if (lit[i]) {
                ghost[i] = 255; // masih menyala → level penuh
                continue;
            }
            var lv = ghost[i];
            if (lv === 0) continue; // sudah gelap total → jalur cepat
            lv -= FADE;
            ghost[i] = lv > 0 ? lv : 0;
            if (lv > 0) active++;
        }
        return active > 0;
    }

    /**
     * Susun ulang ImageData 128x64 dari `lit` + `ghost`, lalu blit ke canvas.
     * Bayangan dirender SOLID selama levelnya masih tinggi (LCD memang lambat
     * mati), sisanya di-dither Bayer 4×4 — jadi tetap hanya 2 warna.
     */
    function compose() {
        var d = imgData.data;
        var dim = !state.displayOn || !state.backlight;
        var visible = state.displayOn;
        for (var y = 0; y < PANEL_H; y++) {
            var g = glassRow(y, dim);
            var gr = g[0];
            var gg = g[1];
            var gb = g[2];
            var ir = INK[0];
            var ig = INK[1];
            var ib = INK[2];
            if (state.invert) {
                // Panel negatif: tinta memakai warna kaca baris ini.
                ir = gr;
                ig = gg;
                ib = gb;
            }
            for (var x = 0; x < PANEL_W; x++) {
                var i = y * PANEL_W + x;
                var on = visible && lit[i] === 1;
                if (!on && visible && ghost[i] > 0) {
                    var lv = ghost[i];
                    on = lv >= SOLID_LV || lv >= BAYER_TH[((y & 3) << 2) | (x & 3)];
                }
                var o = i * 4;
                if (on) {
                    d[o] = ir;
                    d[o + 1] = ig;
                    d[o + 2] = ib;
                } else {
                    d[o] = gr;
                    d[o + 1] = gg;
                    d[o + 2] = gb;
                }
                d[o + 3] = 255;
            }
        }
        octx.putImageData(imgData, 0, 0);
        draw();
    }

    /** Loop RAF untuk meluruhkan bayangan; berhenti sendiri saat layar bersih. */
    function tick() {
        rafRunning = false;
        var more = decay();
        compose();
        if (more) {
            rafRunning = true;
            ctx.raf(tick);
        }
    }

    /** Nyalakan loop hanya kalau memang ada yang perlu diluruhkan (hemat CPU). */
    function kick() {
        if (!rafRunning && state.trail) {
            rafRunning = true;
            ctx.raf(tick);
        }
    }

    /** Panel kosong: semua kaca, tanpa tinta & tanpa sisa nyala. */
    function clearPanel() {
        lit.fill(0);
        ghost.fill(0);
        compose();
    }

    function draw() {
        c2.fillStyle = "#0b0d08";
        c2.fillRect(0, 0, W, H);
        c2.imageSmoothingEnabled = false;

        // --- AKTIFKAN BLUR TIPIS ---
        // Gunakan nilai px yang kecil (misal: 1px atau 1.5px) untuk efek blur tipis.
        c2.save();
        c2.filter = "blur(.8px)";

        // 1. Gambar canvas offscreen ke canvas utama terlebih dahulu
        c2.drawImage(off, offX, offY, PANEL_W * scale, PANEL_H * scale);

        // 2. Overlay Grid Efek Celah (hanya jika state.pixelGap TRUE dan skala > 1)
        //    Diambil dari canvas yang SUDAH jadi → 1x drawImage, bukan 190x fillRect.
        //    Masih di dalam blok filter blur supaya tampilannya sama seperti sebelumnya.
        if (state.pixelGap && scale > 1) {
            c2.drawImage(gridCanvas, offX, offY);
        }

        // --- MATIKAN BLUR ---
        // c2.restore() akan mengembalikan status filter ke 'none' (normal)
        c2.restore();

        // Bingkai tipis tepi panel (biar batas kaca terlihat). Tidak ikut blur.
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
            c2.fillText("DISPLAY OFF", offX + (PANEL_W * scale) / 2, offY + (PANEL_H * scale) / 2);
            c2.textAlign = "start";
        }

        if (!state.backlight) {
            c2.fillStyle = "#8d9a76";
            c2.font = "10px monospace";
            c2.textBaseline = "top";
            c2.fillText("⌁ backlight off", offX + 4, offY + 4);
        }
    }

    ctx.onMessage = function (msg) {
        if (!msg) return;
        if (msg.t === "frame") {
            state.invert = !!msg.invert;
            state.displayOn = msg.displayOn !== false;
            state.backlight = msg.backlight !== false;
            setFrame(msg.fb);
            kick(); // frame baru → luruhkan bayangan frame sebelumnya
            compose();
        } else if (msg.t === "reset") {
            state.invert = false;
            state.displayOn = true;
            state.backlight = true;
            clearPanel();
        } else if (msg.t === "style") {
            if (typeof msg.trail === "boolean") {
                state.trail = msg.trail;
                if (!state.trail) ghost.fill(0); // efek dimatikan → langsung bersih
            }
            kick();
            compose();
        }
    };

    ctx.onResize = function (w, h) {
        W = w;
        H = h;
        layout();
        compose();
    };

    ctx.onDestroy = function () {
        rafRunning = false; // RAF-nya dibatalkan runtime DDC saat window tutup
        lit.fill(0);
        ghost.fill(0);
    };

    // ================================================================
    // START
    // ================================================================
    layout();
    compose(); // panel kosong = kaca bergradient
    ctx.send({
        event: "ready",
        panelW: PANEL_W,
        panelH: PANEL_H,
        scale: scale,
        trail: state.trail,
    });
});
