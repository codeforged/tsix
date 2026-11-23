/**
 * pistachio/core.ts — Fondasi komponen Pistachio.
 *
 * Aturan inti yang membedakan Pistachio dari Cashew:
 * - Satu bentuk konstruktor: `(idOrOpts?, opts?)`.
 * - Props dan style dipisah tegas; key tak dikenal ditolak, bukan jadi CSS.
 * - Tree komponen menjaga satu parent dan ID unik dalam satu root.
 *
 * (c) 2026 TSIX Project
 */

/** Style CSS objek, diteruskan ke lapisan DOM. */
export type TStyle = Record<string, any>;

/** Opsi dasar semua komponen. Subclass menambah props lewat daftar `knownProps`. */
export interface TOptions {
  id?: string;
  style?: TStyle;
  children?: TComponent[];
}

/** Representasi node netral sebelum diterjemahkan ke DOM oleh lapisan UI. */
export interface TNode {
  id: string;
  tag: string;
  props: Record<string, any>;
  children: TNode[];
}

export type TEventName =
  | "click"
  | "input"
  | "keydown"
  | "change"
  | "close";

/** Event tombol keyboard dari lapisan UI. */
export interface TKeyEvent {
  key: string;
  code: string;
  down: boolean;
  repeat: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

/** Capture keyboard milik satu window (emerald `Keyboard`). */
export interface TKeyboardPort {
  on(cb: (ev: TKeyEvent) => void): () => void;
  /** Kembalikan fokus ke penangkap window (mis. setelah input selesai). */
  focus?(): Promise<unknown> | unknown;
}

/**
 * Port ke lapisan UI (emerald/Screen). Core tidak mengimpor emerald supaya
 * tetap bisa diuji tanpa DOM dan tidak menciptakan ketergantungan melingkar.
 */
export interface TScreenPort {
  mount(node: TNode, parentId?: string): Promise<unknown> | unknown;
  update(
    targetId: string,
    props: Record<string, any>,
  ): Promise<unknown> | unknown;
  on(
    targetId: string,
    event: TEventName,
    callback: (ev: any) => void,
  ): Promise<unknown> | void;
  off?(targetId: string): void;
  unmount?(targetId: string): Promise<unknown> | unknown;
  setContent?(
    containerId: string,
    ...children: TNode[]
  ): Promise<unknown> | unknown;
  /** Ada bila window mendukung shortcut keyboard. */
  keyboard?: TKeyboardPort | null;
}

export type TComponentErrorCode =
  | "INVALID_OPTIONS"
  | "UNKNOWN_PROP"
  | "CYCLE"
  | "ALREADY_PARENTED"
  | "DUPLICATE_ID"
  | "NOT_A_CHILD"
  | "DISPOSED"
  | "UNSUPPORTED"
  /** Operasi butuh form yang sudah `run()`. */
  | "NOT_MOUNTED"
  /** Baca file/aset gagal; `cause` = error asli. */
  | "IO_FAILED";

export class EComponentError extends Error {
  public readonly code: TComponentErrorCode;
  public readonly componentId?: string;
  public readonly cause?: unknown;

