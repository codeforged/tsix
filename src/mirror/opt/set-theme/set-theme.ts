/**
 * test-theme.ts — Demo Theme Switching
 *
 * Menunjukkan cara pake theme system TSIX:
 * - load theme dari /opt/asteracea/theme-*.json
 * - switch antar dark/light
 * - pake helper card(), button(), colors.*
 *
 * Jalankan: /bin/test-theme.js
 */

import { Program, std, shell } from "@tsix/Application";
import { Screen, div, button, span, h1, h2 } from "@tsix/emerald";
import { theme } from "@tsix/theme";

export const main = Program(async (_args: string[]) => {
  await std.log("=== Theme Demo ==="); 

  // 1. Deteksi theme yang tersedia
  const available = await theme.discover();

  // 2. Cari DOME PID
  const ps = await shell.ps();
  const domePid = (ps.find((p: any) => p.name.includes("dome")) || {}).pid || 0;

  // 3. Load current theme
  await theme.loadCurrent();
  await std.log(`[theme] Found: ${available.join(", ")}`);
  await std.log(`[theme] Loaded: ${theme.raw.name}`);

  const app = new Screen({ title: "🎨 Theme Demo", width: 640, height: 480 });

  // --- Helpers untuk rebuild UI pas ganti theme ---
  let currentTheme = theme.raw.name?.toLowerCase().includes("light") ? "light" : "dark";
  const themeBtnId = "btn-switch";
  const demoPanelId = "demo-panel";

  async function renderUI() {
    // Card: preview warna
    const card1 = div({ style: { ...theme.card(), marginBottom: "12px" } },
      span({ text: `🎨 ${theme.raw.name}`, style: { fontSize: "14px", fontWeight: "700", color: theme.colors.accent, display: "block", marginBottom: "8px" } }),

      // Swatch warna
      div({ style: { display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "8px" } },
        swatch("bg", theme.colors.bg),
        swatch("card", theme.colors.card),
        swatch("surface", theme.colors.surface),
        swatch("accent", theme.colors.accent),
        swatch("danger", theme.colors.danger),
        swatch("warning", theme.colors.warning),
        swatch("info", theme.colors.info),
        swatch("text", theme.colors.text),
        swatch("muted", theme.colors.textMuted),
      ),

      // Text sample
      span({ text: "Sample text — The quick brown fox", style: { color: theme.colors.text, fontSize: "13px", display: "block", marginBottom: "4px" } }),
      span({ text: "Dim text — jumps over the lazy dog", style: { color: theme.colors.textDim, fontSize: "12px", display: "block" } }),
    );

    // Card: komponen helper
    const btnStyle = (c: string) => ({
      background: theme.colors.buttonBg, color: c,
      border: `1px solid ${c}`, borderRadius: theme.sizes.borderRadiusSm,
      padding: "6px 16px", cursor: "pointer", fontSize: theme.sizes.fontSizeSm, fontWeight: "600",
    });
    const card2 = div({ style: { ...theme.card(theme.colors.info) } },
      h2({ text: "🧩 Components", style: { fontSize: "13px", color: theme.colors.text, margin: "0 0 8px" } }),
      span({ text: `Helper: card(), colors.*, sizes.*`, style: { color: theme.colors.textMuted, fontSize: "11px", display: "block", marginBottom: "8px" } }),
      div({ style: { display: "flex", gap: "6px" } },
        button({ id: "btn-d1", text: "✅ Primary", onClickId: "btn-d1", style: btnStyle(theme.colors.accent) }),
        button({ id: "btn-d2", text: "⚠️ Warning", onClickId: "btn-d2", style: btnStyle(theme.colors.warning) }),
        button({ id: "btn-d3", text: "❌ Danger", onClickId: "btn-d3", style: btnStyle(theme.colors.danger) }),
      ),
    );

    await app.setContent(demoPanelId, card1, card2);
  }

  function swatch(label: string, color: string): any {
    return div({
      style: {
        display: "flex", alignItems: "center", gap: "4px",
        padding: "3px 8px", borderRadius: "4px",
        background: theme.colors.surface, fontSize: "10px",
      },
    },
      div({ style: { width: "12px", height: "12px", borderRadius: "2px", background: color, border: "1px solid " + theme.colors.border, flexShrink: "0" } }),
      span({ text: label, style: { color: theme.colors.textDim } }),
    );
  }

  // --- UI mount ---
  const btnSwitchStyle = (c: string) => ({
    background: theme.colors.buttonBg, color: c,
    border: `1px solid ${c}`, borderRadius: theme.sizes.borderRadiusSm,
    padding: "6px 16px", cursor: "pointer", fontSize: theme.sizes.fontSizeSm, fontWeight: "600",
  });

  await app.mount(
    div({ id: "root", style: { padding: "16px", height: "100%", display: "flex", flexDirection: "column", gap: "8px", background: theme.colors.bg, color: theme.colors.text, fontFamily: "'Segoe UI', sans-serif", fontSize: "13px" } },
      div({ style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
        h1({ text: "🎨 Theme Demo", style: { fontSize: "18px", color: theme.colors.accent, margin: "0" } }),
        button({
          id: themeBtnId, text: `🔄 Switch to ${currentTheme === "dark" ? "Light" : "Dark"}`,
          onClickId: themeBtnId,
          style: btnSwitchStyle(theme.colors.info),
        }),
      ),
      div({ id: demoPanelId, style: { flex: "1", overflowY: "auto" } }),
    ),
  );

  // --- Apply window theme ---
  await theme.applyToDome(domePid, app.wid);

  // --- Render awal ---
  await renderUI();

  // --- Theme switching ---
  await app.on(themeBtnId, "click", async () => {
    if (currentTheme === "dark") {
      await theme.switchTo("theme-light.json");
      currentTheme = "light";
    } else {
      await theme.switchTo("theme-dark.json");
      currentTheme = "dark";
    }
    // Apply window theme + update root
    await theme.applyToDome(domePid, app.wid);
    // Update root background + text
    await app.update("root", { style: { background: theme.colors.bg, color: theme.colors.text } });
    // Update title color
    await app.update("root", {}); // dummy
    // Re-render konten
    await renderUI();
    // Update tombol
    await app.update(themeBtnId, {
      text: `🔄 Switch to ${currentTheme === "dark" ? "Light" : "Dark"}`,
      ...theme.button(theme.colors.info),
    });
    await std.log(`[theme] Switched to: ${theme.raw.name}`);
  });

  await app.loopUntilClose();
});
