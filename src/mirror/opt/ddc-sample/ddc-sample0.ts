/**
 * ddc-sample0.ts — DDC Sample #0: HELLO WORLD (paling sederhana)
 *
 * TGA (TSIX GUI App) — pasangannya: hello.js (NJ, canvas murni, TANPA Fabric).
 * Teks "Hello, TSIX!" bergeser kiri → kanan → balik lagi kanan → kiri.
 *
 * Jalankan: ddc-sample0
 */

import { Program, std, fs } from "@tsix/Application";
import { TForm, TPanel } from "@tsix/cashew";
import { mountDDC, DDCApp } from "@tsix/ddc";

export const appMode = "gui";

export const main = Program(async (_args: string[]) => {
  await std.log("=== DDC Sample 0 — Hello World ===");

  const NJ_PATH = "/opt/ddc-sample/hello.js";

  // ================================================================
  // FORM — Delphi style (sederhana: satu stage penuh)
  // ================================================================
  const form = new TForm({
    title: "DDC Sample 0 — Hello World",
    icon: "👋",
    width: 500,
    height: 100,
    maximizable: false,
    resizable: false,
  });
  form.style = { ...form.style, padding: "0", margin: "0" };
  const stage = new TPanel("stage", {
    flex: "1",
    minHeight: "0",
    padding: "0",
    overflow: "hidden",
    background: "#000",
    borderRadius: "0",
  });
  form.add(stage);

  // ================================================================
  // DDC — baca NJ dari folder yang sama, mount ke stage
  // ================================================================
  let anim: DDCApp | null = null;

  form.onSetup = async (screen) => {
    const src = (await fs.readFile(NJ_PATH)) || "";
    if (!src) {
      await std.error("[ddc-sample0] NJ tidak ditemukan: " + NJ_PATH);
    }
    anim = await mountDDC(
      screen,
      { id: "ddc-hello", source: src, width: 460, height: 160 },
      "stage",
    );
  };

  await form.run();

  // Cleanup: hentikan NJ saat form tutup (anti resource leak)
  const ddcHandle: DDCApp | null = anim as DDCApp | null;
  if (ddcHandle) await ddcHandle.destroy();
  await std.log("[ddc-sample0] Done ✅");
});
