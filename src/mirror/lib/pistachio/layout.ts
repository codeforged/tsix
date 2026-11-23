/**
 * pistachio/layout.ts — Container dan tata letak Pistachio.
 *
 * Semua container adalah class (bukan factory function) supaya punya
 * `instanceof`, bisa di-subclass, dan bisa didaftarkan sebagai tipe.
 *
 * (c) 2026 TSIX Project
 */

import { defineProps, EComponentError, TComponent, TOptions, TScreenPort } from "./core";

const SURFACE = "var(--surface, #16213e)";
const BORDER = "1px solid var(--border, rgba(255,255,255,0.12))";
const ACCENT = "var(--accent, #4caf50)";

/** Panel berlatar surface dengan border — container dasar. */
export class TPanel extends TComponent {
  constructor(
    idOrOpts?: string | TOptions,
    opts?: TOptions,
    knownProps: readonly string[] = [],
  ) {
    super(idOrOpts, opts, knownProps);
    this.style = {
      background: SURFACE,
      borderRadius: "8px",
      padding: "10px",
      border: BORDER,
      ...this.style,
    };
  }
}

/** Container flex horizontal (menggantikan `HStack` di Cashew). */
export class THStack extends TComponent {
  constructor(
    idOrOpts?: string | TOptions,
    opts?: TOptions,
    knownProps: readonly string[] = [],
  ) {
    super(idOrOpts, opts, knownProps);
    this.style = {
      display: "flex",
      gap: "8px",
      alignItems: "center",
      flexWrap: "wrap",
      ...this.style,
    };
  }
}

/** Container flex vertikal (menggantikan `VStack` di Cashew). */
export class TVStack extends TComponent {
  constructor(
    idOrOpts?: string | TOptions,
    opts?: TOptions,
    knownProps: readonly string[] = [],
  ) {
    super(idOrOpts, opts, knownProps);
    this.style = {
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      ...this.style,
    };
  }
}

export interface TGridPanelOptions extends TOptions {
  /** Jumlah kolom tetap (default 2). */
  columns?: number;
}

const GRIDPANEL_PROPS = defineProps<TGridPanelOptions>()(["columns"]);

/** Container grid dengan jumlah kolom tetap. */
export class TGridPanel extends TComponent {
  constructor(
    idOrOpts?: string | TGridPanelOptions,
    opts?: TGridPanelOptions,
    knownProps: readonly string[] = [],
  ) {
    super(idOrOpts, opts, [...GRIDPANEL_PROPS, ...knownProps]);
    const columns = (this.options as TGridPanelOptions).columns ?? 2;
    this.style = {
      display: "grid",
      gridTemplateColumns: `repeat(${columns}, 1fr)`,
      gap: "6px",
      ...this.style,
    };
  }
}

/** Container dengan scroll otomatis. */
export class TScrollBox extends TComponent {
  constructor(
    idOrOpts?: string | TOptions,
    opts?: TOptions,
    knownProps: readonly string[] = [],
  ) {
    super(idOrOpts, opts, knownProps);
    this.style = { overflow: "auto", ...this.style };
  }
}

export interface TSpacerOptions extends TOptions {
  /** Ukuran tetap (px). Tanpa nilai = fleksibel mengisi ruang. */
  size?: number;
}

const SPACER_PROPS = defineProps<TSpacerOptions>()(["size"]);

/** Ruang kosong fleksibel atau berukuran tetap. */
export interface TTimerOptions extends TOptions {
  interval?: number;
  enabled?: boolean;
}

const TIMER_PROPS = defineProps<TTimerOptions>()(["interval", "enabled"]);

/** Timer non-visual; interval dijalankan saat komponen ter-bind dan dibersihkan saat dispose. */
export class TTimer extends TComponent {
  public onTimer: (() => void) | null = null;
  private _interval = 1000;
  private _enabled = false;
  private _handle: ReturnType<typeof setInterval> | null = null;

  constructor(idOrOpts?: string | TTimerOptions, opts?: TTimerOptions) {
    super(idOrOpts, opts, TIMER_PROPS);
    const o = this.options as TTimerOptions;
    this._interval = o.interval ?? 1000;
    this._enabled = o.enabled ?? false;
    this.isVisual = false;
  }

  get interval(): number { return this._interval; }
  set interval(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new EComponentError("INVALID_OPTIONS", `Invalid timer interval: ${value}`, this.id);
    }
    this._interval = value;
    if (this._enabled) this.restart();
  }

  get enabled(): boolean { return this._enabled; }
  set enabled(value: boolean) {
    if (value === this._enabled) return;
    this._enabled = value;
    if (value) this.start(); else this.stop();
  }

  override bindEventHandler(host: TScreenPort): void {
    super.bindEventHandler(host);
    this.stop();
    if (this._enabled) this.start();
  }

  override dispose(): void {
    this.stop();
    super.dispose();
  }

  private start(): void {
    this.stop();
    if (!this._enabled || !this.host) return;
    this._handle = setInterval(() => {
      if (this._enabled) this.onTimer?.();
    }, this._interval);
  }

  private restart(): void {
    this.stop();
    if (this._enabled) this.start();
  }

  private stop(): void {
    if (this._handle !== null) {
      clearInterval(this._handle);
      this._handle = null;
    }
  }
}

