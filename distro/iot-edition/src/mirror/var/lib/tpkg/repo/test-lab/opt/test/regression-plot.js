DDC.onInit(function (ctx) {
    var W = ctx.width;
    var H = ctx.height;
    var c2 = ctx.canvas.getContext("2d");

    var state = {
        xData: [],
        yData: [],
        degree: 1,
        coeffs: [],
        testPoint: null, // { x: number, y: number }
    };

    function predict(x, coeffs) {
        var sum = 0;
        for (var i = 0; i < coeffs.length; i++) {
            sum += coeffs[i] * Math.pow(x, i);
        }
        return sum;
    }

    function drawPlot() {
        c2.clearRect(0, 0, W, H);
        c2.fillStyle = "#0f172a";
        c2.fillRect(0, 0, W, H);

        if (!state.xData || state.xData.length === 0) {
            c2.fillStyle = "#64748b";
            c2.font = "14px sans-serif";
            c2.textAlign = "center";
            c2.fillText("Masukkan data dan klik 'Hitung & Plot DDC'", W / 2, H / 2);
            return;
        }

        var padding = 45;
        var plotW = W - padding * 2;
        var plotH = H - padding * 2;

        var minX = Math.min.apply(null, state.xData);
        var maxX = Math.max.apply(null, state.xData);
        var minY = Math.min.apply(null, state.yData);
        var maxY = Math.max.apply(null, state.yData);

        // Termasuk testPoint dalam bounding box jika ada
        if (state.testPoint) {
            minX = Math.min(minX, state.testPoint.x);
            maxX = Math.max(maxX, state.testPoint.x);
            minY = Math.min(minY, state.testPoint.y);
            maxY = Math.max(maxY, state.testPoint.y);
        }

        var spanX = maxX - minX || 1;
        var spanY = maxY - minY || 1;
        minX -= spanX * 0.1;
        maxX += spanX * 0.1;
        minY -= spanY * 0.1;
        maxY += spanY * 0.1;

        function toScreenX(x) {
            return padding + ((x - minX) / (maxX - minX)) * plotW;
        }
        function toScreenY(y) {
            return H - padding - ((y - minY) / (maxY - minY)) * plotH;
        }

        // 1. Grid & Sumbu
        c2.strokeStyle = "#1e293b";
        c2.lineWidth = 1;
        c2.setLineDash([]);
        c2.beginPath();

        for (var i = 0; i <= 5; i++) {
            var gx = padding + (plotW / 5) * i;
            var gy = padding + (plotH / 5) * i;

            c2.moveTo(gx, padding);
            c2.lineTo(gx, H - padding);

            c2.moveTo(padding, gy);
            c2.lineTo(W - padding, gy);

            c2.fillStyle = "#94a3b8";
            c2.font = "10px sans-serif";
            c2.textAlign = "center";
            var valX = minX + ((maxX - minX) / 5) * i;
            c2.fillText(valX.toFixed(1), gx, H - padding + 15);

            c2.textAlign = "right";
            var valY = maxY - ((maxY - minY) / 5) * i;
            c2.fillText(valY.toFixed(1), padding - 8, gy + 3);
        }
        c2.stroke();

        // 2. Plot Kurva Regresi
        if (state.coeffs && state.coeffs.length > 0) {
            c2.strokeStyle = "#00e5ff";
            c2.lineWidth = 2.5;
            c2.beginPath();

            var steps = 100;
            for (var j = 0; j <= steps; j++) {
                var rx = minX + ((maxX - minX) / steps) * j;
                var ry = predict(rx, state.coeffs);
                var sx = toScreenX(rx);
                var sy = toScreenY(ry);

                if (j === 0) c2.moveTo(sx, sy);
                else c2.lineTo(sx, sy);
            }
            c2.stroke();
        }

        // 3. Titik Sampel (Scatter Points)
        for (var k = 0; k < state.xData.length; k++) {
            var px = toScreenX(state.xData[k]);
            var py = toScreenY(state.yData[k]);

            c2.fillStyle = "#ff2a85";
            c2.beginPath();
            c2.arc(px, py, 5, 0, Math.PI * 2);
            c2.fill();

            c2.strokeStyle = "#ffffff";
            c2.lineWidth = 1.5;
            c2.stroke();
        }

        // 4. Plot Titik Prediksi & Garis Dashed (Kuning)
        if (state.testPoint) {
            var tx = toScreenX(state.testPoint.x);
            var ty = toScreenY(state.testPoint.y);

            // Garis vertikal & horizontal dashed
            c2.strokeStyle = "#facc15";
            c2.lineWidth = 1.5;
            c2.setLineDash([5, 4]);
            c2.beginPath();

            // Dari sumbu X ke titik
            c2.moveTo(tx, H - padding);
            c2.lineTo(tx, ty);

            // Dari sumbu Y ke titik
            c2.moveTo(padding, ty);
            c2.lineTo(tx, ty);

            c2.stroke();
            c2.setLineDash([]); // Reset line dash

            // Titik prediksi berwarna kuning
            c2.fillStyle = "#facc15";
            c2.beginPath();
            c2.arc(tx, ty, 6, 0, Math.PI * 2);
            c2.fill();

            c2.strokeStyle = "#000000";
            c2.lineWidth = 1.5;
            c2.stroke();
        }
    }

    // --- RECEIVE MESSAGES FROM CASHEW ---
    ctx.onMessage = function (msg) {
        if (msg.cmd === "update_regression") {
            state = msg.payload;
            state.testPoint = null; // reset test point saat data baru dihitung
            drawPlot();
        } else if (msg.cmd === "set_predict_point") {
            state.testPoint = msg.payload;
            drawPlot();
        }
    };

    ctx.onResize = function (w, h) {
        W = w;
        H = h;
        drawPlot();
    };

    drawPlot();
});
