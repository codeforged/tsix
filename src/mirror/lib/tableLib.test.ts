import { describe, it, expect, afterEach } from "vitest";

import { displayWidth, setColorEnabled } from "./ansiLib";
import {
    CHARSETS,
    TABLE_THEMES,
    Table,
    printTable,
    renderTable,
    type TableOptions,
    type TableStdLike,
} from "./tableLib";

afterEach(() => {
    setColorEnabled(true);
});

/** Tabel biasa: 2 kolom, 1 baris body. Dipakai berkali-kali di bawah. */
function simple(opts: TableOptions = {}): string {
    return renderTable(["A", "B"], [["x", "y"]], { color: false, ...opts });
}

describe("tableLib ✦ bingkai & dasar", () => {
    it("charset box (default) — bingkai lengkap", () => {
        expect(simple()).toBe(["┌───┬───┐", "│ A │ B │", "├───┼───┤", "│ x │ y │", "└───┴───┘"].join("\n"));
    });

    it("tanpa header hanya menggambar rule atas + body", () => {
        const t = new Table({ color: false });
        t.addRow(["a", "b"]);
        expect(t.render()).toBe(["┌───┬───┐", "│ a │ b │", "└───┴───┘"].join("\n"));
    });

    it("charset markdown — tanpa garis atas/bawah", () => {
        expect(simple({ charset: "markdown" })).toBe(["| A | B |", "|---|---|", "| x | y |"].join("\n"));
    });

    it("charset compact — hanya rule, tanpa garis vertikal", () => {
        expect(simple({ charset: "compact" })).toBe(["────", "A  B", "────", "x  y", "────"].join("\n"));
    });

    it("charset ascii — aman untuk terminal/LCD tanpa Unicode", () => {
        expect(simple({ charset: "ascii" })).toBe(
            ["+---+---+", "| A | B |", "+---+---+", "| x | y |", "+---+---+"].join("\n"),
        );
    });

    it("charset none — tanpa bingkai sama sekali", () => {
        expect(simple({ charset: "none" })).toBe(["A  B", "x  y"].join("\n"));
    });

    it("bingkai bisa dikustom (h/v diganti, sudut tetap)", () => {
        const out = simple({ charset: { ...CHARSETS.box, h: "━", v: "┃" } });
        const lines = out.split("\n");
        expect(lines[0]).toBe("┌━━━┬━━━┐");
        expect(lines[1]).toBe("┃ A ┃ B ┃");
        expect(lines[4]).toBe("└━━━┴━━━┘");
    });

    it("headSeparator: false menghapus garis setelah header", () => {
        expect(simple({ headSeparator: false })).toBe(["┌───┬───┐", "│ A │ B │", "│ x │ y │", "└───┴───┘"].join("\n"));
    });

    it("indent menggeser seluruh tabel", () => {
        const lines = simple({ indent: 2 }).split("\n");
        expect(lines.every((l) => l.startsWith("  "))).toBe(true);
        expect(lines[1]).toBe("  │ A │ B │");
    });

    it("padding: 0 menghilangkan spasi dalam sel", () => {
        expect(simple({ padding: 0 })).toBe(["┌─┬─┐", "│A│B│", "├─┼─┤", "│x│y│", "└─┴─┘"].join("\n"));
    });

    it("tabel tanpa baris sama sekali → string kosong", () => {
        expect(new Table({ color: false }).render()).toBe("");
    });
});

describe("tableLib ✦ perataan", () => {
    it("kolom numerik otomatis rata-kanan (align: auto)", () => {
        const lines = renderTable(
            ["NAME", "N"],
            [
                ["a", 1],
                ["bb", 22],
            ],
            {
                color: false,
            },
        ).split("\n");
        expect(lines[1]).toBe("│ NAME │  N │");
        expect(lines[3]).toBe("│ a    │  1 │");
        expect(lines[4]).toBe("│ bb   │ 22 │");
    });

    it("alignNumeric: false mematikan deteksi angka", () => {
        const lines = renderTable(
            ["NAME", "N"],
            [
                ["a", 1],
                ["bb", 22],
            ],
            {
                color: false,
                alignNumeric: false,
            },
        ).split("\n");
        expect(lines[3]).toBe("│ a    │ 1  │");
        expect(lines[4]).toBe("│ bb   │ 22 │");
    });

    it("align eksplisit per kolom menang atas deteksi", () => {
        const out = renderTable(
            ["K", "V"],
            [
                ["a", 1],
                ["b", 22],
            ],
            {
                color: false,
                align: ["left", "right"],
            },
        );
        expect(out.split("\n")[1]).toBe("│ K │  V │");
        expect(out.split("\n")[3]).toBe("│ a │  1 │");
    });

    it("align: center", () => {
        const out = renderTable(["CC"], [["ab"]], { color: false, align: "center" });
        expect(out.split("\n")[1]).toBe("│ CC │");
    });

    it("kolom bertipe angka+teks campur tidak ikut rata-kanan", () => {
        const out = renderTable(["V"], [["1"], ["x"]], { color: false });
        expect(out.split("\n")[1]).toBe("│ V │");
        expect(out.split("\n")[3]).toBe("│ 1 │");
    });
});

