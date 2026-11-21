/**
 * table-demo — Demo `@tsix/tableLib` + `@tsix/ansiLib`.
 *
 * Menunjukkan cara membuat tabel teks yang benar-benar pas dengan console TSIX:
 *   - lebar tabel diambil dari TTY (`std.getScreenInfo()` → TIOCGWINSZ), bukan
 *     dari `process.stdout.columns` (di worker TSIX itu undefined);
 *   - pengukuran kolom memakai `displayWidth()` yang mengikuti `TTY.putChar()`
 *     (1 sel per code unit UTF-16), jadi tabel tidak miring walau sel memuat
 *     ANSI, box-drawing, atau emoji;
 *   - keluaran dikirim lewat `std.print()` (syscall PRINT → TTY/PTY), bukan
 *     `console.log` yang akan nyasar ke stdout host.
 *
 * Jalankan: /opt/test/table-demo [opsi]
 *   --help            tampilkan bantuan
 *   --width N         paksa lebar tabel (default: lebar TTY - 1)
 *   --no-color        matikan seluruh warna ANSI
 *   --charset NAMA    'box' | 'rounded' | 'double' | 'compact' | 'ascii' |
 *                     'markdown' | 'none'   (default: 'box')
 *   --section NAMA    'semua' (default) | dasar | warna | bingkai | lebar |
 *                     separators | records | ansi | lebar-layar
 */

import { Program, std, shell } from "@tsix/Application";
import { CHARSETS, TABLE_THEMES, Table, renderTable, type CharsetName } from "@tsix/tableLib";
import { detectColor, displayWidth, paint, setColorEnabled, stripAnsi, tone, truncate } from "@tsix/ansiLib";

// ── Util demo ───────────────────────────────────────────────────────────────

const TOTAL_BAR = 62;

async function section(title: string): Promise<void> {
    const bar = "━".repeat(Math.max(4, TOTAL_BAR - displayWidth(title)));
    await std.println("");
    await std.println(tone.accent(`━━ ${title} ${bar}`));
}

async function note(text: string): Promise<void> {
    await std.println(tone.muted(`   ${text}`));
}

// ── Demo ────────────────────────────────────────────────────────────────────

/** 1. Bentuk paling dasar: header + baris. */
async function demoDasar(charset: CharsetName): Promise<void> {
    await section("1. Dasar — header, body, charset default");

    const t = new Table({
        head: ["PID", "PROCESS", "STATE"],
        charset,
        style: TABLE_THEMES.accent,
    });
    t.addRow([1, "init", "running"]);
    t.addRow([7, "tsh", "running"]);
    t.addRow([42, "airtermd", "sleep"]);
    await t.print(std);

    await note("await t.print(std) → lebar otomatis = COLUMNS TTY - 1 sel.");
}

/** 2. Warna: palet semantik `tone` + style tabel. */
async function demoWarna(): Promise<void> {
    await section("2. Warna — tone.* di dalam sel");

    const t = new Table({
        head: ["SERVICE", "STATUS", "LATENCY"],
        charset: "rounded",
        style: TABLE_THEMES.accent,
    });
    t.addRow(["mqtt-broker", tone.success("UP"), "12 ms"]);
    t.addRow(["netfs", tone.warning("DEGRADED"), "184 ms"]);
    t.addRow(["tsh", tone.danger("DOWN"), "—"]);
    t.addRow(["lantana", tone.muted("idle"), "3 ms"]);
    await t.print(std);

    await note("Sel ber-ANSI tetap sejajar karena lebar dihitung displayWidth().");

    await std.println("");
    await std.println(
        `   ${tone.title("title")} ${tone.accent("accent")} ${tone.success("success")} ` +
            `${tone.warning("warning")} ${tone.danger("danger")} ${tone.info("info")} ${tone.muted("muted")}`,
    );
    await std.println(
        `   paint("x", { fg: "red" })      → ${paint("x", { fg: "red" })}` +
            `\n   paint("x", { fg: 208 })        → ${paint("x", { fg: 208 })}` +
            `\n   paint("x", { fg: "#ff8800" })  → ${paint("x", { fg: "#ff8800" })}` +
            `\n   paint("x", ["bold","red"])    → ${paint("x", ["bold", "red"])}`,
    );
}

