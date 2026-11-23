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
import { EComponentError } from "./core";
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

export interface TOpenDialogOptions {
  title?: string;
  startDir?: string;
  filter?: string[];
}

/** Dialog pilih file. `execute()` mengembalikan null bila dibatalkan. */
export class TOpenDialog {
  public title?: string;
  public startDir?: string;
  public filter: string[];

  constructor(options: TOpenDialogOptions = {}) {
    this.title = options.title;
    this.startDir = options.startDir;
    this.filter = options.filter ?? [];
  }

  async execute(
    owner: TDialogOwner,
    fsLib: any = fs,
  ): Promise<TFileDialogResult | null> {
    return resolveScreen(owner).openFileDialog(fsLib, {
      title: this.title,
      startDir: this.startDir,
      filter: this.filter,
    });
  }
}

export interface TSaveDialogOptions extends TOpenDialogOptions {
  defaultName?: string;
}

/** Dialog simpan file. `execute()` mengembalikan null bila dibatalkan. */
export class TSaveDialog {
  public title?: string;
  public startDir?: string;
  public filter: string[];
  public defaultName: string;

  constructor(options: TSaveDialogOptions = {}) {
    this.title = options.title;
    this.startDir = options.startDir;
    this.filter = options.filter ?? [];
    this.defaultName = options.defaultName ?? "";
  }

  async execute(
    owner: TDialogOwner,
    fsLib: any = fs,
  ): Promise<TFileDialogResult | null> {
    return resolveScreen(owner).saveFileDialog(fsLib, {
      title: this.title,
      startDir: this.startDir,
      defaultName: this.defaultName,
    });
  }
}
