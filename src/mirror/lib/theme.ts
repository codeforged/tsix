/**
 * theme.ts — TSIX Desktop Theme System
 *
 * Baca theme dari /opt/asteracea/theme-*.json dan sediakan API
 * untuk aplikasi & WM mengakses warna secara terpusat.
 *
 * Usage:
 *   import { theme } from "../lib/theme";
 *   await theme.load("theme-dark.json");
 *   div({ style: { background: theme.colors.card } })
 *
 * (c) 2026 TSIX Project
 */

// Pakai global._tsixLib langsung, bukan import @tsix/Application
// karena file ini di-import dari berbagai konteks (bin, lib, dll)
function getFs(): any {
  const lib = (global as any)._tsixLib;
  return lib?.fs;
}

export interface ThemeColors {
  bg: string;
  bgAlt: string;
  card: string;
  surface: string;
  buttonBg: string;
  windowTitlebar: string;
  windowBorder: string;
  windowShadow: string;
  accent: string;
  accentBg: string;
  accentBorder: string;
  danger: string;
  dangerBg: string;
  dangerBorder: string;
  warning: string;
  info: string;
  text: string;
  textDim: string;
  textMuted: string;
  textDark: string;
  border: string;
  borderLight: string;
  overlay: string;
  scrollbar: string;
  scrollbarHover: string;
  inputBg: string;
  inputBorder: string;
  success: string;
  error: string;
}

export interface ThemeDefinition {
  name: string;
  version: number;
  author: string;
  colors: ThemeColors;
  sizes: Record<string, string>;
  fonts: Record<string, string>;
}

// Default theme (fallback kalo file gak terbaca)
const DEFAULT_THEME: ThemeDefinition = {
  name: "Default",
  version: 1,
  author: "TSIX",
  colors: {
    bg: "#0d1b2a",
    bgAlt: "#0a0f1f",
    card: "#16213e",
    surface: "#1a1a2e",
    buttonBg: "#0f3460",
    windowTitlebar: "#1a1a2e",
    windowBorder: "#4caf50",
    windowShadow: "0 8px 32px rgba(0,0,0,0.4)",
    accent: "#4caf50",
    accentBg: "rgba(76,175,80,0.15)",
    accentBorder: "rgba(76,175,80,0.3)",
    danger: "#f44336",
    dangerBg: "rgba(244,67,54,0.1)",
    dangerBorder: "rgba(244,67,54,0.3)",
    warning: "#ff9800",
    info: "#2196f3",
    text: "#e0e0e0",
    textDim: "#ccc",
    textMuted: "#888",
    textDark: "#555",
    border: "rgba(255,255,255,0.1)",
    borderLight: "rgba(255,255,255,0.06)",
    overlay: "rgba(0,0,0,0.7)",
    scrollbar: "rgba(255,255,255,0.08)",
    scrollbarHover: "rgba(255,255,255,0.15)",
    inputBg: "rgba(255,255,255,0.06)",
    inputBorder: "rgba(255,255,255,0.12)",
    success: "#4caf50",
    error: "#f44336",
  },
  sizes: {
    borderRadius: "8px",
    borderRadiusSm: "4px",
    borderRadiusLg: "12px",
    padding: "14px",
    paddingSm: "8px",
    fontSize: "13px",
    fontSizeSm: "11px",
    fontSizeLg: "16px",
  },
  fonts: {
    sans: "'Segoe UI', sans-serif",
    mono: "monospace",
  },
};

class ThemeProvider {
  private _theme: ThemeDefinition = DEFAULT_THEME;
  private _loaded = false;
  private _available: string[] = [];

  /** Cari semua file theme-*.json di direktori theme */
  async discover(dir: string = "/opt/asteracea"): Promise<string[]> {
    try {
      const files = await getFs().ls(dir);
      this._available = (files || [])
        .filter((f: any) => f.name?.startsWith("theme-") && f.name?.endsWith(".json"))
        .map((f: any) => f.name);
    } catch (_) {
      this._available = ["theme-dark.json"];
    }
    return this._available;
  }

  get available(): string[] { return this._available; }

  /** Muat theme dari file JSON */
  async load(name: string = "theme-dark.json", dir: string = "/opt/asteracea"): Promise<void> {
    const path = `${dir}/${name}`;
    try {
      const raw = await getFs().readFile(path);
      if (raw) {
        const parsed = JSON.parse(String(raw));
        this._theme = this.merge(DEFAULT_THEME, parsed);
      }
    } catch (_) {
      // File not found — pake default
    }
    this._loaded = true;
  }

  /** Ganti theme — muat file lain + simpan + broadcast ke semua app */
  async switchTo(name: string, dir: string = "/opt/asteracea"): Promise<void> {
    await this.load(name, dir);
    // Simpan ke prefs.json
    await this.saveToPrefs(name, dir);
    // Simpan current-theme (fallback)
    try {
      const fs = getFs();
      if (fs?.writeFile) {
        await fs.writeFile(dir + "/current-theme", JSON.stringify({ theme: name, updatedAt: Date.now() }));
      }
    } catch (_) {}
    // Broadcast ke DOME → semua app + browser
    await this.broadcast(name, dir);
  }

