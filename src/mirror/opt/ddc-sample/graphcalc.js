/**
 * graphcalc.js — DDC NJ: LCD MONOKROM 160×80 (gaya kalkulator grafis)
 *
 * Pasangan TGA: ddc-sample10.ts
 *
 * Tampilan LCD dot-matrix khas kalkulator grafis:
 *   - Grid LOGIKA 160×80 → tiap piksel logika = blok N×N piksel fisik
 *     (scale dihitung otomatis dari ukuran canvas).
 *   - MONOKROM: piksel ON = hitam pekat, piksel OFF = "kaca" hijau
 *     metalik (gradient sheen vertikal, tetap 2-level — bukan anti-alias).
 *   - TRAILING (persistence LCD): piksel yang dimatikan TIDAK langsung
 *     hilang — levelnya luruh bertahap dan dirender sebagai dither
 *     Bayer 4×4, jadi tampak "membayang" lalu memudar seperti LCD asli.
 *   - Font bitmap 3×5 (A-Z, 0-9, simbol) digambar lewat fb.pixel —
 *     karakter LCD dot-matrix, bukan font vektor.
 *   - Status bar atas : mode RAD, indikator BUSY berkedip, jam, baterai.
 *   - Area plot       : grid titik, sumbu + tick, kurva fungsi, dan
 *                       kursor TRACE (crosshair titik-titik + marker).
 *   - Status bar bawah: Y1=f(X), koordinat trace, GRID, TRACE, TRAIL.
 *
 * Library: DDC.FrameBuffer — di-inject DOME dari global window.FrameBuffer
 * (hasil transpile /lib/framebuffer.ts → /dome/framebuffer.js). NJ tidak
 * perlu import apa pun.
 *
 * Perintah dari TGA (ctx.onMessage):
 *   { cmd: "fn",   value: "SIN" | "COS" | "TAN" | "X2" }
 *   { cmd: "grid" }                        → toggle grid titik
 *   { cmd: "trail" }                       → toggle trailing/persistence
 *
 * Zero WebSocket per-frame — loop RAF murni di browser.
 */
