/**
 * cashew.ts — Delphi-style Component Framework for Emerald
 *
 * Membungkus IDOMNode Emerald dengan pola OOP ala Delphi:
 * - Komponen adalah class, bukan function nesting
 * - Parent-child via assignment (komponen.parent := form)
 * - Properties flat (caption, left, top, width, height)
 * - Event handler terpisah (onClick, onInput)
 * - Mirip TButton, TPanel, TLabel, TEdit di Delphi
 *
 * (c) 2026 TSIX Project — Cashew GUI Framework
 */

import { Screen } from "@tsix/emerald";
import {
  lineChart,
  radialGauge,
  sevenSegment,
  indicatorLamp,
  toggleSwitch,
  verticalGauge,
  sensorCard,
  relayCard,
  slider,
  buildToggleSwitchImg,
  buildIndicatorLampImg,
  buildSevenSegmentHtml,
  isLightColor,
  ConnectedDataGrid,
  ConnectedTabulator,
  DataGridColumn,
} from "@tsix/emerald";
import { IDOMNode } from "../../common/GUITypes";
import { theme } from "@tsix/theme";
import { shell } from "@tsix/Application";

// ================================================================
// LAZY IMPORT — theme & shell (di-load runtime, bukan compile-time)
// ================================================================
let _theme: any = null;
let _shell: any = null;
async function ensureTheme(): Promise<any> {
  if (!_theme) _theme = theme;
  return _theme;
}
async function ensureShell(): Promise<any> {
  if (!_shell) _shell = shell;
  return _shell;
}

// ================================================================
// BASE CLASS — TComponent
// ================================================================

export class TComponent {
  public id: string;
  public parent: TComponent | null = null;
  private _children: TComponent[] = [];
  public tag: string = "div";
  public props: Record<string, any> = {};
  public style: Record<string, any> = {};

  constructor(id: string) {
    this.id = id;
  }

  /** Tambah child otomatis set parent */
  add(child: TComponent): TComponent {
    child.parent = this;
    this._children.push(child);
    return child;
  }

  get children(): TComponent[] {
    return this._children;
  }

  /**
   * bindEventHandler(): Daftarkan event handler ke Screen.
   * Otomatis dipanggil oleh TForm.run() untuk semua komponen.
   * Override di subclass untuk register event spesifik (onClick, onInput, dll).
   */
  bindEventHandler(screen: Screen): void {
    // Base: no-op — subclass override untuk register event
  }

  /**
   * refresh(): Update tampilan komponen setelah mount.
   * Otomatis dipanggil oleh TForm.run() setelah auto-bind.
   * Override di subclass (misal TListBox) untuk render ulang child items.
   */
  async refresh(screen: Screen): Promise<void> {
    // Base: no-op — subclass override untuk render dinamis
  }

  /** Konversi ke IDOMNode tree */
  build(): IDOMNode {
    const node: IDOMNode = {
      id: this.id,
      tag: this.tag,
      props: { ...this.props, style: { ...this.style } },
      children: this._children.map((c) => c.build()),
    };
    // Hapus style kosong biar payload gak bloat
    if (Object.keys(node.props.style).length === 0) delete node.props.style;
    return node;
  }
}

// ================================================================
// TForm — Main Window (wraps Screen)
// ================================================================

/** Opsi pembuatan TForm via object literal */
export interface TFormOptions {
  title: string;
  /** Ikon/emoji di kiri judul title bar (opsional) */
  icon?: string;
  width?: number;
  height?: number;
  /** Bisa di-maximize (default: true) */
  maximizable?: boolean;
  /** Bisa di-resize (default: true) */
  resizable?: boolean;
  /** Mode fullscreen tanpa frame (default: false) */
  fullscreen?: boolean;
  /** Tanpa titlebar/border (default: false) */
  frameless?: boolean;
  /** Posisi X window di desktop (default: default cascade) */
  left?: number;
  /** Posisi Y window di desktop (default: default cascade) */
  top?: number;
  /** Tengahkan window di desktop — menimpa left/top (default: false) */
  desktopCentered?: boolean;
  /** Style tambahan (margin, padding, background, dll) — di-merge ke style default form */
  style?: Record<string, any>;
}

export class TForm extends TComponent {
  private _screen!: Screen;
  private _title: string;
  private _icon?: string;
  private _width: number;
  private _height: number;
  private _maximizable: boolean;
  private _resizable: boolean;
  private _fullscreen: boolean;
  private _frameless: boolean;
  private _left: number | undefined;
  private _top: number | undefined;
  private _desktopCentered: boolean;
  private _onClose: (() => void) | null = null;

  // Overload 1 — sequential: new TForm("Title", 500, 100, false, true, true, false)
  constructor(
    title: string,
    width?: number,
    height?: number,
    maximizable?: boolean,
    resizable?: boolean,
    fullscreen?: boolean,
    frameless?: boolean,
  );
  // Overload 2 — object literal: new TForm({ title, width, height, maximizable, resizable, fullscreen, frameless })
  constructor(opts: TFormOptions);
  constructor(
    titleOrOpts: string | TFormOptions,
    width: number = 800,
    height: number = 600,
    maximizable: boolean = true,
    resizable: boolean = true,
    fullscreen: boolean = false,
    frameless: boolean = false,
  ) {
    super("__form__");
    // Normalisasi argumen — dukung dua bentuk pemanggilan
    let userStyle: Record<string, any> | undefined;
    if (typeof titleOrOpts === "object" && titleOrOpts !== null) {
      const o = titleOrOpts as TFormOptions;
      this._title = o.title ?? "Untitled";
      this._icon = o.icon;
      this._width = o.width ?? 800;
      this._height = o.height ?? 600;
      this._maximizable = o.maximizable ?? true;
      this._resizable = o.resizable ?? true;
      this._fullscreen = o.fullscreen ?? false;
      this._frameless = o.frameless ?? false;
      this._left = o.left;
      this._top = o.top;
      this._desktopCentered = o.desktopCentered ?? false;
      userStyle = o.style;
    } else {
      this._title = titleOrOpts;
      this._icon = undefined;
      this._width = width;
      this._height = height;
      this._maximizable = maximizable;
      this._resizable = resizable;
      this._fullscreen = fullscreen;
      this._frameless = frameless;
      this._left = undefined;
      this._top = undefined;
      this._desktopCentered = false;
    }
    this.tag = "div";
    this.style = {
      padding: "12px",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      background: "var(--bg, #0d1b2a)",
      color: "var(--text, #e0e0e0)",
      fontFamily: "'Segoe UI', sans-serif",
      fontSize: "13px",
    };
    // Style dari object literal di-merge di atas default (override)
    if (userStyle) this.style = { ...this.style, ...userStyle };
  }

  set title(v: string) {
    this._title = v;
  }
  set icon(v: string | undefined) {
    this._icon = v;
  }
  set width(w: number) {
    this._width = w;
  }
  set height(h: number) {
    this._height = h;
  }
  set maximizable(v: boolean) {
    this._maximizable = v;
  }
  set resizable(v: boolean) {
    this._resizable = v;
  }
  set fullscreen(v: boolean) {
    this._fullscreen = v;
  }
  set frameless(v: boolean) {
    this._frameless = v;
  }
  set left(v: number | undefined) {
    this._left = v;
  }
  get left(): number | undefined {
    return this._left;
  }
  set top(v: number | undefined) {
    this._top = v;
  }
  get top(): number | undefined {
    return this._top;
  }
  set desktopCentered(v: boolean) {
    this._desktopCentered = v;
  }
  get desktopCentered(): boolean {
    return this._desktopCentered;
  }

  /** Event: saat form ditutup */
  set onClose(cb: (() => void) | null) {
    this._onClose = cb;
  }

  /** Callback setelah mount, sebelum loop — tempat binding event */
  public onSetup: ((screen: Screen) => Promise<void>) | null = null;

  /** Jalankan aplikasi — theme → mount → setup → loop */
  async run(): Promise<void> {
    // Load theme dulu sebelum build agar komponen pake warna yang benar
    try {
      const t = await ensureTheme();
      await t.loadCurrent();
      t.watch();
    } catch (_) {
      /* theme opsional — skip jika gagal */
    }

    const opts: any = {
      title: this._title,
      icon: this._icon,
      width: this._width,
      height: this._height,
      maximizable: this._maximizable,
      resizable: this._resizable,
      fullscreen: this._fullscreen,
      frameless: this._frameless,
      left: this._left,
      top: this._top,
      desktopCentered: this._desktopCentered,
    };
    this._screen = new Screen(opts);
    if (this._onClose) this._screen.win.onClose(() => this._onClose!());
    await this._screen.mount(this.build());

    // Apply theme ke DOME (CSS variables untuk browser)
    try {
      const t = await ensureTheme();
      const s = await ensureShell();
      const ps = await s.ps();
      const domePid =
        (ps.find((p: any) => p.name?.includes("dome")) || {}).pid || 0;
      if (domePid && s?.send) {
        await s.send(domePid, {
          type: "WINDOW_THEME",
          wid: this._screen.win.wid,
          colors: {
            titlebar: t.colors.windowTitlebar,
            border: t.colors.windowBorder,
            shadow: t.colors.windowShadow,
            bg: t.colors.bg,
            surface: t.colors.surface,
            buttonBg: t.colors.buttonBg,
            accent: t.colors.accent,
            text: t.colors.text,
            textDim: t.colors.textDim,
            textMuted: t.colors.textMuted,
            borderColor: t.colors.border,
            inputBg: t.colors.inputBg,
            accentBg: t.colors.accentBg,
          },
        });
      }
    } catch (_) {
      /* theme opsional — skip jika gagal */
    }

    // Auto-bind: traverse semua children & panggil bindEventHandler()
    const autoBind = (comp: TComponent) => {
      comp.bindEventHandler(this._screen);
      for (const child of comp.children) autoBind(child);
    };
    for (const child of this.children) autoBind(child);

    // Auto-refresh: panggil refresh() pada komponen yg membutuhkan (misal TListBox)
    const autoRefresh = async (comp: TComponent) => {
      await comp.refresh(this._screen);
      for (const child of comp.children) await autoRefresh(child);
    };
    for (const child of this.children) await autoRefresh(child);

    // Setup callback — custom setup setelah bind & refresh
    if (this.onSetup) await this.onSetup(this._screen);
    await this._screen.loopUntilClose();
  }

