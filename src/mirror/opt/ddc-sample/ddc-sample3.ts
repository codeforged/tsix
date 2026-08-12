/**
 * ddc-sample3.ts — DDC Sample #3: THREE.JS CUBE
 *
 * TGA (TSIX GUI App) — pasangannya: threecube.js (NJ, Three.js).
 * Cube frame berputar bebas di posisi tetap. Contoh penggunaan library
 * bebas (bukan Fabric) — Three.js di-load CDN di dome-client.html,
 * tersedia sebagai global THREE.
 *
 * Jalankan: ddc-sample3
 */

import { Program, std, fs } from "@tsix/Application";
import { TForm, TPanel } from "@tsix/cashew";
import { mountDDC, DDCApp } from "@tsix/ddc";
import { theme } from "@tsix/theme";

export const appMode = "gui";

export const main = Program(async (_args: string[]) => {
  await std.log("=== DDC Sample 3 — Three.js Cube ===");

  const NJ_PATH = "/opt/ddc-sample/threecube.js";

  // ================================================================
  // FORM — Delphi style
  // ================================================================
  const form = new TForm("DDC Sample 3 — Three.js Cube", 520, 520);
  form.style = { ...form.style, padding: "0", margin: "0" };

  const stage = new TPanel("stage", {
    flex: "1",
    minHeight: "0",
    padding: "0",
    border: `1px solid ${theme.colors.border}`,
    background: "#0a0f1f",
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
      await std.error("[ddc-sample3] NJ tidak ditemukan: " + NJ_PATH);
    }
    anim = await mountDDC(
      screen,
      { id: "ddc-cube", source: src, width: 500, height: 460 },
      "stage",
    );
  };

  await form.run();

  // Cleanup: hentikan NJ saat form tutup (anti resource leak)
  const ddcHandle: DDCApp | null = anim as DDCApp | null;
  if (ddcHandle) await ddcHandle.destroy();
  await std.log("[ddc-sample3] Done ✅");
});
