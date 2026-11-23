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
  ConnectedTabulator,
  DataGridColumn,
  Screen,
  indicatorLamp,
  lineChart,
  radialGauge,
  relayCard,
  sensorCard,
  sevenSegment,
  slider,
  toggleSwitch,
  verticalGauge,
} from "@tsix/emerald";
import { fs } from "@tsix/Application";
import {
  defineProps,
  EComponentError,
  type TErrorHandler,
  TComponent,
  TNode,
  TOptions,
  TScreenPort,
  TStyle,
} from "./core";

export type { DataGridColumn };

interface TGridOptions extends TOptions {
  columns?: DataGridColumn[];
  data?: Record<string, any>[];
  /** Tinggi wrapper (number = px). Kosong = mengikuti isi. */
  height?: number | string;
  /** Batas baris yang dipertahankan di tampilan (0 = tanpa batas). */
  maxRows?: number;
}

export interface TDataGridOptions extends TGridOptions {}
export interface TTabulatorGridOptions extends TGridOptions {
  /** Izinkan pemilihan baris (default true). */
  selectable?: boolean;
}

/** Kontrak minimum yang dipakai Pistachio dari grid emerald. */
interface TEmbeddedGrid {
  columns: DataGridColumn[];
  data: Record<string, any>[];
  build(): TNode;
  setData(rows: Record<string, any>[]): Promise<void>;
  appendData(rows: Record<string, any>[]): Promise<void>;
  setColumns(columns: DataGridColumn[]): Promise<void>;
  readonly selectedIndex: number;
  readonly selectedRecord: Record<string, any> | null;
  getRecord(index: number): Record<string, any> | null;
  setSelectedIndex(index: number): Promise<void>;
  setSelectedRecord(record: Record<string, any> | null): Promise<void>;
  clearSelection(): Promise<void>;
  readonly sort: { key: string; dir: "asc" | "desc" } | null;
  toggleSort?(key: string): Promise<void>;
}

const GRID_OPTIONS = defineProps<TGridOptions>()(["columns", "data", "height", "maxRows"]);

/**
 * Basis grid data manual. Subclass hanya menentukan grid emerald yang dipakai
 * dan cara mount-nya; seluruh API publik seragam.
 */
abstract class TGridBase<TG extends TEmbeddedGrid> extends TComponent {
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

  protected readonly _grid: TG;
  private _columns: DataGridColumn[];
  private _data: Record<string, any>[];

  protected constructor(
    idOrOpts: string | TGridOptions | undefined,
    opts: TGridOptions | undefined,
    knownProps: readonly string[] = [],
  ) {
    super(idOrOpts, opts, [...GRID_OPTIONS, ...knownProps]);
    const o = this.options as TGridOptions;

    this.tag = "div";
    this._columns = o.columns ?? [];
    this._data = o.data ?? [];
    this._grid = this.createGrid();
  }

  protected abstract createGrid(): TG;
  protected abstract mountGrid(host: TScreenPort): void;

  // Hook event dari UI. Wiring internal subclass (mis. TDBGrid) meng-override
  // hook ini, bukan meng-assign event publik milik aplikasi.
  protected handleSort(key: string, dir: "asc" | "desc"): void {
    this.onSort?.(key, dir);
  }

  protected handleRowClick(index: number, record: Record<string, any>): void {
    this.onRowClick?.(index, record);
  }

  protected handleRowContextMenu(
    index: number,
    record: Record<string, any>,
    x: number,
    y: number,
  ): void {
    this.onRowContextMenu?.(index, record, x, y);
  }

  get columns(): readonly DataGridColumn[] {
    return this._columns;
  }
  set columns(value: DataGridColumn[]) {
    this.background(this.setColumns(value), "setColumns");
  }

  get data(): readonly Record<string, any>[] {
    return this._data;
  }
  set data(value: Record<string, any>[]) {
    this.background(this.setData(value), "setData");
  }

  get sort(): { key: string; dir: "asc" | "desc" } | null {
    return this._grid.sort;
  }

  /** Toggle sort untuk kolom; jika grid belum mendukungnya, lempar UNSUPPORTED. */
  async toggleSort(key: string): Promise<void> {
    if (!this._grid.toggleSort) {
      throw new EComponentError("UNSUPPORTED", `Grid "${this.id}" does not support toggleSort`, this.id);
    }
    await this._grid.toggleSort(key);
  }

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

  async setSelectedRecord(record: Record<string, any> | null): Promise<void> {
    await this._grid.setSelectedRecord(record);
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
    this.mountGrid(host);
  }
}

/** Grid data manual berbasis tabel HTML (ConnectedDataGrid). */
export class TDataGrid extends TGridBase<ConnectedDataGrid> {
  constructor(
    idOrOpts?: string | TDataGridOptions,
    opts?: TDataGridOptions,
    knownProps: readonly string[] = [],
  ) {
    super(idOrOpts, opts, knownProps);
  }