describe("tableLib ✦ lebar & pemotongan", () => {
    it("width menyusutkan kolom terlebar & memotong dengan elipsis", () => {
        const out = renderTable(["NAME"], [["abcdefghijkl"]], { color: false, width: 10 });
        expect(out).toBe(["┌────────┐", "│ NAME   │", "├────────┤", "│ abcde… │", "└────────┘"].join("\n"));
        expect(out.split("\n")[0].length).toBe(10);
    });

    it("semua baris keluaran ≤ width + indent", () => {
        const out = renderTable(
            ["NAME", "DESKRIPSI PANJANG SEKALI"],
            [["abcdefghij", "lorem ipsum dolor sit amet consectetur"]],
            { color: false, width: 30 },
        );
        for (const line of out.split("\n")) {
            expect(line.length).toBeLessThanOrEqual(30);
        }
    });

    it("wrap: true membungkus isi sel jadi beberapa baris", () => {
        const out = renderTable(["TEXT"], [["hello world"]], {
            color: false,
            wrap: true,
            colWidths: [5],
        });
        expect(out).toBe(["┌───────┐", "│ TEXT  │", "├───────┤", "│ hello │", "│ world │", "└───────┘"].join("\n"));
    });

    it("colWidths eksplisit tidak menyusut; kolom lain yang dikorbankan", () => {
        const lines = renderTable(["A", "B"], [["1", "abcdefghij"]], {
            color: false,
            align: "left",
            colWidths: [3, null],
            width: 14,
        }).split("\n");
        expect(lines[0]).toBe("┌─────┬──────┐");
        expect(lines[1]).toBe("│ A   │ B    │");
        expect(lines[3]).toBe("│ 1   │ abc… │");
    });

    it("stretch membagi sisa lebar ke kolom", () => {
        const out = renderTable(["A"], [["x"]], { color: false, width: 12, stretch: true });
        expect(out.split("\n")[0]).toBe("┌──────────┐");
        expect(out.split("\n")[0].length).toBe(12);
    });

    it("minColWidth menjaga kolom tidak jadi 0 walau width terlalu kecil", () => {
        let out = "";
        expect(() => {
            out = renderTable(["Aa", "Bb"], [["z", "y"]], { color: false, width: 5 });
        }).not.toThrow();
        expect(out.split("\n").length).toBe(5);
    });

    it("maxColWidth membatasi lebar kolom", () => {
        const out = renderTable(["A"], [["abcdefghij"]], { color: false, maxColWidth: 4 });
        expect(out).toBe(["┌──────┐", "│ A    │", "├──────┤", "│ abc… │", "└──────┘"].join("\n"));
    });

    it("sel yang memuat newline diratakan jadi satu baris", () => {
        const out = renderTable(["V"], [["a\nb"]], { color: false });
        expect(out.split("\n")[3]).toBe("│ a b │");
    });
});

describe("tableLib ✦ separator & baris", () => {
    it("separator() menyisipkan garis di tengah", () => {
        const t = new Table({ head: ["K", "V"], color: false });
        t.addRow(["a", 1]);
        t.separator();
        t.addRow(["b", 22]);
        expect(t.render()).toBe(
            ["┌───┬────┐", "│ K │  V │", "├───┼────┤", "│ a │  1 │", "├───┼────┤", "│ b │ 22 │", "└───┴────┘"].join(
                "\n",
            ),
        );
        expect(t.rowCount).toBe(2);
    });

    it("separator tidak digambar pada charset tanpa garis (none)", () => {
        const t = new Table({ charset: "none", color: false });
        t.addRow(["a"]);
        t.separator();
        t.addRow(["b"]);
        expect(t.render()).toBe(["a", "b"].join("\n"));
    });

    it("nilai null/undefined/boolean dinormalisasi", () => {
        const out = renderTable(["a", "b", "c"], [[null, undefined, true]], { color: false });
        expect(out.split("\n")[3]).toBe("│   │   │ true │");
    });
});

describe("tableLib ✦ fromRecords & helper", () => {
    it("fromRecords memakai key objek sebagai header", () => {
        const out = Table.fromRecords(
            [
                { a: 1, b: "x" },
                { a: 2, b: "y" },
            ],
            undefined,
            {
                color: false,
            },
        ).render();
        expect(out).toBe(["┌───┬───┐", "│ a │ b │", "├───┼───┤", "│ 1 │ x │", "│ 2 │ y │", "└───┴───┘"].join("\n"));
    });

    it("fromRecords dengan daftar kolom eksplisit", () => {
        const out = Table.fromRecords([{ a: 1, b: 2 }], ["b"], { color: false }).render();
        expect(out.split("\n")[1]).toBe("│ b │");
    });

    it("toString() sama dengan render()", () => {
        const t = new Table({ head: ["A"], color: false });
        t.addRow(["1"]);
        expect(t.toString()).toBe(t.render());
    });
});