  get screen(): Screen {
    return this._screen;
  }

  /** Show alert dialog */
  async alert(title: string, msg?: string): Promise<void> {
    await this._screen.alert(title, msg);
  }

  /** Show confirm dialog */
  async confirm(
    title: string,
    msg: string,
    buttons?: string[],
  ): Promise<string> {
    return await this._screen.confirm(title, msg, buttons);
  }

  /** Update props elemen tertentu */
  async update(targetId: string, props: Record<string, any>): Promise<void> {
    await this._screen.update(targetId, props);
  }

  // ============================================================
  // WINDOW CONTROL — delegasi ke Screen.win (Emerald)
  // ============================================================

  /** Perbesar window ke ukuran penuh viewport (maximize). */
  async maximize(): Promise<void> {
    await this._screen.maximize();
  }

  /** Kembalikan window dari state maximized ke ukuran sebelumnya. */
  async unMaximize(): Promise<void> {
    await this._screen.unmaximize();
  }

  /** Alias `unMaximize()` — sama dengan API Emerald (`win.unmaximize()`). */
  async unmaximize(): Promise<void> {
    await this.unMaximize();
  }

  /** Kembalikan window yang sedang di-minimize. */
  async restore(): Promise<void> {
    await this._screen.restore();
  }

  /** Sembunyikan window (iconify). Window tetap hidup, bisa di-restore. */
  async minimize(): Promise<void> {
    await this._screen.minimize();
  }

  /**
   * Tutup form & hancurkan aplikasi.
   * Set `running = false`, bersihkan semua timer, kirim DESTROY_WINDOW →
   * loop `loopUntilClose()` berhenti → `Program()` selesai (process exit).
   * Callback `onClose` (jika diset) ikut dipanggil.
   */
  async close(): Promise<void> {
    if (this._onClose) this._onClose();
    await this._screen.close();
  }
}

// ================================================================
// STANDALONE DIALOGS — Bungkus Emerald dialog ke komponen Cashew
// ----------------------------------------------------------------
// Lapisan API:
//   Kernel → Syscall(GUI_REQ) → DOME Engine → Browser
//                                            ↓
//   Emerald → Screen.alert/confirm/question  ← Browser DOM
//                                            ↓
//   Cashew → TDialogs.*                      ← Lebih gampang
// ================================================================

/**
 * TDialogs — Dialog utility tanpa perlu bikin form.
 *
 * Contoh:
 *   const screen = new Screen("My App");
 *   await TDialogs.alert(screen, "Info", "Hello!");
 *   const ok = await TDialogs.confirm(screen, "Delete?", "Yakin?");
 *   const name = await TDialogs.input(screen, "Siapa nama Anda?");
 */
export class TDialogs {
  /** Alert — pesan info, satu tombol OK */
  static async alert(
    screen: Screen,
    title: string,
    message?: string,
  ): Promise<void> {
    await screen.alert(title, message);
  }

  /** Confirm — pilihan Yes/No atau custom buttons, return pilihan user */
  static async confirm(
    screen: Screen,
    title: string,
    message: string,
    buttons?: string[],
  ): Promise<string> {
    return await screen.confirm(title, message, buttons);
  }

  /** Question — input teks dengan default value. Return null jika dibatalkan. */
  static async input(
    screen: Screen,
    title: string,
    message: string,
    defaultValue?: string,
  ): Promise<string | null> {
    return await screen.question(title, message, defaultValue);
  }

  /** Open File Dialog — pilih file, return path atau null */
  static async openFile(
    screen: Screen,
    fs: any,
    title?: string,
    startDir?: string,
  ): Promise<string | null> {
    const result = await screen.openFileDialog(fs, { title, startDir });
    return result ? result.path : null;
  }

  /** Save File Dialog — tentukan path file, return path atau null */
  static async saveFile(
    screen: Screen,
    fs: any,
    title?: string,
    defaultName?: string,
  ): Promise<string | null> {
    const result = await screen.saveFileDialog(fs, { title, defaultName });
    return result ? result.path : null;
  }
}

// ================================================================
// TPanel — Container (seperti TPanel Delphi)
// ================================================================

export class TPanel extends TComponent {
  constructor(id: string, extraStyle?: Record<string, any>) {
    super(id);
    this.tag = "div";
    this.style = {
      background: "var(--surface, #16213e)",
      borderRadius: "8px",
      padding: "10px",
      border: "1px solid var(--accent, rgba(76,175,80,0.2))",
      ...extraStyle,
    };
  }

  set caption(v: string) {
    this.props.text = v;
  }
  get caption(): string {
    return this.props.text || "";
  }
}

// ================================================================
// TLabel — Label teks (seperti TLabel Delphi)
// ================================================================

export class TLabel extends TComponent {
  private _screen: Screen | null = null;

  constructor(id: string, extraStyle?: Record<string, any>) {
    super(id);
    this.tag = "span";
    this.style = {
      color: "var(--text-dim, #ccc)",
      fontSize: "13px",
      ...extraStyle,
    };
  }

  set caption(v: string) {
    this.props.text = v;
    if (this._screen) this._screen.update(this.id, { text: v });
  }
  get caption(): string {
    return this.props.text || "";
  }

  bindEventHandler(screen: Screen): void {
    this._screen = screen;
  }
}

// ================================================================
// TButton — Tombol (seperti TButton Delphi)
// ================================================================

export class TButton extends TComponent {
  public onClick: (() => void) | null = null;
  private _screen: Screen | null = null;

  constructor(id: string, extraStyle?: Record<string, any>) {
    super(id);
    this.tag = "button";
    this.props.onClickId = id;
    this.style = {
      background: "var(--button-bg, #0f3460)",
      color: "var(--accent, #4caf50)",
      border: "1px solid var(--accent, #4caf50)",
      borderRadius: "6px",
      padding: "6px 16px",
      cursor: "pointer",
      fontSize: "12px",
      fontWeight: "600",
      ...extraStyle,
    };
  }

  set caption(v: string) {
    this.props.text = v;
    if (this._screen) this._screen.update(this.id, { text: v });
  }
  get caption(): string {
    return this.props.text || "";
  }

  set enabled(v: boolean) {
    if (v) delete this.props.disabled;
    else this.props.disabled = "1";
  }

  /** Binding event handler — panggil setelah mount */
  bindEventHandler(screen: Screen): void {
    this._screen = screen;
    if (this.onClick) {
      screen.on(this.id, "click", this.onClick);
    }
  }
}

// ================================================================
// TEdit — Input field (seperti TEdit Delphi)
// ================================================================

export class TEdit extends TComponent {
  public onInput: ((value: string) => void) | null = null;
  private _screen: Screen | null = null;

  constructor(id: string, extraStyle?: Record<string, any>) {
    super(id);
    this.tag = "input";
    this.props.type = "text";
    this.props.onInputId = id;
    this.style = {
      width: "100%",
      padding: "8px 12px",
      background: "var(--input-bg, rgba(255,255,255,0.06))",
      border: "1px solid var(--border, rgba(255,255,255,0.12))",
      borderRadius: "6px",
      color: "var(--text, #e0e0e0)",
      fontSize: "13px",
      outline: "none",
      boxSizing: "border-box",
      ...extraStyle,
    };
  }

  set text(v: string) {
    this.props.value = v;
  }
  get text(): string {
    return this.props.value || "";
  }

  set placeholder(v: string) {
    this.props.placeholder = v;
  }

  /** Binding event handler — panggil setelah mount */
  bindEventHandler(screen: Screen): void {
    this._screen = screen;
    if (this.onInput) {
      screen.on(this.id, "input", (ev: any) => {
        this.onInput!(ev?.value || "");
      });
    }
  }
}

// ================================================================
// TMemo — Multiline text (seperti TMemo Delphi)
// ================================================================

export class TMemo extends TComponent {
  private _screen: Screen | null = null;

  constructor(id: string, extraStyle?: Record<string, any>) {
    super(id);
    this.tag = "textarea";
    this.props.rows = 5;
    this.style = {
      width: "100%",
      padding: "8px 12px",
      background: "var(--input-bg, rgba(255,255,255,0.06))",
      border: "1px solid var(--border, rgba(255,255,255,0.12))",
      borderRadius: "6px",
      color: "var(--text, #e0e0e0)",
      fontSize: "13px",
      outline: "none",
      fontFamily: "monospace",
      boxSizing: "border-box",
      resize: "vertical",
      ...extraStyle,
    };
  }

  set text(v: string) {
    this.props.text = v;
    if (this._screen) this._screen.update(this.id, { text: v });
  }
  get text(): string {
    return this.props.text || "";
  }
  set rows(v: number) {
    this.props.rows = v;
  }

  bindEventHandler(screen: Screen): void {
    this._screen = screen;
  }
}

// ================================================================
// TCheckBox — Checkbox (seperti TCheckBox Delphi)
// ================================================================

export class TCheckBox extends TComponent {
  public onClick: ((checked: boolean) => void) | null = null;
  private _screen: Screen | null = null;

  constructor(id: string, extraStyle?: Record<string, any>) {
    super(id);
    this.tag = "div";
    this.props.onClickId = id;
    this.style = {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      cursor: "pointer",
      padding: "0 0",
      margin: "0",
      fontSize: "12px",
      ...extraStyle,
    };
  }

  set caption(v: string) {
    this.props.text = v;
  }
  get caption(): string {
    return this.props.text || "";
  }

  set checked(v: boolean) {
    this.props["data-checked"] = v ? "true" : "false";
  }
  get checked(): boolean {
    return this.props["data-checked"] === "true";
  }

  bindEventHandler(screen: Screen): void {
    this._screen = screen;
    if (this.onClick) {
      screen.on(this.id, "click", () => {
        this.checked = !this.checked;
        // Update visual — rebuild text dengan ☑/☐
        const ch = this.checked;
        screen.update(`${this.id}_sym`, {
          text: ch ? "☑ " : "☐ ",
        });
        this.onClick!(this.checked);
      });
    }
  }

