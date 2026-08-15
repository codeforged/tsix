/**
 * ddc-sample2.ts — DDC Sample #2: BALLOON POP (Cashew, Delphi-style)
 *
 * TGA (TSIX GUI App) — bagian pertama dari pola 2 file DDC.
 * NJ-nya: balloons.js (animasi game, jalan 100% di browser).
 * Berada SATU FOLDER dengan TGA ini: /opt/ddc-sample/
 *
 * Game:
 *   - Balon 10-20px warna-warni dari atas-tengah, turun pelan
 *   - Panah kiri/kanan → gerakkan segitiga (player)
 *   - Spasi → tembak peluru ke atas
 *   - Peluru kena balon → balon pecah (explosion)
 *   - Score di kanan atas (di-canvas) + status di TGA
 *
 * Jalankan: ddc-sample2
 */

import { Program, std, fs, shell } from "@tsix/Application";
import { TForm, TPanel, TLabel, TButton, HStack, Spacer } from "@tsix/cashew";
import { mountDDC, DDCApp } from "@tsix/ddc";
import { ResourceBank } from "@tsix/resbank";
import { theme } from "@tsix/theme";
import { joystick } from "@tsix/joystickLib";

export const appMode = "gui";

export const main = Program(async (_args: string[]) => {
  await std.log("=== DDC Sample 2 — Balloon Pop ===");

  const NJ_PATH = "/opt/ddc-sample/balloons.js";
  const HS_PATH = "/opt/ddc-sample/highscore.txt"; // satu folder sama app

  // ================================================================
  // CONTOH BACA FILE: load high score persistent dari disk.
  // Kalau file belum ada (run pertama) → langsung buat dengan default 0.
  // ================================================================
  let persistedHigh = 0;
  let hsExists = true;
  try {
    const raw = await fs.readFile(HS_PATH);
    if (raw) {
      const n = parseInt(String(raw).trim(), 10);
      if (!isNaN(n)) persistedHigh = n;
    } else {
      hsExists = false; // readFile balikin null = file belum ada
    }
  } catch (e: any) {
    // readFile bisa throw "File not found" → anggap file belum ada
    hsExists = false;
  }
  if (!hsExists) {
    try {
      await fs.writeFile(HS_PATH, "0"); // buat file high score default
      await std.log("[ddc-sample2] High score file dibuat (default 0): " + HS_PATH);
    } catch (e2: any) {
      await std.error(
        "[ddc-sample2] Gagal buat file high score: " + (e2?.message || e2),
      );
    }
  }
  await std.log(`[ddc-sample2] High score dari disk: ${persistedHigh}`);

  // ================================================================
  // CONTOH TULIS FILE: simpan high score ke disk
  // ================================================================
  async function persistHighScore(v: number) {
    try {
      await fs.writeFile(HS_PATH, String(v));
      await std.log(`[ddc-sample2] High score disimpan: ${v}`);
    } catch (e: any) {
      await std.error(
        "[ddc-sample2] Gagal simpan high score: " + (e?.message || e),
      );
    }
  }

  // ================================================================
  // CONTOH SOUND FX: mainkan MP3 via DOME (pola PLAY_SOUND ala Asteracea)
  //   TGA baca file MP3 → base64 → shell.send(DOME_UUID, PLAY_SOUND)
  //   → DOME relay → browser new Audio(...).play()
  // ================================================================
  const DOME_UUID = "da8711c2-5ca9-4f00-ad13-f1226f95594c";

  // ================================================================
  // CONTOH ResourceBank — abstraksi resource server→browser:
  //   - TGA daftarkan resource (sfx/texture/text/json/bin) → load SEKALI
  //     → ResourceBank kirim RES_LOAD ke browser (cache per-window).
  //   - NJ/client tinggal pakai: ctx.resBank.getResource("laser") dst.
  //   - Di sini dipakai untuk audio game (play cukup kirim nama → hemat WS).
  // ================================================================


  // Handle DDC — di-assign di onSetup; dipakai tombol New Game & cleanup.
  let anim: DDCApp | null = null;

  // Joystick bridge (kernel /dev/joystick → NJ): polling di TGA,
  // forward ke NJ via DDC_MSG. A0 = gerak kiri/kanan, B16 = fire.
  let joyTimer: ReturnType<typeof setInterval> | null = null;
  let joyConnected = false;

  // ================================================================
  // FORM — Delphi style
  // ================================================================
  const form = new TForm({ title: "DDC Sample 2 — Balloon Pop", icon: "🎈", width: 560, height: 560 });
  form.style = { ...form.style, padding: "0", margin: "0" };

  // --- Header ---
  const lblTitle = new TLabel("lbl-title");
  lblTitle.caption = "🎈 DDC — Balloon Pop (Cashew + Fabric)";
  lblTitle.style = {
    fontSize: "14px",
    fontWeight: "700",
    color: theme.colors.accent,
  };
  form.add(lblTitle);

  // --- Hint kontrol ---
  const lblHint = new TLabel("lbl-hint");
  lblHint.caption = "⬅️➡️ gerak | Spasi tembak | 5 nyawa | +10 pecah / -5 lolos";
  lblHint.style = {
    fontSize: "11px",
    color: theme.colors.textMuted,
    fontFamily: "monospace",
  };

  // Tombol New Game — DI LUAR panel DDC (TButton Cashew).
  // Contoh interaksi komponen TGA dengan logic game (NJ):
  // klik → anim.send({ cmd: "newGame" }) → NJ reset game via ctx.onMessage.
  const btnNewGame = new TButton("btn-newgame");
  btnNewGame.caption = "🔄 New Game";
  btnNewGame.onClick = () => {
    void anim?.send({ cmd: "newGame" });
  };

  form.add(HStack({ gap: "6px", marginBottom: "6px" }, lblHint, Spacer(), btnNewGame));

  // --- Status (score echo dari NJ) ---
  const lblStatus = new TLabel("lbl-status");
  lblStatus.caption = "⏳ NJ belum ready...";
  lblStatus.style = {
    fontSize: "11px",
    color: theme.colors.textMuted,
    fontFamily: "monospace",
  };
  form.add(lblStatus);

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
  // DDC — wiring di onSetup
  // ================================================================
  form.onSetup = async (screen) => {
    const njSource = (await fs.readFile(NJ_PATH)) || "";
    if (!njSource) {
      await std.error(
        "[ddc-sample2] NJ source tidak ditemukan: " +
        NJ_PATH +
        " — jalankan sync-vfs dulu!",
      );
    }

    // ResourceBank: daftarkan & muat suara game + gambar spaceship SEKALI.
    const resBank = new ResourceBank({ wid: screen.wid, domeUuid: DOME_UUID });
    resBank.register("laser", "/opt/ddc-sample/laser-beam.mp3", "sfx");
    resBank.register("explode", "/opt/ddc-sample/retro-explode.mp3", "sfx");
    resBank.register("drop", "/opt/ddc-sample/bubbledrop.mp3", "sfx");
    resBank.register(
      "spaceship",
      "/opt/ddc-sample/spaceship1.jpg",
      "image",
      { mime: "image/jpeg" },
    );
    await resBank.loadAll();
    const widPrefix = screen.wid + ":"; // key cache browser: "<wid>:<nama>"

    anim = await mountDDC(
      screen,
      { id: "ddc-stage", source: njSource, width: 540, height: 480 },
      "stage",
    );

    // ================================================================
    // JOYSTICK → NJ (kontrol segitiga via joystick fisik)
    //   Polling /dev/joystick dari kernel di TGA (worker),
    //   lalu forward ke NJ lewat DDC_MSG: { cmd: "joy", data: {...} }.
    // ================================================================
    joyTimer = setInterval(async () => {
      try {
        if (!anim) return;
        const connected = await joystick.isConnected();
        if (connected !== joyConnected) {
          joyConnected = connected;
          await std.log(
            `[ddc-sample2] Joystick ${connected ? "terhubung" : "terputus"}`,
          );
        }
        if (!connected) return;
        // A0 = sumbu X (kiri/kanan), A1 = sumbu Y (atas/bawah), B16 = fire
        const axis0 = await joystick.getAxis(0);
        const axis1 = await joystick.getAxis(1);
        const btn16 = await joystick.getButton(16);
        void anim.send({ cmd: "joy", data: { axis0, axis1, button16: btn16 } });
      } catch (_) {
        /* device belum siap — skip frame */
      }
    }, 50);

    // NJ → TGA
    anim.on("ready", (ev: any) => {
      lblStatus.caption = `✅ NJ ready — ${ev.width}x${ev.height}`;
      // Handshake: setelah NJ siap, kirim high score persisted dari disk
      void anim?.send({ cmd: "initHighScore", value: persistedHigh });
    });
    anim.on("score", (ev: any) => {
      lblStatus.caption = `🎯 Score: ${ev}`;
    });
    anim.on("life", (ev: any) => {
      lblStatus.caption = `❤️ Lives: ${ev}`;
    });
    // NJ memecahkan rekor → persist segera
    anim.on("highscore", async (ev: any) => {
      const v = Number(ev) || 0;
      if (v <= persistedHigh) return;
      persistedHigh = v;
      await persistHighScore(v);
    });
    anim.on("gameover", async (ev: any) => {
      lblStatus.caption = `💀 Game Over — Score ${ev.score} (High ${ev.highScore})`;
      const v = Number(ev.highScore) || 0;
      if (v > persistedHigh) persistedHigh = v;
      await persistHighScore(persistedHigh);
    });
    // Suara dari NJ: "laser" (tembak) / "explode" (balon pecah) / "drop"
    // PLAY_SOUND cukup kirim nama — Audio sudah di-cache browser (RES_LOAD).
    anim.on("sound", async (ev: any) => {
      if (ev === "laser" || ev === "explode" || ev === "drop")
        await shell
          .send(DOME_UUID, { type: "PLAY_SOUND", name: widPrefix + ev })
          .catch(() => { });
    });
    // Keyboard tetap bisa didengar TGA via PixelSpace (opsional)
    anim.on("key", (ev: any) => {
      // contoh: log hanya saat spasi ditekan (debug)
      // if (ev.key === " " && ev.down) std.log("[ddc-sample2] space");
    });
  };

  await form.run();

  // Cleanup: hentikan polling joystick + NJ saat form tutup.
  if (joyTimer) {
    clearInterval(joyTimer);
    joyTimer = null;
  }

  // Cleanup: hentikan NJ saat form tutup.
  // (anim di-assign di dalam closure onSetup → TS sempitkan jadi null di sini,
  //  jadi perlu cast eksplisit biar cleanup aman.)
  const ddcHandle: DDCApp | null = anim as DDCApp | null;
  if (ddcHandle) await ddcHandle.destroy();
  await std.log("[ddc-sample2] Done ✅");
});
