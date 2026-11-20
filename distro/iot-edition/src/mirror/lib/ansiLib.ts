/**
 * ansiLib.ts — Primitif ANSI (SGR) + pengukuran lebar yang SETIA ke TTY TSIX.
 *
 * Kenapa lib ini ada, padahal di npm sudah ada `chalk` / `picocolors` /
 * `string-width`?
 *
 *  1. **Lebar kolom harus cocok dengan TTY TSIX**, bukan dengan "true width"
 *     Unicode. `TTY.putChar()` (src/kernel/tty/TTY.ts) menulis SATU SEL per
 *     **code unit UTF-16** dan menaikkan `cursorX` sebanyak 1. Jadi:
 *       - CSI/SGR (`\x1b[...m`)   → 0 kolom (di-skip oleh `TTY.write`)
 *       - karakter BMP            → 1 kolom (termasuk CJK & box-drawing)
 *       - emoji / surrogat pair   → 2 kolom (dua code unit)
 *     `string-width` npm menghitung CJK & emoji = 2 kolom → tabel akan MIRING
 *     di TSIX (kecuali emoji, yang kebetulan sama). `displayWidth()` di sini
 *     mengikuti perilaku TTY persis.
 *
 *  2. **Zero-dependency.** Semua isi `/lib` di-pre-compile kernel dan dikirim
 *     ke SETIAP worker lewat `workerData` (lihat `Kernel.rebuildVFSCache`) —
 *     menambah paket npm ke `/lib` = membebani tiap proses. Lib ini murni
 *     string/Number, tanpa import apa pun.
 *
 *  3. **Hanya subset ANSI yang aman.** `TTY.handleANSI()` hanya mem-parse:
 *     SGR `m`, `J`, `K`, `A/B/C/D`, `H/f`, `S/T`, `L/M`, `s/u`. Helper di sini
 *     HANYA menghasilkan SGR (`\x1b[..m`) dan `\x1b[K`, supaya tidak ada byte
 *     escape yang muncul sebagai sampah di layar.
 *
 * ── USAGE (aplikasi userland) ──
 *   import { paint, tone, displayWidth, padEnd } from "@tsix/ansiLib";
 *
 *   await std.print(paint("Halo", { fg: "brightgreen", bold: true }) + "\n");
 *   await std.print(tone.danger("GAGAL") + " koneksi terputus\n");
 *   await std.print(paint("jingga", "#ff8800") + "\n");  // truecolor
 *   await std.print(paint("208", 208) + "\n");           // xterm-256
 *
 * Menonaktifkan warna (mis. output untuk file / LCD monokrom):
 *   import { setColorEnabled, detectColor } from "@tsix/ansiLib";
 *   setColorEnabled(false);
 *   // atau dari environment (pola NO_COLOR standar):
 *   setColorEnabled(detectColor({
 *     TERM: await shell.getenv("TERM"),
 *     NO_COLOR: await shell.getenv("NO_COLOR"),
 *   }));
 *
 * ── CATATAN ──
 * `displayWidth()` sengaja BUKAN `string-width`: jangan pakai lib ini untuk
 * mengukur teks di GUI/browser — untuk itu pakai CSS. Lib ini mengukur
 * "berapa sel yang akan dipakai TTY TSIX".
 */

// ────────────────────────────────────────────────────────────────────────────
// Tipe dasar
// ────────────────────────────────────────────────────────────────────────────

/** Warna: nama (`"red"`, `"brightcyan"`), index xterm-256 (0..255), atau truecolor. */
export type Color = number | string | readonly [number, number, number];

/** Atribut SGR non-warna. */
export type Modifier = "bold" | "dim" | "italic" | "underline" | "blink" | "inverse" | "hidden" | "strike";

export interface PaintOptions {
    fg?: Color;
    bg?: Color;
    bold?: boolean;
    dim?: boolean;
    italic?: boolean;
    underline?: boolean;
    blink?: boolean;
    inverse?: boolean;
    hidden?: boolean;
    strike?: boolean;
}

