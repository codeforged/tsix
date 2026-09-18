import { describe, it, expect, afterEach } from "vitest";

import {
    center,
    detectColor,
    displayWidth,
    isColorEnabled,
    padEnd,
    padStart,
    paint,
    setColorEnabled,
    stripAnsi,
    takeWidth,
    tone,
    truncate,
    wrap,
} from "./ansiLib";

afterEach(() => {
    setColorEnabled(true);
});

describe("ansiLib ✦ displayWidth (semantik TTY TSIX)", () => {
    it("menghitung teks polos per code unit", () => {
        expect(displayWidth("")).toBe(0);
        expect(displayWidth("abc")).toBe(3);
        expect(displayWidth("a\tb")).toBe(3);
    });

    it("mengabaikan escape CSI (0 kolom)", () => {
        expect(displayWidth("\x1b[31mabc\x1b[0m")).toBe(3);
        expect(displayWidth("\x1b[1;38;5;208mX\x1b[0m")).toBe(1);
        expect(displayWidth("a\x1b[Kb")).toBe(2);
    });

    it("menghitung BMP (CJK & box-drawing) = 1 sel, seperti TTY.putChar()", () => {
        // Ini yang membedakan dari `string-width` npm, yang menghitung CJK = 2.
        expect(displayWidth("日本語")).toBe(3);
        expect(displayWidth("┌─┬─┐")).toBe(5);
        expect(displayWidth("│ a │")).toBe(5);
    });

    it("menghitung surrogate pair (emoji) = 2 sel", () => {
        expect(displayWidth("😀")).toBe(2);
        expect(displayWidth("a😀b")).toBe(4);
    });

    it("LF/CR tidak memakai sel", () => {
        expect(displayWidth("a\nb")).toBe(2);
        expect(displayWidth("a\r\nb")).toBe(2);
    });
});

describe("ansiLib ✦ stripAnsi / takeWidth", () => {
    it("stripAnsi membuang CSI", () => {
        expect(stripAnsi("\x1b[1;31mX\x1b[0m")).toBe("X");
        expect(stripAnsi("┌─┐")).toBe("┌─┐");
    });

    it("takeWidth memotong sesuai sel & tetap mempertahankan ANSI", () => {
        expect(takeWidth("\x1b[31mabcdef\x1b[0m", 3)).toBe("\x1b[31mabc");
        expect(takeWidth("abcdef", 0)).toBe("");
        expect(takeWidth("日本語", 2)).toBe("日本");
    });
});

describe("ansiLib ✦ padding & perataan (ANSI-aware)", () => {
    it("padEnd / padStart / center menghitung ANSI sebagai 0", () => {
        expect(padEnd("\x1b[31mab\x1b[0m", 5)).toBe("\x1b[31mab\x1b[0m   ");
        expect(padStart("ab", 5)).toBe("   ab");
        expect(center("ab", 6)).toBe("  ab  ");
        expect(padEnd("abcdef", 3)).toBe("abcdef");
        expect(center("ab", 5)).toBe(" ab  ");
    });

    it("padEnd memakai fill multi-karakter", () => {
        expect(padEnd("x", 5, ".-")).toBe("x.-.-");
    });
});

describe("ansiLib ✦ truncate", () => {
    it("tidak memotong kalau sudah muat", () => {
        expect(truncate("abc", 5)).toBe("abc");
        expect(truncate("abc", 3)).toBe("abc");
    });

    it("memotong & memberi elipsis", () => {
        expect(truncate("abcdef", 4)).toBe("abc…");
        expect(truncate("abcdef", 4, "...")).toBe("a...");
        expect(truncate("abcdef", 1)).toBe("a");
        expect(truncate("abcdef", 0)).toBe("");
    });

    it("menutup SGR yang masih terbuka sebelum elipsis", () => {
        expect(truncate("\x1b[31mabcdef\x1b[0m", 4)).toBe("\x1b[31mabc\x1b[0m…");
    });

    it("tidak memotong di tengah surrogate pair", () => {
        // "😀😀" = 4 sel. Dipotong ke 3 sel → 1 emoji utuh + elipsis (bukan
        // surrogat yatim yang tampil sebagai karakter rusak di TTY).
        expect(truncate("😀😀", 3)).toBe("😀…");
        expect(takeWidth("😀😀", 3)).toBe("😀");
    });
});

