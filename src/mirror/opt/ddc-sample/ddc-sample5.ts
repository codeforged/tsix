/**
 * ddc-sample5.ts — DDC Sample #5: 3D WALK (Cashew, Delphi-style)
 *
 * TGA (TSIX GUI App) — bagian pertama dari pola 2 file DDC.
 * NJ-nya: walk.js (Three.js, jalan 100% di browser).
 *
 * - Humanoid kotak-kotak prosedural, gerak WASD/Panah.
 * - Suara langkah kaki (footstep.wav) via ResourceBank + PLAY_SOUND.
 * - Peta bangunan kotak + posisi player dari level.json via ResourceBank.
 *
 * Jalankan: ddc-sample5
 */

import { Program, std, fs, shell } from "@tsix/Application";
import { TForm, TPanel, TLabel } from "@tsix/cashew";
import { mountDDC, DDCApp } from "@tsix/ddc";
import { ResourceBank } from "@tsix/resbank";
import { theme } from "@tsix/theme";

export const appMode = "gui";

export const main = Program(async (_args: string[]) => {
  await std.log("=== DDC Sample 5 — 3D Walk ===");

  const NJ_PATH = "/opt/ddc-sample/walk.js";
  const DOME_UUID = "da8711c2-5ca9-4f00-ad13-f1226f95594c";

  // ================================================================
  // FORM
  // ================================================================
  const form = new TForm({
    title: "DDC Sample 5 — 3D Walk",
    width: 640,
    height: 480,
    frameless: false,
  });
  form.style = { ...form.style, padding: "0", margin: "0" };

  const lblStatus = new TLabel("lbl-status");
  lblStatus.caption =
    "🚶 W/S/A/D jalan (relatif) • Mouse: arah • 🦶 langkah • V: ganti mode kamera";
  lblStatus.style = {
    fontSize: "11px",
    color: theme.colors.textMuted,
    fontFamily: "monospace",
  };
  form.add(lblStatus);

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

  let anim: DDCApp | null = null;

  // ================================================================
  // DDC + ResourceBank — wiring di onSetup
  // ================================================================
  form.onSetup = async (screen) => {
    // ResourceBank: kirim peta (level.json) + suara langkah (footstep.wav)
    // SEKALI ke browser. NJ tinggal resBank.getResource("LEVEL").
    const resBank = new ResourceBank({ wid: screen.wid, domeUuid: DOME_UUID });
    resBank.register("LEVEL", "/opt/ddc-sample/level.json", "json");
    resBank.register("STEP", "/opt/ddc-sample/footstep.wav", "sfx", {
      mime: "audio/wav",
    });
    await resBank.loadAll();
    const widPrefix = screen.wid + ":"; // key cache browser: "<wid>:<nama>"

    const njSource = (await fs.readFile(NJ_PATH)) || "";
    if (!njSource) {
      await std.error(
        "[ddc-sample5] NJ source tidak ditemukan: " +
          NJ_PATH +
          " — jalankan sync-vfs dulu!",
      );
    }

    anim = await mountDDC(
      screen,
      { id: "ddc-walk", source: njSource, width: 620, height: 440 },
      "stage",
    );

    anim.on("ready", (ev: any) => {
      lblStatus.caption = `✅ 3D Walk ready — ${ev.width}x${ev.height}`;
    });
    // Langkah kaki: NJ kirim "step" → play footstep dari cache ResourceBank
    anim.on("sound", async (ev: any) => {
      if (ev === "step")
        await shell
          .send(DOME_UUID, { type: "PLAY_SOUND", name: widPrefix + "STEP" })
          .catch(() => {});
    });
  };

  await form.run();

  // Cleanup
  const ddcHandle: DDCApp | null = anim as DDCApp | null;
  if (ddcHandle) await ddcHandle.destroy();
  await std.log("[ddc-sample5] Done ✅");
});
