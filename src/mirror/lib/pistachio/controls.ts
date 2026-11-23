/**
 * pistachio/controls.ts — Kontrol dasar Pistachio.
 *
 * Konvensi:
 * - Props DOM (`text`, `value`, `onClickId`, `onInputId`) dibangun di `build()`.
 * - State publik memakai accessor; perubahan setelah mount dikirim lewat `push()`.
 * - Event memakai listener mount-time DOME + handler `host.on()`.
 *
 * (c) 2026 TSIX Project
 */

import {
  defineProps,
  TComponent,
  TNode,
  TOptions,
  TScreenPort,
  TStyle,
} from "./core";

const TEXT = "var(--text, #e0e0e0)";
const TEXT_DIM = "var(--text-dim, #ccc)";
const BORDER = "1px solid var(--border, rgba(255,255,255,0.12))";
const ACCENT = "var(--accent, #4caf50)";

const INPUT_STYLE: TStyle = {
  width: "100%",
  padding: "8px 12px",
  background: "var(--input-bg, rgba(255,255,255,0.06))",
  border: BORDER,
  borderRadius: "6px",
  color: TEXT,
  fontSize: "13px",
  outline: "none",
  boxSizing: "border-box",
};

const READONLY_STYLE: TStyle = {
  background: "var(--input-readonly-bg, rgba(255,255,255,0.03))",
  color: "var(--text-muted, #8fa3bf)",
  border: "1px solid rgba(255,255,255,0.06)",
  boxShadow: "inset 0 1px 3px rgba(0,0,0,0.45)",
  cursor: "default",
};

/** Gabungkan style dasar + style pengguna; tambah efek embos saat read-only. */
function inputStyle(base: TStyle, user: TStyle, readOnly: boolean): TStyle {
  return readOnly ? { ...base, ...user, ...READONLY_STYLE } : { ...base, ...user };
}

const MEMO_STYLE: TStyle = {
  ...INPUT_STYLE,
  fontFamily: "monospace",
  resize: "vertical",
};

const CHECK_STYLE: TStyle = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  cursor: "pointer",
  fontSize: "12px",
};

/**
 * Pilihan setelah isi koleksi diganti (aturan K2.3, pistachio-improve-plan):
 * - item terpilih yang masih ada tetap terpilih (indeks barunya);
 * - bila sebelumnya tidak ada item valid, indeks dipertahankan selama masih
 *   dalam jangkauan (mendukung urutan "set selectedIndex dulu, lalu items");
 * - selain itu jatuh ke `fallback` (combo: item pertama, list: -1).
 */
function nextSelection(
  oldItems: readonly string[],
  oldIndex: number,
  newItems: readonly string[],
  fallback: "first" | "none",
): number {
  const previous = oldIndex >= 0 ? oldItems[oldIndex] : undefined;
  if (previous !== undefined) {
    const kept = newItems.indexOf(previous);
    if (kept >= 0) return kept;
  } else if (oldIndex >= 0 && oldIndex < newItems.length) {
    return oldIndex;
  }
  return fallback === "first" && newItems.length > 0 ? 0 : -1;
}

/** Teks statis. */
export interface TLabelOptions extends TOptions {
  text?: string;
}

const LABEL_PROPS = defineProps<TLabelOptions>()(["text"]);

export class TLabel extends TComponent {
  constructor(
    idOrOpts?: string | TLabelOptions,
    opts?: TLabelOptions,
    knownProps: readonly string[] = [],
  ) {
    super(idOrOpts, opts, [...LABEL_PROPS, ...knownProps]);
    this.tag = "span";
    const o = this.options as TLabelOptions;
    if (o.text !== undefined) this.text = o.text;
    this.style = { color: TEXT_DIM, fontSize: "13px", ...this.style };
  }

  get text(): string {
    return this.props.text ?? "";
  }
  set text(value: string) {
    this.props.text = value;
    this.push({ text: value });
  }
}

/** Tombol dengan callback klik. */
export interface TButtonOptions extends TOptions {
  caption?: string;
  enabled?: boolean;
}

