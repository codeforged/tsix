/**
 * gui-read-keyboard — Demo komponen keyboard global (TKeyboard / Keyboard).
 *
 * Menampilkan event keyboard (keydown/keyup + modifier + repeat) SELAMA
 * window ini AKTIF — tanpa perlu klik elemen tertentu dulu. Fokus elemen
 * penangkap dikelola otomatis oleh komponen + DOME di browser (pola DDC):
 *   - saat attach, dan
 *   - saat user klik di mana pun DALAM window (kecuali di input teks).
 * Klik di luar window → fokus pindah → keyboard mati otomatis.
 *
 * Komponen:
 *   - Cashew : TKeyboard (dipakai di contoh ini)
 *   - Emerald: Keyboard  (kelas di balik TKeyboard)
 *
 * Jalankan: gui-read-keyboard
 */

import { Program, std } from "@tsix/Application";
import {
  TForm,
  TLabel,
  TMemo,
  TButton,
  TStatusBar,
  TKeyboard,
  HStack,
  Spacer,
} from "@tsix/cashew";
import { theme } from "@tsix/theme";

export const appMode = "gui";

export const main = Program(async () => {
  await std.log("=== gui-read-keyboard (TKeyboard demo) ===");

  const form = new TForm({
    title: "⌨️ GUI Read Keyboard",
    icon: "⌨️",
    width: 560,
    height: 540,
  });

  // ── Judul ──
  const lblTitle = new TLabel("lbl-title");
  lblTitle.caption = "⌨️ Keyboard Event — aktif saat window ini fokus";
  lblTitle.style = {
    fontSize: "14px",
    fontWeight: "700",
    color: theme.colors.accent,
  };
  form.add(lblTitle);

  // ── Hint + tombol Clear ──
  const lblHint = new TLabel("lbl-hint");
  lblHint.caption =
    "Tekan tombol apa saja. Klik di luar window → keyboard berhenti.";
  lblHint.style = {
    fontSize: "11px",
    color: theme.colors.textMuted,
    fontFamily: "monospace",
  };

  const btnClear = new TButton("btn-clear");
  btnClear.caption = "🧹 Clear";
  btnClear.style = { padding: "3px 12px", fontSize: "11px" };
  btnClear.onClick = () => {
    lastLine = "—";
    log = "";
    memo.text = "";
    lblLast.caption = "—";
  };
  form.add(
    HStack({ gap: "6px", marginBottom: "6px" }, lblHint, Spacer(), btnClear),
  );

  // ── Baris key terakhir ──
  const lblLast = new TLabel("lbl-last");
  lblLast.caption = "—";
  lblLast.style = {
    fontSize: "13px",
    color: theme.colors.text,
    fontFamily: "monospace",
    whiteSpace: "pre" as any,
    background: theme.colors.bgAlt,
    borderRadius: "6px",
    padding: "6px 10px",
    marginBottom: "6px",
  };
  form.add(lblLast);

  // ── Log keydown/keyup ──
  const memo = new TMemo("kb-log", {
    flex: "1",
    minHeight: "0",
    fontFamily: "monospace",
    fontSize: "12px",
  });
  memo.rows = 16;
  form.add(memo);

  // ── Status bar ──
  const status = new TStatusBar("kb-status");
  status.text = "Menunggu keyboard...";
  form.add(status);

  // ── Komponen keyboard (non-visual) — event saat window aktif ──
  const kb = new TKeyboard();
  let lastLine = "—";
  let log = "";
  kb.onKey = (e) => {
    const mods =
      (e.ctrl ? "Ctrl+" : "") +
      (e.shift ? "Shift+" : "") +
      (e.alt ? "Alt+" : "");
    const state = e.down ? "▼ down" : "▲ up  ";
    const line =
      `[${state}] ${mods}${e.key || "(none)"}` +
      `  · code: ${e.code} · repeat: ${e.repeat ? "yes" : "no"}`;
    lastLine = line;
    lblLast.caption = line;
    log = (log + "\n" + line).trim();
    if (log.length > 6000) log = log.slice(-6000);
    memo.text = log;
    status.text = "Listening — " + (e.key || "(none)");
  };
  form.add(kb);

  await form.run();
});