  build(): IDOMNode {
    const ch = this.checked;
    const { text: _t, ...restProps } = this.props;
    return {
      id: this.id,
      tag: this.tag,
      props: {
        ...restProps,
        style: { ...this.style },
      },
      children: [
        {
          id: `${this.id}_sym`,
          tag: "span",
          props: {
            style: { fontSize: "20px", verticalAlign: "middle" },
            text: ch ? "☑ " : "☐ ",
          },
          children: [],
        },
        {
          id: `${this.id}_cap`,
          tag: "span",
          props: {
            style: { fontSize: "11px", verticalAlign: "middle" },
            text: this.caption || "",
          },
          children: [],
        },
      ],
    };
  }
}

// ================================================================
// TListBox — Simple list (seperti TListBox Delphi)
// ================================================================

export class TListBox extends TComponent {
  public items: string[] = [];
  public selectedIndex: number = -1;
  public onClick: ((index: number, item: string) => void) | null = null;
  private _screen: Screen | null = null;

  constructor(id: string) {
    super(id);
    this.tag = "div";
    this.style = {
      background: "var(--surface, rgba(0,0,0,0.2))",
      borderRadius: "6px",
      padding: "4px",
      overflowY: "auto",
      minHeight: "100px",
      border: "1px solid var(--border, rgba(255,255,255,0.08))",
    };
  }

  bindEventHandler(screen: Screen): void {
    this._screen = screen;
  }

  /** Rebuild list items — panggil setelah items berubah */
  async refresh(screen: Screen): Promise<void> {
    const rows: IDOMNode[] = this.items.map((item, i) => ({
      id: `${this.id}_item_${i}`,
      tag: "div",
      props: {
        onClickId: `${this.id}_item_${i}`,
        style: {
          padding: "5px 3px",
          cursor: "pointer",
          fontSize: "12px",
          color:
            i === this.selectedIndex
              ? "var(--accent, #4caf50)"
              : "var(--text-dim, #ccc)",
          background:
            i === this.selectedIndex
              ? "var(--accent-bg, rgba(76,175,80,0.15))"
              : "transparent",
          borderRadius: "4px",
          marginBottom: "0",
        },
        text: item,
      },
      children: [],
    }));

    await screen.setContent(this.id, ...rows);

    for (let i = 0; i < this.items.length; i++) {
      const idx = i;
      screen.on(`${this.id}_item_${i}`, "click", () => {
        this.selectedIndex = idx;
        this.refresh(screen);
        if (this.onClick) this.onClick(idx, this.items[idx]);
      });
    }
  }
}

// ================================================================
// TRadioButton — Radio button dengan grouping (seperti TRadioButton Delphi)
// ================================================================

let _radioGroupCounter = 0;

export class TRadioButton extends TComponent {
  public onClick: ((checked: boolean) => void) | null = null;
  private _screen: Screen | null = null;
  private _group: string;

  constructor(
    id: string,
    group: string = "default",
    extraStyle?: Record<string, any>,
  ) {
    super(id);
    this._group = group;
    this.tag = "div";
    this.props.onClickId = id;
    this.props["data-radio-group"] = group;
    this.style = {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      cursor: "pointer",
      padding: "0 0",
      margin: "0",
      fontSize: "12px",
      ...extraStyle,
    };
  }

  set caption(v: string) {
    this.props.text = v;
  }
  get caption(): string {
    return this.props.text || "";
  }

  set checked(v: boolean) {
    this.props["data-checked"] = v ? "true" : "false";
  }
  get checked(): boolean {
    return this.props["data-checked"] === "true";
  }

  get group(): string {
    return this._group;
  }

  bindEventHandler(screen: Screen): void {
    this._screen = screen;
    if (this.onClick) {
      screen.on(this.id, "click", () => {
        if (this.checked) return; // already selected
        // Uncheck all radios in same group
        const parent = this.parent;
        if (parent) {
          for (const child of parent.children) {
            if (child instanceof TRadioButton && child.group === this.group) {
              child.checked = false;
              screen.update(`${child.id}_sym`, { text: "○ " });
            }
          }
        }
        this.checked = true;
        screen.update(`${this.id}_sym`, { text: "● " });
        this.onClick!(true);
      });
    }
  }

  build(): IDOMNode {
    const ch = this.checked;
    const { text: _t, ...restProps } = this.props;
    return {
      id: this.id,
      tag: this.tag,
      props: {
        ...restProps,
        style: { ...this.style },
      },
      children: [
        {
          id: `${this.id}_sym`,
          tag: "span",
          props: {
            style: { fontSize: "20px", verticalAlign: "middle" },
            text: ch ? "● " : "○ ",
          },
          children: [],
        },
        {
          id: `${this.id}_cap`,
          tag: "span",
          props: {
            style: { fontSize: "11px", verticalAlign: "middle" },
            text: this.caption || "",
          },
          children: [],
        },
      ],
    };
  }
}

// ================================================================
// TComboBox — Dropdown list (seperti TComboBox Delphi)
// ================================================================

export class TComboBox extends TComponent {
  public items: string[] = [];
  public selectedIndex: number = -1;
  public onChange: ((index: number, item: string) => void) | null = null;
  private _screen: Screen | null = null;

  constructor(id: string, extraStyle?: Record<string, any>) {
    super(id);
    this.tag = "select";
    this.props.onInputId = id;
    this.style = {
      width: "100%",
      padding: "8px 10px",
      background: "var(--input-bg, rgba(255,255,255,0.06))",
      border: "1px solid var(--border, rgba(255,255,255,0.12))",
      borderRadius: "6px",
      color: "var(--text, #e0e0e0)",
      fontSize: "13px",
      outline: "none",
      cursor: "pointer",
      boxSizing: "border-box",
      ...extraStyle,
    };
  }

  bindEventHandler(screen: Screen): void {
    this._screen = screen;
    if (this.onChange) {
      screen.on(this.id, "input", (ev: any) => {
        const idx = parseInt(ev?.value || "0", 10);
        if (!isNaN(idx)) {
          this.selectedIndex = idx;
          this.onChange!(idx, this.items[idx] || "");
        }
      });
    }
  }

  build(): IDOMNode {
    // Render <select> dengan <option> children
    const optionNodes: IDOMNode[] = this.items.map((item, i) => ({
      id: `${this.id}_opt_${i}`,
      tag: "option",
      props: {
        value: String(i),
        text: item,
        selected: i === this.selectedIndex ? "selected" : undefined,
        style: { padding: "4px 8px" },
      },
      children: [],
    }));

    return {
      id: this.id,
      tag: this.tag,
      props: {
        ...this.props,
        style: { ...this.style },
      },
      children: optionNodes,
    };
  }
}

// ================================================================
// TStatusBar — Status bar (seperti TStatusBar Delphi)
// ================================================================

// ================================================================
// TStatusBar — Status bar (seperti TStatusBar Delphi)
// ================================================================

export class TStatusBar extends TComponent {
  private _screen: Screen | null = null;
  private _leftSpan: TComponent;
  private _rightSpan: TComponent;

  constructor(id: string, extraStyle?: Record<string, any>) {
    super(id);
    this.tag = "div";
    this.style = {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginTop: "auto",
      padding: "6px 12px",
      borderTop: "1px solid var(--border, #333)",
      fontSize: "11px",
      color: "var(--text-muted, #888)",
      fontFamily: "monospace",
      ...extraStyle,
    };

    // 1. Buat sub-komponen menggunakan base class TComponent asli
    this._leftSpan = new TComponent(`${id}_left`);
    this._leftSpan.tag = "span";
    this._leftSpan.props.text = "";

    this._rightSpan = new TComponent(`${id}_right`);
    this._rightSpan.tag = "span";
    this._rightSpan.props.text = "";

    // 2. Masukkan ke lifecycle children via method add() bawaan parent
    // Ini mengunci agar TComponent.build() otomatis merender keduanya!
    this.add(this._leftSpan);
    this.add(this._rightSpan);
  }

  set leftText(v: string) {
    this._leftSpan.props.text = v;
    // Tembakkan update langsung ke ID sub-komponen kiri
    if (this._screen) {
      this._screen.update(this._leftSpan.id, { text: v });
    }
  }

  get leftText(): string {
    return this._leftSpan.props.text || "";
  }

  set rightText(v: string) {
    this._rightSpan.props.text = v;
    // Tembakkan update langsung ke ID sub-komponen kanan
    if (this._screen) {
      this._screen.update(this._rightSpan.id, { text: v });
    }
  }

  get rightText(): string {
    return this._rightSpan.props.text || "";
  }

  // Backward compatibility untuk .text (otomatis lari ke kiri)
  set text(v: string) {
    this.leftText = v;
  }

  get text(): string {
    return this.leftText;
  }

  bindEventHandler(screen: Screen): void {
    this._screen = screen;
  }
}



// ================================================================
// HSTACK / VSTACK — Layout helpers
// ================================================================

let _almondUid = 0;
function uid(): string {
  return `_al${++_almondUid}`;
}

export function HStack(
  extraStyle?: Record<string, any>,
  ...children: TComponent[]
): TComponent {
  const box = new TComponent(uid());
  box.style = {
    display: "flex",
    gap: "8px",
    alignItems: "center",
    flexWrap: "wrap",
    ...extraStyle,
  };
  children.forEach((c) => box.add(c));
  return box;
}

export function VStack(
  extraStyle?: Record<string, any>,
  ...children: TComponent[]
): TComponent {
  const box = new TComponent(uid());
  box.style = {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    ...extraStyle,
  };
  children.forEach((c) => box.add(c));
  return box;
}

export function Spacer(size: number = 0): TComponent {
  const s = new TComponent(uid());
  if (size > 0)
    s.style = { width: size + "px", height: size + "px", flexShrink: "0" };
  else s.style = { flex: "1" }; // flexible spacer
  return s;
}

// ================================================================
// LAYOUT HELPERS — Align, margins, scroll, grid
// ================================================================

/**
 * Konstanta alignment — tinggal set style position.
 */
export const alNone = "";
export const alTop = "top";
export const alBottom = "bottom";
export const alLeft = "left";
export const alRight = "right";
export const alClient = "client";
export const alCenter = "center";

/**
 * TPanel dengan scroll otomatis (overflow: auto)
 */
