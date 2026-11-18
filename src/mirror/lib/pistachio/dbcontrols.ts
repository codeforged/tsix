/**
 * pistachio/dbcontrols.ts — Komponen visual yang terikat ke TDataSource.
 *
 * (c) 2026 TSIX Project
 */

import {
  resolveOptions,
  TComponent,
  TKeyEvent,
  TOptions,
  TScreenPort,
} from "./core";
import {
  TButton,
  TEdit,
  TEditOptions,
  TLabel,
  TLabelOptions,
  TListBox,
  TListBoxOptions,
  TMemo,
  TMemoOptions,
} from "./controls";
import { THStack } from "./layout";
import {
  EDatabaseError,
  TDataSource,
  TDBQuery,
  TFieldDef,
  TProviderCapabilities,
} from "./data";
import {
  DataGridColumn,
  TTabulatorGrid,
  TTabulatorGridOptions,
} from "./widgets";

type TFieldFormatter = (value: unknown) => string;
type TFieldParser = (text: string) => unknown;

interface TDBBoundOptions extends TOptions {
  dataSource: TDataSource;
  field: string;
  formatValue?: TFieldFormatter;
  parseValue?: TFieldParser;
}

function validateBinding(dataSource: TDataSource, field: string): void {
  if (!(dataSource instanceof TDataSource)) {
    throw new EDatabaseError(
      "INVALID_FIELD",
      "A DB control requires a TDataSource",
    );
  }
  if (typeof field !== "string" || !field.trim()) {
    throw new EDatabaseError("INVALID_FIELD", "A field name is required");
  }
  if (
    dataSource.fields.length > 0 &&
    !dataSource.fields.some((definition) => definition.name === field)
  ) {
    throw new EDatabaseError(
      "INVALID_FIELD",
      `Field "${field}" is not present in the data source`,
    );
  }
}

function fieldDefinition(
  dataSource: TDataSource,
  field: string,
): TFieldDef | undefined {
  return dataSource.fields.find((definition) => definition.name === field);
}

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value) ?? "";
  return String(value);
}

function parseFieldValue(
  dataSource: TDataSource,
  field: string,
  text: string,
): unknown {
  const definition = fieldDefinition(dataSource, field);
  if (!definition || definition.type === "ftString") return text;
  if (text === "" && definition.nullable) return null;

  switch (definition.type) {
    case "ftInteger": {
      const value = Number(text);
      if (!Number.isInteger(value)) {
        throw new EDatabaseError(
          "INVALID_FIELD",
          `Field "${field}" requires an integer`,
        );
      }
      return value;
    }
    case "ftFloat": {
      const value = Number(text);
      if (!Number.isFinite(value)) {
        throw new EDatabaseError(
          "INVALID_FIELD",
          `Field "${field}" requires a number`,
        );
      }
      return value;
    }
    case "ftBoolean":
      if (/^(true|1|yes|on)$/i.test(text)) return true;
      if (/^(false|0|no|off)$/i.test(text)) return false;
      throw new EDatabaseError(
        "INVALID_FIELD",
        `Field "${field}" requires true or false`,
      );
    case "ftDateTime": {
      const value = new Date(text);
      if (Number.isNaN(value.getTime())) {
        throw new EDatabaseError(
          "INVALID_FIELD",
          `Field "${field}" requires a valid date and time`,
        );
      }
      return value;
    }
    case "ftJSON":
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new EDatabaseError(
          "INVALID_FIELD",
          `Field "${field}" requires valid JSON`,
          undefined,
          error,
        );
      }
    case "ftBlob":
      throw new EDatabaseError(
        "INVALID_FIELD",
        `Field "${field}" cannot be edited as text`,
      );
  }
}

function canEditField(
  dataSource: TDataSource,
  field: string,
  capabilities: Readonly<TProviderCapabilities>,
): boolean {
  const definition = fieldDefinition(dataSource, field);
  if (definition?.type === "ftBlob") return false;
  return dataSource.state === "dsInsert"
    ? capabilities.canInsert
    : dataSource.state === "dsEdit" && capabilities.canUpdate;
}

