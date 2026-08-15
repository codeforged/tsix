/**
 * ddc-sample5.ts — DDC Sample #5: Pixel Operation
 *
 * TGA (TSIX GUI App) — pasangannya: pixeloperation.js (NJ, canvas murni, TANPA Fabric).
 * Membuat pixel di beberapa area berikut pembuatan lingkaran dan garis pada level pixel
 *
 * Jalankan: ddc-sample5
 */

import { Program, std, fs } from "@tsix/Application";
import { TForm, TPanel } from "@tsix/cashew";
import { mountDDC, DDCApp } from "@tsix/ddc";
import { theme } from "@tsix/theme";

export const appMode = "gui";

export const main = Program(async (_args: string[]) => {
  await std.log("=== DDC Sample 5 — Fire Animation ===");

  const NJ_PATH = "/opt/ddc-sample/pixeloperation.js";

  // ================================================================
  // FORM — Delphi style
  // ================================================================
  const form = new TForm({ title: "DDC Sample 4 — Fire Animation", icon: "🔥", width: 400, height: 350 });
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
      { id: "ddc-pixel", source: src, width: 460, height: 420 },
      "stage",
    );
  };

  await form.run();

  // Cleanup: hentikan NJ saat form tutup (anti resource leak)
  const ddcHandle: DDCApp | null = anim as DDCApp | null;
  if (ddcHandle) await ddcHandle.destroy();
  await std.log("[ddc-sample4] Done ✅");
});
