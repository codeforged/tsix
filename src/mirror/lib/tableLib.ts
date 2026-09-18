/**
 * tableLib.ts — Text table builder native TSIX (padanan `cli-table3`, tapi
 * sadar-TTY-TSIX).
 *
 * Kenapa tidak pakai `cli-table3` saja?
 *
 *  1. `cli-table3` mengukur lebar pakai `string-width` (CJK/emoji = 2 kolom) dan
 *     mengarang lebar dari `process.stdout.columns`. Di worker TSIX,
 *     `process.stdout` BUKAN TTY (dan bukan layar app) — kolom jadi salah dan
 *     lebar tidak bisa ditentukan. Lib ini memakai `displayWidth()` dari
 *     `ansiLib` yang mengikuti `TTY.putChar()` (1 sel per code unit UTF-16) dan
 *     mengambil lebar dari `std.getScreenInfo()` (syscall `SCREEN_INFO` /
 *     `TIOCGWINSZ`).
 *  2. `cli-table3` mencetak lewat `console.log` → nyasar ke stdout HOST, bukan
 *     ke TTY virtual app. Lib ini mengembalikan string murni (`render()`) atau
 *     mencetak lewat `std.print()` (`print()`).
 *  3. Zero-dependency: `/lib` di-pre-compile kernel & dikirim ke SETIAP worker
 *     (lihat `Kernel.rebuildVFSCache`), jadi paket npm = beban per proses.
 *
 * ── USAGE ──
 *   import { Table } from "@tsix/tableLib";
 *   import { tone } from "@tsix/ansiLib";
 *
 *   const t = new Table({
 *     head: ["PID", "NAME", "CPU"],
 *     style: { head: { bold: true, fg: "brightwhite" } },
 *   });
 *   t.addRow([1, "init", "0.4"]);
 *   t.addRow([7, tone.danger("tsh"), "12.9"]);
 *   await t.print(std);          // lebar otomatis = COLUMNS TTY - 1
 *
 *   // Sekali pakai:
 *   await std.print(renderTable(["A", "B"], [[1, 2], [3, 4]], { charset: "markdown" }));
 *
 * ── CATATAN ──
 *  - `width` = lebar TOTAL tabel (termasuk border). Bila konten lebih lebar,
 *    kolom terlebar yang pertama menyusut (lihat `minColWidth`).
 *  - `align: "auto"` (default) → kolom yang SEMUA isi body-nya angka otomatis
 *    rata-kanan (header diabaikan). Set `align: "left"` atau
 *    `alignNumeric: false` untuk mematikan.
 *  - Kalau sel memuat ANSI sendiri (mis. hasil `tone.danger()`), padding tetap
 *    benar karena semua pengukuran lewat `displayWidth()`.
 */

import { center, displayWidth, isColorEnabled, padEnd, padStart, paint, truncate, wrap } from "./ansiLib";
import type { PaintOptions } from "./ansiLib";

// ────────────────────────────────────────────────────────────────────────────
// Tipe
// ────────────────────────────────────────────────────────────────────────────

export type Align = "left" | "right" | "center" | "auto";
export type CellValue = string | number | bigint | boolean | null | undefined;
export type Cell = CellValue;

/**
 * Kumpulan karakter bingkai. `top`/`bottom` opsional (default true) — `markdown`
 * mematikannya, karena tabel Markdown tidak punya garis atas/bawah.
 */
export interface Charset {
    tl: string;
    tr: string;
    bl: string;
    br: string;
    h: string;
    v: string;
    mt: string;
    mb: string;
    ml: string;
    mr: string;
    mm: string;
    top?: boolean;
    bottom?: boolean;
}

export type CharsetName = "box" | "rounded" | "double" | "compact" | "ascii" | "markdown" | "none";

/**
 * Preset bingkai.
 *
 *  box       ┌─────┬─────┐   (default)
 *  rounded   ╭─────┬─────╮
 *  double    ╔═════╦═════╗
 *  compact   ───── ─────     (tanpa garis vertikal, hanya rule)
 *  ascii     +-----+-----+
 *  markdown  | a | b |
 *            |---|---|
 *  none      tanpa bingkai sama sekali
 *
 * Catatan: `box`/`rounded`/`double` aman di TTY TSIX karena `TTY.putChar()`
 * menghitung karakter box-drawing (U+2500..U+257F) = 1 sel — sama seperti
 * yang dihitung `displayWidth()` di sini. (Bukti terpakai: `atto.ts:showHelp()`.)
 */
