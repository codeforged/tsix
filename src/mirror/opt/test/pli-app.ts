/**
 * pli-app.ts — Simulasi Piecewise Linear Interpolation (PLI) — Cashew + DDC
 *
 * Studi kasus menyelaraskan warna UI dengan tema aktif Asteracea:
 *   - Widget DOM memakai CSS variables (var(--accent), var(--surface), dll)
 *     → otomatis ikut light ↔ dark saat theme di-switch.
 *   - Canvas DDC (NJ = pli-plot.js) tidak bisa pakai var() → host mengirim
 *     palet warna tema via handshake "ready" → update_config.
 *   - Highlight tombol aktif bergerak real-time (accessor TComponent.style).
 *
 * Pasangan NJ: pli-plot.js (satu folder).
 *
 * Jalankan: pli-app   (atau: /opt/test/pli-app.ts)
 * (Pastikan DOME running)
 *
 * (c) 2026 TSIX Project
 */

import { Program, fs } from "@tsix/Application";
import {
    TForm,
    TLabel,
    TButton,
    TPanel,
    TGroupBox,
    TSlider, // Import TSlider dari Cashew
    HStack,
    VStack,
} from "@tsix/cashew";
import { mountDDC, DDCApp } from "@tsix/ddc";
import { theme } from "@tsix/theme";

export const appMode = "gui";