  protected createGrid(): ConnectedDataGrid {
    const o = this.options as TDataGridOptions;
    return new ConnectedDataGrid({
      id: this.id,
      columns: o.columns ?? [],
      data: o.data ?? [],
      height: o.height,
      maxRows: o.maxRows,
    });
  }

  protected mountGrid(host: TScreenPort): void {
    this.background(this._grid.mount(
      host as unknown as Screen,
      (key, dir) => this.handleSort(key, dir),
      (index, record) => this.handleRowClick(index, record),
      (index, record, x, y) => this.handleRowContextMenu(index, record, x, y),
    ), "grid mount");
  }
}

const TABULATOR_PROPS = defineProps<TTabulatorGridOptions, TGridOptions>()([
  "selectable",
]);

/**
 * Grid data manual berbasis Tabulator (virtualized, cocok untuk banyak baris).
 */
export class TTabulatorGrid extends TGridBase<ConnectedTabulator> {
  /** Seleksi berubah; `record` null bila seleksi dikosongkan. */
  public onSelect:
    | ((index: number, record: Record<string, any> | null) => void)
    | null = null;

  /** Baris diaktifkan (double-click). */
  public onActivate:
    | ((index: number, record: Record<string, any>) => void)
    | null = null;

  constructor(
    idOrOpts?: string | TTabulatorGridOptions,
    opts?: TTabulatorGridOptions,
    knownProps: readonly string[] = [],
  ) {
    super(idOrOpts, opts, [...TABULATOR_PROPS, ...knownProps]);
  }

  protected createGrid(): ConnectedTabulator {
    const o = this.options as TTabulatorGridOptions;
    return new ConnectedTabulator({
      id: this.id,
      columns: o.columns ?? [],
      data: o.data ?? [],
      height: o.height,
      maxRows: o.maxRows,
      selectable: o.selectable,
    });
  }

  protected mountGrid(host: TScreenPort): void {
    this.background(this._grid.mount(
      host as unknown as Screen,
      (key, dir) => this.handleSort(key, dir),
      (index, record) => this.handleRowClick(index, record),
      (index, record, x, y) => this.handleRowContextMenu(index, record, x, y),
      (index, record) => this.handleSelect(index, record),
      (index, record) => this.handleActivate(index, record),
    ), "grid mount");
  }

  protected handleSelect(index: number, record: Record<string, any> | null): void {
    this.onSelect?.(index, record);
  }

  protected handleActivate(index: number, record: Record<string, any>): void {
    this.onActivate?.(index, record);
  }
}

function findNode(node: TNode, id: string): TNode | null {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
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
  private _renderQueue: Promise<void> = Promise.resolve();

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

  private createView(): TNode {
    const view = this.decorate(this.buildView());
    if (view.id === this.id) view.id = `${this.id}__view`;
    return view;
  }

  build(): TNode {
    const view = this.createView();
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

    const render = async () => {
      if (this.host !== host || this.disposed) return;
      const view = this.createView();
      if (this._viewId) await host.unmount?.(this._viewId);
      if (this.host !== host || this.disposed) return;
      await host.mount(view, this.id);
      this._viewId = view.id;
    };

    const pending = this._renderQueue.then(render, render);
    this._renderQueue = pending;
    await pending;
  }
}

/** Footprint seragam untuk kartu IoT (lampu, switch, relay, sensor, gauge). */
export const CARD_WIDTH = 132;
export const CARD_HEIGHT = 156;

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
    const userStyle = this.style;

    this.style = {
      width: `${CARD_WIDTH}px`,
      minWidth: `${CARD_WIDTH}px`,
      height: `${CARD_HEIGHT}px`,
      flex: "0 0 auto",
      display: "flex",
      alignItems: "stretch",
      boxSizing: "border-box",
      ...userStyle,
    };

    // Ikuti lebar pilihan app supaya tidak terkunci oleh minWidth default.
    if (userStyle.width !== undefined && userStyle.minWidth === undefined) {
      this.style.minWidth = userStyle.width;
    }
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
      display: "flex",
      flexDirection: "column",
      alignItems: "stretch",
      justifyContent: "center",
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

const PROGRESSBAR_PROPS = defineProps<TProgressBarOptions>()([
  "value",
  "color",
  "track",
  "height",
]);

/** Bar progres 0–100. */
export class TProgressBar extends TComponent {
  private _value: number;
  private _color: string;
  private _track: string;
  private _height: number;

  constructor(
    idOrOpts?: string | TProgressBarOptions,
    opts?: TProgressBarOptions,
  ) {
    super(idOrOpts, opts, PROGRESSBAR_PROPS);
    const o = this.options as TProgressBarOptions;
    this._value = clampPercent(o.value ?? 0);
    this._color = o.color ?? "var(--accent, #4caf50)";
    this._track = o.track ?? "rgba(255,255,255,0.08)";
    this._height = o.height ?? 8;
  }

  get color(): string {
    return this._color;
  }
  set color(value: string) {
    if (value === this._color) return;
    this._color = value;
    if (this.host) this.background(this.host.update(`${this.id}_fill`, { style: { background: value } }), "update");
  }

