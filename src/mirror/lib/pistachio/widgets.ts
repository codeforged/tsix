/**
 * pistachio/widgets.ts — Widget Pistachio.
 *
 * `TDataGrid` di sini **bukan** bagian dari stack database: datanya diisi
 * manual oleh aplikasi (`setData`/`appendData`). Nanti `TDBGrid` yang akan
 * mengisi grid ini lewat `TDataSource`.
 *
 * (c) 2026 TSIX Project
 */

import {
  ConnectedDataGrid,
  DataGridColumn,
  Screen,
  indicatorLamp,
  lineChart,
  radialGauge,
  relayCard,
  sensorCard,
  sevenSegment,
  toggleSwitch,
  verticalGauge,
} from "@tsix/emerald";
import { TComponent, TNode, TOptions, TScreenPort, TStyle } from "./core";

export type { DataGridColumn };

export interface TDataGridOptions extends TOptions {
  columns?: DataGridColumn[];
  data?: Record<string, any>[];
  /** Tinggi wrapper (number = px). Kosong = mengikuti isi. */
  height?: number | string;
  /** Batas baris yang dipertahankan di tampilan (0 = tanpa batas). */
  maxRows?: number;
}

export class TDataGrid extends TComponent {
  public onSort: ((key: string, dir: "asc" | "desc") => void) | null = null;
  /** index = row-key stabil (tahan sorting), bukan nomor baris tampil. */
  public onRowClick:
    | ((index: number, record: Record<string, any>) => void)
    | null = null;
  public onRowContextMenu:
    | ((
        index: number,
        record: Record<string, any>,
        x: number,
        y: number,
      ) => void)
    | null = null;

  private readonly _grid: ConnectedDataGrid;
  private _columns: DataGridColumn[];
  private _data: Record<string, any>[];

  constructor(
    idOrOpts?: string | TDataGridOptions,
    opts?: TDataGridOptions,
    knownProps: readonly string[] = [],
  ) {
    super(idOrOpts, opts, ["columns", "data", "height", "maxRows", ...knownProps]);
    const o = this.options as TDataGridOptions;

    this.tag = "div";
    this._columns = o.columns ?? [];
    this._data = o.data ?? [];
    this._grid = new ConnectedDataGrid({
      id: this.id,
      columns: this._columns,
      data: this._data,
      height: o.height,
      maxRows: o.maxRows,
    });
  }

  get columns(): readonly DataGridColumn[] {
    return this._columns;
  }
  set columns(value: DataGridColumn[]) {
    void this.setColumns(value);
  }

  get data(): readonly Record<string, any>[] {
    return this._data;
  }
  set data(value: Record<string, any>[]) {
    void this.setData(value);
  }

  get sort(): { key: string; dir: "asc" | "desc" } | null {
    return this._grid.sort;
  }

  /** Row-key stabil baris terpilih; -1 bila tidak ada. */
  get selectedIndex(): number {
    return this._grid.selectedIndex;
  }

  get selectedRecord(): Record<string, any> | null {
    return this._grid.selectedRecord;
  }

  getRecord(index: number): Record<string, any> | null {
    return this._grid.getRecord(index);
  }

  async setSelectedIndex(index: number): Promise<void> {
    await this._grid.setSelectedIndex(index);
  }

  async clearSelection(): Promise<void> {
    await this._grid.clearSelection();
  }

  /** Ganti seluruh data. Sebelum mount hanya menyimpan, tanpa render. */
  async setData(rows: Record<string, any>[]): Promise<void> {
    this._data = Array.isArray(rows) ? [...rows] : [];
    this._grid.data = this._data;
    if (this.host) await this._grid.setData(this._data);
  }

  /** Tambah baris secara inkremental (hanya baris baru yang dikirim ke UI). */
  async appendData(rows: Record<string, any>[]): Promise<void> {
    if (rows.length === 0) return;
    this._data = [...this._data, ...rows];
    if (this.host) await this._grid.appendData(rows);
  }

