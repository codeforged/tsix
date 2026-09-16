/**
 * plcd-emulator.ts — TGA: emulator / viewer panel PSEUDO-LCD 128x64
 *
 * Menampilkan isi node `/dev/plcd` (driver kernel `PLCDDevice`) di browser
 * lewat DDC — jadi aplikasi yang biasanya menggambar ke panel LM6029 asli
 * bisa dilihat hasilnya tanpa hardware (dan tanpa mengubah kode app tersebut,
 * asal diarahkan: `TSIX_LCD_DEV=/dev/plcd`).
 *
 * Cara kerja (polling, bukan push):
 *   setiap 80 ms → ioctl GET_REV (murah) → kalau berubah → ioctl GET_FRAME
 *   (base64 1024 byte) → kirim ke NJ (`{ t: "frame", fb, ... }`) untuk
 *   digambar 1 px = 4 px fisik di canvas.
 * `GET_REV` naik HANYA saat flush, jadi panel yang diam = nol trafik.
 *
 * Tombol di bawah panel berfungsi sebagai test-bench: semuanya menulis ke
 * `/dev/plcd` lewat `lcdLib` (jalur yang sama dengan app sungguhan), jadi
 * sekaligus membuktikan driver pseudo-nya bekerja.
 *
 * Jalankan: plcd-emulator
 * PASTIKAN DOME SUDAH RUNNING: dome
 * DEPLOY: sync VFS (`scripts/sync-vfs.ts`) + restart kernel (driver
 * `/dev/plcd` didaftarkan saat boot) + reload halaman browser.
 */

import { Program, std, fs } from "@tsix/Application";
import { TForm, TPanel, TLabel, TButton, HStack } from "@tsix/cashew";
import { mountDDC, DDCApp } from "@tsix/ddc";
import { theme } from "@tsix/theme";
import { LcdLib, LCD_PSEUDO_DEVICE_PATH } from "@tsix/lcdLib";

export const appMode = "gui";

// ================================================================
// GEOMETRI: panel 128x64, digambar 4x → 512x256 (1 px = 4 px fisik)
// ================================================================
const PANEL_W = 128;
const PANEL_H = 64;
const SCALE = 4;
const PHYS_W = PANEL_W * SCALE;
const PHYS_H = PANEL_H * SCALE;

/** Interval polling revisi panel (ms) — 80 ms ≈ 12 fps, GET_REV sangat murah. */
const POLL_MS = 80;

const NJ_PATH = "/opt/plcd/plcd-panel.js";