function reportAsyncError(
  owner: string,
  onError: ((error: unknown) => void) | null,
  error: unknown,
): void {
  if (onError) {
    onError(error);
    return;
  }
  console.error(`[Pistachio] ${owner} failed:`, error);
}

/** Read-only text view backed by a basic TLabel. */
export interface TDBTextOptions extends TLabelOptions, TDBBoundOptions {}

export class TDBText extends TLabel {
  private readonly _dataSource: TDataSource;
  private readonly _field: string;
  private readonly _formatValue?: TFieldFormatter;
  private readonly _unsubscribe: () => void;

  constructor(
    idOrOpts?: string | TDBTextOptions,
    opts?: TDBTextOptions,
  ) {
    super(idOrOpts, opts, ["dataSource", "field", "formatValue"]);
    const options = this.options as TDBTextOptions;
    validateBinding(options.dataSource, options.field);
    this._dataSource = options.dataSource;
    this._field = options.field;
    this._formatValue = options.formatValue;
    this._unsubscribe = this._dataSource.subscribe(() => this.updateValue());
    this.updateValue();
  }

  override async refresh(): Promise<void> {
    this.updateValue();
  }

  override dispose(): void {
    this._unsubscribe();
    super.dispose();
  }

  private updateValue(): void {
    validateBinding(this._dataSource, this._field);
    const record = this._dataSource.currentRecord;
    const value = record?.[this._field];
    this.text = this._formatValue
      ? this._formatValue(value)
      : formatFieldValue(value);
  }
}

/** Single-line bound editor backed by a basic TEdit. */
export interface TDBEditOptions extends TEditOptions, TDBBoundOptions {}

export class TDBEdit extends TEdit {
  private readonly _dataSource: TDataSource;
  private readonly _field: string;
  private readonly _formatValue?: TFieldFormatter;
  private readonly _parseValue?: TFieldParser;
  private readonly _forcedReadOnly: boolean;
  private readonly _unsubscribe: () => void;

  constructor(
    idOrOpts?: string | TDBEditOptions,
    opts?: TDBEditOptions,
  ) {
    super(idOrOpts, opts, [
      "dataSource",
      "field",
      "formatValue",
      "parseValue",
    ]);
    const options = this.options as TDBEditOptions;
    validateBinding(options.dataSource, options.field);
    this._dataSource = options.dataSource;
    this._field = options.field;
    this._formatValue = options.formatValue;
    this._parseValue = options.parseValue;
    this._forcedReadOnly = Boolean(options.readOnly);
    this.onInput = (text) => {
      const value = this._parseValue
        ? this._parseValue(text)
        : parseFieldValue(this._dataSource, this._field, text);
      this._dataSource.setField(this._field, value);
    };
    this._unsubscribe = this._dataSource.subscribe(() => this.updateValue());
    this.updateValue();
  }

  override async refresh(): Promise<void> {
    this.updateValue();
  }

  override dispose(): void {
    this._unsubscribe();
    super.dispose();
  }

  private updateValue(): void {
    validateBinding(this._dataSource, this._field);
    const record = this._dataSource.currentRecord;
    const value = record?.[this._field];
    this.text = this._formatValue
      ? this._formatValue(value)
      : formatFieldValue(value);
    this.readOnly =
      this._forcedReadOnly ||
      !canEditField(
        this._dataSource,
        this._field,
        this._dataSource.capabilities,
      );
  }
}

/** Multiline bound editor backed by a basic TMemo. */
export interface TDBMemoOptions extends TMemoOptions, TDBBoundOptions {}

export class TDBMemo extends TMemo {
  private readonly _dataSource: TDataSource;
  private readonly _field: string;
  private readonly _formatValue?: TFieldFormatter;
  private readonly _parseValue?: TFieldParser;
  private readonly _forcedReadOnly: boolean;
  private readonly _unsubscribe: () => void;

