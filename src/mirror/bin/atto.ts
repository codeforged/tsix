import { IProgram, OSContext } from "../lib/IProgram";

/**
 * ATTO Text Editor
 * Ported from NOS for TSIX.
 * Robust implementation matching texteditor.js logic.
 */

interface EditorState {
    lines: string[];
    cursorX: number;
    cursorY: number;
    offsetX: number;
    offsetY: number;
    monoPos: number;
}

// ================================================================
// SYNTAX HIGHLIGHTING (TypeScript / JavaScript)
// Warna pakai ANSI zero-width — aman, tidak menggeser kursor/posisi.
// ================================================================
// COLOR CODE:
// 30–37	hitam, merah, hijau, kuning, biru, magenta, cyan, putih
// 90–97	versi terang (abu, merah terang, ...)
// 38;5;N	256-color (0–255)
// 38;2;r;g;b	truecolor
// ================================================================
// SYNTAX HIGHLIGHTING (TypeScript / JavaScript)
// Warna pakai ANSI zero-width — aman, tidak menggeser kursor/posisi.
// Tema bisa dikonfigurasi di /etc/atto.json (default + per-language).
// ================================================================
interface StatusBarTheme {
    fg: string; // warna teks (SGR foreground, mis. "30")
    bg: string; // warna background (SGR background, mis. "47")
}

interface SyntaxTheme {
    keyword: string;
    string: string;
    comment: string;
    number: string;
    type: string;
    statusBar: StatusBarTheme;
}

const DEFAULT_THEME: SyntaxTheme = {
    keyword: "34", // biru
    string: "32", // hijau
    comment: "90", // abu redup
    number: "33", // kuning
    type: "36", // cyan
    statusBar: { fg: "30", bg: "47" }, // teks hitam di background putih
};

/** Bungkus teks dengan warna ANSI SGR + reset (zero-width) */
function tint(code: string, s: string): string {
    return `\x1b[${code}m${s}\x1b[0m`;
}

/** Normalisasi nilai warna dari JSON (number/string → SGR code) */
function codeOf(v: any, fallback: string): string {
    if (typeof v === "number") return String(v);
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    return fallback;
}

/**
 * Ubah kode foreground (30-37 / 90-97) jadi background (40-47 / 100-107).
 * Biar user bisa pakai angka yang sama seperti warna teks. Yang sudah
 * berbentuk background (48;5;N, 48;2;r;g;b, dst.) dibiarkan apa adanya.
 */
function bgOf(v: any, fallback: string): string {
    const code = codeOf(v, fallback);
    const n = parseInt(code, 10);
    if (!isNaN(n) && n >= 30 && n <= 37) return String(n + 10);
    if (!isNaN(n) && n >= 90 && n <= 97) return String(n + 10);
    return code;
}

// Daftar default keyword/builtin per bahasa (bisa di-override di /etc/atto.json)
const LANG_KEYWORDS: Record<string, string[]> = {
    typescript: [
        "const", "let", "var", "function", "return", "if", "else", "for", "while",
        "do", "switch", "case", "break", "continue", "new", "class", "extends",
        "super", "this", "throw", "try", "catch", "finally", "typeof", "instanceof",
        "in", "of", "delete", "void", "default", "import", "export", "from", "as",
        "interface", "type", "enum", "implements", "public", "private", "protected",
        "readonly", "static", "abstract", "async", "await", "yield", "get", "set",
        "namespace", "module", "declare", "is", "keyof",
    ],
    javascript: [
        "const", "let", "var", "function", "return", "if", "else", "for", "while",
        "do", "switch", "case", "break", "continue", "new", "class", "extends",
        "super", "this", "throw", "try", "catch", "finally", "typeof", "instanceof",
        "in", "of", "delete", "void", "default", "import", "export", "from",
        "async", "await", "yield", "get", "set",
    ],
};

const LANG_BUILTINS: Record<string, string[]> = {
    typescript: [
        "string", "number", "boolean", "any", "void", "unknown", "never",
        "object", "array", "symbol", "bigint", "Function", "Promise", "Date",
        "Error", "RegExp", "Map", "Set", "Array", "Object", "String", "Number",
        "Boolean", "null", "undefined", "true", "false", "NaN", "Infinity",
    ],
    javascript: [
        "Object", "Function", "Boolean", "Symbol", "Error", "Math", "JSON",
        "Array", "String", "Number", "Date", "RegExp", "Promise", "Map", "Set",
        "WeakMap", "WeakSet", "null", "undefined", "true", "false", "NaN", "Infinity",
    ],
};

function detectLang(filename: string): string {
    const m = /\.([a-z0-9]+)$/i.exec(filename || "");
    const ext = (m && m[1] || "").toLowerCase();
    if (["ts", "tsx", "mts", "cts"].includes(ext)) return "typescript";
    if (["js", "jsx", "mjs", "cjs"].includes(ext)) return "javascript";
    return "";
}

function highlightJS(
    line: string,
    t: SyntaxTheme,
    keywords: Set<string>,
    builtins: Set<string>,
    inBlockStart: boolean,
    from: number,
    to: number
): string {
    const out: string[] = [];
    const n = line.length;
    const end = Math.min(n, to);

    // --- Fase 1: scan sampai `from` biar tahu state di titik potong slice ---
    // (string terbuka? di dalam block comment? ketabrak // ?). Ini bikin slicing
    // horizontal tidak salah warna.
    let i = 0;
    let inBlock = inBlockStart;
    let inString: string | null = null;
    let lineComment = false;
    while (i < from && i < n) {
        const c = line[i];
        const next = line[i + 1];
        if (inString) {
            if (c === "\\") { i += 2; continue; }
            if (c === inString) inString = null;
            i++;
            continue;
        }
        if (inBlock) {
            if (c === "*" && next === "/") { inBlock = false; i += 2; continue; }
            i++;
            continue;
        }
        if (c === "'" || c === '"' || c === "`") { inString = c; i++; continue; }
        if (c === "/" && next === "/") { lineComment = true; break; }
        if (c === "/" && next === "*") { inBlock = true; i += 2; continue; }
        i++;
    }

    // --- Fase 2: highlight bagian visible [from, end) ---
    // Sisa baris sesudah // → semua comment
    if (lineComment) {
        out.push(tint(t.comment, line.slice(from, end)));
        return out.join("");
    }
    // Mulai di tengah string yang dibuka sebelum `from`
    if (inString) {
        let j = from;
        while (j < end) {
            if (line[j] === "\\") { j += 2; continue; }
            if (line[j] === inString) { j++; break; }
            j++;
        }
        out.push(tint(t.string, line.slice(from, j)));
        i = j;
        inString = null;
    }
    // Mulai di tengah komentar blok (bintang-slash) dari baris sebelumnya
    else if (inBlock) {
        const close = line.indexOf("*/", from);
        if (close !== -1 && close + 2 <= end) {
            out.push(tint(t.comment, line.slice(from, close + 2)));
            i = close + 2;
            inBlock = false;
        } else {
            // Belum ketutup di area visible → seluruh slice = comment
            out.push(tint(t.comment, line.slice(from, end)));
            return out.join("");
        }
    }

    while (i < end) {
        const c = line[i];
        const next = line[i + 1];

        // Komentar // → sampai akhir baris
        if (c === "/" && next === "/") {
            out.push(tint(t.comment, line.slice(i, end)));
            break;
        }
        // Komentar blok /* ... */ (satu baris) atau /* ... sampai akhir
        if (c === "/" && next === "*") {
            const close = line.indexOf("*/", i + 2);
            if (close !== -1 && close + 2 <= end) {
                out.push(tint(t.comment, line.slice(i, close + 2)));
                i = close + 2;
                continue;
            }
            // Tidak ketutup di baris ini → comment sampai akhir area visible.
            // Kelanjutannya diwarnai baris berikutnya lewat inBlockStart.
            out.push(tint(t.comment, line.slice(i, end)));
            break;
        }
        // String ' " `
        if (c === "'" || c === '"' || c === "`") {
            let j = i + 1;
            while (j < end) {
                if (line[j] === "\\") { j += 2; continue; }
                if (line[j] === c) { j++; break; }
                j++;
            }
            out.push(tint(t.string, line.slice(i, j)));
            i = j;
            continue;
        }
        // Angka (desimal, hex, biner, oktal, float)
        if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(next))) {
            let j = i;
            if (c === "0" && /[xXbBoO]/.test(next)) {
                j = i + 2;
                while (j < end && /[0-9a-fA-F_]/.test(line[j])) j++;
            } else {
                j = i;
                while (j < end) {
                    const ch = line[j];
                    if (/[0-9]/.test(ch) || ch === "." || ch === "_") { j++; continue; }
                    if (ch === "e" || ch === "E") {
                        let k = j + 1;
                        if (line[k] === "+" || line[k] === "-") k++;
                        if (/[0-9]/.test(line[k] || "")) { j = k + 1; continue; }
                        break;
                    }
                    break;
                }
            }
            out.push(tint(t.number, line.slice(i, j)));
            i = j;
            continue;
        }
        // Identifier / keyword / tipe
        if (/[A-Za-z_$]/.test(c)) {
            let j = i;
            while (j < end && /[A-Za-z0-9_$]/.test(line[j])) j++;
            const word = line.slice(i, j);
            if (keywords.has(word)) out.push(tint(t.keyword, word));
            else if (builtins.has(word)) out.push(tint(t.type, word));
            else out.push(word);
            i = j;
            continue;
        }
        // Karakter lain
        out.push(c);
        i++;
    }
    return out.join("");
}

