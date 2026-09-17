import { describe, it, expect } from "vitest";
import {
  interpreterCandidates,
  isShellInterpreter,
  parseShebang,
} from "./Shebang";

/**
 * Shebang tests (H1)
 *
 * Kontrak ini dipakai kernel pada jalur EXEC (semua peluncuran aplikasi), jadi
 * salah sedikit berarti boot/`./skrip.sh` rusak.
 */

describe("parseShebang (H1.1)", () => {
  it("H1.01 bentuk dasar dan ber-argumen", () => {
    expect(parseShebang("#!/bin/tsh\nls\n")).toEqual({
      interpreter: "/bin/tsh",
      args: [],
    });
    expect(parseShebang("#!/bin/tsh -x\n")).toEqual({
      interpreter: "/bin/tsh",
      args: ["-x"],
    });
  });

  it("H1.02 idiom env dinormalkan jadi nama shell", () => {
    expect(parseShebang("#!/usr/bin/env tsh\n")).toEqual({
      interpreter: "tsh",
      args: [],
    });
    expect(parseShebang("#!/usr/bin/env bash -e\n")).toEqual({
      interpreter: "bash",
      args: ["-e"],
    });
  });

  it("H1.03 bukan shebang → null (termasuk BOM & CRLF)", () => {
    expect(parseShebang("ls -l\n")).toBe(null);
    expect(parseShebang("# komentar biasa")).toBe(null);
    expect(parseShebang("#!")).toBe(null);
    expect(parseShebang("")).toBe(null);
    expect(parseShebang(null)).toBe(null);
    expect(parseShebang("\uFEFF#!/bin/tsh\r\nls\r\n")).toEqual({
      interpreter: "/bin/tsh",
      args: [],
    });
  });

  it("H1.04 shebang tidak harus di baris pertama file yang dibaca penuh", () => {
    expect(parseShebang("#!/bin/tsh\n\n# isi\nversion\n")).toEqual({
      interpreter: "/bin/tsh",
      args: [],
    });
  });
});

describe("isShellInterpreter (H1.2)", () => {
  it("H1.10 menerima tsh/sh/bash dalam berbagai penulisan", () => {
    expect(isShellInterpreter("/bin/tsh")).toBe(true);
    expect(isShellInterpreter("tsh")).toBe(true);
    expect(isShellInterpreter("/bin/tsh.js")).toBe(true);
    expect(isShellInterpreter("sh")).toBe(true);
    expect(isShellInterpreter("/bin/bash")).toBe(true);
    expect(isShellInterpreter("/usr/bin/env bash")).toBe(true);
  });

  it("H1.11 menolak interpreter lain (lebih baik gagal jelas daripada aneh)", () => {
    expect(isShellInterpreter("/usr/bin/python3")).toBe(false);
    expect(isShellInterpreter("node")).toBe(false);
    expect(isShellInterpreter("/usr/bin/env")).toBe(false);
    expect(isShellInterpreter("")).toBe(false);
  });
});

describe("interpreterCandidates (H1.3)", () => {
  it("H1.20 path absolut dipakai apa adanya", () => {
    expect(interpreterCandidates("/usr/local/bin/tsh")).toEqual([
      "/usr/local/bin/tsh",
    ]);
  });

  it("H1.21 nama telanjang dicari di direktori standar", () => {
    expect(interpreterCandidates("tsh")).toEqual([
      "/bin/tsh",
      "/usr/bin/tsh",
      "/sbin/tsh",
    ]);
  });

  it("H1.22 bentuk env memakai token terakhir", () => {
    expect(interpreterCandidates("/usr/bin/env tsh")).toEqual([
      "/bin/tsh",
      "/usr/bin/tsh",
      "/sbin/tsh",
    ]);
  });
});
