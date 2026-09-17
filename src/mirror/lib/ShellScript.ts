// Import RELATIF (bukan `@common/...`): vitest repo ini tanpa config alias,
// jadi modul yang ikut di-unit-test harus relative. Di worker, WorkerEntry
// tetap me-rewrite otomatis (`/common/` → `@common/`), jadi keduanya jalan.
import { isShellInterpreter, parseShebang } from "../../common/Shebang";

/**
 * ShellScript — util murni untuk skrip shell TSIX (dipakai `tsh`)
 *
 * Semua fungsi di sini **tanpa efek samping** supaya bisa ditest langsung dan
 * dipakai ulang. Parsing shebang sendiri tinggal di `@common/Shebang` supaya
 * KERNEL (jalur EXEC) dan userland memakai aturan yang sama persis.
 *
 * Aturan yang diikuti (subset Unix yang bisa dipertanggungjawabkan):
 *   - Komentar `#` hanya bila berada di AWAL kata dan di luar tanda kutip.
 *     Jadi `echo "a # b"` tetap utuh, `$#` tidak dipotong.
 *   - Sambung baris `\` di akhir baris membuang backslash + newline-nya,
 *     sehingga potongan-potongan menjadi SATU perintah logis. `\\` (genap)
 *     berarti backslash literal.
 *   - Baris shebang (`#!...`) di baris pertama diabaikan saat eksekusi.
 *   - Tokenisasi (`splitRawWords`) & pemisahan operator (`splitTopLevel`)
 *     menghormati tanda kutip: `";"`, `"|"`, `"&"`, dan `">"` di dalam tanda
 *     kutip adalah teks biasa.
 *
 * (c) 2026 TSIX Project
 */

/** Satu perintah logis hasil parsing file skrip. */
export interface ScriptLine {
    /** Nomor baris fisik pertama perintah ini (1-based) — untuk pesan error. */
    lineNo: number;
    /** Perintah lengkap (komentar/blank sudah dibuang, sambungan sudah digabung). */
    text: string;
}

/**
 * stripShellComment(): Buang komentar `#` gaya Unix dari satu baris.
 * `#` dianggap komentar hanya bila di awal baris atau didahului whitespace,
 * dan tidak berada di dalam tanda kutip tunggal/ganda.
 */
export function stripShellComment(line: string): string {
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) {
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
            return line.slice(0, i);
        }
    }
    return line;
}

/**
 * splitTrailingContinuation(): Deteksi sambung baris `\` di akhir input.
 *
 * Return `{ text, continues }`:
 *   - `\`  (jumlah ganjil) → backslash terakhir dibuang, `continues: true`
 *   - `\\` (jumlah genap)  → teks tidak diubah, `continues: false` (literal)
 */
export function splitTrailingContinuation(line: string): {
    text: string;
    continues: boolean;
} {
    const match = line.match(/\\+$/);
    if (!match) return { text: line, continues: false };
    if (match[0].length % 2 === 1) {
        return { text: line.slice(0, -1), continues: true };
    }
    return { text: line, continues: false };
}

/**
 * scriptShebang(): Ambil interpreter dari baris pertama, atau null.
 * Contoh: `#!/bin/tsh` → `/bin/tsh`; `#!/usr/bin/env tsh` → `tsh`.
 */
export function scriptShebang(content: string): string | null {
    return parseShebang(content)?.interpreter ?? null;
}

/**
 * isKnownShell(): Apakah interpreter shebang adalah shell yang kompatibel?
 *
 * Menerima `tsh`, `sh`, `bash` (termasuk `tsh.js` dan bentuk `env tsh`) supaya
 * skrip yang disalin dari Linux tetap jalan — dengan catatan TSIX hanya
 * mendukung subset perintahnya.
 */
export function isKnownShell(interpreter: string): boolean {
    return isShellInterpreter(interpreter);
}

/**
 * parseScriptLines(): Ubah isi file skrip menjadi daftar perintah logis.
 *
 * - baris shebang (baris pertama) dilewati;
 * - komentar & baris kosong dilewati;
 * - sambung baris `\` digabung menjadi satu perintah (nomor baris = baris awal);
 * - sambungan yang belum selesai di akhir file tetap dijalankan (seperti bash).
 */
export function parseScriptLines(content: string): ScriptLine[] {
    const out: ScriptLine[] = [];
    if (!content) return out;

    const rawLines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
    let pending = "";
    let pendingLineNo = 0;

    for (let i = 0; i < rawLines.length; i++) {
        const raw = rawLines[i];

        // Shebang hanya bermakna di baris pertama.
        if (i === 0 && raw.trimStart().startsWith("#!")) continue;

        const { text, continues } = splitTrailingContinuation(stripShellComment(raw));

        if (pending === "") {
            if (!text.trim()) continue; // baris kosong / komentar murni
            pendingLineNo = i + 1;
        }
        pending += text;

        if (continues) continue;

        const command = pending.trim();
        if (command) out.push({ lineNo: pendingLineNo, text: command });
        pending = "";
    }

    const tail = pending.trim();
    if (tail) out.push({ lineNo: pendingLineNo, text: tail });

    return out;
}

/** Satu operator yang ditemukan di luar tanda kutip. */
export interface ShellScanHit {
    /** Indeks karakter tempat operator mulai. */
    index: number;
    /** Operator yang cocok (mis. `>`, `>>`, `|`, `;`, `&`). */
    operator: string;
}