export const CHARSETS: Record<CharsetName, Charset> = {
    box: {
        tl: "┌",
        tr: "┐",
        bl: "└",
        br: "┘",
        h: "─",
        v: "│",
        mt: "┬",
        mb: "┴",
        ml: "├",
        mr: "┤",
        mm: "┼",
    },
    rounded: {
        tl: "╭",
        tr: "╮",
        bl: "╰",
        br: "╯",
        h: "─",
        v: "│",
        mt: "┬",
        mb: "┴",
        ml: "├",
        mr: "┤",
        mm: "┼",
    },
    double: {
        tl: "╔",
        tr: "╗",
        bl: "╚",
        br: "╝",
        h: "═",
        v: "║",
        mt: "╦",
        mb: "╩",
        ml: "╠",
        mr: "╣",
        mm: "╬",
    },
    compact: {
        tl: "",
        tr: "",
        bl: "",
        br: "",
        h: "─",
        v: "",
        mt: "",
        mb: "",
        ml: "",
        mr: "",
        mm: "",
    },
    ascii: {
        tl: "+",
        tr: "+",
        bl: "+",
        br: "+",
        h: "-",
        v: "|",
        mt: "+",
        mb: "+",
        ml: "+",
        mr: "+",
        mm: "+",
    },
    markdown: {
        tl: "|",
        tr: "|",
        bl: "|",
        br: "|",
        h: "-",
        v: "|",
        mt: "|",
        mb: "|",
        ml: "|",
        mr: "|",
        mm: "|",
        top: false,
        bottom: false,
    },
    none: {
        tl: "",
        tr: "",
        bl: "",
        br: "",
        h: "",
        v: "",
        mt: "",
        mb: "",
        ml: "",
        mr: "",
        mm: "",
        top: false,
        bottom: false,
    },
};

/** Warna per bagian tabel (opsional; `divider` jatuh ke `border` bila kosong). */
export interface TableStyle {
    border?: PaintOptions;
    head?: PaintOptions;
    body?: PaintOptions;
    divider?: PaintOptions;
}

/**
 * Preset warna siap pakai — pakai lewat `style: TABLE_THEMES.classic`.
 *
 *  plain   → tanpa warna sama sekali (cocok untuk output ke file/LCD)
 *  classic → border abu, header bold putih
 *  accent  → border abu, header bold cyan (warna aksen TSIX)
 */
export const TABLE_THEMES: Record<"plain" | "classic" | "accent", TableStyle> = {
    plain: {},
    classic: {
        border: { fg: "brightblack" },
        head: { bold: true, fg: "brightwhite" },
    },
    accent: {
        border: { fg: "brightblack" },
        head: { bold: true, fg: "brightcyan" },
    },
};

export interface TableOptions {
    /** Baris header. Boleh kosong (= tanpa header). */
    head?: readonly Cell[];
    /** Preset nama atau definisi bingkai sendiri. Default `"box"`. */
    charset?: CharsetName | Charset;
    /** Perataan per kolom (skalar = semua kolom), default `"auto"`. */
    align?: Align | readonly Align[];
    /** Rata-kanan otomatis untuk kolom numerik. Default `true`. */
    alignNumeric?: boolean;
    /** Spasi kiri+kanan tiap sel. Default `1`. */
    padding?: number;
    /** Lebar TOTAL tabel (termasuk border). Bila diisi, kolom menyusut agar muat. */
    width?: number;
    /** Lebar tetap per kolom (`null` = hitung otomatis). */
    colWidths?: ReadonlyArray<number | null>;
    /** Batas bawah lebar kolom saat menyusut. Default `3`. */
    minColWidth?: number;
    /** Batas atas lebar kolom. */
    maxColWidth?: number;
    /** Bungkus teks panjang jadi beberapa baris (default: potong + elipsis). */
    wrap?: boolean;
    /** Karakter elipsis saat memotong. Default `"…"`. */
    ellipsis?: string;
    /** Gambar garis pemisah setelah header. Default `true`. */
    headSeparator?: boolean;
    /** Pakai warna ANSI. Default `true` (juga butuh `isColorEnabled()` global). */
    color?: boolean;
    /** Warna border/header/body. */
    style?: TableStyle;
    /** Geser seluruh tabel ke kanan `n` sel. */
    indent?: number;
    /** Bagi sisa lebar ke kolom (rata penuh seperti `ps`). Default `false`. */
    stretch?: boolean;
}

/** Potongan API `lib.std` yang dipakai `Table.print()` (sengaja struktural). */
export interface TableStdLike {
    print(text: string): Promise<unknown>;
    getScreenInfo(): Promise<{ lines?: number; columns?: number } | null | undefined>;
}