DDC.onInit(function (ctx) {
    var c2 = ctx.canvas.getContext("2d");

    var FB = DDC.FrameBuffer || window.FrameBuffer;
    if (!FB) {
        throw new Error("DDC.FrameBuffer tidak tersedia — pastikan /dome/framebuffer.js termuat");
    }

    // ================================================================
    // LCD — GEOMETRI & PALET
    // ================================================================
    // Resolusi LOGIKA khas kalkulator grafis.
    var LGW = 160;
    var LGH = 80;
    var powerState = 0;

    // "Kaca" LCD = warna piksel OFF (hijau metalik), 2 stop untuk sheen.
    // INK = warna piksel ON (hitam pekat). BAND = buffer warna baris (reuse).
    var GLASS_HI = [200, 216, 166];
    var GLASS_LO = [138, 158, 102];
    var INK = [40, 40, 40];
    var BAND = [0, 0, 0];

    // Tata letak (satuan piksel logika)
    var TOP_BAR_Y = 1; // teks status atas (3×5)
    var TOP_SEP = 7; // garis pemisah atas
    var PLOT_TOP = 8; // area plot atas
    var PLOT_BOT = 65; // area plot bawah
    var BOT_SEP = 66; // garis pemisah bawah
    var BOT_ROW1 = 68; // baris teks 1 (Y1=..., X/Y trace)
    var BOT_ROW2 = 74; // baris teks 2 (GRID, TRACE)
    var CX = LGW >> 1; // sumbu Y di x=80
    var CY = 36; // sumbu X di y=36
    var HALF_H = 28; // jarak pusat→tepi = nilai YMAX
    var XMIN = -3 * Math.PI;
    var XMAX = 3 * Math.PI;
    var YMAX = 2;
    var GRID_STEP = 8; // spasi grid titik (px logika)

    // -- TRAILING (persistence) --
    // Piksel yang padam tidak langsung OFF. Tiap frame levelnya turun FADE.
    // Selama level masih tinggi bayangan dirender SOLID (pekat) seperti LCD
    // lambat mati; sisanya baru di-dither Bayer 4×4 sampai benar-benar OFF.
    // var FADE = 48; // 255/48 ≈ 5 frame (~85 ms @60fps)
    // var SOLID_LV = 64; // level >= ini → bayangan masih PEKAT (≈3 frame)
    var FADE = 30;
    var SOLID_LV = 400; // level >= ini → bayangan masih PEKAT
    // Ambang Bayer 4×4 (index = ((y&3)<<2) | (x&3)).
    var BAYER_TH = [0, 136, 34, 170, 204, 68, 238, 102, 51, 187, 17, 153, 238, 119, 221, 85];

    // -- GERAKAN (biar bayangan trailing jelas kelihatan) --
    // Bayangan hanya tampak kalau ada objek yang BERGESER.
    var PAN_AMP = 2.6; // amplitudo geser kurva (satuan matematis)
    var PAN_SPD = 0.015; // kecepatan geser ≈ 0,33 px logika/frame
    var MARQUEE = "TSIX GRAPHIC CALCULATOR * 160X80 MONO LCD * ";
    var MQ_SPD = 0.35; // kecepatan ticker teks (px logika/frame)
    var MQ_X0 = 26; // area ticker di status bar atas
    var MQ_X1 = 124;

    // ================================================================
    // STATE
    // ================================================================
    var fb = null;
    var scale = 1;
    var mode = "SIN"; // fungsi aktif (diubah dari TGA)
    var grid = true; // grid titik ON/OFF
    var trail = true; // efek trailing (persistence) ON/OFF
    var pan = 0; // geseran horizontal kurva (animasi) — dihitung / frame
    var t = 0; // penghitung frame

    // -- Mask & level trailing --
    // ink[]   : 1 = piksel jadi tinta di FRAME INI
    // ghost[] : 0..255 = level "sisa nyala" piksel yang sudah padam
    var ink = new Uint8Array(LGW * LGH);
    var ghost = new Uint8Array(LGW * LGH * 0.7);
    var marking = false; // true HANYA saat menggambar tinta (bukan kaca)
    var rawPixel = null; // fb.pixel asli (tanpa pencatatan tinta)

    // ================================================================
    // FONT BITMAP 3×5
    // ================================================================
    // Tiap glyph = 5 baris; tiap baris 3 bit (4=kiri, 2=tengah, 1=kanan).
    var FONT = {
        0: [7, 5, 5, 5, 7],
        1: [2, 6, 2, 2, 7],
        2: [7, 1, 7, 4, 7],
        3: [7, 1, 7, 1, 7],
        4: [5, 5, 7, 1, 1],
        5: [7, 4, 7, 1, 7],
        6: [7, 4, 7, 5, 7],
        7: [7, 1, 2, 2, 2],
        8: [7, 5, 7, 5, 7],
        9: [7, 5, 7, 1, 7],
        A: [7, 5, 7, 5, 5],
        B: [6, 5, 6, 5, 6],
        C: [7, 4, 4, 4, 7],
        D: [6, 5, 5, 5, 6],
        E: [7, 4, 7, 4, 7],
        F: [7, 4, 7, 4, 4],
        G: [7, 4, 5, 5, 7],
        H: [5, 5, 7, 5, 5],
        I: [7, 2, 2, 2, 7],
        J: [1, 1, 1, 5, 7],
        K: [5, 5, 6, 5, 5],
        L: [4, 4, 4, 4, 7],
        M: [5, 7, 7, 5, 5],
        N: [6, 5, 5, 5, 5],
        O: [7, 5, 5, 5, 7],
        P: [7, 5, 7, 4, 4],
        Q: [7, 5, 5, 7, 1],
        R: [7, 5, 7, 6, 5],
        S: [7, 4, 7, 1, 7],
        T: [7, 2, 2, 2, 2],
        U: [5, 5, 5, 5, 7],
        V: [5, 5, 5, 5, 2],
        W: [5, 5, 7, 7, 5],
        X: [5, 5, 2, 5, 5],
        Y: [5, 5, 2, 2, 2],
        Z: [7, 1, 2, 4, 7],
        " ": [0, 0, 0, 0, 0],
        "-": [0, 0, 7, 0, 0],
        ".": [0, 0, 0, 0, 2],
        ",": [0, 0, 0, 2, 4],
        "+": [0, 2, 7, 2, 0],
        "=": [0, 7, 0, 7, 0],
        ":": [0, 2, 0, 2, 0],
        "(": [1, 2, 2, 2, 1],
        ")": [4, 2, 2, 2, 4],
        "/": [1, 1, 2, 4, 4],
        "^": [2, 5, 0, 0, 0],
        "?": [7, 1, 2, 0, 2],
        "*": [0, 5, 2, 5, 0],
        "%": [5, 1, 2, 4, 5],
    };

    /**
     * Gambar teks 3×5 (glyph 3 px + 1 px spasi → advance 4 px).
     * clipL/clipR opsional: batas kolom tempat teks dipotong (dipakai
     * ticker berjalan supaya tidak menabrak indikator lain).
     */
    function drawText(x, y, s, color, clipL, clipR) {
        s = String(s).toUpperCase();
        var l = clipL === undefined ? 0 : clipL;
        var rr = clipR === undefined ? LGW - 1 : clipR;
        for (var i = 0; i < s.length; i++) {
            // Lewati glyph yang seluruhnya di luar area klip.
            if (x + 2 >= l && x <= rr) {
                var g = FONT[s.charAt(i)] || FONT["?"];
                for (var ri = 0; ri < 5; ri++) {
                    var bits = g[ri];
                    if (bits & 4 && x >= l && x <= rr) fb.pixel(x, y + ri, color);
                    if (bits & 2 && x + 1 >= l && x + 1 <= rr) fb.pixel(x + 1, y + ri, color);
                    if (bits & 1 && x + 2 >= l && x + 2 <= rr) fb.pixel(x + 2, y + ri, color);
                }
            }
            x += 4;
        }
    }

    /**
     * Ticker teks berjalan (moving text). Ini kunci demo trailing: tiap
     * glyph yang "padam" meninggalkan bayangan pekat sesaat, jadi tulisan
     * yang bergeser tampak berbayang — persis LCD kalkulator grafis.
     */
    function drawMarquee(x0, x1, y) {
        var span = MARQUEE.length * 4; // lebar satu putaran (px)
        var off = Math.floor(t * MQ_SPD) % span;
        // Gambar 2 putaran (dengan klip) supaya area tidak pernah kosong.
        drawText(x0 - off, y, MARQUEE, INK, x0, x1);
        drawText(x0 - off + span, y, MARQUEE, INK, x0, x1);
    }

    /** Gambar teks rata-kanan (ujung kanan di rightX). */
    function drawTextRight(rightX, y, s, color) {
        var w = String(s).length * 4 - 1;
        drawText(rightX - w, y, s, color);
    }

    // ================================================================
    // FRAMEBUFFER — scale otomatis dari ukuran canvas
    // ================================================================
    /**
     * Bangun ulang framebuffer: cari skala bulat TERBESAR sehingga grid
     * logika 160×80 muat di canvas. FrameBuffer(LGW*scale, LGH*scale)
     * menghasilkan lebar logika tepat == LGW (dan tinggi == LGH).
     */
    function rebuild() {
        var W = ctx.width;
        var H = ctx.height;
        scale = Math.max(1, Math.floor(Math.min(W / LGW, H / LGH)));
        fb = new FB(c2, LGW * scale, LGH * scale, { scale: scale });
        wrapPixel(); // buffer baru → pasang lagi pencatat tinta
        ghost.fill(0); // tanpa sisa dari buffer lama
        // Bila canvas bukan kelipatan pas, sisa tepi diwarnai kaca LCD
        // supaya tidak ada pita "kotor" (LCD tetap 160×80 logika).
        c2.fillStyle = "rgb(" + GLASS_HI[0] + "," + GLASS_HI[1] + "," + GLASS_HI[2] + ")";
        c2.fillRect(0, 0, W, H);
    }

    /**
     * Bungkus fb.pixel agar tiap piksel tinta dicatat ke mask `ink`.
     * SEMUA primitif library (line, hline, vline, rect, fillRect, circle,
     * fillCircle, arc, triangle, fillTriangle, roundRect, polyline) pada
     * akhirnya memanggil this.pixel — jadi satu pembungkusan di sini cukup
     * untuk seluruh scene. Kaca LCD (paintGlass) tidak ikut tercatat karena
     * dipanggil saat `marking` = false.
     */
    function wrapPixel() {
        rawPixel = fb.pixel.bind(fb);
        fb.pixel = function (x, y, color) {
            rawPixel(x, y, color);
            if (marking && x >= 0 && x < LGW && y >= 0 && y < LGH) {
                ink[y * LGW + x] = 1;
            }
        };
    }

    // ================================================================
    // MENGGAMBAR LAYAR
    // ================================================================

    /** Isi "kaca" LCD: gradient sheen vertikal (semua piksel OFF). */
    function paintGlass() {
        for (var y = 0; y < LGH; y++) {
            var u = y / (LGH - 1); // 0 (atas) .. 1 (bawah)
            var d = Math.abs(u - 0.35) / 0.75; // sheen di ~35% tinggi
            if (d > 1) d = 1;
            var s = 1 - d * d; // falloff kuadratik
            BAND[0] = (GLASS_LO[0] + (GLASS_HI[0] - GLASS_LO[0]) * s) | 0;
            BAND[1] = (GLASS_LO[1] + (GLASS_HI[1] - GLASS_LO[1]) * s) | 0;
            BAND[2] = (GLASS_LO[2] + (GLASS_HI[2] - GLASS_LO[2]) * s) | 0;
            fb.hline(0, LGW - 1, y, BAND);
        }
    }

    /**
     * Nilai fungsi aktif untuk x tertentu. `pan` menggeser kurva secara
     * horizontal tiap frame → GARIS BERGERAK, dan di situlah bayangan
     * trailing paling kelihatan (persis LCD saat gambar digeser).
     */
    function fnAt(x) {
        var u = x - pan;
        if (mode === "COS") return Math.cos(u);
        if (mode === "TAN") return Math.tan(u);
        if (mode === "X2") return (u * u) / 12 - 1.5;
        return Math.sin(u);
    }

    function mapX(px) {
        return XMIN + (px / (LGW - 1)) * (XMAX - XMIN);
    }

    function mapY(v) {
        if (v > YMAX) v = YMAX;
        if (v < -YMAX) v = -YMAX;
        return CY - Math.round((v / YMAX) * HALF_H);
    }

    /** Format angka dengan tanda minus eksplisit (LCD: tidak ada unicode). */
    function fmt(v, d) {
        return (v < 0 ? "-" : "") + Math.abs(v).toFixed(d);
    }

    /** Grid titik khas kalkulator grafis (dot matrix, bukan garis). */
    function drawGrid() {
        for (var gy = PLOT_TOP + GRID_STEP; gy < PLOT_BOT; gy += GRID_STEP) {
            if (Math.abs(gy - CY) <= 1) continue; // sumbu X menutupi
            for (var gx = GRID_STEP; gx < LGW; gx += GRID_STEP) {
                if (Math.abs(gx - CX) <= 1) continue; // sumbu Y menutupi
                fb.pixel(gx, gy, INK);
            }
        }
    }

    /** Sumbu + tick pendek. */
    function drawAxes() {
        fb.hline(0, LGW - 1, CY, INK);
        fb.vline(CX, PLOT_TOP, PLOT_BOT, INK);
        for (var x = CX % 16; x < LGW; x += 16) {
            if (x === CX) continue;
            fb.vline(x, CY - 2, CY - 1, INK);
            fb.vline(x, CY + 1, CY + 2, INK);
        }
        for (var y = PLOT_TOP + 4; y <= PLOT_BOT - 4; y += 14) {
            if (y === CY) continue;
            fb.hline(CX - 2, CX - 1, y, INK);
            fb.hline(CX + 1, CX + 2, y, INK);
        }
    }

    /** Kurva fungsi: per kolom, disambung agar tidak putus di bagian curam. */
    function drawCurve() {
        var prevX = -1;
        var prevY = 0;
        for (var px = 0; px < LGW; px++) {
            var v = fnAt(mapX(px));
            if (v > YMAX + 0.6 || v < -YMAX - 0.6) {
                prevX = -1; // keluar window → putus (mis. asimtot TAN)
                continue;
            }
            var py = mapY(v);
            if (prevX >= 0) fb.line(prevX, prevY, px, py, INK);
            else fb.pixel(px, py, INK);
            prevX = px;
            prevY = py;
        }
    }

    function statusBar() {
        drawText(2, TOP_BAR_Y, "RAD", INK);

        // Indikator BUSY: 2×2 piksel berkedip (tanda mesin menggambar).
        if (Math.floor(t / 30) % 2 === 0) {
            fb.fillRect(19, TOP_BAR_Y + 1, 2, 2, INK);
        }

        // Ticker teks berjalan — biar bayangan trailing (tulisan) kelihatan.
        drawMarquee(MQ_X0, MQ_X1, TOP_BAR_Y);

        // Jam (waktu jalan) — rata kanan sebelum ikon baterai.
        var secs = Math.floor(t / 60);
        var mm = Math.floor(secs / 60) % 100;
        var ss = secs % 60;
        var clock = (mm < 10 ? "0" : "") + mm + ":" + (ss < 10 ? "0" : "") + ss;
        drawTextRight(149, TOP_BAR_Y, clock, INK);

        // Baterai: badan + kutub + isi.
        fb.rect(151, TOP_BAR_Y, 7, 5, INK);
        fb.fillRect(158, TOP_BAR_Y + 1, 1, 3, INK);
        fb.fillRect(153, TOP_BAR_Y + 2, 4, 1, INK);

        fb.hline(0, LGW - 1, TOP_SEP, INK);
    }

    function bottomBar(tx, ty) {
        fb.hline(0, LGW - 1, BOT_SEP, INK);

        drawText(2, BOT_ROW1, mode === "X2" ? "Y1=X^2/12-1.5" : "Y1=" + mode + "(X)", INK);

        var traceTxt = "X=" + fmt(tx, 2) + " Y=" + (Math.abs(ty) <= YMAX ? fmt(ty, 2) : "----");
        drawTextRight(158, BOT_ROW1, traceTxt, INK);

        drawText(2, BOT_ROW2, grid ? "GRID ON" : "GRID OFF", INK);
        drawText(75, BOT_ROW2, "TRACE", INK);
        drawTextRight(158, BOT_ROW2, trail ? "TRAIL ON" : "TRAIL OFF", INK);
    }

    /** Kursor TRACE: crosshair titik-titik + marker plus berkedip. */
    function drawTrace(tx, ty, blink) {
        if (Math.abs(ty) > YMAX) return;
        var tpx = Math.round(((tx - XMIN) / (XMAX - XMIN)) * (LGW - 1));
        var tpy = mapY(ty);

        var y0 = Math.min(tpy, CY);
        var y1 = Math.max(tpy, CY);
        for (var yy = y0 + 1; yy < y1; yy += 2) fb.pixel(tpx, yy, INK);

        var x0 = Math.min(tpx, CX);
        var x1 = Math.max(tpx, CX);
        for (var xx = x0 + 1; xx < x1; xx += 2) fb.pixel(xx, tpy, INK);

        if (blink) {
            fb.pixel(tpx, tpy, INK);
            fb.pixel(tpx - 2, tpy, INK);
            fb.pixel(tpx - 1, tpy, INK);
            fb.pixel(tpx + 1, tpy, INK);
            fb.pixel(tpx + 2, tpy, INK);
            fb.pixel(tpx, tpy - 2, INK);
            fb.pixel(tpx, tpy - 1, INK);
            fb.pixel(tpx, tpy + 1, INK);
            fb.pixel(tpx, tpy + 2, INK);
        }
    }

    /**
     * TRAILING — susun lapisan "sisa nyala".
     * Piksel yang jadi tinta frame ini → level penuh (255, solid hitam).
     * Piksel yang padam luruh FADE/frame dan dirender sebagai DITHER Bayer:
     * makin turun levelnya makin jarang titik hitamnya, sampai benar-benar
     * OFF. Hasilnya jejak memudar khas LCD — tetap hanya 2 warna.
     */
    function composeGhost() {
        if (!trail) {
            ghost.fill(0); // tanpa persistence → layar biner murni
            return;
        }
        var n = LGW * LGH;
        for (var i = 0; i < n; i++) {
            if (ink[i]) {
                ghost[i] = 255; // masih menyala → level penuh
                continue;
            }
            var lv = ghost[i];
            if (lv === 0) continue; // sudah gelap total → lewati (jalur cepat)
            lv -= FADE;
            if (lv <= 0) {
                ghost[i] = 0; // habis → piksel benar-benar OFF
                continue;
            }
            ghost[i] = lv;
            // Fase awal: bayangan MASIH PEKAT (solid hitam) — LCD memang
            // lambat mati. Sisanya baru di-dither sampai benar-benar OFF.
            var x = i % LGW;
            var y = (i - x) / LGW;
            if (lv >= SOLID_LV || lv >= BAYER_TH[((y & 3) << 2) | (x & 3)]) {
                rawPixel(x, y, INK); // bayangan (bukan tinta baru)
            }
        }
    }

    function drawScene() {
        // 1) Kaca LCD (gradient sheen) — TIDAK dihitung sebagai tinta.
        paintGlass();
        if (powerState) {
            marking = false;
            ink.fill(0);

            // 2) Scene tinta frame ini — semua lewat fb.pixel → tercatat.
            marking = true;

            // Geseran kurva (animasi garis bergerak)
            pan = PAN_AMP * Math.sin(t * PAN_SPD);

            // Kursor trace bergerak bolak-balik melintasi window
            var frac = (Math.sin(t * 0.012) + 1) / 2;
            var tx = XMIN + frac * (XMAX - XMIN);
            var ty = fnAt(tx);

            if (grid) drawGrid(); // grid titik
            drawAxes(); // sumbu + tick
            drawCurve(); // kurva fungsi
            drawTrace(tx, ty, Math.floor(t / 24) % 2 === 0); // kursor TRACE

            statusBar(); // status atas
            bottomBar(tx, ty); // status bawah

            marking = false;

            // 3) Trailing: piksel yang baru padam luruh bertahap (dither).
            composeGhost();
        }
        fb.present(); // 4) swap-buffer → canvas
    }

    // ================================================================
    // LOOP
    // ================================================================
    function frame() {
        drawScene();
        t++;
        ctx.raf(frame);
    }

    // ================================================================
    // KONTROL DARI TGA
    // ================================================================
    ctx.onMessage = function (msg) {
        var d = msg;
        if (typeof d === "string") {
            try {
                d = JSON.parse(d);
            } catch (e) {
                return;
            }
        }
        if (!d || !d.cmd) return;

        if (d.cmd === "fn") {
            var m = String(d.value || "").toUpperCase();
            if (m) mode = m;
        } else if (d.cmd === "grid") {
            grid = typeof d.value === "boolean" ? d.value : !grid;
        } else if (d.cmd === "on/off") {
            powerState = !powerState;
        } else if (d.cmd === "trail") {
            trail = typeof d.value === "boolean" ? d.value : !trail;
            if (!trail) ghost.fill(0); // langsung bersihkan sisa nyala
        }
        ctx.send({ event: "state", data: { mode: mode, grid: grid, trail: trail } });
    };

    ctx.onResize = function () {
        rebuild(); // canvas berubah ukuran → hitung ulang skala blok
    };

    ctx.onDestroy = function () {
        fb = null; // lepas buffer (RAF sudah dibatalkan runtime DDC)
    };

    // ================================================================
    // START
    // ================================================================
    rebuild();
    ctx.send({
        event: "ready",
        data: {
            width: LGW,
            height: LGH,
            scale: scale,
            physW: LGW * scale,
            trail: trail,
        },
    });
    ctx.raf(frame);
});