  constructor(
    idOrOpts?: string | TDBMemoOptions,
    opts?: TDBMemoOptions,
  ) {
    super(idOrOpts, opts, [
      "dataSource",
      "field",
      "formatValue",
      "parseValue",
    ]);
    const options = this.options as TDBMemoOptions;
    validateBinding(options.dataSource, options.field);
    this._dataSource = options.dataSource;
    this._field = options.field;
    this._formatValue = options.formatValue;
    this._parseValue = options.parseValue;
    this._forcedReadOnly = Boolean(options.readOnly);
    this.onInput = (text) => {
      const value = this._parseValue
        ? this._parseValue(text)
        : parseFieldValue(this._dataSource, this._field, text);
      this._dataSource.setField(this._field, value);
    };
    this._unsubscribe = this._dataSource.subscribe(() => this.updateValue());
    this.updateValue();
  }

  override async refresh(): Promise<void> {
    this.updateValue();
  }

  override dispose(): void {
    this._unsubscribe();
    super.dispose();
  }

  private updateValue(): void {
    validateBinding(this._dataSource, this._field);
    const record = this._dataSource.currentRecord;
    const value = record?.[this._field];
    this.text = this._formatValue
      ? this._formatValue(value)
      : formatFieldValue(value);
    this.readOnly =
      this._forcedReadOnly ||
      !canEditField(
        this._dataSource,
        this._field,
        this._dataSource.capabilities,
      );
  }
}

/** Choice editor backed by a basic TListBox. */
export interface TDBListBoxOptions
  extends TListBoxOptions,
    Omit<TDBBoundOptions, "formatValue"> {}

export class TDBListBox extends TListBox {
  public onError: ((error: unknown) => void) | null = null;

  private readonly _dataSource: TDataSource;
  private readonly _field: string;
  private readonly _parseValue?: TFieldParser;
  private readonly _baseStyle: Record<string, any>;
  private readonly _unsubscribe: () => void;

  constructor(
    idOrOpts?: string | TDBListBoxOptions,
    opts?: TDBListBoxOptions,
  ) {
    super(idOrOpts, opts, ["dataSource", "field", "parseValue"]);
    const options = this.options as TDBListBoxOptions;
    validateBinding(options.dataSource, options.field);
    this._dataSource = options.dataSource;
    this._field = options.field;
    this._parseValue = options.parseValue;
    this._baseStyle = { ...this.style };
    this.onClick = (_index, item) => {
      if (this.readOnly) {
        throw new EDatabaseError(
          "DATASET_NOT_BROWSE",
          "Call edit() or insert() before changing a field",
        );
      }
      const value = this._parseValue
        ? this._parseValue(item)
        : parseFieldValue(this._dataSource, this._field, item);
      this._dataSource.setField(this._field, value);
    };
    this._unsubscribe = this._dataSource.subscribe(() => this.scheduleRefresh());
    this.updateSelection();
  }

  get readOnly(): boolean {
    return this.style.pointerEvents === "none";
  }

  override async refresh(): Promise<void> {
    await this.setItems([...this.items]);
    this.updateSelection();
  }

  override dispose(): void {
    this._unsubscribe();
    super.dispose();
  }

  private updateSelection(): void {
    validateBinding(this._dataSource, this._field);
    const record = this._dataSource.currentRecord;
    const value = record?.[this._field];
    this.selectedIndex = this.items.findIndex(
      (item) => item === formatFieldValue(value),
    );
    const editable = canEditField(
      this._dataSource,
      this._field,
      this._dataSource.capabilities,
    );
    this.style = editable
      ? { ...this._baseStyle }
      : { ...this._baseStyle, opacity: 0.6, pointerEvents: "none" };
  }

  private scheduleRefresh(): void {
    void this.refresh().catch((error) =>
      reportAsyncError("TDBListBox refresh", this.onError, error),
    );
  }
}

export interface TDBGridOptions
  extends Omit<TTabulatorGridOptions, "columns"> {
  dataSource: TDataSource;
  columns?: DataGridColumn[] | "auto";
}

interface TResolvedDBGridOptions extends TTabulatorGridOptions {
  dataSource: TDataSource;
}