export function TScrollBox(
  id: string,
  extraStyle?: Record<string, any>,
): TPanel {
  return new TPanel(id, { overflow: "auto", ...extraStyle });
}

/**
 * TFlowPanel — flex wrap container, items otomatis pindah baris
 */
export function TFlowPanel(
  id: string,
  extraStyle?: Record<string, any>,
): TPanel {
  return new TPanel(id, {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    ...extraStyle,
  });
}

/**
 * TGridPanel — grid dengan jumlah kolom tetap
 */
export function TGridPanel(
  id: string,
  cols: number = 2,
  extraStyle?: Record<string, any>,
): TPanel {
  return new TPanel(id, {
    display: "grid",
    gridTemplateColumns: `repeat(${cols}, 1fr)`,
    gap: "6px",
    ...extraStyle,
  });
}

/** Deteksi split container (TSplitHorizontal/TSplitVertical) — untuk nesting. */
function isSplitContainer(c: TComponent): boolean {
  return !!c.props?.["data-tsix-split"];
}

/**
 * TSplitHorizontal — panel bersebelahan (kiri | kanan), bisa di-drag.
 * Mendukung nesting: child bisa TSplitHorizontal/TSplitVertical lagi.
 * child1 = kiri, child2 = kanan
 */
export function TSplitHorizontal(
  child1: TComponent,
  child2: TComponent,
  ratio: string = "1fr",
): TComponent {
  const box = new TComponent(uid());
  box.props["data-tsix-split"] = "h";
  box.style = {
    display: "flex",
    gap: "0",
    flex: "1",
    minHeight: "0",
    minWidth: "0",
    width: "100%",
    overflow: "hidden",
  };
  // Normalisasi ratio "1fr" (bukan nilai CSS flex yang valid) → "1"
  const flex1 = ratio === "1fr" ? "1" : ratio;
  const styleChild = (
    c: TComponent,
    flex: string,
    minDim: "minWidth" | "minHeight",
  ) => {
    c.style = {
      ...c.style,
      flex,
      [minDim]: "0",
      // Split bertingkat (nested) = container → clip, BUKAN scroll (hindari
      // scrollbar horizontal/vertikal yang tidak diinginkan).
      // Leaf panel = area konten → boleh scroll bila isinya overflow.
      ...(isSplitContainer(c) ? { overflow: "hidden" } : { overflow: "auto" }),
    };
  };
  styleChild(child1, flex1, "minWidth");
  styleChild(child2, "1", "minWidth");
  box.add(child1);
  // Divider yang bisa di-drag
  const divider = new TComponent(uid());
  divider.tag = "div";
  divider.props["data-splitter"] = "h";
  divider.style = {
    width: "5px",
    cursor: "col-resize",
    background: "var(--border, rgba(128,128,128,0.3))",
    flexShrink: "0",
  };
  box.add(divider);
  box.add(child2);
  return box;
}

/**
 * TSplitVertical — panel bertumpuk (atas | bawah), bisa di-drag.
 * Mendukung nesting: child bisa TSplitHorizontal/TSplitVertical lagi.
 * child1 = atas, child2 = bawah
 */
export function TSplitVertical(
  child1: TComponent,
  child2: TComponent,
  ratio: string = "1fr",
): TComponent {
  const box = new TComponent(uid());
  box.props["data-tsix-split"] = "v";
  box.style = {
    display: "flex",
    flexDirection: "column",
    gap: "0",
    flex: "1",
    minHeight: "0",
    minWidth: "0",
    width: "100%",
    height: "100%",
    overflow: "hidden",
  };
  const flex1 = ratio === "1fr" ? "1" : ratio;
  const styleChild = (
    c: TComponent,
    flex: string,
    minDim: "minWidth" | "minHeight",
  ) => {
    c.style = {
      ...c.style,
      flex,
      [minDim]: "0",
      ...(isSplitContainer(c) ? { overflow: "hidden" } : { overflow: "auto" }),
    };
  };
  styleChild(child1, flex1, "minHeight");
  styleChild(child2, "1", "minHeight");
  box.add(child1);
  // Divider yang bisa di-drag
  const divider = new TComponent(uid());
  divider.tag = "div";
  divider.props["data-splitter"] = "v";
  divider.style = {
    height: "5px",
    width: "100%",
    cursor: "row-resize",
    background: "var(--border, rgba(128,128,128,0.3))",
    flexShrink: "0",
  };
  box.add(divider);
  box.add(child2);
  return box;
}

/**
 * TGroupBox — panel dengan border & label (kayak GroupBox Delphi)
 */
export function TGroupBox(
  id: string,
  caption: string,
  extraStyle?: Record<string, any>,
): TPanel {
  const box = new TPanel(id, {
    border: "1px solid var(--accent, rgba(76,175,80,0.3))",
    padding: "10px",
    position: "relative",
    marginTop: "10px",
    ...extraStyle,
  });
  // Label group
  const lbl = new TLabel(`${id}_title`);
  lbl.caption = caption;
  lbl.style = {
    position: "absolute",
    top: "-10px",
    left: "8px",
    background: "var(--bg, #0d1b2a)",
    padding: "0 6px",
    fontSize: "11px",
    color: "var(--accent, #4caf50)",
  };
  box.add(lbl);
  return box;
}

// ================================================================
// IoT WIDGETS — Line Chart, Radial Gauge, Seven-Segment, etc.
// ================================================================

/**
 * TLineChart — Line chart untuk data IoT (spline, fill, grid).
 *
 * Usage:
 *   const chart = new TLineChart("temp-chart", {
 *     data: [25,30,28,35,32], color: "#f44336", spline: true, fill: true
 *   });
 *   form.add(chart);
 */
export class TLineChart extends TComponent {
  private _chartProps: Record<string, any> = {};
  private _screen: Screen | null = null;

  constructor(id: string, props?: Record<string, any>) {
    super(id);
    this._chartProps = { ...props, id };
    if (!this._chartProps.maxPoints) this._chartProps.maxPoints = 15;
  }

  get data(): any[] {
    return this._chartProps.data || [];
  }
  set data(v: any[]) {
    this._chartProps.data = v;
  }
  get color(): string {
    return this._chartProps.color || "#4caf50";
  }
  set color(v: string) {
    this._chartProps.color = v;
  }
  get spline(): boolean {
    return !!this._chartProps.spline;
  }
  set spline(v: boolean) {
    this._chartProps.spline = v;
  }
  get maxPoints(): number {
    return this._chartProps.maxPoints || 15;
  }
  set maxPoints(v: number) {
    this._chartProps.maxPoints = v;
  }
  get minValue(): number | undefined {
    return this._chartProps.minValue;
  }
  set minValue(v: number | undefined) {
    this._chartProps.minValue = v;
  }
  get maxValue(): number | undefined {
    return this._chartProps.maxValue;
  }
  set maxValue(v: number | undefined) {
    this._chartProps.maxValue = v;
  }

  /** Catmull-Rom → cubic Bezier untuk kurva halus */
  private splinePath(pts: number[][]): string {
    if (pts.length === 0) return "";
    if (pts.length === 1)
      return `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    const tension = 0.5;
    let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(pts.length - 1, i + 2)];
      const tx = tension / 6;
      d +=
        ` C ${(p1[0] + (p2[0] - p0[0]) * tx).toFixed(1)} ${(p1[1] + (p2[1] - p0[1]) * tx).toFixed(1)},` +
        ` ${(p2[0] - (p3[0] - p1[0]) * tx).toFixed(1)} ${(p2[1] - (p3[1] - p1[1]) * tx).toFixed(1)},` +
        ` ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
    }
    return d;
  }

  bindEventHandler(screen: Screen): void {
    this._screen = screen;
  }

  /** Update data + render ulang chart (scroll animation) */
  async setData(v: number[]): Promise<void> {
    const oldData = this._chartProps.data || [];
    this._chartProps.data = v;
    if (!this._screen || v.length === 0) return;
    const s = this._screen;
    const raw = v;
    const color = this._chartProps.color || "#4caf50";
    const W = this._chartProps.width || 280;
    const H = this._chartProps.height || 180;
    const pad = { t: 20, r: 12, b: 28, l: 38 };
    const pw = W - pad.l - pad.r;
    const ph = H - pad.t - pad.b;
    const maxPts = this.maxPoints;
    const isFull = v.length >= maxPts;
    const useSpline = this._chartProps.spline;
    // Helper: hitung koordinat chart
    const fixedMin = this.minValue;
    const fixedMax = this.maxValue;
    const calcCoords = (
      data: number[],
      fixRange?: { min: number; max: number },
    ) => {
      const yMin = fixedMin ?? (fixRange ? fixRange.min : Math.min(...data));
      const yMax = fixedMax ?? (fixRange ? fixRange.max : Math.max(...data));
      const yRange = yMax - yMin || 1;
      const toX = (i: number) => pad.l + (i / (maxPts - 1)) * pw;
      const toY = (val: number) => pad.t + ph - ((val - yMin) / yRange) * ph;
      return data.map((y, i) => [toX(i), toY(y)]);
    };
    const makePathD = (coords: number[][]) => {
      if (useSpline) return this.splinePath(coords);
      return coords
        .map(
          (c, i) =>
            (i === 0 ? "M" : "L") + ` ${c[0].toFixed(1)} ${c[1].toFixed(1)}`,
        )
        .join(" ");
    };
    const makeDotsHtml = (coords: number[][], data: number[]) => {
      return coords
        .map((c, di) => {
          const yVal = (data[di] ?? 0).toFixed(1);
          return `<circle cx="${c[0].toFixed(1)}" cy="${c[1].toFixed(1)}" r="4" fill="${color}" title="${yVal}" style="cursor:pointer"/>`;
        })
        .join("");
    };
    const makeAreaD = (pathD: string, coords: number[][]) => {
      const last = coords[coords.length - 1];
      return (
        pathD +
        ` L ${last[0].toFixed(1)} ${pad.t + ph} L ${coords[0][0].toFixed(1)} ${pad.t + ph} Z`
      );
    };
    const renderChart = async (
      coords: number[][],
      data: number[],
      pathD: string,
    ) => {
      await s.update(`lc-line-${this.id}`, { d: pathD });
      if (this._chartProps.fill) {
        await s.update(`lc-area-${this.id}`, { d: makeAreaD(pathD, coords) });
      }
      await s.update(`lc-dots-${this.id}`, {
        innerHTML: makeDotsHtml(coords, data),
      });
    };
    // Hanya scroll jika data sudah penuh (15), selain itu redraw biasa
    if (isFull) {
      const stepPx = pw / (maxPts - 1);
      // Step 1: gambar 16 titik (old + new) — titik baru di kanan (di luar jendela)
      // Pakai range tetap biar titik lama tidak bergeser
      const combMin = fixedMin ?? Math.min(...raw);
      const combMax = fixedMax ?? Math.max(...raw);
      const combRange = { min: combMin, max: combMax };
      const combined = [...oldData, ...raw.slice(-1)];
      const combCoords = calcCoords(combined, combRange);
      const combPathD = makePathD(combCoords);
      await s.update(`lc-scroll-${this.id}`, {
        style: { transition: "none", transform: "translateX(0)" },
      });
      await renderChart(combCoords, combined, combPathD);
      await s.win.flush();
      // Step 2: scroll ke kiri — data lama (A) exit, data baru (P) masuk dari kanan
      await s.update(`lc-scroll-${this.id}`, {
        style: { transition: "transform 0.25s ease-out" },
      });
      await s.win.flush();
      await new Promise((r) => setTimeout(r, 30));
      await s.update(`lc-scroll-${this.id}`, {
        style: { transform: `translateX(-${stepPx}px)` },
      });
      await s.win.flush();
      // Step 3: tunggu scroll selesai, redraw dengan 15 data [B..P]
      await new Promise((r) => setTimeout(r, 270));
      const finalCoords = calcCoords(raw);
      const finalPathD = makePathD(finalCoords);
      await s.update(`lc-scroll-${this.id}`, {
        style: { transition: "none", transform: "translateX(0)" },
      });
      await renderChart(finalCoords, raw, finalPathD);
      await s.win.flush();
    } else {
      // Data belum penuh — redraw biasa tanpa scroll, posisi normal
      const ncoords = calcCoords(raw);
      const npathD = makePathD(ncoords);
      await s.update(`lc-scroll-${this.id}`, {
        style: { transition: "none", transform: "translateX(0)" },
      });
      await renderChart(ncoords, raw, npathD);
      await s.win.flush();
    }
  }

  build(): IDOMNode {
    return lineChart({ ...this._chartProps, id: this.id });
  }
}

