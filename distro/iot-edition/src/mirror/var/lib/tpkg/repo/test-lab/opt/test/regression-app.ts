/**
 * regression-app.ts — Kalkulator Regresi Polinomial + DDC Cartesian Plot
 *
 * Studi kasus pola dua-file DDC (Cashew + NJ):
 *   - TGA: form Cashew (input data, pilih derajat regresi, hitung)
 *   - NJ  : regression-plot.js (canvas plot, satu folder dgn app)
 *
 * Jalankan: regression-app   (atau: /opt/test/regression-app.ts)
 * (Pastikan DOME running)
 *
 * (c) 2026 TSIX Project
 */

import { Program, fs } from "@tsix/Application";
import {
    TForm,
    TLabel,
    TButton,
    TMemo,
    TComboBox,
    TEdit,
    TGroupBox,
    TPanel,
    HStack,
} from "@tsix/cashew";
import { mountDDC, DDCApp } from "@tsix/ddc";

export const appMode = "gui";

// Eliminasi Gauss-Jordan
function solveLinearSystem(A: number[][], B: number[]): number[] {
    const n = A.length;
    const M: number[][] = A.map((row, i) => [...row, B[i]]);

    for (let i = 0; i < n; i++) {
        let maxRow = i;
        for (let k = i + 1; k < n; k++) {
            if (Math.abs(M[k][i]) > Math.abs(M[maxRow][i])) maxRow = k;
        }
        [M[i], M[maxRow]] = [M[maxRow], M[i]];

        if (Math.abs(M[i][i]) < 1e-12) {
            throw new Error("Matriks singular atau data kurang bervariasi.");
        }

        for (let k = i + 1; k < n; k++) {
            const c = -M[k][i] / M[i][i];
            for (let j = i; j <= n; j++) {
                if (i === j) M[k][j] = 0;
                else M[k][j] += c * M[i][j];
            }
        }
    }

    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
        let sum = M[i][n];
        for (let j = i + 1; j < n; j++) sum -= M[i][j] * x[j];
        x[i] = sum / M[i][i];
    }
    return x;
}

function calculatePolynomialRegression(
    xData: number[],
    yData: number[],
    degree: number,
) {
    const n = xData.length;
    const m = degree + 1;

    const A: number[][] = Array.from({ length: m }, () => new Array(m).fill(0));
    const B: number[] = new Array(m).fill(0);

    for (let i = 0; i < m; i++) {
        for (let j = 0; j < m; j++) {
            let sum = 0;
            for (let k = 0; k < n; k++) sum += Math.pow(xData[k], i + j);
            A[i][j] = sum;
        }
        let sumY = 0;
        for (let k = 0; k < n; k++) sumY += yData[k] * Math.pow(xData[k], i);
        B[i] = sumY;
    }

    const coeffs = solveLinearSystem(A, B);

    const predict = (x: number): number => {
        return coeffs.reduce((acc, c, idx) => acc + c * Math.pow(x, idx), 0);
    };

    const meanY = yData.reduce((a, b) => a + b, 0) / n;
    let ssTot = 0;
    let ssRes = 0;

    for (let i = 0; i < n; i++) {
        const yPred = predict(xData[i]);
        ssTot += Math.pow(yData[i] - meanY, 2);
        ssRes += Math.pow(yData[i] - yPred, 2);
    }

    const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;

    return { coeffs, r2, predict };
}