export interface TSplitOptions extends TOptions {
  orientation?: "horizontal" | "vertical";
  ratio?: string | number;
  first?: TComponent;
  second?: TComponent;
}

const SPLIT_PROPS = defineProps<TSplitOptions>()([
  "orientation", "ratio", "first", "second",
]);

/** Container dua panel dengan divider yang bisa di-drag. */
export class TSplit extends TComponent {
  private readonly _first: TComponent | null;
  private readonly _second: TComponent | null;

  constructor(idOrOpts?: string | TSplitOptions, opts?: TSplitOptions) {
    super(idOrOpts, opts, SPLIT_PROPS);
    const o = this.options as TSplitOptions;
    this._first = o.first ?? null;
    this._second = o.second ?? null;
    const orientation = o.orientation ?? "horizontal";
    const ratio = o.ratio === undefined ? "1fr" : String(o.ratio);

    this.props["data-tsix-split"] = orientation === "vertical" ? "v" : "h";
    this.style = {
      display: "flex",
      flexDirection: orientation === "vertical" ? "column" : "row",
      gap: "0",
      flex: "1",
      minHeight: "0",
      minWidth: "0",
      width: "100%",
      overflow: "hidden",
      ...this.style,
    };

    if (this._first) this.add(this._first);
    const divider = new TComponent({ id: `${this.id}_divider` });
    divider.tag = "div";
    divider.props["data-splitter"] = orientation === "vertical" ? "v" : "h";
    divider.style = orientation === "vertical"
      ? { height: "5px", cursor: "row-resize", background: "var(--border, rgba(128,128,128,0.3))", flexShrink: "0" }
      : { width: "5px", cursor: "col-resize", background: "var(--border, rgba(128,128,128,0.3))", flexShrink: "0" };
    this.add(divider);
    if (this._second) this.add(this._second);

    const flexFirst = ratio === "1fr" ? "1" : ratio;
    if (this._first) this._first.style = {
      ...this._first.style,
      flex: flexFirst,
      ...(orientation === "vertical" ? { minHeight: "0" } : { minWidth: "0" }),
      overflow: "auto",
    };
    if (this._second) this._second.style = {
      ...this._second.style,
      flex: "1",
      ...(orientation === "vertical" ? { minHeight: "0" } : { minWidth: "0" }),
      overflow: "auto",
    };
  }
}

export class TSplitHorizontal extends TSplit {
  constructor(idOrOpts?: string | TSplitOptions, opts?: TSplitOptions) {
    super(idOrOpts, { orientation: "horizontal", ...(opts ?? {}) });
  }
}

export class TSplitVertical extends TSplit {
  constructor(idOrOpts?: string | TSplitOptions, opts?: TSplitOptions) {
    super(idOrOpts, { orientation: "vertical", ...(opts ?? {}) });
  }
}

export class TSpacer extends TComponent {
  constructor(
    idOrOpts?: string | TSpacerOptions,
    opts?: TSpacerOptions,
    knownProps: readonly string[] = [],
  ) {
    super(idOrOpts, opts, [...SPACER_PROPS, ...knownProps]);
    const size = (this.options as TSpacerOptions).size ?? 0;
    this.style = size > 0
      ? { width: `${size}px`, height: `${size}px`, flexShrink: "0" }
      : { flex: "1" };
  }
}

export interface TGroupBoxOptions extends TOptions {
  caption?: string;
}

const GROUPBOX_PROPS = defineProps<TGroupBoxOptions>()(["caption"]);

/** Panel bergaris dengan judul di atas border. */
export class TGroupBox extends TPanel {
  private readonly _caption: TComponent;

  constructor(idOrOpts?: string | TGroupBoxOptions, opts?: TGroupBoxOptions) {
    super(idOrOpts, opts, GROUPBOX_PROPS);
    const caption = (this.options as TGroupBoxOptions).caption ?? "";

    this.style = {
      position: "relative",
      marginTop: "10px",
      border: `1px solid ${ACCENT}`,
      ...this.style,
    };

    this._caption = new TComponent({ id: `${this.id}_caption` });
    this._caption.tag = "span";
    this._caption.style = {
      position: "absolute",
      top: "-10px",
      left: "8px",
      background: "var(--bg, #0d1b2a)",
      padding: "0 6px",
      fontSize: "11px",
      color: ACCENT,
    };
    this._caption.props.text = caption;
    this.add(this._caption);
  }

  get caption(): string {
    return this._caption.props.text ?? "";
  }
  set caption(value: string) {
    this._caption.props.text = value;
    if (this.host) this.background(this.host.update(this._caption.id, { text: value }), "update");
  }
}