/**
 * TRadialGauge — Gauge melingkar ala speedometer.
 *
 * Usage:
 *   const gauge = new TRadialGauge("cpu-gauge", {
 *     value: 72, min: 0, max: 100, color: "#2196f3", unit: "%"
 *   });
 *   form.add(gauge);
 */
export class TRadialGauge extends TComponent {
  private _gaugeProps: Record<string, any> = {};
  private _screen: Screen | null = null;

  constructor(id: string, props?: Record<string, any>) {
    super(id);
    this._gaugeProps = { ...props, id };
  }

  get value(): number {
    return this._gaugeProps.value ?? 0;
  }
  set value(v: number) {
    this._gaugeProps.value = v;
  }
  get color(): string {
    return this._gaugeProps.color || "#4caf50";
  }
  set color(v: string) {
    this._gaugeProps.color = v;
  }

  bindEventHandler(screen: Screen): void {
    this._screen = screen;
  }

  /** Update nilai + render ulang gauge (targeted arc/needle, smooth) */
  async setValue(v: number): Promise<void> {
    this._gaugeProps.value = v;
    if (!this._screen) return;
    const s = this._screen;
    const val = v;
    const min = this._gaugeProps.min ?? 0;
    const max = this._gaugeProps.max ?? 100;
    const size = this._gaugeProps.size || 120;
    const radius = size * 0.36;
    const startAngle = -220,
      endAngle = 40;
    const range = endAngle - startAngle;
    const pct = Math.max(0, Math.min(1, (val - min) / (max - min || 1)));
    const angle = startAngle + range * pct;
    const arcLength =
      (radius * Math.abs(endAngle - startAngle) * Math.PI) / 180;
    const dashOffset = arcLength * (1 - pct);
    const formatted = val % 1 === 0 ? String(Math.round(val)) : val.toFixed(1);
    await s.update(`rg-arc-${this.id}`, {
      style: { strokeDashoffset: String(dashOffset) },
    });
    await s.update(`rg-needle-group-${this.id}`, {
      style: { transform: `rotate(${angle}deg)` },
    });
    await s.update(`rg-val-${this.id}`, { text: formatted });
  }

  build(): IDOMNode {
    return radialGauge({ ...this._gaugeProps, id: this.id });
  }
}

/**
 * TSevenSegment — Display LED 7-segment ala kalkulator.
 *
 * Usage:
 *   const seg = new TSevenSegment("display", {
 *     value: 42.5, digits: 4, decimals: 1, color: "#4caf50"
 *   });
 *   form.add(seg);
 */
export class TSevenSegment extends TComponent {
  private _segProps: Record<string, any> = {};
  private _screen: Screen | null = null;

  constructor(id: string, props?: Record<string, any>) {
    super(id);
    this._segProps = { ...props, id };
  }

  get value(): number {
    return this._segProps.value ?? 0;
  }
  set value(v: number) {
    this._segProps.value = v;
  }

  bindEventHandler(screen: Screen): void {
    this._screen = screen;
  }

  /** Update nilai + render ulang seven segment */
  async setValue(v: number): Promise<void> {
    this._segProps.value = v;
    if (!this._screen) return;
    const html = buildSevenSegmentHtml({ ...this._segProps, id: this.id });
    await this._screen.update(`ss-html-${this.id}`, { innerHTML: html });
  }

  build(): IDOMNode {
    return sevenSegment({ ...this._segProps, id: this.id });
  }
}

/**
 * TIndicatorLamp — Lampu indikator ON/OFF dengan glow effect.
 *
 * Usage:
 *   const lamp = new TIndicatorLamp("power-lamp", {
 *     color: "#4caf50", on: true, label: "POWER"
 *   });
 *   form.add(lamp);
 */
export class TIndicatorLamp extends TComponent {
  private _lampProps: Record<string, any> = {};
  private _screen: Screen | null = null;

  constructor(id: string, props?: Record<string, any>) {
    super(id);
    this._lampProps = { ...props, id };
  }

  get on(): boolean {
    return !!this._lampProps.on;
  }
  set on(v: boolean) {
    this._lampProps.on = v;
  }
  get label(): string {
    return this._lampProps.label || "";
  }
  set label(v: string) {
    this._lampProps.label = v;
  }
  get color(): string {
    return this._lampProps.color || "#4caf50";
  }
  set color(v: string) {
    this._lampProps.color = v;
  }

  bindEventHandler(screen: Screen): void {
    this._screen = screen;
  }

  /** Update state ON/OFF + render ulang lampu */
  async setOn(val: boolean): Promise<void> {
    this._lampProps.on = val;
    if (!this._screen) return;
    const s = this._screen;
    const on = val;
    const color = this.color;
    const size = this._lampProps.size || 36;
    const { innerHTML } = buildIndicatorLampImg({ color, on, size });
    await s.update(`il-html-${this.id}`, { innerHTML });
    await s.update(`il-label-${this.id}`, {
      text: this.label,
      style: {
        fontSize: "11px",
        color: on ? color : theme.colors.textMuted,
        display: "block",
        textAlign: "center",
        marginTop: "6px",
        fontWeight: "600",
      },
    });
    await s.update(`il-${this.id}`, {
      style: {
        flex: "1",
        minWidth: "100px",
        background: theme.colors.card,
        borderRadius: "10px",
        padding: "14px",
        border: `1px solid ${on ? color : theme.colors.border}44`,
        textAlign: "center",
        overflow: "hidden",
      },
    });
  }

  build(): IDOMNode {
    return indicatorLamp({ ...this._lampProps, id: this.id });
  }
}

/**
 * TToggleSwitch — Toggle ON/OFF switch (bisa diklik).
 * Otomatis toggle visual saat diklik + panggil onClick callback.
 *
 * Usage:
 *   const tgl = new TToggleSwitch("fan-toggle", {
 *     color: "#4caf50", on: false, label: "FAN"
 *   });
 *   form.add(tgl);
 *   tgl.onClick = () => { std.log("Toggled!"); };
 */
export class TToggleSwitch extends TComponent {
  private _tglProps: Record<string, any> = {};
  public onClick: (() => void) | null = null;
  private _screen: Screen | null = null;

  constructor(id: string, props?: Record<string, any>) {
    super(id);
    this._tglProps = { ...props, id };
  }

  get on(): boolean {
    return !!this._tglProps.on;
  }
  set on(v: boolean) {
    this._tglProps.on = v;
  }
  get label(): string {
    return this._tglProps.label || "";
  }
  set label(v: string) {
    this._tglProps.label = v;
  }
  get color(): string {
    return this._tglProps.color || "#4caf50";
  }
  set color(v: string) {
    this._tglProps.color = v;
  }

  bindEventHandler(screen: Screen): void {
    this._screen = screen;
    const wrapId = `ts-${this.id}`;
    screen.on(wrapId, "click", async () => {
      // Toggle state
      this._tglProps.on = !this._tglProps.on;
      const on = this._tglProps.on;
      const color = this.color;
      // Theme-aware off-state colors
      const isLight = isLightColor(theme.colors.card);
      const offTrack = isLight ? "#ccc" : "#444";
      const offKnob = isLight ? "#999" : "#777";
      // Re-render SVG via targeted update
      await screen.update(`ts-html-${this.id}`, {
        innerHTML: buildToggleSwitchImg({
          color,
          on,
          size: 48,
          offTrack,
          offKnob,
        }),
      });
      // Update label color
      if (this.label) {
        await screen.update(`ts-label-${this.id}`, {
          style: {
            fontSize: "11px",
            color: on ? color : theme.colors.textMuted,
            display: "block",
            textAlign: "center",
            marginTop: "4px",
            fontWeight: "600",
          },
        });
      }
      // Update card border
      await screen.update(wrapId, {
        style: {
          flex: "1",
          minWidth: "110px",
          background: theme.colors.card,
          borderRadius: "10px",
          padding: "14px",
          border: `1px solid ${on ? color : theme.colors.border}44`,
          textAlign: "center",
          cursor: "pointer",
          overflow: "hidden",
        },
      });
      // Call user callback (await untuk async onClick)
      if (this.onClick) await this.onClick();
    });
  }