  async setColumns(columns: DataGridColumn[]): Promise<void> {
    this._columns = columns;
    this._grid.columns = columns;
    if (this.host) await this._grid.setColumns(columns);
  }

  build(): TNode {
    return this._grid.build();
  }

  bindEventHandler(host: TScreenPort): void {
    super.bindEventHandler(host);
    void this._grid.mount(
      host as unknown as Screen,
      (key, dir) => this.onSort?.(key, dir),
      (index, record) => this.onRowClick?.(index, record),
      (index, record, x, y) => this.onRowContextMenu?.(index, record, x, y),
    );
  }
}


// ================================================================
// WIDGET IOT — pembungkus builder emerald
// ================================================================

/**
 * Widget yang tampilannya berasal dari builder emerald.
 *
 * Strategi update: view lama di-unmount, view baru di-mount dengan id stabil
 * `(id)` yang diturunkan dari id komponen. Ini menghindari duplikasi logika
 * path SVG/HTML di setiap widget.
 */
abstract class TViewWidget extends TComponent {
  private _viewId: string | null = null;

  protected constructor(
    idOrOpts: string | TOptions | undefined,
    opts: TOptions | undefined,
    knownProps: readonly string[],
  ) {
    super(idOrOpts, opts, knownProps);
    this.tag = "div";
  }

  protected abstract buildView(): TNode;

  /** Penyesuaian node view sebelum dipasang (mis. ukuran kartu seragam). */
  protected decorate(view: TNode): TNode {
    return view;
  }

  /** Id node view (root yang dikembalikan builder emerald). */
  protected get viewId(): string | null {
    return this._viewId;
  }

  build(): TNode {
    const view = this.decorate(this.buildView());
    this._viewId = view.id;
    return {
      id: this.id,
      tag: this.tag,
      props: { style: { ...this.style } },
      children: [view],
    };
  }

  protected async rerender(): Promise<void> {
    const host = this.host;
    if (!host) return;

    const view = this.decorate(this.buildView());
    if (this._viewId) await host.unmount?.(this._viewId);
    await host.mount(view, this.id);
    this._viewId = view.id;
  }
}

/** Footprint seragam untuk kartu IoT (lampu, switch, relay, sensor, gauge). */
const CARD_WIDTH = 132;
const CARD_HEIGHT = 156;

/**
 * Kartu berukuran tetap supaya rapi saat ditempatkan di TGroupBox maupun
 * TGridPanel. Ukuran bisa di-override lewat `style` komponen.
 */
abstract class TCardWidget extends TViewWidget {
  protected constructor(
    idOrOpts: string | TOptions | undefined,
    opts: TOptions | undefined,
    knownProps: readonly string[],
  ) {
    super(idOrOpts, opts, knownProps);
    this.style = {
      width: `${CARD_WIDTH}px`,
      minWidth: `${CARD_WIDTH}px`,
      height: `${CARD_HEIGHT}px`,
      flex: "0 0 auto",
      display: "flex",
      alignItems: "stretch",
      boxSizing: "border-box",
      ...this.style,
    };
  }

