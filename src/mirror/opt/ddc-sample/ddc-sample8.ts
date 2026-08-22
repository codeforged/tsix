/**
 * blackhole3d.ts — DDC (Direct Draw and Control) — Cashew Component
 *
 * TGA (TSIX GUI App) — Backend dengan Kontrol Slider untuk Tuning Parameter 3D.
 */

import { Program, std, fs } from "@tsix/Application";
import { TForm, TPanel, TLabel, TButton, TGroupBox, TFlowPanel, TSlider, HStack } from "@tsix/cashew";
import { mountDDC, DDCApp } from "@tsix/ddc";
import { theme } from "@tsix/theme";

export const appMode = "gui";

export const main = Program(async (_args: string[]) => {
  await std.log("=== Mengaktifkan Subsistem 3D Space TGA dengan Slider ===");
 
  const NJ_PATH = "/opt/ddc-sample/blackhole3d.js";

  // ================================================================
  // FORM INTERFACE — Delphi-Style Window Generator
  // ================================================================
  const form = new TForm({ title: "3D Space Simulation — Tuning Control", icon: "🚀", width: 680, height: 580 });
  form.style = { ...form.style, padding: "0", margin: "0" };

  // --- Header Atas ---
  const lblTitle = new TLabel("lbl-title");
  lblTitle.caption = "☄️ TSIX WebGL — 3D Space Tuning Controls";
  lblTitle.style = {
    fontSize: "13px",
    fontWeight: "700",
    color: theme.colors.accent,
  }; 
  form.add(lblTitle);

  // --- Indikator Log Informasi ---
  const lblStatus = new TLabel("lbl-status");
  lblStatus.caption = "⏳ Memuat modul WebGL 3D...";
  lblStatus.style = {
    fontSize: "11px",
    color: theme.colors.textMuted,
    fontFamily: "monospace",
    padding: "4px 8px",
  };
  form.add(HStack({ gap: "4px", marginBottom: "4px" }, lblStatus));

  // ================================================================
  // TUNING SLIDERS GROUP (Mengikuti Pola TGroupBox Anda)
  // ================================================================
//   const tuningGroup = new TGroupBox("grp-tuning", "🎚️ Physics Tuning System", {
//     marginBottom: "8px",
//     padding: "8px"
//   });

  const sliderRow = TFlowPanel("slider-row", { gridColumn: "1 / -1" });
//   tuningGroup.add(sliderRow);

  // Slider 1: Kekuatan Gravitasi / Massa Black Hole
  const massSlider = new TSlider("mass-slider", {
    value: 100, min: 10, max: 300, color: "#ff2a85",
    label: "Black Hole Mass", unit: "G"
  });

  // Slider 2: Kecepatan Simulasi Kosmik 
  const speedSlider = new TSlider("speed-slider", {
    value: 100, min: 10, max: 250, color: "#00e5ff",
    label: "Simulation Speed", unit: "%"
  });

  // Slider 3: Particles count
  const particleCountSlider = new TSlider("particle-count-slider", {
    value: 100, min: 10, max: 2000, color: "#58ff16",
    label: "Particle Count", unit: "%"
  });

  sliderRow.add(massSlider);
  sliderRow.add(speedSlider);
  sliderRow.add(particleCountSlider);
  form.add(sliderRow);

  // --- Stage Render Panel 3D ---
  const stage = new TPanel("stage", {
    flex: "1",
    minHeight: "0",
    padding: "0",
    border: `1px solid ${theme.colors.border}`,
    background: "#020205",
    borderRadius: "0",
    overflow: "hidden",
  });
  form.add(stage);

  let anim: DDCApp | null = null;

  // Hubungkan event interaksi slider saat diinput oleh user
  massSlider.onInput = (val) => {
    lblStatus.caption = `🕳️ Gravitasi Diubah: ${Math.round(val)} G`;
    if (anim) void anim.send({ cmd: "update_mass", value: val }); // Kirim nilai ke NJ
  };

  speedSlider.onInput = (val) => {
    lblStatus.caption = `⚡ Warp Speed: ${Math.round(val)}%`;
    if (anim) void anim.send({ cmd: "update_speed", value: val / 100 }); // Kirim pengali kecepatan ke NJ
  };

  particleCountSlider.onInput = (val) => {
    lblStatus.caption = `🌌 Partikel: ${Math.round(val*20)}`;
    if (anim) void anim.send({ cmd: "update_particles", value: val }); // Kirim jumlah partikel ke NJ
  }

  form.onSetup = async (screen) => {
    const njSource = (await fs.readFile(NJ_PATH)) || "";
    if (!njSource) {
      await std.error("[3d-sample] Berkas logika javascript tidak ditemukan!");
    }

    anim = await mountDDC(
      screen,
      { id: "ddc-3d-stage", source: njSource, width: 660, height: 380 },
      "stage",
    );

    anim.on("ready", (ev: any) => {
      lblStatus.caption = `✅ WebGL Ready — Merender ${ev.count} Partikel dalam Ruang XYZ 3D`;
    });
  };

  await form.run();

  if (anim) await anim.destroy();
  await std.log("[3d-sample] Selesai membersihkan pipeline grafis 3D ✅");
});