describe("ansiLib ✦ wrap", () => {
    it("membungkus di batas kata", () => {
        expect(wrap("hello world foo", 7)).toEqual(["hello", "world", "foo"]);
    });

    it("memotong paksa kata yang lebih panjang dari lebar", () => {
        expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    });

    it("menghormati newline eksplisit & baris kosong", () => {
        expect(wrap("a\n\nb", 5)).toEqual(["a", "", "b"]);
        expect(wrap("", 5)).toEqual([""]);
    });

    it("menyusutkan spasi di awal baris lanjutan", () => {
        expect(wrap("aa bb cc", 5)).toEqual(["aa bb", "cc"]);
    });

    it("lebar <= 0 mengembalikan teks apa adanya", () => {
        expect(wrap("abc", 0)).toEqual(["abc"]);
    });
});

describe("ansiLib ✦ paint & tone", () => {
    it("nama warna dasar & terang", () => {
        expect(paint("x", { fg: "red" })).toBe("\x1b[31mx\x1b[0m");
        expect(paint("x", { fg: "brightred" })).toBe("\x1b[91mx\x1b[0m");
        expect(paint("x", { bg: "blue" })).toBe("\x1b[44mx\x1b[0m");
        expect(paint("x", { bg: "brightblue" })).toBe("\x1b[104mx\x1b[0m");
    });

    it("index xterm-256 & truecolor (hex / triplet)", () => {
        expect(paint("x", { fg: 208 })).toBe("\x1b[38;5;208mx\x1b[0m");
        expect(paint("x", { fg: 8 })).toBe("\x1b[90mx\x1b[0m");
        expect(paint("x", { fg: "#ff8800" })).toBe("\x1b[38;2;255;136;0mx\x1b[0m");
        expect(paint("x", { fg: [0, 128, 255] })).toBe("\x1b[38;2;0;128;255mx\x1b[0m");
    });

    it("modifier selalu mendahului warna", () => {
        expect(paint("x", { fg: "brightred", bold: true })).toBe("\x1b[1;91mx\x1b[0m");
        expect(paint("x", ["underline", "green"])).toBe("\x1b[4;32mx\x1b[0m");
    });

    it("warna tidak dikenali diabaikan (tidak menghasilkan escape kosong)", () => {
        expect(paint("x", { fg: "warnabiru" })).toBe("x");
        expect(paint("", { fg: "red" })).toBe("");
    });

    it("tone.* memakai palet semantik", () => {
        expect(tone.success("ok")).toBe("\x1b[92mok\x1b[0m");
        expect(tone.danger("no")).toBe("\x1b[91mno\x1b[0m");
        expect(tone.muted("m")).toBe("\x1b[2mm\x1b[0m");
    });

    it("setColorEnabled(false) mematikan semua output ANSI", () => {
        setColorEnabled(false);
        expect(isColorEnabled()).toBe(false);
        expect(paint("x", { fg: "red", bold: true })).toBe("x");
        expect(tone.success("ok")).toBe("ok");
        expect(padEnd("a", 3)).toBe("a  ");
    });
});

describe("ansiLib ✦ detectColor", () => {
    it("menghormati TERM / NO_COLOR / FORCE_COLOR", () => {
        expect(detectColor({ TERM: "xterm-256color" })).toBe(true);
        expect(detectColor({ TERM: "dumb" })).toBe(false);
        expect(detectColor({ TERM: "" })).toBe(false);
        expect(detectColor({})).toBe(false);
        expect(detectColor({ TERM: "xterm", NO_COLOR: "1" })).toBe(false);
        expect(detectColor({ TERM: "dumb", FORCE_COLOR: "1" })).toBe(true);
        expect(detectColor({ TERM: "xterm", FORCE_COLOR: "0" })).toBe(true);
    });
});
