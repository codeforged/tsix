/**
 * ddc-sample.ts — DDC (Direct Draw and Control) Sample — Cashew (Delphi-style)
 *
 * TGA (TSIX GUI App) — bagian PERTAMA dari pola 2 file DDC:
 *   1. File ini (TGA)     — dibungkus Cashew (TForm/TButton/TPanel, gaya Delphi)
 *   2. particles.js (NJ)  — animasi Fabric.js, jalan 100% di browser.
 *      Berada SATU FOLDER dengan TGA ini: /opt/ddc-sample/
 *
 *   TGA (Worker) ──DDC_MSG──► DOME ──► Browser: NJ.onMessage()
 *   NJ (Browser)  ──ddc_event──► DOME ──► TGA: DDCApp.on()
 *
 * Jalankan: ddc-sample (atau dari menu Asteracea)
 * PASTIKAN DOME SUDAH RUNNING: dome
 */

import { Program, std, fs } from "@tsix/Application";
import { TForm, TPanel, TLabel, TButton, HStack } from "@tsix/cashew";
import { mountDDC, DDCApp } from "@tsix/ddc";
import { theme } from "@tsix/theme";

export const appMode = "gui";

export const main = Program(async (_args: string[]) => {
  await std.log("=== DDC Sample (Cashew) ===");

  // NJ berdekatan dengan TGA — satu folder: /opt/ddc-sample/
  const NJ_PATH = "/opt/ddc-sample/particles.js";

  // ================================================================
  // FORM — Delphi style (flat, no nested declarative DOM!)
  // ================================================================
  const form = new TForm({ title: "DDC Sample — Fabric Particles", icon: "🎨", width: 640, height: 480 });
  form.style = { ...form.style, padding: "0", margin: "0" };
  // --- Header ---
  const lblTitle = new TLabel("lbl-title");
  lblTitle.caption = "🦋 DDC — Fabric Particles (Native JS di browser)";
  lblTitle.style = {
    fontSize: "14px",
    fontWeight: "700",
    color: theme.colors.accent,
  }; 
  form.add(lblTitle);

  // --- Toolbar: Burst + Clear + Status ---
  const btnBurst = new TButton("btn-burst");
  btnBurst.caption = "💥 Burst";

  const btnClear = new TButton("btn-clear");
  btnClear.caption = "🧹 Clear";

  const lblStatus = new TLabel("lbl-status");
  lblStatus.caption = "⏳ NJ belum ready...";
  lblStatus.style = {
    fontSize: "11px",
    color: theme.colors.textMuted,
    fontFamily: "monospace",
    padding: "4px 6px",
  };

    
  form.add(HStack({ gap: "6px", marginBottom: "6px" }, btnBurst, btnClear, lblStatus));

  // --- Stage: tempat DDC di-mount ---
  const stage = new TPanel("stage", {
    flex: "1",
    minHeight: "0",
    padding: "0",
    border: `1px solid ${theme.colors.border}`,
    background: "#000",
    borderRadius: "0",
    overflow: "hidden",
  });
  form.add(stage);

  // ================================================================
  // DDC — wiring di onSetup (screen sudah ada saat form.run())
  // ================================================================
  let anim: DDCApp | null = null;

  btnBurst.onClick = () => {
    if (anim) void anim.send({ cmd: "burst" });
  };
  btnClear.onClick = () => {
    if (anim) void anim.send({ cmd: "clear" });
  };

  form.onSetup = async (screen) => {
    const njSource = (await fs.readFile(NJ_PATH)) || "";
    if (!njSource) {
      await std.error(
        "[ddc-sample] NJ source tidak ditemukan: " +
          NJ_PATH +
          " — jalankan sync-vfs dulu!",
      );
    }

    anim = await mountDDC(
      screen,
      { id: "ddc-stage", source: njSource, width: 620, height: 400 },
      "stage",
    );

    // NJ → TGA
    anim.on("ready", (ev: any) => {
      lblStatus.caption = `✅ NJ ready — ${ev.circles} circles @ ${ev.width}x${ev.height}`;
    });
    anim.on("click", (ev: any) => {
      lblStatus.caption = `🖱️ click @ ${ev.x},${ev.y}`;
    });
    anim.on("count", (ev: any) => {
      lblStatus.caption = `⏺️ particles: ${ev}`;
    });
    anim.on("mouse", (ev: any) => {
      if (ev.type === "mousedown" || ev.type === "click") {
        lblStatus.caption = `🖱️ ${ev.type} @ ${ev.x},${ev.y} (btn ${ev.button})`;
      }
    });
  };

  await form.run();

  // Cleanup: hentikan NJ saat form tutup
  if (anim) await anim.destroy();
  await std.log("[ddc-sample] Done ✅");
});