export const main = Program(async () => {
    const NJ_PATH = "/opt/test/regression-plot.js";

    const form = new TForm({
        title: "Kalkulator Regresi + DDC Cartesian Plot",
        width: 920,
        height: 620,
        resizable: true,
    });

    form.style = { ...form.style, color: "#f8fafc" };

    let ddcApp: DDCApp | null = null;
    let currentPredictFn: ((x: number) => number) | null = null;

    // --- PANEL KIRI: INPUT DATA ---
    const grpInput = TGroupBox("grp-input", "=Ë Input & Kontrol", {
        width: "320px",
        height: "450px",
        marginRight: "10px",
    });

    const memoData = new TMemo("memo-data");
    memoData.rows = 8;
    memoData.text = "1, 5\n2, 8\n3, 9\n4, 13\n5, 15\n6, 15.5";
    memoData.style = {
        background: "#1e293b",
        color: "#f8fafc",
        fontFamily: "monospace",
    };

    const cmbType = new TComboBox("cmb-type");
    cmbType.items = [
        "Pilih Tipe Regresi",
        "Linear (Derajat 1)",
        "Kuadratik (Derajat 2)",
        "Kubik (Derajat 3)",
    ];
    cmbType.selectedIndex = 0;
    cmbType.onChange = () => {
        btnCalc.onClick();
    };

    const btnCalc = new TButton("btn-calc", {
        marginTop: "10px",
    });
    btnCalc.caption = "¡ Hitung & Plot DDC";

    const edtXTest = new TEdit("edt-xtest", {
        marginTop: "10px",
    });
    edtXTest.placeholder = "Nilai X...";
    edtXTest.text = "3.5";

    const btnPredict = new TButton("btn-predict", {
        marginTop: "8px",
    });
    btnPredict.caption = "=. Hitung Y";

    const lblPredictResult = new TLabel("lbl-pred-res");
    lblPredictResult.caption = "Hasil Y: -";
    lblPredictResult.style = {
        marginTop: "8px",
        marginLeft: "10px",
        fontWeight: "bold",
        color: "#38bdf8",
    };

    grpInput.add(memoData);
    grpInput.add(cmbType);
    grpInput.add(btnCalc);
    grpInput.add(new TLabel("lbl-gap", { marginTop: "10px" }));
    grpInput.add(edtXTest);
    grpInput.add(btnPredict);
    grpInput.add(lblPredictResult);

    // --- PANEL KANAN: DDC CANVAS & RINGKASAN ---
    const grpHasil = TGroupBox("grp-hasil", "=È Grafik Cartesian & Analisis", {
        width: "320px",
        height: "450px",
        flex: "1",
    });

    const ddcStage = new TPanel("ddc-stage", {
        width: "100%",
        height: "280px",
        background: "#0f172a",
        borderRadius: "6px",
        overflow: "hidden",
    });

    const memoOutput = new TMemo("memo-output");
    memoOutput.rows = 6;
    memoOutput.text = "Klik 'Hitung & Plot DDC' untuk memproses.";
    memoOutput.style = {
        background: "#1e293b",
        color: "#34d399",
        fontFamily: "monospace",
        marginTop: "10px",
    };

    grpHasil.add(ddcStage);
    grpHasil.add(memoOutput);

    form.add(HStack({ padding: "12px" }, grpInput, grpHasil));

    form.onSetup = async (screen) => {
        const src = (await fs.readFile(NJ_PATH)) || "";
        if (src) {
            ddcApp = await mountDDC(
                screen,
                { id: "ddc-regression", source: src, width: 500, height: 280 },
                "ddc-stage",
            );
        }
    };

    // LOGIKA HITUNG & KIRIM KE DDC
    btnCalc.onClick = () => {
        try {
            const lines = memoData.text.split("\n");
            const xData: number[] = [];
            const yData: number[] = [];

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                const parts = trimmed.split(/[\s,]+/);
                if (parts.length >= 2) {
                    const x = parseFloat(parts[0]);
                    const y = parseFloat(parts[1]);
                    if (!isNaN(x) && !isNaN(y)) {
                        xData.push(x);
                        yData.push(y);
                    }
                }
            }

            const degree = cmbType.selectedIndex;
            if (xData.length < degree + 1) {
                memoOutput.text = `  Minimal ${degree + 1} data untuk derajat ${degree}.`;
                return;
            }

            const { coeffs, r2, predict } = calculatePolynomialRegression(
                xData,
                yData,
                degree,
            );
            currentPredictFn = predict;

            // Gunakan `void` tanpa `await` agar event handler tidak stuck/lock
            if (ddcApp) {
                void ddcApp.send({
                    cmd: "update_regression",
                    payload: { xData, yData, degree, coeffs },
                });
            }

            let eqStr = "Y = ";
            coeffs.forEach((c, idx) => {
                const sign = c >= 0 && idx > 0 ? " + " : idx > 0 ? " - " : "";
                const val = Math.abs(c).toFixed(4);
                if (idx === 0) eqStr += `${c.toFixed(4)}`;
                else if (idx === 1) eqStr += `${sign}${val}X`;
                else eqStr += `${sign}${val}X^${idx}`;
            });

            memoOutput.text = `=== PERSAMAAN REGRESI ===\n${eqStr}\n\nR² = ${r2.toFixed(6)} (${(r2 * 100).toFixed(2)}%)\nn  = ${xData.length} sampel`;
        } catch (err: any) {
            memoOutput.text = `L Error: ${err.message}`;
        }
    };

    btnPredict.onClick = () => {
        if (!currentPredictFn) return;
        const xVal = parseFloat(edtXTest.text);
        if (!isNaN(xVal)) {
            const yVal = currentPredictFn(xVal);
            lblPredictResult.caption = `Hasil Y: ${yVal.toFixed(6)}`;

            // Kirim titik prediksi ke DDC untuk diplot
            if (ddcApp) {
                void ddcApp.send({
                    cmd: "set_predict_point",
                    payload: { x: xVal, y: yVal },
                });
            }
        }
    };

    await form.run();

    if (ddcApp) await (ddcApp as DDCApp).destroy();
});