const BUTTON_PROPS = defineProps<TButtonOptions>()(["caption", "enabled"]);

export class TButton extends TComponent {
  public onClick: (() => void) | null = null;

  constructor(
    idOrOpts?: string | TButtonOptions,
    opts?: TButtonOptions,
    knownProps: readonly string[] = [],
  ) {
    super(idOrOpts, opts, [...BUTTON_PROPS, ...knownProps]);
    this.tag = "button";
    this.props.onClickId = this.id;
    const o = this.options as TButtonOptions;
    if (o.caption !== undefined) this.caption = o.caption;
    if (o.enabled !== undefined) this.enabled = o.enabled;
    this.style = {
      background: "var(--button-bg, #0f3460)",
      color: ACCENT,
      border: `1px solid ${ACCENT}`,
      borderRadius: "6px",
      padding: "6px 16px",
      cursor: "pointer",
      fontSize: "12px",
      fontWeight: "600",
      ...this.style,
    };
  }

  get caption(): string {
    return this.props.text ?? "";
  }
  set caption(value: string) {
    this.props.text = value;
    this.push({ text: value });
  }

  get enabled(): boolean {
    return !this.props.disabled;
  }
  set enabled(value: boolean) {
    this.props.disabled = !value;
    this.push({ disabled: !value });
  }

  bindEventHandler(host: TScreenPort): void {
    super.bindEventHandler(host);
    host.on(this.id, "click", () => this.onClick?.());
  }
}

/** Input satu baris. */
export interface TEditOptions extends TOptions {
  text?: string;
  placeholder?: string;
  readOnly?: boolean;
}

const EDIT_PROPS = defineProps<TEditOptions>()(["text", "placeholder", "readOnly"]);

export class TEdit extends TComponent {
  public onInput: ((value: string) => void) | null = null;

  constructor(
    idOrOpts?: string | TEditOptions,
    opts?: TEditOptions,
    knownProps: readonly string[] = [],
  ) {
    super(idOrOpts, opts, [...EDIT_PROPS, ...knownProps]);
    this.tag = "input";
    this.props.type = "text";
    this.props.onInputId = this.id;
    const o = this.options as TEditOptions;
    this.style = { ...INPUT_STYLE, ...this.style };
    if (o.text !== undefined) this.text = o.text;
    if (o.placeholder !== undefined) this.placeholder = o.placeholder;
    if (o.readOnly !== undefined) this.readOnly = o.readOnly;
  }

  get text(): string {
    return this.props.value ?? "";
  }
  set text(value: string) {
    this.props.value = value;
    this.push({ value });
  }

  get placeholder(): string {
    return this.props.placeholder ?? "";
  }
  set placeholder(value: string) {
    this.props.placeholder = value;
    this.push({ placeholder: value });
  }

  get readOnly(): boolean {
    return Boolean(this.props.readOnly);
  }
  set readOnly(value: boolean) {
    this.props.readOnly = Boolean(value);
    const userStyle = (this.options as TEditOptions).style ?? {};
    this.style = inputStyle(INPUT_STYLE, userStyle, this.readOnly);
    this.push({ readOnly: Boolean(value) });
  }

  bindEventHandler(host: TScreenPort): void {
    super.bindEventHandler(host);
    host.on(this.id, "input", (ev: any) => {
      const value = ev?.value ?? "";
      this.props.value = value;
      this.onInput?.(value);
    });
  }
}

/** Input multiline. */
export interface TMemoOptions extends TOptions {
  text?: string;
  rows?: number;
  readOnly?: boolean;
}

const MEMO_PROPS = defineProps<TMemoOptions>()(["text", "rows", "readOnly"]);

export class TMemo extends TComponent {
  public onInput: ((value: string) => void) | null = null;

  constructor(
    idOrOpts?: string | TMemoOptions,
    opts?: TMemoOptions,
    knownProps: readonly string[] = [],
  ) {
    super(idOrOpts, opts, [...MEMO_PROPS, ...knownProps]);
    this.tag = "textarea";
    this.props.onInputId = this.id;
    const o = this.options as TMemoOptions;
    this.style = { ...MEMO_STYLE, ...this.style };
    this.rows = o.rows ?? 5;
    if (o.text !== undefined) this.text = o.text;
    if (o.readOnly !== undefined) this.readOnly = o.readOnly;
  }