class SimpleTextEditor {
    public lines: string[];
    public cursorX: number = 0;
    public cursorY: number = 0;
    public offsetX: number = 0;
    public offsetY: number = 0;

    // Added properties for selection and clipboard
    private selectionActive: boolean = false;
    private selectionStart: { line: number; col: number } | null = null;
    private selectionEnd: { line: number; col: number } | null = null;
    private clipboard: string = "";
    public monoPos: number = 0;
    public screenWidth: number = 80;
    public screenHeight: number = 23;
    public changed: boolean = false;
    public filename: string;
    private os: OSContext;
    private lang: string = ""; // "typescript" | "javascript" | ""
    private syntaxTheme: SyntaxTheme = { ...DEFAULT_THEME };
    private langKeywords: Set<string> = new Set();
    private langBuiltins: Set<string> = new Set();

    private originalLines: string[] = [];

    // Search & Replace state
    public findMode: boolean = false;
    private findText: string = "";
    private replaceMode: boolean = false;
    private replaceText: string = "";
    private findResults: { line: number, col: number, length: number }[] = [];
    private findCurrentIndex: number = -1;
    private findStep: "find" | "replace" | "confirm" = "find";

    private undoStack: EditorState[] = [];
    private redoStack: EditorState[] = [];
    private maxHistorySize: number = 50;
    private lastEditLine: number = -1;
    private lastEditCol: number = -1;

    // Line number gutter — lebar mengikuti jumlah baris total
    public get numWidth(): number {
        return String(this.lines.length).length; // <10 → 1, <100 → 2, dst
    }
    /** Lebar area teks = kolom terminal minus gutter + separator (1 spasi) */
    public get textWidth(): number {
        return Math.max(1, this.screenWidth - this.numWidth - 1);
    }
    private lastNumWidth: number = 1;


    constructor(content: string, os: OSContext, filename: string) {
        this.os = os;
        this.filename = filename;
        this.lang = detectLang(filename);
        this.langKeywords = new Set(LANG_KEYWORDS[this.lang] || []);
        this.langBuiltins = new Set(LANG_BUILTINS[this.lang] || []);
        // Strip carriage returns and expand tabs
        const safeContent = (content || "").toString();
        const cleanedContent = safeContent.replace(/\r/g, "").replace(/\t/g, "  ");
        this.lines = cleanedContent ? cleanedContent.split("\n") : [""];
        this.originalLines = [...this.lines];
    }

    public async init() {
        // Read from environment variables if possible
        const envLines = parseInt(await this.os.shell.getenv("LINES") || "24");
        const envColumns = parseInt(await this.os.shell.getenv("COLUMNS") || "80");

        const screen = await this.os.std.getScreenInfo() || { lines: envLines, columns: envColumns };
        this.screenWidth = screen.columns;
        this.screenHeight = screen.lines - 1; // Reserve 1 for status bar
        this.lastNumWidth = this.numWidth;

        // Listen for window resize signal
        this.os.shell.onSignal("SIGWINCH", async () => {
            const envLines = parseInt(await this.os.shell.getenv("LINES") || "24");
            const envColumns = parseInt(await this.os.shell.getenv("COLUMNS") || "80");
            const newScreen = await this.os.std.getScreenInfo() || { lines: envLines, columns: envColumns };
            this.screenWidth = newScreen.columns;
            this.screenHeight = newScreen.lines - 1;
            await this.render();
        });

        // Listen for IPC resize (from pixelterm via pipe-based terminal)
        const lib = (global as any)._tsixLib;
        if (lib?.onEvent) {
            lib.onEvent("ipc_message", async (msg: any) => {
                const data = msg?.data || msg;
                if (data?.type === "RESIZE") {
                    this.screenWidth = data.columns || this.screenWidth;
                    this.screenHeight = data.lines ? (data.lines - 1) : this.screenHeight;
                    await this.render();
                }
            });
        }

        // Listen for SIGINT (Ctrl+C) - Just the claim to prevent default exit
        this.os.shell.onSignal("SIGINT", async () => {
            // Signal received, we rely on the character \u0003 appearing in stdin
            // which is pushed by KeyboardDevice.
        });

        // Load tema syntax dari /etc/atto.json
        await this.loadSyntaxTheme();

        // Disable Line Wrapping for perfect TUI positioning
        await this.write("\x1b[?7l");
    }

    /**
     * RENDER UI
     */
    private async write(text: string) {
        await this.os.fs.write(1, text);
    }

    /**
     * Hitung per baris: apakah baris DIMULAI di dalam komentar blok
     * (slash-bintang ... bintang-slash). Dipakai highlighter untuk mewarnai
     * komentar multi-baris dengan benar.
     */
    private computeBlockCommentStarts(): boolean[] {
        const states: boolean[] = [];
        let inBlock = false;
        for (const line of this.lines) {
            states.push(inBlock);
            const n = line.length;
            let i = 0;
            while (i < n) {
                const c = line[i];
                const next = line[i + 1];
                if (inBlock) {
                    if (c === "*" && next === "/") { inBlock = false; i += 2; continue; }
                    i++;
                    continue;
                }
                if (c === "'" || c === '"' || c === "`") {
                    let j = i + 1;
                    while (j < n) {
                        if (line[j] === "\\") { j += 2; continue; }
                        if (line[j] === c) { j++; break; }
                        j++;
                    }
                    i = j;
                    continue;
                }
                if (c === "/" && next === "/") break; // komentar baris → abaikan sisanya
                if (c === "/" && next === "*") { inBlock = true; i += 2; continue; }
                i++;
            }
        }
        return states;
    }