// ────────────────────────────────────────────────────────────────────────────
// Helper (non-export kecuali yang ditandai)
// ────────────────────────────────────────────────────────────────────────────

const NUMERIC_RE = /^[-+]?(?:\d+(?:[.,]\d+)*|\d*[.,]\d+)(?:[eE][-+]?\d+)?%?$/;

/** Ubah nilai sel jadi string. `null`/`undefined` → string kosong. */
export function stringifyCell(value: CellValue): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    return String(value);
}

function resolveCharset(cs?: CharsetName | Charset): Charset {
    if (cs === undefined) return CHARSETS.box;
    if (typeof cs === "string") return CHARSETS[cs] ?? CHARSETS.box;
    return cs;
}

function padTo(cells: string[], cols: number): string[] {
    if (cells.length === cols) return cells;
    const out = cells.slice(0, cols);
    while (out.length < cols) out.push("");
    return out;
}

function columnIsNumeric(body: ReadonlyArray<string[] | null>, i: number): boolean {
    let seen = false;
    for (const row of body) {
        if (!row) continue;
        const s = (row[i] ?? "").trim();
        if (s === "") continue;
        if (!NUMERIC_RE.test(s)) return false;
        seen = true;
    }
    return seen;
}

function resolveAligns(cols: number, o: TableOptions, body: ReadonlyArray<string[] | null>): Align[] {
    const cfg = o.align;
    const numeric = o.alignNumeric !== false;
    const out: Align[] = [];
    for (let i = 0; i < cols; i++) {
        const explicit = Array.isArray(cfg) ? cfg[i] : cfg;
        if (explicit !== undefined && explicit !== "auto") {
            out.push(explicit as Align);
            continue;
        }
        out.push(numeric && columnIsNumeric(body, i) ? "right" : "left");
    }
    return out;
}

/**
 * Susutkan kolom terlebar dulu sampai total <= budget (seimbang & prediktabel).
 * Kolom dengan `colWidths` eksplisit tidak pernah disentuh.
 */
function fitWidths(widths: number[], budget: number, min: number, fixed?: ReadonlyArray<number | null>): number[] {
    const out = widths.slice();
    const isFixed = (i: number): boolean => {
        const cw = fixed?.[i];
        return cw !== undefined && cw !== null && cw > 0;
    };
    const floor = Math.max(1, Math.floor(min));
    let total = out.reduce((a, b) => a + b, 0);

    while (total > budget) {
        let idx = -1;
        let best = -Infinity;
        for (let i = 0; i < out.length; i++) {
            if (isFixed(i) || out[i] <= floor) continue;
            if (out[i] > best) {
                best = out[i];
                idx = i;
            }
        }
        if (idx === -1) break; // semua sudah kena `minColWidth`
        out[idx] -= 1;
        total -= 1;
    }
    return out;
}

/** Bagi sisa lebar ke kolom secara merata (round-robin) bila `stretch`. */
function stretchWidths(widths: number[], budget: number, o: TableOptions): number[] {
    if (!o.stretch || !Number.isFinite(budget)) return widths;
    const out = widths.slice();
    const cap = o.maxColWidth !== undefined && o.maxColWidth > 0 ? o.maxColWidth : Infinity;
    let total = out.reduce((a, b) => a + b, 0);
    let cursor = 0;
    let guard = budget * 2 + out.length;

    while (total < budget && guard-- > 0) {
        const i = cursor % out.length;
        if (out[i] < cap) {
            out[i] += 1;
            total += 1;
        }
        cursor += 1;
        if (out.every((w) => w >= cap)) break;
    }
    return out;
}