describe("tableLib ✦ warna", () => {
    it("default tanpa style → keluaran polos (tanpa ANSI)", () => {
        expect(renderTable(["A"], [["x"]])).not.toContain("\x1b[");
    });

    it("TABLE_THEMES.classic mewarnai border & header", () => {
        const out = renderTable(["A"], [["x"]], { style: TABLE_THEMES.classic });
        expect(out).toContain("\x1b[90m"); // border brightblack
        expect(out).toContain("\x1b[1;97m"); // head bold + brightwhite
    });

    it("TABLE_THEMES.accent memakai aksen cyan", () => {
        const out = renderTable(["A"], [["x"]], { style: TABLE_THEMES.accent });
        expect(out).toContain("\x1b[1;96m");
    });

    it("color: false mematikan warna tabel (ANSI milik sel tetap utuh)", () => {
        const cell = "\x1b[31mxy\x1b[0m";
        const out = renderTable(["V"], [[cell]], {
            color: false,
            style: TABLE_THEMES.classic,
        });
        expect(out).not.toContain("\x1b[90m");
        expect(out).toContain(cell);
        // sel ber-ANSI tetap sejajar dengan border
        expect(out.split("\n")[3]).toBe(`│ \x1b[31mxy\x1b[0m │`);
    });

    it("setColorEnabled(false) mematikan warna tabel secara global", () => {
        setColorEnabled(false);
        const out = renderTable(["A"], [["x"]], { style: TABLE_THEMES.classic });
        expect(out).not.toContain("\x1b[");
        expect(out.split("\n")[1]).toBe("│ A │");
    });

    it("sel ber-ANSI tidak mengacaukan lebar kolom", () => {
        const cell = "\x1b[1mabcd\x1b[0m";
        const lines = renderTable(["V"], [[cell]], { color: false }).split("\n");
        expect(lines[3]).toBe(`│ ${cell} │`);
        // lebar TAMPILAN harus sama dengan garis border, walau .length beda
        expect(displayWidth(lines[3])).toBe(displayWidth(lines[0]));
    });
});

describe("tableLib ✦ print() ke TTY", () => {
    function fakeStd(columns: number | null): { std: TableStdLike; out: string[] } {
        const out: string[] = [];
        return {
            out,
            std: {
                print: async (s: string) => {
                    out.push(s);
                },
                getScreenInfo: async () => (columns === null ? null : { lines: 24, columns }),
            },
        };
    }

    it("memakai COLUMNS dari SCREEN_INFO minus 1 sel", async () => {
        const { std, out } = fakeStd(20);
        const t = new Table({ head: ["NAME"], color: false });
        t.addRow(["abcdefghijkl"]);
        await t.print(std);

        expect(out.length).toBe(1);
        const lines = out[0].replace(/\n$/, "").split("\n");
        expect(lines[0]).toBe("┌──────────────┐");
        expect(lines[0].length).toBe(16);
        expect(out[0].endsWith("\n")).toBe(true);
    });

    it("newline: false tidak menambah newline", async () => {
        const { std, out } = fakeStd(20);
        const t = new Table({ head: ["A"], color: false });
        t.addRow(["x"]);
        await t.print(std, { newline: false });
        expect(out[0].endsWith("\n")).toBe(false);
    });

    it("jatuh ke lebar natural bila SCREEN_INFO tidak tersedia", async () => {
        const { std, out } = fakeStd(null);
        const t = new Table({ head: ["NAME"], color: false });
        t.addRow(["abcdefghijkl"]);
        await t.print(std);
        expect(out[0].split("\n")[0]).toBe("┌──────────────┐");
    });

    it("jatuh ke lebar natural bila syscall gagal", async () => {
        const out: string[] = [];
        const std: TableStdLike = {
            print: async (s: string) => {
                out.push(s);
            },
            getScreenInfo: async () => {
                throw new Error("no tty");
            },
        };
        const t = new Table({ head: ["A"], color: false });
        t.addRow(["abcdef"]);
        await t.print(std);
        expect(out[0].split("\n")[0]).toBe("┌────────┐");
    });

    it("width eksplisit menang atas SCREEN_INFO", async () => {
        const { std, out } = fakeStd(200);
        const t = new Table({ head: ["A"], color: false });
        t.addRow(["abcdef"]);
        await t.print(std, { width: 8 });
        expect(out[0].split("\n")[0].length).toBe(8);
    });
});