function resolveDBGridOptions(
  idOrOpts?: string | TDBGridOptions,
  opts?: TDBGridOptions,
): { options: TResolvedDBGridOptions; automaticColumns: boolean } {
  const options = resolveOptions(idOrOpts, opts) as TDBGridOptions;
  if (!(options.dataSource instanceof TDataSource)) {
    throw new EDatabaseError(
      "INVALID_FIELD",
      "TDBGrid requires a TDataSource",
    );
  }
  const automaticColumns =
    options.columns === undefined || options.columns === "auto";
  return {
    options: {
      ...options,
      columns: Array.isArray(options.columns) ? options.columns : [],
    },
    automaticColumns,
  };
}

/** Tabulator-backed database grid; columns default to field metadata. */
export class TDBGrid extends TTabulatorGrid {
  public onError: ((error: unknown) => void) | null = null;
  public onRecordDoubleClick:
    | ((record: Readonly<Record<string, unknown>>) => void)
    | null = null;

  private readonly _dataSource: TDataSource;
  private readonly _automaticColumns: boolean;
  private _rowIndexKey = "__pistachio_row_index__";
  private readonly _unsubscribe: () => void;

  constructor(
    idOrOpts?: string | TDBGridOptions,
    opts?: TDBGridOptions,
  ) {
    const resolved = resolveDBGridOptions(idOrOpts, opts);
    super(resolved.options, undefined, ["dataSource"]);
    this._dataSource = resolved.options.dataSource;
    this._automaticColumns = resolved.automaticColumns;
    this.onSort = (key, direction) => {
      const order = direction === "asc" ? 1 : -1;
      this._dataSource.setSort((left, right) =>
        order * compareValues(left[key], right[key]),
      );
    };
    this.onSelectionChange = (_key, record) => {
      if (this._dataSource.state !== "dsBrowse") return;
      const index = record?.[this._rowIndexKey];
      if (typeof index === "number") this._dataSource.setCurrentIndex(index);
    };
    this.onRowDoubleClick = (_key, record) => {
      if (this._dataSource.state !== "dsBrowse") return;
      const index = record[this._rowIndexKey];
      if (typeof index === "number") this._dataSource.setCurrentIndex(index);
      const current = this._dataSource.currentRecord;
      if (current) this.onRecordDoubleClick?.(current);
    };
    this._unsubscribe = this._dataSource.subscribe((event) => {
      if (event.type === "data") {
        this.scheduleRefresh();
      } else if (event.type === "cursor") {
        this.scheduleSelection();
      }
    });
  }

  get dataSource(): TDataSource {
    return this._dataSource;
  }

  override handleKeyEvent(event: TKeyEvent): boolean {
    return (
      navigateDataSourceByKey(
        this._dataSource,
        event,
        false,
        (error) =>
          reportAsyncError("TDBGrid keyboard navigation", this.onError, error),
      ) || super.handleKeyEvent(event)
    );
  }

  override async refresh(): Promise<void> {
    const fields = this._dataSource.fields;
    if (this._automaticColumns) {
      await this.setColumns(
        fields.map((field) => ({
          key: field.name,
          label: field.name,
          ...(field.type === "ftInteger" || field.type === "ftFloat"
            ? { align: "right" as const }
            : {}),
        })),
      );
    }
    this._rowIndexKey = "__pistachio_row_index__";
    while (fields.some((field) => field.name === this._rowIndexKey)) {
      this._rowIndexKey += "_";
    }
    await this.setData(
      this._dataSource.records.map((record, index) => ({
        ...record,
        [this._rowIndexKey]: index,
      })),
    );
    await this.syncSelection();
  }

  override dispose(): void {
    this._unsubscribe();
    super.dispose();
  }

  private scheduleRefresh(): void {
    void this.refresh().catch((error) =>
      reportAsyncError("TDBGrid refresh", this.onError, error),
    );
  }

  private scheduleSelection(): void {
    void this.syncSelection().catch((error) =>
      reportAsyncError("TDBGrid selection", this.onError, error),
    );
  }

  private async syncSelection(): Promise<void> {
    await this.setSelectedRecord(
      this.data[this._dataSource.currentIndex] ?? null,
    );
  }
}