/** Overhead ANSI yang dipakai TTY TSIX (SGR + erase-line). */
export const RESET = "\x1b[0m";
export const ERASE_LINE = "\x1b[K";

const MODIFIERS: Record<Modifier, number> = {
    bold: 1,
    dim: 2,
    italic: 3,
    underline: 4,
    blink: 5,
    inverse: 7,
    hidden: 8,
    strike: 9,
};

const NAMED_COLORS: Record<string, number> = {
    black: 0,
    red: 1,
    green: 2,
    yellow: 3,
    blue: 4,
    magenta: 5,
    cyan: 6,
    white: 7,
    // 8..15 = versi terang (SGR 90..97 / 100..107)
    gray: 8,
    grey: 8,
    brightblack: 8,
    brightred: 9,
    brightgreen: 10,
    brightyellow: 11,
    brightblue: 12,
    brightmagenta: 13,
    brightcyan: 14,
    brightwhite: 15,
};

// ────────────────────────────────────────────────────────────────────────────
// Enable/disable warna
// ────────────────────────────────────────────────────────────────────────────

let colorsEnabled = true;

/** Nyalakan/matikan seluruh output ANSI dari lib ini (paint/padEnd/wrap dsb). */
export function setColorEnabled(on: boolean): void {
    colorsEnabled = on;
}

export function isColorEnabled(): boolean {
    return colorsEnabled;
}

/**
 * Deteksi warna dari environment (pola standar CLI).
 *
 * Prioritas: `FORCE_COLOR` (menang) → `NO_COLOR` → `TERM` kosong/`dumb`.
 * Nilai yang dianggap "menang" untuk FORCE_COLOR: apa pun kecuali
 * `""`/`"0"`/undefined/null.
 */
export function detectColor(env: {
    TERM?: string | null;
    NO_COLOR?: string | null;
    FORCE_COLOR?: string | null;
}): boolean {
    const force = env.FORCE_COLOR;
    if (force !== undefined && force !== null && force !== "" && force !== "0") {
        return true;
    }
    if (env.NO_COLOR !== undefined && env.NO_COLOR !== null) return false;
    const term = (env.TERM ?? "").trim().toLowerCase();
    if (term === "" || term === "dumb") return false;
    return true;
}

// ────────────────────────────────────────────────────────────────────────────
// Kode SGR
// ────────────────────────────────────────────────────────────────────────────

function clamp255(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(255, Math.round(n)));
}

function normalizeName(name: string): string {
    return name
        .trim()
        .toLowerCase()
        .replace(/[\s_-]/g, "");
}