/** Urutkan operator terpanjang lebih dulu supaya `>>` menang atas `>`. */
function sortOperators(operators: string[]): string[] {
    return [...operators].sort((a, b) => b.length - a.length);
}

/**
 * skipDollarParen(): Bila `input[start]` adalah awal `$(`, kembalikan indeks
 * SETELAH `)` pasangannya (sadar sarang & tanda kutip), atau -1 kalau bukan
 * `$(` / pasangannya tidak ketemu.
 *
 * Dipakai semua pemindai supaya `$(expr $N - 1)` dan `$(a; b)` tetap dianggap
 * SATU potongan: spasi di dalamnya bukan pemisah kata, dan `;`/`|`/`>` di
 * dalamnya bukan operator milik perintah luar.
 */
function skipDollarParen(input: string, start: number): number {
    if (input[start] !== "$" || input[start + 1] !== "(") return -1;

    let depth = 1;
    let quote: string | null = null;

    for (let i = start + 2; i < input.length; i++) {
        const ch = input[i];

        if (ch === "\\" && quote !== "'") {
            i++;
            continue;
        }
        if (quote) {
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            continue;
        }
        if (ch === "(") depth++;
        else if (ch === ")") {
            depth--;
            if (depth === 0) return i + 1;
        }
    }

    return -1;
}

/**
 * findTopLevelOperators(): Semua operator yang berada DI LUAR tanda kutip.
 *
 * Backslash dianggap escape (kecuali di dalam `'...'`), jadi `\;` bukan
 * pemisah perintah. Ini yang membuat `echo "a > b"` tetap satu perintah.
 */
export function findTopLevelOperators(input: string, operators: string[]): ShellScanHit[] {
    const sorted = sortOperators(operators);
    const hits: ShellScanHit[] = [];
    let quote: string | null = null;

    for (let i = 0; i < input.length; i++) {
        const ch = input[i];

        if (ch === "\\" && quote !== "'") {
            i++; // lewati karakter yang di-escape
            continue;
        }
        if (quote) {
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }

        const parenEnd = quote === null ? skipDollarParen(input, i) : -1;
        if (parenEnd !== -1) {
            i = parenEnd - 1;
            continue;
        }

        const op = sorted.find((candidate) => input.startsWith(candidate, i));
        if (op) {
            hits.push({ index: i, operator: op });
            i += op.length - 1;
        }
    }

    return hits;
}

/** findTopLevelOperator(): Operator PERTAMA di luar tanda kutip, atau null. */
export function findTopLevelOperator(input: string, operators: string[]): ShellScanHit | null {
    return findTopLevelOperators(input, operators)[0] ?? null;
}

/**
 * splitTopLevel(): Pisah teks pada operator di luar tanda kutip.
 * Bagian kosong dibuang (`a;;b` → `["a","b"]`), tiap bagian di-trim.
 */
export function splitTopLevel(input: string, operators: string[]): string[] {
    const sorted = sortOperators(operators);
    const parts: string[] = [];
    let buf = "";
    let quote: string | null = null;

    for (let i = 0; i < input.length; i++) {
        const ch = input[i];

        if (ch === "\\" && quote !== "'") {
            buf += ch;
            if (i + 1 < input.length) {
                buf += input[i + 1];
                i++;
            }
            continue;
        }
        if (quote) {
            buf += ch;
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            buf += ch;
            continue;
        }

        const parenEnd = quote === null ? skipDollarParen(input, i) : -1;
        if (parenEnd !== -1) {
            buf += input.slice(i, parenEnd);
            i = parenEnd - 1;
            continue;
        }

        const op = sorted.find((candidate) => input.startsWith(candidate, i));
        if (op) {
            parts.push(buf);
            buf = "";
            i += op.length - 1;
            continue;
        }

        buf += ch;
    }

    parts.push(buf);
    return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * splitRawWords(): Pecah perintah jadi kata-kata MENTAH.
 *
 * Tanda kutip dan backslash DIPERTAHANKAN (`'"a b"'`, `'a\\ b'`) — pemanggil
 * yang meng-expand, supaya `'$VAR'`, `"\$VAR"`, dan `$VAR` tetap berbeda arti.
 * Ini pengganti regex `(?:[^\s"']+|"[^"]*"|'[^']*')+` yang tidak paham escape
 * dan tidak bisa membedakan kutip tunggal dari ganda.
 */
export function splitRawWords(input: string): string[] {
    const words: string[] = [];
    let buf = "";
    let started = false;
    let quote: string | null = null;

    for (let i = 0; i < input.length; i++) {
        const ch = input[i];

        if (quote === null && /\s/.test(ch)) {
            if (started) {
                words.push(buf);
                buf = "";
                started = false;
            }
            continue;
        }

        started = true;

        // `$( ... )` adalah SATU kata, walau di dalamnya ada spasi.
        const parenEnd = quote === null ? skipDollarParen(input, i) : -1;
        if (parenEnd !== -1) {
            buf += input.slice(i, parenEnd);
            i = parenEnd - 1;
            continue;
        }

        if (ch === "\\" && quote !== "'") {
            buf += ch;
            if (i + 1 < input.length) {
                buf += input[i + 1];
                i++;
            }
            continue;
        }

        if (quote === null && (ch === '"' || ch === "'")) {
            quote = ch;
            buf += ch;
            continue;
        }

        if (quote !== null && ch === quote) {
            quote = null;
            buf += ch;
            continue;
        }

        buf += ch;
    }

    if (started) words.push(buf);
    return words;
}
