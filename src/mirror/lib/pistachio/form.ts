/**
 * pistachio/form.ts — Jendela aplikasi Pistachio.
 *
 * TForm menjembatani core (tanpa DOM) ke emerald `Screen`. Semua komponen
 * lain hanya melihat `TScreenPort`, sehingga bisa diuji tanpa DOME.
 *
 * (c) 2026 TSIX Project
 */

import { Keyboard, Screen } from "@tsix/emerald";
import { theme } from "@tsix/theme";
import { shell } from "@tsix/Application";
import { defineProps, TComponent, TKeyEvent, TOptions, TScreenPort } from "./core";

const FORM_OPTIONS = defineProps<TFormOptions>()([
  "title",
  "icon",
  "width",
  "height",
  "maximizable",
  "resizable",
  "fullscreen",
  "frameless",
  "left",
  "top",
  "desktopCentered",
]);

export interface TFormOptions extends TOptions {
  title?: string;
  icon?: string;
  width?: number;
  height?: number;
  maximizable?: boolean;
  resizable?: boolean;
  fullscreen?: boolean;
  frameless?: boolean;
  left?: number;
  top?: number;
  desktopCentered?: boolean;
}

export class TForm extends TComponent {
  public onSetup: ((form: TForm) => Promise<void> | void) | null = null;
  public onClose: (() => void) | null = null;

  private _screen: Screen | null = null;
  private _keyboardUnbind: (() => void) | null = null;
  private _closePrepared = false;
  private readonly _title: string;
  private readonly _icon?: string;
  private readonly _width: number;
  private readonly _height: number;
  private readonly _maximizable: boolean;
  private readonly _resizable: boolean;
  private readonly _fullscreen: boolean;
  private readonly _frameless: boolean;
  private readonly _left?: number;
  private readonly _top?: number;
  private readonly _desktopCentered: boolean;

  constructor(idOrOpts?: string | TFormOptions, opts?: TFormOptions) {
    super(idOrOpts, opts, FORM_OPTIONS);
    const o = this.options as TFormOptions;

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

    this.style = {
      padding: "12px",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      background: "var(--bg, #0d1b2a)",
      color: "var(--text, #e0e0e0)",
      fontFamily: "'Segoe UI', sans-serif",
      fontSize: "13px",
      ...this.style,
    };
  }

  get screen(): Screen | null {
    return this._screen;
  }

  get title(): string {
    return this._title;
  }

  override bindEventHandler(host: TScreenPort): void {
    super.bindEventHandler(host);
    this.unbindKeyboard();
    this._keyboardUnbind =
      host.keyboard?.on((event) => {
        if (event.down && !event.repeat) this.handleKeyEvent(event);
      }) ?? null;
  }

  /** Mount window, bind event, jalankan setup, lalu tunggu sampai ditutup. */
  async run(): Promise<void> {
    const screen = new Screen({
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
    });
    this._screen = screen;

    await applyTheme(screen);
    await screen.mount(this.build());

    const keyboard = new Keyboard(screen.win, {
      targetId: `${this.id}_kb`,
    });
    await keyboard.attach();
    screen.keyboard = keyboard;

    this.bindTree(this, screen);
    await this.refreshTree(this);

    try {
      if (this.onSetup) await this.onSetup(this);
      await screen.loopUntilClose(() => this.prepareForClose());
    } finally {
      this.unbindKeyboard();
      this.disposeTree({ unmount: false });
    }
  }

  /** Perbesar window ke ukuran penuh viewport. */
  async maximize(): Promise<void> {
    await this._screen?.maximize();
  }

  /** Sembunyikan window (iconify). */
  async minimize(): Promise<void> {
    await this._screen?.minimize();
  }

  /** Kembalikan window dari keadaan minimize. */
  async restore(): Promise<void> {
    await this._screen?.restore();
  }

  /** Kembalikan window dari keadaan maximized ke ukuran sebelumnya. */
  async unMaximize(): Promise<void> {
    const screen = this._screen as unknown as {
      unmaximize?: () => Promise<unknown>;
      unMaximize?: () => Promise<unknown>;
    } | null;
    if (screen?.unmaximize) await screen.unmaximize();
    else if (screen?.unMaximize) await screen.unMaximize();
  }

  /** Tutup window dan hancurkan seluruh subtree. */
  async close(): Promise<void> {
    this.prepareForClose();
    await this._screen?.keyboard?.detach();
    await this._screen?.close();
  }

  override dispose(): void {
    this.unbindKeyboard();
    super.dispose();
  }

  /** Komponen yang ditambahkan setelah `run()` langsung tampil. */
  protected onChildAdded(child: TComponent, parent: TComponent): void {
    const screen = this._screen;
    if (!screen) return;

    if (child.isVisual) this.background(screen.mount(child.build(), parent.id), "mount");
    this.bindTree(child, screen);
    this.background(this.refreshTree(child), "refresh");
  }

  private bindTree(component: TComponent, host: TScreenPort): void {
    component.bindEventHandler(host);
    for (const child of component.children) this.bindTree(child, host);
  }

  private async refreshTree(component: TComponent): Promise<void> {
    await component.refresh();
    for (const child of component.children) await this.refreshTree(child);
  }

  private unbindKeyboard(): void {
    this._keyboardUnbind?.();
    this._keyboardUnbind = null;
  }

  private prepareForClose(): void {
    if (this._closePrepared) return;
    this._closePrepared = true;
    try {
      this.onClose?.();
    } finally {
      this.unbindKeyboard();
      this.disposeTree({ unmount: false });
    }
  }
}

/** Terapkan tema DOME ke window; kegagalan tema tidak boleh menggagalkan app. */
async function applyTheme(screen: Screen): Promise<void> {
  try {
    await theme.loadCurrent();
    theme.watch();

    const processes = await shell.ps();
    const dome = processes.find((process: any) => process.name?.includes("dome"));
    if (!dome?.pid || !shell.send) return;

    await shell.send(dome.pid, {
      type: "WINDOW_THEME",
      wid: screen.win.wid,
      colors: {
        titlebar: theme.colors.windowTitlebar,
        border: theme.colors.windowBorder,
        shadow: theme.colors.windowShadow,
        bg: theme.colors.bg,
        surface: theme.colors.surface,
        buttonBg: theme.colors.buttonBg,
        accent: theme.colors.accent,
        text: theme.colors.text,
        textDim: theme.colors.textDim,
        textMuted: theme.colors.textMuted,
        borderColor: theme.colors.border,
        inputBg: theme.colors.inputBg,
        accentBg: theme.colors.accentBg,
      },
    });
  } catch (_) {
    // Tema opsional — jangan blokir start aplikasi.
  }
}