    /** Syntax highlight TS/JS — warna ANSI zero-width (tema dari /etc/atto.json) */
    private highlightLine(line: string, inBlockStart: boolean, sliceStart: number, sliceEnd: number): string {
        if (this.lang !== "typescript" && this.lang !== "javascript") return line.slice(sliceStart, sliceEnd);
        return highlightJS(line, this.syntaxTheme, this.langKeywords, this.langBuiltins, inBlockStart, sliceStart, sliceEnd);
    }

    /** Load tema warna syntax dari /etc/atto.json (default + per-language override) */
    private async loadSyntaxTheme() {
        const theme: SyntaxTheme = { ...DEFAULT_THEME };
        try {
            const fd = await this.os.fs.open("/etc/atto.json");
            if (fd !== null) {
                const raw = await this.os.fs.read(fd);
                await this.os.fs.close(fd);
                if (raw) {
                    const cfg = JSON.parse(String(raw));
                    const apply = (o: any) => {
                        if (!o || typeof o !== "object") return;
                        if (o.keyword) theme.keyword = codeOf(o.keyword, theme.keyword);
                        if (o.string) theme.string = codeOf(o.string, theme.string);
                        if (o.comment) theme.comment = codeOf(o.comment, theme.comment);
                        if (o.number) theme.number = codeOf(o.number, theme.number);
                        if (o.type) theme.type = codeOf(o.type, theme.type);
                        if (o.statusBar && typeof o.statusBar === "object") {
                            const sb = { ...theme.statusBar };
                            if (o.statusBar.fg) sb.fg = codeOf(o.statusBar.fg, sb.fg);
                            if (o.statusBar.bg) sb.bg = bgOf(o.statusBar.bg, sb.bg);
                            theme.statusBar = sb;
                        }
                    };
                    apply(cfg.default); // base
                    const lc = cfg[this.lang];
                    apply(lc); // override warna sesuai bahasa
                    // Override daftar keyword/builtin per bahasa
                    if (lc) {
                        if (Array.isArray(lc.keywords)) this.langKeywords = new Set(lc.keywords.map(String));
                        if (Array.isArray(lc.builtins)) this.langBuiltins = new Set(lc.builtins.map(String));
                    }
                }
            }
        } catch (_) {
            /* file tidak ada / rusak → pakai default */
        }
        this.syntaxTheme = theme;
    }

    /**
     * RENDER UI
     */
    /** Rentang kolom yang terseleksi pada baris absolut `lineIdx`, atau null */
    private selectionRangeForLine(lineIdx: number): [number, number] | null {
        if (!this.selectionActive || !this.selectionStart || !this.selectionEnd) return null;
        let s = this.selectionStart;
        let e = this.selectionEnd;
        if (s.line > e.line || (s.line === e.line && s.col > e.col)) {
            const t = s; s = e; e = t;
        }
        if (lineIdx < s.line || lineIdx > e.line) return null;
        const from = lineIdx === s.line ? s.col : 0;
        const to = lineIdx === e.line ? e.col : Number.MAX_SAFE_INTEGER;
        return [from, to];
    }