/** 3. Semua preset bingkai. */
async function demoBingkai(): Promise<void> {
    await section("3. Bingkai — semua preset");

    for (const name of Object.keys(CHARSETS) as CharsetName[]) {
        await std.println(`   ${tone.label(name)}`);
        const out = renderTable(
            ["A", "B"],
            [
                [1, 2],
                [30, 4],
            ],
            {
                charset: name,
                style: TABLE_THEMES.classic,
                indent: 3,
            },
        );
        await std.println(out);
    }

    await note("'ascii' untuk terminal/LCD tanpa glyph Unicode; 'none' tanpa bingkai.");
}

/** 4. Lebar tetap → kolom menyusut + elipsis / wrap. */
async function demoLebar(width: number): Promise<void> {
    await section(`4. Lebar — dipaksa ${width} sel`);

    const head = ["FILE", "KETERANGAN"];
    const rows: Array<[string, string]> = [
        ["/etc/rc.local", "skrip startup yang dijalankan saat boot selesai"],
        ["/etc/shadow", "hash password (0660, root-only)"],
        ["/lib/UserLib.ts", "libc-nya TSIX — dibungkus jadi syscall manusiawi"],
    ];

    await std.println(`   ${tone.label("potong + elipsis (default)")}`);
    await std.println(renderTable(head, rows, { width, style: TABLE_THEMES.classic, indent: 3 }));

    await std.println("");
    await std.println(`   ${tone.label("wrap: true (teks dibungkus)")}`);
    await std.println(
        renderTable(head, rows, {
            width,
            wrap: true,
            style: TABLE_THEMES.classic,
            indent: 3,
        }),
    );

    await std.println("");
    await std.println(`   ${tone.label("stretch: true (rata penuh)")}`);
    await std.println(
        renderTable(["A", "B", "C"], [["x", "y", "z"]], {
            width,
            stretch: true,
            style: TABLE_THEMES.classic,
            indent: 3,
        }),
    );
}

/** 5. Garis pemisah & baris ringkasan. */
async function demoSeparator(): Promise<void> {
    await section("5. separator() — pemisah + baris total");

    const t = new Table({
        head: ["ITEM", "QTY", "HARGA"],
        align: ["left", "right", "right"],
        style: TABLE_THEMES.classic,
    });
    t.addRow(["sensor DHT22", 2, "Rp 74.000"]);
    t.addRow(["relay 4ch", 1, "Rp 38.500"]);
    t.separator();
    t.addRow([tone.value("TOTAL"), tone.value("3"), tone.value("Rp 112.500")]);
    await t.print(std);

    await note("Catatan: kolom 'HARGA' rata-kanan di sini karena align eksplisit.");
}

/** 6. fromRecords() — langsung dari hasil query/syscall. */
async function demoRecords(): Promise<void> {
    await section("6. fromRecords() — data objek → tabel");

    const procs = await shell.ps();
    const rows = procs.slice(0, 8).map((p: any) => ({
        pid: p.pid,
        ppid: p.ppid,
        name: p.name,
        user: p.user,
        tty: p.ttyId ?? "-",
        state: p.state,
    }));

    const t = Table.fromRecords(rows, ["pid", "ppid", "name", "user", "tty", "state"], {
        align: ["right", "right", "left", "left", "right", "left"],
        style: TABLE_THEMES.accent,
    });
    await t.print(std);

    await note("Angka otomatis rata-kanan kalau align tidak disebut.");
}

/** 7. Kenapa bukan string-width: CJK & emoji di TTY TSIX. */
async function demoAnsi(): Promise<void> {
    await section("7. displayWidth() — lebar versi TTY TSIX");

    const samples: Array<[string, string]> = [
        ["ASCII", "hello"],
        ["Box drawing", "┌─┬─┐"],
        ["CJK", "日本語"],
        ["Emoji", "😀😀"],
        ["ANSI", paint("abc", { fg: "brightgreen" })],
    ];
    for (const [label, text] of samples) {
        await std.println(
            `   ${label.padEnd(12)} ${paint(String(displayWidth(text)), { bold: true })} sel  ` +
                `${tone.muted("len=" + String(text.length))}  ${text}`,
        );
    }

    await note("TTY.putChar() = 1 sel per code unit UTF-16 → CJK=1, emoji=2, ANSI=0.");
    await note("(string-width npm menghitung CJK=2 → tabel akan miring di TSIX.)");

    await std.println("");
    await std.println(`   truncate("abcdefghij", 6)   → ${JSON.stringify(truncate("abcdefghij", 6))}`);
    await std.println(`   truncate("😀😀😀", 5)        → ${JSON.stringify(truncate("😀😀😀", 5))}`);
    await std.println(`   stripAnsi("<ESC>[31mAB<ESC>[0m") → ${JSON.stringify(stripAnsi("\x1b[31mAB\x1b[0m"))}`);
}