function compareValues(left: unknown, right: unknown): number {
  if (Object.is(left, right)) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() - right.getTime();
  }
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function navigateDataSourceByKey(
  dataSource: TDataSource,
  event: TKeyEvent,
  postBeforeMove: boolean,
  reportError: (error: unknown) => void,
): boolean {
  if (
    !event.down ||
    event.repeat ||
    event.ctrl ||
    event.alt ||
    event.shift
  ) {
    return false;
  }

  let move: (() => void) | null = null;
  switch (event.key) {
    case "ArrowUp":
      move = () => dataSource.prior();
      break;
    case "ArrowDown":
      move = () => dataSource.next();
      break;
    case "ArrowLeft":
      move = () => dataSource.first();
      break;
    case "ArrowRight":
      move = () => dataSource.last();
      break;
    default:
      return false;
  }

  if (!dataSource.isOpen) return true;
  if (dataSource.state !== "dsBrowse" && !postBeforeMove) return true;
  if (
    event.key === "ArrowDown" &&
    dataSource.currentIndex + 1 >= dataSource.recordCount
  ) {
    return true;
  }

  try {
    if (dataSource.state !== "dsBrowse") dataSource.post();
    move();
  } catch (error) {
    reportError(error);
  }
  return true;
}

/** Standard dataset navigation and edit/apply buttons. */
export interface TDBNavigatorOptions extends TOptions {
  dataSource: TDataSource;
}

export class TDBNavigator extends THStack {
  public onError: ((error: unknown) => void) | null = null;

  private readonly _dataSource: TDataSource;
  private readonly _unsubscribe: () => void;
  private readonly _status: TLabel;

  readonly firstButton: TButton;
  readonly priorButton: TButton;
  readonly nextButton: TButton;
  readonly lastButton: TButton;
  readonly insertButton: TButton;
  readonly editButton: TButton;
  readonly deleteButton: TButton;
  readonly postButton: TButton;
  readonly cancelButton: TButton;
  readonly applyButton: TButton;

  constructor(
    idOrOpts?: string | TDBNavigatorOptions,
    opts?: TDBNavigatorOptions,
  ) {
    super(idOrOpts, opts, ["dataSource"]);
    const options = this.options as TDBNavigatorOptions;
    if (!(options.dataSource instanceof TDataSource)) {
      throw new EDatabaseError(
        "INVALID_FIELD",
        "TDBNavigator requires a TDataSource",
      );
    }
    this._dataSource = options.dataSource;
    this.firstButton = new TButton({ id: `${this.id}-first`, caption: "|<" });
    this.priorButton = new TButton({ id: `${this.id}-prior`, caption: "<" });
    this.nextButton = new TButton({ id: `${this.id}-next`, caption: ">" });
    this.lastButton = new TButton({ id: `${this.id}-last`, caption: ">|" });
    this.insertButton = new TButton({ id: `${this.id}-insert`, caption: "+" });
    this.editButton = new TButton({ id: `${this.id}-edit`, caption: "Edit" });
    this.deleteButton = new TButton({ id: `${this.id}-delete`, caption: "-" });
    this.postButton = new TButton({ id: `${this.id}-post`, caption: "Post" });
    this.cancelButton = new TButton({
      id: `${this.id}-cancel`,
      caption: "Cancel",
    });
    this.applyButton = new TButton({
      id: `${this.id}-apply`,
      caption: "Apply",
    });
    this._status = new TLabel({ id: `${this.id}-status`, text: "0/0" });

    for (const button of [
      this.firstButton,
      this.priorButton,
      this.nextButton,
      this.lastButton,
      this.insertButton,
      this.editButton,
      this.deleteButton,
      this.postButton,
      this.cancelButton,
      this.applyButton,
      this._status,
    ]) {
      this.add(button);
    }
    this.firstButton.onClick = () =>
      this.navigate(() => this._dataSource.first());
    this.priorButton.onClick = () =>
      this.navigate(() => this._dataSource.prior());
    this.nextButton.onClick = () =>
      this.navigate(() => this._dataSource.next());
    this.lastButton.onClick = () =>
      this.navigate(() => this._dataSource.last());
    this.insertButton.onClick = () => this._dataSource.insert();
    this.editButton.onClick = () => this._dataSource.edit();
    this.deleteButton.onClick = () => this._dataSource.delete();
    this.postButton.onClick = () => this._dataSource.post();
    this.cancelButton.onClick = () => this._dataSource.cancel();
    this.applyButton.onClick = () => {
      void this._dataSource
        .applyUpdates()
        .then((result) => {
          if (result.failed > 0) {
            this._status.text = `Apply failed: ${result.failed}`;
            for (const row of result.results) {
              if (!row.success) {
                reportAsyncError("TDBNavigator apply", this.onError, row.error);
              }
            }

          } else {
            this._status.text = `Applied ${result.succeeded}`;
          }
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          this._status.text = `Apply error: ${message}`;
          reportAsyncError("TDBNavigator apply", this.onError, error);
        });
    };
    this._unsubscribe = this._dataSource.subscribe(() => this.updateState());
    this.updateState();
  }