  get text(): string {
    return this.props.text ?? "";
  }
  set text(value: string) {
    this.props.text = value;
    this.push({ text: value });
  }

  get rows(): number {
    return this.props.rows ?? 5;
  }
  set rows(value: number) {
    this.props.rows = value;
    this.push({ rows: value });
  }

  get readOnly(): boolean {
    return Boolean(this.props.readOnly);
  }
  set readOnly(value: boolean) {
    this.props.readOnly = Boolean(value);
    const userStyle = (this.options as TMemoOptions).style ?? {};
    this.style = inputStyle(MEMO_STYLE, userStyle, this.readOnly);
    this.push({ readOnly: Boolean(value) });
  }

  bindEventHandler(host: TScreenPort): void {
    super.bindEventHandler(host);
    host.on(this.id, "input", (ev: any) => {
      const value = ev?.value ?? "";
      this.props.text = value;
      this.onInput?.(value);
    });
  }
}

/** Checkbox dengan simbol teks (kompatibel DOME). */
export interface TCheckBoxOptions extends TOptions {
  caption?: string;
  checked?: boolean;
}

const CHECKBOX_PROPS = defineProps<TCheckBoxOptions>()(["caption", "checked"]);

export class TCheckBox extends TComponent {
  public onClick: ((checked: boolean) => void) | null = null;
  private _caption: string = "";

  constructor(
    idOrOpts?: string | TCheckBoxOptions,
    opts?: TCheckBoxOptions,
    knownProps: readonly string[] = [],
  ) {
    super(idOrOpts, opts, [...CHECKBOX_PROPS, ...knownProps]);
    this.tag = "div";
    this.props.onClickId = this.id;
    const o = this.options as TCheckBoxOptions;
    this._caption = o.caption ?? "";
    if (o.checked !== undefined) this.checked = o.checked;
    this.style = { ...CHECK_STYLE, ...this.style };
  }

  get caption(): string {
    return this._caption;
  }
  set caption(value: string) {
    this._caption = value;
    this.pushChild(`${this.id}_cap`, { text: value });
  }

  get checked(): boolean {
    return this.props["data-checked"] === "true";
  }
  set checked(value: boolean) {
    this.props["data-checked"] = value ? "true" : "false";
    this.pushChild(`${this.id}_sym`, { text: value ? "☑ " : "☐ " });
  }

  bindEventHandler(host: TScreenPort): void {
    super.bindEventHandler(host);
    host.on(this.id, "click", () => this.handleClick());
  }

  /** Perilaku klik default: toggle. Radio meng-override jadi pilih tunggal. */
  protected handleClick(): void {
    this.checked = !this.checked;
    this.onClick?.(this.checked);
  }

  build(): TNode {
    return {
      id: this.id,
      tag: this.tag,
      props: { ...this.props, style: { ...this.style } },
      children: [
        {
          id: `${this.id}_sym`,
          tag: "span",
          props: {
            style: { fontSize: "20px", verticalAlign: "middle" },
            text: this.checked ? "☑ " : "☐ ",
          },
          children: [],
        },
        {
          id: `${this.id}_cap`,
          tag: "span",
          props: {
            style: { fontSize: "11px", verticalAlign: "middle" },
            text: this._caption,
          },
          children: [],
        },
      ],
    };
  }

  private pushChild(id: string, props: Record<string, any>): void {
    if (this.host) this.background(this.host.update(id, props), "update");
  }
}

/** Radio button dengan pengelompokan per parent. */
export interface TRadioButtonOptions extends TCheckBoxOptions {
  group?: string;
}

const RADIO_PROPS = defineProps<TRadioButtonOptions, TCheckBoxOptions>()(["group"]);

export class TRadioButton extends TCheckBox {
  /** `null` = tanpa grup eksplisit → hanya saudara satu parent. */
  private _group: string | null;

