import { describe, it, expect } from "vitest";
import {
    findTopLevelOperator,
    isKnownShell,
    parseScriptLines,
    scriptShebang,
    splitRawWords,
    splitTopLevel,
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
        const content = ["#!/bin/tsh", "# komentar", "", "cd /mnt/sbak", "ls -l # daftar", ""].join("\n");

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
        expect(parseScriptLines("echo a \\")).toEqual([{ lineNo: 1, text: "echo a" }]);
    });

    it("S1.33 file kosong / hanya shebang → tanpa perintah", () => {
        expect(parseScriptLines("")).toEqual([]);
        expect(parseScriptLines("#!/bin/tsh\n")).toEqual([]);
    });
});

describe("ShellScript — tokenisasi kata (S1.5)", () => {
    it("S1.40 kutip dipertahankan supaya '$VAR' ≠ \"$VAR\" ≠ $VAR", () => {
        expect(splitRawWords('echo "a b" c')).toEqual(["echo", '"a b"', "c"]);
        expect(splitRawWords("echo '$a' \"$a\" $a")).toEqual(["echo", "'$a'", '"$a"', "$a"]);
    });

    it("S1.41 spasi di dalam $( ... ) bukan pemisah kata", () => {
        expect(splitRawWords("export C=$(expr $C - 1)")).toEqual(["export", "C=$(expr $C - 1)"]);
        expect(splitRawWords("echo a $(expr 1 + 1) b")).toEqual(["echo", "a", "$(expr 1 + 1)", "b"]);
    });

    it("S1.42 spasi ber-escape tetap satu kata", () => {
        expect(splitRawWords("touch a\\ b")).toEqual(["touch", "a\\ b"]);
    });

    it("S1.43 kutip tidak bisa dipakai lintas kata", () => {
        expect(splitRawWords('echo ""  ""')).toEqual(["echo", '""', '""']);
        expect(splitRawWords("")).toEqual([]);
    });
});

describe("ShellScript — operator di luar kutip (S1.6)", () => {
    it("S1.50 ';' di dalam kutip bukan pemisah perintah", () => {
        expect(splitTopLevel('echo "a; b" ; ls', [";"])).toEqual(['echo "a; b"', "ls"]);
        expect(splitTopLevel("echo 'x;y'", [";"])).toEqual(["echo 'x;y'"]);
    });

    it("S1.51 '|' dan '>' di dalam kutip bukan operator", () => {
        expect(splitTopLevel('echo "a | b"', ["|"])).toEqual(['echo "a | b"']);
        expect(findTopLevelOperator('echo " 5. PIPELINE (|) & REDIR (>)  "', [">"])).toBe(null);
        expect(splitTopLevel("cat a | grep b", ["|"])).toEqual(["cat a", "grep b"]);
    });

    it("S1.52 '>>' menang atas '>' dan posisinya dilaporkan", () => {
        const hit = findTopLevelOperator("echo hi >> log.txt", [">>", ">"]);
        expect(hit).toEqual({ index: 8, operator: ">>" });
        expect(findTopLevelOperator("echo hi > log.txt", [">>", ">"])).toEqual({
            index: 8,
            operator: ">",
        });
    });

    it("S1.53 ';'/'>' di dalam $( ... ) bukan operator perintah luar", () => {
        expect(splitTopLevel("X=$(a; b) ; ls", [";"])).toEqual(["X=$(a; b)", "ls"]);
        expect(findTopLevelOperator("echo $(cat > f)", [">"])).toBe(null);
    });

    it("S1.54 operator ber-escape bukan pemisah", () => {
        expect(splitTopLevel("echo a\\;b", [";"])).toEqual(["echo a\\;b"]);
        expect(findTopLevelOperator("echo a\\>b", [">"])).toBe(null);
    });

    it("S1.55 bagian kosong dibuang & tiap bagian di-trim", () => {
        expect(splitTopLevel("  a ;; b ;", [";"])).toEqual(["a", "b"]);
    });
});