  /** Simpan theme ke prefs.json */
  async saveToPrefs(name: string, dir: string = "/opt/asteracea"): Promise<void> {
    try {
      const fs = getFs();
      if (!fs?.readFile || !fs?.writeFile) return;
      const raw = await fs.readFile(dir + "/prefs.json");
      const prefs = raw ? JSON.parse(String(raw)) : {};
      prefs.theme = name;
      prefs.themeDir = dir;
      await fs.writeFile(dir + "/prefs.json", JSON.stringify(prefs, null, 4));
    } catch (_) {}
  }

  /** Broadcast THEME_CHANGED ke DOME */
  async broadcast(name: string, dir: string = "/opt/asteracea"): Promise<void> {
    try {
      const lib = (global as any)._tsixLib;
      if (!lib?.shell?.send) return;
      const ps = await lib.shell.ps();
      const dome = (ps || []).find((p: any) => p.name?.includes("dome"));
      if (dome?.pid) {
        await lib.shell.send(dome.pid, { type: "THEME_CHANGED", theme: name, dir });
      }
    } catch (_) {}
  }

  /** Pasang listener THEME_CHANGED — panggil di app yang ingin auto-update */
  watch(): void {
    try {
      const lib = (global as any)._tsixLib;
      if (!lib?.onEvent) return;
      lib.onEvent("ipc_message", (msg: any) => {
        const ev = msg?.data || msg;
        if (ev?.type === "THEME_CHANGED" && ev.theme) {
          this.load(ev.theme, ev.dir || "/opt/asteracea").catch(() => {});
        }
      });
    } catch (_) {}
  }

  /** Muat theme dari file current-theme (hasil save sebelumnya) atau prefs.json */
  async loadCurrent(dir: string = "/opt/asteracea"): Promise<void> {
    // Priority 1: prefs.json
    try {
      const raw = await getFs().readFile(dir + "/prefs.json");
      if (raw) {
        const prefs = JSON.parse(String(raw));
        if (prefs.theme) {
          await this.load(prefs.theme, prefs.themeDir || dir);
          return;
        }
      }
    } catch (_) {}
    // Priority 2: current-theme file
    try {
      const raw = await getFs().readFile(dir + "/current-theme");
      if (raw) {
        const state = JSON.parse(String(raw));
        if (state.theme) {
          await this.load(state.theme, dir);
          return;
        }
      }
    } catch (_) {}
    // Fallback ke dark
    await this.load("theme-dark.json", dir);
  }

  /** Akses warna */
  get colors(): ThemeColors { return this._theme.colors; }
  get sizes(): Record<string, string> { return this._theme.sizes; }
  get fonts(): Record<string, string> { return this._theme.fonts; }
  get raw(): ThemeDefinition { return this._theme; }

  /** Helper: card dengan border accent */
  card(accentColor?: string): Record<string, string> {
    return {
      background: this._theme.colors.card,
      borderRadius: this._theme.sizes.borderRadius,
      padding: this._theme.sizes.padding,
      border: accentColor
        ? `1px solid ${accentColor}44`
        : `1px solid ${this._theme.colors.accentBorder}`,
    };
  }

  /** Helper: tombol dengan warna accent */
  button(color: string = this._theme.colors.accent): Record<string, string> {
    return {
      background: this._theme.colors.buttonBg,
      color,
      border: `1px solid ${color}`,
      borderRadius: this._theme.sizes.borderRadiusSm,
      padding: "6px 16px",
      cursor: "pointer",
      fontSize: this._theme.sizes.fontSizeSm,
      fontWeight: "600",
    };
  }

  /** Kirim theme window ke DOME engine — update titlebar, border, shadow */
  async applyToDome(domePid: number, myWid: string): Promise<void> {
    try {
      const shell = (global as any)._tsixLib?.shell;
      if (!shell?.send) return;
      await shell.send(domePid, {
        type: "WINDOW_THEME",
        wid: myWid,
        colors: {
          titlebar: this._theme.colors.windowTitlebar,
          border: this._theme.colors.windowBorder,
          shadow: this._theme.colors.windowShadow,
          bg: this._theme.colors.bg,
          surface: this._theme.colors.surface,
          buttonBg: this._theme.colors.buttonBg,
          accent: this._theme.colors.accent,
          text: this._theme.colors.text,
          textDim: this._theme.colors.textDim,
          textMuted: this._theme.colors.textMuted,
          borderColor: this._theme.colors.border,
          inputBg: this._theme.colors.inputBg,
          accentBg: this._theme.colors.accentBg,
        },
      });
    } catch (_) { /* DOME might not be ready */ }
  }

  private merge(base: any, override: any): any {
    const result = { ...base };
    for (const key of Object.keys(override)) {
      if (typeof override[key] === "object" && !Array.isArray(override[key])) {
        result[key] = this.merge(base[key] || {}, override[key]);
      } else {
        result[key] = override[key];
      }
    }
    return result;
  }
}

/** Singleton — panggil `await theme.load()` sekali di awal */
export const theme = new ThemeProvider();
