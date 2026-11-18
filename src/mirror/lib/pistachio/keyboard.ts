/**
 * pistachio/keyboard.ts — Shortcut keyboard per window.
 *
 * Satu window hanya punya satu capture keyboard (dikelola `TForm`). Komponen
 * `TKeyboard` mendaftarkan shortcut ke capture itu, sehingga beberapa set
 * shortcut bisa hidup berdampingan tanpa berebut elemen penangkap.
 *
 * DOME merutekan `kb_key` hanya ke window yang sedang fokus, jadi shortcut
 * otomatis tidak aktif saat aplikasi kehilangan fokus.
 *
 * (c) 2026 TSIX Project
 */

import {
  TComponent,
  TKeyEvent,
  TKeyboardPort,
  TOptions,
  TScreenPort,
} from "./core";

export interface TKeyboardOptions extends TOptions {
  /** Peta kombinasi → handler, mis. `{ "Ctrl+S": () => simpan() }`. */
  shortcuts?: Record<string, () => void>;
}

function normalizeKey(key: string): string {
  if (!key) return "";
  if (key === " " || key.toLowerCase() === "space") return "Space";
  if (key.length === 1) return key.toUpperCase();
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function comboOf(ev: TKeyEvent): string {
  const mods: string[] = [];
  if (ev.ctrl) mods.push("Ctrl");
  if (ev.alt) mods.push("Alt");
  if (ev.shift) mods.push("Shift");
  return [...mods, normalizeKey(ev.key)].filter(Boolean).join("+");
}

/** Normalisasi ejaan kombinasi: "ctrl+shift+s" → "Ctrl+Shift+S". */
export function normalizeCombo(combo: string): string {
  let ctrl = false;
  let alt = false;
  let shift = false;
  let key = "";

  for (const part of combo.split("+")) {
    const token = part.trim();
    if (!token) continue;

    switch (token.toLowerCase()) {
      case "ctrl":
      case "control":
        ctrl = true;
        break;
      case "alt":
        alt = true;
        break;
      case "shift":
        shift = true;
        break;
      default:
        key = normalizeKey(token);
    }
  }

  const mods: string[] = [];
  if (ctrl) mods.push("Ctrl");
  if (alt) mods.push("Alt");
  if (shift) mods.push("Shift");
  return [...mods, key].filter(Boolean).join("+");
}

/** Komponen non-visual pendaftar shortcut keyboard. */
export class TKeyboard extends TComponent {
  /** Listener mentah untuk semua keydown (setelah shortcut dicocokkan). */
  public onKey: ((ev: TKeyEvent) => void) | null = null;

  private readonly _shortcuts = new Map<string, () => void>();
  private _unbind: (() => void) | null = null;

  constructor(
    idOrOpts?: string | TKeyboardOptions,
    opts?: TKeyboardOptions,
  ) {
    super(idOrOpts, opts, ["shortcuts"]);
    this.isVisual = false;

    const shortcuts = (this.options as TKeyboardOptions).shortcuts ?? {};
    for (const [combo, handler] of Object.entries(shortcuts)) {
      this.bind(combo, handler);
    }
  }

  /** Benar bila shortcut sudah terhubung ke capture window. */
  get attached(): boolean {
    return this._unbind !== null;
  }

  /** Daftarkan/perbarui shortcut. */
  bind(combo: string, handler: () => void): void {
    this._shortcuts.set(normalizeCombo(combo), handler);
  }

  /** Hapus shortcut. */
  unbind(combo: string): void {
    this._shortcuts.delete(normalizeCombo(combo));
  }

  bindEventHandler(host: TScreenPort): void {
    super.bindEventHandler(host);

    const keyboard: TKeyboardPort | null | undefined = host.keyboard;
    if (!keyboard) return;

    this._unbind?.();
    this._unbind = keyboard.onKey((ev) => this.handle(ev));
  }

  dispose(): void {
    this._unbind?.();
    this._unbind = null;
    super.dispose();
  }

  private handle(ev: TKeyEvent): void {
    if (!ev.down || ev.repeat) return;

    const handler = this._shortcuts.get(comboOf(ev));
    if (handler) handler();
    this.onKey?.(ev);
  }
}
