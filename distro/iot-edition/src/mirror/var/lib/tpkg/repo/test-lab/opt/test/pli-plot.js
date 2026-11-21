DDC.onInit(function (ctx) {
    var W = ctx.width;
    var H = ctx.height;
    var c2 = ctx.canvas.getContext("2d");

    var state = {
        profile: "Pressure",
        numNodes: 5,
        resolutionRatio: 0.5,
        testInput: 39.4,
        xMin: 0,
        xMax: 100,
        yMin: 0,
        yMax: 4095,
        // Palet warna dari tema aktif (dikirim host). Fallback dark.
        palette: {
            bg: "#111827",
            grid: "#1f2937",
            tick: "#6b7280",
            axis: "#9ca3af",
            accent: "#2563eb",
            inspect: "#22c55e",
            ring: "#ffffff",
            textMain: "#e5e7eb",
            textSub: "#9ca3af"
        }
    };

    // --- Fungsi Matematika Kurva Respon Sensor ---
    function getIdealY(x, profile) {
        var norm = (x - state.xMin) / (state.xMax - state.xMin);
        norm = Math.max(0, Math.min(1, norm));

        if (profile === "Thermistor") {
            // Non-linear eksponensial (Steinhart-Hart / NTC-like)
            return state.yMin + (state.yMax - state.yMin) * Math.exp(-2.5 * norm);
        } else if (profile === "Pressure") {
            // Non-linear Logaritmik / Saturasi Tekanan
            return state.yMin + (state.yMax - state.yMin) * (Math.log(1 + 9 * norm) / Math.log(10));
        } else if (profile === "Optical") {
            // Kurva Sigmoid (Photodiode / Optical Density)
            var sig = 1 / (1 + Math.exp(-10 * (norm - 0.5)));
            return state.yMin + (state.yMax - state.yMin) * sig;
        }
        return state.yMin + (state.yMax - state.yMin) * norm;
    }

    // --- Interpolasi Linear (PLI) ---
    function getPLIPredict(x, nodes) {
        if (!nodes || nodes.length < 2) return getIdealY(x, state.profile);

        if (x <= nodes[0].x) return nodes[0].y;
        if (x >= nodes[nodes.length - 1].x) return nodes[nodes.length - 1].y;

        for (var i = 0; i < nodes.length - 1; i++) {
            if (x >= nodes[i].x && x <= nodes[i + 1].x) {
                var x0 = nodes[i].x, y0 = nodes[i].y;
                var x1 = nodes[i + 1].x, y1 = nodes[i + 1].y;
                return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
            }
        }
        return nodes[0].y;
    }

    function generateNodes() {
        var nodes = [];
        var count = state.numNodes;
        var activeSpan = (state.xMax - state.xMin) * state.resolutionRatio;
        var xStart = state.xMin;
        var xEnd = state.xMin + activeSpan;

        for (var i = 0; i < count; i++) {
            var xi = xStart + (i / (count - 1)) * (xEnd - xStart);
            var yi = getIdealY(xi, state.profile);
            nodes.push({ x: xi, y: yi });
        }
        return nodes;
    }

    function drawPlot() {
        c2.clearRect(0, 0, W, H);

        // Background — sesuai tema aktif
        c2.fillStyle = state.palette.bg;
        c2.fillRect(0, 0, W, H);

        var paddingLeft = 60;
        var paddingBottom = 40;
        var paddingTop = 25;
        var paddingRight = 30;

        var plotW = W - paddingLeft - paddingRight;
        var plotH = H - paddingTop - paddingBottom;

        var nodes = generateNodes();

        function toScreenX(x) {
            return paddingLeft + ((x - state.xMin) / (state.xMax - state.xMin)) * plotW;
        }
        function toScreenY(y) {
            return H - paddingBottom - ((y - state.yMin) / (state.yMax - state.yMin)) * plotH;
        }

        // 1. Grid Sumbu
        c2.strokeStyle = state.palette.grid;
        c2.lineWidth = 1;
        c2.setLineDash([]);
        c2.beginPath();

        for (var i = 0; i <= 5; i++) {
            var gx = paddingLeft + (plotW / 5) * i;
            var gy = paddingTop + (plotH / 5) * i;

            c2.moveTo(gx, paddingTop);
            c2.lineTo(gx, H - paddingBottom);

            c2.moveTo(paddingLeft, gy);
            c2.lineTo(W - paddingRight, gy);

            // Label X & Y
            c2.fillStyle = state.palette.tick;
            c2.font = "10px sans-serif";
            c2.textAlign = "center";
            var valX = state.xMin + ((state.xMax - state.xMin) / 5) * i;
            c2.fillText(valX.toFixed(0), gx, H - paddingBottom + 16);

            c2.textAlign = "right";
            var valY = state.yMax - ((state.yMax - state.yMin) / 5) * i;
            c2.fillText(valY.toFixed(0), paddingLeft - 8, gy + 3);
        }
        c2.stroke();

        // Sumbu Labels
        c2.fillStyle = state.palette.axis;
        c2.font = "11px sans-serif";
        c2.textAlign = "right";
        c2.fillText("Input (kPa / Unit)", W - paddingRight, H - 10);

        c2.textAlign = "left";
        c2.fillText("ADC Count", 12, 18);

        // 2. Kurva Ideal Kontinu (Dashed Line)
        c2.strokeStyle = state.palette.accent;
        c2.globalAlpha = 0.5;
        c2.lineWidth = 2;
        c2.setLineDash([4, 4]);
        c2.beginPath();

        var steps = 120;
        for (var j = 0; j <= steps; j++) {
            var rx = state.xMin + ((state.xMax - state.xMin) / steps) * j;
            var ry = getIdealY(rx, state.profile);
            var sx = toScreenX(rx);
            var sy = toScreenY(ry);

            if (j === 0) c2.moveTo(sx, sy);
            else c2.lineTo(sx, sy);
        }
        c2.stroke();
        c2.globalAlpha = 1.0;
        c2.setLineDash([]);

        // 3. Kurva Model Terkalibrasi PLI (Solid — warna accent tema)
        c2.strokeStyle = state.palette.accent;
        c2.lineWidth = 2.5;
        c2.beginPath();

        for (var k = 0; k < nodes.length; k++) {
            var nx = toScreenX(nodes[k].x);
            var ny = toScreenY(nodes[k].y);

            if (k === 0) c2.moveTo(nx, ny);
            else c2.lineTo(nx, ny);
        }
        c2.stroke();

        // Titik Nodes Kalibrasi
        for (var n = 0; n < nodes.length; n++) {
            var nodex = toScreenX(nodes[n].x);
            var nodey = toScreenY(nodes[n].y);

            c2.fillStyle = state.palette.accent;
            c2.beginPath();
            c2.arc(nodex, nodey, 4.5, 0, Math.PI * 2);
            c2.fill();

            c2.strokeStyle = state.palette.ring;
            c2.lineWidth = 1.5;
            c2.stroke();
        }

        // 4. Titik Inspeksi / Predict Point (Hijau)
        var testX = state.testInput;
        var rawADC = getIdealY(testX, state.profile);
        var pliVal = getPLIPredict(testX, nodes);

        var ix = toScreenX(testX);
        var iy = toScreenY(rawADC);

        // Garis Panduan Dashed (warna inspect/success tema)
        c2.strokeStyle = state.palette.inspect;
        c2.lineWidth = 1.5;
        c2.setLineDash([4, 3]);
        c2.beginPath();

        c2.moveTo(ix, H - paddingBottom);
        c2.lineTo(ix, iy);

        c2.stroke();
        c2.setLineDash([]);

        // Dot Inspeksi (warna inspect/success tema)
        c2.fillStyle = state.palette.inspect;
        c2.beginPath();
        c2.arc(ix, iy, 5.5, 0, Math.PI * 2);
        c2.fill();

        c2.strokeStyle = state.palette.ring;
        c2.lineWidth = 1.5;
        c2.stroke();

        // Legenda Atas
        c2.fillStyle = state.palette.accent;
        c2.fillRect(paddingLeft + 15, paddingTop + 10, 8, 8);
        c2.fillStyle = state.palette.textMain;
        c2.font = "11px sans-serif";
        c2.textAlign = "left";
        c2.fillText("PLI Calibrated Model", paddingLeft + 28, paddingTop + 18);

        c2.strokeStyle = state.palette.accent;
        c2.setLineDash([3, 3]);
        c2.beginPath();
        c2.moveTo(paddingLeft + 15, paddingTop + 30);
        c2.lineTo(paddingLeft + 23, paddingTop + 30);
        c2.stroke();
        c2.setLineDash([]);
        c2.fillStyle = state.palette.textSub;
        c2.fillText("--> Continuous Ideal Curve", paddingLeft + 28, paddingTop + 33);
    }

    // Interaktivitas Klik pada Canvas untuk Pindah Titik Uji
    ctx.canvas.addEventListener("click", function (evt) {
        var rect = ctx.canvas.getBoundingClientRect();
        var clickX = evt.clientX - rect.left;

        var paddingLeft = 60;
        var paddingRight = 30;
        var plotW = W - paddingLeft - paddingRight;

        var normX = (clickX - paddingLeft) / plotW;
        if (normX >= 0 && normX <= 1) {
            state.testInput = state.xMin + normX * (state.xMax - state.xMin);
            drawPlot();

            var nodes = generateNodes();
            var rawADC = getIdealY(state.testInput, state.profile);
            var pliVal = getPLIPredict(state.testInput, nodes);

            ctx.send({
                event: "on_inspect",
                data: {
                    trueInput: state.testInput,
                    rawADC: rawADC,
                    pliPredict: pliVal
                }
            });
        }
    });

    // --- Menerima Pesan dari Host (Cashew) ---
    ctx.onMessage = function (msg) {
        if (msg.cmd === "update_config") {
            state.profile = msg.payload.profile || state.profile;
            state.numNodes = msg.payload.numNodes || state.numNodes;
            state.resolutionRatio = msg.payload.resolutionRatio || state.resolutionRatio;
            if (msg.payload.testInput !== undefined) {
                state.testInput = msg.payload.testInput;
            }
            if (msg.payload.palette) {
                // Update palet warna sesuai tema aktif
                for (var key in msg.payload.palette) {
                    state.palette[key] = msg.payload.palette[key];
                }
            }
            drawPlot();

            var nodes = generateNodes();
            var rawADC = getIdealY(state.testInput, state.profile);
            var pliVal = getPLIPredict(state.testInput, nodes);

            ctx.send({
                event: "on_inspect",
                data: {
                    trueInput: state.testInput,
                    rawADC: rawADC,
                    pliPredict: pliVal
                }
            });
        }
    };

    ctx.onResize = function (w, h) {
        W = w;
        H = h;
        drawPlot();
    };

    drawPlot();

    // Kabari host bahwa NJ sudah siap — host baru mengirim update_config
    // (termasuk palet tema) setelah menerima event ini. Ini mencegah pesan
    // pertama hilang karena dikirim sebelum NJ selesai init (race condition).
    ctx.send({
        event: "ready",
        data: { width: W, height: H }
    });
});