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

    const { text, continues } = splitTrailingContinuation(
      stripShellComment(raw),
    );

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
