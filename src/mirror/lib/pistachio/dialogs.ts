/**
 * pistachio/dialogs.ts — Dialog modal dan file dialog.
 *
 * Semua dialog didelegasikan ke `Screen` emerald; Pistachio hanya menyediakan
 * API yang konsisten dan bisa menerima `TForm` langsung.
 *
 * (c) 2026 TSIX Project
 */

import { Screen, type TAlertOptions } from "@tsix/emerald";
import { fs } from "@tsix/Application";
import { defineProps, EComponentError, TComponent, type TOptions } from "./core";
import { TForm } from "./form";

export interface TFileDialogResult {
  path: string;
  filename: string;
  directory: string;
}

/** Pemilik dialog: form aplikasi atau Screen langsung. */
export type TDialogOwner = TForm | Screen;

function resolveScreen(owner: TDialogOwner): Screen {
  if (owner instanceof TForm) {
    const screen = owner.screen;
    if (!screen) {
      throw new EComponentError(
        "NOT_MOUNTED",
        `Form "${owner.id}" is not running; call run() before opening a dialog`,
        owner.id,
      );
    }
    return screen;
  }

  // Screen langsung, atau objek yang menyediakan `screen` (mis. wrapper/mock).
  if (typeof (owner as any).openFileDialog === "function") {
    return owner as Screen;
  }
  const nested = (owner as any).screen;
  if (nested) return nested as Screen;

  throw new EComponentError("INVALID_OPTIONS", "Dialog owner must be a TForm or Screen");
}

/**
 * Trio dialog dasar.
 *
 * `confirm()` mengembalikan label tombol yang diklik (default tombol pertama
 * adalah pilihan utama), sehingga dialog tiga tombol tetap bisa dibedakan.
 */
export class TDialogs {
  static async alert(
    owner: TDialogOwner,
    title: string,
    message?: string,
    options?: TAlertOptions,
  ): Promise<void> {
    const screen = resolveScreen(owner);
    // Pertahankan pemanggilan dua argumen untuk pemilik dialog lama/mock.
    if (options) await screen.alert(title, message, options);
    else await screen.alert(title, message);
  }

  static async confirm(
    owner: TDialogOwner,
    title: string,
    message: string = "",
    buttons: string[] = ["OK", "Cancel"],
  ): Promise<string> {
    return resolveScreen(owner).confirm(title, message, buttons);
  }

  static async input(
    owner: TDialogOwner,
    title: string,
    message: string = "",
    defaultValue: string = "",
  ): Promise<string | null> {
    return resolveScreen(owner).question(title, message, defaultValue);
  }
}

export interface TOpenDialogOptions extends TOptions {
  title?: string;
  startDir?: string;
  filter?: string[];
}

const OPENDIALOG_PROPS = defineProps<TOpenDialogOptions>()(["title", "startDir", "filter"]);

/**
 * Dialog pilih file, komponen non-visual (K6). Pasang ke form lalu panggil
 * `execute()`; hasilnya null bila dibatalkan.
 *
 * ```ts
 * const dlg = new TOpenDialog({ id: "dlg-open", title: "Pilih file" });
 * form.add(dlg);
 * const result = await dlg.execute();
 * ```
 */
export class TOpenDialog extends TComponent {
  public title?: string;
  public startDir?: string;
  public filter: string[];

  constructor(
    idOrOpts?: string | TOpenDialogOptions,
    opts?: TOpenDialogOptions,
    knownProps: readonly string[] = [],
  ) {
    super(idOrOpts, opts, [...OPENDIALOG_PROPS, ...knownProps]);
    this.isVisual = false;
    const o = this.options as TOpenDialogOptions;
    this.title = o.title;
    this.startDir = o.startDir;
    this.filter = [...(o.filter ?? [])];
  }

  /** Tampilkan dialog. Tanpa `owner`, dialog memakai form tempat ia dipasang. */
  async execute(owner?: TDialogOwner, fsLib: any = fs): Promise<TFileDialogResult | null> {
    return this.ownerScreen(owner).openFileDialog(fsLib, {
      title: this.title,
      startDir: this.startDir,
      filter: this.filter,
    });
  }

  protected ownerScreen(owner?: TDialogOwner): Screen {
    if (owner) return resolveScreen(owner);
    let root: TComponent = this;
    while (root.parent) root = root.parent;
    if (!(root instanceof TForm)) {
      throw new EComponentError(
        "NOT_MOUNTED",
        `Dialog "${this.id}" is not attached to a form; add it to a form or pass an owner`,
        this.id,
      );
    }
    return resolveScreen(root);
  }
}

export interface TSaveDialogOptions extends TOpenDialogOptions {
  defaultName?: string;
}

const SAVEDIALOG_PROPS = defineProps<TSaveDialogOptions, TOpenDialogOptions>()(["defaultName"]);

/** Dialog simpan file, komponen non-visual. `execute()` → null bila dibatalkan. */
export class TSaveDialog extends TOpenDialog {
  public defaultName: string;

  constructor(idOrOpts?: string | TSaveDialogOptions, opts?: TSaveDialogOptions) {
    super(idOrOpts, opts, SAVEDIALOG_PROPS);
    this.defaultName = (this.options as TSaveDialogOptions).defaultName ?? "";
  }

  override async execute(
    owner?: TDialogOwner,
    fsLib: any = fs,
  ): Promise<TFileDialogResult | null> {
    return this.ownerScreen(owner).saveFileDialog(fsLib, {
      title: this.title,
      startDir: this.startDir,
      defaultName: this.defaultName,
    });
  }
}