/** `#rgb`, `#rrggbb`, atau 6 digit hex tanpa `#` → triplet RGB. */
function parseHex(text: string): [number, number, number] | null {
    const raw = text.trim().replace(/^#/, "");
    if (!/^[0-9a-fA-F]+$/.test(raw)) return null;
    if (raw.length === 3) {
        return [parseInt(raw[0] + raw[0], 16), parseInt(raw[1] + raw[1], 16), parseInt(raw[2] + raw[2], 16)];
    }
    if (raw.length === 6) {
        return [parseInt(raw.slice(0, 2), 16), parseInt(raw.slice(2, 4), 16), parseInt(raw.slice(4, 6), 16)];
    }
    return null;
}

/**
 * Ubah `Color` jadi parameter SGR (tanpa `\x1b[` dan tanpa `m`).
 * Mengembalikan `""` bila warna tidak dikenali (pemanggil mengabaikannya).
 */
function colorCode(c: Color, layer: "fg" | "bg"): string {
    const brightBase = layer === "bg" ? 100 : 90;
    const base = layer === "bg" ? 40 : 30;

    if (Array.isArray(c)) {
        const [r, g, b] = c;
        return `38;2;${clamp255(r)};${clamp255(g)};${clamp255(b)}`;
    }

    if (typeof c === "number") {
        if (!Number.isFinite(c)) return "";
        if (c >= 0 && c <= 7) return String(base + c);
        if (c >= 8 && c <= 15) return String(brightBase + (c - 8));
        if (c >= 16 && c <= 255) return `${layer === "bg" ? 48 : 38};5;${c}`;
        // Di luar jangkauan → jepit ke 255 (lebih baik daripada diam-diam salah)
        return `${layer === "bg" ? 48 : 38};5;255`;
    }

    const text = String(c).trim();
    if (text === "") return "";
    if (/^\d+$/.test(text)) return colorCode(parseInt(text, 10), layer);

    const hex = parseHex(text);
    if (hex) return `38;2;${hex[0]};${hex[1]};${hex[2]}`;

    const idx = NAMED_COLORS[normalizeName(text)];
    if (idx === undefined) return "";
    return idx < 8 ? String(base + idx) : String(brightBase + (idx - 8));
}

/**
 * Bungkus `text` dengan SGR. Menerima dua bentuk:
 *
 *   paint("x", { fg: "red", bold: true })
 *   paint("x", ["red", "bold"])              // urutan bebas
 *   paint("x", [208, "underline"])
 */
export function paint(text: string, options?: PaintOptions | ReadonlyArray<Color | Modifier>): string {
    if (!colorsEnabled || text === "" || options === undefined) return text;

    const codes: string[] = [];

    if (Array.isArray(options)) {
        for (const item of options as ReadonlyArray<Color | Modifier>) {
            if (typeof item === "string" && MODIFIERS[item as Modifier] !== undefined) {
                codes.push(String(MODIFIERS[item as Modifier]));
            } else {
                codes.push(colorCode(item as Color, "fg"));
            }
        }
    } else {
        const o = options as PaintOptions;
        for (const m of Object.keys(MODIFIERS) as Modifier[]) {
            if (o[m]) codes.push(String(MODIFIERS[m]));
        }
        if (o.fg !== undefined) codes.push(colorCode(o.fg, "fg"));
        if (o.bg !== undefined) codes.push(colorCode(o.bg, "bg"));
    }

    const clean = codes.filter((c) => c !== "");
    if (clean.length === 0) return text;
    return `\x1b[${clean.join(";")}m${text}${RESET}`;
}

/**
 * Palet semantik CLI — supaya seluruh aplikasi TSIX memakai warna yang sama.
 * Setiap entri adalah fungsi (dipanggil saat render, jadi ikut `setColorEnabled`).
 */
export const tone = {
    title: (t: string) => paint(t, { bold: true, fg: "brightwhite" }),
    accent: (t: string) => paint(t, { fg: "brightcyan" }),
    success: (t: string) => paint(t, { fg: "brightgreen" }),
    danger: (t: string) => paint(t, { fg: "brightred" }),
    warning: (t: string) => paint(t, { fg: "brightyellow" }),
    info: (t: string) => paint(t, { fg: "brightblue" }),
    muted: (t: string) => paint(t, { dim: true }),
    label: (t: string) => paint(t, { dim: true }),
    value: (t: string) => paint(t, { bold: true }),
} as const;

// ────────────────────────────────────────────────────────────────────────────
// Lebar & pemotongan teks (ANSI-aware, setia ke TTY TSIX)
// ────────────────────────────────────────────────────────────────────────────

/** Posisi setelah byte final CSI (0x40..0x7E), atau akhir string. */
function csiEnd(text: string, start: number): number {
    let j = start + 2;
    while (j < text.length) {
        const code = text.charCodeAt(j);
        if (code >= 0x40 && code <= 0x7e) return j + 1;
        j++;
    }
    return text.length;
}

/** Token teks: `w` = jumlah sel yang dipakai TTY (0 untuk ANSI). */
interface Token {
    raw: string;
    w: number;
}

function tokenize(text: string): Token[] {
    const out: Token[] = [];
    let i = 0;
    while (i < text.length) {
        const ch = text[i];

        if (ch === "\x1b" && text[i + 1] === "[") {
            const end = csiEnd(text, i);
            out.push({ raw: text.slice(i, end), w: 0 });
            i = end;
            continue;
        }

        const code = text.codePointAt(i)!;
        if (code > 0xffff) {
            // Surrogate pair: TTY menulis 2 code unit → 2 sel. Dijaga utuh
            // supaya pemotongan tidak menghasilkan surrogat yatim.
            out.push({ raw: text.slice(i, i + 2), w: 2 });
            i += 2;
            continue;
        }

        if (ch === "\n" || ch === "\r") {
            out.push({ raw: ch, w: 0 });
            i += 1;
            continue;
        }

        out.push({ raw: ch, w: 1 });
        i += 1;
    }
    return out;
}

/**
 * Lebar tampilan menurut TTY TSIX (jumlah sel), bukan `string-width`.
 * ANSI = 0, LF/CR = 0, karakter lain = 1 per code unit, emoji = 2.
 */
export function displayWidth(text: string): number {
    let w = 0;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === "\x1b" && text[i + 1] === "[") {
            i = csiEnd(text, i);
            continue;
        }
        if (ch === "\n" || ch === "\r") {
            i += 1;
            continue;
        }
        const code = text.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
            const next = text.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                w += 2;
                i += 2;
                continue;
            }
        }
        w += 1;
        i += 1;
    }
    return w;
}