  protected decorate(view: TNode): TNode {
    view.props.style = {
      ...(view.props.style || {}),
      flex: "1 1 auto",
      width: "100%",
      height: "100%",
      minWidth: "0",
      boxSizing: "border-box",
      overflow: "hidden",
    };
    return view;
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export interface TProgressBarOptions extends TOptions {
  value?: number;
  color?: string;
  track?: string;
  height?: number;
}

/** Bar progres 0–100. */
export class TProgressBar extends TComponent {
  private _value: number;
  private readonly _color: string;
  private readonly _track: string;
  private readonly _height: number;

  constructor(
    idOrOpts?: string | TProgressBarOptions,
    opts?: TProgressBarOptions,
  ) {
    super(idOrOpts, opts, ["value", "color", "track", "height"]);
    const o = this.options as TProgressBarOptions;
    this._value = clampPercent(o.value ?? 0);
    this._color = o.color ?? "var(--accent, #4caf50)";
    this._track = o.track ?? "rgba(255,255,255,0.08)";
    this._height = o.height ?? 8;
  }

  get value(): number {
    return this._value;
  }
  set value(value: number) {
    this._value = clampPercent(value);
    if (this.host) {
      void this.host.update(`${this.id}_fill`, {
        style: { width: `${this._value}%` },
      });
    }
  }

  build(): TNode {
    return {
      id: this.id,
      tag: "div",
      props: {
        style: {
          background: this._track,
          borderRadius: "6px",
          overflow: "hidden",
          height: `${this._height}px`,
          width: "100%",
          ...this.style,
        },
      },
      children: [
        {
          id: `${this.id}_fill`,
          tag: "div",
          props: {
            style: {
              height: "100%",
              width: `${this._value}%`,
              background: this._color,
              borderRadius: "6px",
              transition: "width 0.2s ease-out",
            },
          },
          children: [],
        },
      ],
    };
  }
}

export interface TIndicatorLampOptions extends TOptions {
  on?: boolean;
  color?: string;
  label?: string;
  size?: number;
}

export class TIndicatorLamp extends TCardWidget {
  private _on: boolean;
  private readonly _color: string;
  private readonly _label: string;
  private readonly _size: number;

  constructor(
    idOrOpts?: string | TIndicatorLampOptions,
    opts?: TIndicatorLampOptions,
  ) {
    super(idOrOpts, opts, ["on", "color", "label", "size"]);
    const o = this.options as TIndicatorLampOptions;
    this._on = Boolean(o.on);
    this._color = o.color ?? "var(--accent, #4caf50)";
    this._label = o.label ?? "";
    this._size = o.size ?? 36;
  }

  get on(): boolean {
    return this._on;
  }
  set on(value: boolean) {
    if (value === this._on) return;
    this._on = value;
    void this.rerender();
  }

  protected buildView(): TNode {
    return indicatorLamp({
      id: this.id,
      on: this._on,
      color: this._color,
      label: this._label,
      size: this._size,
    });
  }
}

export interface TToggleSwitchOptions extends TOptions {
  on?: boolean;
  color?: string;
  label?: string;
  size?: number;
}

export class TToggleSwitch extends TCardWidget {
  public onClick: ((on: boolean) => void) | null = null;
  private _on: boolean;
  private readonly _color: string;
  private readonly _label: string;
  private readonly _size: number;

  constructor(
    idOrOpts?: string | TToggleSwitchOptions,
    opts?: TToggleSwitchOptions,
  ) {
    super(idOrOpts, opts, ["on", "color", "label", "size"]);
    const o = this.options as TToggleSwitchOptions;
    this._on = Boolean(o.on);
    this._color = o.color ?? "var(--accent, #4caf50)";
    this._label = o.label ?? "";
    this._size = o.size ?? 48;
  }

  get on(): boolean {
    return this._on;
  }
  set on(value: boolean) {
    if (value === this._on) return;
    this._on = value;
    void this.rerender();
  }

  protected buildView(): TNode {
    return toggleSwitch({
      id: this.id,
      on: this._on,
      color: this._color,
      label: this._label,
      size: this._size,
      onClickId: `ts-${this.id}`,
    });
  }

  bindEventHandler(host: TScreenPort): void {
    super.bindEventHandler(host);
    host.on(`ts-${this.id}`, "click", () => {
      this._on = !this._on;
      this.onClick?.(this._on);
      void this.rerender();
    });
  }
}

export interface TRelayCardOptions extends TOptions {
  active?: boolean;
  color?: string;
  label?: string;
  icon?: string;
}

export class TRelayCard extends TCardWidget {
  public onToggle: ((active: boolean) => void) | null = null;
  private _active: boolean;
  private readonly _color: string;
  private readonly _label: string;
  private readonly _icon: string;

  constructor(
    idOrOpts?: string | TRelayCardOptions,
    opts?: TRelayCardOptions,
  ) {
    super(idOrOpts, opts, ["active", "color", "label", "icon"]);
    const o = this.options as TRelayCardOptions;
    this._active = Boolean(o.active);
    this._color = o.color ?? "var(--accent, #4caf50)";
    this._label = o.label ?? "Relay";
    this._icon = o.icon ?? "⚡";
  }

  get active(): boolean {
    return this._active;
  }
  set active(value: boolean) {
    if (value === this._active) return;
    this._active = value;
    void this.rerender();
  }

  protected buildView(): TNode {
    const view = relayCard({
      id: this.id,
      active: this._active,
      color: this._color,
      label: this._label,
      icon: this._icon,
    });
    view.props.onClickId = view.id;
    view.props.style = { ...(view.props.style || {}), cursor: "pointer" };
    return view;
  }

  bindEventHandler(host: TScreenPort): void {
    super.bindEventHandler(host);
    host.on(`rc-${this.id}`, "click", () => {
      this._active = !this._active;
      this.onToggle?.(this._active);
      void this.rerender();
    });
  }
}

export interface TSensorCardOptions extends TOptions {
  value?: number;
  label?: string;
  unit?: string;
  icon?: string;
  color?: string;
  min?: number;
  max?: number;
}

export class TSensorCard extends TCardWidget {
  private _value: number;
  private readonly _label: string;
  private readonly _unit: string;
  private readonly _icon: string;
  private readonly _color: string;
  private readonly _min: number;
  private readonly _max: number;

  constructor(
    idOrOpts?: string | TSensorCardOptions,
    opts?: TSensorCardOptions,
  ) {
    super(idOrOpts, opts, ["value", "label", "unit", "icon", "color", "min", "max"]);
    const o = this.options as TSensorCardOptions;
    this._value = o.value ?? 0;
    this._label = o.label ?? "Sensor";
    this._unit = o.unit ?? "";
    this._icon = o.icon ?? "📡";
    this._color = o.color ?? "var(--accent, #4caf50)";
    this._min = o.min ?? 0;
    this._max = o.max ?? 100;
  }

  get value(): number {
    return this._value;
  }
  set value(value: number) {
    if (value === this._value) return;
    this._value = value;
    void this.rerender();
  }

  protected buildView(): TNode {
    return sensorCard({
      id: this.id,
      value: this._value,
      label: this._label,
      unit: this._unit,
      icon: this._icon,
      color: this._color,
      min: this._min,
      max: this._max,
    });
  }
}

export interface TLineChartOptions extends TOptions {
  data?: number[];
  color?: string;
  spline?: boolean;
  fill?: boolean;
  width?: number;
  height?: number;
}

export class TLineChart extends TViewWidget {
  private _data: number[];
  private readonly _color: string;
  private readonly _spline: boolean;
  private readonly _fill: boolean;
  private readonly _width: number;
  private readonly _height: number;

  constructor(
    idOrOpts?: string | TLineChartOptions,
    opts?: TLineChartOptions,
  ) {
    super(idOrOpts, opts, ["data", "color", "spline", "fill", "width", "height"]);
    const o = this.options as TLineChartOptions;
    this._data = [...(o.data ?? [])];
    this._color = o.color ?? "var(--accent, #4caf50)";
    this._spline = Boolean(o.spline);
    this._fill = Boolean(o.fill);
    this._width = o.width ?? 280;
    this._height = o.height ?? 180;
  }

  get data(): readonly number[] {
    return this._data;
  }
  set data(value: number[]) {
    void this.setData(value);
  }

  async setData(values: number[]): Promise<void> {
    this._data = [...values];
    await this.rerender();
  }

  protected buildView(): TNode {
    return lineChart({
      id: this.id,
      data: this._data,
      color: this._color,
      spline: this._spline,
      fill: this._fill,
      width: this._width,
      height: this._height,
    });
  }
}

export interface TRadialGaugeOptions extends TOptions {
  value?: number;
  min?: number;
  max?: number;
  color?: string;
  size?: number;
  label?: string;
  unit?: string;
}

export class TRadialGauge extends TCardWidget {
  private _value: number;
  private readonly _min: number;
  private readonly _max: number;
  private readonly _color: string;
  private readonly _size: number;
  private readonly _label: string;
  private readonly _unit: string;

  constructor(
    idOrOpts?: string | TRadialGaugeOptions,
    opts?: TRadialGaugeOptions,
  ) {
    super(idOrOpts, opts, ["value", "min", "max", "color", "size", "label", "unit"]);
    const o = this.options as TRadialGaugeOptions;
    this._value = o.value ?? 0;
    this._min = o.min ?? 0;
    this._max = o.max ?? 100;
    this._color = o.color ?? "var(--accent, #4caf50)";
    this._size = o.size ?? 92;
    this._label = o.label ?? "";
    this._unit = o.unit ?? "";
  }

  get value(): number {
    return this._value;
  }
  set value(value: number) {
    if (value === this._value) return;
    this._value = value;
    void this.rerender();
  }

  protected buildView(): TNode {
    return radialGauge({
      id: this.id,
      value: this._value,
      min: this._min,
      max: this._max,
      color: this._color,
      size: this._size,
      label: this._label,
      unit: this._unit,
    });
  }
}

export interface TSevenSegmentOptions extends TOptions {
  value?: number;
  digits?: number;
  decimals?: number;
  color?: string;
  label?: string;
  scale?: number;
}

export class TSevenSegment extends TViewWidget {
  private _value: number;
  private readonly _digits: number;
  private readonly _decimals: number;
  private readonly _color: string;
  private readonly _label: string;
  private readonly _scale: number;

  constructor(
    idOrOpts?: string | TSevenSegmentOptions,
    opts?: TSevenSegmentOptions,
  ) {
    super(idOrOpts, opts, ["value", "digits", "decimals", "color", "label", "scale"]);
    const o = this.options as TSevenSegmentOptions;
    this._value = o.value ?? 0;
    this._digits = o.digits ?? 4;
    this._decimals = o.decimals ?? 0;
    this._color = o.color ?? "var(--accent, #4caf50)";
    this._label = o.label ?? "";
    this._scale = o.scale ?? 1;
  }

  get value(): number {
    return this._value;
  }
  set value(value: number) {
    if (value === this._value) return;
    this._value = value;
    void this.rerender();
  }

  protected buildView(): TNode {
    return sevenSegment({
      id: this.id,
      value: this._value,
      digits: this._digits,
      decimals: this._decimals,
      color: this._color,
      label: this._label,
      scale: this._scale,
    });
  }
}

export interface TVerticalGaugeOptions extends TOptions {
  value?: number;
  color?: string;
  label?: string;
  unit?: string;
  width?: number;
  height?: number;
}

export class TVerticalGauge extends TViewWidget {
  private _value: number;
  private readonly _color: string;
  private readonly _label: string;
  private readonly _unit: string;
  private readonly _width: number;
  private readonly _height: number;

  constructor(
    idOrOpts?: string | TVerticalGaugeOptions,
    opts?: TVerticalGaugeOptions,
  ) {
    super(idOrOpts, opts, ["value", "color", "label", "unit", "width", "height"]);
    const o = this.options as TVerticalGaugeOptions;
    this._value = clampPercent(o.value ?? 0);
    this._color = o.color ?? "#2196f3";
    this._label = o.label ?? "";
    this._unit = o.unit ?? "%";
    this._width = o.width ?? 48;
    this._height = o.height ?? 160;
  }

  get value(): number {
    return this._value;
  }
  set value(value: number) {
    const next = clampPercent(value);
    if (next === this._value) return;
    this._value = next;
    void this.rerender();
  }

  protected buildView(): TNode {
    return verticalGauge({
      id: this.id,
      value: this._value,
      color: this._color,
      label: this._label,
      unit: this._unit,
      w: this._width,
      h: this._height,
    });
  }
}