  constructor(
    code: TComponentErrorCode,
    message: string,
    componentId?: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "EComponentError";
    this.code = code;
    this.componentId = componentId;
    this.cause = cause;
  }
}

const BASE_OPTIONS = ["id", "style", "children"] as const;

/** Key opsi milik `T` yang tidak diwarisi dari `TBase` (default: opsi dasar). */
export type OwnProps<T, TBase = TOptions> = Exclude<keyof T, keyof TBase> & string;

/** `true` bila dua union key sama persis, `false` bila tidak. */
export type AssertExact<A extends PropertyKey, B extends PropertyKey> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

/**
 * K5 — satu sumber props. Daftar props kelas ditulis sekali sebagai array dan
 * dicek terhadap interface opsinya saat compile:
 *
 * ```ts
 * const BUTTON_PROPS = defineProps<TButtonOptions>()(["caption", "enabled"]);
 * ```
 *
 * Key di array yang tidak ada di interface → error; key di interface yang tidak
 * ada di array → error `missing: "..."`. Untuk subclass, `TBase` adalah
 * interface opsi induk, sehingga hanya props tambahannya yang didaftarkan.
 */
export function defineProps<T, TBase = TOptions>() {
  return <const K extends readonly OwnProps<T, TBase>[]>(
    keys: K &
      ([AssertExact<OwnProps<T, TBase>, K[number]>] extends [true]
        ? unknown
        : { missing: Exclude<OwnProps<T, TBase>, K[number]> }),
  ): K => keys;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalisasi argumen konstruktor menjadi satu objek opsi.
 * Bentuk yang didukung: `("id")`, `({ ...opsi })`, `("id", { ...opsi })`.
 * Argumen kedua menimpa argumen pertama.
 */
export function resolveOptions(
  idOrOpts?: string | TOptions,
  opts?: TOptions,
): TOptions {
  if (idOrOpts === undefined) return { ...(opts ?? {}) };

  if (typeof idOrOpts === "string") {
    return { ...(opts ?? {}), id: idOrOpts };
  }

  if (!isPlainObject(idOrOpts)) {
    throw new EComponentError(
      "INVALID_OPTIONS",
      "Options must be an id string or an object",
    );
  }

  const merged: TOptions = { ...idOrOpts, ...(opts ?? {}) };
  if (merged.id === undefined) merged.id = idOrOpts.id;
  return merged;
}

/** Tolak key yang tidak dideklarasikan komponen — mencegah typo jadi CSS. */
export function assertKnownProps(
  options: Record<string, any>,
  known: readonly string[],
  owner: string,
): void {
  for (const key of Object.keys(options)) {
    if (!known.includes(key)) {
      throw new EComponentError(
        "UNKNOWN_PROP",
        `Unknown property "${key}" on ${owner}`,
        owner,
      );
    }
  }
}

let _seq = 0;

function generateId(ctor: { name?: string }): string {
  const name =
    (ctor?.name || "component")
      .replace(/^T/, "")
      .replace(/[^a-zA-Z0-9]/g, "")
      .toLowerCase() || "component";
  return `${name}_${++_seq}`;
}

export class TComponent {
  public readonly id: string;
  public tag: string = "div";
  /** Komponen non-visual tetap di-bind, tapi tidak menghasilkan node DOM. */
  public isVisual: boolean = true;
  public props: Record<string, any> = {};

  private _style: TStyle = {};
  private _parent: TComponent | null = null;
  private readonly _children: TComponent[] = [];
  private _registry: Map<string, TComponent> | null = null;
  private _host: TScreenPort | null = null;
  private _disposed: boolean = false;
  private _skipUnmountOnDispose = false;

  /** Opsi hasil normalisasi; subclass membaca props tambahannya dari sini. */
  protected readonly options: TOptions;

  /**
   * `knownProps` dipakai subclass untuk mendeklarasikan props tambahannya,
   * sehingga validasi tetap ketat tanpa melonggarkan aturan di basis.
   */
  constructor(
    idOrOpts?: string | TOptions,
    opts?: TOptions,
    knownProps: readonly string[] = [],
  ) {
    const options = resolveOptions(idOrOpts, opts);
    assertKnownProps(
      options,
      [...BASE_OPTIONS, ...knownProps],
      this.constructor.name,
    );

    this.id = options.id ?? generateId(this.constructor);
    this.options = options;
    this._style = { ...(options.style ?? {}) };
    for (const child of options.children ?? []) this.add(child);
  }

  /**
   * Style komponen. Assignment setelah mount langsung disinkronkan ke UI;
   * mutasi objek (`this.style.x = ...`) tidak memicu sinkronisasi.
   */
  get style(): TStyle {
    return this._style;
  }
  set style(v: TStyle) {
    this._style = v || {};
    if (this._host) {
      this.background(this._host.update(this.id, { style: { ...this._style } }), "style update");
    }
  }

  get host(): TScreenPort | null {
    return this._host;
  }

  get parent(): TComponent | null {
    return this._parent;
  }

  get children(): readonly TComponent[] {
    return this._children;
  }

  /** Forward a keyboard event to children until one component handles it. */
  handleKeyEvent(event: TKeyEvent): boolean {
    for (const child of this._children) {
      if (child.handleKeyEvent(event)) return true;
    }
    return false;
  }

  get disposed(): boolean {
    return this._disposed;
  }

  /** Pasang child. Menolak child yang sudah punya parent atau ID duplikat. */
  add(child: TComponent): TComponent {
    this.assertUsable();

    if (!(child instanceof TComponent)) {
      throw new EComponentError(
        "INVALID_OPTIONS",
        `Component "${this.id}" can only contain TComponent children`,
        this.id,
      );
    }

    if (child._disposed) {
      throw new EComponentError(
        "DISPOSED",
        `Component "${child.id}" has been disposed`,
        child.id,
      );
    }

    if (child._parent) {
      throw new EComponentError(
        "ALREADY_PARENTED",
        `Component "${child.id}" already belongs to "${child._parent.id}"`,
        child.id,
      );
    }

    for (let node: TComponent | null = this; node; node = node._parent) {
      if (node === child) {
        throw new EComponentError(
          "CYCLE",
          `Component "${child.id}" cannot be added to its own descendant`,
          child.id,
        );
      }
    }

    const registry = this.rootComponent().ensureRegistry();
    const subtree = collectTree(child);

    for (const component of subtree) {
      if (registry.has(component.id)) {
        throw new EComponentError(
          "DUPLICATE_ID",
          `Duplicate component id "${component.id}"`,
          component.id,
        );
      }
    }

    child._parent = this;
    this._children.push(child);
    for (const component of subtree) registry.set(component.id, component);

    this.rootComponent().onChildAdded(child, this);
    return child;
  }

  /**
   * Lepas child dari tree tanpa menghancurkannya, sehingga bisa dipasang ke
   * parent lain. ID-nya langsung dibebaskan. Panggil `dispose()` bila subtree
   * memang tidak dipakai lagi.
   */
  remove(child: TComponent): TComponent {
    this.assertUsable();

    const index = this._children.indexOf(child);
    if (index < 0) {
      throw new EComponentError(
        "NOT_A_CHILD",
        `Component "${child.id}" is not a child of "${this.id}"`,
        child.id,
      );
    }

    const registry = this.rootComponent()._registry;
    const subtree = collectTree(child);
    for (const component of subtree) {
      if (registry?.get(component.id) === component) {
        registry.delete(component.id);
      }
      component.detachFromHost();
    }

    this._children.splice(index, 1);
    child._parent = null;
    return child;
  }

  /** Cari komponen berdasarkan ID di seluruh tree root. */
  byId<T extends TComponent = TComponent>(id: string): T | null {
    const found = this.rootComponent().ensureRegistry().get(id);
    return found ? (found as T) : null;
  }

  /** Hancurkan subtree; idempoten dan otomatis melepas diri dari parent. */
  dispose(): void {
    if (this._disposed) return;

    const root = this.rootComponent();
    const subtree = collectTree(this);

    if (root._registry) {
      for (const component of subtree) {
        if (root._registry.get(component.id) === component) {
          root._registry.delete(component.id);
        }
      }
    }

    for (const component of subtree) {
      component._disposed = true;
      component.detachFromHost();
      component._children.length = 0;
    }

    const parent = this._parent;
    if (parent) {
      const index = parent._children.indexOf(this);
      if (index >= 0) parent._children.splice(index, 1);
    }
    this._parent = null;
  }

  /**
   * Dispose each node in the subtree, optionally leaving DOM teardown to the
   * window.
   */
  disposeTree(options: { unmount?: boolean } = {}): void {
    const subtree = collectTree(this);
    if (options.unmount === false) {
      for (const component of subtree) {
        component._skipUnmountOnDispose = true;
      }
    }
    for (const component of subtree.reverse()) component.dispose();
  }

  /** Tree netral (belum DOM). Komponen non-visual tidak ikut. */
  build(): TNode {
    const props: Record<string, any> = { ...this.props };
    if (Object.keys(this.style).length > 0) props.style = { ...this.style };

    return {
      id: this.id,
      tag: this.tag,
      props,
      children: this._children
        .filter((child) => child.isVisual)
        .map((child) => child.build()),
    };
  }

  /** Kirim perubahan props ke UI bila komponen sudah ter-mount. */
  protected push(props: Record<string, any>): void {
    if (this._host) this.background(this._host.update(this.id, props), "update");
  }

  /**
   * Fire-and-forget terpusat: tugas async yang tidak ditunggu pemanggil
   * (setter, event UI) tidak boleh menjadi unhandled rejection. Kegagalannya
   * diteruskan ke `reportError()`.
   */
  protected background(task: unknown, context: string): void {
    if (task && typeof (task as PromiseLike<unknown>).then === "function") {
      (task as PromiseLike<unknown>).then(undefined, (error) => this.reportError(context, error));
    }
  }

  /**
   * Laporkan kegagalan async: ke `onError` milik komponen bila ada (K1),
   * selain itu ke `console.error`. Handler yang ikut melempar juga dilog.
   */
  protected reportError(context: string, error: unknown): void {
    const onError = (this as { onError?: unknown }).onError;
    if (typeof onError === "function") {
      try {
        onError.call(this, error);
        return;
      } catch (handlerError) {
        console.error(`[Pistachio] ${this.constructor.name} "${this.id}" onError failed:`, handlerError);
      }
    }
    console.error(`[Pistachio] ${this.constructor.name} "${this.id}" ${context} failed:`, error);
  }

  /** Daftarkan host UI. Subclass yang menangani event wajib memanggil super. */
  bindEventHandler(host: TScreenPort): void {
    this._host = host;
  }

  /** Render ulang isi dinamis. Subclass override bila perlu (mis. list). */
  async refresh(): Promise<void> {
    // Base: tidak ada isi dinamis.
  }

  /** Hook saat child masuk tree; form memakai ini untuk mount inkremental. */
  protected onChildAdded(_child: TComponent, _parent: TComponent): void {
    // Base: tidak ada host yang perlu diketahui.
  }

  /** Lepas node DOM dan handler milik subtree, lalu lupakan host. */
  private detachFromHost(): void {
    const host = this._host;
    if (!host) return;

    host.off?.(this.id);
    if (this.isVisual && !this._skipUnmountOnDispose) {
      this.background(host.unmount?.(this.id), "unmount");
    }
    this._host = null;
  }

  private rootComponent(): TComponent {
    let root: TComponent = this;
    while (root._parent) root = root._parent;
    return root;
  }

  private ensureRegistry(): Map<string, TComponent> {
    if (!this._registry) {
      this._registry = new Map();
      for (const component of collectTree(this)) {
        this._registry.set(component.id, component);
      }
    }
    return this._registry;
  }

  private assertUsable(): void {
    if (this._disposed) {
      throw new EComponentError(
        "DISPOSED",
        `Component "${this.id}" has been disposed`,
        this.id,
      );
    }
  }
}

function collectTree(root: TComponent): TComponent[] {
  const components = [root];
  for (const child of root.children) {
    components.push(...collectTree(child));
  }
  return components;
}