/** Buang seluruh escape CSI dari teks. */
export function stripAnsi(text: string): string {
    let out = "";
    let i = 0;
    while (i < text.length) {
        if (text[i] === "\x1b" && text[i + 1] === "[") {
            i = csiEnd(text, i);
            continue;
        }
        out += text[i];
        i += 1;
    }
    return out;
}

/** true bila masih ada SGR yang belum di-reset (dipakai saat memotong). */
function hasOpenSgr(text: string): boolean {
    let open = 0;
    const re = /\x1b\[([0-9;]*)m/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const params = m[1];
        if (params === "" || params === "0") open = 0;
        else open += 1;
    }
    return open > 0;
}

function repeatFill(fill: string, n: number): string {
    if (n <= 0) return "";
    if (fill === "") return " ".repeat(n);
    return fill.repeat(Math.ceil(n / fill.length)).slice(0, n);
}

/** Ambil `width` sel pertama (ANSI tetap ikut, tapi tidak menambah lebar). */
export function takeWidth(text: string, width: number): string {
    if (width <= 0) return "";
    let out = "";
    let used = 0;
    for (const t of tokenize(text)) {
        if (t.w === 0) {
            out += t.raw;
            continue;
        }
        if (used + t.w > width) break;
        out += t.raw;
        used += t.w;
    }
    return out;
}

/**
 * Potong teks ke `width` sel. Aman untuk teks ber-ANSI: SGR yang masih
 * terbuka ditutup dengan RESET sebelum elipsis, jadi warna tidak "bocor".
 */
export function truncate(text: string, width: number, ellipsis = "…"): string {
    if (width <= 0) return "";
    if (displayWidth(text) <= width) return text;

    const ellipsisW = displayWidth(ellipsis);
    const budget = width - ellipsisW;
    if (budget <= 0) return takeWidth(text, width);

    const kept = takeWidth(text, budget);
    return (hasOpenSgr(kept) ? kept + RESET : kept) + ellipsis;
}

/** Pad ke kanan sampai `width` sel (ANSI tidak dihitung). */
export function padEnd(text: string, width: number, fill = " "): string {
    const gap = width - displayWidth(text);
    if (gap <= 0) return text;
    return text + repeatFill(fill, gap);
}

/** Pad ke kiri sampai `width` sel. */
export function padStart(text: string, width: number, fill = " "): string {
    const gap = width - displayWidth(text);
    if (gap <= 0) return text;
    return repeatFill(fill, gap) + text;
}

/** Penengahan (kelebihan 1 sel jatuh ke kanan, seperti `padStart`+`padEnd`). */
export function center(text: string, width: number, fill = " "): string {
    const gap = width - displayWidth(text);
    if (gap <= 0) return text;
    const left = Math.floor(gap / 2);
    return repeatFill(fill, left) + text + repeatFill(fill, gap - left);
}

interface Chunk {
    raw: string;
    w: number;
    space: boolean;
    tokens: Token[];
}