  constructor(
    idOrOpts?: string | TRadioButtonOptions,
    opts?: TRadioButtonOptions,
  ) {
    super(idOrOpts, opts, RADIO_PROPS);
    const o = this.options as TRadioButtonOptions;
    this._group = o.group ?? null;
  }

  get group(): string {
    return this._group ?? "default";
  }

  override get checked(): boolean {
    return super.checked;
  }
  /**
   * Menyalakan radio (lewat klik atau kode) mematikan anggota grup lain.
   * Grup eksplisit berlaku untuk seluruh form; tanpa `group` hanya untuk
   * saudara satu parent. Perubahan lewat kode tidak memicu `onClick`.
   */
  override set checked(value: boolean) {
    super.checked = value;
    if (value) {
      for (const other of this.groupMembers()) other.checked = false;
    }
  }

  protected handleClick(): void {
    if (this.checked) return;
    this.checked = true;
    this.onClick?.(true);
  }

  /** Radio lain yang satu grup (konstruktor: belum ada tree, jadi kosong). */
  private groupMembers(): TRadioButton[] {
    // Saat super() memanggil setter, _group belum diinisialisasi.
    if (this._group === undefined) return [];

    let scope: TComponent | null = this.parent;
    if (!scope) return [];
    if (this._group !== null) {
      while (scope.parent) scope = scope.parent;
    }

    const members: TRadioButton[] = [];
    const visit = (node: TComponent, deep: boolean): void => {
      for (const child of node.children) {
        if (
          child instanceof TRadioButton &&
          child !== this &&
          child._group === this._group &&
          (this._group !== null || child.parent === this.parent)
        ) {
          members.push(child);
        }
        if (deep) visit(child, true);
      }
    };
    visit(scope, this._group !== null);
    return members;
  }
}

/** Dropdown pilihan tunggal. */
export interface TComboBoxOptions extends TOptions {
  items?: string[];
  selectedIndex?: number;
}

const COMBOBOX_PROPS = defineProps<TComboBoxOptions>()(["items", "selectedIndex"]);

export class TComboBox extends TComponent {
  public onChange: ((index: number, item: string) => void) | null = null;
  private _items: string[] = [];
  private _selectedIndex: number = -1;

  constructor(
    idOrOpts?: string | TComboBoxOptions,
    opts?: TComboBoxOptions,
    knownProps: readonly string[] = [],
  ) {
    super(idOrOpts, opts, [...COMBOBOX_PROPS, ...knownProps]);
    this.tag = "select";
    this.props.onInputId = this.id;
    const o = this.options as TComboBoxOptions;
    this._items = [...(o.items ?? [])];
    this._selectedIndex = o.selectedIndex ?? -1;
    this.style = {
      ...INPUT_STYLE,
      padding: "8px 10px",
      cursor: "pointer",
      ...this.style,
    };
  }

  get items(): readonly string[] {
    return this._items;
  }
  /** Sama persis dengan `setItems()`; pakai `setItems()` bila perlu menunggu render. */
  set items(value: string[]) {
    this.background(this.setItems(value), "setItems");
  }

  get selectedIndex(): number {
    return this._selectedIndex;
  }
  set selectedIndex(value: number) {
    this._selectedIndex = value;
    this.push({ value: String(value) });
  }

  /**
   * Ganti daftar opsi saat runtime, mis. lookup yang bergantung pada pilihan
   * lain. Nilai yang sedang dipilih dipertahankan bila masih ada.
   */
  async setItems(items: string[]): Promise<void> {
    const next = [...items];
    this._selectedIndex = nextSelection(this._items, this._selectedIndex, next, "first");
    this._items = next;
    this.push({ value: String(this._selectedIndex) });
    const host = this.host;
    if (!host?.setContent) return;
    await host.setContent(this.id, ...this.build().children);
  }

  bindEventHandler(host: TScreenPort): void {
    super.bindEventHandler(host);
    host.on(this.id, "input", (ev: any) => {
      const index = Number.parseInt(ev?.value ?? "", 10);
      if (Number.isNaN(index)) return;
      this._selectedIndex = index;
      this.onChange?.(index, this._items[index] ?? "");
    });
  }

