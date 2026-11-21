/**
 * Shebang — parsing baris `#!` pada file executable (skrip)
 *
 * Dipakai BERSAMA oleh dua sisi:
 *   - KERNEL (`Syscalls.ts`, kasus EXEC) — supaya `exec("/etc/rc.local")` atau
 *     `./skrip.sh` bisa dijalankan lewat interpreter-nya, seperti `execve` di
 *     Unix. Ini juga yang membuat cron/Asteracea bisa memanggil skrip.
 *   - USERLAND (`@tsix/ShellScript` untuk `tsh`) — deteksi skrip + validasi
 *     interpreter sebelum dijalankan.
 *
 * File ini SENGAJA tanpa dependency (tidak impor apa pun) supaya aman dipakai
 * di kedua dunia dan bisa ditest langsung.
 *
 * (c) 2026 TSIX Project
 */

/** Hasil parsing shebang. */
export interface Shebang {
  /** Interpreter (token pertama), mis. `/bin/tsh` atau `tsh`. */
  interpreter: string;
  /** Argumen tambahan di baris shebang (mis. `#!/bin/tsh -x`). */
  args: string[];
}

/**
 * parseShebang(): Ambil interpreter dari baris pertama file.
 *
 * Bentuk `#!/usr/bin/env tsh` (idiom Linux) dikenali dan dinormalkan menjadi
 * interpreter `tsh`, karena TSIX tidak punya `env` sebagai binary terpisah.
 *
 * @returns null kalau baris pertama bukan shebang.
 */
export function parseShebang(
  content: string | null | undefined,
): Shebang | null {
  if (!content) return null;

  const first =
    content.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
  if (!first.startsWith("#!")) return null;

  const body = first.substring(2).trim();
  if (!body) return null;

  const tokens = body.split(/\s+/);
  const interpreter = tokens[0];
  let args = tokens.slice(1);

  // `#!/usr/bin/env tsh [args]` → interpreter = "tsh"
  const interpreterName = interpreter.split("/").pop() || interpreter;
  if (interpreterName === "env" && args.length > 0) {
    return { interpreter: args[0], args: args.slice(1) };
  }

  return { interpreter, args };
}

/**
 * isShellInterpreter(): Apakah interpreter ini shell yang didukung TSIX?
 * Menerima `tsh`, `sh`, `bash` (dengan/tanpa `.js`/`.ts`) — skrip yang disalin
 * dari Linux tetap bisa jalan, dengan catatan hanya subset perintahnya.
 */
export function isShellInterpreter(interpreter: string): boolean {
  // Terima juga bentuk multi-token (mis. "/usr/bin/env bash").
  const token = interpreter.trim().split(/\s+/).pop() || "";
  const name = token.split("/").pop() || token;
  return /^(tsh|sh|bash)(\.js|\.ts)?$/i.test(name);
}

/**
 * interpreterCandidates(): Kandidat path interpreter yang dicoba berurutan.
 *
 * Path absolut dipakai apa adanya; nama telanjang (`tsh`) dicari di direktori
 * standar. Pemanggil menambahkan varian sidecar `.js`/`.ts` sendiri, karena
 * runtime TSIX mengeksekusi `.js` dan source-nya `.ts`.
 */
export function interpreterCandidates(interpreter: string): string[] {
  const token = interpreter.trim().split(/\s+/).pop() || "";
  if (!token) return [];
  if (token.startsWith("/")) return [token];
  return [`/bin/${token}`, `/usr/bin/${token}`, `/sbin/${token}`];
}