/** 8. Info TTY & tabel penuh lebar layar. */
async function demoLebarLayar(): Promise<void> {
    await section("8. Lebar layar (SCREEN_INFO / TIOCGWINSZ)");

    const info = await std.getScreenInfo();
    const columns = Number((info as any)?.columns) || 0;
    const lines = Number((info as any)?.lines) || 0;

    await std.println(`   getScreenInfo() → ${tone.value(`${columns} kolom × ${lines} baris`)}`);
    await std.println(`   $COLUMNS        → ${tone.value((await shell.getenv("COLUMNS")) || "(kosong)")}`);
    await std.println(`   $TERM           → ${tone.value((await shell.getenv("TERM")) || "(kosong)")}`);

    await std.println("");
    await std.println(
        renderTable(
            ["ENV", "NILAI"],
            [
                ["HOSTNAME", (await shell.getenv("HOSTNAME")) || "-"],
                ["USER", (await shell.getenv("USER")) || "-"],
                ["SHELL", (await shell.getenv("SHELL")) || "-"],
            ],
            { width: columns > 0 ? columns - 3 : undefined, indent: 3, style: TABLE_THEMES.classic },
        ),
    );

    await note("Resize jendela (pixelterm/retroterm) lalu jalankan ulang → tabel ikut menyesuaikan.");
}

// ── Entry point ─────────────────────────────────────────────────────────────

const HELP = `table-demo — demo tableLib + ansiLib (native TSIX)

Usage: /opt/test/table-demo [opsi]
  --help             tampilkan bantuan ini
  --width N          paksa lebar tabel (default: lebar TTY - 1)
  --no-color         matikan semua warna ANSI (output polos)
  --charset NAMA     box | rounded | double | compact | ascii | markdown | none
  --section NAMA     semua | dasar | warna | bingkai | lebar | separators |
                     records | ansi | lebar-layar

Contoh:
  /opt/test/table-demo
  /opt/test/table-demo --charset rounded --width 60
  /opt/test/table-demo --no-color --section dasar,ansi`;

function flagValue(args: string[], name: string): string | undefined {
    const idx = args.indexOf(name);
    if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
    const prefixed = args.find((a) => a.startsWith(name + "="));
    if (prefixed) return prefixed.slice(name.length + 1);
    return undefined;
}

export const main = Program(async (args) => {
    if (args.includes("--help") || args.includes("-h")) {
        await std.println(HELP);
        return;
    }

    // ── Warna: hormati NO_COLOR / TERM / --no-color ──
    const envColor = detectColor({
        TERM: await shell.getenv("TERM"),
        NO_COLOR: await shell.getenv("NO_COLOR"),
        FORCE_COLOR: await shell.getenv("FORCE_COLOR"),
    });
    const colorOn = envColor && !args.includes("--no-color");
    setColorEnabled(colorOn);

    // ── Charset default (untuk demo 1) ──
    const charsetArg = (flagValue(args, "--charset") || "box") as CharsetName;
    const charset: CharsetName = CHARSETS[charsetArg] ? charsetArg : "box";

    // ── Lebar: prioritas --width → COLUMNS TTY → 80 ──
    const info = await std.getScreenInfo();
    const ttyColumns = Number((info as any)?.columns) || 0;
    const widthArg = Number(flagValue(args, "--width"));
    const width =
        Number.isFinite(widthArg) && widthArg > 0 ? Math.floor(widthArg) : ttyColumns > 0 ? ttyColumns - 1 : 80;

    // ── Pilih section ──
    const sectionArg = flagValue(args, "--section") || "semua";
    const wanted = new Set(
        sectionArg
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean),
    );
    const want = (name: string): boolean => wanted.has("semua") || wanted.has(name);

    await std.println("");
    await std.println(tone.title("  TSIX tableLib demo — tabel teks + warna ANSI"));
    await std.println(tone.muted(`  charset=${charset}  width=${width}  color=${colorOn ? "on" : "off"}`));

    if (want("dasar")) await demoDasar(charset);
    if (want("warna")) await demoWarna();
    if (want("bingkai")) await demoBingkai();
    if (want("lebar")) await demoLebar(width);
    if (want("separators")) await demoSeparator();
    if (want("records")) await demoRecords();
    if (want("ansi")) await demoAnsi();
    if (want("lebar-layar")) await demoLebarLayar();

    await std.println("");
    await std.println(tone.muted("  selesai. Lihat wiki/changelogs/tablelib.md untuk API lengkap."));
    await std.println("");
});