export const main = Program(async () => {
    const NJ_PATH = "/opt/test/pli-plot.js";

    // Ikuti tema aktif Asteracea (dark/light) untuk warna UI & palet canvas.
    await theme.loadCurrent();

    const form = new TForm({
        title: "Simulasi Piecewise Linear Interpolation (PLI)",
        width: 900,
        height: 750, // Menyesuaikan tinggi untuk kontrol slider
        resizable: true,
    });

    form.style = { ...form.style, color: "var(--text, #e0e0e0)" };

    let ddcApp: DDCApp | null = null;

    // --- State Aplikasi ---
    let currentProfile = "Pressure";
    let numNodes = 5;
    let resolutionRatio = 0.5; // 50% Default
    let testInput = 39.4;

    // --- WIDGET RINGKASAN DATA (METRICS) ---
    const lblTrueInput = new TLabel("lbl-true-input", {
        fontSize: "18px",
        fontWeight: "bold",
        color: "var(--text, #e0e0e0)",
    });
    lblTrueInput.caption = "39.4 kPa";

    const lblRawADC = new TLabel("lbl-raw-adc", {
        fontSize: "18px",
        fontWeight: "bold",
        color: "var(--text, #e0e0e0)",
    });
    lblRawADC.caption = "1075";

    const lblPLIPredict = new TLabel("lbl-pli-predict", {
        fontSize: "18px",
        fontWeight: "bold",
        color: "var(--accent, #4caf50)",
    });
    lblPLIPredict.caption = "41.1 kPa";

    function createMetricCard(title: string, widget: TLabel) {
        const card = new TPanel("card-" + title, {
            background: "var(--surface, #3aa82b)",
            borderRadius: "8px",
            padding: "10px 15px",
            flex: "1",
            alignItems: "center",
        });
        const lblTitle = new TLabel("lbl-t-" + title, {
            fontSize: "12px",
            color: "var(--text-muted, #888)",
            marginBottom: "4px",
        });
        lblTitle.caption = title;
        card.add(lblTitle);
        card.add(widget);
        return card;
    }

    const metricsBar = HStack(
        { gap: "12px", width: "100%", marginTop: "10px" },
        createMetricCard("True Input", lblTrueInput),
        createMetricCard("Raw ADC", lblRawADC),
        createMetricCard("PLI Predict", lblPLIPredict)
    );

    // --- TSLIDER UNTUK TEST INPUT INSPECTION ---
    const sldTestInput = new TSlider("sld-test-input", {
        value: testInput,
        min: 0,
        max: 100,
        color: theme.colors.accent || "#4caf50",
        label: "Inspection Input Value",
        unit: "kPa",
    });

    // Reaksi real-time saat slider digeser
    sldTestInput.onInput = (val) => {
        testInput = typeof val === "number" ? val : parseFloat(val);
        syncToDDC();
    };

    // --- PANEL KONTROL KARAKTERISTIK SENSOR ---
    const btnThermistor = new TButton("btn-thermistor", { width: "100px" });
    btnThermistor.caption = "Thermistor";

    const btnPressure = new TButton("btn-pressure", { width: "100px" });
    btnPressure.caption = "Pressure";

    const btnOptical = new TButton("btn-optical", { width: "100px" });
    btnOptical.caption = "Optical";

    // Helper: set state tombol (aktif/idle). Cukup assign `btn.style` —
    // accessor TComponent.style otomatis mengirim perubahan ke browser bila
    // komponen sudah di-mount (lihat bindEventHandler di cashew.ts). Sebelum
    // mount hanya mengubah state in-memory yang dipakai saat build awal.
    function setBtnState(btn: TButton, active: boolean) {
        const bg = active ? "var(--accent, #4caf50)" : "var(--surface2, #0f3460)";
        const fg = active ? "#ffffff" : "var(--text, #e0e0e0)";
        const bd = active
            ? "1px solid var(--accent, #4caf50)"
            : "1px solid var(--border, rgba(255,255,255,0.12))";

        // Merge, jangan replace — supaya lebar/padding/border-radius default
        // tombol tetap dipertahankan.
        btn.style = { ...btn.style, background: bg, color: fg, border: bd };
    }

    function updateProfileButtons() {
        setBtnState(btnThermistor, currentProfile === "Thermistor");
        setBtnState(btnPressure, currentProfile === "Pressure");
        setBtnState(btnOptical, currentProfile === "Optical");
    }
    updateProfileButtons();

    const grpProfile = TGroupBox("grp-prof", "Sensor Profile Characteristic", {
        width: "100%",
        marginTop: "10px",
    });
    grpProfile.add(
        HStack(
            { gap: "10px", justifyContent: "center", width: "100%" },
            btnThermistor,
            btnPressure,
            btnOptical
        )
    );

    // --- KONTROL KALIBRASI & WINDOW RESOLUTION ---
    const lblNodeCount = new TLabel("lbl-node-cnt", {
        fontWeight: "bold",
        color: "var(--accent, #4caf50)",
    });
    lblNodeCount.caption = "5 pts";

    const btnNodeLess = new TButton("btn-node-less", { width: "35px" });
    btnNodeLess.caption = "-";
    const btnNodeMore = new TButton("btn-node-more", { width: "35px" });
    btnNodeMore.caption = "+";

    const btnRes25 = new TButton("btn-res-25", { width: "100px" });
    btnRes25.caption = "25% Res";

    const btnRes50 = new TButton("btn-res-50", { width: "110px" });
    btnRes50.caption = "50% (Default)";

    const btnRes100 = new TButton("btn-res-100", { width: "90px" });
    btnRes100.caption = "100% Full";

    function updateResButtons() {
        setBtnState(btnRes25, resolutionRatio === 0.25);
        setBtnState(btnRes50, resolutionRatio === 0.5);
        setBtnState(btnRes100, resolutionRatio === 1.0);
    }
    updateResButtons();

    const grpControls = HStack(
        { gap: "15px", width: "100%", marginTop: "10px" },
        VStack(
            { flex: "1" },
            new TLabel("lbl-cal-nodes", {
                fontSize: "12px",
                color: "var(--text-muted, #888)",
                caption: "Calibration Nodes / Segments",
            }),
            HStack({ gap: "8px", alignItems: "center", marginTop: "4px" }, btnNodeLess, lblNodeCount, btnNodeMore)
        ),
        VStack(
            { flex: "1" },
            new TLabel("lbl-win-res", {
                fontSize: "12px",
                color: "var(--text-muted, #888)",
                caption: "Sample Segment Window Resolution",
            }),
            HStack({ gap: "6px", marginTop: "4px" }, btnRes25, btnRes50, btnRes100)
        )
    );

    // --- STAGE DDC CANVAS ---
    const ddcStage = new TPanel("ddc-stage", {
        width: "100%",
        height: "300px",
        background: "var(--bg, #0d1b2a)",
        borderRadius: "8px",
        overflow: "hidden",
    });

    const mainLayout = VStack(
        { padding: "16px", gap: "10px", width: "100%" },
        ddcStage,
        sldTestInput, // Menambahkan TSlider ke layout
        metricsBar,
        grpProfile,
        grpControls
    );

    form.add(mainLayout);

    // --- SINKRONISASI KE DDC ---
    // Petakan warna tema aktif → palet untuk canvas DDC (NJ).
    function getThemePalette() {
        const c: any = (theme as any).colors || {};
        return {
            bg: c.bg,
            grid: c.border,
            tick: c.textMuted,
            axis: c.textDim,
            accent: c.accent,
            inspect: c.success,
            ring: c.text,
            textMain: c.text,
            textSub: c.textMuted,
        };
    }

    function syncToDDC() {
        if (ddcApp) {
            void ddcApp.send({
                cmd: "update_config",
                payload: {
                    profile: currentProfile,
                    numNodes: numNodes,
                    resolutionRatio: resolutionRatio,
                    testInput: testInput,
                    palette: getThemePalette(),
                },
            });
        }
    }

    form.onSetup = async (screen) => {
        const src = (await fs.readFile(NJ_PATH)) || "";
        if (src) {
            ddcApp = await mountDDC(
                screen,
                { id: "ddc-pli", source: src, width: 860, height: 300 },
                "ddc-stage"
            );

            // Sinkronisasi balik jika user klik langsung di DDC Canvas
            ddcApp.on("on_inspect", (p: any) => {
                testInput = p.trueInput;

                // Update nilai slider & label-label ringkasan
                sldTestInput.value = testInput;
                lblTrueInput.caption = `${p.trueInput.toFixed(1)} kPa`;
                lblRawADC.caption = `${p.rawADC.toFixed(0)}`;
                lblPLIPredict.caption = `${p.pliPredict.toFixed(1)} kPa`;
            });

            // Handshake: NJ kirim "ready" setelah selesai init di browser.
            // Setelah itu baru kirim update_config — menjamin palet tema
            // tidak hilang karena NJ belum siap saat mountDDC() resolve.
            let syncedOnce = false;
            const doSync = () => {
                if (syncedOnce) return;
                syncedOnce = true;
                syncToDDC();
            };
            ddcApp.on("ready", () => {
                doSync();
            });

            // Pengaman: kalau event "ready" sudah terlewat sebelum listener
            // ini terpasang (NJ init lebih cepat dari resolveDomePid), kirim
            // konfigurasi setelah NJ dipastikan siap. Hanya sekali.
            setTimeout(doSync, 600);
        }
    };

    // --- EVENT HANDLERS ---
    btnThermistor.onClick = () => {
        currentProfile = "Thermistor";
        updateProfileButtons();
        syncToDDC();
    };

    btnPressure.onClick = () => {
        currentProfile = "Pressure";
        updateProfileButtons();
        syncToDDC();
    };

    btnOptical.onClick = () => {
        currentProfile = "Optical";
        updateProfileButtons();
        syncToDDC();
    };

    btnNodeLess.onClick = () => {
        if (numNodes > 2) {
            numNodes--;
            lblNodeCount.caption = `${numNodes} pts`;
            syncToDDC();
        }
    };

    btnNodeMore.onClick = () => {
        if (numNodes < 20) {
            numNodes++;
            lblNodeCount.caption = `${numNodes} pts`;
            syncToDDC();
        }
    };

    btnRes25.onClick = () => {
        resolutionRatio = 0.25;
        updateResButtons();
        syncToDDC();
    };

    btnRes50.onClick = () => {
        resolutionRatio = 0.5;
        updateResButtons();
        syncToDDC();
    };

    btnRes100.onClick = () => {
        resolutionRatio = 1.0;
        updateResButtons();
        syncToDDC();
    };

    // Update otomatis saat theme di-switch lewat Asteracea (light ↔ dark).
    // Widget DOM otomatis ikut via CSS var; canvas DDC di-redraw dgn palet baru.
    const lib = (global as any)._tsixLib;
    if (lib?.onEvent) {
        lib.onEvent("ipc_message", (msg: any) => {
            const ev = msg?.data || msg;
            if (ev?.type !== "THEME_CHANGED") return;
            void theme
                .load(ev.theme, ev.dir || "/opt/asteracea")
                .then(() => {
                    if (ddcApp) syncToDDC();
                });
        });
    }

    await form.run();
    if (ddcApp) await (ddcApp as DDCApp).destroy();
});