  build(): IDOMNode {
    return toggleSwitch({
      ...this._tglProps,
      id: this.id,
      onClickId: `ts-${this.id}`,
    });
  }
}

/**
 * TVerticalGauge — Tabung kaca vertikal berisi cairan.
 *
 * Usage:
 *   const vg = new TVerticalGauge("water-level", {
 *     value: 75, color: "#2196f3", label: "Water Level", unit: "%"
 *   });
 *   form.add(vg);
 */
export class TVerticalGauge extends TComponent {
  private _vgProps: Record<string, any> = {};
  private _screen: Screen | null = null;

  constructor(id: string, props?: Record<string, any>) {
    super(id);
    this._vgProps = { ...props, id };
  }

  get value(): number {
    return this._vgProps.value ?? 0;
  }
  set value(v: number) {
    this._vgProps.value = v;
  }

  bindEventHandler(screen: Screen): void {
    this._screen = screen;
  }

  /** Update nilai + render ulang vertical gauge (targeted water level, smooth) */
  async setValue(v: number): Promise<void> {
    this._vgProps.value = v;
    if (!this._screen) return;
    const s = this._screen;
    const H = this._vgProps.h || 160;
    const r = 10;
    const val = Math.max(0, Math.min(100, v));
    const fillH = Math.max(0, ((H - r * 2) * val) / 100);
    const waterY = H - r - Math.min(fillH, H - r * 2);
    const translateY = `translateY(${waterY}px)`;
    await s.update(`wg-water-${this.id}`, { style: { transform: translateY } });
    await s.update(`wg-grad-${this.id}`, { style: { transform: translateY } });
    await s.update(`wg-surface-${this.id}`, {
      style: { transform: translateY },
    });
    await s.update(`wg-clip-${this.id}`, { style: { transform: translateY } });
    const txt = String(Math.round(val));
    await s.update(`wg-val-bg-${this.id}`, { text: txt });
    await s.update(`wg-val-${this.id}`, { text: txt });
  }

  build(): IDOMNode {
    return verticalGauge({ ...this._vgProps, id: this.id });
  }
}

/**
 * TSensorCard — Kartu sensor IoT dengan progress bar.
 *
 * Usage:
 *   const card = new TSensorCard("temp", {
 *     label: "Temperature", unit: "°C", icon: "🌡️",
 *     color: "#f44336", value: 45, min: 0, max: 100
 *   });
 *   form.add(card);
 */
export class TSensorCard extends TComponent {
  private _cardProps: Record<string, any> = {};
  private _screen: Screen | null = null;

  constructor(id: string, props?: Record<string, any>) {
    super(id);
    this._cardProps = { ...props, id };
  }

  get value(): number | undefined {
    return this._cardProps.value;
  }
  set value(v: number | undefined) {
    this._cardProps.value = v;
  }

  bindEventHandler(screen: Screen): void {
    this._screen = screen;
  }

  /** Update nilai sensor + render ulang */
  async setValue(v: number): Promise<void> {
    this._cardProps.value = v;
    if (!this._screen) return;
    const { min = 0, max = 100 } = this._cardProps;
    const pct = Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100));
    await this._screen.update(`sv-${this.id}`, { text: v.toFixed(1) });
    await this._screen.update(`bar-${this.id}`, {
      style: {
        width: `${pct}%`,
        background: this._cardProps.color || "#4caf50",
        height: "6px",
        borderRadius: "3px",
        transition: "width 0.3s",
      },
    });
  }

  build(): IDOMNode {
    return sensorCard({ ...this._cardProps, id: this.id });
  }
}

/**
 * TRelayCard — Kartu relay ON/OFF untuk panel kontrol.
 *
 * Usage:
 *   const relay = new TRelayCard("fan-relay", {
 *     label: "FAN", icon: "🌀", color: "#4caf50", active: true
 *   });
 *   form.add(relay);
 */
export class TRelayCard extends TComponent {
  private _relayProps: Record<string, any> = {};
  private _screen: Screen | null = null;

  constructor(id: string, props?: Record<string, any>) {
    super(id);
    this._relayProps = { ...props, id };
  }

  get active(): boolean {
    return !!this._relayProps.active;
  }
  set active(v: boolean) {
    this._relayProps.active = v;
  }
  get color(): string {
    return this._relayProps.color || "#4caf50";
  }
  set color(v: string) {
    this._relayProps.color = v;
  }

  bindEventHandler(screen: Screen): void {
    this._screen = screen;
  }

  /** Update state aktif/mati + render ulang */
  async setActive(val: boolean): Promise<void> {
    this._relayProps.active = val;
    if (!this._screen) return;
    const s = this._screen;
    const on = val;
    const color = this.color;
    await s.update(`rc-${this.id}`, {
      style: {
        padding: "12px",
        borderRadius: "8px",
        border: `1px solid ${on ? color : theme.colors.border}`,
        background: on ? `${color}22` : theme.colors.card,
        flex: "1",
        textAlign: "center",
      },
    });
    await s.update(`rs-${this.id}`, {
      text: on ? "🟢 ON" : "⚫ OFF",
      style: {
        color: on ? color : theme.colors.textMuted,
        fontWeight: "700",
        fontSize: "14px",
      },
    });
  }

  build(): IDOMNode {
    return relayCard({ ...this._relayProps, id: this.id });
  }
}

/**
 * TSlider — Slider range horizontal.
 * Otomatis update value display saat digeser + panggil onInput callback.
 *
 * Usage:
 *   const sl = new TSlider("brightness", {
 *     value: 70, min: 0, max: 100, step: 1, color: "#2196f3",
 *     label: "Brightness", unit: "%"
 *   });
 *   form.add(sl);
 */
export class TSlider extends TComponent {
  private _sliderProps: Record<string, any> = {};
  public onInput: ((value: number) => void) | null = null;
  private _screen: Screen | null = null;

  constructor(id: string, props?: Record<string, any>) {
    super(id);
    this._sliderProps = {
      min: 0,
      max: 100,
      step: 1,
      value: 50,
      ...props,
      id,
    };
  }

  get min(): number {
    return this._sliderProps.min ?? 0;
  }
  set min(v: number) {
    this._sliderProps.min = v;
  }

  get max(): number {
    return this._sliderProps.max ?? 100;
  }
  set max(v: number) { 
    this._sliderProps.max = v;
  }

  get value(): number {
    return this._sliderProps.value ?? this.min;
  }
  set value(v: number) {
    // Clamping nilai value agar selalu berada dalam rentang [min, max]
    const clamped = Math.min(Math.max(v, this.min), this.max);
    this._sliderProps.value = clamped;
  }

  bindEventHandler(screen: Screen): void {
    this._screen = screen;
    const inputId = `sl-input-${this.id}`;
    const valId = `sl-val-${this.id}`;
    
    screen.on(inputId, "input", async (ev: any) => {
      if (ev.value !== undefined) {
        let numVal = parseFloat(ev.value);
        if (isNaN(numVal)) return;

        // Pastikan nilai hasil input tidak melenceng dari rentang min/max
        numVal = Math.min(Math.max(numVal, this.min), this.max);
        this._sliderProps.value = numVal;

        // Update displayed value
        const unit = this._sliderProps.unit || "";
        const displayVal =
          numVal % 1 === 0 ? String(Math.round(numVal)) : numVal.toFixed(1);
          
        await screen.update(valId, { text: displayVal + unit });
        if (this.onInput) this.onInput(numVal);
      }
    });
  }

  build(): IDOMNode {
    return slider({
      min: this.min,
      max: this.max,
      step: this._sliderProps.step ?? 1,
      ...this._sliderProps,
      id: this.id,
      value: this.value,
    });
  }
}

// ================================================================
// TTIMER — Delphi-style Timer (managed, auto-cleaned)
// ================================================================

/**
 * TTimer — Interval timer ala Delphi.
 * Otomatis di-cleanup saat form ditutup (pake managed timer dari Screen).
 *
 * Usage:
 *   const timer = new TTimer("tmr-update", 3000);
 *   timer.onTimer = () => { std.log("Tick!"); };
 *   timer.enabled = true;
 *   form.add(timer);
 *
 *   // Atau langsung enabled=true di constructor:
 *   const timer = new TTimer("tmr-update", 3000, true);
 *   timer.onTimer = () => { ... };
 *   form.add(timer);
 *
 * Props:
 *   - interval: ms antar tick (default 1000)
 *   - enabled:  start/stop timer
 *
 * Event:
 *   - onTimer: callback tiap tick
 */
export class TTimer extends TComponent {
  public onTimer: (() => void) | null = null;
  private _interval: number = 1000;
  private _enabled: boolean = false;
  private _screen: Screen | null = null;

  constructor(id: string, interval: number = 1000, enabled: boolean = false) {
    super(id);
    this._interval = interval;
    this._enabled = enabled;
  }

  /** Interval dalam ms */
  get interval(): number {
    return this._interval;
  }
  set interval(v: number) {
    this._interval = v;
    if (this._enabled) this.restart();
  }

  /** Start/stop timer */
  get enabled(): boolean {
    return this._enabled;
  }
  set enabled(v: boolean) {
    if (v === this._enabled) return;
    this._enabled = v;
    if (v) this.start();
    else this.stop();
  }

  bindEventHandler(screen: Screen): void {
    this._screen = screen;
    // Auto-start jika enabled sudah di-set true
    if (this._enabled) this.start();
  }

  private start(): void {
    this.stop();
    if (!this._screen || !this.onTimer) return;
    this._screen.setInterval(() => {
      if (this._enabled && this.onTimer) this.onTimer();
    }, this._interval);
  }

  private stop(): void {
    // Managed timer di-screen akan auto-cleanup saat close
    // Tidak perlu clearInterval manual
  }

  /** Restart timer dengan interval baru */
  private restart(): void {
    if (this._enabled) {
      this.start();
    }
  }
}

// ================================================================
// TCHART — uPlot Chart (real-time, smooth scrolling)
// ================================================================

