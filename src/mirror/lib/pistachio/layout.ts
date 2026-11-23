/**
 * pistachio/layout.ts — Container dan tata letak Pistachio.
 *
 * Semua container adalah class (bukan factory function) supaya punya
 * `instanceof`, bisa di-subclass, dan bisa didaftarkan sebagai tipe.
 *
 * (c) 2026 TSIX Project
 */

import { defineProps, TComponent, TOptions } from "./core";

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
    if (this.host) void this.host.update(this._caption.id, { text: value });
  }
}