export const main = Program(async (_args: string[]) => {
  await std.log("=== PLCD Emulator — pseudo LCD 128x64 (/dev/plcd) ===");

  // Instance lcdLib yang diarahkan ke node pseudo (bukan /dev/lcd).
  const plcd = new LcdLib().setDevicePath(LCD_PSEUDO_DEVICE_PATH);

  // ================================================================
  // FORM
  // ================================================================
  const form = new TForm({
    title: "PLCD Emulator — Pseudo LCD 128x64 (/dev/plcd)",
    icon: "🖥️",
    width: 720,
    height: 560,
    maximizable: false,
    resizable: false,
  });
  form.style = { ...form.style, padding: "0", margin: "0" };

  const lblTitle = new TLabel("lbl-title");
  lblTitle.caption = "🖥️ PLCD Emulator — panel palsu pengganti LM6029 128×64";
  lblTitle.style = {
    fontSize: "13px",
    fontWeight: "700",
    color: theme.colors.accent,
    padding: "10px 12px 0 12px",
  };
  form.add(lblTitle);

  const lblStatus = new TLabel("lbl-status");
  lblStatus.caption = "⏳ Membaca /dev/plcd...";
  lblStatus.style = {
    fontSize: "11px",
    color: theme.colors.textMuted,
    fontFamily: "monospace",
    padding: "2px 12px 6px 12px",
  };
  form.add(lblStatus);

  let anim: DDCApp | null = null;

  // --- Chassis + bezel (gaya modul LCD, bukan kalkulator) ---
  const body = new TPanel("plcd-body", {
    alignSelf: "center",
    padding: "14px 14px 12px 14px",
    borderRadius: "14px",
    border: "1px solid #45454f",
    background: "linear-gradient(180deg, #35353f 0%, #24242b 55%, #191920 100%)",
    boxShadow: "0 12px 28px rgba(0,0,0,0.5)",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  });

  const bezel = new TPanel("plcd-bezel", {
    alignSelf: "center",
    boxSizing: "border-box",
    width: PHYS_W + 14 + "px",
    height: PHYS_H + 14 + "px",
    padding: "6px",
    borderRadius: "8px",
    border: "1px solid #000",
    background: "#0b0d08",
    boxShadow: "inset 0 2px 10px rgba(0,0,0,0.85)",
  });

  const stage = new TPanel("stage", {
    boxSizing: "border-box",
    width: PHYS_W + "px",
    height: PHYS_H + "px",
    flex: "0 0 auto",
    padding: "0",
    margin: "0",
    border: "none",
    borderRadius: "0",
    overflow: "hidden",
    background: "#0b0d08",
  });
  bezel.add(stage);
  body.add(bezel);

  // --- Baris pin/modul (biar terasa seperti modul hardware) ---
  const lblPinLeft = new TLabel("lbl-pin-l");
  lblPinLeft.caption = "LM6029ACW · 128×64 · 1 bpp";
  lblPinLeft.style = {
    fontSize: "10px",
    letterSpacing: "1px",
    color: "#c9d6a8",
    fontFamily: "monospace",
  };
  const lblPinRight = new TLabel("lbl-pin-r");
  lblPinRight.caption = "SPI: — (pseudo, tanpa hardware)";
  lblPinRight.style = {
    fontSize: "10px",
    letterSpacing: "1px",
    color: "#8d9a76",
    fontFamily: "monospace",
  };
  body.add(
    HStack({ justifyContent: "space-between", width: "100%" }, lblPinLeft, lblPinRight),
  );

  // ================================================================
  // TOMBOL TEST-BENCH — semuanya menulis lewat lcdLib ke /dev/plcd
  // ================================================================
  let counter = 0;

  const makeBtn = (
    id: string,
    caption: string,
    onClick: () => void,
    width = "104px",
  ): TButton => {
    const b = new TButton(id);
    b.caption = caption;
    b.style = {
      width,
      padding: "7px 0",
      fontSize: "11px",
      fontWeight: "700",
      fontFamily: "monospace",
      color: "#e6eeda",
      background: "linear-gradient(180deg, #4b4b57 0%, #2a2a32 100%)",
      border: "1px solid #5c5c6a",
      borderRadius: "6px",
      boxShadow: "0 2px 0 #101014",
      cursor: "pointer",
    };
    b.onClick = onClick;
    return b;
  };

  /** Gambar pola uji memakai API yang sama dengan app sungguhan. */
  const drawTestPattern = async () => {
    await plcd.clear();
    await plcd.drawRect(0, 0, PANEL_W, PANEL_H, 1);
    await plcd.drawLine(1, 1, PANEL_W - 2, PANEL_H - 2, 1);
    await plcd.drawLine(PANEL_W - 2, 1, 1, PANEL_H - 2, 1);
    await plcd.drawCircle(20, 45, 13, 1);
    await plcd.fillCircle(108, 45, 13, 1);
    await plcd.fillTriangle(46, 60, 82, 60, 64, 38, 1);
    await plcd.drawRoundRect(40, 4, 48, 20, 6, 1);
    await plcd.setTextSize(1);
    await plcd.printText("PSEUDO LCD 128x64", 2, 24, 1);
    await plcd.printText("Halo TSIX! 0123456789", 2, 52, 1);
    await plcd.flush();
    await pull(true);
  };

  const keypad = HStack(
    { justifyContent: "center", width: "100%", gap: "6px", flexWrap: "wrap" },
    makeBtn("btn-pattern", "Test Pattern", () => void drawTestPattern()),
    makeBtn("btn-clear", "Clear", async () => {
      await plcd.clear();
      await plcd.flush();
      await pull(true);
    }),
    makeBtn("btn-print", "Print", async () => {
      counter++;
      await plcd.printText(`PLCD #${counter}`, 2, (counter % 6) * 8, 1);
      await pull(true);
    }),
    makeBtn("btn-invert", "Invert", async () => {
      const cur = await plcd.getInvert();
      await plcd.setInvert(!cur);
      await pull(true);
    }),
    makeBtn("btn-display", "Display", async () => {
      const cur = await plcd.isDisplayOn();
      await plcd.setDisplayOn(!cur);
      await pull(true);
    }),
    makeBtn("btn-backlight", "Backlight", async () => {
      const cur = await plcd.getBacklight();
      await plcd.setBacklight(!cur);
      await pull(true);
    }),
    makeBtn("btn-contrast-", "Kontras −", async () => {
      const cur = (await plcd.getContrast()) ?? 31;
      await plcd.setContrast(Math.max(0, cur - 8));
      await pull(true);
    }),
    makeBtn("btn-contrast+", "Kontras +", async () => {
      const cur = (await plcd.getContrast()) ?? 31;
      await plcd.setContrast(Math.min(63, cur + 8));
      await pull(true);
    }),
    makeBtn("btn-refresh", "Refresh", () => void pull(true)),
  );
  body.add(keypad);
  form.add(body);

  // ================================================================
  // POLLING /dev/plcd → DDC
  // ================================================================
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastRev = -1;
  let njScale = SCALE;

  function setStatus(text: string) {
    lblStatus.caption = text;
  }

  async function pull(force = false) {
    if (!anim) return;
    const rev = await plcd.getFrameRev();
    if (rev === null) {
      setStatus(
        "❌ /dev/plcd tidak merespons — apakah driver PLCDDevice ter-load? (restart kernel setelah sync)",
      );
      return;
    }
    if (!force && rev === lastRev) return;

    const frame = await plcd.getFrame();
    if (!frame) return;
    lastRev = frame.rev;
    await anim.send({
      t: "frame",
      fb: frame.fb,
      invert: frame.invert,
      displayOn: frame.displayOn,
      backlight: frame.backlight,
      contrast: frame.contrast,
      rev: frame.rev,
    });
    setStatus(
      `✅ ${LCD_PSEUDO_DEVICE_PATH} rev ${frame.rev} • frame ${frame.frames} • ` +
        `${frame.width}×${frame.height} @×${njScale} • kontras ${frame.contrast} • ` +
        `backlight ${frame.backlight ? "ON" : "OFF"} • display ${frame.displayOn ? "ON" : "OFF"} • ` +
        `invert ${frame.invert ? "ON" : "OFF"} • autoFlush ${frame.autoFlush ? "ON" : "OFF"} • ` +
        `poll ${POLL_MS}ms`,
    );
  }

  // ================================================================
  // SETUP: mount NJ + mulai polling
  // ================================================================
  form.onSetup = async (screen) => {
    const available = await plcd.isAvailable();
    const pseudo = await plcd.isPseudo();
    const info = await plcd.getInfo();
    if (!available || !pseudo) {
      setStatus(
        `❌ Node ${LCD_PSEUDO_DEVICE_PATH} belum siap (available=${available}, pseudo=${pseudo}) — ` +
          "pastikan driver PLCDDevice ter-load kernel (restart setelah sync VFS).",
      );
      return;
    }
    await std.log(
      `[plcd-emulator] device=${info?.device} framebufferSize=${info?.framebufferSize}`,
    );

    const src = (await fs.readFile(NJ_PATH)) || "";
    if (!src) {
      setStatus(`❌ NJ tidak ditemukan: ${NJ_PATH} (jalankan sync VFS)`);
      return;
    }

    anim = await mountDDC(
      screen,
      { id: "ddc-plcd", source: src, width: PHYS_W, height: PHYS_H },
      "stage",
    );

    anim.on("ready", (ev: any) => {
      njScale = ev?.scale || SCALE;
      void pull(true);
    });

    timer = setInterval(() => {
      void pull();
    }, POLL_MS);

    await pull(true);
  };

  await form.run();

  // Cleanup: hentikan polling + lepas FD & NJ (anti resource leak).
  if (timer) clearInterval(timer);
  timer = null;
  const ddcHandle: DDCApp | null = anim as DDCApp | null;
  if (ddcHandle) await ddcHandle.destroy();
  await plcd.close();
  await std.log("[plcd-emulator] Done ✅");
});
