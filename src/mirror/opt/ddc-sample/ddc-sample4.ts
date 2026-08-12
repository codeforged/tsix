/**
 * ddc-sample4.ts — DDC Sample #4: ANIMASI API
 *
 * TGA (TSIX GUI App) — pasangannya: fire.js (NJ, canvas murni, TANPA Fabric).
 * Efek api berbasis partikel: sumber di bawah tengah, nyala naik & mendingin
 * (kuning → oranye → merah). Jalan 100% di browser — zero WS per-frame.
 *
 * Jalankan: ddc-sample4
 */

import { Program, std, fs } from "@tsix/Application";
import { TForm, TPanel } from "@tsix/cashew";
import { mountDDC, DDCApp } from "@tsix/ddc";
import { theme } from "@tsix/theme";

export const appMode = "gui";

export const main = Program(async (_args: string[]) => {
  await std.log("=== DDC Sample 4 — Fire Animation ===");

  const NJ_PATH = "/opt/ddc-sample/fire.js";

  // ================================================================
  // FORM — Delphi style
  // ================================================================
  const form = new TForm("DDC Sample 4 — Fire Animation", 800, 400);
  // Full-bleed: hilangkan padding default TForm (12px) yang bikin frame di tepi
  form.style = { ...form.style, padding: "0", margin: "0" };

  const stage = new TPanel("stage", {
    flex: "1",
    minHeight: "0",
    padding: "0",
    margin: "0",
    border: "none", // hapus border — panel full tanpa garis
    background: "#0a0a0a", // gelap biar api keliatan jelas
    borderRadius: "0",
    overflow: "hidden",
  });
  form.add(stage);

  // ================================================================
  // DDC — baca NJ dari folder yang sama, mount ke stage
  // ================================================================
  let anim: DDCApp | null = null;

  form.onSetup = async (screen) => {
    const src = (await fs.readFile(NJ_PATH)) || "";
    if (!src) {
      await std.error("[ddc-sample4] NJ tidak ditemukan: " + NJ_PATH);
    }
    anim = await mountDDC(
      screen,
      { id: "ddc-fire", source: src, width: 460, height: 420 },
      "stage",
    );
  };

  await form.run();

  // Cleanup: hentikan NJ saat form tutup (anti resource leak)
  const ddcHandle: DDCApp | null = anim as DDCApp | null;
  if (ddcHandle) await ddcHandle.destroy();
  await std.log("[ddc-sample4] Done ✅");
});
