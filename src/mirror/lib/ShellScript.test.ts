import { describe, it, expect } from "vitest";
import {
  isKnownShell,
  parseScriptLines,
  scriptShebang,
  splitTrailingContinuation,
  stripShellComment,
} from "./ShellScript";

/**
 * ShellScript tests (S1)
 *
 * Util murni untuk skrip `.sh` di tsh. Semua kasus di sini adalah janji yang
 * dipegang shell: salah sedikit, skrip user ikut rusak.
 */

describe("ShellScript — komentar (S1.1)", () => {
  it("S1.01 membuang komentar di akhir baris", () => {
    expect(stripShellComment("ls -l /tmp # daftar file")).toBe("ls -l /tmp ");
  });

  it("S1.02 baris komentar penuh menjadi kosong", () => {
    expect(stripShellComment("# hanya komentar")).toBe("");
    expect(stripShellComment("   # inden")).toBe("   ");
  });

  it("S1.03 '#' di dalam tanda kutip BUKAN komentar", () => {
    expect(stripShellComment('echo "a # b"')).toBe('echo "a # b"');
    expect(stripShellComment("echo 'x # y'")).toBe("echo 'x # y'");
  });

  it("S1.04 '$#' dan '#' yang menempel kata tetap utuh", () => {
    expect(stripShellComment("echo $#")).toBe("echo $#");
    expect(stripShellComment("echo a#b")).toBe("echo a#b");
  });
});

describe("ShellScript — sambung baris (S1.2)", () => {
  it("S1.10 backslash tunggal menyambung & dibuang", () => {
    expect(splitTrailingContinuation("netfsd --export /mnt/sbak/ \\")).toEqual({
      text: "netfsd --export /mnt/sbak/ ",
      continues: true,
    });
  });

  it("S1.11 backslash ganda = literal, tidak menyambung", () => {
    expect(splitTrailingContinuation("echo a\\\\")).toEqual({
      text: "echo a\\\\",
      continues: false,
    });
  });

  it("S1.12 baris tanpa backslash tidak menyambung", () => {
    expect(splitTrailingContinuation("ls")).toEqual({
      text: "ls",
      continues: false,
    });
  });
});

describe("ShellScript — shebang (S1.3)", () => {
  it("S1.20 mengenali shebang umum dan bentuk env", () => {
    expect(scriptShebang("#!/bin/tsh\nls\n")).toBe("/bin/tsh");
    // Bentuk `env` dinormalkan jadi nama shell (`tsh`) — aturan yang SAMA
    // dipakai kernel di jalur EXEC (lihat @common/Shebang), supaya skrip yang
    // dijalankan lewat `./x.sh` dan lewat `exec()` tidak berbeda tafsir.
    expect(scriptShebang("#!/usr/bin/env tsh\n")).toBe("tsh");
    expect(scriptShebang("ls\n")).toBe(null);
    expect(scriptShebang("# komentar biasa")).toBe(null);
  });

  it("S1.21 hanya shell yang dikenal yang diterima", () => {
    expect(isKnownShell("/bin/tsh")).toBe(true);
    expect(isKnownShell("/bin/tsh.js")).toBe(true);
    expect(isKnownShell("/bin/sh")).toBe(true);
    expect(isKnownShell("/usr/bin/env bash")).toBe(true);
    expect(isKnownShell("/usr/bin/python3")).toBe(false);
  });
});

describe("ShellScript — parse file skrip (S1.4)", () => {
  it("S1.30 melewati shebang, komentar, dan baris kosong", () => {
    const content = [
      "#!/bin/tsh",
      "# komentar",
      "",
      "cd /mnt/sbak",
      "ls -l # daftar",
      "",
    ].join("\n");

    expect(parseScriptLines(content)).toEqual([
      { lineNo: 4, text: "cd /mnt/sbak" },
      { lineNo: 5, text: "ls -l" },
    ]);
  });

  it("S1.31 menggabungkan sambung baris jadi satu perintah", () => {
    const content = [
      "#!/bin/tsh",
      "netfsd --export /mnt/sbak/ \\",
      "  --label databank \\",
      "  --port 7777",
      "echo done",
    ].join("\n");

    expect(parseScriptLines(content)).toEqual([
      {
        lineNo: 2,
        text: "netfsd --export /mnt/sbak/   --label databank   --port 7777",
      },
      { lineNo: 5, text: "echo done" },
    ]);
  });

  it("S1.32 sambungan di akhir file tetap dijalankan", () => {
    expect(parseScriptLines("echo a \\")).toEqual([
      { lineNo: 1, text: "echo a" },
    ]);
  });

  it("S1.33 file kosong / hanya shebang → tanpa perintah", () => {
    expect(parseScriptLines("")).toEqual([]);
    expect(parseScriptLines("#!/bin/tsh\n")).toEqual([]);
  });
});