/**
 * TChart — Wrapper untuk uPlot chart library.
 * Render via DOME IPC ke browser (uPlot di-load di dome-client.html).
 *
 * Usage:
 *   const chart = new TChart("temp-chart", {
 *     width: 300, height: 160,
 *     minValue: 15, maxValue: 45,
 *     label: "°C",
 *   });
 *   form.add(chart);
 *   chart.setData([x1, x2, ...], [y1, y2, ...]);
 *
 * Props:
 *   - width/height: ukuran chart
 *   - minValue/maxValue: range Y tetap
 *   - label: label sumbu Y
 *   - color: warna line (default "#f44336")
 */
export class TChart extends TComponent {
  private _chartOpts: Record<string, any> = {};
  private _wid: string = "";
  private _domePid: number = 0;
  private _lib: any = null;
  private _xData: number[] = [];
  private _yData: number[] = [];
  private _seriesData: Record<string, number[]> = {};
  private _seriesKeys: string[] = [];

  constructor(id: string, props?: Record<string, any>) {
    super(id);
    this._chartOpts = { ...props, id };
    this.tag = "div";
    this.style = {
      width: "100%",
      height: (props?.height || 160) + "px",
      position: "relative",
    };
    // Init multi-series buffer
    const series = props?.series;
    if (Array.isArray(series) && series.length > 0) {
      this._seriesKeys = series.map((s: any) => s.key);
      for (const s of series) {
        this._seriesData[s.key] = [];
      }
    }
  }

  /** Kirim pesan ke browser via DOME */
  private async sendToDome(type: string, extra: Record<string, any> = {}) {
    if (!this._domePid || !this._wid || !this._lib?.shell) return;
    try {
      await this._lib.shell.send(this._domePid, {
        type,
        wid: this._wid,
        targetId: this.id,
        ...extra,
      });
    } catch (_) {
      /* serialization error — skip */
    }
  }

  bindEventHandler(screen: Screen): void {
    this._wid = screen.wid;
    this._lib = (global as any)._tsixLib;
  }

  /** Panggil setelah form.run() — init chart di browser */
  async initChart(): Promise<void> {
    if (!this._lib?.shell) return;
    try {
      const ps = await this._lib.shell.ps();
      const dome = (ps || []).find((p: any) => p.name?.includes("dome"));
      this._domePid = dome ? dome.pid : 0;
      if (this._domePid) await this.init();
    } catch (_) {
      /* DOME might not be running */
    }
  }

  /** Inisialisasi uPlot di browser */
  async init(): Promise<void> {
    const opts = this.buildOpts();
    await this.sendToDome("CHART_INIT", { opts });
  }

  /** Update data chart — auto-shift jika data melebihi maxPoints */
  async setData(xData: number[], yData: number[]): Promise<void> {
    this._xData = xData;
    this._yData = yData;
    const maxPts = this._chartOpts.maxPoints;
    if (maxPts && this._xData.length > maxPts) {
      const excess = this._xData.length - maxPts;
      this._xData = this._xData.slice(excess);
      this._yData = this._yData.slice(excess);
    }
    await this.sendToDome("CHART_DATA", { data: [this._xData, this._yData] });
  }

  /**
   * pushData — Push satu titik data baru.
   *
   * Single series: pushData(timestamp, value)
   * Multi series:  pushData(timestamp, { cpu: 55, mem: 45, disk: 68 })
   *
   * Jika maxPoints diset, data lama otomatis di-shift.
   */
  async pushData(x: number, y: number | Record<string, number>): Promise<void> {
    if (typeof y === "number") {
      // Single series (backward compatible)
      this._xData.push(x);
      this._yData.push(y);
      const maxPts = this._chartOpts.maxPoints;
      if (maxPts && this._xData.length > maxPts) {
        this._xData.shift();
        this._yData.shift();
      }
      await this.sendToDome("CHART_DATA", { data: [this._xData, this._yData] });
    } else if (this._seriesKeys.length > 0) {
      // Multi series
      this._xData.push(x);
      for (const key of this._seriesKeys) {
        this._seriesData[key].push(y[key] ?? 0);
      }
      const maxPts = this._chartOpts.maxPoints;
      if (maxPts && this._xData.length > maxPts) {
        this._xData.shift();
        for (const key of this._seriesKeys) {
          this._seriesData[key].shift();
        }
      }
      const payload: any = { x: [...this._xData], series: {} };
      for (const key of this._seriesKeys) {
        payload.series[key] = [...this._seriesData[key]];
      }
      await this.sendToDome("CHART_DATA", { data: payload });
    }
  }

  /** Hancurkan chart */
  async destroy(): Promise<void> {
    await this.sendToDome("CHART_DESTROY");
  }

  /** Bangun konfigurasi Lightweight Charts */
  private buildOpts(): any {
    const w = this._chartOpts.width || 300;
    const h = this._chartOpts.height || 160;
    const minY = this._chartOpts.minValue;
    const maxY = this._chartOpts.maxValue;
    const color = this._chartOpts.color || "#f44336";
    const label = this._chartOpts.label || "";
    const series = this._chartOpts.series || [];

    // Price scale: series with custom min/max get their own scale
    const enrichedSeries = series.map((s: any) => ({
      ...s,
      priceScaleId:
        s.minValue !== undefined || s.maxValue !== undefined ? s.key : "right",
    }));

    return {
      width: w,
      height: h,
      color,
      label,
      minValue: minY,
      maxValue: maxY,
      series: enrichedSeries,
    };
  }
}

// ================================================================
// TDATAGRID — Tabel data dengan sort & variable column width
// ================================================================

/**
 * TDataGrid — DataGrid Delphi-style (membungkus ConnectedDataGrid).
 *
 * Usage:
 *   const grid = new TDataGrid("sensor", [
 *     { key: "node_id", label: "Node", width: 140 },
 *     { key: "value", label: "Nilai", width: 80, align: "right" },
 *     { key: "timestamp", label: "Waktu", width: "40%" },
 *   ], [], { height: 300 });
 *   form.add(grid);
 *   await grid.setData(rows);      // async — bisa di-await
 *
 * Properti:
 *   - columns: definisi kolom (setter — design-time / runtime)
 *   - data:    baris data (setter — fire-and-forget convenience)
 *   - onSort:  callback saat user klik header (key, dir)
 *   - sort:    state sort saat ini (getter)
 *
 * Metode async (untuk operasi yang perlu di-await):
 *   - setData(rows)
 *   - setColumns(cols)
 *
 * Note: nanti diturunkan menjadi TDBDataGrid (data-bound) pada konsep
 * DataSource/Provider/ClientDataSet. Class ini base yang bersih.
 */
export class TDataGrid extends TComponent {
  public onSort: ((key: string, dir: "asc" | "desc") => void) | null = null;
  /** Dipanggil saat baris diklik: (indexStabilRowKey, record) — index BUKAN nomor baris */
  public onRowClick:
    | ((index: number, record: Record<string, any>) => void)
    | null = null;
  private _columns: DataGridColumn[];
  private _data: Record<string, any>[];
  private grid: ConnectedDataGrid;
  private _screen: Screen | null = null;

  constructor(
    id: string,
    columns: DataGridColumn[] = [],
    data: Record<string, any>[] = [],
    opts: { height?: number | string; maxRows?: number } = {},
  ) {
    super(id);
    this._columns = columns;
    this._data = data;
    this.tag = "div";
    this.grid = new ConnectedDataGrid({
      id,
      columns,
      data,
      height: opts.height,
      maxRows: opts.maxRows,
    });
  }

  /** Definis kolom — setter convenience (design-time & runtime) */
  set columns(v: DataGridColumn[]) {
    this._columns = v;
    this.grid.columns = v;
    if (this._screen) void this.grid.setColumns(v).catch(() => {});
  }
  get columns(): DataGridColumn[] {
    return this._columns;
  }

  /** Data — setter fire-and-forget (convenience). Untuk await, pakai setData(). */
  set data(v: Record<string, any>[]) {
    this._data = v;
    this.grid.data = v;
    if (this._screen) void this.grid.setData(v).catch(() => {});
  }
  get data(): Record<string, any>[] {
    return this._data;
  }

  /** State sort saat ini: { key, dir } atau null */
  get sort(): { key: string; dir: "asc" | "desc" } | null {
    return this.grid.sort;
  }

  // ============================================================
  // SELECTION — cursor berbasis row-key stabil (INDEX ≠ ROW NUMBER)
  // index = kunci di-generate saat row masuk; tahan sort & refresh
  // ============================================================

  /** Kunci stabil baris yang dipilih; -1 jika tak ada */
  get selectedIndex(): number {
    return this.grid.selectedIndex;
  }

  /** Rekaman baris yang dipilih (copy) */
  get selectedRecord(): Record<string, any> | null {
    return this.grid.selectedRecord;
  }

  /**
   * Ambil data row berdasarkan row-key (index stabil).
   * Siap dipakai nanti oleh TDBDataGrid / TDBEdit / ClientDataSet delta.
   */
  getRecord(index: number): Record<string, any> | null {
    return this.grid.getRecord(index);
  }

  /** Programmatic select berdasarkan row-key. index = -1 → clear. */
  async setSelectedIndex(index: number): Promise<void> {
    await this.grid.setSelectedIndex(index);
  }

  /** Hapus seleksi */
  async clearSelection(): Promise<void> {
    await this.grid.clearSelection();
  }

  /** Ganti data — async method (bisa di-await) */
  async setData(v: Record<string, any>[]): Promise<void> {
    this._data = v;
    this.grid.data = v;
    if (this._screen) await this.grid.setData(v);
  }

  /**
   * Tambah data baru INKREMENTAL — hanya baris baru yang dikirim ke browser
   * (mount per baris), tanpa rebuild seluruh tbody. Hemat traffic WS untuk
   * data yang terus bertambah (sniffer, log, telemetry).
   */
  async appendData(v: Record<string, any>[]): Promise<void> {
    this._data = [...(this._data || []), ...v];
    if (this._screen) await this.grid.appendData(v);
  }

  /** Ganti kolom — async method */
  async setColumns(v: DataGridColumn[]): Promise<void> {
    this._columns = v;
    this.grid.columns = v;
    if (this._screen) await this.grid.setColumns(v);
  }

  build(): IDOMNode {
    return this.grid.build();
  }