function alignText(text: string, width: number, align: Align): string {
    switch (align) {
        case "right":
            return padStart(text, width);
        case "center":
            return center(text, width);
        default:
            return padEnd(text, width);
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Table
// ────────────────────────────────────────────────────────────────────────────

export class Table {
    private headRaw: Cell[] = [];
    private rowsRaw: Array<Cell[] | null> = [];
    private options: TableOptions;

    constructor(options: TableOptions = {}) {
        const { head, ...rest } = options;
        this.options = { ...rest };
        if (head) this.headRaw = [...head];
    }

    /** Tambah satu baris (varargs). */
    public push(...cells: Cell[]): this {
        this.rowsRaw.push(cells);
        return this;
    }

    /** Tambah satu baris (array). */
    public addRow(cells: readonly Cell[]): this {
        this.rowsRaw.push([...cells]);
        return this;
    }

    public addRows(rows: ReadonlyArray<readonly Cell[]>): this {
        for (const r of rows) this.addRow(r);
        return this;
    }

    /** Sisipkan garis pemisah horizontal di posisi sekarang. */
    public separator(): this {
        this.rowsRaw.push(null);
        return this;
    }

    public setHead(cells: readonly Cell[]): this {
        this.headRaw = [...cells];
        return this;
    }

    /** Banyak baris body (garis pemisah tidak dihitung). */
    public get rowCount(): number {
        return this.rowsRaw.filter((r) => r !== null).length;
    }

    /** Bangun tabel dari array objek. `columns` menentukan urutan kolom. */
    public static fromRecords(
        records: ReadonlyArray<Record<string, CellValue>>,
        columns?: readonly string[],
        options: TableOptions = {},
    ): Table {
        const keys = columns ?? (records.length > 0 ? Object.keys(records[0]) : []);
        const t = new Table({ ...options, head: keys });
        for (const rec of records) t.addRow(keys.map((k) => rec[k]));
        return t;
    }

    /** Render jadi string (baris digabung `\n`, TANPA newline penutup). */
    public render(override?: TableOptions): string {
        return this.toLines(override).join("\n");
    }

    /** Sama dengan `render()` — biar kompatibel dengan kebiasaan `cli-table3`. */
    public toString(): string {
        return this.render();
    }

    /** Render jadi array baris (dipakai kalau perlu menyalurkan per-baris). */
    public toLines(override?: TableOptions): string[] {
        const o: TableOptions = { ...this.options, ...(override ?? {}) };
        const cs = resolveCharset(o.charset);
        const pad = Math.max(0, Math.floor(o.padding ?? 1));
        const indentWidth = Math.max(0, Math.floor(o.indent ?? 0));
        const indent = " ".repeat(indentWidth);
        const ellipsis = o.ellipsis ?? "…";
        const wrapEnabled = o.wrap === true;

        const colorOn = (o.color ?? true) && isColorEnabled();
        const borderStyle = o.style?.border;
        const dividerStyle = o.style?.divider ?? o.style?.border;
        const headStyle = o.style?.head;
        const bodyStyle = o.style?.body;

        const pBorder = (t: string): string => (colorOn && borderStyle ? paint(t, borderStyle) : t);
        const pDivider = (t: string): string => (colorOn && dividerStyle ? paint(t, dividerStyle) : t);
        const pHead = (t: string): string => (colorOn && headStyle ? paint(t, headStyle) : t);
        const pBody = (t: string): string => (colorOn && bodyStyle ? paint(t, bodyStyle) : t);

        const head = this.headRaw.map(stringifyCell);
        const body = this.rowsRaw.map((r) => (r === null ? null : r.map(stringifyCell)));

        const cols = Math.max(head.length, ...body.map((r) => (r ? r.length : 0)), 0);
        if (cols === 0) return [];

        const normHead = head.length > 0 ? padTo(head, cols) : null;
        const normBody = body.map((r) => (r === null ? null : padTo(r, cols)));
        const aligns = resolveAligns(cols, o, normBody);

        // ── 1. Lebar natural per kolom ──
        const natural: number[] = [];
        for (let i = 0; i < cols; i++) {
            let w = normHead ? displayWidth(normHead[i]) : 0;
            for (const row of normBody) {
                if (!row) continue;
                for (const seg of row[i].replace(/\s*\r?\n\s*/g, " ").split("\n")) {
                    w = Math.max(w, displayWidth(seg));
                }
            }
            if (o.maxColWidth !== undefined && o.maxColWidth > 0) {
                w = Math.min(w, o.maxColWidth);
            }
            natural.push(Math.max(1, w));
        }
        if (o.colWidths) {
            for (let i = 0; i < cols; i++) {
                const cw = o.colWidths[i];
                if (cw !== undefined && cw !== null && cw > 0) natural[i] = Math.floor(cw);
            }
        }

        // ── 2. Overhead bingkai & padding (tidak bergantung isi) ──
        const hasLeft = cs.v !== "" || cs.tl !== "" || cs.bl !== "" || cs.ml !== "";
        const hasRight = cs.v !== "" || cs.tr !== "" || cs.br !== "" || cs.mr !== "";
        const padLeftAt = (i: number): number => (i === 0 && !hasLeft ? 0 : pad);
        const padRightAt = (i: number): number => (i === cols - 1 && !hasRight ? 0 : pad);
        let padSum = 0;
        for (let i = 0; i < cols; i++) padSum += padLeftAt(i) + padRightAt(i);
        const overhead =
            (hasLeft ? 1 : 0) + (hasRight ? 1 : 0) + Math.max(0, cols - 1) * (cs.v !== "" ? 1 : 0) + padSum;

        // ── 3. Sesuaikan ke anggaran lebar ──
        const budget = o.width !== undefined && o.width > 0 ? Math.floor(o.width) - indentWidth : Infinity;
        const minColWidth = o.minColWidth ?? 3;
        let widths = natural.slice();
        if (Number.isFinite(budget)) {
            const contentBudget = Math.max(cols, budget - overhead);
            widths = fitWidths(widths, contentBudget, minColWidth, o.colWidths);
            widths = stretchWidths(widths, contentBudget, o);
        }

        // ── 4. Render ──
        const cellLinesFor = (text: string, i: number): string[] =>
            wrapEnabled ? wrap(text, widths[i]) : [truncate(text.replace(/\s*\r?\n\s*/g, " "), widths[i], ellipsis)];

        const out: string[] = [];

        const ruleLine = (left: string, mid: string, right: string, painter: (t: string) => string): string => {
            let s = painter(left);
            for (let i = 0; i < cols; i++) {
                if (i > 0) s += painter(mid);
                const seg = padLeftAt(i) + widths[i] + padRightAt(i);
                s += painter(cs.h.repeat(Math.max(0, seg)));
            }
            s += painter(right);
            return indent + s;
        };

        const buildRow = (cells: string[][], painter: (t: string) => string): string[] => {
            const height = Math.max(1, ...cells.map((c) => c.length));
            const lines: string[] = [];
            for (let j = 0; j < height; j++) {
                let s = hasLeft ? pBorder(cs.v) : "";
                for (let i = 0; i < cols; i++) {
                    if (i > 0) s += pBorder(cs.v);
                    const raw = cells[i]?.[j] ?? "";
                    const aligned = alignText(raw, widths[i], aligns[i]);
                    const padded = " ".repeat(padLeftAt(i)) + aligned + " ".repeat(padRightAt(i));
                    s += painter(padded);
                }
                if (hasRight) s += pBorder(cs.v);
                lines.push(indent + s);
            }
            return lines;
        };

        if (cs.top !== false && cs.h !== "") {
            out.push(ruleLine(cs.tl, cs.mt, cs.tr, pBorder));
        }

        if (normHead) {
            out.push(
                ...buildRow(
                    normHead.map((t, i) => cellLinesFor(t, i)),
                    pHead,
                ),
            );
            if (o.headSeparator !== false && cs.h !== "") {
                out.push(ruleLine(cs.ml, cs.mm, cs.mr, pDivider));
            }
        }

        for (const row of normBody) {
            if (row === null) {
                if (cs.h !== "") out.push(ruleLine(cs.ml, cs.mm, cs.mr, pDivider));
                continue;
            }
            out.push(
                ...buildRow(
                    row.map((t, i) => cellLinesFor(t, i)),
                    pBody,
                ),
            );
        }

        if (cs.bottom !== false && cs.h !== "") {
            out.push(ruleLine(cs.bl, cs.mb, cs.br, pBorder));
        }

        return out;
    }

    /**
     * Render & cetak ke TTY lewat `std.print()`.
     *
     * Lebar otomatis diambil dari `std.getScreenInfo()` (syscall `SCREEN_INFO` →
     * `TIOCGWINSZ`) minus 1 sel, supaya baris tidak mengenai tepi layar.
     * Kalau syscall gagal, jatuh ke 80 kolom.
     */
    public async print(std: TableStdLike, opts: { width?: number; newline?: boolean } = {}): Promise<string> {
        let width = opts.width;
        if (width === undefined) {
            try {
                const info = await std.getScreenInfo();
                const columns = Number(info?.columns);
                if (Number.isFinite(columns) && columns > 0) width = columns - 1;
            } catch {
                // SCREEN_INFO tidak tersedia (mis. bukan TTY) → pakai fallback di bawah
            }
        }
        const text = this.render(width !== undefined ? { width } : undefined);
        await std.print(opts.newline === false ? text : text + "\n");
        return text;
    }
}

/** Render tabel sekali pakai tanpa membuat instance. */
export function renderTable(
    head: readonly Cell[],
    rows: ReadonlyArray<readonly Cell[]>,
    options: TableOptions = {},
): string {
    return new Table({ ...options, head }).addRows(rows).render();
}

/** Versi async `renderTable()` — lebar diambil dari TTY. */
export async function printTable(
    std: TableStdLike,
    head: readonly Cell[],
    rows: ReadonlyArray<readonly Cell[]>,
    options: TableOptions = {},
): Promise<string> {
    const table = new Table({ ...options, head }).addRows(rows);
    return await table.print(std);
}

/** Re-export agar app cukup import dari satu tempat. */
export type { Color, PaintOptions, Modifier } from "./ansiLib";
