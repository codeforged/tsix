/**
 * ddc-sample.ts — DDC (Direct Draw and Control) Sample — Cashew (Delphi-style)
 *
 * TGA (TSIX GUI App) — Bagian backend penunjang Simulasi Lubang Hitam.
 *   1. File ini (TGA)            — Di-compile oleh TSIX app runner.
 *   2. gravity-well.js (NJ)      — Animasi mekanika orbit Fabric.js di browser.
 *      Berada di folder: /opt/ddc-sample/
 */

import { Program, std, fs } from "@tsix/Application";
import { TForm, TPanel, TLabel, TButton, HStack } from "@tsix/cashew";
import { mountDDC, DDCApp } from "@tsix/ddc";
import { theme } from "@tsix/theme";

export const appMode = "gui";

export const main = Program(async (_args: string[]) => {
  await std.log("=== DDC Black Hole Gravity Simulator ===");

  // Arahkan ke berkas JavaScript simulasi gravitasi baru Anda
  const NJ_PATH = "/opt/ddc-sample/gravity-well.js"; 

  // ================================================================
  // FORM — Cashew/Delphi Flat Style
  // ================================================================
  const form = new TForm({ title: "TSIX Gravity Well — Black Hole Simulation", icon: "🕳️", width: 640, height: 480 });
  form.style = { ...form.style, padding: "0", margin: "0" };

  // --- Header Teks ---
  const lblTitle = new TLabel("lbl-title");
  lblTitle.caption = "🌌 TSIX Space Physics — Interaktif Gravity Well (Fabric.js)";
  lblTitle.style = {
    fontSize: "14px",
    fontWeight: "700",
    color: theme.colors.accent,
  }; 
  form.add(lblTitle);

  // --- Toolbar: Kontrol Fisika Makro ---
  const btnBurst = new TButton("btn-burst");
  btnBurst.caption = "🚀 Inject Particles"; // Mengganti nama burst agar lebih kontekstual

  const btnClear = new TButton("btn-clear");
  btnClear.caption = "🌀 Reset Universe"; // Mengganti nama clear menjadi reset

  const lblStatus = new TLabel("lbl-status");
  lblStatus.caption = "⏳ Menginisialisasi Medan Gravitasi...";
  lblStatus.style = {
    fontSize: "11px",
    color: theme.colors.textMuted,
    fontFamily: "monospace",
    padding: "4px 6px",
  };

  form.add(HStack({ gap: "6px", marginBottom: "6px" }, btnBurst, btnClear, lblStatus));

  // --- Stage Panel Tempat Menggambar ---
  const stage = new TPanel("stage", {
    flex: "1",
    minHeight: "0",
    padding: "0",
    border: `1px solid ${theme.colors.border}`,
    background: "#050510", // Mengubah background dasar ke biru-hitam luar angkasa
    borderRadius: "0",
    overflow: "hidden",
  });
  form.add(stage);

  // ================================================================
  // DDC Wiring & Event Listeners
  // ================================================================
  let anim: DDCApp | null = null;

  btnBurst.onClick = () => {
    if (anim) void anim.send({ cmd: "burst" }); // Mengirim trigger injeksi partikel baru
  };
  btnClear.onClick = () => {
    if (anim) void anim.send({ cmd: "clear" }); // Mengirim trigger reset sistem gravitasi tunggal
  };

  form.onSetup = async (screen) => {
    const njSource = (await fs.readFile(NJ_PATH)) || "";
    if (!njSource) {
      await std.error(
        "[ddc-sample] Gagal memuat simulasi. Berkas tidak ditemukan: " +
          NJ_PATH +
          " — Pastikan sinkronisasi VFS aman!",
      );
    }

    // Mount objek DDCApp ke container
    anim = await mountDDC(
      screen,
      { id: "ddc-stage", source: njSource, width: 620, height: 400 },
      "stage",
    );

    // --- Menangani Data Event dari NJ (Browser) ke TGA (Worker) ---
    
    // 1. Event Inisialisasi Siap
    anim.on("ready", (ev: any) => {
      lblStatus.caption = `🪐 Jaringan Siap — Grid: ${ev.width}x${ev.height} px`;
    });

    // 2. Event Pembuatan Lubang Hitam Baru hasil klik user
    anim.on("new_gravity_well", (ev: any) => {
      lblStatus.caption = `🕳️ Lubang Hitam Baru terbentuk di Koordinat: X=${ev.x}, Y=${ev.y}`;
    });

    // 3. Cadangan penanganan klik mouse standar bawaan
    anim.on("mouse", (ev: any) => {
      if (ev.type === "mousedown" || ev.type === "click") {
        lblStatus.caption = `🖱️ Klik kursor @ X=${ev.x}, Y=${ev.y}`;
      }
    });
  };

  await form.run();

  // Bersihkan memori subsistem browser saat Form ditutup
  if (anim) await anim.destroy();
  await std.log("[ddc-sample] Simulator ditutup secara aman ✅");
});