  build(): TNode {
    return {
      id: this.id,
      tag: this.tag,
      props: { ...this.props, style: { ...this.style } },
      children: this._items.map((item, index) => ({
        id: `${this.id}_opt_${index}`,
        tag: "option",
        props: {
          value: String(index),
          text: item,
          ...(index === this._selectedIndex ? { selected: true } : {}),
        },
        children: [],
      })),
    };
  }
}

/** Daftar pilihan dengan seleksi baris. */
export interface TListBoxOptions extends TOptions {
  items?: string[];
  selectedIndex?: number;
}

const LISTBOX_PROPS = defineProps<TListBoxOptions>()(["items", "selectedIndex"]);

export class TListBox extends TComponent {
  public onClick: ((index: number, item: string) => void) | null = null;
  private _items: string[] = [];
  private _selectedIndex: number = -1;

  constructor(
    idOrOpts?: string | TListBoxOptions,
    opts?: TListBoxOptions,
    knownProps: readonly string[] = [],
  ) {
    super(idOrOpts, opts, [...LISTBOX_PROPS, ...knownProps]);
    this.tag = "div";
    const o = this.options as TListBoxOptions;
    this._items = [...(o.items ?? [])];
    this._selectedIndex = o.selectedIndex ?? -1;
    this.style = {
      background: "var(--surface, rgba(0,0,0,0.2))",
      borderRadius: "6px",
      padding: "4px",
      overflowY: "auto",
      minHeight: "100px",
      width: "100%",
      minWidth: "0",
      border: "1px solid rgba(255,255,255,0.08)",
      ...this.style,
    };
  }

  get items(): readonly string[] {
    return this._items;
  }
  /** Sama persis dengan `setItems()`; pakai `setItems()` bila perlu menunggu render. */
  set items(value: string[]) {
    this.background(this.setItems(value), "setItems");
  }

  get selectedIndex(): number {
    return this._selectedIndex;
  }
  set selectedIndex(value: number) {
    this._selectedIndex = value;
    this.applySelection();
  }

  /**
   * Ganti isi list saat runtime. Item terpilih dipertahankan bila masih ada
   * (aturan sama dengan TComboBox, tapi tanpa memilih item pertama otomatis).
   */
  async setItems(items: string[]): Promise<void> {
    const next = [...items];
    this._selectedIndex = nextSelection(this._items, this._selectedIndex, next, "none");
    this._items = next;
    if (!this.host?.setContent) return;

    await this.host.setContent(this.id, ...this.build().children);
    this.bindRows();
  }

  bindEventHandler(host: TScreenPort): void {
    super.bindEventHandler(host);
    this.bindRows();
  }

  build(): TNode {
    return {
      id: this.id,
      tag: this.tag,
      props: { ...this.props, style: { ...this.style } },
      children: this._items.map((item, index) => ({
        id: `${this.id}_item_${index}`,
        tag: "div",
        props: {
          onClickId: `${this.id}_item_${index}`,
          text: item,
          style: this.rowStyle(index),
        },
        children: [],
      })),
    };
  }

  private bindRows(): void {
    const host = this.host;
    if (!host) return;

    this._items.forEach((_, index) => {
      host.on(`${this.id}_item_${index}`, "click", () => this.select(index));
    });
  }

  private select(index: number): void {
    this._selectedIndex = index;
    this.applySelection();
    this.onClick?.(index, this._items[index] ?? "");
  }

  private applySelection(): void {
    const host = this.host;
    if (!host) return;
    this._items.forEach((_, index) => {
      this.background(host.update(`${this.id}_item_${index}`, {
        style: this.rowStyle(index),
      }), "update");
    });
  }

  private rowStyle(index: number): TStyle {
    const active = index === this._selectedIndex;
    return {
      padding: "5px 3px",
      cursor: "pointer",
      fontSize: "12px",
      borderRadius: "4px",
      color: active ? ACCENT : TEXT_DIM,
      background: active ? "var(--accent-bg, rgba(76,175,80,0.15))" : "transparent",
    };
  }
}