    /** Render isi satu baris: gutter + teks (syntax highlight) + overlay selection */
    private renderLineContent(lineIdx: number, blockStarts: boolean[], sliceStart: number, sliceEnd: number): string {
        const line = this.lines[lineIdx] || "";
        const lineNum = String(lineIdx + 1).padStart(this.numWidth, " ");
        const sel = this.selectionRangeForLine(lineIdx);
        let text: string;
        if (sel) {
            const s = Math.max(sliceStart, sel[0]);
            const e = Math.min(sliceEnd, sel[1]);
            if (s < e) {
                const before = this.highlightLine(line, blockStarts[lineIdx] || false, sliceStart, s);
                const selected = this.highlightLine(line, blockStarts[lineIdx] || false, s, e);
                const after = this.highlightLine(line, blockStarts[lineIdx] || false, e, sliceEnd);
                // Reverse video untuk area terseleksi. Syntax highlight memakai kode
                // ANSI nol-lebar dengan reset (\x1b[0m) di tiap token, jadi setiap
                // reset di dalam area terseleksi diikuti reverse lagi agar highlight
                // tidak putus di tengah token.
                text = before + "\x1b[7m" + selected.replace(/\x1b\[0m/g, "\x1b[0m\x1b[7m") + "\x1b[27m" + after;
            } else {
                text = this.highlightLine(line, blockStarts[lineIdx] || false, sliceStart, sliceEnd);
            }
        } else {
            text = this.highlightLine(line, blockStarts[lineIdx] || false, sliceStart, sliceEnd);
        }
        return `\x1b[90m${lineNum}\x1b[0m ${text}`;
    }

    public async render() {
        const blockStarts = this.computeBlockCommentStarts();

        let output = "\x1B[?25l"; // Hide cursor
        for (let i = 0; i < this.screenHeight; i++) {
            const lineIdx = this.offsetY + i;
            output += `\x1b[${i + 1};1H\x1b[2K`;

            if (lineIdx < this.lines.length) {
                const sliceStart = this.offsetX;
                const sliceEnd = this.offsetX + this.textWidth;
                output += this.renderLineContent(lineIdx, blockStarts, sliceStart, sliceEnd);
                const line = this.lines[lineIdx];
                if (line.length > sliceEnd) {
                    output += `\x1b[${i + 1};${this.screenWidth}H→`;
                }
            } else {
                // Blue Tilde for empty lines beyond EOF
                const lineNum = String(lineIdx + 1).padStart(this.numWidth, " ");
                output += `\x1b[90m${lineNum}\x1b[0m \x1b[34m~\x1b[0m`;
            }
        }

        await this.write(output);
        await this.renderStatusBar();
        await this.renderCursorOnly();
    }

    public async renderCurrentLine() {
        // Kalau lebar gutter berubah (mis. baris nambah / numpuk), redraw penuh
        if (this.lastNumWidth !== this.numWidth) {
            this.lastNumWidth = this.numWidth;
            await this.render();
            return;
        }

        const lineIdx = this.cursorY + this.offsetY;
        const sliceStart = this.offsetX;
        const sliceEnd = this.offsetX + this.textWidth;
        const blockStarts = this.computeBlockCommentStarts();

        // Move to start of line, clear it, write gutter + text (dengan selection)
        let output = `\x1b[${this.cursorY + 1};1H\x1b[2K${this.renderLineContent(lineIdx, blockStarts, sliceStart, sliceEnd)}`;

        // Handle "→" indicator if line exceeds viewport
        const line = this.lines[lineIdx] || "";
        if (line.length > sliceEnd) {
            output += `\x1b[${this.cursorY + 1};${this.screenWidth}H→`;
        }

        await this.write(output);
        await this.renderCursorOnly();
    }

    /**
     * Salin teks terseleksi ke clipboard lalu nonaktifkan selection.
     * (Copy sebenarnya: teks utuh multi-baris dimasukkan ke clipboard.)
     */
    private finalizeSelection(): void {
        if (this.selectionActive && this.selectionStart && this.selectionEnd) {
            const start = this.selectionStart;
            const end = this.selectionEnd;
            // Pastikan start sebelum end
            let s = start, e = end;
            if (s.line > e.line || (s.line === e.line && s.col > e.col)) {
                s = end; e = start;
            }
            const lines = this.lines.slice(s.line, e.line + 1);
            if (lines.length === 1) {
                this.clipboard = lines[0].slice(s.col, e.col);
            } else {
                const first = lines[0].slice(s.col);
                const last = lines[lines.length - 1].slice(0, e.col);
                const middle = lines.slice(1, -1).join("\n");
                this.clipboard = [first, middle, last].filter(Boolean).join("\n");
            }
        }
        this.selectionActive = false;
        this.selectionStart = null;
        this.selectionEnd = null;
    }

    public async renderStatusBar() {
        if (this.findMode) {
            let prompt = "";
            let info = "";
            if (this.findResults.length > 0) {
                info = ` [${this.findCurrentIndex + 1}/${this.findResults.length}]`;
            }

            if (this.findStep === "find") prompt = `Find: ${this.findText}${info}`;
            else if (this.findStep === "replace") prompt = `Replace with: ${this.replaceText}${info}`;
            else if (this.findStep === "confirm") prompt = `Replace? (y)es (n)o (a)ll (q)uit${info}`;

            const padding = " ".repeat(Math.max(0, this.screenWidth - prompt.length));
            const sb = this.syntaxTheme.statusBar;
            await this.write(`\x1b[${this.screenHeight + 1};1H\x1b[${sb.fg}m\x1b[${sb.bg}m${prompt}${padding}\x1b[0m`);
            await this.positionCursorInternal();
            return;
        }

        const totalLines = this.lines.length;
        const currentLine = this.cursorY + this.offsetY + 1;
        const currentCol = this.cursorX + 1;
        const modified = this.changed ? " [Modified]" : "";

        const leftText = ` R:${currentLine}/${totalLines} C:${currentCol}${modified} `;
        const rightText = ` ${this.filename} `;

        let centerText = "";
        if (this.findResults.length > 0) {
            centerText = ` [Match ${this.findCurrentIndex + 1}/${this.findResults.length}] `;
        }

        const totalUsed = leftText.length + rightText.length + centerText.length;
        const totalPadding = Math.max(0, this.screenWidth - totalUsed);
        const padLeftCount = Math.floor(totalPadding / 2);
        const padLeft = " ".repeat(padLeftCount);
        const padRight = " ".repeat(totalPadding - padLeftCount);

        const sb = this.syntaxTheme.statusBar;
        const statusOutput = `\x1b[${this.screenHeight + 1};1H\x1b[${sb.fg}m\x1b[${sb.bg}m${leftText}${padLeft}${centerText}${padRight}${rightText}\x1b[0m`;
        await this.write(statusOutput);
        await this.positionCursorInternal();
    }

    /** Sinkronkan ukuran layar dari getScreenInfo — self-heal kalau sinyal resize terlewat */
    private async refreshScreenSize(): Promise<boolean> {
        try {
            const envLines = parseInt(await this.os.shell.getenv("LINES") || "24");
            const envColumns = parseInt(await this.os.shell.getenv("COLUMNS") || "80");
            const s = await this.os.std.getScreenInfo() || { lines: envLines, columns: envColumns };
            const w = s.columns || this.screenWidth;
            const h = (s.lines || this.screenHeight + 1) - 1;
            if (w !== this.screenWidth || h !== this.screenHeight) {
                this.screenWidth = w;
                this.screenHeight = h;
                return true;
            }
        } catch (_) { /* ignore */ }
        return false;
    }

    public async renderCursorOnly() {
        // Self-heal ukuran layar: kalau berubah (mis. resize terlewat sinyalnya),
        // redraw penuh biar layout & status bar selalu di posisi yang benar.
        if (await this.refreshScreenSize()) {
            await this.render();
            return;
        }
        await this.renderStatusBar();
    }

    private async positionCursorInternal() {
        if (this.findMode) {
            let cursorCol = 1;
            if (this.findStep === "find") cursorCol = 7 + this.findText.length;
            else if (this.findStep === "replace") cursorCol = 15 + this.replaceText.length;
            else if (this.findStep === "confirm") {
                const res = this.findResults[this.findCurrentIndex];
                cursorCol = Math.max(0, Math.min(this.screenWidth - 1, res.col - this.offsetX)) + 1;
                await this.write(`\x1b[${this.cursorY + 1};${cursorCol}H\x1B[?25h`);
                return;
            }
            await this.write(`\x1b[${this.screenHeight + 1};${cursorCol}H\x1B[?25h`);
            return;
        }
        const displayCursorX = Math.max(0, Math.min(this.textWidth, this.cursorX - this.offsetX));
        // Gutter (numWidth) + separator (1 spasi) + posisi teks
        await this.write(`\x1b[${this.cursorY + 1};${this.numWidth + 2 + displayCursorX}H\x1B[?25h`);
    }

    /**
     * INPUT HANDLING
     */
    public async handleKey(char: string): Promise<string | void> {
        const { std } = this.os;

        // 1. ESCAPE SEQUENCES (Arrows, Home, End, etc.)
        if (char === "\u001b") {
            // Baca karakter pertama sequence secara NON-blocking (poll), supaya
            // ESC tunggal (keluar find mode) tidak menggantung menunggu input.
            let seq1: string | null = null;
            for (let i = 0; i < 5; i++) {
                seq1 = await std.poll();
                if (seq1) break;
                await new Promise(r => setTimeout(r, 20));
            }

            if (!seq1) {
                // ESC tunggal: JANGAN mulai find mode — cukup "cuek".
                // Akhiri selection kalau sedang aktif, dan kalau sedang di dalam
                // find mode, keluarkan dari sana (ESC tetap = keluar find mode).
                const hadSelection = this.selectionActive;
                this.selectionActive = false;
                this.selectionStart = null;
                this.selectionEnd = null;
                if (this.findMode) {
                    this.findMode = false;
                    this.replaceMode = false;
                    await this.render();
                } else if (hadSelection) {
                    await this.render();
                }
                return;
            }

            if (seq1 === "[") {
                await std.getChar(); // consume [
                const seq2 = await std.getChar();

                // Tombol navigasi non-arrow: kalau sedang selection, salin lalu
                // akhiri selection biar highlight tidak tertinggal.
                const endSelection = async () => {
                    if (this.selectionActive) {
                        this.finalizeSelection();
                        await this.render();
                    }
                };

                // Home / End / PgUp / PgDn / Del / Insert
                // Catatan: untuk sequence yang diakhiri "~" (5~, 6~, 3~, 2~, 4~),
                // "~" harus dikonsumsi — kalau tidak, sisa "~" ikut diketik.
                if (seq2 === "H") { await endSelection(); this.cursorX = 0; this.monoPos = 0; if (!(await this.adjustHorizontalScroll())) await this.renderCursorOnly(); return; } // Home \x1b[H
                if (seq2 === "F") { await endSelection(); await this.jumpToEnd(); return; }   // End \x1b[F
                if (seq2 === "5") { await endSelection(); await std.getChar(); await this.pageUp(); return; }    // PgUp \x1b[5~
                if (seq2 === "6") { await endSelection(); await std.getChar(); await this.pageDown(); return; }  // PgDn \x1b[6~
                if (seq2 === "3") { await endSelection(); await std.getChar(); await this.deleteChar(); return; } // Del \x1b[3~
                if (seq2 === "2") { await endSelection(); await std.getChar(); return; } // Insert \x1b[2~ (belum ada mode insert)
                if (seq2 === "4") { await endSelection(); await std.getChar(); await this.jumpToEnd(); return; } // End \x1b[4~ (fallback)

                if (seq2 === "1") {
                    const seq3 = await std.getChar();
                    if (seq3 === ";") {
                        const seq4 = await std.getChar();
                        if (seq4 === "2") {
                            // Shift+Arrow → perluas selection
                            const seq5 = await std.getChar();
                            if (!this.selectionActive) {
                                this.selectionActive = true;
                                this.selectionStart = { line: this.cursorY + this.offsetY, col: this.cursorX };
                            }
                            if (seq5 === "A") await this.moveUp();
                            else if (seq5 === "B") await this.moveDown();
                            else if (seq5 === "C") await this.moveRight();
                            else if (seq5 === "D") await this.moveLeft();
                            if (this.selectionActive) {
                                this.selectionEnd = { line: this.cursorY + this.offsetY, col: this.cursorX };
                            }
                            await this.render();
                            return;
                        }
                        if (seq4 === "5") {
                            // Ctrl+Arrow → lompat kata / Ctrl+Home / Ctrl+End
                            const seq5 = await std.getChar();
                            if (seq5 === "C") { await this.jumpToNextWord(); return; }
                            if (seq5 === "D") { await this.jumpToPrevWord(); return; }
                            if (seq5 === "A") { for (let k = 0; k < 5; k++) await this.moveUp(); return; }
                            if (seq5 === "B") { for (let k = 0; k < 5; k++) await this.moveDown(); return; }
                            if (seq5 === "H") { await this.jumpToStartOfFile(); return; } // Ctrl+Home
                            if (seq5 === "F") { await this.jumpToEndOfFile(); return; }   // Ctrl+End
                        }
                    } else if (seq3 === "~") {
                        // Home key (fallback \x1b[1~)
                        await endSelection();
                        this.cursorX = 0; this.monoPos = 0;
                        if (!(await this.adjustHorizontalScroll())) await this.renderCursorOnly();
                        return;
                    }
                }
                // Arrow biasa
                if (seq2 === "A") { await this.moveUp(); }
                else if (seq2 === "B") { await this.moveDown(); }
                else if (seq2 === "C") { await this.moveRight(); }
                else if (seq2 === "D") { await this.moveLeft(); }
                // Kalau sebelumnya sedang selection, arrow biasa = finalize (copy)
                if (this.selectionActive) {
                    this.finalizeSelection();
                    await this.render();
                }
                return;
            } else if (seq1 === "O") {
                await std.getChar(); // consume O
                const seq2 = await std.getChar();
                if (seq2 === "P") { await this.showHelp(); return; } // F1
                if (seq2 === "H") { this.cursorX = 0; this.monoPos = 0; if (!(await this.adjustHorizontalScroll())) await this.renderCursorOnly(); return; }
                if (seq2 === "F") { await this.jumpToEnd(); return; }
            } else if (seq1 === "r") {
                await std.getChar(); // consume r
                await this.startFindMode(true);
                return;
            }

            if (this.findMode) {
                this.findMode = false;
                this.replaceMode = false;
                await this.render();
                return;
            }
            return;
        }

        // Jika selection aktif dan user menekan tombol non-arrow, salin lalu akhiri selection
        if (this.selectionActive) {
            this.finalizeSelection();
            await this.render();
        }

        // 2. SEARCH MODE INPUT
        if (this.findMode) {
            if (char === "\r" || char === "\n") {
                if (this.findStep === "find") {
                    if (this.findText) {
                        this.performFind();
                        if (this.findResults.length > 0) {
                            if (this.replaceMode) {
                                this.findStep = "replace";
                                await this.renderStatusBar();
                            } else {
                                this.findMode = false;
                                await this.jumpToResult(0);
                            }
                        } else {
                            await this.write(`\x1b[${this.screenHeight + 1};1H\x1b[41m\x1b[97m No results found for "${this.findText}" \x1b[0m\x1b[K`);
                            setTimeout(() => this.renderStatusBar(), 2000);
                        }
                    } else {
                        this.findMode = false;
                        await this.render();
                    }
                } else if (this.findStep === "replace") {
                    this.findStep = "confirm";
                    this.findCurrentIndex = 0;
                    await this.jumpToResult(0);
                }
                return;
            }

            if (this.findStep === "confirm") {
                const c = char.toLowerCase();
                if (c === "y") {
                    await this.replaceCurrent();
                    if (this.findResults.length > 0) {
                        this.findCurrentIndex %= this.findResults.length;
                        await this.jumpToResult(this.findCurrentIndex);
                    } else {
                        this.findMode = false;
                        await this.render();
                    }
                } else if (c === "n") {
                    this.findCurrentIndex = (this.findCurrentIndex + 1) % this.findResults.length;
                    await this.jumpToResult(this.findCurrentIndex);
                } else if (c === "a") {
                    await this.replaceAll();
                    this.findMode = false;
                } else if (c === "q") {
                    this.findMode = false;
                    await this.render();
                }
                return;
            }

            if (char === "\u007f" || char === "\b") {
                if (this.findStep === "find") {
                    this.findText = this.findText.slice(0, -1);
                    this.performFind();
                }
                else if (this.findStep === "replace") this.replaceText = this.replaceText.slice(0, -1);
                await this.renderStatusBar();
            } else if (char >= " ") {
                if (this.findStep === "find") {
                    this.findText += char;
                    this.performFind();
                }
                else if (this.findStep === "replace") this.replaceText += char;
                await this.renderStatusBar();
            }
            return;
        }

        // 3. GLOBAL SHORTCUTS
        if (char === "\u0001") { this.cursorX = 0; this.monoPos = 0; if (!(await this.adjustHorizontalScroll())) await this.renderCursorOnly(); return; } // Ctrl+A
        if (char === "\u0005") { await this.jumpToEnd(); return; } // Ctrl+E
        if (char === "\u0006") { await this.startFindMode(false); return; } // Ctrl+F
        if (char === "\u000c") { await this.findNext(); return; }           // Ctrl+L
        if (char === "\u0012") { await this.startFindMode(true); return; }  // Ctrl+R
        if (char === "\u000b") { await this.deleteLine(); return; }         // Ctrl+K
        if (char === "\u0013") { await this.save(); return; }               // Ctrl+S
        if (char === "\u001a") { this.undo(); await this.render(); return; } // Ctrl+Z
        if (char === "\u0019") { this.redo(); await this.render(); return; } // Ctrl+Y
        if (char === "\u0016") { // Ctrl+V (Paste)
            if (this.clipboard) {
                this.captureState();
                const lineIdx = this.cursorY + this.offsetY;
                const line = this.lines[lineIdx] || "";
                const parts = this.clipboard.split("\n");
                if (parts.length === 1) {
                    // Paste dalam satu baris
                    this.lines[lineIdx] = line.slice(0, this.cursorX) + this.clipboard + line.slice(this.cursorX);
                    this.cursorX += this.clipboard.length;
                    this.monoPos = this.cursorX;
                } else {
                    // Paste multi-baris: pecah menjadi elemen baris tersendiri.
                    // (Sebelumnya digabung jadi 1 elemen → render baris berikutnya
                    //  menimpa isi, sehingga yang terlihat hanya 1 baris.)
                    const head = line.slice(0, this.cursorX);
                    const tail = line.slice(this.cursorX);
                    const first = parts[0];
                    const last = parts[parts.length - 1];
                    const middle = parts.slice(1, -1);
                    this.lines.splice(lineIdx, 1, head + first, ...middle, last + tail);
                    this.cursorX = last.length;
                    this.monoPos = this.cursorX;
                    // Posisikan kursor di baris terakhir hasil paste (dengan scroll)
                    const absLine = lineIdx + (parts.length - 1);
                    if (absLine < this.offsetY) this.offsetY = absLine;
                    else if (absLine >= this.offsetY + this.screenHeight) this.offsetY = absLine - this.screenHeight + 1;
                    this.cursorY = absLine - this.offsetY;
                    if (this.cursorX < this.offsetX) this.offsetX = this.cursorX;
                    else if (this.cursorX >= this.offsetX + this.textWidth) this.offsetX = this.cursorX - this.textWidth + 1;
                }
                this.changed = true;
                this.checkModified();
                await this.render();
            }
            return;
        }

        if (char === "\u0017" || char === "\u0003") { // Ctrl+W or Ctrl+C: Exit
            this.checkModified();
            if (this.changed) {
                const choice = await this.askDirtyExit();
                if (choice === "save") {
                    await this.save();
                    return "exit";
                }
                if (choice === "discard") return "exit";
                // Cancel
                await this.render();
                return;
            } else {
                return "exit";
            }
        }

        // 4. REGULAR EDITING
        if (char === "\t") {
            char = "  "; // Convert tab to 2 spaces
        }

        if (char === "\r" || char === "\n") {
            this.captureState(true);
            const lineIdx = this.cursorY + this.offsetY;
            const line = this.lines[lineIdx] || "";
            this.lines.splice(lineIdx + 1, 0, line.slice(this.cursorX));
            this.lines[lineIdx] = line.slice(0, this.cursorX);
            this.cursorX = 0;
            this.offsetX = 0;
            this.monoPos = 0;
            if (this.cursorY < this.screenHeight - 1) this.cursorY++;
            else this.offsetY++;
            this.changed = true;
            this.checkModified();
            await this.render();
        } else if (char === "\u007f" || char === "\b") {
            await this.backspace();
            if (!(await this.adjustHorizontalScroll())) {
                await this.renderCurrentLine();
            }
        } else if (char >= " ") {
            this.captureState();
            const lineIdx = this.cursorY + this.offsetY;
            const line = this.lines[lineIdx] || "";
            this.lines[lineIdx] = line.slice(0, this.cursorX) + char + line.slice(this.cursorX);
            this.cursorX += char.length;
            this.changed = true;
            this.monoPos = this.cursorX;
            this.checkModified(); 
            const afterPos = this.cursorX;
            const updatedLine = this.lines[lineIdx];
            const isClose = afterPos >= 2 && updatedLine[afterPos - 2] === "*" && updatedLine[afterPos - 1] === "/";
            const isOpen = afterPos >= 2 && updatedLine[afterPos - 2] === "/" && updatedLine[afterPos - 1] === "*";
            if (isClose || isOpen) {
                await this.render();
            } else {
                if (!(await this.adjustHorizontalScroll())) {
                    await this.renderCurrentLine();
                }
            }
        }
    }

    /**
     * NAVIGATION
     */
    private async moveUp() {
        if (this.cursorY > 0) {
            this.cursorY--;
        } else if (this.offsetY > 0) {
            this.offsetY--;
            await this.render();
        }
        const line = this.lines[this.cursorY + this.offsetY] || "";
        this.cursorX = Math.min(this.monoPos, line.length);
        if (!(await this.adjustHorizontalScroll())) {
            await this.renderCursorOnly();
        }
    }

    private async moveDown() {
        if (this.cursorY < this.screenHeight - 1 && this.cursorY + this.offsetY < this.lines.length - 1) {
            this.cursorY++;
        } else if (this.offsetY + this.screenHeight < this.lines.length) {
            this.offsetY++;
            await this.render();
        }
        const line = this.lines[this.cursorY + this.offsetY] || "";
        this.cursorX = Math.min(this.monoPos, line.length);
        if (!(await this.adjustHorizontalScroll())) {
            await this.renderCursorOnly();
        }
    }

    private async moveLeft() {
        if (this.cursorX > 0) {
            this.cursorX--;
            this.monoPos = this.cursorX;
            if (!(await this.adjustHorizontalScroll())) {
                await this.renderCursorOnly();
            }
        } else if (this.cursorY + this.offsetY > 0) {
            await this.moveUp();
            this.cursorX = this.lines[this.cursorY + this.offsetY].length;
            this.monoPos = this.cursorX;
            if (!(await this.adjustHorizontalScroll())) {
                await this.render();
            }
        }
    }

    private async moveRight() {
        const line = this.lines[this.cursorY + this.offsetY] || "";
        if (this.cursorX < line.length) {
            this.cursorX++;
            this.monoPos = this.cursorX;
            if (!(await this.adjustHorizontalScroll())) {
                await this.renderCursorOnly();
            }
        } else if (this.cursorY + this.offsetY < this.lines.length - 1) {
            await this.moveDown();
            this.cursorX = 0;
            this.offsetX = 0;
            this.monoPos = 0;
            await this.render();
        }
    }

    private async jumpToHome() {
        this.cursorX = 0;
        this.offsetX = 0;
        this.monoPos = 0;
        if (!(await this.adjustHorizontalScroll())) {
            await this.renderCursorOnly();
        }
    }

    private async jumpToEnd() {
        const line = this.lines[this.cursorY + this.offsetY] || "";
        this.cursorX = line.length;
        this.monoPos = this.cursorX;
        if (!(await this.adjustHorizontalScroll())) {
            await this.render();
        }
    }

    private async pageUp() {
        this.offsetY = Math.max(0, this.offsetY - this.screenHeight);
        await this.render();
    }

    private async pageDown() {
        if (this.offsetY + this.screenHeight < this.lines.length) {
            this.offsetY = Math.min(this.lines.length - this.screenHeight, this.offsetY + this.screenHeight);
            await this.render();
        }
    }

    private async jumpToNextWord() {
        const line = this.lines[this.cursorY + this.offsetY] || "";
        if (this.cursorX >= line.length) {
            if (this.cursorY + this.offsetY < this.lines.length - 1) {
                await this.moveDown();
                this.cursorX = 0;
                this.monoPos = 0;
                await this.render();
            }
            return;
        }
        let pos = this.cursorX;
        const isAlphanum = (c: string) => /[a-zA-Z0-9]/.test(c);
        if (isAlphanum(line[pos])) {
            while (pos < line.length && isAlphanum(line[pos])) pos++;
        }
        while (pos < line.length && !isAlphanum(line[pos])) pos++;
        this.cursorX = pos;
        this.monoPos = pos;
        if (!(await this.adjustHorizontalScroll())) {
            await this.render();
        }
    }

    private async jumpToPrevWord() {
        if (this.cursorX === 0) {
            if (this.cursorY + this.offsetY > 0) {
                await this.moveUp();
                this.cursorX = this.lines[this.cursorY + this.offsetY].length;
                this.monoPos = this.cursorX;
                await this.render();
            }
            return;
        }
        const line = this.lines[this.cursorY + this.offsetY] || "";
        let pos = this.cursorX - 1;
        const isAlphanum = (c: string) => /[a-zA-Z0-9]/.test(c);
        while (pos > 0 && !isAlphanum(line[pos])) pos--;
        while (pos > 0 && isAlphanum(line[pos - 1])) pos--;
        this.cursorX = pos;
        this.monoPos = pos;
        if (!(await this.adjustHorizontalScroll())) {
            await this.render();
        }
    }

    private async jumpToStartOfFile() {
        this.cursorX = 0;
        this.cursorY = 0;
        this.offsetX = 0;
        this.offsetY = 0;
        this.monoPos = 0;
        await this.render();
    }

    private async jumpToEndOfFile() {
        this.offsetY = Math.max(0, this.lines.length - this.screenHeight);
        this.cursorY = Math.min(this.lines.length - this.offsetY - 1, this.screenHeight - 1);
        const line = this.lines[this.lines.length - 1] || "";
        this.cursorX = line.length;
        this.monoPos = this.cursorX;
        if (!(await this.adjustHorizontalScroll())) {
            await this.render();
        }
    }

    private async adjustHorizontalScroll(): Promise<boolean> {
        if (this.cursorX < this.offsetX) {
            this.offsetX = this.cursorX;
            await this.render();
            return true;
        } else if (this.cursorX >= this.offsetX + this.textWidth) {
            this.offsetX = this.cursorX - this.textWidth + 1;
            await this.render();
            return true;
        }
        return false;
    }

    /**
     * EDITING ACTIONS
     */
    private async backspace() {
        if (this.cursorX > 0) {
            this.captureState();
            const lineIdx = this.cursorY + this.offsetY;
            const line = this.lines[lineIdx];
            this.lines[lineIdx] = line.slice(0, this.cursorX - 1) + line.slice(this.cursorX);
            this.cursorX--;
            this.changed = true;
            this.monoPos = this.cursorX;
            this.checkModified();
            await this.adjustHorizontalScroll();
        } else if (this.cursorY + this.offsetY > 0) {
            this.captureState();
            const currentLineIdx = this.cursorY + this.offsetY;
            const prevLineIdx = currentLineIdx - 1;
            const prevLine = this.lines[prevLineIdx];
            this.cursorX = prevLine.length;
            this.lines[prevLineIdx] = prevLine + this.lines[currentLineIdx];
            this.lines.splice(currentLineIdx, 1);
            if (this.cursorY > 0) this.cursorY--;
            else this.offsetY--;
            this.changed = true;
            this.monoPos = this.cursorX;
            this.checkModified();
            await this.adjustHorizontalScroll();
            await this.render();
        }
    }

    private async deleteChar() {
        const lineIdx = this.cursorY + this.offsetY;
        const line = this.lines[lineIdx];
        if (this.cursorX < line.length) {
            this.captureState();
            this.lines[lineIdx] = line.slice(0, this.cursorX) + line.slice(this.cursorX + 1);
            this.changed = true;
            this.checkModified();
            await this.render();
        } else if (lineIdx < this.lines.length - 1) {
            this.captureState();
            this.lines[lineIdx] = line + this.lines[lineIdx + 1];
            this.lines.splice(lineIdx + 1, 1);
            this.changed = true;
            this.checkModified();
            await this.render();
        }
    }

    private async deleteLine() {
        this.captureState(true);
        const lineIdx = this.cursorY + this.offsetY;
        this.lines.splice(lineIdx, 1);
        if (this.lines.length === 0) this.lines = [""];
        if (lineIdx >= this.lines.length) {
            if (this.cursorY > 0) this.cursorY--;
            else if (this.offsetY > 0) this.offsetY--;
        }
        this.cursorX = 0;
        this.monoPos = 0;
        this.changed = true;
        this.checkModified();
        await this.render();
    }

    /**
     * STATE MANAGEMENT
     */
    private captureState(force: boolean = false) {
        const currLineIdx = this.cursorY + this.offsetY;
        const currCol = this.cursorX;

        if (!force) {
            if (this.lastEditLine === currLineIdx) {
                const line = this.lines[currLineIdx] || "";
                if (Math.abs(currCol - this.lastEditCol) < 2) {
                    const min = Math.min(this.lastEditCol, currCol);
                    const max = Math.max(this.lastEditCol, currCol);
                    const between = line.substring(min, max);
                    if (between.indexOf(" ") === -1 && between.indexOf("\t") === -1) return;
                }
            }
        }

        this.lastEditLine = currLineIdx;
        this.lastEditCol = currCol;

        if (this.undoStack.length >= this.maxHistorySize) this.undoStack.shift();
        this.undoStack.push({
            lines: [...this.lines],
            cursorX: this.cursorX,
            cursorY: this.cursorY,
            offsetX: this.offsetX,
            offsetY: this.offsetY,
            monoPos: this.monoPos
        });
        this.redoStack = [];
    }

    private undo() {
        if (this.undoStack.length === 0) return;
        this.redoStack.push({
            lines: [...this.lines],
            cursorX: this.cursorX,
            cursorY: this.cursorY,
            offsetX: this.offsetX,
            offsetY: this.offsetY,
            monoPos: this.monoPos
        });
        const state = this.undoStack.pop()!;
        this.lines = [...state.lines];
        this.cursorX = state.cursorX;
        this.cursorY = state.cursorY;
        this.offsetX = state.offsetX;
        this.offsetY = state.offsetY;
        this.monoPos = state.monoPos;
        this.checkModified();
    }

    private redo() {
        if (this.redoStack.length === 0) return;
        this.undoStack.push({
            lines: [...this.lines],
            cursorX: this.cursorX,
            cursorY: this.cursorY,
            offsetX: this.offsetX,
            offsetY: this.offsetY,
            monoPos: this.monoPos
        });
        const state = this.redoStack.pop()!;
        this.lines = [...state.lines];
        this.cursorX = state.cursorX;
        this.cursorY = state.cursorY;
        this.offsetX = state.offsetX;
        this.offsetY = state.offsetY;
        this.monoPos = state.monoPos;
        this.checkModified();
    }

    private checkModified() {
        if (this.lines.length !== this.originalLines.length) {
            this.changed = true;
            return;
        }
        for (let i = 0; i < this.lines.length; i++) {
            if (this.lines[i] !== this.originalLines[i]) {
                this.changed = true;
                return;
            }
        }
        this.changed = false;
    }

    /**
     * SEARCH & REPLACE
     */
    private async startFindMode(isReplace: boolean = false) {
        this.findMode = true;
        this.replaceMode = isReplace;
        this.findStep = "find";
        this.findText = "";
        this.replaceText = "";
        this.findResults = [];
        this.findCurrentIndex = -1;
        await this.renderStatusBar();
    }

    private performFind() {
        if (!this.findText) return;
        this.findResults = [];
        const isCaseSensitive = /[A-Z]/.test(this.findText);
        const searchStr = isCaseSensitive ? this.findText : this.findText.toLowerCase();

        for (let i = 0; i < this.lines.length; i++) {
            const line = (isCaseSensitive ? this.lines[i] : this.lines[i].toLowerCase());
            let pos = line.indexOf(searchStr);
            while (pos !== -1) {
                this.findResults.push({ line: i, col: pos, length: this.findText.length });
                pos = line.indexOf(searchStr, pos + 1);
            }
        }
        if (this.findResults.length > 0) {
            this.findCurrentIndex = 0;
        }
    }

    private async replaceCurrent() {
        if (this.findCurrentIndex === -1 || this.findResults.length === 0) return;
        this.captureState(true);
        const res = this.findResults[this.findCurrentIndex];
        const line = this.lines[res.line];
        this.lines[res.line] = line.slice(0, res.col) + this.replaceText + line.slice(res.col + res.length);
        this.changed = true;
        this.checkModified();

        // Re-calculate find results because positions shifted
        this.performFind();
        // Since we replaced one, we stay at same index (which is now different match)
        // or loop wraps if none left.
        if (this.findResults.length === 0) {
            this.findMode = false;
        }
    }

    private async replaceAll() {
        if (this.findResults.length === 0) return;
        this.captureState(true);
        // Reverse to maintain offsets
        for (let i = this.findResults.length - 1; i >= 0; i--) {
            const res = this.findResults[i];
            const line = this.lines[res.line];
            this.lines[res.line] = line.slice(0, res.col) + this.replaceText + line.slice(res.col + res.length);
        }
        this.changed = true;
        this.checkModified();
        await this.render();
        await this.write(`\x1b[${this.screenHeight + 1};1H\x1b[42m\x1b[30m Replaced ${this.findResults.length} occurrences. \x1b[0m\x1b[K`);
        setTimeout(() => this.renderStatusBar(), 1500);
    }

    private async findNext() {
        if (this.findResults.length === 0) return;
        this.findCurrentIndex = (this.findCurrentIndex + 1) % this.findResults.length;
        await this.jumpToResult(this.findCurrentIndex);
    }

    private async jumpToResult(index: number) {
        this.findCurrentIndex = index;
        const res = this.findResults[index];
        this.cursorX = res.col;
        this.monoPos = this.cursorX;
        const targetLine = res.line;

        if (targetLine < this.offsetY || targetLine >= this.offsetY + this.screenHeight) {
            this.offsetY = Math.max(0, targetLine - Math.floor(this.screenHeight / 2));
        }
        this.cursorY = targetLine - this.offsetY;

        await this.adjustHorizontalScroll();
        await this.render();
    }

    /**
     * PROMPTS & HELP
     */
    public async askDirtyExit(): Promise<"save" | "discard" | "cancel"> {
        const prompt = " File Modified! (S)ave, (D)iscard, (C)ancel? ";
        // Use bright Red background for high visibility
        await this.write(`\x1b[${this.screenHeight + 1};1H\x1b[41m\x1b[97m${prompt}\x1b[0m\x1b[K`);
        while (true) {
            const rawChar = await this.os.std.getChar();
            if (rawChar === null) return "discard";
            const char = rawChar.toLowerCase();
            if (char === "s") return "save";
            if (char === "d") return "discard";
            if (char === "c" || char === "\u001b") return "cancel";
            if (char === "\u0003") return "discard"; // Second Ctrl+C = discard
        }
    }

    private async showHelp() {
        const helpText = [
            "┌─────────────────────────────────────────────────────────────────────┐",
            "│                          ATTO Text Editor v1.83                     │",
            "├─────────────────────────────────────────────────────────────────────┤",
            "│ Ctrl+S: Save          │ Ctrl+F: Find     │ Ctrl+L: Find Next        │",
            "│ Ctrl+W: Save & Exit   │ Alt+R:  Replace  │ F1:     Help             │",
            "│ Shift+Arrow: Select   │ Ctrl+V: Paste    │ Ctrl+A: Start            │",
            "│ Ctrl+C: Exit          │ Ctrl+Z: Undo     │ Ctrl+E: End              │",
            "│ Ctrl+K: Delete Line   │ Ctrl+Y: Redo     │ Ctrl+←/→: Word           │",
            "│ Home: Begin of Col    │ End: End of Col  │ Ctrl+Home: Begin of file │",
            "│ Ctrl+End: End of file │ PgUp: Page Up    │ PgDn: Page Down          │",
            "├─────────────────────────────────────────────────────────────────────┤",
            "│                    Press any key to continue...                     │",
            "└─────────────────────────────────────────────────────────────────────┘"
        ];
        const startRow = Math.max(1, Math.floor((this.screenHeight - helpText.length) / 2));
        const startCol = Math.max(1, Math.floor((this.screenWidth - 63) / 2));

        let output = "\x1b[?25l";
        for (let i = 0; i < helpText.length; i++) {
            output += `\x1b[${startRow + i};${startCol}H\x1b[1;37;44m${helpText[i]}\x1b[0m`;
        }
        await this.os.std.print(output);
        await this.os.std.getChar();

        // Flush any trailing escape sequence characters (e.g. if user pressed Arrow/ESC to close help)
        while (await this.os.std.poll()) {
            await this.os.std.getChar();
        }

        await this.render();
    }


    public async save() {
        try {
            const content = this.lines.join("\n");
            const fd = await this.os.fs.open(this.filename, "w");
            if (fd !== null) {
                await this.os.fs.write(fd, content);
                await this.os.fs.close(fd);
                this.changed = false;
                this.originalLines = [...this.lines];
                await this.render();
                await this.write(`\x1b[${this.screenHeight + 1};1H\x1b[42m\x1b[30m ** File Saved! ** \x1b[0m\x1b[K`);
                setTimeout(() => this.renderStatusBar(), 1500);
            }
        } catch (e: any) {
            await this.write(`\x1b[${this.screenHeight + 1};1H\x1b[41m\x1b[37m Error: ${e.message} \x1b[0m\x1b[K`);
        }
    }

    private isExiting: boolean = false;

    public async cleanupAndExit() {
        if (this.isExiting) return;
        this.isExiting = true;

        // Reset terminal state
        await this.os.fs.write(1, "\x1b[?7h"); // Enable wrap
        await this.os.fs.write(1, "\x1b[?25h"); // Show cursor
        await this.os.fs.write(1, "\x1b[0m");    // Reset colors

        // Clear entire screen and go home
        await this.os.fs.write(1, "\x1b[2J\x1b[H");

        await this.os.std.setRawMode(false);
        await this.os.shell.exit();
    }
}

export class main implements IProgram {
    async execute(os: OSContext, args: string[]): Promise<void> {
        if (args.length < 1) {
            await os.std.print("Usage: atto <filename>\n");
            return;
        }

        const filename = args[0];
        let content = "";
        try {
            const fd = await os.fs.open(filename);
            if (fd !== null) {
                const rawContent = await os.fs.read(fd);
                content = rawContent || "";
                await os.fs.close(fd);
            }
        } catch (e) { }

        const editor = new SimpleTextEditor(content, os, filename);
        await editor.init();

        await os.std.setRawMode(true);
        await os.std.print("\x1B[H\x1B[J");

        let stop = false;

        // SIGINT HANDLER REMOVED - Using manual Ctrl+C handling in loop to avoid race conditions.

        try {
            await editor.render();
            while (!stop) {
                const char = await os.std.getChar();
                if (char === null) break;
                if (stop) break;
                const result = await editor.handleKey(char);
                if (result === "exit") {
                    stop = true;
                    await editor.cleanupAndExit();
                    break;
                }
            }
        } catch (e) {
            await editor.cleanupAndExit();
        }
    }
}