/** Pecah jadi potongan kata & spasi (spasi = U+0020 saja, agar cocok TTY). */
function splitChunks(text: string): Chunk[] {
    const chunks: Chunk[] = [];
    let word: Token[] = [];
    let wordRaw = "";
    let wordW = 0;
    let space: Token[] = [];
    let spaceRaw = "";
    let spaceW = 0;

    const flushWord = () => {
        if (word.length === 0) return;
        chunks.push({ raw: wordRaw, w: wordW, space: false, tokens: word });
        word = [];
        wordRaw = "";
        wordW = 0;
    };
    const flushSpace = () => {
        if (space.length === 0) return;
        chunks.push({ raw: spaceRaw, w: spaceW, space: true, tokens: space });
        space = [];
        spaceRaw = "";
        spaceW = 0;
    };

    for (const t of tokenize(text)) {
        if (t.w === 1 && t.raw === " ") {
            flushWord();
            space.push(t);
            spaceRaw += t.raw;
            spaceW += t.w;
        } else {
            flushSpace();
            word.push(t);
            wordRaw += t.raw;
            wordW += t.w;
        }
    }
    flushWord();
    flushSpace();
    return chunks;
}

/** Paksa pecah kata yang lebih panjang dari `width` (menghasilkan >= 1 baris). */
function hardSplit(tokens: Token[], width: number): string[] {
    const out: string[] = [];
    let cur = "";
    let curW = 0;
    for (const t of tokens) {
        if (t.w === 0) {
            cur += t.raw;
            continue;
        }
        if (curW + t.w > width && curW > 0) {
            out.push(cur);
            cur = "";
            curW = 0;
        }
        cur += t.raw;
        curW += t.w;
    }
    out.push(cur);
    return out;
}

/**
 * Word-wrap ANSI-aware. `\n` di dalam teks = baris paksa (selalu dihormati).
 * Selalu mengembalikan minimal satu baris.
 */
export function wrap(text: string, width: number): string[] {
    if (width <= 0) return [text];

    const lines: string[] = [];
    const paragraphs = text.split("\n");

    for (const paragraph of paragraphs) {
        let line: string[] = [];
        let lineW = 0;
        let pending = "";
        let pendingW = 0;

        const flushLine = () => {
            lines.push(line.join(""));
            line = [];
            lineW = 0;
            pending = "";
            pendingW = 0;
        };

        for (const chunk of splitChunks(paragraph)) {
            if (chunk.space) {
                if (line.length > 0) {
                    pending = chunk.raw;
                    pendingW = chunk.w;
                }
                continue;
            }

            if (chunk.w <= width) {
                if (line.length > 0 && lineW + pendingW + chunk.w > width) flushLine();
                if (line.length === 0) {
                    pending = "";
                    pendingW = 0;
                }
                if (line.length > 0 && pending !== "") {
                    line.push(pending);
                    lineW += pendingW;
                }
                pending = "";
                pendingW = 0;
                line.push(chunk.raw);
                lineW += chunk.w;
                continue;
            }

            // Kata lebih panjang dari lebar kolom → potong paksa.
            if (line.length > 0) flushLine();
            const pieces = hardSplit(chunk.tokens, width);
            for (let i = 0; i < pieces.length - 1; i++) lines.push(pieces[i]);
            line = [pieces[pieces.length - 1]];
            lineW = displayWidth(line[0]);
        }

        if (line.length > 0) lines.push(line.join(""));
        else if (paragraph === "") lines.push("");
    }

    return lines.length > 0 ? lines : [""];
}

// ────────────────────────────────────────────────────────────────────────────
// Helper komposisi cepat (dipakai tableLib, tapi berguna juga untuk app)
// ────────────────────────────────────────────────────────────────────────────

/** Gabung baris dengan `sep` + jaga agar `\r`/`\n` di dalam tetap utuh. */
export function joinLines(lines: ReadonlyArray<string>, sep = "\n"): string {
    return lines.join(sep);
}

/** Gambar garis horizontal `n` sel (mis. `"─".repeat(12)`). */
export function rule(n: number, char = "─"): string {
    return char.repeat(Math.max(0, n));
}