  override async refresh(): Promise<void> {
    this.updateState();
  }

  override handleKeyEvent(event: TKeyEvent): boolean {
    return (
      navigateDataSourceByKey(
        this._dataSource,
        event,
        true,
        (error) =>
          reportAsyncError(
            "TDBNavigator keyboard navigation",
            this.onError,
            error,
          ),
      ) || super.handleKeyEvent(event)
    );
  }

  override dispose(): void {
    this._unsubscribe();
    super.dispose();
  }

  private updateState(): void {
    const open = this._dataSource.isOpen;
    const count = this._dataSource.recordCount;
    const index = this._dataSource.currentIndex;
    const browsing = this._dataSource.state === "dsBrowse";
    const current = this._dataSource.currentRecord !== null;
    const capabilities = this._dataSource.capabilities;

    this.firstButton.enabled =
      open && count > 0 && index > 0;
    this.priorButton.enabled =
      open && count > 0 && (index > 0 || index >= count);
    this.nextButton.enabled =
      open && count > 0 && index < count - 1;
    this.lastButton.enabled =
      open && count > 0 && index < count - 1;
    this.insertButton.enabled =
      open && browsing && capabilities.canInsert;
    this.editButton.enabled =
      open && browsing && current && capabilities.canUpdate;
    this.deleteButton.enabled =
      open && browsing && current && capabilities.canDelete;
    this.postButton.enabled = open && !browsing;
    this.cancelButton.enabled = open && !browsing;
    this.applyButton.enabled =
      open && browsing && this._dataSource.dirtyCount > 0;
    const position =
      index < 0 ? 0 : Math.min(index + 1, count);
    this._status.text = `${position}/${count}`;
  }

  private navigate(move: () => void): void {
    // Keep active edits in the local dataset before moving its cursor.
    if (this._dataSource.state !== "dsBrowse") this._dataSource.post();
    move();
  }
}

export interface TDBPagerOptions extends TOptions {
  dataSource: TDataSource;
  pageSize?: number;
}

/** Server-side paging for the SELECT query bound to a data source. */
/** Edit nomor halaman: commit saat Enter atau saat field ditinggalkan. */
class TPageEdit extends TEdit {
  public onCommit: ((value: string) => void) | null = null;

  private _pageHost: TScreenPort | null = null;

  constructor(idOrOpts?: string | TEditOptions, opts?: TEditOptions) {
    super(idOrOpts, opts);
    this.props.onKeydownId = this.id;
    this.props.onChangeId = this.id;
  }

  override bindEventHandler(host: TScreenPort): void {
    super.bindEventHandler(host);
    this._pageHost = host;
    host.on(this.id, "keydown", (ev: any) => {
      if (ev?.value !== "Enter") return;
      this.onCommit?.(this.text);
      // Kembalikan fokus ke window supaya panah langsung menggerakkan record.
      void Promise.resolve(this._pageHost?.keyboard?.focus?.()).catch(
        () => {},
      );
    });
    host.on(this.id, "change", (ev: any) => {
      this.onCommit?.(typeof ev?.value === "string" ? ev.value : this.text);
    });
  }
}