  /** Auto-bind oleh TForm.run() — daftarkan header sort + klik row + render awal */
  bindEventHandler(screen: Screen): void {
    this._screen = screen;
    void this.grid
      .mount(
        screen,
        (key, dir) => {
          if (this.onSort) this.onSort(key, dir);
        },
        (index, record) => {
          if (this.onRowClick) this.onRowClick(index, record);
        },
      )
      .catch(() => {});
  }

  /** Auto-refresh oleh TForm.run() — render data awal */
  async refresh(screen: Screen): Promise<void> {
    await this.grid.setData(this._data);
  }
}

// ================================================================
// TTABULATORGRID — DataGrid berbasis Tabulator v6 (browser-side)
// ================================================================

/**
 * TTabulatorGrid — DataGrid Delphi-style (membungkus ConnectedTabulator).
 *
 * API 100% SAMA dengan TDataGrid — aplikasi consumer tinggal ganti
 * `new TDataGrid(...)` → `new TTabulatorGrid(...)` tanpa perubahan lain.
 *
 * Berbeda dari TDataGrid (render virtual-DOM app-side), grid ini dirender
 * di sisi browser oleh library Tabulator v6: sort, resize kolom, selection,
 * dan scroll ditangani Tabulator sendiri → bebas dari bug render/setContent
 * yang dulu, dan traffic IPC jauh lebih kecil.
 *
 * Usage:
 *   const grid = new TTabulatorGrid("sensor", [
 *     { key: "node_id", label: "Node", width: 140 },
 *     { key: "value", label: "Nilai", width: 80, align: "right" },
 *     { key: "timestamp", label: "Waktu", width: "40%" },
 *   ], [], { height: 300 });
 *   form.add(grid);
 *   await grid.setData(rows);      // async — bisa di-await
 *
 * Properti & metode sama persis dengan TDataGrid:
 *   - columns / data (setter convenience)
 *   - onSort / onRowClick (callback)
 *   - sort / selectedIndex / selectedRecord / getRecord()
 *   - setData / appendData / setColumns / setSelectedIndex / clearSelection
 */
export class TTabulatorGrid extends TComponent {
  public onSort: ((key: string, dir: "asc" | "desc") => void) | null = null;
  /** Dipanggil saat baris diklik: (indexStabilRowKey, record) — index BUKAN nomor baris */
  public onRowClick:
    | ((index: number, record: Record<string, any>) => void)
    | null = null;
  private _columns: DataGridColumn[];
  private _data: Record<string, any>[];
  private grid: ConnectedTabulator;
  private _screen: Screen | null = null;

  constructor(
    id: string,
    columns: DataGridColumn[] = [],
    data: Record<string, any>[] = [],
    opts: { height?: number | string; maxRows?: number } = {},
  ) {
    super(id);
    this._columns = columns;
    this._data = data;
    this.tag = "div";
    this.grid = new ConnectedTabulator({
      id,
      columns,
      data,
      height: opts.height,
      maxRows: opts.maxRows,
    });
  }

  /** Definisi kolom — setter convenience (design-time & runtime) */
  set columns(v: DataGridColumn[]) {
    this._columns = v;
    this.grid.columns = v;
    if (this._screen) void this.grid.setColumns(v).catch(() => {});
  }
  get columns(): DataGridColumn[] {
    return this._columns;
  }

  /** Data — setter fire-and-forget (convenience). Untuk await, pakai setData(). */
  set data(v: Record<string, any>[]) {
    this._data = v;
    this.grid.data = v;
    if (this._screen) void this.grid.setData(v).catch(() => {});
  }
  get data(): Record<string, any>[] {
    return this._data;
  }

  /** State sort saat ini: { key, dir } atau null */
  get sort(): { key: string; dir: "asc" | "desc" } | null {
    return this.grid.sort;
  }

  // ============================================================
  // SELECTION — cursor berbasis row-key stabil (INDEX ≠ ROW NUMBER)
  // ============================================================

  /** Kunci stabil baris yang dipilih; -1 jika tak ada */
  get selectedIndex(): number {
    return this.grid.selectedIndex;
  }

  /** Rekaman baris yang dipilih (copy) */
  get selectedRecord(): Record<string, any> | null {
    return this.grid.selectedRecord;
  }

  /** Ambil data row berdasarkan row-key (index stabil). */
  getRecord(index: number): Record<string, any> | null {
    return this.grid.getRecord(index);
  }

  /** Programmatic select berdasarkan row-key. index = -1 → clear. */
  async setSelectedIndex(index: number): Promise<void> {
    await this.grid.setSelectedIndex(index);
  }

  /** Hapus seleksi */
  async clearSelection(): Promise<void> {
    await this.grid.clearSelection();
  }

  /**
   * Sort programmatic (dari app): toggle asc ↔ desc.
   * (Tambahan — TDataGrid tidak punya ini; API lain 100% sama.)
   */
  async toggleSort(key: string): Promise<void> {
    await this.grid.toggleSort(key);
  }

  /** Ganti data — async method (bisa di-await) */
  async setData(v: Record<string, any>[]): Promise<void> {
    this._data = v;
    this.grid.data = v;
    if (this._screen) await this.grid.setData(v);
  }

  /**
   * Tambah data baru INKREMENTAL — hanya baris baru yang dikirim ke browser
   * (Tabulator.addData). Hemat traffic WS untuk data yang terus bertambah.
   */
  async appendData(v: Record<string, any>[]): Promise<void> {
    this._data = [...(this._data || []), ...v];
    if (this._screen) await this.grid.appendData(v);
  }

  /** Ganti kolom — async method */
  async setColumns(v: DataGridColumn[]): Promise<void> {
    this._columns = v;
    this.grid.columns = v;
    if (this._screen) await this.grid.setColumns(v);
  }

  build(): IDOMNode {
    return this.grid.build();
  }

  /** Auto-bind oleh TForm.run() — daftarkan sort + klik row + render awal */
  bindEventHandler(screen: Screen): void {
    this._screen = screen;
    void this.grid
      .mount(
        screen,
        (key, dir) => {
          if (this.onSort) this.onSort(key, dir);
        },
        (index, record) => {
          if (this.onRowClick) this.onRowClick(index, record);
        },
      )
      .catch(() => {});
  }

  /** Auto-refresh oleh TForm.run() — render data awal */
  async refresh(screen: Screen): Promise<void> {
    await this.grid.setData(this._data);
  }
}


// ================================================================
// TProgressBar — Progress Bar dengan Efek XOR Klona Ganda (Perfect Clip)
// ================================================================

export class TProgressBar extends TComponent {
  private _screen: Screen | null = null;
  private _bar: TComponent;
  private _fgText: TComponent;
  private _unit: string = "%";

  constructor(id: string, extraStyle?: Record<string, any>) {
    super(id);
    this.tag = "div";
    
    this.props.min = 0;
    this.props.max = 100;
    this.props.value = 0;
    
    this.style = {
      width: "100%",
      height: "18px", // Dipertebal sedikit agar teks lebih proporsional
      background: "var(--input-bg, rgba(255,255,255,0.06))",
      border: "1px solid var(--border, rgba(255,255,255,0.12))",
      borderRadius: "6px",
      overflow: "hidden",
      position: "relative",
      boxSizing: "border-box",
      ...extraStyle,
    };
    // LAYER 2: Progress Bar Pengisi (Bertindak sebagai jendela kliping)
    this._bar = new TComponent(`${id}_bar`);
    this._bar.tag = "div";
    this._bar.style = {
      width: "0%", 
      height: "100%",
      background: "var(--accent, #4caf50)", // Warna bar utama om
      transition: "width 0.2s ease",
      position: "absolute",
      left: "0",
      top: "0",
      overflow: "hidden", // ⚠️ KUNCI UTAMA: Potong teks putih di dalamnya
      zIndex: "2",
    };

    // LAYER 3: Teks klona di dalam bar pengisi (Hanya terlihat saat tertutup bar)
    this._fgText = new TComponent(`${id}_fgtext`);
    this._fgText.tag = "span";
    this._fgText.style = {
      position: "absolute",
      // Karena parent-nya (_bar) lebarnya dinamis bergerak, posisi teks ini harus dikunci 
      // terhadap komponen utama (menggunakan kalkulasi posisi baris tengah)
      left: "50%",
      top: "50%",
      transform: "translate(-50%, -50%)",
      fontSize: "11px",
      fontWeight: "700",
      fontFamily: "monospace",
      color: "#ffffff", // Warna teks kontras saat tertimpa bar (misal: putih murni)
      pointerEvents: "none",
      // Amankan lebar teks agar tidak ciut/wrap saat progress bar masih sangat sempit di kiri
      width: "max-content", 
    };
    this._fgText.props.text = `0${this._unit}`;

    // Susun hirarki komponen sesuai lifecycle Cashew
    this._bar.add(this._fgText); // fgText dimasukkan ke dalam bar
    this.add(this._bar);         // bar dimasukkan ke base container
  }

  set value(v: number) {
    const min = this.props.min ?? 0;
    const max = this.props.max ?? 100;
    const pct = Math.min(100, Math.max(0, ((v - min) / (max - min || 1)) * 100));
    
    this.props.value = v;
    
    // Update blueprint memori internal
    this._bar.style.width = `${pct}%`;
    
    const formattedVal = v % 1 === 0 ? String(Math.round(v)) : v.toFixed(1);
    const textToShow = `${formattedVal}${this._unit}`;
    
    this._fgText.props.text = textToShow;

    // Tembak live update ke browser jika form sudah jalan
    if (this._screen) {
      this._screen.update(this._bar.id, { style: { ...this._bar.style } });
      this._screen.update(this._fgText.id, { text: textToShow });
    }
  }

  get value(): number { return this.props.value ?? 0; }

  set unit(u: string) {
    this._unit = u;
    this.value = this.value;
  }
  get unit(): string { return this._unit; }

  set min(v: number) {
    this.props.min = v;
    this.value = this.value;
  }
  get min(): number { return this.props.min ?? 0; }

  set max(v: number) {
    this.props.max = v;
    this.value = this.value;
  }
  get max(): number { return this.props.max ?? 100; }

  bindEventHandler(screen: Screen): void {
    this._screen = screen;
  }
}