  get track(): string {
    return this._track;
  }
  set track(value: string) {
    if (value === this._track) return;
    this._track = value;
    if (this.host) this.background(this.host.update(this.id, { style: this.barStyle() }), "update");
  }

  get height(): number {
    return this._height;
  }
  set height(value: number) {
    if (value === this._height) return;
    this._height = value;
    if (this.host) this.background(this.host.update(this.id, { style: this.barStyle() }), "update");
  }

  get value(): number {
    return this._value;
  }
  set value(value: number) {
    this._value = clampPercent(value);
    if (this.host) {
      this.background(this.host.update(`${this.id}_fill`, {
        style: { width: `${this._value}%` },
      }), "update");
    }
  }

  private barStyle(): Record<string, any> {
    return {
      background: this._track,
      borderRadius: "6px",
      overflow: "hidden",
      height: `${this._height}px`,
      width: "100%",
      ...this.style,
    };
  }

  build(): TNode {
    return {
      id: this.id,
      tag: "div",
      props: { style: this.barStyle() },
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
  caption?: string;
  size?: number;
}

const INDICATORLAMP_PROPS = defineProps<TIndicatorLampOptions>()([
  "on",
  "color",
  "caption",
  "size",
]);

export class TIndicatorLamp extends TCardWidget {
  private _on: boolean;
  private _color: string;
  private _caption: string;
  private _size: number;

  constructor(
    idOrOpts?: string | TIndicatorLampOptions,
    opts?: TIndicatorLampOptions,
  ) {
    super(idOrOpts, opts, INDICATORLAMP_PROPS);
    const o = this.options as TIndicatorLampOptions;
    this._on = Boolean(o.on);
    this._color = o.color ?? "var(--accent, #4caf50)";
    this._caption = o.caption ?? "";
    this._size = o.size ?? 36;
  }

  get color(): string {
    return this._color;
  }
  set color(value: string) {
    if (value === this._color) return;
    this._color = value;
    this.background(this.rerender(), "render");
  }

  get caption(): string {
    return this._caption;
  }
  set caption(value: string) {
    if (value === this._caption) return;
    this._caption = value;
    this.background(this.rerender(), "render");
  }

  get size(): number {
    return this._size;
  }
  set size(value: number) {
    if (value === this._size) return;
    this._size = value;
    this.background(this.rerender(), "render");
  }

  get on(): boolean {
    return this._on;
  }
  set on(value: boolean) {
    if (value === this._on) return;
    this._on = value;
    this.background(this.rerender(), "render");
  }

  protected buildView(): TNode {
    return indicatorLamp({
      id: this.id,
      on: this._on,
      color: this._color,
      label: this._caption,
      size: this._size,
    });
  }
}

export interface TToggleSwitchOptions extends TOptions {
  on?: boolean;
  /** Jangan ubah indikator saat diklik; tunggu state dari pemilik data. */
  controlled?: boolean;
  color?: string;
  caption?: string;
  size?: number;
}

const TOGGLESWITCH_PROPS = defineProps<TToggleSwitchOptions>()([
  "on",
  "controlled",
  "color",
  "caption",
  "size",
]);

export class TToggleSwitch extends TCardWidget {
  /** User menggeser switch; mode `controlled` hanya meminta `on` baru. */
  public onChange: ((on: boolean) => void) | null = null;
  private _on: boolean;
  private _color: string;
  private _caption: string;
  private _size: number;
  private readonly _controlled: boolean;

  constructor(
    idOrOpts?: string | TToggleSwitchOptions,
    opts?: TToggleSwitchOptions,
  ) {
    super(idOrOpts, opts, TOGGLESWITCH_PROPS);
    const o = this.options as TToggleSwitchOptions;
    this._on = Boolean(o.on);
    this._controlled = Boolean(o.controlled);
    this._color = o.color ?? "var(--accent, #4caf50)";
    this._caption = o.caption ?? "";
    this._size = o.size ?? 48;
  }

  get color(): string {
    return this._color;
  }
  set color(value: string) {
    if (value === this._color) return;
    this._color = value;
    this.background(this.rerender(), "render");
  }

  get caption(): string {
    return this._caption;
  }
  set caption(value: string) {
    if (value === this._caption) return;
    this._caption = value;
    this.background(this.rerender(), "render");
  }

  get size(): number {
    return this._size;
  }
  set size(value: number) {
    if (value === this._size) return;
    this._size = value;
    this.background(this.rerender(), "render");
  }

  get on(): boolean {
    return this._on;
  }
  set on(value: boolean) {
    if (value === this._on) return;
    this._on = value;
    this.background(this.rerender(), "render");
  }

  protected buildView(): TNode {
    return toggleSwitch({
      id: this.id,
      on: this._on,
      color: this._color,
      label: this._caption,
      size: this._size,
      onClickId: `ts-${this.id}`,
    });
  }

  bindEventHandler(host: TScreenPort): void {
    super.bindEventHandler(host);
    host.on(`ts-${this.id}`, "click", () => {
      const requestedState = !this._on;
      if (this._controlled) {
        this.onChange?.(requestedState);
        return;
      }
      this._on = requestedState;
      this.onChange?.(requestedState);
      this.background(this.rerender(), "render");
    });
  }
}

export interface TRelayCardOptions extends TOptions {
  active?: boolean;
  color?: string;
  caption?: string;
  icon?: string;
}

const RELAYCARD_PROPS = defineProps<TRelayCardOptions>()([
  "active",
  "color",
  "caption",
  "icon",
]);

export class TRelayCard extends TCardWidget {
  /** User menekan kartu relay. */
  public onChange: ((active: boolean) => void) | null = null;
  private _active: boolean;
  private _color: string;
  private _caption: string;
  private _icon: string;

  constructor(
    idOrOpts?: string | TRelayCardOptions,
    opts?: TRelayCardOptions,
  ) {
    super(idOrOpts, opts, RELAYCARD_PROPS);
    const o = this.options as TRelayCardOptions;
    this._active = Boolean(o.active);
    this._color = o.color ?? "var(--accent, #4caf50)";
    this._caption = o.caption ?? "Relay";
    this._icon = o.icon ?? "⚡";
  }

  get color(): string {
    return this._color;
  }
  set color(value: string) {
    if (value === this._color) return;
    this._color = value;
    this.background(this.rerender(), "render");
  }

  get caption(): string {
    return this._caption;
  }
  set caption(value: string) {
    if (value === this._caption) return;
    this._caption = value;
    this.background(this.rerender(), "render");
  }

  get icon(): string {
    return this._icon;
  }
  set icon(value: string) {
    if (value === this._icon) return;
    this._icon = value;
    this.background(this.rerender(), "render");
  }

  get active(): boolean {
    return this._active;
  }
  set active(value: boolean) {
    if (value === this._active) return;
    this._active = value;
    this.background(this.rerender(), "render");
  }

  protected buildView(): TNode {
    const view = relayCard({
      id: this.id,
      active: this._active,
      color: this._color,
      label: this._caption,
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
      this.onChange?.(this._active);
      this.background(this.rerender(), "render");
    });
  }
}

export interface TSensorCardOptions extends TOptions {
  value?: number;
  caption?: string;
  unit?: string;
  icon?: string;
  color?: string;
  min?: number;
  max?: number;
}

const SENSORCARD_PROPS = defineProps<TSensorCardOptions>()([
  "value",
  "caption",
  "unit",
  "icon",
  "color",
  "min",
  "max",
]);

export class TSensorCard extends TCardWidget {
  private _value: number;
  private _caption: string;
  private _unit: string;
  private _icon: string;
  private _color: string;
  private _min: number;
  private _max: number;

  constructor(
    idOrOpts?: string | TSensorCardOptions,
    opts?: TSensorCardOptions,
  ) {
    super(idOrOpts, opts, SENSORCARD_PROPS);
    const o = this.options as TSensorCardOptions;
    this._value = o.value ?? 0;
    this._caption = o.caption ?? "Sensor";
    this._unit = o.unit ?? "";
    this._icon = o.icon ?? "📡";
    this._color = o.color ?? "var(--accent, #4caf50)";
    this._min = o.min ?? 0;
    this._max = o.max ?? 100;
  }

  get caption(): string {
    return this._caption;
  }
  set caption(value: string) {
    if (value === this._caption) return;
    this._caption = value;
    this.background(this.rerender(), "render");
  }

  get unit(): string {
    return this._unit;
  }
  set unit(value: string) {
    if (value === this._unit) return;
    this._unit = value;
    this.background(this.rerender(), "render");
  }

  get icon(): string {
    return this._icon;
  }
  set icon(value: string) {
    if (value === this._icon) return;
    this._icon = value;
    this.background(this.rerender(), "render");
  }

  get color(): string {
    return this._color;
  }
  set color(value: string) {
    if (value === this._color) return;
    this._color = value;
    this.background(this.rerender(), "render");
  }

  get min(): number {
    return this._min;
  }
  set min(value: number) {
    if (value === this._min) return;
    this._min = value;
    this.background(this.rerender(), "render");
  }

  get max(): number {
    return this._max;
  }
  set max(value: number) {
    if (value === this._max) return;
    this._max = value;
    this.background(this.rerender(), "render");
  }

  get value(): number {
    return this._value;
  }
  set value(value: number) {
    if (value === this._value) return;
    this._value = value;
    this.background(this.rerender(), "render");
  }

  protected buildView(): TNode {
    return sensorCard({
      id: this.id,
      value: this._value,
      label: this._caption,
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
  viewStyle?: Record<string, any>;
  showXAxisLabels?: boolean;
  showYAxisLabels?: boolean;
}

const LINECHART_PROPS = defineProps<TLineChartOptions>()([
  "data",
  "color",
  "spline",
  "fill",
  "width",
  "height",
  "viewStyle",
  "showXAxisLabels",
  "showYAxisLabels",
]);

export class TLineChart extends TViewWidget {
  private _data: number[];
  private _color: string;
  private _spline: boolean;
  private _fill: boolean;
  private _width: number;
  private _height: number;
  private _viewStyle: Record<string, any>;
  private _showXAxisLabels: boolean;
  private _showYAxisLabels: boolean;

  constructor(
    idOrOpts?: string | TLineChartOptions,
    opts?: TLineChartOptions,
  ) {
    super(idOrOpts, opts, LINECHART_PROPS);
    const o = this.options as TLineChartOptions;
    this._data = [...(o.data ?? [])];
    this._color = o.color ?? "var(--accent, #4caf50)";
    this._spline = Boolean(o.spline);
    this._fill = Boolean(o.fill);
    this._width = o.width ?? 280;
    this._height = o.height ?? 180;
    this._viewStyle = { ...(o.viewStyle ?? {}) };
    this._showXAxisLabels = o.showXAxisLabels ?? true;
    this._showYAxisLabels = o.showYAxisLabels ?? true;
  }

  get color(): string {
    return this._color;
  }
  set color(value: string) {
    if (value === this._color) return;
    this._color = value;
    this.background(this.rerender(), "render");
  }

  get spline(): boolean {
    return this._spline;
  }
  set spline(value: boolean) {
    if (value === this._spline) return;
    this._spline = value;
    this.background(this.rerender(), "render");
  }

  get fill(): boolean {
    return this._fill;
  }
  set fill(value: boolean) {
    if (value === this._fill) return;
    this._fill = value;
    this.background(this.rerender(), "render");
  }

  get width(): number {
    return this._width;
  }
  set width(value: number) {
    if (value === this._width) return;
    this._width = value;
    this.background(this.rerender(), "render");
  }

  get height(): number {
    return this._height;
  }
  set height(value: number) {
    if (value === this._height) return;
    this._height = value;
    this.background(this.rerender(), "render");
  }

  get viewStyle(): Record<string, any> {
    return this._viewStyle;
  }
  set viewStyle(value: Record<string, any>) {
    if (value === this._viewStyle) return;
    this._viewStyle = value;
    this.background(this.rerender(), "render");
  }

  get showXAxisLabels(): boolean {
    return this._showXAxisLabels;
  }
  set showXAxisLabels(value: boolean) {
    if (value === this._showXAxisLabels) return;
    this._showXAxisLabels = value;
    this.background(this.rerender(), "render");
  }

  get showYAxisLabels(): boolean {
    return this._showYAxisLabels;
  }
  set showYAxisLabels(value: boolean) {
    if (value === this._showYAxisLabels) return;
    this._showYAxisLabels = value;
    this.background(this.rerender(), "render");
  }

  get data(): readonly number[] {
    return this._data;
  }
  set data(value: number[]) {
    this.background(this.setData(value), "setData");
  }

  async setData(values: number[]): Promise<void> {
    if (
      values.length === this._data.length &&
      values.every((value, index) => value === this._data[index])
    ) return;
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
      style: this._viewStyle,
      showXAxisLabels: this._showXAxisLabels,
      showYAxisLabels: this._showYAxisLabels,
    });
  }
}

export interface TRadialGaugeOptions extends TOptions {
  value?: number;
  min?: number;
  max?: number;
  color?: string;
  size?: number;
  caption?: string;
  unit?: string;
}

const RADIALGAUGE_PROPS = defineProps<TRadialGaugeOptions>()([
  "value",
  "min",
  "max",
  "color",
  "size",
  "caption",
  "unit",
]);

export class TRadialGauge extends TCardWidget {
  private _value: number;
  private _min: number;
  private _max: number;
  private _color: string;
  private _size: number;
  private _caption: string;
  private _unit: string;

  constructor(
    idOrOpts?: string | TRadialGaugeOptions,
    opts?: TRadialGaugeOptions,
  ) {
    super(idOrOpts, opts, RADIALGAUGE_PROPS);
    const o = this.options as TRadialGaugeOptions;
    this._value = o.value ?? 0;
    this._min = o.min ?? 0;
    this._max = o.max ?? 100;
    this._color = o.color ?? "var(--accent, #4caf50)";
    this._size = o.size ?? 92;
    this._caption = o.caption ?? "";
    this._unit = o.unit ?? "";
  }

  get min(): number {
    return this._min;
  }
  set min(value: number) {
    if (value === this._min) return;
    this._min = value;
    this.background(this.rerender(), "render");
  }

  get max(): number {
    return this._max;
  }
  set max(value: number) {
    if (value === this._max) return;
    this._max = value;
    this.background(this.rerender(), "render");
  }

  get color(): string {
    return this._color;
  }
  set color(value: string) {
    if (value === this._color) return;
    this._color = value;
    this.background(this.rerender(), "render");
  }

  get size(): number {
    return this._size;
  }
  set size(value: number) {
    if (value === this._size) return;
    this._size = value;
    this.background(this.rerender(), "render");
  }

  get caption(): string {
    return this._caption;
  }
  set caption(value: string) {
    if (value === this._caption) return;
    this._caption = value;
    this.background(this.rerender(), "render");
  }

  get unit(): string {
    return this._unit;
  }
  set unit(value: string) {
    if (value === this._unit) return;
    this._unit = value;
    this.background(this.rerender(), "render");
  }

  get value(): number {
    return this._value;
  }
  set value(value: number) {
    if (value === this._value) return;
    this._value = value;
    this.background(this.rerender(), "render");
  }

  protected buildView(): TNode {
    return radialGauge({
      id: this.id,
      value: this._value,
      min: this._min,
      max: this._max,
      color: this._color,
      size: this._size,
      label: this._caption,
      unit: this._unit,
    });
  }
}

export interface TSevenSegmentOptions extends TOptions {
  value?: number;
  digits?: number;
  decimals?: number;
  color?: string;
  caption?: string;
  scale?: number;
}

const SEVENSEGMENT_PROPS = defineProps<TSevenSegmentOptions>()([
  "value",
  "digits",
  "decimals",
  "color",
  "caption",
  "scale",
]);

export class TSevenSegment extends TViewWidget {
  private _value: number;
  private _digits: number;
  private _decimals: number;
  private _color: string;
  private _caption: string;
  private _scale: number;

  constructor(
    idOrOpts?: string | TSevenSegmentOptions,
    opts?: TSevenSegmentOptions,
  ) {
    super(idOrOpts, opts, SEVENSEGMENT_PROPS);
    const o = this.options as TSevenSegmentOptions;
    this._value = o.value ?? 0;
    this._digits = o.digits ?? 4;
    this._decimals = o.decimals ?? 0;
    this._color = o.color ?? "var(--accent, #4caf50)";
    this._caption = o.caption ?? "";
    this._scale = o.scale ?? 1;
  }

  get digits(): number {
    return this._digits;
  }
  set digits(value: number) {
    if (value === this._digits) return;
    this._digits = value;
    this.background(this.rerender(), "render");
  }

  get decimals(): number {
    return this._decimals;
  }
  set decimals(value: number) {
    if (value === this._decimals) return;
    this._decimals = value;
    this.background(this.rerender(), "render");
  }

  get color(): string {
    return this._color;
  }
  set color(value: string) {
    if (value === this._color) return;
    this._color = value;
    this.background(this.rerender(), "render");
  }

  get caption(): string {
    return this._caption;
  }
  set caption(value: string) {
    if (value === this._caption) return;
    this._caption = value;
    this.background(this.rerender(), "render");
  }

  get scale(): number {
    return this._scale;
  }
  set scale(value: number) {
    if (value === this._scale) return;
    this._scale = value;
    this.background(this.rerender(), "render");
  }

  get value(): number {
    return this._value;
  }
  set value(value: number) {
    if (value === this._value) return;
    this._value = value;
    this.background(this.rerender(), "render");
  }

  protected buildView(): TNode {
    return sevenSegment({
      id: this.id,
      value: this._value,
      digits: this._digits,
      decimals: this._decimals,
      color: this._color,
      label: this._caption,
      scale: this._scale,
    });
  }
}

export interface TVerticalGaugeOptions extends TOptions {
  value?: number;
  color?: string;
  caption?: string;
  unit?: string;
  width?: number;
  height?: number;
}

const VERTICALGAUGE_PROPS = defineProps<TVerticalGaugeOptions>()([
  "value",
  "color",
  "caption",
  "unit",
  "width",
  "height",
]);

export class TVerticalGauge extends TViewWidget {
  private _value: number;
  private _color: string;
  private _caption: string;
  private _unit: string;
  private _width: number;
  private _height: number;

  constructor(
    idOrOpts?: string | TVerticalGaugeOptions,
    opts?: TVerticalGaugeOptions,
  ) {
    super(idOrOpts, opts, VERTICALGAUGE_PROPS);
    const o = this.options as TVerticalGaugeOptions;
    this._value = clampPercent(o.value ?? 0);
    this._color = o.color ?? "#2196f3";
    this._caption = o.caption ?? "";
    this._unit = o.unit ?? "%";
    this._width = o.width ?? 48;
    this._height = o.height ?? 160;
  }

  get color(): string {
    return this._color;
  }
  set color(value: string) {
    if (value === this._color) return;
    this._color = value;
    this.background(this.rerender(), "render");
  }

  get caption(): string {
    return this._caption;
  }
  set caption(value: string) {
    if (value === this._caption) return;
    this._caption = value;
    this.background(this.rerender(), "render");
  }

  get unit(): string {
    return this._unit;
  }
  set unit(value: string) {
    if (value === this._unit) return;
    this._unit = value;
    this.background(this.rerender(), "render");
  }

  get width(): number {
    return this._width;
  }
  set width(value: number) {
    if (value === this._width) return;
    this._width = value;
    this.background(this.rerender(), "render");
  }

  get height(): number {
    return this._height;
  }
  set height(value: number) {
    if (value === this._height) return;
    this._height = value;
    this.background(this.rerender(), "render");
  }

  get value(): number {
    return this._value;
  }
  set value(value: number) {
    const next = clampPercent(value);
    if (next === this._value) return;
    this._value = next;
    this.background(this.rerender(), "render");
  }

  protected buildView(): TNode {
    return verticalGauge({
      id: this.id,
      value: this._value,
      color: this._color,
      label: this._caption,
      unit: this._unit,
      w: this._width,
      h: this._height,
    });
  }
}


// ================================================================
// KONTROL TAMBAHAN — status bar, slider, image
// ================================================================

export interface TStatusBarOptions extends TOptions {
  leftText?: string;
  rightText?: string;
}

const STATUSBAR_PROPS = defineProps<TStatusBarOptions>()(["leftText", "rightText"]);

/** Baris status dua sisi (kiri/kanan). */
export class TStatusBar extends TComponent {
  private _left: string;
  private _right: string;

  constructor(
    idOrOpts?: string | TStatusBarOptions,
    opts?: TStatusBarOptions,
  ) {
    super(idOrOpts, opts, STATUSBAR_PROPS);
    const o = this.options as TStatusBarOptions;

    this.tag = "div";
    this._left = o.leftText ?? "";
    this._right = o.rightText ?? "";
    this.style = {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      gap: "8px",
      padding: "6px 10px",
      borderTop: "1px solid var(--border, rgba(255,255,255,0.12))",
      fontSize: "12px",
      color: "var(--text-muted, #8fa3bf)",
      ...this.style,
    };
  }

  get leftText(): string {
    return this._left;
  }
  set leftText(value: string) {
    this._left = value;
    if (this.host) this.background(this.host.update(`${this.id}_left`, { text: value }), "update");
  }

  get rightText(): string {
    return this._right;
  }
  set rightText(value: string) {
    this._right = value;
    if (this.host) this.background(this.host.update(`${this.id}_right`, { text: value }), "update");
  }

  build(): TNode {
    return {
      id: this.id,
      tag: this.tag,
      props: { style: { ...this.style } },
      children: [
        {
          id: `${this.id}_left`,
          tag: "span",
          props: { text: this._left },
          children: [],
        },
        {
          id: `${this.id}_right`,
          tag: "span",
          props: { text: this._right },
          children: [],
        },
      ],
    };
  }
}

export interface TSliderOptions extends TOptions {
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  caption?: string;
  color?: string;
}

const SLIDER_PROPS = defineProps<TSliderOptions>()([
  "value",
  "min",
  "max",
  "step",
  "unit",
  "caption",
  "color",
]);

/** Slider rentang dengan nilai tampil di bawahnya. */
export class TSlider extends TViewWidget {
  /** Selama digeser. */
  public onInput: ((value: number) => void) | null = null;
  /** Nilai final saat slider dilepas. */
  public onChange: ((value: number) => void) | null = null;

  private _value: number;
  private _min: number;
  private _max: number;
  private _step: number;
  private _unit: string;
  private _caption: string;
  private _color: string;

  constructor(idOrOpts?: string | TSliderOptions, opts?: TSliderOptions) {
    super(idOrOpts, opts, SLIDER_PROPS);
    const o = this.options as TSliderOptions;

    this._min = o.min ?? 0;
    this._max = o.max ?? 100;
    this._step = o.step ?? 1;
    this._unit = o.unit ?? "";
    this._caption = o.caption ?? "";
    this._color = o.color ?? "#2196f3";
    this._value = this.clamp(o.value ?? this._min);
  }

  get min(): number {
    return this._min;
  }
  set min(value: number) {
    if (value === this._min) return;
    this._min = value;
    this._value = this.clamp(this._value);
    this.background(this.rerender(), "render");
  }

  get max(): number {
    return this._max;
  }
  set max(value: number) {
    if (value === this._max) return;
    this._max = value;
    this._value = this.clamp(this._value);
    this.background(this.rerender(), "render");
  }

  get step(): number {
    return this._step;
  }
  set step(value: number) {
    if (value === this._step) return;
    this._step = value;
    this._value = this.clamp(this._value);
    this.background(this.rerender(), "render");
  }

  get unit(): string {
    return this._unit;
  }
  set unit(value: string) {
    if (value === this._unit) return;
    this._unit = value;
    this.background(this.rerender(), "render");
  }

  get caption(): string {
    return this._caption;
  }
  set caption(value: string) {
    if (value === this._caption) return;
    this._caption = value;
    this.background(this.rerender(), "render");
  }

  get color(): string {
    return this._color;
  }
  set color(value: string) {
    if (value === this._color) return;
    this._color = value;
    this.background(this.rerender(), "render");
  }

  get value(): number {
    return this._value;
  }
  set value(value: number) {
    const next = this.clamp(value);
    if (next === this._value) return;
    this._value = next;
    this.background(this.rerender(), "render");
  }

  bindEventHandler(host: TScreenPort): void {
    super.bindEventHandler(host);
    host.on(`sl-input-${this.id}`, "input", (ev: any) => {
      const parsed = Number.parseFloat(ev?.value);
      if (Number.isNaN(parsed)) return;

      this._value = this.clamp(parsed);
      this.background(host.update(`sl-val-${this.id}`, { text: this.displayValue() }), "update");
      this.onInput?.(this._value);
    });
    host.on(`sl-input-${this.id}`, "change", (ev: any) => {
      const parsed = Number.parseFloat(ev?.value);
      if (Number.isNaN(parsed)) return;
      this._value = this.clamp(parsed);
      this.onChange?.(this._value);
    });
  }

  protected buildView(): TNode {
    const view = slider({
      id: this.id,
      min: this._min,
      max: this._max,
      step: this._step,
      value: this._value,
      unit: this._unit,
      label: this._caption,
      color: this._color,
    });
    // Builder emerald hanya memasang `onInputId`; `change` = saat dilepas.
    const input = findNode(view, `sl-input-${this.id}`);
    if (input) input.props.onChangeId = input.id;
    return view;
  }

  private clamp(value: number): number {
    if (!Number.isFinite(value)) return this._min;
    return Math.min(Math.max(value, this._min), this._max);
  }

  private displayValue(): string {
    const text =
      this._value % 1 === 0
        ? String(Math.round(this._value))
        : this._value.toFixed(1);
    return text + this._unit;
  }
}

export interface TImageOptions extends TOptions {
  /** URL atau data URI langsung. */
  src?: string;
  /** Path file di VFS; dimuat otomatis saat mount. */
  file?: string;
  alt?: string;
  fit?: "contain" | "cover" | "fill" | "none";
  width?: number | string;
  height?: number | string;
}

const IMAGE_PROPS = defineProps<TImageOptions>()([
  "src",
  "file",
  "alt",
  "fit",
  "width",
  "height",
]);

/** Gambar; bisa dari URL/data URI atau file VFS. */
export class TImage extends TComponent {
  public onClick: (() => void) | null = null;
  /** Auto-load `file` gagal (`IO_FAILED`); tanpa handler, error dilog. */
  public onError: TErrorHandler | null = null;

  private _src: string;
  private _alt: string;
  private _mime: string;
  private _file: string;
  private _fileLoaded: boolean = false;

  constructor(idOrOpts?: string | TImageOptions, opts?: TImageOptions) {
    super(idOrOpts, opts, IMAGE_PROPS);
    const o = this.options as TImageOptions;

    this.tag = "img";
    this._alt = o.alt ?? "";
    this._mime = mimeOfPath(o.file ?? "", "image/png");
    this._file = o.file ?? "";
    this._src = o.src ?? this._file;

    const size = (value: number | string | undefined) =>
      value === undefined
        ? {}
        : { width: typeof value === "number" ? `${value}px` : value };

    this.style = {
      display: "block",
      maxWidth: "100%",
      objectFit: o.fit ?? "contain",
      ...size(o.width),
      ...(o.height !== undefined
        ? { height: typeof o.height === "number" ? `${o.height}px` : o.height }
        : {}),
      ...this.style,
    };
  }

  get src(): string {
    return this._src;
  }
  set src(value: string) {
    this._src = value;
    this.props.src = value;
    this.push({ src: value });
  }

  get alt(): string {
    return this._alt;
  }
  set alt(value: string) {
    this._alt = value;
    this.push({ alt: value });
  }

  /** Muat gambar dari file VFS sebagai data URI. */
  async loadFile(path: string): Promise<void> {
    if (!path) return;

    this._file = path;
    let raw: unknown;
    try {
      raw = await fs.readFile(path);
    } catch (error) {
      throw new EComponentError("IO_FAILED", `Cannot read image "${path}"`, this.id, error);
    }
    if (!raw) {
      throw new EComponentError("IO_FAILED", `Cannot read image "${path}"`, this.id);
    }

    this._mime = mimeOfPath(path, this._mime);
    this.src = toDataUri(String(raw), this._mime);
  }

  bindEventHandler(host: TScreenPort): void {
    super.bindEventHandler(host);
    host.on(this.id, "click", () => this.onClick?.());

    if (this._file && !this._fileLoaded) {
      this._fileLoaded = true;
      this.background(this.loadFile(this._file), "loadFile");
    }
  }

  build(): TNode {
    return {
      id: this.id,
      tag: this.tag,
      props: {
        ...this.props,
        src: this._src,
        alt: this._alt,
        onClickId: this.id,
        style: { ...this.style },
      },
      children: [],
    };
  }
}

function mimeOfPath(path: string, fallback = "image/png"): string {
  const ext = (path || "").toLowerCase().split(".").pop() || "";
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    default:
      return fallback;
  }
}

function toDataUri(raw: string, mime: string): string {
  const base64 = Buffer.from(String(raw), "latin1").toString("base64");
  return `data:${mime};base64,${base64}`;
}