export class TDBPager extends THStack {
  public onError: ((error: unknown) => void) | null = null;

  readonly firstButton: TButton;
  readonly priorButton: TButton;
  readonly nextButton: TButton;
  readonly lastButton: TButton;
  readonly pageEdit: TPageEdit;

  private readonly _dataSource: TDataSource;
  private readonly _query: TDBQuery;
  private readonly _pageCountLabel: TLabel;
  private readonly _status: TLabel;
  private readonly _unsubscribe: () => void;
  private _lastDirtyCount: number;
  private _loading = false;
  private _message: string | null = null;
  private _shownPage: number | null = null;

  constructor(
    idOrOpts?: string | TDBPagerOptions,
    opts?: TDBPagerOptions,
  ) {
    super(idOrOpts, opts, ["dataSource", "pageSize"]);
    const options = this.options as TDBPagerOptions;
    if (!(options.dataSource instanceof TDataSource)) {
      throw new EDatabaseError(
        "INVALID_FIELD",
        "TDBPager requires a TDataSource",
      );
    }

    this._dataSource = options.dataSource;
    this._query = this._dataSource.dataset.provider.query;
    this._query.setPaging(options.pageSize ?? 100);
    this._lastDirtyCount = this._dataSource.dirtyCount;

    this.firstButton = new TButton({ id: `${this.id}-first`, caption: "|<" });
    this.priorButton = new TButton({ id: `${this.id}-prior`, caption: "<" });
    this.nextButton = new TButton({ id: `${this.id}-next`, caption: ">" });
    this.lastButton = new TButton({ id: `${this.id}-last`, caption: ">|" });
    this.pageEdit = new TPageEdit({
      id: `${this.id}-page`,
      text: "",
      style: { width: "56px", minWidth: "56px", textAlign: "center" },
    });
    this._pageCountLabel = new TLabel({
      id: `${this.id}-pagecount`,
      text: "of -",
    });
    this._status = new TLabel({ id: `${this.id}-status`, text: "" });

    for (const control of [
      this.firstButton,
      this.priorButton,
      this.pageEdit,
      this._pageCountLabel,
      this.nextButton,
      this.lastButton,
      this._status,
    ]) {
      this.add(control);
    }

    this.firstButton.onClick = () => void this.goToPage(0);
    this.priorButton.onClick = () =>
      void this.goToPage(Math.max(0, this._query.pageIndex - 1));
    this.nextButton.onClick = () =>
      void this.goToPage(this._query.pageIndex + 1);
    this.lastButton.onClick = () =>
      void this.goToPage(Math.max(0, this.pageCount - 1));
    this.pageEdit.onCommit = (value) => this.commitPageInput(value);

    this._unsubscribe = this._dataSource.subscribe((event) => {
      const dirtyCount = this._dataSource.dirtyCount;
      const appliedChanges =
        event.type === "data" &&
        this._lastDirtyCount > 0 &&
        dirtyCount === 0 &&
        this._query.isOpen;
      this._lastDirtyCount = dirtyCount;
      if (event.type === "data" && this._query.totalCount !== null) {
        this._message = null;
      }
      this.updateState();
      if (appliedChanges) void this.loadPage(this._query.pageIndex);
    });
    this.updateState();
    // A pager attached to an already-open dataset still needs its first page.
    if (this._dataSource.isOpen) void this.loadPage(this._query.pageIndex);
  }

  get dataSource(): TDataSource {
    return this._dataSource;
  }

  get pageSize(): number {
    return this._query.pageSize ?? 100;
  }

  get pageIndex(): number {
    return this._query.pageIndex;
  }

  get pageCount(): number {
    const count = this._query.totalCount;
    return count === null ? 0 : Math.ceil(count / this.pageSize);
  }

  get totalCount(): number | null {
    return this._query.totalCount;
  }

  override async refresh(): Promise<void> {
    if (this._dataSource.isOpen && this._query.totalCount === null) {
      await this.loadPage(this._query.pageIndex);
      return;
    }
    this.updateState();
  }

  override dispose(): void {
    this._unsubscribe();
    super.dispose();
  }

  async goToPage(pageIndex: number): Promise<void> {
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
      throw new EDatabaseError(
        "INVALID_UPDATE",
        "Page index must be a non-negative safe integer",
      );
    }
    if (this._loading) return;
    if (!this._dataSource.isOpen) {
      this._query.setPageIndex(pageIndex);
      this.updateState();
      return;
    }

    if (this._dataSource.state !== "dsBrowse") {
      this._message = "Post atau Cancel edit sebelum pindah halaman.";
      this.updateState();
      return;
    }
    if (this._dataSource.dirtyCount > 0) {
      this._message = "Apply perubahan sebelum pindah halaman.";
      this.updateState();
      return;
    }

    const targetPage = Math.min(
      pageIndex,
      Math.max(0, this.pageCount - 1),
    );
    if (targetPage === this._query.pageIndex) return;
    await this.loadPage(targetPage);
  }

  private async loadPage(pageIndex: number): Promise<void> {
    if (!this._dataSource.isOpen) {
      this._query.setPageIndex(pageIndex);
      this.updateState();
      return;
    }
    if (
      this._dataSource.state !== "dsBrowse" ||
      this._dataSource.dirtyCount > 0
    ) {
      this._message =
        this._dataSource.state !== "dsBrowse"
          ? "Post atau Cancel edit sebelum memuat halaman."
          : "Apply perubahan sebelum memuat halaman.";
      this.updateState();
      return;
    }

    const previousPage = this._query.pageIndex;
    this._query.setPageIndex(pageIndex);
    this._loading = true;
    this._message = null;
    this.updateState();
    try {
      await this._dataSource.refresh();
      if (
        this._query.pageIndex !== previousPage &&
        this._dataSource.recordCount > 0
      ) {
        this._dataSource.first();
      }
    } catch (error) {
      this._query.setPageIndex(previousPage);
      const message = error instanceof Error ? error.message : String(error);
      this._message = `Gagal memuat halaman: ${message}`;
      reportAsyncError("TDBPager refresh", this.onError, error);
    } finally {
      this._loading = false;
      this.updateState();
    }
  }

  /** Terapkan nomor halaman yang diketik user (1-based). */
  private commitPageInput(value: string): void {
    const pages = this.pageCount;
    const typed = value.trim();
    const requested = Number(typed);
    this._message = null;
    this._shownPage = null;

    if (!typed || !Number.isSafeInteger(requested) || requested < 1) {
      this._message = "Nomor halaman harus angka mulai dari 1.";
      this.updateState();
      return;
    }
    if (pages > 0 && requested > pages) {
      this._message = `Halaman maksimal ${pages}.`;
      this.updateState();
      return;
    }

    void this.goToPage(requested - 1)
      .then(() => this.updateState())
      .catch((error) => {
        reportAsyncError("TDBPager page input", this.onError, error);
        this.updateState();
      });
  }

  private updateState(): void {
    const total = this._query.totalCount;
    const pageCount = this.pageCount;
    const page = total === null || total === 0 ? 0 : this.pageIndex + 1;
    const browse =
      this._dataSource.isOpen &&
      this._dataSource.state === "dsBrowse" &&
      this._dataSource.dirtyCount === 0 &&
      !this._loading;

    if (this._shownPage !== page) {
      this.pageEdit.text = page === 0 ? "" : String(page);
      this._shownPage = page;
    }
    this._pageCountLabel.text = total === null ? "of -" : `of ${pageCount}`;
    this._status.text = this._message ?? "";
    if (this.pageEdit.readOnly !== !browse) this.pageEdit.readOnly = !browse;

    this.firstButton.enabled = browse && page > 1;
    this.priorButton.enabled = browse && page > 1;
    this.nextButton.enabled = browse && page > 0 && page < pageCount;
    this.lastButton.enabled = browse && page > 0 && page < pageCount;
  }
}
